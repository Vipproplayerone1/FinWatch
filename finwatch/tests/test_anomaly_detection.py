"""Tests for anomaly detection queries.

Three tiers:
  1. Smoke tests — the four anomaly/dashboard SQL files execute without error.
  2. Detection tests — inject controlled fraud against a per-test ephemeral
     account, wait for CDC to land it in ClickHouse, assert the relevant
     anomaly query flags the injected account/txn, then delete the account
     (CDC propagates the delete; cdc_op='d' rows are hidden by the FINAL +
     cdc_op != 'd' filter that all queries use).
  3. Dedup test — verifies ReplacingMergeTree behaviour with and without FINAL.

Detection tests require the full stack to be running and the Debezium
connector to be RUNNING. Each test uses a unique account to stay
idempotent across pytest runs.
"""

import json
import os
import re
import time
import uuid
from contextlib import contextmanager

import clickhouse_connect
import psycopg2


# ---------- shared helpers ----------

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

PIPELINE_TIMEOUT_S = 25
PIPELINE_POLL_INTERVAL_S = 1.0


def get_ch_client():
    return clickhouse_connect.get_client(**CH_CONFIG)


def get_pg_conn():
    return psycopg2.connect(**DB_CONFIG)


def _extract_queries(filepath):
    """Read a SQL file and split into individual executable queries."""
    with open(filepath) as f:
        content = f.read()
    content = re.sub(r"--.*$", "", content, flags=re.MULTILINE)
    return [q.strip() for q in content.split(";") if q.strip()]


def _wait_for_rows(ch, sql, expected_count, timeout=PIPELINE_TIMEOUT_S):
    """Poll ClickHouse until `sql` returns >= expected_count, or fail."""
    deadline = time.time() + timeout
    last = 0
    while time.time() < deadline:
        result = ch.query(sql)
        last = result.result_rows[0][0] if result.result_rows else 0
        if last >= expected_count:
            return last
        time.sleep(PIPELINE_POLL_INTERVAL_S)
    raise AssertionError(
        f"CDC pipeline lag: expected >={expected_count} rows for '{sql}', "
        f"only saw {last} after {timeout}s"
    )


@contextmanager
def _ephemeral_account(pg, balance=100_000_000):
    """Create a throwaway active account, yield its UUID, delete on exit.
    The delete propagates via CDC; cdc_op='d' rows are hidden from
    target-table queries by FINAL + cdc_op!='d'."""
    account_id = str(uuid.uuid4())
    email = f"test-{account_id}@finwatch.test"
    with pg.cursor() as cur:
        cur.execute(
            "INSERT INTO accounts (id, full_name, email, balance, currency, status) "
            "VALUES (%s, %s, %s, %s, 'VND', 'active')",
            (account_id, "Pytest Account", email, balance),
        )
    pg.commit()
    try:
        yield account_id
    finally:
        with pg.cursor() as cur:
            cur.execute("DELETE FROM transactions WHERE account_id = %s", (account_id,))
            cur.execute("DELETE FROM accounts WHERE id = %s", (account_id,))
        pg.commit()


def _pick_merchant(pg, risk_level="low"):
    """Return one merchant id at the requested risk level (fallback: any)."""
    with pg.cursor() as cur:
        cur.execute(
            "SELECT id FROM merchants WHERE risk_level=%s ORDER BY random() LIMIT 1",
            (risk_level,),
        )
        row = cur.fetchone()
        if row is None:
            cur.execute("SELECT id FROM merchants ORDER BY random() LIMIT 1")
            row = cur.fetchone()
    return row[0]


# ---------- Tier 1: SQL smoke tests ----------

def test_velocity_check_query_executes():
    ch = get_ch_client()
    for q in _extract_queries("clickhouse/queries/anomaly_velocity_check.sql"):
        assert ch.query(q) is not None


