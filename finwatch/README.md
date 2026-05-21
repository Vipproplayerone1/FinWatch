# finwatch/

Runnable stack for the FinWatch project. See the [project README](../README.md) for overview, architecture, and quick start, and [`../CLAUDE.md`](../CLAUDE.md) for the operational reference (verification commands, design invariants, extension recipe, recovery cheatsheet).

```
docker-compose.yml         # all services
postgres/                  # WAL config, schema, seed data, publication
debezium/connectors/       # finwatch-connector.json
kafka/scripts/             # topic helpers
clickhouse/init/           # Kafka engine, target tables, MVs
clickhouse/queries/        # anomaly + dashboard SQL
grafana/provisioning/      # datasources + dashboards
prometheus/                # scrape config
scripts/                   # load gen, fraud sim, benchmarks
tests/                     # pytest health / integrity / anomaly
docs/                      # architecture.md, runbook.md, tutorial/
```

Quick start (from this directory):

```bash
conda activate C:\ProgramData\miniconda3\envs\graduate_env
pip install -r scripts/requirements.txt
docker compose up -d
python scripts/wait_for_services.py
```

Grading: see [`HANDIN_CHECKLIST.md`](./HANDIN_CHECKLIST.md).
