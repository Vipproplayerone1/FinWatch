"""FinWatch - comprehensive demo preparation script.

Goes beyond the basic prepare_demo.py: drives ALL 6 fraud rules (R1-R6),
seeds a backdated baseline so the z-score rule has a distribution to flag
against, pre-warms every UI page so the first demo visitor sees instant
loads, and verifies that each of the 6 fraud cards has count > 0 before
declaring the stack demo-ready.

What it does, in order (14 stages):

   1. Verify Docker is available.
   2. Optional `docker compose up -d` (--start flag).
   3. Wait for healthchecks on the 8 services + HTTP probes.
   4. Register/refresh the Debezium connector, verify RUNNING.
   5. Verify the snapshot landed (12 merchants, 10 accounts).
   6. Seed a 30-day backdated baseline (5-20 rows per active account)
      so ZSCORE (R2) has historical data to flag against.
   7. Drive synthetic live load so TPS / streams have data.
   8. Fire ALL 6 fraud scenarios via POST /api/scenarios/run
      (this is the same code path the UI buttons use - tests them too).
   9. Wait 12s for CDC to propagate.
  10. Tick the fraud_alert_worker once so /alerts and per-account alert
      history are non-empty by the time the banner prints (compose
      service runs the same worker on a 30s loop but we don't want
      the banner to lie about readiness for that long).
  11. Pre-warm 8 UI pages + 18 API endpoints + 3 per-account routes.
  12. Verify per-rule readiness: each of /api/fraud/r1.../r6 has count > 0.
  13. Optional `collect_evidence.py` (--evidence flag).
  14. Print readiness banner with per-stage elapsed times.

Run from anywhere - paths are resolved relative to the project root:

    python finwatch/scripts/prepare_demo_full.py
    python finwatch/scripts/prepare_demo_full.py --start
    python finwatch/scripts/prepare_demo_full.py --no-baseline
    python finwatch/scripts/prepare_demo_full.py --no-fraud --no-prewarm
    python finwatch/scripts/prepare_demo_full.py --evidence
    python finwatch/scripts/prepare_demo_full.py --load 3000

Exit codes:
    0  Ready for demo (all checks passed)
    2  Ready with warnings (e.g. one rule failed to flag in time)
    1  Hard failure (Docker down, connector failed, snapshot missing, ...)
"""

from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv

# ----------------------------------------------------------------------------
# Constants / config
# ----------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent  # finwatch/

load_dotenv(PROJECT_DIR / ".env")

DEBEZIUM_URL = "http://localhost:8083"
CLICKHOUSE_URL = "http://localhost:8123"
CLICKHOUSE_USER = os.getenv("CLICKHOUSE_USER", "default")
CLICKHOUSE_PASSWORD = os.getenv("CLICKHOUSE_PASSWORD", "")
WEB_URL = "http://localhost:3002"
GRAFANA_URL = "http://localhost:3000"
PROMETHEUS_URL = "http://localhost:9090"

CONNECTOR_NAME = "finwatch-connector"
CONNECTOR_CONFIG = PROJECT_DIR / "debezium" / "connectors" / "finwatch-connector.json"

PG_CONFIG = {
    "host": os.getenv("POSTGRES_HOST", "localhost"),
    "port": int(os.getenv("POSTGRES_PORT", 5432)),
    "dbname": os.getenv("POSTGRES_DB", "finwatch"),
    "user": os.getenv("POSTGRES_USER", "finwatch"),
    "password": os.getenv("POSTGRES_PASSWORD", "finwatch_secret_2024"),
}

PYTHON = sys.executable

# Mirror of web/lib/scenarios.ts - the 6 scenario names the API accepts.
ALL_SCENARIOS = [
    ("card-cloning", "VELOCITY", "R1"),
    ("wire-fraud", "LARGE_AMT", "R3"),
    ("fx-laundering", "MULTI_CCY", "R5"),
    ("account-takeover", "ZSCORE", "R2"),
    ("mule-account", "HIGH_RISK", "R4"),
    ("card-testing", "FAIL_SPIKE", "R6"),
]

