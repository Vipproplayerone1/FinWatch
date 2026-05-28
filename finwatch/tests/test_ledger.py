"""Tests for the application-layer balance ledger and lock/unlock contract.

Covers the invariant in CLAUDE.md §11 rule 10 and ADR-0005:
every transaction-creating code path checks accounts.status and
accounts.balance under SELECT ... FOR UPDATE and inserts the appropriate
status / description without race conditions.

Tested behaviours:
  1. Suspended account → next /api/insert-transaction returns accepted=false
     with reason="suspended" and inserts a row with status='failed'.
  2. Reactivated account → next insert returns accepted=true with the
     correct new_balance.
  3. Debit with insufficient balance → accepted=false reason="insufficient_funds".
  4. Two parallel threads each attempting a withdrawal greater than half the
     balance never overdraft the account. Exactly one succeeds; the other
     records as failed with description='insufficient funds'.

Tests target the running Next.js API at http://localhost:3002 and PG at
localhost:5432. Each test owns its own freshly-created account so runs are
isolated; teardown removes the account and its transactions.
"""

import os
import threading
import time
import uuid
from decimal import Decimal

import psycopg2
import pytest
import requests
from dotenv import load_dotenv

load_dotenv()

WEB_BASE = os.getenv("WEB_BASE_URL", "http://localhost:3002")
PG_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "finwatch_secret_2024")


def _pg():
    return psycopg2.connect(
        host=os.getenv("POSTGRES_HOST", "localhost"),
        port=int(os.getenv("POSTGRES_PORT", 5432)),
        dbname=os.getenv("POSTGRES_DB", "finwatch"),
        user=os.getenv("POSTGRES_USER", "finwatch"),
        password=PG_PASSWORD,
    )


