"""Tests for data integrity between PostgreSQL and ClickHouse.

All ClickHouse reads follow the design invariant in CLAUDE.md §8:
`FROM finwatch.<table> FINAL WHERE cdc_op != 'd'` (queries see only the
latest, non-deleted version of each row).

The CDC pipeline is eventually consistent. Tests that compare PG vs CH
counts use a short wait loop to absorb normal pipeline lag (~few seconds).
"""

import time
import uuid

import clickhouse_connect
import psycopg2


CONSISTENCY_TIMEOUT_S = 30
CONSISTENCY_POLL_S = 1.0


def _wait_for_match(pg_count_fn, ch_count_fn, timeout=CONSISTENCY_TIMEOUT_S):
    """Poll until PG count == CH count, or fail after timeout."""
    deadline = time.time() + timeout
    pg_count = ch_count = None
    while time.time() < deadline:
        pg_count = pg_count_fn()
        ch_count = ch_count_fn()
        if pg_count == ch_count:
            return pg_count, ch_count
        time.sleep(CONSISTENCY_POLL_S)
    return pg_count, ch_count


def get_pg_conn():
    return psycopg2.connect(
        host="localhost", port=5432, dbname="finwatch",
        user="finwatch", password="finwatch_secret_2024"
    )


def get_ch_client():
    return clickhouse_connect.get_client(
        host="localhost", port=8123, database="finwatch",
        username="default", password="clickhouse_secret_2024"
    )


def _pg_count(pg, table):
    def f():
        with pg.cursor() as cur:
            cur.execute(f"SELECT count(*) FROM {table}")
            return cur.fetchone()[0]
    return f


def _ch_count(ch, table):
    def f():
        return ch.query(
            f"SELECT count() FROM finwatch.{table} FINAL WHERE cdc_op != 'd'"
        ).result_rows[0][0]
    return f


def test_merchants_count_match():
    pg = get_pg_conn()
    ch = get_ch_client()
    try:
        pg_count, ch_count = _wait_for_match(
            _pg_count(pg, "merchants"), _ch_count(ch, "merchants")
        )
    finally:
        pg.close()
    assert pg_count == ch_count, (
        f"PG={pg_count}, CH={ch_count} after {CONSISTENCY_TIMEOUT_S}s catch-up"
    )


def test_accounts_count_match():
    pg = get_pg_conn()
    ch = get_ch_client()
    try:
        pg_count, ch_count = _wait_for_match(
            _pg_count(pg, "accounts"), _ch_count(ch, "accounts")
        )
    finally:
        pg.close()
    assert pg_count == ch_count, (
        f"PG={pg_count}, CH={ch_count} after {CONSISTENCY_TIMEOUT_S}s catch-up"
    )


def test_clickhouse_has_transactions():
    ch = get_ch_client()
    count = ch.query(
        "SELECT count() FROM finwatch.transactions FINAL WHERE cdc_op != 'd'"
    ).result_rows[0][0]
    assert count > 0, "ClickHouse should have transactions"


def test_all_transaction_types_present():
    """Insert one transaction of each declared type via CDC, then assert
    all five appear in ClickHouse. Self-contained: doesn't depend on prior
    load generation, and the markers are deleted in teardown."""
    pg = get_pg_conn()
    ch = get_ch_client()
    marker = f"types-check-{uuid.uuid4()}"
    types = ["purchase", "transfer", "withdrawal", "deposit", "refund"]

    try:
        with pg.cursor() as cur:
            cur.execute("SELECT id FROM accounts WHERE status='active' LIMIT 1")
            account_id = cur.fetchone()[0]
            cur.execute("SELECT id FROM merchants LIMIT 1")
            merchant_id = cur.fetchone()[0]
            for t in types:
                cur.execute(
                    """
                    INSERT INTO transactions
                      (account_id, merchant_id, amount, currency, type, status, description)
                    VALUES (%s, %s, 100000, 'VND', %s, 'completed', %s)
                    """,
                    (account_id, merchant_id, t, marker),
                )
        pg.commit()

        # Wait up to 15 s for all 5 to reach ClickHouse.
        import time
        deadline = time.time() + 15
        seen_types = set()
        while time.time() < deadline:
            r = ch.query(
                "SELECT DISTINCT type FROM finwatch.transactions FINAL "
                f"WHERE description = '{marker}' AND cdc_op != 'd'"
            )
            seen_types = {row[0] for row in r.result_rows}
            if set(types).issubset(seen_types):
                break
            time.sleep(0.5)

        assert set(types).issubset(seen_types), (
            f"Missing types: {set(types) - seen_types}. Seen: {seen_types}"
        )
    finally:
        with pg.cursor() as cur:
            cur.execute(
                "DELETE FROM transactions WHERE description = %s", (marker,)
            )
        pg.commit()
        pg.close()