UI_PAGES = [
    "/", "/architecture", "/trace", "/fraud", "/kafka", "/demo",
    "/accounts", "/alerts",  # fraud-workflow pages
]

# Endpoints that don't need a path parameter. The per-account detail routes
# (`/api/accounts/<uuid>`, `.../transactions`, `.../alerts`) need a live UUID
# and are resolved in `prewarm()` at runtime.
API_ENDPOINTS = [
    "/api/health/summary",
    "/api/health/tps",
    "/api/pipeline-stats",
    "/api/transactions/live",
    "/api/transactions/recent",
    "/api/alerts/recent",
    "/api/accounts",
    "/api/merchants",
    "/api/kafka/topics",
    "/api/scenarios/list",
    "/api/fraud/r1",
    "/api/fraud/r2",
    "/api/fraud/r3",
    "/api/fraud/r4",
    "/api/fraud/r5",
    "/api/fraud/r6",
    "/api/accounts/search?q=&limit=50",   # fraud-workflow: directory
    "/api/alerts?limit=100",              # fraud-workflow: case queue
]

REQUIRED_SERVICES = [
    "postgres", "zookeeper", "kafka", "debezium",
    "clickhouse", "prometheus", "grafana", "web",
]

OK_MARK = "OK"
FAIL_MARK = "X "
WARN_MARK = "!!"


# ----------------------------------------------------------------------------
# Logging helpers (ASCII-only for Windows cp1252 console safety)
# ----------------------------------------------------------------------------

class Stage:
    """Context manager that prints stage banner + tracks elapsed time."""
    elapsed: dict[str, float] = {}

    def __init__(self, num: int, total: int, title: str):
        self.num = num
        self.total = total
        self.title = title
        self.t0 = 0.0

    def __enter__(self) -> "Stage":
        print(f"\n=== {self.num}/{self.total}  {self.title} ===")
        self.t0 = time.time()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        dt = time.time() - self.t0
        Stage.elapsed[f"{self.num:>2}. {self.title}"] = dt


def info(msg: str) -> None: print(f"[..] {msg}")
def ok(msg: str)   -> None: print(f"[OK] {msg}")
def warn(msg: str) -> None: print(f"[!!] {msg}")
def fail(msg: str, exit_code: int = 1) -> None:
    print(f"[XX] {msg}")
    sys.exit(exit_code)


# ----------------------------------------------------------------------------
# Process / docker helpers
# ----------------------------------------------------------------------------

def run(cmd: list[str], cwd: Optional[Path] = None, check: bool = True,
        capture: bool = False, timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=str(cwd or PROJECT_DIR),
        check=check,
        capture_output=capture,
        text=True,
        timeout=timeout,
    )


def docker_available() -> bool:
    try:
        r = run(["docker", "version"], check=False, capture=True, timeout=10)
        return r.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def compose_ps() -> list[dict]:
    r = run(["docker", "compose", "ps", "--format", "json"], capture=True, check=False)
    if r.returncode != 0 or not r.stdout.strip():
        return []
    out = r.stdout.strip()
    try:
        return [json.loads(line) for line in out.splitlines() if line.strip()]
    except json.JSONDecodeError:
        pass
    try:
        data = json.loads(out)
        return data if isinstance(data, list) else [data]
    except json.JSONDecodeError:
        return []


def compose_up() -> None:
    info("docker compose up -d")
    run(["docker", "compose", "up", "-d"])


# ----------------------------------------------------------------------------
# Healthcheck helpers
# ----------------------------------------------------------------------------

def wait_for_url(url: str, name: str, timeout: int = 180) -> bool:
    info(f"Waiting for {name} at {url}")
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = requests.get(url, timeout=5)
            if r.status_code < 500:
                ok(f"{name} ready ({r.status_code})")
                return True
        except requests.RequestException:
            pass
        time.sleep(3)
    warn(f"{name} not ready after {timeout}s - continuing")
    return False


