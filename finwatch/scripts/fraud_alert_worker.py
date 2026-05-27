"""
FinWatch fraud alert worker.

Runs the six anomaly queries in clickhouse/queries/anomaly_*.sql against
ClickHouse over HTTP every --interval seconds (default 30) and writes new
cases into Postgres `fraud_alerts`, deduplicated by (account_id, rule_code)
within a per-rule rolling window. Each window matches the corresponding
rule's SQL observation window (see RULE_DEDUP_DEFAULTS), so the same
underlying anomaly produces one open case while it remains visible to the
rule. FRAUD_DEDUP_SECONDS, if set, overrides every per-rule default (for
demo-chaotic runs). The CDC pipeline then carries each new alert back
into ClickHouse, where the UI reads it.

The detection rules are NOT redefined here -- the anomaly_*.sql files are the
source of truth. The worker calls each one verbatim and only adds:
  - severity classification per the spec table
  - txn_count / total_amount aggregation per account
  - evidence JSON payload
  - per-rule rolling dedup

A lightweight HTTP server on FRAUD_TICK_HTTP_PORT (default 5000) exposes
POST /tick and GET /healthz so the dashboard's DemoControls can force an
immediate detection pass after firing a scenario, instead of waiting up to
--interval seconds for the next scheduled tick.
"""

import argparse
import json
import logging
import os
import re
import signal
import sys
import threading
import time
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psycopg2
import psycopg2.extras
import requests

# ---------- configuration ----------

DB_CONFIG = {
    "host": os.getenv("POSTGRES_HOST", "localhost"),
    "port": int(os.getenv("POSTGRES_PORT", 5432)),
    "dbname": os.getenv("POSTGRES_DB", "finwatch"),
    "user": os.getenv("POSTGRES_USER", "finwatch"),
    "password": os.getenv("POSTGRES_PASSWORD", "finwatch_secret_2024"),
}

CH_URL = os.getenv("CLICKHOUSE_HTTP_URL", "http://localhost:8123")
CH_USER = os.getenv("CLICKHOUSE_USER", "default")
CH_PASSWORD = os.getenv("CLICKHOUSE_PASSWORD", "")
CH_DATABASE = os.getenv("CLICKHOUSE_DATABASE", "finwatch")

QUERIES_DIR = Path(__file__).resolve().parent.parent / "clickhouse" / "queries"

LARGE_AMT_CRITICAL_THRESHOLD = Decimal("500000000")  # 500M VND
ZSCORE_CRITICAL_THRESHOLD = 5.0

# Per-rule dedup defaults aligned to each rule's SQL observation window
# in finwatch/clickhouse/queries/. Same anomaly stays one open case while
# its underlying state remains visible to the rule.
RULE_DEDUP_DEFAULTS = {
    "VELOCITY":   300,   # SQL window 5 min
    "ZSCORE":     600,   # SQL window 10 min
    "LARGE_AMT":  3600,  # SQL window 1 hour
    "HIGH_RISK":  3600,  # SQL window 1 hour
    "MULTI_CCY":  600,   # SQL window 10 min
    "FAIL_SPIKE": 1800,  # SQL window 30 min
}
# Optional global override: if FRAUD_DEDUP_SECONDS is set, used in place of
# every per-rule default. Intended for demo-chaotic mode where every press
# should re-fire fresh alerts; leave unset in production.
_dedup_env = os.getenv("FRAUD_DEDUP_SECONDS")
DEDUP_OVERRIDE_SECONDS = int(_dedup_env) if _dedup_env else None

def dedup_seconds_for(rule_code):
    if DEDUP_OVERRIDE_SECONDS is not None:
        return DEDUP_OVERRIDE_SECONDS
    return RULE_DEDUP_DEFAULTS.get(rule_code, 3600)

TICK_HTTP_PORT = int(os.getenv("FRAUD_TICK_HTTP_PORT", "5000"))

LOG = logging.getLogger("fraud_alert_worker")


# ---------- ClickHouse helpers ----------

