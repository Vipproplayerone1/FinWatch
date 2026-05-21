# CLAUDE.md — FinWatch

Operational reference for the FinWatch real-time transaction monitoring pipeline. The stack is already built under `finwatch/`. This file tells an AI agent how to **run, verify, and extend** it.

---

## 1. Environment (run before every command)

```bash
conda activate C:\ProgramData\miniconda3\envs\graduate_env
```

If the env is missing:

```bash
conda create -p C:\ProgramData\miniconda3\envs\graduate_env python=3.11 -y
conda activate C:\ProgramData\miniconda3\envs\graduate_env
pip install -r finwatch/scripts/requirements.txt
```

Quick sanity: `python --version`, `docker --version`, `docker compose version`.

---

## 2. Pipeline

```
PostgreSQL (WAL) → Debezium → Kafka → ClickHouse → Grafana
```

**Goal:** capture every DB change in real time, stream through Kafka, store in ClickHouse for analytics, surface anomalies in dashboards.

**Working dir for all stack files:** `finwatch/`.

---

## 3. Repo layout (what lives where)

| Path | Purpose |
|---|---|
| `finwatch/docker-compose.yml` | All services (postgres, zookeeper, kafka, debezium, clickhouse, prometheus, grafana, web) |
| `finwatch/.env` / `.env.example` | Credentials & ports |
| `finwatch/postgres/init/01_init_schema.sql` | `accounts`, `merchants`, `transactions`, debezium role, publication `finwatch_pub`, seed data |
| `finwatch/postgres/postgresql.conf` | `wal_level=logical`, replication slots |
| `finwatch/debezium/connectors/finwatch-connector.json` | CDC connector config (JSON converter, no schema, `ExtractNewRecordState` SMT) |
| `finwatch/clickhouse/init/0[1-4]_*.sql` | DB → Kafka engines → target `ReplacingMergeTree` tables → materialized views |
| `finwatch/clickhouse/users.d/streaming.xml` | Profile override: `stream_flush_interval_ms=500`, `stream_poll_timeout_ms=200` — drops E2E latency from ~7.5s (default) to ~1s |
| `finwatch/clickhouse/queries/anomaly_*.sql` | Velocity, z-score, threshold rules |
| `finwatch/clickhouse/queries/dashboard_queries.sql` | Volume, type breakdown, top merchants, ingestion lag |
| `finwatch/grafana/provisioning/` | Datasources (ClickHouse, Prometheus) + dashboards |
| `finwatch/prometheus/prometheus.yml` | Scrapes ClickHouse metrics |
| `finwatch/scripts/generate_transactions.py` | Synthetic TPS load |
| `finwatch/scripts/simulate_fraud.py` | Velocity / large-amount / multi-currency fraud patterns |
| `finwatch/scripts/wait_for_services.py` | Registers Debezium connector |
| `finwatch/scripts/benchmark_latency.py` | E2E PG→CH latency |
| `finwatch/scripts/benchmark_throughput.py` | Sustained insert TPS |
| `finwatch/scripts/collect_evidence.py` | Bundles connector state + queries + benchmarks into a timestamped `evidence/` folder for thesis Chapter 5 |
| `finwatch/web/` | Next.js 14 live demo UI (port 3002). API routes in `web/app/api/**` query ClickHouse via `@clickhouse/client`; components in `web/components/` render the animated architecture flow, health KPIs, TPS sparkline, live transaction stream, and fraud alert feed. Built into the stack as the `web` service in `docker-compose.yml`. |
| `finwatch/tests/` | `test_pipeline_health.py`, `test_data_integrity.py`, `test_anomaly_detection.py`, `test_schema_evolution.py`, `test_stress.py` (slow) |
| `finwatch/pytest.ini` | Registers `slow` marker; default run skips slow tests |
| `finwatch/docs/architecture.md`, `runbook.md` | Design + ops reference |

Open these files when needed — do not re-inline them here.

---

## 4. Start / stop

From `finwatch/`:

```bash
docker compose up -d                          # start everything
python scripts/wait_for_services.py           # register Debezium connector (idempotent)
docker compose down                           # stop
docker compose down -v                        # stop + wipe all volumes (clean slate)
docker compose ps                             # status
docker compose logs -f <service>              # tail logs
```

Boot order is handled by `depends_on` + healthchecks. Give the stack ~60s after `up -d` before registering the connector.

---

## 5. Verification checklist (run after changes)

```bash
# PostgreSQL — schema + WAL
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "\dt"
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SHOW wal_level;"   # logical

# Kafka — topics created by Debezium snapshot
docker exec finwatch-kafka kafka-topics --bootstrap-server kafka:9092 --list
# Expect: finwatch.public.accounts, finwatch.public.merchants, finwatch.public.transactions

# Debezium — connector RUNNING (PowerShell: use curl.exe; plain `curl` is aliased to Invoke-WebRequest)
curl.exe -s http://localhost:8083/connectors/finwatch-connector/status | python -m json.tool

# ClickHouse — snapshot landed (FINAL + cdc_op != 'd' per §11 rule 5)
docker exec finwatch-clickhouse clickhouse-client -q "SELECT count() FROM finwatch.merchants FINAL WHERE cdc_op != 'd'"   # 12
docker exec finwatch-clickhouse clickhouse-client -q "SELECT count() FROM finwatch.accounts  FINAL WHERE cdc_op != 'd'"   # 10

# End-to-end — insert in PG, read in CH after ~10s
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
INSERT INTO transactions (account_id, merchant_id, amount, currency, type, status, description)
SELECT a.id, m.id, 150000.00, 'VND', 'purchase', 'completed', 'smoke test'
FROM accounts a, merchants m WHERE a.email='nguyenvana@email.com' AND m.name='VinMart' LIMIT 1;"

docker exec finwatch-clickhouse clickhouse-client -q "
SELECT id, amount, type FROM finwatch.transactions FINAL WHERE description='smoke test' AND cdc_op != 'd'"
```

---

## 6. Load + fraud + benchmarks

```bash
python scripts/generate_transactions.py --count 2000 --tps 200
python scripts/simulate_fraud.py --pattern all          # velocity | large-amount | multi-currency | all
python scripts/benchmark_latency.py --samples 20         # target avg < 5000 ms
python scripts/benchmark_throughput.py --total 10000     # target > 1000 TPS at the PG insert side
```

Run anomaly queries:

```bash
docker exec finwatch-clickhouse clickhouse-client --multiquery < clickhouse/queries/anomaly_velocity_check.sql
docker exec finwatch-clickhouse clickhouse-client --multiquery < clickhouse/queries/anomaly_zscore.sql
docker exec finwatch-clickhouse clickhouse-client --multiquery < clickhouse/queries/anomaly_threshold.sql
```

---

## 7. Endpoints

| Service | URL |
|---|---|
| PostgreSQL | `localhost:5432` (psql) |
| Kafka browser (internal) | http://localhost:3002/kafka — topic browser, message inspector, consumer-lag view (replaces the external kafka-ui tool) |
| Debezium Connect | http://localhost:8083/connectors |
| ClickHouse HTTP | http://localhost:8123/ping → `Ok.` |
| Grafana | http://localhost:3000 (admin / admin) |
| Prometheus | http://localhost:9090 |
| **FinWatch UI (demo)** | **http://localhost:3002** — live transaction stream, fraud alerts, pipeline health, animated architecture |

---

## 8. Design decisions (must respect when editing)

