"""FinWatch rule evaluation (defense audit item C1).

Generates labeled synthetic transactions in dedicated eval-only accounts, runs
each of the 6 anomaly rules against ClickHouse, computes a per-rule confusion
matrix (TP/FP/FN/TN) plus precision/recall/F1, and writes a markdown report
to `finwatch/evaluation/`.

Run with --seed for reproducibility. Default cleanup deletes the eval accounts
and their transactions after the report is written.

Usage:
    python scripts/evaluate_rules.py --seed 42
    python scripts/evaluate_rules.py --victims-per-rule 5 --clean-controls 30
    python scripts/evaluate_rules.py --rules VELOCITY,LARGE_AMT --no-cleanup
"""

import argparse
import os
import random
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import psycopg2
import requests
from dotenv import load_dotenv
from psycopg2.extras import execute_values

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
# Reuse the simulator's ledger-enforced insert so eval traffic obeys the same
# application-layer contract as production traffic (CLAUDE.md §11.10).
from simulate_fraud import _insert as ledger_insert  # noqa: E402

load_dotenv(SCRIPT_DIR.parent / ".env")


DB_CONFIG = {
    "host": os.getenv("POSTGRES_HOST", "localhost"),
    "port": int(os.getenv("POSTGRES_PORT", 5432)),
    "dbname": os.getenv("POSTGRES_DB", "finwatch"),
    "user": os.getenv("POSTGRES_USER", "finwatch"),
    "password": os.environ["POSTGRES_PASSWORD"],
}

CLICKHOUSE_URL = "http://localhost:8123"
CLICKHOUSE_USER = os.getenv("CLICKHOUSE_USER", "default")
CLICKHOUSE_PASSWORD = os.getenv("CLICKHOUSE_PASSWORD", "")

QUERIES_DIR = SCRIPT_DIR.parent / "clickhouse" / "queries"
DEFAULT_OUTPUT_DIR = SCRIPT_DIR.parent / "evaluation"

# Each rule maps to (source SQL file, positional index of its SELECT among
# `;`-split statements in the file). anomaly_threshold.sql packs 4 sub-rules.
RULE_SOURCES = {
    "VELOCITY":   ("anomaly_velocity_check.sql", 0),
    "ZSCORE":     ("anomaly_zscore.sql", 0),
    "LARGE_AMT":  ("anomaly_threshold.sql", 0),
    "HIGH_RISK":  ("anomaly_threshold.sql", 1),
    "MULTI_CCY":  ("anomaly_threshold.sql", 2),
    "FAIL_SPIKE": ("anomaly_threshold.sql", 3),
}
ALL_RULES = list(RULE_SOURCES)

# Positive-class definition per rule, derived from rule SEMANTICS not scenario
# names. Several rules legitimately overlap:
#   - VELOCITY's `OR total_amount > 50M` clause means it also catches single
#     large transactions, so wire-fraud (250M) and ATO outlier (350M) victims
#     are legitimate VELOCITY positives in addition to card-cloning.
#   - LARGE_AMT (>100M single txn) catches both wire-fraud and ATO outlier.
# Mapping overlapping victims as positives for the rules they legitimately
# trigger prevents the eval from charging the rule for "false" positives that
# are actually correct firings.
POSITIVE_CLASS_SOURCES = {
    "VELOCITY":   ["VELOCITY", "LARGE_AMT", "ZSCORE"],
    "ZSCORE":     ["ZSCORE"],
    "LARGE_AMT":  ["LARGE_AMT", "ZSCORE"],
    "HIGH_RISK":  ["HIGH_RISK"],
    "MULTI_CCY":  ["MULTI_CCY"],
    "FAIL_SPIKE": ["FAIL_SPIKE"],
}

# High enough that no scenario can blow the balance check.
EVAL_INITIAL_BALANCE = Decimal("10000000000")  # 10B VND


def ch_query(sql: str, timeout: int = 30) -> str:
    auth = (CLICKHOUSE_USER, CLICKHOUSE_PASSWORD) if CLICKHOUSE_PASSWORD else None
    r = requests.post(CLICKHOUSE_URL, params={"query": sql}, auth=auth, timeout=timeout)
    r.raise_for_status()
    return r.text.strip()


def ch_query_rows(sql: str, timeout: int = 30) -> list[list[str]]:
    out = ch_query(sql, timeout=timeout)
    if not out:
        return []
    return [line.split("\t") for line in out.split("\n")]