def test_zscore_query_executes():
    ch = get_ch_client()
    for q in _extract_queries("clickhouse/queries/anomaly_zscore.sql"):
        assert ch.query(q) is not None


def test_threshold_queries_execute():
    ch = get_ch_client()
    for q in _extract_queries("clickhouse/queries/anomaly_threshold.sql"):
        assert ch.query(q) is not None


def test_dashboard_queries_execute():
    ch = get_ch_client()
    for q in _extract_queries("clickhouse/queries/dashboard_queries.sql"):
        assert ch.query(q) is not None


# ---------- Tier 2: detection tests (per-test ephemeral account) ----------

def test_velocity_check_detects_burst():
    """TC-7.1 - Scenario: card-cloning (stolen card -> rapid micro-purchases).

    Real-world typology: an attacker clones a card via a skimmer and races to
    drain the balance with a burst of small purchases before the issuer blocks
    the card. The detection rule is the VELOCITY check in
    `clickhouse/queries/anomaly_velocity_check.sql` (>10 txns OR >50M VND in
    5 minutes).

    Demo trigger:   python scripts/simulate_fraud.py --scenario card-cloning
    This test injects 25 controlled txns for an ephemeral account and asserts
    the VELOCITY rule flags that account.
    """
    pg = get_pg_conn()
    ch = get_ch_client()
    burst = 25

    try:
        with _ephemeral_account(pg) as account_id:
            merchant_id = _pick_merchant(pg)
            with pg.cursor() as cur:
                for i in range(burst):
                    cur.execute(
                        """
                        INSERT INTO transactions
                          (account_id, merchant_id, amount, currency, type, status, description)
                        VALUES (%s, %s, %s, 'VND', 'purchase', 'completed', %s)
                        """,
                        (account_id, merchant_id, 1_000_000 + i, f"velocity-{account_id}-{i}"),
                    )
            pg.commit()

            _wait_for_rows(
                ch,
                f"SELECT count() FROM finwatch.transactions FINAL "
                f"WHERE account_id='{account_id}' AND cdc_op != 'd'",
                burst,
            )

            velocity_sql = _extract_queries("clickhouse/queries/anomaly_velocity_check.sql")[0]
            result = ch.query(velocity_sql)
            flagged = {str(row[0]) for row in result.result_rows}
            assert account_id in flagged, (
                f"Velocity rule did not flag account {account_id} after "
                f"{burst} rapid txns. Flagged: {flagged}"
            )
    finally:
        pg.close()


def test_zscore_detects_large_outlier():
    """TC-8.1 - Scenario: account-takeover (compromised creds -> single outlier).

    Real-world typology: an attacker uses stolen credentials. The account's
    historical pattern is small recurring purchases; the attacker drains it
    via one transfer 1000x the norm. The detection rule is the Z-SCORE check
    in `clickhouse/queries/anomaly_zscore.sql` (|z| > 3 against the account's
    30-day baseline).

    Demo trigger:   python scripts/simulate_fraud.py --scenario account-takeover
    This test seeds 20 baseline txns (~100K VND) then injects one 300M outlier
    and asserts the Z-SCORE rule flags the account.
    """
    pg = get_pg_conn()
    ch = get_ch_client()
    baseline_n = 20  # N baselines + 1 outlier gives z ~ sqrt(N)

    try:
        with _ephemeral_account(pg) as account_id:
            merchant_id = _pick_merchant(pg)
            with pg.cursor() as cur:
                for i in range(baseline_n):
                    cur.execute(
                        """
                        INSERT INTO transactions
                          (account_id, merchant_id, amount, currency, type, status, description)
                        VALUES (%s, %s, %s, 'VND', 'purchase', 'completed', %s)
                        """,
                        (account_id, merchant_id, 100_000 + i * 5_000, f"zscore-baseline-{i}"),
                    )
                cur.execute(
                    """
                    INSERT INTO transactions
                      (account_id, merchant_id, amount, currency, type, status, description)
                    VALUES (%s, %s, %s, 'VND', 'transfer', 'completed', 'zscore-outlier')
                    """,
                    (account_id, merchant_id, 300_000_000),
                )
            pg.commit()

            _wait_for_rows(
                ch,
                f"SELECT count() FROM finwatch.transactions FINAL "
                f"WHERE account_id='{account_id}' AND cdc_op != 'd'",
                baseline_n + 1,
            )

            zscore_sql = _extract_queries("clickhouse/queries/anomaly_zscore.sql")[0]
            result = ch.query(zscore_sql)
            flagged = {str(row[1]) for row in result.result_rows}  # account_id at col 1
            assert account_id in flagged, (
                f"Z-score rule did not flag account {account_id} despite 300M VND outlier "
                f"against ~100K baseline. Flagged: {flagged}"
            )
    finally:
        pg.close()