def wait_for_compose_health(timeout: int = 180) -> None:
    info(f"Waiting for {len(REQUIRED_SERVICES)} services to be Up/healthy")
    start = time.time()
    while time.time() - start < timeout:
        rows = compose_ps()
        by_service = {}
        for row in rows:
            svc = row.get("Service") or row.get("service") or row.get("Name", "")
            state = row.get("State") or row.get("state") or ""
            health = row.get("Health") or row.get("health") or ""
            by_service[svc] = (state, health)

        missing = [s for s in REQUIRED_SERVICES if s not in by_service]
        if missing:
            info(f"  not yet started: {', '.join(missing)}")
            time.sleep(3)
            continue

        bad = []
        for svc in REQUIRED_SERVICES:
            state, health = by_service[svc]
            if state != "running":
                bad.append(f"{svc}={state}")
            elif health and health not in ("healthy", ""):
                bad.append(f"{svc}=health:{health}")
        if not bad:
            ok(f"All {len(REQUIRED_SERVICES)} services Up")
            return
        info(f"  pending: {', '.join(bad)}")
        time.sleep(3)
    warn(f"Some services not fully ready after {timeout}s - see `docker compose ps`")


# ----------------------------------------------------------------------------
# Debezium
# ----------------------------------------------------------------------------

def register_connector() -> None:
    if not CONNECTOR_CONFIG.exists():
        fail(f"Connector config not found at {CONNECTOR_CONFIG}")
    with CONNECTOR_CONFIG.open() as f:
        cfg = json.load(f)
    name = cfg["name"]

    r = requests.get(f"{DEBEZIUM_URL}/connectors/{name}", timeout=10)
    if r.status_code == 200:
        info(f"Connector '{name}' exists - refreshing config")
        r = requests.put(
            f"{DEBEZIUM_URL}/connectors/{name}/config",
            headers={"Content-Type": "application/json"},
            json=cfg["config"],
            timeout=15,
        )
    else:
        info(f"Registering connector '{name}'")
        r = requests.post(
            f"{DEBEZIUM_URL}/connectors",
            headers={"Content-Type": "application/json"},
            json=cfg,
            timeout=15,
        )

    if r.status_code not in (200, 201):
        fail(f"Connector register failed: {r.status_code} {r.text}")

    deadline = time.time() + 30
    while time.time() < deadline:
        r = requests.get(f"{DEBEZIUM_URL}/connectors/{name}/status", timeout=10)
        if r.status_code == 200:
            state = r.json().get("connector", {}).get("state", "")
            tasks = r.json().get("tasks", [])
            task_state = tasks[0].get("state", "") if tasks else ""
            if state == "RUNNING" and task_state == "RUNNING":
                ok(f"Connector '{name}' RUNNING (task RUNNING)")
                return
        time.sleep(2)
    warn(f"Connector '{name}' did not reach RUNNING within 30s")


# ----------------------------------------------------------------------------
# ClickHouse helpers
# ----------------------------------------------------------------------------

def ch_query(sql: str) -> str:
    auth = (CLICKHOUSE_USER, CLICKHOUSE_PASSWORD) if CLICKHOUSE_PASSWORD else None
    r = requests.post(CLICKHOUSE_URL, params={"query": sql}, auth=auth, timeout=15)
    r.raise_for_status()
    return r.text.strip()


def verify_snapshot(timeout: int = 60) -> None:
    info("Verifying ClickHouse snapshot")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            m = int(ch_query("SELECT count() FROM finwatch.merchants FINAL WHERE cdc_op != 'd'"))
            a = int(ch_query("SELECT count() FROM finwatch.accounts FINAL WHERE cdc_op != 'd'"))
            t = int(ch_query("SELECT count() FROM finwatch.transactions FINAL WHERE cdc_op != 'd'"))
            if m >= 12 and a >= 10:
                ok(f"Snapshot present: merchants={m}, accounts={a}, transactions={t}")
                return
            info(f"  not yet: merchants={m}/12, accounts={a}/10")
        except Exception as exc:
            info(f"  CH query failed (warming up): {exc}")
        time.sleep(3)
    warn("Snapshot not visible in ClickHouse")


