# Chapter 08 — Dashboards: Grafana

## Why this matters

Data that only a SQL query can see is data nobody outside engineering uses. Dashboards are how operations, fraud analysts, and stakeholders interact with the pipeline you've built. A system that's technically correct but invisible to its users isn't useful.

This chapter teaches you Grafana — the dashboard tool FinWatch uses — and how to build your first real-time panel against live ClickHouse data.

By the end of this chapter you'll have a working Grafana dashboard showing transactions per minute, status mix, and pipeline latency, all auto-refreshing as new data lands.

---

## Theory

### Why Grafana

Grafana is built for *operations*:
- Time-series metrics first-class (auto-refresh, live tail)
- Strong alerting (PagerDuty, Slack, email integrations)
- Dashboards are code (JSON definitions, version-controlled)
- User base: engineers and SREs who know SQL/PromQL
- Strength: real-time monitoring, alerting, correlating metrics across sources

FinWatch uses Grafana for both ops health (pipeline lag, failure spikes) and fraud signal review (velocity check results in real time). Business-intelligence-style ad-hoc exploration for non-engineers is out of scope for this thesis stack — Grafana with a few well-tuned dashboards is enough.

### Provisioning vs UI-based config

Both tools can be configured in two ways:

**Provisioning** — configuration files (YAML/JSON) that are applied at startup. Version-controllable, reproducible, survives a container rebuild. FinWatch provisions Grafana's data sources this way.

**UI-based** — click around the web interface, changes persist in the app's own database. Easier to iterate; not reproducible unless you export/import. FinWatch's dashboards (the actual charts) are built this way for now.

You can mix both — provision the data sources and initial dashboards, then let users edit.

### ClickHouse as a Grafana data source

Grafana doesn't natively know how to talk to ClickHouse. It relies on a plugin: `grafana-clickhouse-datasource` (the official one, maintained by ClickHouse Inc.). Installed via:

```yaml
GF_INSTALL_PLUGINS: grafana-clickhouse-datasource
```

in the Grafana service in `docker-compose.yml`. On first boot, Grafana downloads the plugin. The plugin speaks the ClickHouse HTTP protocol and HTTP/Native protocols, handles query parameterization, and supports ClickHouse-specific types like `DateTime64`.

### Real-time refresh in Grafana

A time-series panel in Grafana has three refresh behaviors:

1. **Manual** — refresh only when the user clicks Refresh
2. **Interval** — auto-refresh every N seconds (e.g., 5s, 30s)
3. **Live** — streaming mode, for data sources that support server-sent events (ClickHouse doesn't)

FinWatch dashboards typically use 5–10 second auto-refresh. That's "real-time" from a human's point of view.

---

## How it's used in FinWatch

### Grafana provisioning files

`grafana/provisioning/datasources/clickhouse.yml`:

```yaml
apiVersion: 1
datasources:
  - name: ClickHouse
    type: grafana-clickhouse-datasource
    access: proxy
    url: http://clickhouse:8123
    jsonData:
      defaultDatabase: finwatch
      port: 9000
      server: clickhouse
      username: default
    secureJsonData:
      password: clickhouse_secret_2024
    isDefault: false
```

Line-by-line:

- `type: grafana-clickhouse-datasource` — the official plugin
- `access: proxy` — Grafana's backend makes the requests to ClickHouse, not the user's browser. Keeps ClickHouse off the public network.
- `url: http://clickhouse:8123` — HTTP endpoint (port 8123). Used for queries.
- `port: 9000` + `server: clickhouse` — native protocol endpoint. Faster for large result sets.
- `defaultDatabase: finwatch` — queries default to the `finwatch` database unless they say otherwise.
- `secureJsonData.password` — written encrypted into Grafana's internal database on first load.
- `isDefault: false` — Prometheus is the default data source; ClickHouse is opt-in per panel.

`grafana/provisioning/datasources/prometheus.yml`:

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
```

For pipeline health metrics (container CPU/memory, Kafka JMX, etc.). This chapter focuses on ClickHouse; chapter-out-of-scope covers Prometheus.

`grafana/provisioning/dashboards/dashboard.yml`:

```yaml
apiVersion: 1
providers:
  - name: 'FinWatch'
    orgId: 1
    folder: 'FinWatch'
    type: file
    options:
      path: /etc/grafana/provisioning/dashboards
```

This tells Grafana: "look in `/etc/grafana/provisioning/dashboards` for dashboard JSON files and auto-import them on startup, into a folder called FinWatch." You drop `.json` dashboard exports here and they appear.

---

## Hands-on — Grafana

Start Grafana (it's not in the minimal stack):

```bash
cd D:/Major/Graduate_Project/finwatch
docker compose up -d grafana prometheus
docker compose ps grafana
# Wait for Up status
```

Grafana takes ~30 seconds on first boot because it downloads the ClickHouse plugin.

### Step 1 — Log in

Open http://localhost:3000. Log in with:
- Username: `admin`
- Password: `admin` (from `.env`)

On first login Grafana may ask you to change the password — you can skip this for learning.

### Step 2 — Confirm the ClickHouse data source

Left sidebar → Connections → Data sources. You should see **ClickHouse** and **Prometheus**. Click ClickHouse. Scroll to the bottom, click **Save & test**. You should see a green "Data source is working" message.

If you see a red error, check:

- ClickHouse container is running: `docker compose ps clickhouse`
- `docker exec finwatch-clickhouse clickhouse-client --database=finwatch -q "SELECT 1"` works
- The password in `grafana/provisioning/datasources/clickhouse.yml` matches the one in `.env`

### Step 3 — Build your first panel

Top bar → **+** → **Dashboard** → **Add visualization**.

Select the **ClickHouse** data source when prompted.

You're now in the panel editor. Change to SQL mode by clicking the pencil/edit icon next to the query — Grafana's plugin has a GUI builder, but SQL is more transparent for learning.

Paste this query:

```sql
SELECT
    toStartOfMinute(created_at) AS time,
    count() AS transactions_per_minute
FROM finwatch.transactions FINAL
WHERE created_at >= $__fromTime
  AND created_at <= $__toTime
  AND cdc_op != 'd'
GROUP BY time
ORDER BY time
```

- `$__fromTime` and `$__toTime` are Grafana template variables — they resolve to the dashboard's time range (top-right of Grafana).
- `FINAL` gives you deduplicated counts.
- `cdc_op != 'd'` excludes deleted rows.

In the right sidebar:
- **Visualization type**: Time series
- **Title**: `Transactions per minute`
- **Unit**: short → Count

Click **Apply** (top right). You're back in the dashboard with one panel showing a line chart.

### Step 4 — Set auto-refresh

Top right of the dashboard → dropdown next to the refresh icon → choose **5s**. The panel re-queries every 5 seconds. Insert transactions in a terminal and watch the line tick up in near real time:

```bash
conda activate C:\ProgramData\miniconda3\envs\graduate_env
python scripts/generate_transactions.py --count 200 --tps 20
```

The time-series line jumps as the data arrives.

### Step 5 — Save the dashboard

Top right → Save icon. Give it a name: `FinWatch Live`. Choose the **FinWatch** folder. Done.

### Step 6 — Add a second panel: status breakdown

Add another visualization (top right → Add → Visualization). ClickHouse data source again.

```sql
SELECT
    status,
    count() AS count
FROM finwatch.transactions FINAL
WHERE created_at >= now() - INTERVAL 1 HOUR
  AND cdc_op != 'd'
GROUP BY status
ORDER BY count DESC
```

- **Visualization type**: Pie chart (or Stat with categories, whichever you prefer)
- **Title**: `Transaction status (last hour)`

Apply. Save the dashboard again. You now have a two-panel dashboard that updates live.

### Step 7 — Add a third panel: pipeline latency

```sql
SELECT
    toStartOfMinute(_ingested_at) AS time,
    quantile(0.50)(toUnixTimestamp64Milli(_ingested_at) - _source_ts_ms) AS p50_ms,
    quantile(0.95)(toUnixTimestamp64Milli(_ingested_at) - _source_ts_ms) AS p95_ms,
    quantile(0.99)(toUnixTimestamp64Milli(_ingested_at) - _source_ts_ms) AS p99_ms
FROM finwatch.transactions
WHERE _ingested_at >= $__fromTime
  AND _ingested_at <= $__toTime
GROUP BY time
ORDER BY time
```

Three series — p50, p95, p99. Notice no FINAL here — for latency measurement, duplicate rows are fine; we're not counting entities, we're measuring a per-event metric.

- **Visualization type**: Time series
- **Unit**: Milliseconds
- **Title**: `Pipeline latency (source → ClickHouse)`

Apply and save.

### Step 8 — Export the dashboard for version control (optional)

Dashboard settings (gear icon) → JSON Model → copy the JSON. Save it to `grafana/provisioning/dashboards/finwatch-live.json`. After a Grafana restart, the dashboard auto-provisions from this file.

---

## Checkpoints

1. What's the difference between "provisioning" and "UI configuration" for Grafana dashboards, and which would you use if you wanted your dashboards to be reproducible across environments?
2. In the pipeline latency panel, we queried without FINAL. Why was that OK there but not in the transactions-per-minute panel?
3. If Grafana's dashboard auto-refresh is set to 5 seconds and ClickHouse's ingestion latency is typically 150 ms, what's the effective end-to-end time from a Postgres INSERT to a change visible in the dashboard?

(Answers at the bottom.)

---

## Troubleshooting

**Problem:** Grafana's ClickHouse data source test fails with "bad gateway" or "connection refused".
**Cause:** Either ClickHouse isn't running, or Grafana can't reach it by name `clickhouse`.
**Fix:**

```bash
docker compose ps clickhouse grafana
# Both should be Up
docker exec finwatch-grafana wget -qO- http://clickhouse:8123/ping
# Should print "Ok."
```

If the last command fails, the two containers aren't on the same network. Check `docker-compose.yml`: both must be on `finwatch-net`.

---

**Problem:** Grafana dashboard panel shows "No data".
**Cause:** Query returned 0 rows, or time range has no data, or the query has a bug.
**Fix:** Click the panel title → **Inspect** → **Query** — see the exact SQL Grafana sent. Copy it, paste into `clickhouse-client`, see what you get. Most common: the time range (`$__fromTime`, `$__toTime`) doesn't overlap with your data. Adjust the dashboard's time range (top right).

---

**Problem:** Grafana is up but the ClickHouse plugin isn't installed (no `ClickHouse` option in data source types).
**Cause:** Plugin download failed on first boot (usually because of network issues).
**Fix:**

```bash
docker compose logs grafana | grep -i "plugin"
```

Force a re-install:

```bash
docker exec finwatch-grafana grafana-cli plugins install grafana-clickhouse-datasource
docker compose restart grafana
```

---

## Where to go next

You've now built and operated the full FinWatch pipeline, from the smallest `INSERT` to the finished dashboard. Every box in the diagram from chapter 00 is something you've touched, understood, and seen working. You're equipped to:

- Extend the pipeline with new tables (add them to the publication, the connector, a Kafka Engine, and an MV)
- Troubleshoot failures at any stage
- Tune performance when the system grows
- Explain the whole thing to someone else

Optional follow-ups — not yet part of this tutorial, but natural next steps:

- **Anomaly detection queries** (`clickhouse/queries/anomaly_*.sql`) — the z-score, velocity, and threshold rules FinWatch's thesis describes
- **Monitoring with Prometheus** — how to scrape Kafka/ClickHouse metrics and build pipeline-health dashboards in Grafana
- **Performance engineering** — `scripts/benchmark_*.py`, how to measure throughput limits and optimize
- **Schema evolution** — how to add or remove columns in Postgres and keep the pipeline running

Refer to `finwatch/docs/architecture.md` for the system-design view, and `finwatch/docs/runbook.md` for operational procedures.

---

### Checkpoint answers

1. Provisioning uses config files (YAML/JSON) applied at Grafana startup — version-controlled in git, reproducible, survives `docker compose down -v`. UI configuration is clicking around in the browser — fast but not reproducible. For anything you want to survive a wipe or share across dev/prod, use provisioning. FinWatch provisions data sources via the file you just saw; dashboards can be provisioned too by exporting JSON to `grafana/provisioning/dashboards/`.

2. The transactions-per-minute panel counts distinct *entities* — each transaction should count once. Duplicates (from not-yet-merged ReplacingMergeTree state) would over-count. FINAL gives correct counts. The latency panel measures per-*event* metrics using `_ingested_at - _source_ts_ms`. Whether an event is a duplicate or not doesn't change its latency — you're just aggregating individual measurements. FINAL would be a waste of compute here.

3. 150 ms (pipeline) + up to 5 s (dashboard refresh) = up to ~5.15 seconds worst case, ~2.5 seconds average (since you're equally likely to INSERT right after a refresh or right before). For true real-time dashboards with sub-second freshness, you'd shorten the refresh interval — but then Grafana re-queries ClickHouse more often, which has its own cost. 5 seconds is the pragmatic default.