@dataclass
class EvalAccounts:
    by_rule: dict[str, list[str]] = field(default_factory=dict)
    clean: list[str] = field(default_factory=list)

    def all_ids(self) -> list[str]:
        ids = list(self.clean)
        for rule_ids in self.by_rule.values():
            ids.extend(rule_ids)
        return ids


def create_eval_accounts(conn, run_id: str, victims_per_rule: int,
                         clean_controls: int) -> EvalAccounts:
    accounts = EvalAccounts()
    rows: list[tuple] = []

    for rule in ALL_RULES:
        for i in range(victims_per_rule):
            acct_id = str(uuid.uuid4())
            accounts.by_rule.setdefault(rule, []).append(acct_id)
            rows.append((
                acct_id,
                f"EVAL {rule} {i:03d}",
                f"eval-{run_id}-{rule.lower()}-{i:03d}@finwatch.local",
                "0900000000",
                EVAL_INITIAL_BALANCE,
                "VND",
                "active",
            ))

    for i in range(clean_controls):
        acct_id = str(uuid.uuid4())
        accounts.clean.append(acct_id)
        rows.append((
            acct_id,
            f"EVAL clean {i:03d}",
            f"eval-{run_id}-clean-{i:03d}@finwatch.local",
            "0900000000",
            EVAL_INITIAL_BALANCE,
            "VND",
            "active",
        ))

    with conn.cursor() as cur:
        execute_values(
            cur,
            """
            INSERT INTO accounts (id, full_name, email, phone, balance, currency, status)
            VALUES %s
            """,
            rows,
            page_size=100,
        )
    conn.commit()
    return accounts


