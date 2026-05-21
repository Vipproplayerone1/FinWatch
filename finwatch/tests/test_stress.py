"""TC-17.1 — high-volume stress test.

Pushes 100 000 transactions through the pipeline and asserts:
  - sustained insert TPS > 1000,
  - zero data loss (PG count == CH count within a catch-up window).

Marked `slow` because it takes ~2 minutes; run with `pytest -m slow`.
"""

import os
import random
import time
import uuid

import clickhouse_connect
import psycopg2
import pytest
from psycopg2.extras import execute_values


DB_CONFIG = {
    "host": os.getenv("POSTGRES_HOST", "localhost"),
    "port": int(os.getenv("POSTGRES_PORT", 5432)),
    "dbname": os.getenv("POSTGRES_DB", "finwatch"),
    "user": os.getenv("POSTGRES_USER", "finwatch"),
    "password": os.getenv("POSTGRES_PASSWORD", "finwatch_secret_2024"),
}

CH_CONFIG = {
    "host": "localhost",
    "port": 8123,
    "database": "finwatch",
    "username": "default",
    "password": "clickhouse_secret_2024",
}

TOTAL_TXNS = 100_000
BATCH_SIZE = 500
CATCH_UP_TIMEOUT_S = 180
TPS_TARGET = 1000


@pytest.mark.slow
def test_stress_100k_transactions_zero_loss():
    pg = psycopg2.connect(**DB_CONFIG)
    ch = clickhouse_connect.get_client(**CH_CONFIG)
    marker = f"stress-test-{uuid.uuid4()}"

    with pg.cursor() as cur:
        cur.execute("SELECT id FROM accounts WHERE status='active'")
        account_ids = [r[0] for r in cur.fetchall()]
        cur.execute("SELECT id FROM merchants")
        merchant_ids = [r[0] for r in cur.fetchall()]

    start = time.time()
    inserted = 0
    while inserted < TOTAL_TXNS:
        bs = min(BATCH_SIZE, TOTAL_TXNS - inserted)
        rows = [
            (
                random.choice(account_ids),
                random.choice(merchant_ids),
                round(random.uniform(10_000, 10_000_000), 2),
                "VND",
                "purchase",
                "completed",
                marker,
            )
            for _ in range(bs)
        ]
        with pg.cursor() as cur:
            execute_values(
                cur,
                "INSERT INTO transactions "
                "(account_id, merchant_id, amount, currency, type, status, description) "
                "VALUES %s",
                rows,
            )
        pg.commit()
        inserted += bs

    elapsed = time.time() - start
    insert_tps = inserted / elapsed
    print(
        f"\n[stress] inserted {inserted} in {elapsed:.1f}s = {insert_tps:.0f} TPS"
    )
    assert insert_tps > TPS_TARGET, (
        f"Insert throughput {insert_tps:.0f} TPS below target {TPS_TARGET}"
    )

    # Count only THIS run's marker on both sides — ignores prior-test noise
    # (CREATE events whose DELETE counterparts may still be in-flight on
    # the Kafka topic from earlier tests).
    deadline = time.time() + CATCH_UP_TIMEOUT_S
    pg_marker = None
    ch_marker = None
    while time.time() < deadline:
        pg_marker = _marker_count_pg(pg, marker)
        ch_marker = _marker_count_ch(ch, marker)
        if pg_marker == ch_marker == TOTAL_TXNS:
            break
        time.sleep(2)

    catch_up_s = time.time() - (start + elapsed)
    print(
        f"[stress] PG marker count {pg_marker}, CH marker count {ch_marker}, "
        f"catch-up {catch_up_s:.1f}s"
    )

    try:
        assert pg_marker == TOTAL_TXNS, (
            f"Postgres marker count {pg_marker} != expected {TOTAL_TXNS}"
        )
        assert ch_marker == TOTAL_TXNS, (
            f"Data loss: PG={pg_marker}, CH={ch_marker}, "
            f"diff={pg_marker - ch_marker} after {CATCH_UP_TIMEOUT_S}s catch-up"
        )
    finally:
        # Best-effort cleanup so the next run doesn't accumulate stress rows.
        with pg.cursor() as cur:
            cur.execute(
                "DELETE FROM transactions WHERE description = %s", (marker,)
            )
        pg.commit()
        pg.close()


def _marker_count_pg(pg, marker):
    with pg.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM transactions WHERE description = %s", (marker,)
        )
        return cur.fetchone()[0]


def _marker_count_ch(ch, marker):
    return ch.query(
        "SELECT count() FROM finwatch.transactions FINAL "
        f"WHERE description = '{marker}' AND cdc_op != 'd'"
    ).result_rows[0][0]
