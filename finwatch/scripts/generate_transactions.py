"""
Synthetic transaction generator for FinWatch.
Generates realistic transaction patterns for testing the pipeline.

Every insert goes through the ledger: the account row is locked with
SELECT ... FOR UPDATE, status and balance are checked, and the transaction is
recorded as 'completed' (debit/credit applied) or 'failed' (no balance change)
with a descriptive reason. This mirrors the API and the simulator so the
detect-action-reject loop is uniform across all transaction-creating paths.
"""

import argparse
import json
import os
import random
import time
from decimal import Decimal

import psycopg2
from dotenv import load_dotenv

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
DEBIT_TYPES = {"purchase", "transfer", "withdrawal"}

# Amount ranges in VND
AMOUNT_RANGES = {
    "purchase": (10_000, 5_000_000),
    "transfer": (50_000, 50_000_000),
    "withdrawal": (100_000, 10_000_000),
    "deposit": (100_000, 100_000_000),
    "refund": (10_000, 5_000_000),
}


def get_connection():
    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = False
    return conn


def load_ids(conn):
    """Load all account and merchant IDs (active and otherwise)."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM accounts")
        account_ids = [row[0] for row in cur.fetchall()]

        cur.execute("SELECT id, risk_level FROM merchants")
        merchants = [(row[0], row[1]) for row in cur.fetchall()]

    conn.commit()
    return account_ids, merchants


def generate_transaction(account_ids, merchants):
    """Generate a single random transaction (status is decided by the ledger)."""
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
        "description": f"Auto-generated {txn_type}",
        "metadata": json.dumps({"generator": "finwatch", "batch": True}),
        "ip_address": f"192.168.{random.randint(1,255)}.{random.randint(1,255)}",
        "device_id": f"device-{random.randint(1000, 9999)}",
    }


def insert_with_ledger(conn, txn):
    """
    Insert one transaction under the ledger contract:
      - Lock the account row.
      - If status != 'active'  -> status='failed', description='rejected: account <status>'.
      - If debit type with insufficient balance -> status='failed', description='insufficient funds'.
      - Otherwise -> status='completed' and balance is debited/credited.
    Returns a one-letter outcome code ('C' completed, 'R' rejected, 'I' insufficient) for stats.
    """
    amount = Decimal(str(txn["amount"]))
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT balance, status FROM accounts WHERE id = %s FOR UPDATE",
                (txn["account_id"],),
            )
            row = cur.fetchone()
            if row is None:
                conn.rollback()
                return "M"  # missing account
            balance, status = row[0], row[1]

            if status != "active":
                cur.execute(
                    """
                    INSERT INTO transactions
                      (account_id, merchant_id, amount, currency, type, status, description, metadata, ip_address, device_id)
                    VALUES (%s, %s, %s, %s, %s, 'failed', %s, %s, %s, %s)
                    """,
                    (
                        txn["account_id"], txn["merchant_id"], amount, txn["currency"],
                        txn["type"], f"rejected: account {status}",
                        txn["metadata"], txn["ip_address"], txn["device_id"],
                    ),
                )
                conn.commit()
                return "R"

            if txn["type"] in DEBIT_TYPES and balance < amount:
                cur.execute(
                    """
                    INSERT INTO transactions
                      (account_id, merchant_id, amount, currency, type, status, description, metadata, ip_address, device_id)
                    VALUES (%s, %s, %s, %s, %s, 'failed', 'insufficient funds', %s, %s, %s)
                    """,
                    (
                        txn["account_id"], txn["merchant_id"], amount, txn["currency"],
                        txn["type"], txn["metadata"], txn["ip_address"], txn["device_id"],
                    ),
                )
                conn.commit()
                return "I"

            sign = -1 if txn["type"] in DEBIT_TYPES else 1
            cur.execute(
                """
                INSERT INTO transactions
                  (account_id, merchant_id, amount, currency, type, status, description, metadata, ip_address, device_id)
                VALUES (%s, %s, %s, %s, %s, 'completed', %s, %s, %s, %s)
                """,
                (
                    txn["account_id"], txn["merchant_id"], amount, txn["currency"],
                    txn["type"], txn["description"],
                    txn["metadata"], txn["ip_address"], txn["device_id"],
                ),
            )
            cur.execute(
                "UPDATE accounts SET balance = balance + %s WHERE id = %s",
                (sign * amount, txn["account_id"]),
            )
        conn.commit()
        return "C"
    except Exception:
        conn.rollback()
        raise


def main():
    parser = argparse.ArgumentParser(description="FinWatch Transaction Generator")
    parser.add_argument("--count", type=int, default=1000, help="Total transactions")
    parser.add_argument("--tps", type=int, default=100, help="Transactions per second")
    args = parser.parse_args()

    conn = get_connection()
    account_ids, merchants = load_ids(conn)

    print(f"Generating {args.count} transactions at ~{args.tps} TPS")
    print(f"   Accounts: {len(account_ids)}, Merchants: {len(merchants)}")

    generated = 0
    counts = {"C": 0, "R": 0, "I": 0, "M": 0}
    start_time = time.time()

    while generated < args.count:
        txn = generate_transaction(account_ids, merchants)
        outcome = insert_with_ledger(conn, txn)
        counts[outcome] += 1
        generated += 1

        # Rate limiting
        elapsed = time.time() - start_time
        expected_time = generated / args.tps
        if elapsed < expected_time:
            time.sleep(expected_time - elapsed)

        if generated % 200 == 0:
            elapsed = time.time() - start_time
            actual_tps = generated / elapsed if elapsed > 0 else 0
            print(
                f"   {generated}/{args.count} -- {actual_tps:.0f} TPS "
                f"(completed={counts['C']} rejected={counts['R']} "
                f"insufficient={counts['I']} missing={counts['M']})"
            )

    elapsed = time.time() - start_time
    print(
        f"Done! {generated} transactions in {elapsed:.1f}s ({generated/elapsed:.0f} TPS); "
        f"completed={counts['C']} rejected={counts['R']} "
        f"insufficient={counts['I']} missing={counts['M']}"
    )
    conn.close()


if __name__ == "__main__":
    main()