def load_merchant_pools(conn) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Return (safe_merchants, high_risk_merchants)."""
    with conn.cursor() as cur:
        cur.execute("SELECT id, name FROM merchants WHERE risk_level IN ('low', 'medium')")
        safe = [(str(r[0]), r[1]) for r in cur.fetchall()]
        cur.execute("SELECT id, name FROM merchants WHERE risk_level = 'high'")
        high = [(str(r[0]), r[1]) for r in cur.fetchall()]
    return safe, high


def seed_zscore_baseline(conn, victims: list[str],
                         merchants: list[tuple[str, str]],
                         baseline_n: int = 20,
                         baseline_mean: int = 120_000,
                         baseline_spread: int = 15_000,
                         min_days_back: int = 5,
                         max_days_back: int = 25) -> int:
    """Insert backdated baseline txns per ZSCORE victim, spread between
    min_days_back and max_days_back so they never fall in the 10-min outer
    window of the ZSCORE rule (which looks at recent txns).
    Direct INSERT — bypasses ledger since these are historical.
    """
    rows: list[tuple] = []
    now = datetime.now(timezone.utc)
    for acct in victims:
        for _ in range(baseline_n):
            amount = baseline_mean + random.randint(-baseline_spread, baseline_spread)
            merchant_id, _name = random.choice(merchants)
            offset_days = random.uniform(min_days_back, max_days_back)
            ts = now - timedelta(
                days=offset_days,
                minutes=random.randint(0, 60 * 24 - 1),
            )
            rows.append((
                str(uuid.uuid4()),
                acct,
                merchant_id,
                Decimal(str(amount)),
                "VND",
                "purchase",
                "completed",
                "zscore-baseline",
                '{"generator": "evaluate_rules", "baseline": true}',
                f"10.0.{random.randint(1, 255)}.{random.randint(1, 255)}",
                f"device-{random.randint(1000, 9999)}",
                ts,
                ts,
            ))

    with conn.cursor() as cur:
        execute_values(
            cur,
            """
            INSERT INTO transactions
              (id, account_id, merchant_id, amount, currency, type, status,
               description, metadata, ip_address, device_id, created_at, updated_at)
            VALUES %s
            """,
            rows,
            page_size=200,
        )
    conn.commit()
    return len(rows)


def inject_card_cloning(conn, victim: str, merchants: list[tuple[str, str]],
                        count: int = 15) -> int:
    """VELOCITY: rapid micro-purchases."""
    merchant_id, _ = random.choice(merchants)
    for i in range(count):
        amount = round(random.uniform(800_000, 4_500_000), 2)
        ledger_insert(conn, victim, merchant_id, amount, "VND", "purchase", "completed",
                      f"eval-card-cloning #{i+1}",
                      {"fraud_type": "card_cloning", "eval": True, "sequence": i + 1})
    return count


def inject_wire_fraud(conn, victim: str, merchants: list[tuple[str, str]],
                      amount: int = 250_000_000) -> int:
    """LARGE_AMT: single oversized transfer."""
    merchant_id, _ = random.choice(merchants)
    ledger_insert(conn, victim, merchant_id, amount, "VND", "transfer", "completed",
                  "eval-wire-fraud",
                  {"fraud_type": "wire_fraud", "eval": True, "amount": amount})
    return 1


def inject_fx_laundering(conn, victim: str, merchants: list[tuple[str, str]],
                         currencies: list[str] | None = None) -> int:
    """MULTI_CCY: currency hops."""
    if currencies is None:
        currencies = ["VND", "USD", "EUR", "JPY", "THB"]
    merchant_id, _ = random.choice(merchants)
    for i, ccy in enumerate(currencies):
        amount = round(random.uniform(500_000, 8_000_000), 2)
        ledger_insert(conn, victim, merchant_id, amount, ccy, "purchase", "completed",
                      f"eval-fx-laundering hop {i+1}/{len(currencies)}",
                      {"fraud_type": "fx_laundering", "eval": True, "currency": ccy})
    return len(currencies)


def inject_account_takeover(conn, victim: str, merchants: list[tuple[str, str]],
                            outlier: int = 350_000_000) -> int:
    """ZSCORE: outlier vs backdated baseline.
    Baseline is seeded separately by seed_zscore_baseline().
    """
    merchant_id, _ = random.choice(merchants)
    ledger_insert(conn, victim, merchant_id, outlier, "VND", "transfer", "completed",
                  "eval-ato-outlier",
                  {"fraud_type": "account_takeover_outlier", "eval": True})
    return 1


def inject_mule_account(conn, victim: str,
                        high_risk_merchants: list[tuple[str, str]],
                        count: int = 4) -> int:
    """HIGH_RISK: transfers to high-risk merchant."""
    if not high_risk_merchants:
        return 0
    merchant_id, _ = random.choice(high_risk_merchants)
    for i in range(count):
        amount = round(random.uniform(3_000_000, 12_000_000), 2)
        ledger_insert(conn, victim, merchant_id, amount, "VND", "transfer", "completed",
                      f"eval-mule routing {i+1}/{count}",
                      {"fraud_type": "mule_account", "eval": True})
    return count


def inject_card_testing(conn, victim: str, merchants: list[tuple[str, str]],
                        failed_n: int = 6, completed_n: int = 1) -> int:
    """FAIL_SPIKE: failed + completed purchase attempts."""
    merchant_id, _ = random.choice(merchants)
    for i in range(failed_n):
        amount = round(random.uniform(50_000, 500_000), 2)
        ledger_insert(conn, victim, merchant_id, amount, "VND", "purchase", "failed",
                      f"eval-card-testing fail #{i+1}",
                      {"fraud_type": "card_testing", "eval": True, "outcome": "failed"})
    for i in range(completed_n):
        amount = round(random.uniform(50_000, 500_000), 2)
        ledger_insert(conn, victim, merchant_id, amount, "VND", "purchase", "completed",
                      f"eval-card-testing ok #{i+1}",
                      {"fraud_type": "card_testing", "eval": True, "outcome": "completed"})
    return failed_n + completed_n


def inject_clean(conn, clean_id: str, merchants: list[tuple[str, str]],
                 txn_per_account: int = 3) -> int:
    """Benign traffic — low-amount VND purchases to safe merchants. Kept under
    5 per account so ZSCORE's `txn_count_30d >= 5` filter naturally excludes
    these accounts from the rule altogether.
    """
    for i in range(txn_per_account):
        amount = round(random.uniform(50_000, 2_000_000), 2)
        merchant_id, _ = random.choice(merchants)
        ledger_insert(conn, clean_id, merchant_id, amount, "VND", "purchase", "completed",
                      f"eval-clean #{i+1}",
                      {"generator": "evaluate_rules", "eval": True, "clean": True})
    return txn_per_account


def wait_for_cdc(eval_account_ids: list[str], expected_count: int,
                 timeout: int = 60, poll: float = 0.5) -> int:
    """Poll CH until count of FINAL rows for eval accounts >= expected, or timeout."""
    quoted = ", ".join(f"'{a}'" for a in eval_account_ids)
    sql = (
        f"SELECT count() FROM finwatch.transactions FINAL "
        f"WHERE account_id IN ({quoted}) AND cdc_op != 'd'"
    )
    deadline = time.time() + timeout
    last = 0
    while time.time() < deadline:
        try:
            last = int(ch_query(sql))
        except Exception:
            last = 0
        if last >= expected_count:
            return last
        time.sleep(poll)
    return last


def split_sql_statements(sql: str) -> list[str]:
    """Split a SQL string on `;` terminators, ignoring `;` inside `--` line
    comments and `/* ... */` block comments. Returns non-empty trimmed
    statements; comment-only chunks (no SELECT after stripping) are dropped.
    """
    out: list[str] = []
    current: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        if c == "-" and i + 1 < n and sql[i + 1] == "-":
            while i < n and sql[i] != "\n":
                current.append(sql[i])
                i += 1
        elif c == "/" and i + 1 < n and sql[i + 1] == "*":
            current.append(sql[i]); current.append(sql[i + 1])
            i += 2
            while i + 1 < n and not (sql[i] == "*" and sql[i + 1] == "/"):
                current.append(sql[i])
                i += 1
            if i + 1 < n:
                current.append(sql[i]); current.append(sql[i + 1])
                i += 2
        elif c == ";":
            stmt = "".join(current).strip()
            if stmt and any(
                ln.strip() and not ln.strip().startswith("--")
                for ln in stmt.splitlines()
            ):
                out.append(stmt)
            current = []
            i += 1
        else:
            current.append(c)
            i += 1
    final = "".join(current).strip()
    if final and any(
        ln.strip() and not ln.strip().startswith("--") for ln in final.splitlines()
    ):
        out.append(final)
    return out


def load_rule_statements(queries_dir: Path) -> dict[str, str]:
    """Read each rule's source SQL and return {rule_name: SELECT body}.
    Maps positionally via RULE_SOURCES.
    """
    file_cache: dict[str, list[str]] = {}
    out: dict[str, str] = {}

    for rule, (filename, idx) in RULE_SOURCES.items():
        if filename not in file_cache:
            content = (queries_dir / filename).read_text(encoding="utf-8")
            file_cache[filename] = split_sql_statements(content)

        statements = file_cache[filename]
        if idx >= len(statements):
            raise RuntimeError(
                f"Rule {rule} expects statement index {idx} in {filename}, "
                f"but only {len(statements)} were parsed."
            )
        out[rule] = statements[idx]
    return out


def wrap_rule_for_eval(inner_sql: str, eval_account_ids: list[str]) -> str:
    """Wrap a rule's SELECT in `SELECT DISTINCT account_id FROM (...) WHERE
    account_id IN (...)` so output is normalized to a flagged-account set.
    """
    quoted = ", ".join(f"'{a}'" for a in eval_account_ids)
    return (
        "SELECT DISTINCT toString(account_id) AS account_id FROM (\n"
        f"{inner_sql}\n"
        f") AS rule_output WHERE account_id IN ({quoted})"
    )


def run_rule(rule: str, inner_sql: str, eval_account_ids: list[str]) -> set[str]:
    sql = wrap_rule_for_eval(inner_sql, eval_account_ids)
    rows = ch_query_rows(sql)
    return {row[0] for row in rows if row and row[0]}


@dataclass
class RuleResult:
    rule: str
    tp: int
    fp: int
    fn: int
    tn: int
    flagged_accounts: list[str]
    positive_accounts: list[str]

    @property
    def precision(self) -> float | None:
        if self.tp + self.fp == 0:
            return None
        return self.tp / (self.tp + self.fp)

    @property
    def recall(self) -> float | None:
        if self.tp + self.fn == 0:
            return None
        return self.tp / (self.tp + self.fn)

    @property
    def f1(self) -> float | None:
        p, r = self.precision, self.recall
        if p is None or r is None or p + r == 0:
            return None
        return 2 * p * r / (p + r)


def compute_confusion(rule: str, flagged: set[str], accounts: EvalAccounts) -> RuleResult:
    positives: set[str] = set()
    for src in POSITIVE_CLASS_SOURCES[rule]:
        positives.update(accounts.by_rule.get(src, []))
    all_eval = set(accounts.all_ids())
    negatives = all_eval - positives
    tp = len(flagged & positives)
    fp = len(flagged & negatives)
    fn = len(positives - flagged)
    tn = len(negatives - flagged)
    return RuleResult(
        rule=rule, tp=tp, fp=fp, fn=fn, tn=tn,
        flagged_accounts=sorted(flagged),
        positive_accounts=sorted(positives),
    )


def fmt_num(v: float | None) -> str:
    return "n/a" if v is None else f"{v:.3f}"


def write_report(out_dir: Path, run_id: str, args: argparse.Namespace,
                 git_sha: str, results: list[RuleResult],
                 accounts: EvalAccounts, cdc_rows_observed: int,
                 total_expected: int) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"report_{run_id}.md"

    valid_f1s = [r.f1 for r in results if r.f1 is not None]
    macro_f1 = sum(valid_f1s) / len(valid_f1s) if valid_f1s else None

    lines: list[str] = []
    lines.append(f"# FinWatch rule evaluation — {run_id}")
    lines.append("")
    lines.append(f"- **Timestamp:** {datetime.now().isoformat(timespec='seconds')}")
    lines.append(f"- **Seed:** {args.seed}")
    lines.append(f"- **Git SHA:** `{git_sha}`")
    lines.append(
        f"- **Command:** `python scripts/evaluate_rules.py --seed {args.seed} "
        f"--victims-per-rule {args.victims_per_rule} "
        f"--clean-controls {args.clean_controls} "
        f"--rules {','.join(args.rules_list)}`"
    )
    lines.append("")
    lines.append("## Configuration")
    lines.append("")
    lines.append("| Setting | Value |")
    lines.append("|---|---|")
    lines.append(f"| Victims per rule | {args.victims_per_rule} |")
    lines.append(f"| Clean control accounts | {args.clean_controls} |")
    lines.append(f"| Rules evaluated | {', '.join(args.rules_list)} |")
    lines.append(f"| Total eval accounts | {len(accounts.all_ids())} |")
    lines.append(f"| Eval rows expected in ClickHouse | {total_expected} |")
    lines.append(f"| Eval rows observed in ClickHouse | {cdc_rows_observed} |")
    lines.append("")

    lines.append("## Per-rule results")
    lines.append("")
    lines.append("| Rule | TP | FP | FN | TN | Precision | Recall | F1 |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|")
    for r in results:
        lines.append(
            f"| {r.rule} | {r.tp} | {r.fp} | {r.fn} | {r.tn} | "
            f"{fmt_num(r.precision)} | {fmt_num(r.recall)} | {fmt_num(r.f1)} |"
        )
    lines.append("")
    lines.append(f"**Macro-F1:** {fmt_num(macro_f1)}")
    lines.append("")

    lines.append("## Positive-class mapping")
    lines.append("")
    lines.append(
        "Each rule's positive class is the set of eval accounts that received a "
        "fraud pattern this rule is designed to catch. A pattern may legitimately "
        "be a positive for more than one rule."
    )
    lines.append("")
    lines.append("| Rule | Positive class sources |")
    lines.append("|---|---|")
    for rule in args.rules_list:
        srcs = POSITIVE_CLASS_SOURCES[rule]
        lines.append(f"| {rule} | {', '.join(srcs)} |")
    lines.append("")
    lines.append(
        "Notes on rule overlap (these are correct firings, not labelling leaks):"
    )
    lines.append("")
    lines.append(
        "- **VELOCITY** fires on any 5-minute window with `>10 txn` **or** "
        "`>50M VND total`. The `OR` clause means a single 250M (wire-fraud) or "
        "350M (account-takeover outlier) transaction is also a legitimate "
        "VELOCITY positive — so its positive class includes those victims in "
        "addition to card-cloning victims."
    )
    lines.append(
        "- **LARGE_AMT** (`>100M VND single txn`) catches both wire-fraud "
        "(250M) and account-takeover outlier (350M) victims."
    )
    lines.append(
        "- All other rules have a single positive class because their "
        "patterns do not overlap with the other scenarios."
    )
    lines.append("")

    lines.append("## Caveats")
    lines.append("")
    lines.append(
        "1. **Synthetic data.** All transactions are generated from controlled "
        "patterns with amounts drawn from uniform distributions. Real-world "
        "precision/recall will differ — production validation on labelled bank "
        "data is future work."
    )
    lines.append(
        "2. **Thresholds untuned.** Rule thresholds (VELOCITY: >10 txn or >50M "
        "VND in 5 min; LARGE_AMT: >100M VND; ZSCORE: |z|>3; etc.) are the values "
        "shipped in `clickhouse/queries/anomaly_*.sql` at the time of evaluation. "
        "No threshold optimization was performed; F1 numbers reflect default "
        "configuration."
    )
    lines.append(
        "3. **ZSCORE baseline is short.** Each ZSCORE victim has 20 backdated "
        "baseline transactions spread between 5 and 25 days ago. Production "
        "accounts have hundreds of historical transactions, giving a sharper "
        "stddev and likely better recall. Treat ZSCORE F1 as a floor."
    )
    lines.append(
        "4. **Per-account binary classification.** All rules are evaluated at "
        "the account level (flagged or not), matching how the demo `/alerts` "
        "page surfaces cases. Per-transaction precision/recall would be a "
        "separate evaluation."
    )
    lines.append(
        "5. **Evaluation scope.** Only eval-account traffic is counted in "
        "TP/FP/FN/TN. Pre-existing baseline or demo data sharing the same time "
        "window does not pollute the metrics because the wrapper SQL filters "
        "rule output by eval account IDs."
    )
    lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def cleanup(conn, run_id: str) -> tuple[int, int]:
    """Delete fraud_alerts -> transactions -> accounts for this eval run.

    fraud_alerts is cleaned first because the fraud-worker may have ticked
    during the eval and created cases that FK to eval accounts. Without
    this, the final DELETE FROM accounts violates the FK constraint.
    """
    pattern = f"eval-{run_id}-%@finwatch.local"
    with conn.cursor() as cur:
        cur.execute(
            """
            DELETE FROM fraud_alerts
            WHERE account_id IN (SELECT id FROM accounts WHERE email LIKE %s)
            """,
            (pattern,),
        )
        cur.execute(
            """
            DELETE FROM transactions
            WHERE account_id IN (SELECT id FROM accounts WHERE email LIKE %s)
            """,
            (pattern,),
        )
        txns_deleted = cur.rowcount
        cur.execute("DELETE FROM accounts WHERE email LIKE %s", (pattern,))
        accts_deleted = cur.rowcount
    conn.commit()
    return txns_deleted, accts_deleted


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Evaluate FinWatch fraud rules on labelled synthetic data.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--victims-per-rule", type=int, default=5)
    p.add_argument("--clean-controls", type=int, default=30)
    p.add_argument(
        "--rules", default="all",
        help=f"Comma-list of rules (or 'all'). Choices: {','.join(ALL_RULES)}",
    )
    p.add_argument("--no-cleanup", action="store_true",
                   help="Keep eval accounts + transactions after run.")
    p.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    p.add_argument("--propagation-timeout", type=int, default=60)
    args = p.parse_args()

    if args.rules == "all":
        args.rules_list = list(ALL_RULES)
    else:
        args.rules_list = [r.strip().upper() for r in args.rules.split(",") if r.strip()]
        bad = [r for r in args.rules_list if r not in ALL_RULES]
        if bad:
            p.error(f"Unknown rules: {bad}. Valid: {ALL_RULES}")
    return args


