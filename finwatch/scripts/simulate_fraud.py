"""FinWatch fraud simulator.

Each scenario maps to one of the anomaly rules in `clickhouse/queries/anomaly_*.sql`
and prints a short real-world narrative so the audience understands *why* the
detection matters, not just *that* it fires.

  Scenario           Rule that fires             Real-world typology
  -----------------  --------------------------  -------------------------------
  card-cloning       VELOCITY                    Stolen card -> rapid bursts
  wire-fraud         LARGE_AMT  (threshold #1)   BEC / executive impersonation
  fx-laundering      MULTI_CCY  (threshold #3)   Layering via currency hops
  account-takeover   ZSCORE                      Compromised creds -> single outlier
  mule-account       HIGH_RISK  (threshold #2)   Funds funneled via high-risk merchant
  card-testing       FAIL_SPIKE (threshold #4)   Stolen card validation attempts

Usage:
    python scripts/simulate_fraud.py --scenario all
    python scripts/simulate_fraud.py --scenario card-cloning
    python scripts/simulate_fraud.py --scenario wire-fraud --amount 750000000

Backward-compat: the legacy `--pattern velocity|large-amount|multi-currency|all`
still works and maps to the equivalent scenarios.
"""

import argparse
import json
import os
import random
import time

import psycopg2
from dotenv import load_dotenv

load_dotenv()

DB_CONFIG = {
    "host": os.getenv("POSTGRES_HOST", "localhost"),
    "port": int(os.getenv("POSTGRES_PORT", 5432)),
    "dbname": os.getenv("POSTGRES_DB", "finwatch"),
    "user": os.getenv("POSTGRES_USER", "finwatch"),
    "password": os.environ["POSTGRES_PASSWORD"],
}


# ---------- helpers ----------

def _banner(scenario, rule, story):
    bar = "=" * 72
    print(f"\n{bar}")
    print(f"  SCENARIO: {scenario}")
    print(f"  RULE    : {rule}")
    print(f"  STORY   : {story}")
    print(bar)