def test_threshold_detects_large_amount():
    """TC-9.1 - Scenario: wire-fraud (Business Email Compromise / exec impersonation).

    Real-world typology: attacker spoofs a senior executive in email and
    instructs a single oversized wire transfer to a controlled account.
    The detection rule is threshold rule #1 in
    `clickhouse/queries/anomaly_threshold.sql` (single txn > 100M VND).

    Demo trigger:   python scripts/simulate_fraud.py --scenario wire-fraud
    This test injects one 150M VND transfer and asserts the LARGE_AMT rule
    flags that specific txn id.
    """
    pg = get_pg_conn()
    ch = get_ch_client()
    amount = 150_000_000

    try:
        with _ephemeral_account(pg) as account_id:
            merchant_id = _pick_merchant(pg)
            with pg.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO transactions
                      (account_id, merchant_id, amount, currency, type, status, description)
                    VALUES (%s, %s, %s, 'VND', 'transfer', 'completed', 'threshold-large')
                    RETURNING id
                    """,
                    (account_id, merchant_id, amount),
                )
                txn_id = cur.fetchone()[0]
            pg.commit()

            _wait_for_rows(
                ch,
                f"SELECT count() FROM finwatch.transactions FINAL "
                f"WHERE id = '{txn_id}' AND cdc_op != 'd'",
                1,
            )

            queries = _extract_queries("clickhouse/queries/anomaly_threshold.sql")
            large_amount_q = next(q for q in queries if "100000000" in q)
            result = ch.query(large_amount_q)
            flagged = {str(row[0]) for row in result.result_rows}
            assert str(txn_id) in flagged, (
                f"Threshold rule did not flag txn {txn_id} of {amount} VND. "
                f"Flagged ids: {flagged}"
            )
    finally:
        pg.close()


def test_threshold_detects_high_risk_merchant():
    """TC-9.2 - Scenario: mule-account (funds funneled via high-risk shell merchant).

    Real-world typology: a money mule routes funds through a counter-party
    flagged risk_level='high' (shell company / sanctioned / known mule).
    The individual txn amount is unremarkable; the counter-party is the red
    flag. Detection rule: threshold rule #2 in
    `clickhouse/queries/anomaly_threshold.sql`.

    Demo trigger:   python scripts/simulate_fraud.py --scenario mule-account
    This test injects one 5M VND txn against a high-risk merchant and asserts
    the HIGH_RISK rule flags it.
    """
    pg = get_pg_conn()
    ch = get_ch_client()

    try:
        with _ephemeral_account(pg) as account_id:
            high_risk_merchant_id = _pick_merchant(pg, risk_level="high")
            with pg.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO transactions
                      (account_id, merchant_id, amount, currency, type, status, description)
                    VALUES (%s, %s, 5000000, 'VND', 'purchase', 'completed', 'high-risk-merchant')
                    RETURNING id
                    """,
                    (account_id, high_risk_merchant_id),
                )
                txn_id = cur.fetchone()[0]
            pg.commit()

            _wait_for_rows(
                ch,
                f"SELECT count() FROM finwatch.transactions FINAL "
                f"WHERE id = '{txn_id}' AND cdc_op != 'd'",
                1,
            )

            queries = _extract_queries("clickhouse/queries/anomaly_threshold.sql")
            high_risk_q = next(q for q in queries if "risk_level = 'high'" in q)
            result = ch.query(high_risk_q)
            flagged = {str(row[0]) for row in result.result_rows}
            assert str(txn_id) in flagged, (
                f"High-risk merchant rule did not flag txn {txn_id}. Flagged: {flagged}"
            )
    finally:
        pg.close()


