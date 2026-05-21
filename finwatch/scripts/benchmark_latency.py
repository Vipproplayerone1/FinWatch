"""
Measure end-to-end latency: PostgreSQL INSERT -> ClickHouse queryable.
"""

import time
import uuid
import json
import argparse

import psycopg2
import clickhouse_connect
from dotenv import load_dotenv
import os

load_dotenv()


def measure_latency(pg_conn, ch_client, timeout=30):
    """Insert a marked transaction and time until it appears in ClickHouse."""
    marker = str(uuid.uuid4())

    # Get account and merchant IDs
    with pg_conn.cursor() as cur:
        cur.execute("SELECT id FROM accounts LIMIT 1")
        account_id = cur.fetchone()[0]
        cur.execute("SELECT id FROM merchants LIMIT 1")
        merchant_id = cur.fetchone()[0]

    # Insert into PostgreSQL
    start = time.time()
    with pg_conn.cursor() as cur:
        cur.execute("""
            INSERT INTO transactions
            (account_id, merchant_id, amount, currency, type, status, description, metadata)
            VALUES (%s, %s, 12345.67, 'VND', 'purchase', 'completed', %s, %s)
            RETURNING id
        """, (account_id, merchant_id, f"latency-test-{marker}",
              json.dumps({"marker": marker})))
        txn_id = cur.fetchone()[0]
    pg_conn.commit()

    insert_time = time.time()

    # Poll ClickHouse
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


def main():
    parser = argparse.ArgumentParser(description="FinWatch Latency Benchmark")
    parser.add_argument("--samples", type=int, default=20, help="Number of latency samples")
    parser.add_argument("--interval", type=float, default=2.0, help="Seconds between samples")
    args = parser.parse_args()

    pg_conn = psycopg2.connect(
        host="localhost", port=5432, dbname="finwatch",
        user="finwatch", password="finwatch_secret_2024"
    )
    ch_client = clickhouse_connect.get_client(
        host="localhost", port=8123, database="finwatch",
        username="default", password="clickhouse_secret_2024"
    )

    print(f"Measuring end-to-end latency ({args.samples} samples)...\n")
    results = []

    for i in range(args.samples):
        r = measure_latency(pg_conn, ch_client)
        results.append(r)
        status = "OK" if r.get("e2e_latency_ms", -1) > 0 else "FAIL"
        print(f"  [{status}] Sample {i+1}: E2E = {r.get('e2e_latency_ms', 'TIMEOUT')} ms "
              f"(PG insert: {r.get('pg_insert_ms', '?')} ms, "
              f"Pipeline: {r.get('pipeline_latency_ms', '?')} ms)")
        time.sleep(args.interval)

    # Summary
    valid = [r["e2e_latency_ms"] for r in results if r.get("e2e_latency_ms", -1) > 0]
    if valid:
        print(f"\nResults ({len(valid)}/{args.samples} successful):")
        print(f"   Min:    {min(valid):.0f} ms")
        print(f"   Max:    {max(valid):.0f} ms")
        print(f"   Avg:    {sum(valid)/len(valid):.0f} ms")
        print(f"   Median: {sorted(valid)[len(valid)//2]:.0f} ms")
        print(f"   P95:    {sorted(valid)[int(len(valid)*0.95)]:.0f} ms")

        target = 5000
        within_target = sum(1 for v in valid if v <= target)
        print(f"\n   Target {target}ms: {within_target}/{len(valid)} "
              f"({within_target/len(valid)*100:.0f}%)")

    pg_conn.close()


if __name__ == "__main__":
    main()