def ch_query(sql):
    """POST a SELECT to ClickHouse, return parsed JSONEachRow list."""
    body = sql.rstrip().rstrip(";") + "\nFORMAT JSONEachRow"
    params = {"database": CH_DATABASE}
    auth = (CH_USER, CH_PASSWORD) if CH_USER else None
    resp = requests.post(CH_URL, params=params, data=body.encode("utf-8"),
                         auth=auth, timeout=15)
    resp.raise_for_status()
    rows = []
    for line in resp.text.splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def split_sql_statements(text):
    """Split a multi-statement SQL file into individual SELECT statements."""
    parts = []
    buf = []
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("--") or not stripped:
            continue
        buf.append(raw_line)
        if stripped.endswith(";"):
            joined = "\n".join(buf).strip().rstrip(";").strip()
            if joined:
                parts.append(joined)
            buf = []
    if buf:
        leftover = "\n".join(buf).strip()
        if leftover:
            parts.append(leftover)
    return parts


# ---------- per-rule transforms ----------

def _amt(v):
    """Coerce a string/number to Decimal safely."""
    if v is None:
        return Decimal("0")
    try:
        return Decimal(str(v))
    except Exception:
        return Decimal("0")


def transform_velocity(row):
    return {
        "account_id": row["account_id"],
        "txn_count": int(row.get("txn_count", 0) or 0),
        "total_amount": _amt(row.get("total_amount")),
        "severity": "high",
        "evidence": {
            "window_seconds": row.get("window_seconds"),
            "window_start": row.get("window_start"),
            "window_end": row.get("window_end"),
            "txn_types": row.get("txn_types"),
            "txn_statuses": row.get("txn_statuses"),
        },
    }


def transform_zscore(row):
    z = row.get("z_score")
    try:
        z_abs = abs(float(z)) if z is not None else 0.0
    except Exception:
        z_abs = 0.0
    severity = "critical" if z_abs > ZSCORE_CRITICAL_THRESHOLD else "high"
    return {
        "account_id": row["account_id"],
        "txn_count": 1,
        "total_amount": _amt(row.get("amount")),
        "severity": severity,
        "evidence": {
            "txn_id": row.get("id"),
            "z_score": z,
            "type": row.get("type"),
            "merchant_id": row.get("merchant_id"),
            "avg_amount": row.get("avg_amount"),
            "std_amount": row.get("std_amount"),
            "txn_count_30d": row.get("txn_count_30d"),
        },
    }


def transform_large_amt(row):
    amount = _amt(row.get("amount"))
    severity = "critical" if amount > LARGE_AMT_CRITICAL_THRESHOLD else "high"
    return {
        "account_id": row["account_id"],
        "txn_count": 1,
        "total_amount": amount,
        "severity": severity,
        "evidence": {
            "txn_id": row.get("id"),
            "currency": row.get("currency"),
            "type": row.get("type"),
            "merchant_id": row.get("merchant_id"),
            "status": row.get("status"),
        },
    }


def transform_high_risk(row):
    return {
        "account_id": row["account_id"],
        "txn_count": 1,
        "total_amount": _amt(row.get("amount")),
        "severity": "medium",
        "evidence": {
            "txn_id": row.get("id"),
            "merchant_name": row.get("merchant_name"),
            "risk_level": row.get("risk_level"),
            "type": row.get("type"),
        },
    }


def transform_multi_ccy(row):
    return {
        "account_id": row["account_id"],
        "txn_count": int(row.get("txn_count", 0) or 0),
        "total_amount": Decimal("0"),
        "severity": "medium",
        "evidence": {
            "currencies": row.get("currencies"),
            "currency_count": row.get("currency_count"),
            "first_txn": row.get("first_txn"),
            "last_txn": row.get("last_txn"),
        },
    }


def transform_fail_spike(row):
    return {
        "account_id": row["account_id"],
        "txn_count": int(row.get("failed_count", 0) or 0),
        "total_amount": Decimal("0"),
        "severity": "high",
        "evidence": {
            "failed_count": row.get("failed_count"),
            "total_count": row.get("total_count"),
            "fail_rate_pct": row.get("fail_rate_pct"),
        },
    }


# ---------- rule loader ----------

