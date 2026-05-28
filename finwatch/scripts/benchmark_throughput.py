"""Throughput benchmark: maximum sustained PostgreSQL insert rate.

Inserts N transactions in batches with a configurable batch size and
reports total elapsed time + TPS. Reproducible via --seed.
"""

import argparse
import json
import os
import random
import statistics
import subprocess
import sys
import time
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
load_dotenv(SCRIPT_DIR.parent / ".env")


def git_sha_short() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            stderr=subprocess.DEVNULL, cwd=SCRIPT_DIR.parent.parent,
        ).decode().strip()
    except Exception:
        return "unknown"


def print_header(args: argparse.Namespace) -> None:
    print("=" * 64)
    print("FinWatch throughput benchmark")
    print("=" * 64)
    print(f"  git SHA:        {git_sha_short()}")
    print(f"  python:         {sys.version.split()[0]}")
    print(f"  seed:           {args.seed}")
    print(f"  total rows:     {args.total} (warmup: {args.warmup}, measured: {args.total - args.warmup})")
    print(f"  batch size:     {args.batch_size}")
    print(f"  target TPS:     {args.target_tps}")
    print(f"  note:           inserts bypass the application-layer ledger; balance is not updated.")
    print("=" * 64)
    print()


def run_throughput_test(conn, total: int, batch_size: int, warmup: int) -> dict:
    """Insert `total` rows in `batch_size` batches; the first `warmup` rows
    are inserted but excluded from TPS calculation.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM accounts WHERE status='active'")
        account_ids = [row[0] for row in cur.fetchall()]
        cur.execute("SELECT id FROM merchants")
        merchant_ids = [row[0] for row in cur.fetchall()]

    print(f"Throughput test: {total} rows, batch size {batch_size}, "
          f"warmup {warmup} rows")
    inserted = 0
    warmup_done_at: float | None = None
    measured_start: float | None = None
    batch_durations_ms: list[float] = []
    start = time.time()

    while inserted < total:
        bs = min(batch_size, total - inserted)
        rows = []
        for _ in range(bs):
            rows.append((
                random.choice(account_ids),
                random.choice(merchant_ids),
                round(random.uniform(10_000, 10_000_000), 2),
                "VND", "purchase", "completed",
                "throughput-test",
                json.dumps({"test": "throughput"}),
            ))

        t0 = time.time()
        with conn.cursor() as cur:
            execute_values(
                cur,
                """
                INSERT INTO transactions
                  (account_id, merchant_id, amount, currency, type, status, description, metadata)
                VALUES %s
                """,
                rows,
            )
        conn.commit()
        batch_ms = (time.time() - t0) * 1000

        prev = inserted
        inserted += bs
        if warmup_done_at is None and inserted >= warmup:
            warmup_done_at = time.time()
            measured_start = warmup_done_at
            print(f"   warmup complete at {inserted} rows ({warmup_done_at - start:.2f}s "
                  f"since start)")

        if inserted > warmup:
            batch_durations_ms.append(batch_ms)

        if inserted % max(batch_size, 1000) == 0:
            elapsed = time.time() - start
            print(f"   {inserted}/{total} -- {inserted / elapsed:.0f} TPS (rolling)")

    end = time.time()
    total_elapsed = end - start
    measured_rows = total - warmup
    measured_elapsed = end - (measured_start or start)
    sustained_tps = measured_rows / measured_elapsed if measured_elapsed > 0 else 0

    return {
        "total_rows": total,
        "warmup_rows": warmup,
        "measured_rows": measured_rows,
        "total_elapsed_s": total_elapsed,
        "measured_elapsed_s": measured_elapsed,
        "burst_tps": total / total_elapsed,
        "sustained_tps": sustained_tps,
        "batches_measured": len(batch_durations_ms),
        "batch_ms_min": min(batch_durations_ms) if batch_durations_ms else 0,
        "batch_ms_avg": statistics.mean(batch_durations_ms) if batch_durations_ms else 0,
        "batch_ms_p95": sorted(batch_durations_ms)[int(len(batch_durations_ms) * 0.95)]
                        if batch_durations_ms else 0,
        "batch_ms_max": max(batch_durations_ms) if batch_durations_ms else 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="FinWatch throughput benchmark",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--total", type=int, default=10000,
                        help="Total rows to insert (warmup + measured).")
    parser.add_argument("--batch-size", type=int, default=100,
                        help="Rows per execute_values batch.")
    parser.add_argument("--warmup", type=int, default=500,
                        help="Initial rows to insert before TPS measurement starts.")
    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed for reproducibility.")
    parser.add_argument("--target-tps", type=int, default=1000,
                        help="Target sustained TPS to compare against.")
    args = parser.parse_args()

    if args.warmup >= args.total:
        parser.error(f"--warmup ({args.warmup}) must be < --total ({args.total})")

    random.seed(args.seed)
    print_header(args)

    conn = psycopg2.connect(
        host=os.getenv("POSTGRES_HOST", "localhost"),
        port=int(os.getenv("POSTGRES_PORT", 5432)),
        dbname=os.getenv("POSTGRES_DB", "finwatch"),
        user=os.getenv("POSTGRES_USER", "finwatch"),
        password=os.environ["POSTGRES_PASSWORD"],
    )

    try:
        r = run_throughput_test(conn, args.total, args.batch_size, args.warmup)
    finally:
        conn.close()

    print(f"\nResults:")
    print(f"   Total rows:          {r['total_rows']}")
    print(f"   Warmup rows:         {r['warmup_rows']}")
    print(f"   Measured rows:       {r['measured_rows']}")
    print(f"   Burst TPS (all):     {r['burst_tps']:.0f}")
    print(f"   Sustained TPS:       {r['sustained_tps']:.0f} (excludes warmup)")
    print(f"   Batches measured:    {r['batches_measured']}")
    print(f"   Per-batch min/avg/p95/max: "
          f"{r['batch_ms_min']:.1f} / {r['batch_ms_avg']:.1f} / "
          f"{r['batch_ms_p95']:.1f} / {r['batch_ms_max']:.1f} ms")
    print()
    if r['sustained_tps'] >= args.target_tps:
        print(f"   Target {args.target_tps} TPS: PASS ({r['sustained_tps']:.0f} >= {args.target_tps})")
    else:
        print(f"   Target {args.target_tps} TPS: BELOW ({r['sustained_tps']:.0f} < {args.target_tps})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
