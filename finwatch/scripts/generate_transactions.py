"""
Synthetic transaction generator for FinWatch.
Generates realistic transaction patterns for testing the pipeline.
"""

import argparse
import random
import time
import uuid
import json
from datetime import datetime
from decimal import Decimal

import psycopg2
from psycopg2.extras import execute_values
from dotenv import load_dotenv
import os

load_dotenv()

# ============================================
# Configuration
# ============================================
DB_CONFIG = {
    "host": os.getenv("POSTGRES_HOST", "localhost"),
    "port": int(os.getenv("POSTGRES_PORT", 5432)),
    "dbname": os.getenv("POSTGRES_DB", "finwatch"),
    "user": os.getenv("POSTGRES_USER", "finwatch"),
    "password": os.getenv("POSTGRES_PASSWORD", "finwatch_secret_2024"),
}

TRANSACTION_TYPES = ["purchase", "transfer", "withdrawal", "deposit", "refund"]
TYPE_WEIGHTS = [0.45, 0.25, 0.15, 0.10, 0.05]

STATUS_OPTIONS = ["completed", "completed", "completed", "pending", "failed"]

# Amount ranges in VND
AMOUNT_RANGES = {
    "purchase": (10_000, 5_000_000),
    "transfer": (50_000, 50_000_000),
    "withdrawal": (100_000, 10_000_000),
    "deposit": (100_000, 100_000_000),
    "refund": (10_000, 5_000_000),
}


def get_connection():
    return psycopg2.connect(**DB_CONFIG)


def load_ids(conn):
    """Load account and merchant IDs from PostgreSQL."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM accounts WHERE status = 'active'")
        account_ids = [row[0] for row in cur.fetchall()]

        cur.execute("SELECT id, risk_level FROM merchants")
        merchants = [(row[0], row[1]) for row in cur.fetchall()]

    return account_ids, merchants


def generate_transaction(account_ids, merchants):
    """Generate a single random transaction."""
    txn_type = random.choices(TRANSACTION_TYPES, weights=TYPE_WEIGHTS, k=1)[0]
    lo, hi = AMOUNT_RANGES[txn_type]
    amount = round(random.uniform(lo, hi), 2)

    merchant = random.choice(merchants)

    return {
        "account_id": random.choice(account_ids),
        "merchant_id": merchant[0],
        "amount": amount,
        "currency": "VND",
        "type": txn_type,
        "status": random.choice(STATUS_OPTIONS),
        "description": f"Auto-generated {txn_type}",
        "metadata": json.dumps({"generator": "finwatch", "batch": True}),
        "ip_address": f"192.168.{random.randint(1,255)}.{random.randint(1,255)}",
        "device_id": f"device-{random.randint(1000, 9999)}",
    }


def insert_batch(conn, transactions):
    """Insert a batch of transactions."""
    cols = list(transactions[0].keys())
    values = [[t[c] for c in cols] for t in transactions]

    query = f"""
        INSERT INTO transactions ({', '.join(cols)})
        VALUES %s
    """
    with conn.cursor() as cur:
        execute_values(cur, query, values)
    conn.commit()


def main():
    parser = argparse.ArgumentParser(description="FinWatch Transaction Generator")
    parser.add_argument("--count", type=int, default=1000, help="Total transactions")
    parser.add_argument("--tps", type=int, default=100, help="Transactions per second")
    parser.add_argument("--batch-size", type=int, default=50, help="Insert batch size")
    args = parser.parse_args()

    conn = get_connection()
    account_ids, merchants = load_ids(conn)

    print(f"Generating {args.count} transactions at ~{args.tps} TPS")
    print(f"   Accounts: {len(account_ids)}, Merchants: {len(merchants)}")

    generated = 0
    start_time = time.time()

    while generated < args.count:
        batch_size = min(args.batch_size, args.count - generated)
        batch = [generate_transaction(account_ids, merchants) for _ in range(batch_size)]

        insert_batch(conn, batch)
        generated += batch_size

        # Rate limiting
        elapsed = time.time() - start_time
        expected_time = generated / args.tps
        if elapsed < expected_time:
            time.sleep(expected_time - elapsed)

        if generated % 200 == 0:
            elapsed = time.time() - start_time
            actual_tps = generated / elapsed if elapsed > 0 else 0
            print(f"   {generated}/{args.count} -- {actual_tps:.0f} TPS")

    elapsed = time.time() - start_time
    print(f"Done! {generated} transactions in {elapsed:.1f}s ({generated/elapsed:.0f} TPS)")
    conn.close()


if __name__ == "__main__":
    main()