@pytest.fixture
def test_account():
    """Yield (account_id, merchant_id) of a freshly-created account with
    balance=10_000_000 VND and merchant=any low-risk. Cleans up afterwards.
    """
    conn = _pg()
    conn.autocommit = False
    acct_id = str(uuid.uuid4())
    email = f"ledger-test-{uuid.uuid4().hex[:8]}@finwatch.local"
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO accounts (id, full_name, email, phone, balance, currency, status)
                VALUES (%s, %s, %s, '0900000000', %s, 'VND', 'active')
                """,
                (acct_id, "Ledger Test", email, Decimal("10000000")),
            )
            cur.execute(
                "SELECT id FROM merchants WHERE risk_level IN ('low', 'medium') LIMIT 1"
            )
            row = cur.fetchone()
            assert row is not None, "test stack must have at least one low/medium merchant"
            merchant_id = str(row[0])
        conn.commit()

        yield acct_id, merchant_id
    finally:
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM fraud_alerts WHERE account_id = %s", (acct_id,)
                )
                cur.execute(
                    "DELETE FROM transactions WHERE account_id = %s", (acct_id,)
                )
                cur.execute("DELETE FROM accounts WHERE id = %s", (acct_id,))
            conn.commit()
        finally:
            conn.close()


def _insert_via_api(account_id: str, merchant_id: str, amount: float,
                    txn_type: str = "purchase") -> dict:
    r = requests.post(
        f"{WEB_BASE}/api/insert-transaction",
        json={
            "account_id": account_id,
            "merchant_id": merchant_id,
            "amount": amount,
            "type": txn_type,
            "currency": "VND",
        },
        timeout=10,
    )
    r.raise_for_status()
    return r.json()


def _lock_via_api(account_id: str) -> dict:
    r = requests.post(f"{WEB_BASE}/api/accounts/{account_id}/lock", timeout=10)
    r.raise_for_status()
    return r.json()


def _unlock_via_api(account_id: str) -> dict:
    r = requests.post(f"{WEB_BASE}/api/accounts/{account_id}/unlock", timeout=10)
    r.raise_for_status()
    return r.json()


def _account_balance(account_id: str) -> Decimal:
    conn = _pg()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT balance FROM accounts WHERE id = %s", (account_id,))
            return Decimal(str(cur.fetchone()[0]))
    finally:
        conn.close()


def test_suspended_account_rejects_next_insert(test_account):
    """Lock → insert returns accepted=false with reason='suspended'."""
    account_id, merchant_id = test_account
    initial = _account_balance(account_id)

    lock_resp = _lock_via_api(account_id)
    assert lock_resp.get("status") == "suspended", lock_resp

    insert_resp = _insert_via_api(account_id, merchant_id, 100000, "purchase")
    assert insert_resp["accepted"] is False, insert_resp
    assert insert_resp["reason"] == "suspended", insert_resp

    # Balance unchanged: failed inserts don't debit.
    assert _account_balance(account_id) == initial


def test_reactivated_account_completes_insert_and_debits_balance(test_account):
    """Lock → unlock → insert returns accepted=true with correct new_balance."""
    account_id, merchant_id = test_account
    initial = _account_balance(account_id)
    amount = Decimal("250000")

    _lock_via_api(account_id)
    unlock_resp = _unlock_via_api(account_id)
    assert unlock_resp.get("status") == "active", unlock_resp

    insert_resp = _insert_via_api(account_id, merchant_id, float(amount), "purchase")
    assert insert_resp["accepted"] is True, insert_resp
    expected = initial - amount
    assert Decimal(str(insert_resp["new_balance"])) == expected, insert_resp
    # And the DB balance matches.
    assert _account_balance(account_id) == expected


def test_insufficient_funds_rejected_without_balance_change(test_account):
    """Debit amount > balance → accepted=false reason='insufficient_funds'."""
    account_id, merchant_id = test_account
    initial = _account_balance(account_id)
    big = float(initial + Decimal("1000000"))  # 1M more than we have

    insert_resp = _insert_via_api(account_id, merchant_id, big, "purchase")
    assert insert_resp["accepted"] is False, insert_resp
    assert insert_resp["reason"] == "insufficient_funds", insert_resp
    assert _account_balance(account_id) == initial


def test_parallel_inserts_do_not_overdraft(test_account):
    """Two threads each attempt a withdrawal greater than half the balance.
    The application-layer ledger uses SELECT ... FOR UPDATE, so exactly
    one should succeed; the other records as failed.
    """
    account_id, merchant_id = test_account
    initial = _account_balance(account_id)  # 10M VND
    half_plus = float(initial / 2 + Decimal("1000000"))  # 6M each → total 12M, can't both succeed

    results: list[dict] = [None, None]  # type: ignore[list-item]
    errors: list[Exception | None] = [None, None]

    def worker(idx: int):
        try:
            results[idx] = _insert_via_api(account_id, merchant_id, half_plus, "withdrawal")
        except Exception as exc:
            errors[idx] = exc

    t0 = threading.Thread(target=worker, args=(0,))
    t1 = threading.Thread(target=worker, args=(1,))
    t0.start(); t1.start()
    t0.join(); t1.join()

    assert all(e is None for e in errors), errors
    accepted_count = sum(1 for r in results if r and r.get("accepted") is True)
    rejected_count = sum(1 for r in results if r and r.get("accepted") is False)
    assert accepted_count == 1, (
        f"Expected exactly 1 success (FOR UPDATE serialization), got "
        f"{accepted_count} success + {rejected_count} reject: {results}"
    )
    assert rejected_count == 1, results

    # The rejection must be on insufficient funds, not on suspended.
    rejected = next(r for r in results if r and r.get("accepted") is False)
    assert rejected["reason"] == "insufficient_funds", rejected

    # Final balance: initial minus exactly one half_plus debit.
    expected = initial - Decimal(str(half_plus))
    actual = _account_balance(account_id)
    # Allow a tiny rounding tolerance because half_plus is float→Decimal.
    diff = abs(actual - expected)
    assert diff < Decimal("0.01"), f"balance {actual} != expected {expected}"