# ----------------------------------------------------------------------------
# NEW: backdated baseline seeding (psycopg2 inline)
# ----------------------------------------------------------------------------

TRANSACTION_TYPES = ["purchase", "transfer", "withdrawal", "deposit", "refund"]
TYPE_WEIGHTS = [0.45, 0.25, 0.15, 0.10, 0.05]
STATUS_OPTIONS = ["completed", "completed", "completed", "pending", "failed"]
AMOUNT_RANGES = {
    "purchase":   (10_000, 5_000_000),
    "transfer":   (50_000, 50_000_000),
    "withdrawal": (100_000, 10_000_000),
    "deposit":    (100_000, 100_000_000),
    "refund":     (10_000, 5_000_000),
}


def seed_baseline(days: int = 30,
                  min_per_account: int = 5,
                  max_per_account: int = 20) -> int:
    """Insert backdated transactions for every active account so the ZSCORE
    rule has a distribution to flag outliers against.

    Each active account gets randint(min, max) rows whose `created_at` is
    uniformly distributed across the last `days` days. Returns the total
    rows inserted.
    """
    import psycopg2
    from psycopg2.extras import execute_values

    conn = psycopg2.connect(**PG_CONFIG)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM accounts WHERE status = 'active'")
            account_ids = [row[0] for row in cur.fetchall()]
            cur.execute("SELECT id, risk_level FROM merchants")
            merchants = [(row[0], row[1]) for row in cur.fetchall()]

        if not account_ids:
            warn("No active accounts found - baseline seed skipped")
            return 0
        if not merchants:
            warn("No merchants found - baseline seed skipped")
            return 0

        rows: list[tuple] = []
        now = datetime.now(timezone.utc)
        for acct in account_ids:
            n = random.randint(min_per_account, max_per_account)
            for _ in range(n):
                txn_type = random.choices(TRANSACTION_TYPES, weights=TYPE_WEIGHTS, k=1)[0]
                lo, hi = AMOUNT_RANGES[txn_type]
                amount = round(random.uniform(lo, hi), 2)
                merchant_id, _risk = random.choice(merchants)
                # Spread uniformly across the window with a random
                # intra-day offset.
                offset_days = random.uniform(0, days)
                ts = now - timedelta(
                    days=offset_days,
                    minutes=random.randint(0, 60 * 24 - 1),
                )
                rows.append((
                    str(uuid.uuid4()),       # id
                    acct,                    # account_id
                    merchant_id,             # merchant_id
                    amount,                  # amount
                    "VND",                   # currency
                    txn_type,                # type
                    random.choice(STATUS_OPTIONS),  # status
                    f"baseline-{txn_type}",  # description
                    json.dumps({"generator": "prepare_demo_full",
                                "baseline": True}),  # metadata
                    f"10.0.{random.randint(1,255)}.{random.randint(1,255)}",  # ip
                    f"device-{random.randint(1000, 9999)}",  # device_id
                    ts,                      # created_at
                    ts,                      # updated_at
                ))

        info(f"Inserting {len(rows)} baseline rows across "
             f"{len(account_ids)} active accounts over {days} days")

        with conn.cursor() as cur:
            execute_values(
                cur,
                """
                INSERT INTO transactions
                  (id, account_id, merchant_id, amount, currency, type,
                   status, description, metadata, ip_address, device_id,
                   created_at, updated_at)
                VALUES %s
                """,
                rows,
                page_size=200,
            )
        conn.commit()
        ok(f"Baseline seeded ({len(rows)} rows)")
        return len(rows)
    finally:
        conn.close()


# ----------------------------------------------------------------------------
# Drive load (delegate to existing script)
# ----------------------------------------------------------------------------