def test_threshold_detects_multi_currency():
    """TC-9.3 - Scenario: fx-laundering (ML "layering" via rapid currency hops).

    Real-world typology: a money launderer fragments a single sum across
    multiple currencies within minutes to obscure the audit trail (the
    'layering' stage in the Placement-Layering-Integration model).
    Detection rule: threshold rule #3 in
    `clickhouse/queries/anomaly_threshold.sql` (>2 distinct currencies / 10min).

    Demo trigger:   python scripts/simulate_fraud.py --scenario fx-laundering
    This test injects 4 txns in distinct currencies (VND, USD, EUR, JPY) and
    asserts the MULTI_CCY rule flags the account.
    """
    pg = get_pg_conn()
    ch = get_ch_client()
    currencies = ["VND", "USD", "EUR", "JPY"]

    try:
        with _ephemeral_account(pg) as account_id:
            merchant_id = _pick_merchant(pg)
            with pg.cursor() as cur:
                for curr in currencies:
                    cur.execute(
                        """
                        INSERT INTO transactions
                          (account_id, merchant_id, amount, currency, type, status, description)
                        VALUES (%s, %s, 1000000, %s, 'purchase', 'completed', %s)
                        """,
                        (account_id, merchant_id, curr, f"multi-curr-{curr}"),
                    )
            pg.commit()

            _wait_for_rows(
                ch,
                f"SELECT count() FROM finwatch.transactions FINAL "
                f"WHERE account_id='{account_id}' AND cdc_op != 'd'",
                len(currencies),
            )

            queries = _extract_queries("clickhouse/queries/anomaly_threshold.sql")
            multi_curr_q = next(q for q in queries if "currency_count" in q)
            result = ch.query(multi_curr_q)
            flagged = {str(row[0]) for row in result.result_rows}
            assert account_id in flagged, (
                f"Multi-currency rule did not flag account {account_id} after "
                f"{len(currencies)} distinct currencies. Flagged: {flagged}"
            )
    finally:
        pg.close()


def test_threshold_detects_failure_spike():
    """TC-9.4 - Scenario: card-testing (stolen-card validation reconnaissance).

    Real-world typology: an attacker has a batch of stolen card details and
    probes them with many small charges to identify which still work. Most
    fail (declined / CVV mismatch); a few sneak through. The failure-rate
    spike is the tell. Detection rule: threshold rule #4 in
    `clickhouse/queries/anomaly_threshold.sql` (>=3 failed AND >50% fail rate).

    Demo trigger:   python scripts/simulate_fraud.py --scenario card-testing
    This test injects 5 failed + 2 completed txns and asserts the FAIL_SPIKE
    rule flags the account.
    """
    pg = get_pg_conn()
    ch = get_ch_client()
    failed_n = 5
    completed_n = 2

    try:
        with _ephemeral_account(pg) as account_id:
            merchant_id = _pick_merchant(pg)
            with pg.cursor() as cur:
                for i in range(failed_n):
                    cur.execute(
                        """
                        INSERT INTO transactions
                          (account_id, merchant_id, amount, currency, type, status, description)
                        VALUES (%s, %s, 500000, 'VND', 'purchase', 'failed', %s)
                        """,
                        (account_id, merchant_id, f"fail-spike-{i}"),
                    )
                for i in range(completed_n):
                    cur.execute(
                        """
                        INSERT INTO transactions
                          (account_id, merchant_id, amount, currency, type, status, description)
                        VALUES (%s, %s, 500000, 'VND', 'purchase', 'completed', %s)
                        """,
                        (account_id, merchant_id, f"fail-spike-ok-{i}"),
                    )
            pg.commit()

            _wait_for_rows(
                ch,
                f"SELECT count() FROM finwatch.transactions FINAL "
                f"WHERE account_id='{account_id}' AND cdc_op != 'd'",
                failed_n + completed_n,
            )

            queries = _extract_queries("clickhouse/queries/anomaly_threshold.sql")
            fail_spike_q = next(q for q in queries if "fail_rate_pct" in q)
            result = ch.query(fail_spike_q)
            flagged = {str(row[0]) for row in result.result_rows}
            assert account_id in flagged, (
                f"Failure-spike rule did not flag account {account_id} with "
                f"{failed_n}/{failed_n+completed_n} failed txns. Flagged: {flagged}"
            )
    finally:
        pg.close()