def git_sha_short() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            stderr=subprocess.DEVNULL, cwd=SCRIPT_DIR.parent.parent,
        ).decode().strip()
    except Exception:
        return "unknown"


def main() -> int:
    args = parse_args()
    random.seed(args.seed)

    run_id = f"eval-{datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:6]}"
    out_dir = Path(args.output_dir).resolve()
    git_sha = git_sha_short()

    print(f"[evaluate_rules] run_id={run_id} seed={args.seed} git={git_sha}")
    print(f"[evaluate_rules] rules={args.rules_list}")

    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = False
    cleanup_done = False
    try:
        n_accounts = len(ALL_RULES) * args.victims_per_rule + args.clean_controls
        print(f"[1/7] Creating {n_accounts} eval accounts...")
        accounts = create_eval_accounts(
            conn, run_id, args.victims_per_rule, args.clean_controls
        )

        safe_merchants, high_risk_merchants = load_merchant_pools(conn)
        if not safe_merchants:
            print("[FATAL] No low/medium-risk merchants found.")
            return 1
        if not high_risk_merchants and "HIGH_RISK" in args.rules_list:
            print("[WARN] No high-risk merchants found — HIGH_RISK rule will have recall=0.")

        zscore_victims = accounts.by_rule.get("ZSCORE", [])
        if zscore_victims and "ZSCORE" in args.rules_list:
            print(f"[2/7] Seeding 30-day baseline for {len(zscore_victims)} ZSCORE victims...")
            baseline_rows = seed_zscore_baseline(conn, zscore_victims, safe_merchants)
            print(f"       -> {baseline_rows} backdated baseline rows")
        else:
            baseline_rows = 0

        print("[3/7] Injecting fraud patterns + clean traffic...")
        inject_counts: dict[str, int] = {}
        for rule in args.rules_list:
            for v in accounts.by_rule.get(rule, []):
                if rule == "VELOCITY":
                    n = inject_card_cloning(conn, v, safe_merchants)
                elif rule == "ZSCORE":
                    n = inject_account_takeover(conn, v, safe_merchants)
                elif rule == "LARGE_AMT":
                    n = inject_wire_fraud(conn, v, safe_merchants)
                elif rule == "HIGH_RISK":
                    n = inject_mule_account(conn, v, high_risk_merchants)
                elif rule == "MULTI_CCY":
                    n = inject_fx_laundering(conn, v, safe_merchants)
                elif rule == "FAIL_SPIKE":
                    n = inject_card_testing(conn, v, safe_merchants)
                else:
                    n = 0
                inject_counts[rule] = inject_counts.get(rule, 0) + n

        total_clean = 0
        for clean_id in accounts.clean:
            total_clean += inject_clean(conn, clean_id, safe_merchants)
        print(f"       -> pattern rows: {sum(inject_counts.values())} per_rule={inject_counts}")
        print(f"       -> clean rows: {total_clean}")

        total_expected = baseline_rows + sum(inject_counts.values()) + total_clean
        print(f"[4/7] Waiting for CDC to land {total_expected} rows in ClickHouse "
              f"(timeout {args.propagation_timeout}s)...")
        cdc_observed = wait_for_cdc(
            accounts.all_ids(), total_expected, timeout=args.propagation_timeout
        )
        print(f"       -> ClickHouse sees {cdc_observed}/{total_expected} rows")
        if cdc_observed < total_expected:
            print(f"[WARN] CDC propagation incomplete; numbers may be biased low on recall.")

        print(f"[5/7] Loading rule SQL from {QUERIES_DIR}...")
        rule_statements = load_rule_statements(QUERIES_DIR)

        print(f"[6/7] Running each rule against eval accounts...")
        results: list[RuleResult] = []
        for rule in args.rules_list:
            try:
                flagged = run_rule(rule, rule_statements[rule], accounts.all_ids())
            except Exception as exc:
                print(f"       [{rule}] query failed: {exc}")
                flagged = set()
            result = compute_confusion(rule, flagged, accounts)
            results.append(result)
            print(f"       [{rule}] TP={result.tp} FP={result.fp} FN={result.fn} "
                  f"TN={result.tn} P={fmt_num(result.precision)} "
                  f"R={fmt_num(result.recall)} F1={fmt_num(result.f1)}")

        report_path = write_report(
            out_dir, run_id, args, git_sha, results, accounts,
            cdc_observed, total_expected,
        )
        print(f"[7/7] Report written: {report_path}")

        if not args.no_cleanup:
            print("[cleanup] Deleting eval transactions + accounts...")
            txns_deleted, accts_deleted = cleanup(conn, run_id)
            cleanup_done = True
            print(f"          -> deleted {txns_deleted} txns, {accts_deleted} accounts")
        else:
            print(f"[cleanup] Skipped (--no-cleanup). Eval data retained under "
                  f"'eval-{run_id}-%@finwatch.local'.")

        print(f"\nDONE. Report: {report_path}")
        return 0

    except Exception:
        # If anything blew up mid-run and we did not request --no-cleanup,
        # try to roll back the eval rows so the stack is not polluted.
        if not args.no_cleanup and not cleanup_done:
            try:
                conn.rollback()
                txns_deleted, accts_deleted = cleanup(conn, run_id)
                print(f"[cleanup-on-error] Removed {txns_deleted} txns, "
                      f"{accts_deleted} accounts.")
            except Exception as cleanup_exc:
                print(f"[cleanup-on-error] Failed: {cleanup_exc}")
        raise

    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
