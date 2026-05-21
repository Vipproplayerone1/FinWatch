# FinWatch — Hand-in Checklist

Use this document to verify the project is complete and reproducible before
submission. Each section should pass before moving on.

---

## 0. Prerequisites

- [ ] Docker Desktop is running (`docker info` succeeds)
- [ ] Conda env exists: `conda activate C:\ProgramData\miniconda3\envs\graduate_env`
- [ ] Python deps installed: `pip install -r scripts/requirements.txt`
- [ ] Project root is `finwatch/` for all commands below

---

## 1. Static deliverables (no runtime needed)

- [ ] `README.md` — top-level project overview
- [ ] `CLAUDE.md` — full build guide (one level up at project root)
- [ ] `docs/architecture.md` — component design + data flow
- [ ] `docs/runbook.md` — operational procedures
- [ ] `docs/tutorial/` — eight-chapter walkthrough
- [ ] `docker-compose.yml` — full stack
- [ ] `postgres/postgresql.conf` — WAL configured for logical replication
- [ ] `postgres/init/01_init_schema.sql` — schema, seed data, publication
- [ ] `debezium/connectors/finwatch-connector.json`
- [ ] `clickhouse/init/01..04_*.sql` — DB, Kafka engines, target tables, MVs
- [ ] `clickhouse/users.d/streaming.xml` — profile-level `stream_flush_interval_ms=500`
- [ ] `clickhouse/queries/anomaly_*.sql` and `dashboard_queries.sql`
- [ ] `grafana/provisioning/datasources/{clickhouse,prometheus}.yml`
- [ ] `grafana/provisioning/dashboards/dashboard.yml` + `pipeline-health.json`
- [ ] `prometheus/prometheus.yml`
- [ ] `scripts/{generate_transactions,simulate_fraud,benchmark_latency,benchmark_throughput,wait_for_services,collect_evidence}.py`
- [ ] `tests/test_pipeline_health.py`, `test_data_integrity.py`, `test_anomaly_detection.py`, `test_schema_evolution.py`, `test_stress.py`
- [ ] `pytest.ini` (registers `slow` marker)
- [ ] `kafka/scripts/{create-topics,describe-topics}.sh`

---

## 2. Bring the stack up

```bash
docker compose down -v          # clean slate
docker compose up -d
sleep 60
docker compose ps               # all containers healthy
```

- [ ] All containers report `healthy` or `running`
- [ ] No restart loops in `docker compose ps`

---

## 3. Register the Debezium connector

```bash
python scripts/wait_for_services.py
curl -s http://localhost:8083/connectors/finwatch-connector/status | python -m json.tool
```

- [ ] Connector state: `RUNNING`
- [ ] Task[0] state: `RUNNING`
- [ ] Replication slot exists in Postgres:
      `docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SELECT slot_name, active FROM pg_replication_slots;"`

---

## 4. Snapshot data flowed end-to-end

```bash
docker exec finwatch-clickhouse clickhouse-client \
  -q "SELECT count() FROM finwatch.merchants FINAL"   # expect 12
docker exec finwatch-clickhouse clickhouse-client \
  -q "SELECT count() FROM finwatch.accounts FINAL"    # expect 10
```

- [ ] Merchants count = 12
- [ ] Accounts count = 10

---

## 5. Live CDC works

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
  INSERT INTO transactions (account_id, merchant_id, amount, currency, type, status, description)
  SELECT a.id, m.id, 150000.00, 'VND', 'purchase', 'completed', 'handin smoke test'
  FROM accounts a, merchants m
  WHERE a.email='nguyenvana@email.com' AND m.name='VinMart'
  LIMIT 1;
"
sleep 8
docker exec finwatch-clickhouse clickhouse-client \
  -q "SELECT count() FROM finwatch.transactions FINAL WHERE description='handin smoke test'"
```

- [ ] Returns `1`

---

## 6. Load + fraud simulation

```bash
python scripts/generate_transactions.py --count 2000 --tps 200
sleep 20
python scripts/simulate_fraud.py --pattern all
sleep 15

docker exec finwatch-clickhouse clickhouse-client \
  --multiquery < clickhouse/queries/anomaly_velocity_check.sql
