"""
Measure maximum sustained throughput of the pipeline.
"""

import time
import argparse
import random
import json

import psycopg2
from psycopg2.extras import execute_values
from dotenv import load_dotenv
import os

load_dotenv()


def run_throughput_test(conn, total, batch_size):
    """Insert transactions as fast as possible and measure throughput."""

    with conn.cursor() as cur:
        cur.execute("SELECT id FROM accounts WHERE status='active'")
        account_ids = [row[0] for row in cur.fetchall()]
        cur.execute("SELECT id FROM merchants")
        merchant_ids = [row[0] for row in cur.fetchall()]

    print(f"Throughput test: {total} transactions, batch size {batch_size}")
    inserted = 0
    start = time.time()

    while inserted < total:
        bs = min(batch_size, total - inserted)
        rows = []
        for _ in range(bs):
            rows.append((
                random.choice(account_ids),
                random.choice(merchant_ids),
                round(random.uniform(10_000, 10_000_000), 2),
                'VND', 'purchase', 'completed',
                'throughput-test',
                json.dumps({"test": "throughput"}),
            ))

        with conn.cursor() as cur:
            execute_values(cur, """
                INSERT INTO transactions
                (account_id, merchant_id, amount, currency, type, status, description, metadata)
                VALUES %s
            """, rows)
        conn.commit()
        inserted += bs

        if inserted % 1000 == 0:
            elapsed = time.time() - start
            print(f"   {inserted}/{total} -- {inserted/elapsed:.0f} TPS")

    elapsed = time.time() - start
    tps = total / elapsed
    print(f"\nResult: {total} transactions in {elapsed:.1f}s = {tps:.0f} TPS")
    return tps


def main():
    parser = argparse.ArgumentParser(description="FinWatch Throughput Benchmark")
    parser.add_argument("--total", type=int, default=10000)
    parser.add_argument("--batch-size", type=int, default=100)
    args = parser.parse_args()

    conn = psycopg2.connect(
        host="localhost", port=5432, dbname="finwatch",
        user="finwatch", password="finwatch_secret_2024"
    )

    run_throughput_test(conn, args.total, args.batch_size)
    conn.close()


if __name__ == "__main__":
    main()