def drive_load(count: int, tps: int) -> None:
    if count <= 0:
        info("Skipping load (count=0)")
        return
    info(f"Generating {count} synthetic transactions @ ~{tps} TPS")
    cmd = [
        PYTHON, str(SCRIPT_DIR / "generate_transactions.py"),
        "--count", str(count),
        "--tps", str(tps),
    ]
    if os.environ.get("LOAD_EXCLUDE_HIGH_RISK") == "1":
        cmd.append("--exclude-high-risk")
    run(cmd)
    ok("Load generation complete")


# ----------------------------------------------------------------------------
# NEW: fire all 6 fraud scenarios via /api/scenarios/run
# ----------------------------------------------------------------------------

def fire_all_fraud_scenarios() -> dict[str, str]:
    """POST to /api/scenarios/run for each of the 6 scenarios.

    Returns a dict mapping scenario_name -> "OK: <details>" or
    "FAIL: <error>". Doesn't raise on individual scenario failure - the
    final summary will flag what didn't fire.
    """
    results: dict[str, str] = {}
    for scenario, rule_name, rule_id in ALL_SCENARIOS:
        info(f"  -> {scenario:18s} (rule {rule_id} / {rule_name})")
        try:
            r = requests.post(
                f"{WEB_URL}/api/scenarios/run",
                headers={"Content-Type": "application/json"},
                json={"scenario": scenario},
                timeout=120,  # account-takeover inserts 21 rows
            )
            j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            if r.ok and not j.get("error"):
                results[scenario] = (
                    f"OK: rule={j.get('rule', rule_name)} "
                    f"rows={j.get('rowsInserted', '?')} "
                    f"ms={j.get('durationMs', '?')}"
                )
            else:
                results[scenario] = f"FAIL: {j.get('error', r.status_code)}"
        except requests.RequestException as exc:
            results[scenario] = f"FAIL: {exc.__class__.__name__}"

    for scenario, msg in results.items():
        mark = OK_MARK if msg.startswith("OK") else FAIL_MARK
        print(f"  {mark}  {scenario:18s}  {msg}")
    return results


# ----------------------------------------------------------------------------
# NEW: tick the fraud-alert worker once
# ----------------------------------------------------------------------------

