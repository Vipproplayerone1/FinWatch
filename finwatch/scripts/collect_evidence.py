"""Collect end-to-end evidence for thesis Chapter 5.

Writes a timestamped folder under `evidence/` containing:
  - connector_status.json   : Debezium connector + task state
  - kafka_topics.txt        : topic list and basic stats
  - snapshot_counts.txt     : accounts/merchants counts in ClickHouse
  - anomaly_*.txt           : output of each anomaly query
  - dashboard_queries.txt   : output of each dashboard query
  - latency.txt             : benchmark_latency.py output (20 samples)
  - throughput.txt          : benchmark_throughput.py output (10k txns)
  - dedup_evidence.txt      : ReplacingMergeTree with vs without FINAL
  - SUMMARY.md              : observed-vs-target table for inclusion in thesis

Run from `finwatch/` with the stack up.
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import clickhouse_connect
import psycopg2
import requests


DB_CONFIG = {
    "host": "localhost",
    "port": 5432,
    "dbname": "finwatch",
    "user": "finwatch",
    "password": "finwatch_secret_2024",
}
CH_CONFIG = {
    "host": "localhost",
    "port": 8123,
    "database": "finwatch",
    "username": "default",
    "password": "clickhouse_secret_2024",
}

PYTHON_EXE = sys.executable
EVIDENCE_ROOT = Path("evidence")


def main():
    timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    out = EVIDENCE_ROOT / timestamp
    out.mkdir(parents=True, exist_ok=True)
    print(f"Writing evidence to {out}/")

    ch = clickhouse_connect.get_client(**CH_CONFIG)

    metrics = {}

    metrics["connector_state"] = _connector_status(out)
    _kafka_topics(out)
    metrics.update(_snapshot_counts(ch, out))
    _anomaly_queries(ch, out)
    _dashboard_queries(ch, out)
    metrics.update(_latency(out))
    metrics.update(_throughput(out))
    metrics.update(_dedup_evidence(ch, out))

    _summary(out, metrics)
    print(f"\nDone. See {out}/SUMMARY.md")


def _connector_status(out):
    r = requests.get(
        "http://localhost:8083/connectors/finwatch-connector/status", timeout=5
    )
    data = r.json()
    (out / "connector_status.json").write_text(json.dumps(data, indent=2))
    state = data.get("connector", {}).get("state", "UNKNOWN")
    print(f"  connector state: {state}")
    return state


def _kafka_topics(out):
    cmd = [
        "docker", "exec", "finwatch-kafka",
        "kafka-topics", "--bootstrap-server", "kafka:9092", "--list",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    (out / "kafka_topics.txt").write_text(result.stdout)
    print(f"  kafka topics: {len(result.stdout.strip().splitlines())} listed")


def _snapshot_counts(ch, out):
    merchants = ch.query(
        "SELECT count() FROM finwatch.merchants FINAL WHERE cdc_op != 'd'"
    ).result_rows[0][0]
    accounts = ch.query(
        "SELECT count() FROM finwatch.accounts FINAL WHERE cdc_op != 'd'"
    ).result_rows[0][0]
    transactions = ch.query(
        "SELECT count() FROM finwatch.transactions FINAL WHERE cdc_op != 'd'"
    ).result_rows[0][0]
    text = (
        f"merchants:    {merchants}\n"
        f"accounts:     {accounts}\n"
        f"transactions: {transactions}\n"
    )
    (out / "snapshot_counts.txt").write_text(text)
    print(f"  snapshot: {merchants} merchants, {accounts} accounts, {transactions} txns")
    return {
        "merchants_count": merchants,
        "accounts_count": accounts,
        "transactions_count": transactions,
    }


def _read_sql_statements(filepath):
    with open(filepath) as f:
        content = f.read()
    content = re.sub(r"--.*$", "", content, flags=re.MULTILINE)
    return [q.strip() for q in content.split(";") if q.strip()]


def _run_sql_and_save(ch, sql_files, out, prefix):
    for path in sql_files:
        statements = _read_sql_statements(path)
        outfile = out / f"{prefix}_{Path(path).stem}.txt"
        with outfile.open("w") as f:
            for i, stmt in enumerate(statements):
                f.write(f"-- statement {i+1} from {path}\n")
                f.write(stmt + ";\n\n")
                try:
                    result = ch.query(stmt)
                    if result.column_names:
                        f.write("| " + " | ".join(result.column_names) + " |\n")
                        f.write("|" + "|".join(["---"] * len(result.column_names)) + "|\n")
                        for row in result.result_rows[:100]:
                            f.write("| " + " | ".join(str(c) for c in row) + " |\n")
                        if len(result.result_rows) > 100:
                            f.write(f"... ({len(result.result_rows) - 100} more rows)\n")
                    else:
                        f.write("(no result columns)\n")
                except Exception as e:
                    f.write(f"ERROR: {e}\n")
                f.write("\n")


def _anomaly_queries(ch, out):
    sql_files = [
        "clickhouse/queries/anomaly_velocity_check.sql",
        "clickhouse/queries/anomaly_zscore.sql",
        "clickhouse/queries/anomaly_threshold.sql",
    ]
    _run_sql_and_save(ch, sql_files, out, "anomaly")
    print(f"  anomaly queries: {len(sql_files)} files captured")


def _dashboard_queries(ch, out):
    _run_sql_and_save(ch, ["clickhouse/queries/dashboard_queries.sql"], out, "dashboard")
    print(f"  dashboard queries: captured")


def _latency(out):
    cmd = [PYTHON_EXE, "scripts/benchmark_latency.py", "--samples", "20"]
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    result = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=600)
    out_text = result.stdout + ("\nSTDERR:\n" + result.stderr if result.stderr else "")
    (out / "latency.txt").write_text(out_text)

    avg = p95 = None
    for line in result.stdout.splitlines():
        m = re.search(r"Avg:\s+(\d+)\s+ms", line)
        if m:
            avg = int(m.group(1))
        m = re.search(r"P95:\s+(\d+)\s+ms", line)
        if m:
            p95 = int(m.group(1))
    print(f"  latency: avg={avg} ms, p95={p95} ms")
    return {"latency_avg_ms": avg, "latency_p95_ms": p95}


def _throughput(out):
    cmd = [
        PYTHON_EXE, "scripts/benchmark_throughput.py",
        "--total", "10000", "--batch-size", "100",
    ]
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    result = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=600)
    out_text = result.stdout + ("\nSTDERR:\n" + result.stderr if result.stderr else "")
    (out / "throughput.txt").write_text(out_text)

    tps = None
    for line in result.stdout.splitlines():
        m = re.search(r"=\s+(\d+)\s+TPS", line)
        if m:
            tps = int(m.group(1))
    print(f"  throughput: {tps} TPS")
    return {"throughput_tps": tps}


def _dedup_evidence(ch, out):
    """Pick an arbitrary transaction id and show its raw vs FINAL view."""
    sample_id_rows = ch.query(
        "SELECT id FROM finwatch.transactions FINAL WHERE cdc_op != 'd' LIMIT 1"
    ).result_rows
    if not sample_id_rows:
        (out / "dedup_evidence.txt").write_text("(no transactions to demonstrate dedup)\n")
        return {}

    sample_id = sample_id_rows[0][0]
    raw = ch.query(
        f"SELECT count() FROM finwatch.transactions WHERE id='{sample_id}'"
    ).result_rows[0][0]
    final = ch.query(
        f"SELECT count() FROM finwatch.transactions FINAL "
        f"WHERE id='{sample_id}' AND cdc_op != 'd'"
    ).result_rows[0][0]

    # Aggregate view: how many ids have multiple raw rows.
    multi_version = ch.query(
        "SELECT count() FROM (SELECT id, count() AS c FROM finwatch.transactions "
        "GROUP BY id HAVING c > 1)"
    ).result_rows[0][0]
    total_ids = ch.query(
        "SELECT uniqExact(id) FROM finwatch.transactions"
    ).result_rows[0][0]

    text = (
        f"sample id: {sample_id}\n"
        f"  raw rows (no FINAL):       {raw}\n"
        f"  FINAL + cdc_op != 'd':     {final}\n\n"
        f"corpus-wide:\n"
        f"  unique ids:                {total_ids}\n"
        f"  ids with >1 raw row:       {multi_version}\n"
    )
    (out / "dedup_evidence.txt").write_text(text)
    print(f"  dedup: {multi_version}/{total_ids} ids have multiple versions")
    return {"unique_ids": total_ids, "multi_version_ids": multi_version}


def _summary(out, metrics):
    lines = [
        "# FinWatch — Evidence Summary",
        "",
        f"Captured at `{out.name}` (local time)",
        "",
        "## Pipeline state",
        "",
        f"- Debezium connector state: **{metrics.get('connector_state')}**",
        f"- ClickHouse merchants: **{metrics.get('merchants_count')}** (expected 12)",
        f"- ClickHouse accounts: **{metrics.get('accounts_count')}** (expected 10)",
        f"- ClickHouse transactions: **{metrics.get('transactions_count')}**",
        "",
        "## Performance",
        "",
        "| Metric                       | Target     | Observed |",
        "| ---------------------------- | ---------- | -------- |",
        f"| E2E latency (avg)            | < 5000 ms  | {metrics.get('latency_avg_ms')} ms |",
        f"| E2E latency (p95)            | < 8000 ms  | {metrics.get('latency_p95_ms')} ms |",
        f"| Insert throughput            | > 1000 TPS | {metrics.get('throughput_tps')} TPS |",
        "",
        "## Dedup evidence (ReplacingMergeTree)",
        "",
        f"- Unique transaction ids: {metrics.get('unique_ids')}",
        f"- Ids with multiple raw versions (pre-merge): {metrics.get('multi_version_ids')}",
        "- See `dedup_evidence.txt` for the FINAL-vs-raw comparison on a sample id.",
        "",
        "## Files in this evidence bundle",
        "",
        "- `connector_status.json`",
        "- `kafka_topics.txt`",
        "- `snapshot_counts.txt`",
        "- `anomaly_*.txt` (velocity, zscore, threshold)",
        "- `dashboard_dashboard_queries.txt`",
        "- `latency.txt`",
        "- `throughput.txt`",
        "- `dedup_evidence.txt`",
        "",
    ]
    (out / "SUMMARY.md").write_text("\n".join(lines))


if __name__ == "__main__":
    main()