- **JSON converter, no schema** between Debezium → Kafka → ClickHouse. ClickHouse Kafka engines use `JSONEachRow`. Switching to Avro would require adding a schema registry and updating all `kafka_format` settings — currently out of scope.
- **Decimals as String** in Debezium (`decimal.handling.mode=string`) → cast in ClickHouse MVs via `toDecimal128(amount, 2)`.
- **Timestamps as ISO strings** (`time.precision.mode=connect` emits Connect logical types; `timestamptz` columns become ISO 8601 strings). Kafka engine columns are `Nullable(String)`; MVs convert with `if(created_at IS NOT NULL AND created_at != '', parseDateTimeBestEffort(created_at), fromUnixTimestamp64Milli(__source_ts_ms))`. `__source_ts_ms` is Int64 epoch ms — used as the fallback **and** as the `ReplacingMergeTree` version column.
- **Dedup via `ReplacingMergeTree(_source_ts_ms)`** — always query target tables with `FINAL` for correctness, and filter `cdc_op != 'd'` to exclude deletes.
- **Kafka-engine flush tuned** — `stream_flush_interval_ms=500` and `stream_poll_timeout_ms=200` set as profile-level settings in `clickhouse/users.d/streaming.xml` (these are user-profile, NOT table-level `SETTINGS`; ClickHouse rejects them at the table `Kafka(...)` SETTINGS clause).
- **SMT `ExtractNewRecordState`** flattens Debezium envelopes and adds `__op`, `__table`, `__source_ts_ms` fields.
- **Publication `finwatch_pub`** + replication slot `finwatch_slot` are created in `01_init_schema.sql`. Adding a CDC table requires `ALTER PUBLICATION finwatch_pub ADD TABLE …` and updating `table.include.list` in the connector.

---

## 9. Extending the pipeline (add a new table)

1. Add table + grant to `debezium` in a new `postgres/init/*.sql` (or migration).
2. `ALTER PUBLICATION finwatch_pub ADD TABLE public.<new>;`
3. Add `public.<new>` to `table.include.list` in `debezium/connectors/finwatch-connector.json` and re-PUT the config (`scripts/wait_for_services.py` handles upsert).
4. Add Kafka engine + target `ReplacingMergeTree` + MV in `clickhouse/init/` (mirror existing patterns: String amounts, `Nullable(String)` timestamps decoded via `parseDateTimeBestEffort`, Int64 `__source_ts_ms`, plus `__op/__table` columns).

---

## 10. Recovery cheatsheet (full version in `finwatch/docs/runbook.md`)

- Connector stuck / FAILED → `curl.exe -X POST http://localhost:8083/connectors/finwatch-connector/restart` (PowerShell; use `curl` on bash/Linux)
- Replication slot bloat → `SELECT slot_name, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) FROM pg_replication_slots;` — if connector is gone, `SELECT pg_drop_replication_slot('finwatch_slot');`
- ClickHouse not consuming → check `system.kafka_consumers`; recreate the Kafka engine table to reset offsets.
- Full reset → `docker compose down -v && docker compose up -d && python scripts/wait_for_services.py`.

---

## 11. Agent rules

1. Activate Conda before any `python`/`pip`/`docker`/`curl` command.
2. Edit existing files under `finwatch/`; don't recreate the scaffolding.
3. After any change, run the relevant section of §5.
4. Keep the invariants in §8 (JSON converter, `ReplacingMergeTree`, decimal-as-string, epoch-ms timestamps).
5. Use `FINAL` and `cdc_op != 'd'` in every analytical query.
6. Use forward slashes in Docker volume mounts; backslashes only for Conda paths.
7. Port collision → change in `.env`, never in `.env.example`.
8. If a service misbehaves, read `docker compose logs <service>` before changing config.
9. **Code language is English only.** All identifiers, comments, log messages, error strings, docstrings, and CLI output in `.py`, `.ts`/`.tsx`, `.sql`, `.yml`, `.json`, `.ps1`, `.sh`, `.conf`, `.xml` files must be English. Vietnamese is allowed **only** as content destined for `.docx`/`.md` thesis output — i.e. inside `add_*(doc, ...)` calls and table-row data in `finwatch/scripts/build_demo_docs.py`, and inside Markdown prose. To verify before commit, run `python finwatch/scripts/_audit_vietnamese.py` — it must report `Vietnamese-in-CODE hits: 0`.