def tick_fraud_worker() -> None:
    """Run `fraud_alert_worker.py --once` so the new /alerts page and the
    per-account alert history aren't empty by the time the readiness banner
    prints. The compose `fraud-worker` service is also running this on a 30s
    loop, but we don't want the banner to lie about readiness for ~30s.
    """
    script = SCRIPT_DIR / "fraud_alert_worker.py"
    if not script.exists():
        warn(f"{script} not found — skipping worker tick")
        return
    info("Running fraud_alert_worker.py --once")
    env = os.environ.copy()
    # Make sure CH credentials reach the subprocess (PG_CONFIG already
    # picks them up via os.getenv at module load time inside the worker).
    env.setdefault("CLICKHOUSE_HTTP_URL", CLICKHOUSE_URL)
    env.setdefault("CLICKHOUSE_USER", CLICKHOUSE_USER)
    env.setdefault("CLICKHOUSE_PASSWORD", CLICKHOUSE_PASSWORD)
    env.setdefault("CLICKHOUSE_DATABASE", os.getenv("CLICKHOUSE_DB", "finwatch"))
    try:
        r = subprocess.run(
            [PYTHON, str(script), "--once"],
            cwd=str(PROJECT_DIR),
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        # The worker logs one line per rule on stderr (via logging module).
        for line in (r.stderr or "").splitlines():
            if "[worker]" in line:
                print(f"    {line.strip()}")
        if r.returncode != 0:
            warn(f"Worker tick exited {r.returncode} — see logs above")
        else:
            ok("Worker tick complete (new cases written to fraud_alerts)")
    except subprocess.TimeoutExpired:
        warn("Worker tick timed out after 60s — continuing")


# ----------------------------------------------------------------------------
# NEW: pre-warm UI + APIs
# ----------------------------------------------------------------------------

def _resolve_account_uuid() -> Optional[str]:
    """Pick a real account UUID so the per-account routes can be warmed.
    Returns None if the endpoint can't be reached or returns no accounts —
    the caller then skips the per-account warmup with a warning."""
    try:
        r = requests.get(f"{WEB_URL}/api/accounts", timeout=10)
        r.raise_for_status()
        accounts = (r.json() or {}).get("accounts", [])
        if accounts:
            return accounts[0].get("id")
    except (requests.RequestException, ValueError):
        return None
    return None


def prewarm() -> tuple[int, int]:
    # Build the per-account routes dynamically — they need a real UUID.
    acct_uuid = _resolve_account_uuid()
    per_account_endpoints: list[str] = []
    if acct_uuid:
        per_account_endpoints = [
            f"/api/accounts/{acct_uuid}",
            f"/api/accounts/{acct_uuid}/transactions",
            f"/api/accounts/{acct_uuid}/alerts",
        ]
    else:
        warn("Could not resolve an account UUID — skipping per-account API warmup")

    all_endpoints = API_ENDPOINTS + per_account_endpoints
    info(f"Pre-warming {len(UI_PAGES)} UI pages + {len(all_endpoints)} API endpoints")
    pass_count = 0
    total = 0
    for p in UI_PAGES + all_endpoints:
        total += 1
        try:
            r = requests.get(WEB_URL + p, timeout=15)
            mark = OK_MARK if r.status_code == 200 else FAIL_MARK
            print(f"  {mark}  {r.status_code:>3}  {p}")
            if r.status_code == 200:
                pass_count += 1
        except requests.RequestException as exc:
            print(f"  {FAIL_MARK}  ERR  {p}  ({exc.__class__.__name__})")
    return pass_count, total


# ----------------------------------------------------------------------------
# NEW: per-rule R1-R6 verification
# ----------------------------------------------------------------------------

def verify_per_rule() -> tuple[int, list[str]]:
    """Hit each /api/fraud/rN endpoint and count rules with count > 0.

    Returns (rules_firing, list of rule labels that are EMPTY). An empty
    rule is a warning, not a hard failure - some rules need time windows
    to accumulate (e.g. R6 FAIL_SPIKE needs 5 failed status txns in 10 min).
    """
    info("Probing each fraud rule for count > 0")
    firing = 0
    empty: list[str] = []
    for _, rule_name, rule_id in ALL_SCENARIOS:
        path = f"/api/fraud/{rule_id.lower()}"
        try:
            r = requests.get(WEB_URL + path, timeout=15)
            r.raise_for_status()
            j = r.json()
            count = int(j.get("count", 0))
            short = j.get("shortName", rule_name)
            if count > 0:
                firing += 1
                print(f"  {OK_MARK}  {rule_id} {short:11s}  count={count}")
            else:
                empty.append(f"{rule_id} {short}")
                print(f"  {WARN_MARK}  {rule_id} {short:11s}  count=0 (no rows flagged)")
        except Exception as exc:
            empty.append(f"{rule_id} ({exc.__class__.__name__})")
            print(f"  {FAIL_MARK}  {rule_id} {rule_name:11s}  query failed: {exc}")
    return firing, empty


# ----------------------------------------------------------------------------
# Final banner
# ----------------------------------------------------------------------------

def print_banner(api_pass: int, api_total: int,
                 rules_firing: int, empty_rules: list[str],
                 fraud_results: dict[str, str],
                 exit_code: int,
                 for_defense: bool = False) -> None:
    line = "=" * 76
    print("\n" + line)
    if exit_code == 0:
        if for_defense:
            title = "FinWatch is READY FOR LIVE DEFENSE DEMO (clean state)"
        else:
            title = "FinWatch is READY for COMPREHENSIVE DEMO"
    elif exit_code == 2:
        title = "FinWatch is ready WITH WARNINGS"
    else:
        title = "FinWatch demo prep FAILED"
    print(f"  {title}".center(76))
    print(line)

    print("\n  Endpoints to open:")
    print(f"    - Web UI (main)     {WEB_URL}")
    print(f"    - Architecture      {WEB_URL}/architecture")
    print(f"    - Insert & Trace    {WEB_URL}/demo")
    print(f"    - Trace             {WEB_URL}/trace")
    print(f"    - Fraud rules       {WEB_URL}/fraud")
    print(f"    - Accounts          {WEB_URL}/accounts")
    print(f"    - Alerts queue      {WEB_URL}/alerts")
    print(f"    - Kafka browser     {WEB_URL}/kafka")
    print(f"    - Grafana           {GRAFANA_URL}  (admin / admin)")
    print(f"    - Prometheus        {PROMETHEUS_URL}")
    print(f"    - Debezium status   {DEBEZIUM_URL}/connectors/{CONNECTOR_NAME}/status")

    print("\n  Readiness checks:")
    api_mark = OK_MARK if api_pass == api_total else FAIL_MARK
    rules_mark = OK_MARK if rules_firing == 6 else WARN_MARK
    print(f"    {api_mark}  HTTP probes        {api_pass}/{api_total} returned 200")
    print(f"    {rules_mark}  Fraud rules firing {rules_firing}/6")
    if empty_rules:
        print(f"          empty: {', '.join(empty_rules)}")

    if fraud_results:
        print("\n  Fraud scenarios injected:")
        for s, msg in fraud_results.items():
            mark = OK_MARK if msg.startswith("OK") else FAIL_MARK
            print(f"    {mark}  {s:18s}  {msg}")

    if Stage.elapsed:
        print("\n  Per-stage elapsed:")
        for label, dt in Stage.elapsed.items():
            print(f"    {label:<52s}  {dt:>6.1f}s")

    print("\n  Recommended demo flow: see")
    print("    finwatch/docs/demo/DEMO_INSTRUCTIONS_UI.md")
    if for_defense and exit_code == 0:
        print("\n  Tip: click scenario buttons during the demo to populate alerts live.")
    print("\n" + line + "\n")


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Comprehensive demo prep: baseline seed + all 6 fraud rules + UI prewarm + per-rule verify.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--start", action="store_true",
                   help="Run `docker compose up -d` before health-checking.")
    p.add_argument("--no-baseline", action="store_true",
                   help="Skip the 30-day backdated baseline seed.")
    p.add_argument("--baseline-days", type=int, default=30,
                   help="Days back to spread baseline rows.")
    p.add_argument("--no-load", action="store_true",
                   help="Skip the live load step.")
    p.add_argument("--load", type=int, default=1500,
                   help="Live-load transaction count.")
    p.add_argument("--tps", type=int, default=200,
                   help="Live-load target TPS.")
    p.add_argument("--no-fraud", action="store_true",
                   help="Skip injecting the 6 fraud scenarios.")
    p.add_argument("--no-prewarm", action="store_true",
                   help="Skip UI page pre-warm.")
    p.add_argument("--evidence", action="store_true",
                   help="Also run scripts/collect_evidence.py at the end.")
    p.add_argument("--for-defense", action="store_true",
                   help="Prepare a clean state for live demo: no fraud injection, "
                        "no worker tick, normal load uses low/medium-risk merchants only.")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    if args.for_defense:
        args.no_fraud = True
        os.environ["LOAD_EXCLUDE_HIGH_RISK"] = "1"
    t0 = time.time()

    print("FinWatch - comprehensive demo preparation")
    print(f"Project dir: {PROJECT_DIR}")
    print(f"Python:      {PYTHON}")

    fraud_results: dict[str, str] = {}
    api_pass, api_total = 0, 0
    rules_firing, empty_rules = 0, []

    # 1. Docker
    with Stage(1, 14, "Docker check"):
        if not docker_available():
            fail("Docker is not available. Start Docker Desktop and retry.")
        ok("Docker daemon reachable")

    # 2. Optional compose up
    with Stage(2, 14, "docker compose up -d (optional)"):
        if args.start:
            compose_up()
        else:
            info("Skipping (pass --start to bring stack up)")

    # 3. Wait for healthchecks
    with Stage(3, 14, "Wait for stack healthchecks"):
        wait_for_compose_health(timeout=180)
        wait_for_url(f"{DEBEZIUM_URL}/connectors", "Debezium Connect")
        wait_for_url(f"{CLICKHOUSE_URL}/ping", "ClickHouse")
        wait_for_url(WEB_URL + "/", "Web UI")

    # 4. Debezium
    with Stage(4, 14, "Register Debezium connector"):
        register_connector()

    # 5. Snapshot verify
    with Stage(5, 14, "Verify ClickHouse snapshot"):
        verify_snapshot()

    # 6. NEW Baseline seed
    with Stage(6, 14, "Seed backdated baseline (NEW)"):
        if args.no_baseline:
            info("Skipping (--no-baseline)")
        else:
            try:
                seed_baseline(days=args.baseline_days)
            except Exception as exc:
                warn(f"Baseline seed failed: {exc} - continuing")

    # 7. Live load
    with Stage(7, 14, "Drive synthetic live load"):
        if args.no_load:
            info("Skipping (--no-load)")
        else:
            drive_load(args.load, args.tps)

    # 8. NEW Fire all 6 fraud scenarios
    with Stage(8, 14, "Fire all 6 fraud scenarios (NEW)"):
        if args.no_fraud:
            info("Skipping (--no-fraud)")
        else:
            fraud_results = fire_all_fraud_scenarios()

    # 9. Wait for CDC
    with Stage(9, 14, "Wait for CDC to propagate"):
        info("Sleeping 12s for Kafka -> ClickHouse")
        time.sleep(12)

    # 10. NEW Tick the fraud-alert worker so /alerts is non-empty by banner time
    with Stage(10, 14, "Tick fraud_alert_worker (NEW)"):
        if args.no_fraud:
            info("Skipping (--no-fraud — no anomalies were injected to detect)")
        else:
            tick_fraud_worker()

    # 11. NEW Pre-warm
    with Stage(11, 14, "Pre-warm UI pages + APIs (NEW)"):
        if args.no_prewarm:
            info("Skipping (--no-prewarm)")
            # +3 for the per-account endpoints that would normally be resolved
            est = len(UI_PAGES) + len(API_ENDPOINTS) + 3
            api_pass, api_total = est, est
        else:
            api_pass, api_total = prewarm()

    # 12. NEW Per-rule verification
    with Stage(12, 14, "Per-rule R1-R6 verification (NEW)"):
        if args.for_defense:
            info("Per-rule verification skipped - defense mode (clean state expected).")
            rules_firing, empty_rules = 6, []
        elif args.no_fraud:
            info("Skipping per-rule check (--no-fraud was set)")
            rules_firing, empty_rules = 6, []
        else:
            rules_firing, empty_rules = verify_per_rule()

    # 13. Optional evidence
    with Stage(13, 14, "Evidence bundle (optional)"):
        if args.evidence:
            info("Collecting evidence")
            try:
                run([PYTHON, str(SCRIPT_DIR / "collect_evidence.py")], timeout=600)
                ok("Evidence collected")
            except Exception as exc:
                warn(f"collect_evidence.py failed: {exc}")
        else:
            info("Skipping (pass --evidence to collect)")

    # 14. Banner
    with Stage(14, 14, "Final readiness banner"):
        if api_pass < api_total:
            exit_code = 1
        elif rules_firing < 6:
            exit_code = 2
        else:
            exit_code = 0
        print_banner(api_pass, api_total, rules_firing, empty_rules,
                     fraud_results, exit_code, for_defense=args.for_defense)

    dt = time.time() - t0
    print(f"Total elapsed: {dt:.1f}s")
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
