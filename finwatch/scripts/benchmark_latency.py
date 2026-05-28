"""End-to-end latency benchmark: PostgreSQL INSERT -> ClickHouse queryable.

Reports min/avg/median/stddev/p95/p99/max over N measurement samples with
optional warmup discarded. Reproducible via --seed.
"""

import argparse
import json
import os
import random
import statistics
import subprocess
import sys
import time
import uuid
from pathlib import Path

import psycopg2
import clickhouse_connect
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
load_dotenv(SCRIPT_DIR.parent / ".env")


def measure_latency(pg_conn, ch_client, timeout=30):
    """Insert a marked transaction and time until it appears in ClickHouse."""
    marker = str(uuid.uuid4())

    with pg_conn.cursor() as cur:
        cur.execute("SELECT id FROM accounts LIMIT 1")
        account_id = cur.fetchone()[0]
        cur.execute("SELECT id FROM merchants LIMIT 1")
        merchant_id = cur.fetchone()[0]

    start = time.time()
    with pg_conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO transactions
              (account_id, merchant_id, amount, currency, type, status, description, metadata)
            VALUES (%s, %s, 12345.67, 'VND', 'purchase', 'completed', %s, %s)
            RETURNING id
            """,
            (account_id, merchant_id, f"latency-test-{marker}",
             json.dumps({"marker": marker})),
        )
        txn_id = cur.fetchone()[0]
    pg_conn.commit()

    insert_time = time.time()

    while time.time() - start < timeout:
        result = ch_client.query(
            f"SELECT count() FROM finwatch.transactions WHERE id = '{txn_id}'"
        )
        if result.result_rows[0][0] > 0:
            end = time.time()
            return {
                "txn_id": str(txn_id),
                "pg_insert_ms": round((insert_time - start) * 1000, 1),
                "e2e_latency_ms": round((end - start) * 1000, 1),
                "pipeline_latency_ms": round((end - insert_time) * 1000, 1),
            }
        time.sleep(0.2)

    return {"txn_id": str(txn_id), "e2e_latency_ms": -1, "error": "timeout"}


def git_sha_short() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            stderr=subprocess.DEVNULL, cwd=SCRIPT_DIR.parent.parent,
        ).decode().strip()
    except Exception:
        return "unknown"


def percentile(sorted_values: list[float], p: float) -> float:
    """Linear-interp percentile on a sorted list. p in [0, 100]."""
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return sorted_values[0]
    k = (len(sorted_values) - 1) * (p / 100)
    f = int(k)
    c = min(f + 1, len(sorted_values) - 1)
    if f == c:
        return sorted_values[f]
    return sorted_values[f] + (sorted_values[c] - sorted_values[f]) * (k - f)


def print_header(args: argparse.Namespace) -> None:
    print("=" * 64)
    print("FinWatch end-to-end latency benchmark")
    print("=" * 64)
    print(f"  git SHA:        {git_sha_short()}")
    print(f"  python:         {sys.version.split()[0]}")
    print(f"  seed:           {args.seed}")
    print(f"  samples:        {args.samples} (warmup: {args.warmup}, measured: {args.samples - args.warmup})")
    print(f"  sample interval: {args.interval}s")
    print(f"  target:         {args.target_ms} ms")
    print(f"  CH stream tuning: see clickhouse/users.d/streaming.xml")
    print("=" * 64)
    print()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="FinWatch end-to-end latency benchmark",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--samples", type=int, default=20,
                        help="Total samples to take (warmup + measured).")
    parser.add_argument("--warmup", type=int, default=3,
                        help="Initial samples to discard before measuring.")
    parser.add_argument("--interval", type=float, default=2.0,
                        help="Seconds between samples.")
    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed for reproducibility.")
    parser.add_argument("--target-ms", type=int, default=5000,
                        help="SLA target — fraction of samples within is reported.")
    args = parser.parse_args()

    if args.warmup >= args.samples:
        parser.error(f"--warmup ({args.warmup}) must be < --samples ({args.samples})")

    random.seed(args.seed)
    print_header(args)

    pg_conn = psycopg2.connect(
        host=os.getenv("POSTGRES_HOST", "localhost"),
        port=int(os.getenv("POSTGRES_PORT", 5432)),
        dbname=os.getenv("POSTGRES_DB", "finwatch"),
        user=os.getenv("POSTGRES_USER", "finwatch"),
        password=os.environ["POSTGRES_PASSWORD"],
    )
    ch_client = clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "localhost"),
        port=int(os.getenv("CLICKHOUSE_HTTP_PORT", 8123)),
        database=os.getenv("CLICKHOUSE_DB", "finwatch"),
        username=os.getenv("CLICKHOUSE_USER", "default"),
        password=os.environ["CLICKHOUSE_PASSWORD"],
    )

    print(f"Measuring end-to-end latency ({args.samples} samples)...\n")
    measured: list[float] = []

    for i in range(args.samples):
        r = measure_latency(pg_conn, ch_client)
        e2e = r.get("e2e_latency_ms", -1)
        status = "OK" if e2e > 0 else "FAIL"
        is_warmup = i < args.warmup
        tag = "[warm]" if is_warmup else "[meas]"
        print(f"  {tag} [{status}] Sample {i+1:2d}/{args.samples}: "
              f"E2E={e2e if e2e > 0 else 'TIMEOUT'} ms "
              f"(PG insert: {r.get('pg_insert_ms', '?')} ms, "
              f"Pipeline: {r.get('pipeline_latency_ms', '?')} ms)")
        if not is_warmup and e2e > 0:
            measured.append(e2e)
        time.sleep(args.interval)

    pg_conn.close()

    if not measured:
        print("\nNo measured samples succeeded.")
        return 1

    sorted_vals = sorted(measured)
    print(f"\nResults ({len(measured)}/{args.samples - args.warmup} measured samples successful):")
    print(f"   Min:    {min(measured):.0f} ms")
    print(f"   Avg:    {statistics.mean(measured):.0f} ms")
    print(f"   Median: {percentile(sorted_vals, 50):.0f} ms")
    print(f"   StdDev: {statistics.stdev(measured) if len(measured) > 1 else 0:.0f} ms")
    print(f"   P95:    {percentile(sorted_vals, 95):.0f} ms")
    print(f"   P99:    {percentile(sorted_vals, 99):.0f} ms")
    print(f"   Max:    {max(measured):.0f} ms")

    within = sum(1 for v in measured if v <= args.target_ms)
    print(f"\n   Target {args.target_ms}ms: {within}/{len(measured)} "
          f"({within / len(measured) * 100:.0f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