def load_rules():
    """Load the six rule SQL statements + transforms from disk."""
    velocity_sql = (QUERIES_DIR / "anomaly_velocity_check.sql").read_text(encoding="utf-8")
    zscore_sql = (QUERIES_DIR / "anomaly_zscore.sql").read_text(encoding="utf-8")
    threshold_text = (QUERIES_DIR / "anomaly_threshold.sql").read_text(encoding="utf-8")
    threshold_parts = split_sql_statements(threshold_text)
    if len(threshold_parts) != 4:
        raise RuntimeError(
            f"Expected 4 statements in anomaly_threshold.sql, found {len(threshold_parts)}"
        )
    # anomaly_threshold.sql declares the rules in this order:
    #   #1 Large single transaction (LARGE_AMT)
    #   #2 High-risk merchant       (HIGH_RISK)
    #   #3 Multi-currency           (MULTI_CCY)
    #   #4 Failed transaction spike (FAIL_SPIKE)
    return [
        ("VELOCITY",   velocity_sql,           transform_velocity),
        ("ZSCORE",     zscore_sql,             transform_zscore),
        ("LARGE_AMT",  threshold_parts[0],     transform_large_amt),
        ("HIGH_RISK",  threshold_parts[1],     transform_high_risk),
        ("MULTI_CCY",  threshold_parts[2],     transform_multi_ccy),
        ("FAIL_SPIKE", threshold_parts[3],     transform_fail_spike),
    ]


# ---------- aggregation + insert ----------

SEVERITY_ORDER = {"low": 0, "medium": 1, "high": 2, "critical": 3}


def aggregate_by_account(rows, transform):
    """Collapse multiple rows per account into one payload per account."""
    agg = {}
    for raw in rows:
        payload = transform(raw)
        aid = payload["account_id"]
        if not aid:
            continue
        prev = agg.get(aid)
        if prev is None:
            agg[aid] = {
                "txn_count": payload["txn_count"],
                "total_amount": payload["total_amount"],
                "severity": payload["severity"],
                "evidence": payload["evidence"],
            }
        else:
            prev["txn_count"] += payload["txn_count"]
            prev["total_amount"] += payload["total_amount"]
            if SEVERITY_ORDER[payload["severity"]] > SEVERITY_ORDER[prev["severity"]]:
                prev["severity"] = payload["severity"]
            # Keep first evidence; record a sample count for traceability.
            prev["evidence"].setdefault("matches", 1)
            prev["evidence"]["matches"] += 1
    return agg


def upsert_alerts(conn, rule_code, agg):
    """For each account in `agg`, insert a new fraud_alert unless one already
    exists for (account_id, rule_code) within the last hour.

    Each account is committed in its own transaction so one bad row (e.g. an
    account_id that exists in ClickHouse but has been deleted from Postgres)
    cannot abort the whole rule's tick.
    """
    new = 0
    dedup = 0
    skipped = 0
    for account_id, payload in agg.items():
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT 1 FROM fraud_alerts
                    WHERE account_id = %s
                      AND rule_code  = %s
                      AND created_at > NOW() - make_interval(secs => %s)
                    LIMIT 1
                    """,
                    (account_id, rule_code, dedup_seconds_for(rule_code)),
                )
                if cur.fetchone():
                    dedup += 1
                    conn.commit()
                    continue
                cur.execute(
                    """
                    INSERT INTO fraud_alerts
                      (account_id, rule_code, severity, txn_count, total_amount, evidence)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (
                        account_id,
                        rule_code,
                        payload["severity"],
                        payload["txn_count"],
                        payload["total_amount"],
                        psycopg2.extras.Json(payload["evidence"]),
                    ),
                )
            conn.commit()
            new += 1
        except psycopg2.errors.ForeignKeyViolation:
            conn.rollback()
            skipped += 1
            LOG.debug("[worker] rule=%s skipped orphan account_id=%s", rule_code, account_id)
        except Exception:
            conn.rollback()
            raise
    return new, dedup, skipped


# ---------- main loop ----------

# Serializes access to the shared PG connection between the periodic loop
# and HTTP-triggered ticks (see _serve_http).
_tick_lock = threading.Lock()


