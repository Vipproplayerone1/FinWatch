# FinWatch — Live Demo Walkthrough

This is the exact, step-by-step demo to perform during slide 24 of the defense.
Budget **5–7 minutes** total. Read the "Say" boxes out loud; run the "Run" commands
in your terminal; expect the "See" outputs and watch for the listed red flags.

> **Working directory:** `D:\Major\Graduate_Project\finwatch\`
> **Shell:** PowerShell (default on Windows). Bash equivalents are noted where they differ.

---

## Pre-demo checklist  (run 5 minutes BEFORE the talk, not during it)

```powershell
# 1. Activate Conda env
conda activate C:\ProgramData\miniconda3\envs\graduate_env

# 2. Make sure Docker Desktop is running
docker info | Select-String "Server Version"

# 3. Bring up the full stack (idempotent — fine if already up)
docker compose up -d

# 4. Wait, then verify every container
Start-Sleep -Seconds 30
docker compose ps
# Every row should say "running" or "healthy". No "restarting", no "exited".

# 5. Register the Debezium connector (idempotent)
python scripts/wait_for_services.py

# 6. Sanity-check: connector RUNNING
curl http://localhost:8083/connectors/finwatch-connector/status
# {"connector":{"state":"RUNNING"}, "tasks":[{"state":"RUNNING"}], ...}

# 7. Sanity-check: snapshot data already in ClickHouse
docker exec finwatch-clickhouse clickhouse-client `
  -q "SELECT count() FROM finwatch.merchants FINAL"
# expect: 12
docker exec finwatch-clickhouse clickhouse-client `
  -q "SELECT count() FROM finwatch.accounts FINAL"
# expect: 10
```

If any of these fail, fix BEFORE the talk — never debug live in front of the
committee. Common fixes:

| Symptom                              | Fix                                                                |
| ------------------------------------ | ------------------------------------------------------------------ |
| Some container not healthy           | `docker compose logs <name> --tail 50`                             |
| Connector not RUNNING                | `curl -X POST .../restart`, or re-run `wait_for_services.py`       |
| ClickHouse count is 0                | Connector probably wasn't running during snapshot — restart it     |
| Port already in use                  | Edit `.env`, change the port, `docker compose up -d` again         |

### Browser tabs to pre-open

Open these *before* the talk so you don't fumble URLs:

1. http://localhost:3002/kafka  — FinWatch internal Kafka browser (replaces the external kafka-ui)
2. http://localhost:8083/connectors/finwatch-connector/status  — Debezium status
3. http://localhost:8123/play  — ClickHouse Play UI (or use a SQL panel)
4. http://localhost:3000  — Grafana (logged in as admin/admin)
5. http://localhost:9090/targets — Prometheus targets
6. http://localhost:3002  — FinWatch web UI home (dashboard, fraud, demo controls)

---

## Demo Step 1 — Stack health  (≈ 45 sec)

### Say

"Before I show data flowing, let me prove the eight containers are actually
running."

### Run

```powershell
docker compose ps
```

### See

A table where every service — `postgres`, `zookeeper`, `kafka`, `debezium`,
`clickhouse`, `prometheus`, `grafana`, `web` — has STATUS `Up (healthy)` or
`Up`. **Point at the screen and read off the eight services**.

Then, in browser tab 2, refresh the Debezium status endpoint and read:

```json
"connector": { "state": "RUNNING" },
"tasks":     [ { "state": "RUNNING" } ]
```

### Say

"Connector RUNNING means Debezium is actively tailing the Postgres replication
slot right now."

---

## Demo Step 2 — Single-row CDC, end-to-end in seconds  (≈ 1 min) ★

This is the **money shot**. Do it slowly. The committee should *see* a row
appear.

### Say

"Now I'll INSERT a transaction directly into Postgres, and we'll watch it land
in ClickHouse without my touching either Kafka or Debezium."

### Run (Terminal 1 — left half of screen)

```powershell
docker exec -it finwatch-postgres psql -U finwatch -d finwatch -c "
INSERT INTO transactions
  (account_id, merchant_id, amount, currency, type, status, description)
