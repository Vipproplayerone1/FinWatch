"""TC-15.1 — schema evolution survives the CDC pipeline.

Adds a column to `accounts` in PostgreSQL, inserts a row using it, and
verifies:
  - the Debezium connector stays RUNNING (no replication slot failure),
  - the new row reaches ClickHouse (the unknown column is silently dropped
    by JSONEachRow on the consumer side, which is the documented behaviour).

Teardown drops the column and removes the test row regardless of outcome.
"""

import os
import time
import uuid

import clickhouse_connect
import psycopg2
import requests


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

DEBEZIUM_STATUS_URL = "http://localhost:8083/connectors/finwatch-connector/status"
NEW_COL = "test_evolution_col"


def _connector_state():
    r = requests.get(DEBEZIUM_STATUS_URL, timeout=5)
    r.raise_for_status()
    return r.json()["connector"]["state"]


def test_schema_evolution_does_not_break_connector():
    assert _connector_state() == "RUNNING", "connector must be RUNNING before the test"

    pg = psycopg2.connect(**DB_CONFIG)
    ch = clickhouse_connect.get_client(**CH_CONFIG)
    account_id = str(uuid.uuid4())
    email = f"schema-test-{account_id}@finwatch.test"

    try:
        with pg.cursor() as cur:
            cur.execute(f"ALTER TABLE accounts ADD COLUMN {NEW_COL} VARCHAR(50)")
        pg.commit()

        # Give Debezium a moment to register the schema change.
        time.sleep(2)

        with pg.cursor() as cur:
            cur.execute(
                f"INSERT INTO accounts (id, full_name, email, balance, currency, status, {NEW_COL}) "
                "VALUES (%s, %s, %s, 50000000, 'VND', 'active', %s)",
                (account_id, "Schema Test", email, "evolution-marker"),
            )
        pg.commit()

        # Wait up to 15s for the row to reach ClickHouse.
        deadline = time.time() + 15
        seen = False
        while time.time() < deadline:
            r = ch.query(
                f"SELECT count() FROM finwatch.accounts FINAL "
                f"WHERE id='{account_id}' AND cdc_op != 'd'"
            )
            if r.result_rows[0][0] == 1:
                seen = True
                break
            time.sleep(0.5)
        assert seen, "new row with extra column did not reach ClickHouse"

        # The whole point: connector must still be RUNNING after the ALTER.
        assert _connector_state() == "RUNNING", (
            "connector state changed after ALTER TABLE — schema evolution broke CDC"
        )

    finally:
        with pg.cursor() as cur:
            cur.execute("DELETE FROM accounts WHERE id = %s", (account_id,))
            cur.execute(f"ALTER TABLE accounts DROP COLUMN IF EXISTS {NEW_COL}")
        pg.commit()
        pg.close()
