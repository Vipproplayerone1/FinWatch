# FinWatch Live Demo UI

Single-page real-time dashboard for FinWatch thesis demos. Reads ClickHouse via HTTP and renders:

- Animated PG → Debezium → Kafka → ClickHouse architecture flow
- Pipeline health KPIs (avg/P95 latency, TPS, total today)
- TPS sparkline (last 60s)
- Live transaction stream (top 20, auto-refresh)
- Fraud alerts feed (velocity / large-amount / multi-currency / failed-spike)

## Run

From `finwatch/`:

```bash
docker compose up -d --build web
```

Open http://localhost:3002 (override with `WEB_PORT` in `.env`).

Drive activity in another shell:

```bash
python scripts/generate_transactions.py --count 500 --tps 50
python scripts/simulate_fraud.py --pattern all
```

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `CLICKHOUSE_HOST`     | `clickhouse`              | Hostname (Docker service name) |
| `CLICKHOUSE_PORT`     | `8123`                    | HTTP port |
| `CLICKHOUSE_USER`     | `default`                 | User |
| `CLICKHOUSE_PASSWORD` | (from `.env`)             | Password |
| `CLICKHOUSE_DATABASE` | `finwatch`                | Target DB |

## Troubleshooting

- **Blank KPIs / "—" placeholders** → ClickHouse unreachable. Check `docker compose ps clickhouse` and `docker compose logs web`.
- **Stream empty** → No recent inserts. Run `scripts/generate_transactions.py`.
- **Port 3002 already in use** → set `WEB_PORT=3003` in `finwatch/.env`.

## Local dev (without Docker)

```bash
cd finwatch/web
npm install
CLICKHOUSE_HOST=localhost CLICKHOUSE_PASSWORD=clickhouse_secret_2024 npm run dev
```