SELECT a.id, m.id, 199000.00, 'VND', 'purchase', 'completed', 'LIVE DEMO row'
FROM accounts a, merchants m
WHERE a.email='nguyenvana@email.com' AND m.name='VinMart'
LIMIT 1;
"
```

### Run (Terminal 2 — right half of screen, BEFORE running the INSERT)

Start polling ClickHouse so the row appears live:

```powershell
while ($true) {
  $count = docker exec finwatch-clickhouse clickhouse-client `
    -q "SELECT count() FROM finwatch.transactions FINAL WHERE description='LIVE DEMO row'"
  Write-Host "$(Get-Date -Format HH:mm:ss)  ClickHouse rows with that description: $count"
  if ($count -eq "1") { break }
  Start-Sleep -Milliseconds 500
}
```

Bash equivalent:

```bash
while true; do
  c=$(docker exec finwatch-clickhouse clickhouse-client \
        -q "SELECT count() FROM finwatch.transactions FINAL WHERE description='LIVE DEMO row'")
  echo "$(date +%H:%M:%S)  ClickHouse rows: $c"
  [ "$c" = "1" ] && break
  sleep 0.5
done
```

### See

Several lines of "0" then a "1" within ~2 seconds.

### Say

"That round-trip — Postgres commit, WAL, Debezium, Kafka, ClickHouse Kafka-engine,
materialized view, target table — happened in about one second. That's the
headline result on the latency slide."

---

## Demo Step 3 — Show the event in Kafka  (≈ 45 sec)

### Say

"Let me prove there really is a Kafka topic in the middle, not magic."

### Option A (preferred — visual): FinWatch Kafka browser tab

In browser tab 1 (http://localhost:3002/kafka):

1. Click **finwatch.public.transactions** in the left sidebar.
2. The Messages tab is already selected — newest message at the top.
3. Click the top row to expand the full JSON.

Point at the JSON. Read the key fields out loud:
- `"id"` — the UUID Postgres just generated
- `"amount": "199000.00"` — note it's a *string* (decimal-as-string mode)
- `"__op": "c"` — `c` for `create`
- `"__source_ts_ms": 17...` — Postgres commit time in epoch ms

### Option B (if no projector / browser): CLI

```powershell
docker exec finwatch-kafka kafka-console-consumer `
  --bootstrap-server kafka:9092 `
  --topic finwatch.public.transactions `
  --from-beginning --max-messages 1 --property print.key=true
```

### Say

"Notice the amount comes through as a *string*. That's the `decimal.handling.mode
= string` setting in my connector config — it's how I guarantee no cents are lost
to floating-point rounding. The `__op = c` tells me this was an INSERT. And
`__source_ts_ms` is the timestamp ClickHouse will use as the version key for
deduplication."

---

## Demo Step 4 — Bulk load: 2 000 transactions  (≈ 1 min)

### Say

"One row was the proof-of-life. Now let's load realistic volume."

### Run

```powershell
python scripts/generate_transactions.py --count 2000 --tps 200
```

### See

Live progress output:

```
🚀 Generating 2000 transactions at ~200 TPS
   Accounts: 10, Merchants: 12
   📊 200/2000 — 198 TPS
   📊 400/2000 — 199 TPS
   ...
✅ Done! 2000 transactions in 10.1s (199 TPS)
```

### Say

"That generator inserted at the *target* 200 transactions per second. In the
throughput benchmark — slide 27 — I push it as fast as it will go and the
pipeline sustains around 1 700 TPS."

### Optional: show row counts match

```powershell
docker exec finwatch-postgres psql -U finwatch -d finwatch -tAc "SELECT count(*) FROM transactions"
docker exec finwatch-clickhouse clickhouse-client -q "SELECT count() FROM finwatch.transactions FINAL"
```

The two numbers should be within a handful — proof that no rows are silently lost.

---

## Demo Step 5 — Inject fraud patterns  (≈ 45 sec)

### Say

"Now I'll inject three fraud patterns the rules in slide 20–22 are supposed to
catch."

### Run

```powershell
python scripts/simulate_fraud.py --pattern all
```

### See

```
🔴 VELOCITY FRAUD: 20 rapid transactions for account 7f2e...
✅ Injected 20 rapid transactions.
🔴 LARGE AMOUNT FRAUD: 500,000,000 VND for account 9c4a...
✅ Injected 1 large transaction.
🔴 MULTI-CURRENCY FRAUD: 5 different currencies for account a1b2...
✅ Injected 5 multi-currency transactions.
🎯 Fraud simulation complete. Check ClickHouse anomaly queries.
```

### Say

"The simulator pinned each fraud pattern to a specific account and printed the
UUID — so when the next query flags those accounts, we'll know it actually
caught them, not lucky noise."

---

## Demo Step 6 — Run the anomaly queries  (≈ 1 min 30 s)

### Say

"Each rule is a single SQL query. Let me run them in order."

### Run — Velocity rule

```powershell
docker exec finwatch-clickhouse clickhouse-client `
  --multiquery < clickhouse/queries/anomaly_velocity_check.sql
```

**See:** at least one row, with the same `account_id` the velocity simulator
printed. `txn_count > 10`. **Point at it.**

### Run — Z-score rule

```powershell
docker exec finwatch-clickhouse clickhouse-client `
  --multiquery < clickhouse/queries/anomaly_zscore.sql
```

**See:** transactions with `z_score > 3` (or below `-3`). **Note:** z-score needs
a per-account 30-day history; if it returns no rows on a brand-new clean stack,
say so — the 30-day window is empty by design.

### Run — Threshold + composite rules

```powershell
docker exec finwatch-clickhouse clickhouse-client `
  --multiquery < clickhouse/queries/anomaly_threshold.sql
```

**See:** the large-amount rule fires on the 500 M VND row; the multi-currency
rule fires on the multi-currency simulator's account.

### Say

"All four rules fired against the injected fraud. Each query took under 50 ms
against a few thousand rows. The same queries against a few million rows still
return in under a second, because ClickHouse is reading only the columns the
query touches."

---

## Demo Step 7 — Grafana dashboard  (≈ 1 min)

### Say

"Last stop — the same data, visualized for an analyst."

In browser tab 4 (http://localhost:3000):

1. Log in as `admin` / `admin`.
2. Sidebar → **Dashboards** → folder **FinWatch** → **FinWatch — Pipeline Health**.

### Walk through the panels in order

- **Transactions per minute** — pointed up sharply during the bulk load.
- **Top merchants by volume (1 h)** — VinMart and the others lead.
- **Velocity alerts (last 5 min)** — non-zero now, because of the simulator.
- **Ingestion lag P50 / P95** — should sit around 1 second, matching the
  benchmark slide.

### Say

"This dashboard is provisioned as YAML in the repo — `grafana/provisioning/`. The
moment a new contributor runs `docker compose up`, they get the same dashboard,
the same data sources, no clicks needed. That reproducibility was one of the
explicit goals on slide 5."

---

## Demo wrap

### Say

"To recap the demo in one breath: one row INSERTED in Postgres appeared in
ClickHouse in about a second, two thousand rows flowed through end-to-end without
lag, three fraud patterns were injected and all four anomaly rules caught them,
and the live Grafana dashboard reflects every step of that flow. That's the whole
pipeline working under load."

→ Return to slide 25 (testing).

---

## Fallback plans — if things go wrong live

> Pick the highest-impact fallback and stay calm. The committee respects "here's
> what would normally show, and here's the recorded output" much more than
> watching you debug.

| If this breaks                | Fallback                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| Docker not running            | Open `presentation/DEMO_OUTPUT.txt` (pre-recorded), narrate from it.                       |
| Debezium not RUNNING          | Skip to step 4 and explain — show a pre-captured `/kafka` screenshot of recent messages.  |
| ClickHouse query hangs        | `docker compose restart clickhouse`, give it 15 s, retry.                                 |
| Grafana panels say "No data"  | Re-run the generator (step 4) and refresh; or skip the dashboard step and describe panels.|
| /kafka page doesn't load      | Check `docker compose logs web`; fall back to the CLI consumer (step 3, Option B).        |
| Internet drops mid-demo       | Everything is local — internet is not required for any step. Mention this.                |

### Optional: pre-record the demo output

If you want a guaranteed-safe fallback, capture the output of every step BEFORE
the talk:

```powershell
# From the project root, save a transcript:
docker compose ps                                                  | Tee-Object -FilePath presentation/demo_output/01_ps.txt
curl http://localhost:8083/connectors/finwatch-connector/status    | Tee-Object -FilePath presentation/demo_output/02_status.json
docker exec finwatch-clickhouse clickhouse-client `
  -q "SELECT count() FROM finwatch.transactions FINAL"             | Tee-Object -FilePath presentation/demo_output/04_count.txt
docker exec finwatch-clickhouse clickhouse-client `
  --multiquery < clickhouse/queries/anomaly_velocity_check.sql     | Tee-Object -FilePath presentation/demo_output/06_velocity.txt
```

Then if anything dies live, open the relevant `.txt` and narrate from it.

---

## Post-demo cleanup  (optional, after the talk)

```powershell
# Wipe everything for a clean re-run later:
docker compose down -v        # WARNING: deletes all data volumes
```

Or just leave it running — it costs nothing on an idle laptop.