```

- [ ] Postgres count and ClickHouse count agree (within seconds of lag):
      `docker exec finwatch-postgres psql -U finwatch -d finwatch -tAc "SELECT count(*) FROM transactions"`
      vs
      `docker exec finwatch-clickhouse clickhouse-client -q "SELECT count() FROM finwatch.transactions FINAL"`
- [ ] Velocity query returns at least one anomalous account (the velocity-fraud target)

---

## 7. Benchmarks

```bash
python scripts/benchmark_latency.py --samples 20
python scripts/benchmark_throughput.py --total 10000 --batch-size 100
```

- [ ] Average end-to-end latency < 5000 ms
- [ ] Sustained insert throughput > 1000 TPS

Record the actual numbers below for the report (run on 2026-05-19, 20 latency samples / 10 000 txns / batch 100, with `stream_flush_interval_ms=500`):

| Metric                        | Target    | Observed |
| ----------------------------- | --------- | -------- |
| E2E latency (avg)             | < 5000 ms | 1090 ms  |
| E2E latency (p95)             | < 8000 ms | 2128 ms  |
| Insert throughput             | > 1000 TPS| 1778 TPS |
| ClickHouse query (1h volume)  | < 500 ms  | 5 ms     |
| 100k stress: sustained TPS    | > 1000 TPS| 1896 TPS |
| 100k stress: catch-up time    | < 60 s    | 2.1 s    |
| 100k stress: data loss        | 0         | 0        |

---

## 8. Automated tests

```bash
pytest tests/ -v                      # 22 fast tests (default: excludes slow)
pytest tests/test_stress.py -v -m slow  # 1 slow test, ~2 min, 100k-txn stress
```

- [ ] `test_pipeline_health.py` — 6 health checks (PG, Kafka, Debezium, CH, Grafana, Prometheus)
- [ ] `test_data_integrity.py` — 4 tests (merchants/accounts count, txn presence, all-5-types via CDC)
- [ ] `test_anomaly_detection.py` — 11 tests (4 SQL smoke + 6 detection + 1 dedup), all use ephemeral accounts
- [ ] `test_schema_evolution.py` — TC-15.1: ALTER TABLE survives, connector stays RUNNING
- [ ] `test_stress.py` (slow) — TC-17.1: 100k txns, > 1000 TPS, zero data loss, < 60s catch-up

Coverage of `finwatch-test-cases.md`: 11 of 36 test cases now automated (TC-1.2 partial, TC-3.1, TC-3.2, TC-4.1, TC-4.2, TC-7.1, TC-8.1, TC-9.1, TC-9.2, TC-9.3, Rule 4, TC-14.1, TC-15.1, TC-17.1). Fault-tolerance (TC-11/12/13) remains manual via runbook.

---

## 9. Dashboards

Grafana → http://localhost:3000 (admin / admin)

- [ ] Folder `FinWatch` exists and contains `FinWatch — Pipeline Health`
- [ ] All panels render without "No data" after data is generated
- [ ] ClickHouse datasource passes "Save & test"

---

## 10. Endpoints sanity check

| Service         | URL                                     | Expected                             |
| --------------- | --------------------------------------- | ------------------------------------ |
| PostgreSQL      | localhost:5432                          | `psql` connects                      |
| Kafka browser   | http://localhost:3002/kafka             | Topics list shows finwatch.public.*  |
| Debezium        | http://localhost:8083/connectors        | Lists `finwatch-connector`           |
| ClickHouse      | http://localhost:8123/ping              | Returns `Ok.`                        |
| Grafana         | http://localhost:3000/api/health        | `database: ok`                       |
| Prometheus      | http://localhost:9090/-/healthy         | `Prometheus Server is Healthy.`      |

---

## 11. Final clean-up before zipping

- [ ] `.env` redacted or replaced with `.env.example` if secrets are sensitive
- [ ] Volumes pruned: `docker compose down -v` (optional — leaves a fresh state)
- [ ] No `__pycache__/`, `.pytest_cache/`, or local `data/` directories committed
- [ ] `git status` clean (or only intended changes)
- [ ] Tag the release: `git tag -a v1.0-handin -m "Graduate hand-in"`