def _random_account(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM accounts WHERE status='active' ORDER BY random() LIMIT 1")
        return cur.fetchone()[0]


def _random_merchant(conn, risk_level=None):
    with conn.cursor() as cur:
        if risk_level:
            cur.execute(
                "SELECT id, name FROM merchants WHERE risk_level=%s ORDER BY random() LIMIT 1",
                (risk_level,),
            )
            row = cur.fetchone()
            if row:
                return row
        cur.execute("SELECT id, name FROM merchants ORDER BY random() LIMIT 1")
        return cur.fetchone()


DEBIT_TYPES = {"purchase", "transfer", "withdrawal"}


def _insert(conn, account_id, merchant_id, amount, currency, txn_type, status, description, meta):
    """Insert one simulator txn under the ledger contract.

    The caller's `status` is treated as the *intent*. The ledger may override it:
      - Account is not 'active'      -> status='failed', description='rejected: account <status>'.
      - Intent='completed', debit type, insufficient balance -> status='failed',
        description='insufficient funds'.
      - Intent='failed'              -> recorded as-is, no balance change (card-testing depends on this).
      - Intent='completed', balance OK -> recorded as completed, balance debited or credited.
    """
    from decimal import Decimal
    amt = Decimal(str(amount))
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT balance, status FROM accounts WHERE id = %s FOR UPDATE",
                (account_id,),
            )
            row = cur.fetchone()
            if row is None:
                conn.rollback()
                return
            balance, acct_status = row[0], row[1]

            if acct_status != "active":
                cur.execute(
                    """
                    INSERT INTO transactions
                      (account_id, merchant_id, amount, currency, type, status, description, metadata)
                    VALUES (%s, %s, %s, %s, %s, 'failed', %s, %s)
                    """,
                    (account_id, merchant_id, amt, currency, txn_type,
                     f"rejected: account {acct_status}", json.dumps(meta)),
                )
                conn.commit()
                return

            if status == "failed":
                cur.execute(
                    """
                    INSERT INTO transactions
                      (account_id, merchant_id, amount, currency, type, status, description, metadata)
                    VALUES (%s, %s, %s, %s, %s, 'failed', %s, %s)
                    """,
                    (account_id, merchant_id, amt, currency, txn_type, description, json.dumps(meta)),
                )
                conn.commit()
                return

            if txn_type in DEBIT_TYPES and balance < amt:
                cur.execute(
                    """
                    INSERT INTO transactions
                      (account_id, merchant_id, amount, currency, type, status, description, metadata)
                    VALUES (%s, %s, %s, %s, %s, 'failed', 'insufficient funds', %s)
                    """,
                    (account_id, merchant_id, amt, currency, txn_type, json.dumps(meta)),
                )
                conn.commit()
                return

            sign = -1 if txn_type in DEBIT_TYPES else 1
            cur.execute(
                """
                INSERT INTO transactions
                  (account_id, merchant_id, amount, currency, type, status, description, metadata)
                VALUES (%s, %s, %s, %s, %s, 'completed', %s, %s)
                """,
                (account_id, merchant_id, amt, currency, txn_type, description, json.dumps(meta)),
            )
            cur.execute(
                "UPDATE accounts SET balance = balance + %s WHERE id = %s",
                (sign * amt, account_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


# ---------- scenarios ----------

def scenario_card_cloning(conn, count=15, interval_sec=0.2):
    """Stolen card -> many rapid small purchases before the bank blocks it."""
    _banner(
        "card-cloning",
        "VELOCITY (>10 txns or >50M VND in 5 min)",
        "Attacker cloned a card from a skimmer and races to drain the balance "
        f"via {count} micro-purchases before fraud monitoring kicks in.",
    )
    account_id = _random_account(conn)
    merchant_id, _ = _random_merchant(conn)
    print(f"  victim account : {account_id}")
    for i in range(count):
        amount = round(random.uniform(800_000, 4_500_000), 2)
        _insert(conn, account_id, merchant_id, amount, "VND", "purchase", "completed",
                f"card-cloning #{i+1}", {"fraud_type": "card_cloning", "sequence": i + 1})
        time.sleep(interval_sec)
    print(f"  -> injected {count} rapid txns (expected: VELOCITY rule fires)\n")


def scenario_wire_fraud(conn, amount=250_000_000):
    """BEC scam: a single huge wire transfer disguised as an executive instruction."""
    _banner(
        "wire-fraud",
        "LARGE_AMT (single txn > 100M VND)",
        "Business Email Compromise: attacker spoofs the CFO and instructs a "
        f"one-shot wire transfer of {amount:,.0f} VND to a controlled account.",
    )
    account_id = _random_account(conn)
    merchant_id, mname = _random_merchant(conn)
    print(f"  victim account : {account_id}")
    print(f"  destination    : {mname}")
    _insert(conn, account_id, merchant_id, amount, "VND", "transfer", "completed",
            "wire-fraud (BEC)", {"fraud_type": "wire_fraud", "amount": amount})
    print("  -> injected 1 oversized txn (expected: LARGE_AMT rule fires)\n")


def scenario_fx_laundering(conn, currencies=None):
    """Layering: hop value through multiple currencies within minutes."""
    if currencies is None:
        currencies = ["VND", "USD", "EUR", "JPY", "THB"]
    _banner(
        "fx-laundering",
        "MULTI_CCY (>2 distinct currencies in 10 min)",
        "Money launderer fragments a single sum across "
        f"{len(currencies)} currencies ({', '.join(currencies)}) in rapid succession "
        "to obscure the audit trail (the 'layering' stage of ML).",
    )
    account_id = _random_account(conn)
    merchant_id, _ = _random_merchant(conn)
    print(f"  victim account : {account_id}")
    for i, ccy in enumerate(currencies):
        amount = round(random.uniform(500_000, 8_000_000), 2)
        _insert(conn, account_id, merchant_id, amount, ccy, "purchase", "completed",
                f"fx-laundering hop {i+1}/{len(currencies)}",
                {"fraud_type": "fx_laundering", "currency": ccy})
        time.sleep(0.4)
    print(f"  -> injected {len(currencies)} currency hops (expected: MULTI_CCY rule fires)\n")


def scenario_account_takeover(conn, baseline_n=20, baseline_mean=120_000, outlier=350_000_000):
    """Compromised credentials -> one outlier transaction far above account's norm."""
    _banner(
        "account-takeover",
        "ZSCORE (|z| > 3 vs 30-day baseline)",
        f"Attacker uses stolen credentials. Account's normal pattern is ~{baseline_mean:,.0f} VND "
        f"micro-purchases; attacker drains it with one {outlier:,.0f} VND transfer.",
    )
    account_id = _random_account(conn)
    merchant_id, _ = _random_merchant(conn)
    print(f"  victim account : {account_id}")
    print(f"  building       : {baseline_n} historical baseline txns")
    for i in range(baseline_n):
        amount = baseline_mean + random.randint(-15_000, 15_000)
        _insert(conn, account_id, merchant_id, amount, "VND", "purchase", "completed",
                f"ato-baseline {i+1}", {"fraud_type": "account_takeover_baseline"})
    print(f"  attacker fires : 1 outlier of {outlier:,.0f} VND")
    _insert(conn, account_id, merchant_id, outlier, "VND", "transfer", "completed",
            "ato-outlier", {"fraud_type": "account_takeover_outlier"})
    print("  -> injected baseline + outlier (expected: ZSCORE rule fires)\n")


def scenario_mule_account(conn, count=4):
    """Mule account: funds repeatedly routed through a high-risk merchant."""
    _banner(
        "mule-account",
        "HIGH_RISK (threshold rule 2)",
        f"Money mule sends {count} payments through a merchant flagged risk_level='high' "
        "(shell / sanctions / known-mule signals). Each individual txn looks normal, "
        "but the merchant counter-party is the red flag.",
    )
    account_id = _random_account(conn)
    merchant_row = _random_merchant(conn, risk_level="high")
    if merchant_row is None:
        print("  no high-risk merchant in seed data — skipping")
        return
    merchant_id, mname = merchant_row
    print(f"  mule account   : {account_id}")
    print(f"  shell merchant : {mname} (risk_level=high)")
    for i in range(count):
        amount = round(random.uniform(3_000_000, 12_000_000), 2)
        _insert(conn, account_id, merchant_id, amount, "VND", "transfer", "completed",
                f"mule routing {i+1}/{count}", {"fraud_type": "mule_account"})
        time.sleep(0.3)
    print(f"  -> injected {count} routing txns (expected: HIGH_RISK rule fires)\n")


def scenario_card_testing(conn, failed_n=6, completed_n=1):
    """Card-testing: attacker validates stolen cards via many small charges that bounce."""
    _banner(
        "card-testing",
        "FAIL_SPIKE (threshold rule 4: >=3 failed AND >50% fail rate)",
        f"Attacker has a batch of stolen card details and runs probing charges; "
        f"{failed_n} fail (declined / CVV mismatch) and {completed_n} sneak through. "
        "Failure-rate spike reveals the reconnaissance.",
    )
    account_id = _random_account(conn)
    merchant_id, _ = _random_merchant(conn)
    print(f"  victim account : {account_id}")
    for i in range(failed_n):
        amount = round(random.uniform(50_000, 500_000), 2)
        _insert(conn, account_id, merchant_id, amount, "VND", "purchase", "failed",
                f"card-testing fail #{i+1}", {"fraud_type": "card_testing", "outcome": "failed"})
        time.sleep(0.15)
    for i in range(completed_n):
        amount = round(random.uniform(50_000, 500_000), 2)
        _insert(conn, account_id, merchant_id, amount, "VND", "purchase", "completed",
                f"card-testing ok #{i+1}", {"fraud_type": "card_testing", "outcome": "completed"})
        time.sleep(0.15)
    print(f"  -> injected {failed_n} failed + {completed_n} completed (expected: FAIL_SPIKE rule fires)\n")


# ---------- CLI ----------

SCENARIOS = {
    "card-cloning":     scenario_card_cloning,
    "wire-fraud":       scenario_wire_fraud,
    "fx-laundering":    scenario_fx_laundering,
    "account-takeover": scenario_account_takeover,
    "mule-account":     scenario_mule_account,
    "card-testing":     scenario_card_testing,
}

# Legacy --pattern -> new --scenario mapping (kept for backward compatibility).
LEGACY_PATTERN_MAP = {
    "velocity":       "card-cloning",
    "large-amount":   "wire-fraud",
    "multi-currency": "fx-laundering",
}


def main():
    parser = argparse.ArgumentParser(
        description="FinWatch fraud simulator - six named scenarios, one per detection rule.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Scenarios:\n  "
            + "\n  ".join(f"{k:18s} -> {v.__doc__.splitlines()[0]}" for k, v in SCENARIOS.items())
        ),
    )
    parser.add_argument(
        "--scenario",
        choices=list(SCENARIOS) + ["all"],
        help="Named scenario to run (preferred).",
    )
    parser.add_argument(
        "--pattern",
        choices=list(LEGACY_PATTERN_MAP) + ["all"],
        help="Legacy alias for --scenario (velocity/large-amount/multi-currency).",
    )
    parser.add_argument("--amount", type=float, default=250_000_000,
                        help="Amount for wire-fraud scenario (VND).")
    parser.add_argument("--count", type=int, default=15,
                        help="Burst count for card-cloning scenario.")
    args = parser.parse_args()

    # Resolve target scenario list.
    if args.scenario:
        targets = list(SCENARIOS) if args.scenario == "all" else [args.scenario]
    elif args.pattern:
        if args.pattern == "all":
            targets = ["card-cloning", "wire-fraud", "fx-laundering"]
        else:
            targets = [LEGACY_PATTERN_MAP[args.pattern]]
    else:
        targets = list(SCENARIOS)  # default: run them all

    conn = psycopg2.connect(**DB_CONFIG)
    try:
        for name in targets:
            fn = SCENARIOS[name]
            if name == "card-cloning":
                fn(conn, count=args.count)
            elif name == "wire-fraud":
                fn(conn, amount=args.amount)
            else:
                fn(conn)
    finally:
        conn.close()

    print("=" * 72)
    print("Fraud simulation complete. Check the FinWatch UI (http://localhost:3002),")
    print("Grafana, or run the anomaly_*.sql queries in clickhouse/queries/.")
    print("=" * 72)


if __name__ == "__main__":
    main()