def tick(conn, rules):
    """Run one detection pass. Returns a list of per-rule result dicts."""
    results = []
    for rule_code, sql, transform in rules:
        start = time.time()
        try:
            rows = ch_query(sql)
        except Exception as e:
            LOG.error("[worker] rule=%s clickhouse error: %s", rule_code, e)
            results.append({"rule_code": rule_code, "error": "clickhouse"})
            continue
        agg = aggregate_by_account(rows, transform)
        try:
            new, dedup, skipped = upsert_alerts(conn, rule_code, agg)
        except Exception as e:
            conn.rollback()
            LOG.error("[worker] rule=%s postgres error: %s", rule_code, e)
            results.append({"rule_code": rule_code, "error": "postgres"})
            continue
        elapsed_ms = int((time.time() - start) * 1000)
        LOG.info(
            "[worker] rule=%s new=%d dedup=%d skipped=%d elapsed=%dms",
            rule_code, new, dedup, skipped, elapsed_ms,
        )
        results.append({
            "rule_code": rule_code,
            "new": new,
            "dedup": dedup,
            "skipped": skipped,
            "elapsed_ms": elapsed_ms,
        })
    return results


# ---------- HTTP control plane ----------

# CDC PG->CH usually finishes within ~1s; this lets a scenario insert reach
# ClickHouse before the next /tick runs the rule queries.
TICK_CDC_GRACE_SECONDS = 1.5


def _make_http_handler(conn, rules):
    class _Handler(BaseHTTPRequestHandler):
        def _write_json(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *args):
            LOG.info("[worker:http] " + fmt, *args)

        def do_GET(self):
            if self.path == "/healthz":
                self._write_json(200, {"ok": True})
                return
            self._write_json(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/tick":
                self._write_json(404, {"error": "not found"})
                return
            time.sleep(TICK_CDC_GRACE_SECONDS)
            try:
                with _tick_lock:
                    rule_results = tick(conn, rules)
            except Exception as e:
                LOG.exception("[worker:http] tick failed")
                self._write_json(503, {"error": str(e)})
                return
            self._write_json(200, {
                "rules": rule_results,
                "dedup_seconds": {r: dedup_seconds_for(r) for r in RULE_DEDUP_DEFAULTS},
                "dedup_override": DEDUP_OVERRIDE_SECONDS,
            })

    return _Handler


def _serve_http(conn, rules):
    try:
        server = ThreadingHTTPServer(("0.0.0.0", TICK_HTTP_PORT),
                                     _make_http_handler(conn, rules))
    except OSError as e:
        LOG.error("[worker] http bind failed on :%d (%s) — periodic loop continues",
                  TICK_HTTP_PORT, e)
        return
    LOG.info("[worker] http server listening on :%d (POST /tick, GET /healthz)",
             TICK_HTTP_PORT)
    server.serve_forever()


_running = True


def _stop(_signo, _frame):
    global _running
    _running = False


def main():
    parser = argparse.ArgumentParser(description="FinWatch fraud alert worker (CH -> PG fraud_alerts).")
    parser.add_argument("--interval", type=int, default=30,
                        help="Seconds between ticks (default 30).")
    parser.add_argument("--once", action="store_true",
                        help="Run a single tick and exit (for testing).")
    parser.add_argument("--log-level", default="INFO",
                        help="Logging level (DEBUG/INFO/WARNING/ERROR).")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )

    rules = load_rules()
    LOG.info("[worker] loaded %d rules from %s", len(rules), QUERIES_DIR)
    LOG.info("[worker] clickhouse=%s database=%s", CH_URL, CH_DATABASE)
    dedup_summary = " ".join(f"{r}={dedup_seconds_for(r)}s" for r in RULE_DEDUP_DEFAULTS)
    LOG.info("[worker] dedup defaults: %s (override=%s)",
             dedup_summary,
             f"{DEDUP_OVERRIDE_SECONDS}s" if DEDUP_OVERRIDE_SECONDS is not None else "None")

    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = False

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    try:
        if args.once:
            with _tick_lock:
                tick(conn, rules)
            return

        threading.Thread(target=_serve_http, args=(conn, rules),
                         name="fraud-worker-http", daemon=True).start()

        while _running:
            with _tick_lock:
                tick(conn, rules)
            for _ in range(args.interval):
                if not _running:
                    break
                time.sleep(1)
    finally:
        conn.close()
        LOG.info("[worker] shutdown clean")


if __name__ == "__main__":
    main()