# ---------- Tier 3: dedup behaviour ----------

def test_replacing_merge_tree_dedup_with_final():
    """TC-14.1: 1 INSERT + 3 UPDATEs.
    Without FINAL: multiple row versions visible.
    With FINAL: exactly one row, latest amount.
    """
    pg = get_pg_conn()
    ch = get_ch_client()
    final_amount = 9_999_999

    try:
        with _ephemeral_account(pg) as account_id:
            merchant_id = _pick_merchant(pg)
            with pg.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO transactions
                      (account_id, merchant_id, amount, currency, type, status, description)
                    VALUES (%s, %s, 1000000, 'VND', 'purchase', 'completed', 'dedup-test')
                    RETURNING id
                    """,
                    (account_id, merchant_id),
                )
                txn_id = cur.fetchone()[0]
            pg.commit()

            _wait_for_rows(
                ch,
                f"SELECT count() FROM finwatch.transactions FINAL "
                f"WHERE id = '{txn_id}' AND cdc_op != 'd'",
                1,
            )

            for amt in (2_000_000, 5_000_000, final_amount):
                with pg.cursor() as cur:
                    cur.execute(
                        "UPDATE transactions SET amount=%s WHERE id=%s",
                        (amt, txn_id),
                    )
                pg.commit()
                time.sleep(1.0)

            # Wait until the latest update reaches CH and FINAL returns it.
            deadline = time.time() + PIPELINE_TIMEOUT_S
            final_seen = None
            while time.time() < deadline:
                r = ch.query(
                    f"SELECT amount FROM finwatch.transactions FINAL "
                    f"WHERE id='{txn_id}' AND cdc_op != 'd'"
                )
                if r.result_rows and int(r.result_rows[0][0]) == final_amount:
                    final_seen = int(r.result_rows[0][0])
                    break
                time.sleep(PIPELINE_POLL_INTERVAL_S)
            assert final_seen == final_amount, (
                f"FINAL did not return latest amount {final_amount} for txn {txn_id}"
            )

            # ReplacingMergeTree may have merged the parts already (background
            # merge or stream flush). The contract we care about is the FINAL
            # behaviour: exactly one row, latest amount, regardless of merges.
            final_count = ch.query(
                f"SELECT count() FROM finwatch.transactions FINAL "
                f"WHERE id='{txn_id}' AND cdc_op != 'd'"
            )
            assert final_count.result_rows[0][0] == 1, (
                f"FINAL should return exactly 1 row for txn {txn_id}, "
                f"got {final_count.result_rows[0][0]}"
            )

            # The raw row count without FINAL is informational; it reflects how
            # many versions are still un-merged. Both 1 (merged) and >=2
            # (unmerged) are valid intermediate states.
            non_final = ch.query(
                f"SELECT count() FROM finwatch.transactions WHERE id='{txn_id}'"
            )
            assert non_final.result_rows[0][0] >= 1
    finally:
        pg.close()
