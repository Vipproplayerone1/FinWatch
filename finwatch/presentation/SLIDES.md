# FinWatch — Graduate Project Defense Slide Deck

**Author:** Phong Bui  •  **Target duration:** 30–40 minutes  •  **Audience:** Thesis advisor + committee

> Each slide is split into two parts:
> - **SLIDE** — the text/bullets/figure to put on the slide itself (keep it short).
> - **SCRIPT** — what to say out loud. Read it as a talking guide, not word-for-word.
>
> Times are guidance only. Demo (slide 24) is the big one — budget 5–7 minutes for it.

---

## Slide 1 — Title  (≈ 30 sec)

### SLIDE

```
FinWatch
Near Real-Time Financial Transaction Monitoring
with Change Data Capture

Graduate Project Defense
Phong Bui — 2026
```

Pipeline diagram (small, top-right):
`PostgreSQL → Debezium → Kafka → ClickHouse → Grafana`

### SCRIPT

Good morning, professor. My graduate project is called **FinWatch** — a near real-time
financial transaction monitoring system. The core idea is that every change to a
banking database — every new transaction, every status update — should be visible to
analysts and fraud-detection rules within a few seconds, not the next morning after a
nightly batch job. I built the whole pipeline myself end-to-end using a CDC
architecture: Postgres on the left as the source of truth, Debezium reading its
write-ahead log, Kafka carrying the events, ClickHouse on the right serving fast
analytical queries, and Grafana on top for visualization. Over the next
30 to 40 minutes I'll walk through why I built it this way, how each component works,
the anomaly-detection rules I implemented, the latency and throughput numbers I
measured, and finally a live demo on my laptop.

---

## Slide 2 — Agenda  (≈ 30 sec)

### SLIDE

1. Problem & motivation
2. Goals and scope
3. Architecture overview
4. Component deep-dive — Postgres, Debezium, Kafka, ClickHouse
5. Anomaly detection rules
6. Monitoring & dashboards
7. Testing & benchmark results
8. **Live demo**
9. Lessons learned & future work
10. Q&A

### SCRIPT

Here's the road map. I'll start with the *problem* — why banks need this kind of
system. Then the *goals* I set for myself. Then the *architecture* at a high level,
followed by a deep-dive into each of the four core components. After that, the
*anomaly-detection rules* I wrote in SQL, the *monitoring* layer, the *test suite* and
*benchmark numbers*, then a *live demo* on my laptop, and finally *lessons learned*,
*limitations*, and open *future work*. I'll save formal Q&A for the end but please
interrupt me at any time if something is unclear.

---

## Slide 3 — The Problem  (≈ 1 min)

### SLIDE

**Traditional finance data pipelines are too slow for fraud.**

- Operational data lives in OLTP databases (Postgres, MySQL, Oracle) — optimized for
  writes, not analytics.
- Analytics is usually a **nightly ETL** dump into a warehouse.
- Fraudulent activity unfolds in **seconds to minutes**, not in 24-hour batches.
- By the time a batch job flags a stolen card, the attacker has already drained the
  account.

> Industry benchmark: Stripe Radar evaluates >1,000 features in <100 ms per
> transaction with a 0.1 % false-positive rate.

### SCRIPT

Most companies still run their operational database — typically Postgres or MySQL —
and a separate analytical warehouse. The two are usually connected by a nightly ETL
job that copies the day's data into the warehouse so the BI team can query it. For
financial fraud, that's a disaster. A stolen card can be drained in *minutes*. A
velocity attack — where the attacker fires twenty small purchases in a row to test if
the card works — happens in *seconds*. If your detection layer only wakes up at
midnight, by then the money is gone, the chargebacks have started, and the customer
is calling the bank. Real production systems like Stripe Radar evaluate over a
thousand features per transaction in under 100 milliseconds. The gap between that and
"nightly ETL" is exactly what this project tries to close — at a scale a single
student can build and benchmark.

---

## Slide 4 — Why Change Data Capture (CDC)?  (≈ 1 min)

### SLIDE

**Three ways to get data out of an OLTP database:**

| Approach              | Latency      | Load on OLTP   | Misses changes?   |
| --------------------- | ------------ | -------------- | ----------------- |
| Periodic SQL query    | minutes–hours| high (full scan) | yes (between polls) |
| Application dual-write| ~ms          | high (latency)  | yes (on failure)  |
| **CDC from WAL**      | **~seconds** | **near zero**   | **no**            |

CDC reads the database's own replication log → no application changes, no
double-writes, no missed updates.

### SCRIPT

There are basically three ways to get operational data into an analytics system.
First, you can poll: run a `SELECT * FROM transactions WHERE updated_at > ...` on a
timer. That hammers the source database, misses anything that's deleted, and the
latency is whatever your poll interval is. Second, you can do dual-writes from the
application — every time the app writes to Postgres it also publishes to Kafka. That
sounds clean but the two writes are not atomic, so any crash between them leaves the
two stores inconsistent forever, and the application now carries extra latency.
The third option — and the one I picked — is **Change Data Capture from the
write-ahead log**. The database already writes every change to its WAL for crash
recovery. CDC just *reads* that same log as a stream of events. The OLTP database is
essentially unaware. There's no application code change. There's no missed event,
because the WAL is the same log Postgres itself uses to survive a crash. This is the
same pattern used by Stripe, Shopify, Zalando, Uber — basically every major
production CDC system runs on this idea.

---

## Slide 5 — Project Goals  (≈ 45 sec)

### SLIDE

Build, end-to-end on a single laptop, a system that:

1. **Captures** every INSERT/UPDATE/DELETE on three Postgres tables in real time.
2. **Streams** changes through Kafka with at-least-once delivery.
3. **Lands** them in a columnar OLAP store with sub-second query latency.
4. **Detects** four classes of suspicious behavior with SQL-only rules.
5. **Visualizes** pipeline health and business KPIs in Grafana.
6. **Documents** itself: tutorial, runbook, tests, benchmarks.

**Hard targets:** End-to-end latency < 5 s. Sustained insert throughput > 1 000 TPS.

### SCRIPT

I set myself six concrete goals. One: every change to my Postgres tables must end up
in the analytics layer — no rows lost, no rows silently dropped. Two: it must go
through Kafka, because that's what gives me a durable, replayable buffer between the
source and the sink. Three: the sink must be columnar and fast — ClickHouse — so an
analyst can run a `GROUP BY` over a million rows in tens of milliseconds, not minutes.
Four: I must implement real anomaly-detection logic, not just transport data. Five:
the whole thing has to be visible — pipeline health and business KPIs both — in
Grafana. And six: it has to be reproducible. Anyone who clones the repo and runs
`docker compose up` plus one Python script must get the same working system. The two
*hard numerical targets* I set are average end-to-end latency under five seconds and
sustained insert throughput above one thousand transactions per second. I'll show the
measured numbers on slides 22 and 23.

---

## Slide 6 — Scope: What's In, What's Out  (≈ 30 sec)

### SLIDE

**In scope**

- Postgres logical replication, Debezium, Kafka, ClickHouse, Grafana, Prometheus.
- JSON serialization end-to-end.
- Single-node deployment via Docker Compose.
- Four SQL-based anomaly-detection rules.
- Synthetic transaction generator + fraud simulator.

**Out of scope**

- Multi-node HA cluster, Kubernetes, cloud deployment.
- Machine-learning fraud models (deliberately — SQL gives a transparent, auditable
  baseline first).
- Production-grade secrets management (passwords are in `.env`).

### SCRIPT

I want to be honest about the boundary. **In scope:** the entire CDC chain on a
single laptop, using Docker Compose; JSON as the wire format because it's the easiest
to debug; and four SQL-based anomaly rules. **Out of scope:** multi-node clusters,
Kubernetes, cloud deployments, and machine-learning fraud models. The last one is a
deliberate choice — I wanted a *transparent* baseline. SQL rules can be read by an
auditor; a neural network can't. In a follow-up project, an ML scoring service would
sit *alongside* these rules, not replace them.

---

## Slide 7 — Architecture Diagram  (≈ 1 min 30 s)

### SLIDE

```
   ┌──────────────┐   logical    ┌──────────┐   JSON    ┌────────┐   JSONEachRow   ┌────────────┐
   │  PostgreSQL  │─────WAL─────▶│ Debezium │──events──▶│ Kafka  │────────────────▶│ ClickHouse │
   │   (OLTP)     │ pgoutput     │ Connect  │           │ Broker │                 │  (OLAP)    │
   │  3 tables    │ slot+pub     │ SMT:     │           │        │                 │  K-engine  │
   │              │              │ unwrap   │           │        │                 │   ↓ MV     │
   └──────┬───────┘              └────┬─────┘           └───┬────┘                 │ RplMrgTree │
          │                           │                     │                       └──┬─────┬───┘
          │                           │                     │                          │     │
          ▼                           ▼                     ▼                          ▼     ▼
   ┌────────────┐                                                                 ┌───────────┐
   │ Prometheus │                                                                 │  Grafana  │
   └─────┬──────┘                                                                 │dashboards │
         │                                                                        └───────────┘
         └──────────── scrapes ─────────────────────────────────────────────────────────▲
```

Nine Docker containers on one Docker network (`finwatch-net`) — including the FinWatch web UI on port 3002.

### SCRIPT

This is the whole system in one picture. Postgres on the far left is the source of
truth — it has three tables: accounts, merchants, and transactions. Postgres is
configured with `wal_level = logical` and exposes a *publication* that lists exactly
which tables we want to ship out. Debezium runs inside Kafka Connect; it opens a
*logical replication slot* against Postgres, reads the WAL through the pgoutput
plugin, applies a Single Message Transform to flatten the event, and writes JSON to
Kafka. Kafka is the durable buffer in the middle — three topics, one per table.
ClickHouse on the right has three Kafka-engine tables that act as consumers; each one
has a materialized view that parses the JSON, converts types, and inserts into a
ReplacingMergeTree target table. On top of all of that, Grafana and a custom Next.js
web UI query ClickHouse for dashboards, and Prometheus scrapes ClickHouse metrics.
Nine containers, one Docker network — that's the whole physical layout.

---

## Slide 8 — Technology Choices, Justified  (≈ 1 min 30 s)

### SLIDE

| Layer    | Tool                | Why this one                                                  |
| -------- | ------------------- | ------------------------------------------------------------- |
| Source   | **PostgreSQL 15**   | Logical replication is mature, free, well documented.         |
| CDC      | **Debezium 2.5**    | Industry-standard, supports pgoutput, exactly-once snapshot.  |
| Stream   | **Kafka 7.6**       | Durable, partitioned, decouples producer from consumer.       |
| Analytics| **ClickHouse 24.3** | Columnar, vectorized, native Kafka Engine, ReplacingMergeTree.|
| Dash     | **Grafana 10.3**    | Provisioning-as-code, ClickHouse plugin, alerting.            |
| Demo UI  | **Next.js 14**      | Custom live dashboard for thesis demos (port 3002).           |
| Metrics  | **Prometheus 2.50** | De-facto standard, pulls ClickHouse metrics.                  |

### SCRIPT

Every box in that diagram is a deliberate pick, not the first thing I Googled.
Postgres because logical replication is the most mature open-source CDC source.
Debezium because it's used in production at Zalando, Trendyol, WePay — and because
unlike Kafka Connect's built-in JDBC source, it reads the WAL directly, so it doesn't
miss deletes. Kafka because it's the only message bus where I can be confident a
seven-day buffer of events will survive a consumer outage. ClickHouse because of three
things: it's columnar, so analytical queries are 100× faster than Postgres for the
same data; it has a native Kafka Engine so I don't need a separate sink connector;
and ReplacingMergeTree handles CDC duplicates naturally. Grafana for the operational
dashboards, with a custom Next.js web UI for thesis-demo storytelling. Prometheus
pulls metrics from ClickHouse. I'll defend each of these in more detail as we go.

---

## Slide 9 — PostgreSQL: The Source  (≈ 1 min)

### SLIDE

**Schema** (in `postgres/init/01_init_schema.sql`):

- `accounts` — id (UUID PK), full_name, email, balance, status, timestamps
- `merchants` — id, name, category, mcc_code, **risk_level** (low/medium/high), country
- `transactions` — id, account_id FK, merchant_id FK, amount Decimal(18,2),
  currency, type, status, ip_address, device_id, timestamps

**CDC enablement** (in `postgres/postgresql.conf`):

```ini
wal_level             = logical
max_replication_slots = 4
max_wal_senders       = 4
wal_keep_size         = 1024     # MB
```

**Dedicated CDC user + publication:**

```sql
CREATE ROLE debezium WITH LOGIN PASSWORD '...' REPLICATION;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO debezium;
CREATE PUBLICATION finwatch_pub
    FOR TABLE accounts, merchants, transactions;
```

### SCRIPT

Let me walk through Postgres. The schema is intentionally simple: three tables.
*Accounts* are the bank customers — name, email, balance, status. *Merchants* are
where they spend money; the important column there is `risk_level`, low / medium /
high, which I use later for one of the anomaly rules. *Transactions* is the
high-volume table — every purchase, transfer, withdrawal, refund. Amount is stored
as `Decimal(18,2)` because *floats are forbidden in finance* — you lose cents to
rounding. To make CDC work I have to change three Postgres settings: `wal_level =
logical` enables logical decoding; `max_replication_slots` and `max_wal_senders`
allow at least one slot for Debezium; and `wal_keep_size` keeps a buffer in case the
consumer falls behind. Then I create a *dedicated CDC user* called `debezium` —
following the principle of least privilege, it has `SELECT` and `REPLICATION` only,
never write or DDL. And I create a *publication* that explicitly names the three
tables I want to stream. Anything outside that list is invisible to Debezium.

---

## Slide 10 — Deep Dive: How WAL & Logical Replication Work  (≈ 1 min 30 s)

### SLIDE

**Write-Ahead Log (WAL)** = the file Postgres writes to *before* it touches the data
files. It exists for crash recovery — replay the WAL, you get back to a consistent
state.

Logical replication adds:

1. **Logical decoding** (`pgoutput` plugin) — turns the binary WAL into structured
   `INSERT/UPDATE/DELETE` events keyed by primary key.
2. **Replication slot** — a *named bookmark* into the WAL. Postgres won't recycle
   any WAL beyond the oldest slot's `restart_lsn`.
3. **Publication** — the *whitelist* of tables a slot is allowed to publish.

```
Client INSERT ─▶ WAL (binary) ─▶ pgoutput ─▶ replication slot ─▶ Debezium ─▶ Kafka
                                            (finwatch_slot)
```

**Operational risk:** if a slot's consumer stops, WAL grows without bound → disk
fills → Postgres crashes. → that's why we configure `wal_keep_size` and monitor slot
lag.

### SCRIPT

This slide is the one technical detail I most want the committee to understand,
because it's where most production CDC outages come from. Postgres writes every
change to a binary file called the *write-ahead log* before it touches the actual
table data — that's just how it survives crashes. Logical replication piggybacks on
that log. There are three concepts. First, the *pgoutput plugin* turns those binary
WAL records into structured INSERT/UPDATE/DELETE events keyed by primary key — that's
the "logical" part. Second, a *replication slot* is a named bookmark Postgres
maintains: it remembers where Debezium last acknowledged, and it refuses to throw
away any WAL records past that bookmark. Third, a *publication* is the whitelist of
tables. Now the operational catch — and this is the famous one in the industry —
**if Debezium crashes and stays down, Postgres will hold WAL forever to be safe**.
The disk fills, and when the disk fills, Postgres dies. The whole database. That's
why my config sets `wal_keep_size` to a sane cap, and why slot lag is one of the
metrics I monitor in Grafana. This single failure mode is the reason CDC in
production is more "operational work" than "architectural work."

---

## Slide 11 — Debezium: The CDC Engine  (≈ 1 min 30 s)

### SLIDE

Debezium = a Kafka Connect *source connector* that:

1. On first start, runs an **initial snapshot** under `SERIALIZABLE` isolation —
   `SELECT * FROM ...` for every included table.
2. Then **streams** from the replication slot continuously.
3. Stores its **offsets in Kafka internal topics** (`_finwatch_connect_offsets`) →
   restarts pick up where they left off.

**Debezium envelope** (before SMT):

```json
{ "before": null,
  "after":  { "id": "...", "amount": "150000.00", ... },
  "source": { "ts_ms": 1737028800000, "lsn": 26543210, ... },
  "op":     "c",   // c, u, d, r
  "ts_ms":  1737028800123
}
```

**ExtractNewRecordState SMT** flattens this to a single-level JSON object, keeping
only `after` + a few `__` metadata fields → cleanest input for ClickHouse.

### SCRIPT

Debezium is a Kafka Connect source connector — meaning it runs *inside* a Kafka
Connect worker, it doesn't have its own server. When it starts for the very first
time, it does an *initial snapshot*: a serializable read of every row in every
included table. That's how the data already in the database — like our twelve
seeded merchants — ends up in Kafka without a single INSERT happening. After the
snapshot, it switches to *streaming mode* and just follows the replication slot,
event by event. Debezium's *offsets* — meaning "I've processed up to this LSN" —
are themselves stored in a Kafka topic, so even if the Debezium container is
destroyed and recreated, it remembers where it was. Now, by default Debezium
produces a fairly verbose envelope — it sends both the `before` and `after` state
of every row, plus source metadata, plus the operation type. For ClickHouse that
envelope is awkward to parse, so I apply a Single Message Transform called
`ExtractNewRecordState` that flattens the envelope down to just the `after` fields,
plus three metadata columns I prefix with double underscores: `__op` (was it an
insert, update, or delete), `__table` (which source table), and `__source_ts_ms`
(when did Postgres commit the change). That's exactly the shape ClickHouse's Kafka
Engine wants to see.

---

## Slide 12 — Debezium Connector Config (the real one)  (≈ 1 min)

### SLIDE

`debezium/connectors/finwatch-connector.json` — the most important keys:

```json
{
  "connector.class":  "io.debezium.connector.postgresql.PostgresConnector",
  "topic.prefix":     "finwatch",
  "plugin.name":      "pgoutput",
  "slot.name":        "finwatch_slot",
  "publication.name": "finwatch_pub",
  "table.include.list": "public.accounts,public.merchants,public.transactions",

  "transforms":                            "unwrap",
  "transforms.unwrap.type":                "io.debezium.transforms.ExtractNewRecordState",
  "transforms.unwrap.add.fields":          "op,table,source.ts_ms",
  "transforms.unwrap.delete.handling.mode":"rewrite",

  "decimal.handling.mode":                 "string",   // avoid float precision loss
  "time.precision.mode":                   "connect",
  "heartbeat.interval.ms":                 "5000",     // keep slot LSN advancing
  "snapshot.mode":                         "initial"
}
```

### SCRIPT

This is the actual connector file from my repo. A few keys deserve attention.
`topic.prefix=finwatch` is what gives me topic names like
`finwatch.public.transactions`. `slot.name` and `publication.name` are the names of
the replication slot and publication I created in Postgres. `table.include.list` is
my explicit allowlist of three tables. The `transforms` block is the SMT I just
described. `decimal.handling.mode=string` is the most important data-type setting:
Debezium would otherwise encode `Decimal(18,2)` as a base64 byte array, which is
awful to consume from ClickHouse — by sending it as a plain string I can simply
`toDecimal128(amount, 2)` on the ClickHouse side and the cents stay exact.
`heartbeat.interval.ms=5000` is the other production-grade setting: it forces
Debezium to emit a heartbeat write every five seconds even if the source tables are
idle, which keeps the replication slot's LSN advancing and prevents the WAL-bloat
problem I mentioned on slide 10. And `snapshot.mode=initial` means: first time you
run, snapshot everything; after that, just stream.

---

## Slide 13 — Kafka: The Durable Backbone  (≈ 1 min)

### SLIDE

**Why Kafka and not just an HTTP webhook?**

- **Durability** — every event written to disk on the broker, replicated within the
  cluster, kept for the configured retention (we use the default 7 days).
- **Replay** — a downstream consumer that fell behind can rewind to any offset.
- **Decoupling** — Debezium and ClickHouse don't need to know about each other;
  either can be restarted without the other noticing.
- **Partitioning** — per-key ordering is preserved.

**Topics auto-created by Debezium:**

```
finwatch.public.accounts
finwatch.public.merchants
finwatch.public.transactions
```

Plus three internal topics for connector state:
`_finwatch_connect_configs`, `_finwatch_connect_offsets`, `_finwatch_connect_status`.

### SCRIPT

Kafka is the part of the pipeline most people ask "why is it there at all?" — and
the answer is buffering, durability, and decoupling. Suppose ClickHouse crashes for
an hour. Without Kafka, every event Debezium produced during that hour would be
lost; *with* Kafka, those events sit safely on the broker's disk for seven days, and
the moment ClickHouse comes back up its consumer offset just continues from where it
stopped. Same in the other direction: if Debezium is upgraded and goes down for ten
minutes, the dashboards keep showing the data Kafka already has. The three data
topics — accounts, merchants, transactions — are auto-created by Debezium the first
time it sees a change for each table. There are also three internal topics
Kafka-Connect uses to store its own config and offsets — that's how the connector
"remembers" across restarts.

---

## Slide 14 — Delivery Semantics & Deduplication  (≈ 45 sec)

### SLIDE

| Hop                          | Guarantee     | Why                                                       |
| ---------------------------- | ------------- | --------------------------------------------------------- |
| Postgres → Debezium          | exactly-once  | replication slot tracks LSN; gap-free.                    |
| Debezium → Kafka             | at-least-once | producer ack failure may re-send.                         |
| Kafka → ClickHouse           | at-least-once | consumer commit happens *after* insert.                   |

→ End-to-end is **at-least-once** → duplicates *can* happen.

→ Mitigation: **`ReplacingMergeTree(_source_ts_ms)`** in ClickHouse keeps only the
row with the highest `_source_ts_ms` per primary key.

### SCRIPT

Whenever you do CDC, you have to be honest about delivery semantics. Postgres to
Debezium is essentially exactly-once because the LSN bookmark is gap-free. But
Debezium to Kafka, and Kafka to ClickHouse, are *at-least-once* — if a network glitch
makes a producer or consumer retry an acknowledged message, the same event can show
up twice. So the end-to-end pipeline is at-least-once, and I have to design for
duplicates *on the consumer side*. My mitigation is ClickHouse's
ReplacingMergeTree engine: I declare `_source_ts_ms` as the version column, and
during background merges ClickHouse drops any duplicate primary key, keeping only
the row with the latest source timestamp. I'll show this in the schema in two slides.

---

## Slide 15 — ClickHouse: Why a Columnar OLAP Store?  (≈ 45 sec)

### SLIDE

For analytical workloads — `SELECT count(*), sum(amount) FROM transactions WHERE
created_at > now() - INTERVAL 1 HOUR GROUP BY type` — ClickHouse is the right tool.

| Property              | Postgres (OLTP)     | ClickHouse (OLAP)            |
| --------------------- | ------------------- | ---------------------------- |
| Storage layout        | row-oriented        | **column-oriented**          |
| Index                 | B-tree              | sparse primary + skip index  |
| Vectorized exec       | no                  | **yes, SIMD-aware**          |
| Insert pattern        | row-by-row          | **bulk + async_insert**      |
| Typical query speed   | 100 ms – seconds    | **1–50 ms** on millions of rows |

→ Same data, queries that take 5 s in Postgres often take <50 ms in ClickHouse.

### SCRIPT

Why ClickHouse and not, say, just analyzing the data inside Postgres? Postgres is
brilliant at OLTP — single-row writes, primary-key lookups — but the moment you ask
"what's the total spend by merchant category over the last hour?" it has to read
every row of every column to answer. ClickHouse stores data *by column*: when you
ask for `sum(amount)`, it reads only the `amount` column off disk, in compressed
chunks, fed straight into SIMD-vectorized aggregations. The same query that takes
several seconds in Postgres typically takes one to fifty milliseconds in ClickHouse,
on the same dataset. The trade-off is that ClickHouse is *bad* at the kind of
single-row updates Postgres lives on. So we use each for what it's good at —
Postgres holds the canonical state, ClickHouse holds the analytical replica.

---

## Slide 16 — ClickHouse Ingestion Pattern  (≈ 1 min 30 s)

### SLIDE

Three layers, defined in `clickhouse/init/02..04_*.sql`:

```
Kafka topic ──┐
              ▼
   ┌──────────────────────┐
   │ transactions_kafka   │   ENGINE = Kafka     (consumer, transient rows)
   └──────────┬───────────┘
              │  triggers
              ▼
   ┌──────────────────────┐
   │ transactions_mv      │   MATERIALIZED VIEW  (parse, cast, project)
   └──────────┬───────────┘
              │  inserts
              ▼
   ┌──────────────────────┐
   │ transactions         │   ReplacingMergeTree (durable, dedup’d)
   └──────────────────────┘
```

The Kafka-engine table holds nothing — every row it ingests is immediately consumed
by the materialized view and inserted into the durable target table.

### SCRIPT

This is the ClickHouse-side pattern. There are three tables per source table, not
one. First, a *Kafka-engine table* — that's basically a streaming consumer with a
SQL interface. It doesn't store data; rows pass through it. Second, a *materialized
view* — in ClickHouse a materialized view is really an *insert trigger*, not a
cached query. Every time the Kafka-engine table receives a batch, the view's SELECT
runs against it and the result is inserted into the third table. The third table is
the *target* — a ReplacingMergeTree partitioned by month and ordered by
`(account_id, created_at, id)`. That's where the data actually lives. The benefit
of splitting it like this is that the *parsing* and *type casting* — string-to-
decimal, epoch-millis-to-DateTime64 — happen in pure SQL in the materialized view,
so they're easy to read, easy to change, and have no Python code path.

---

## Slide 17 — Target Table Definition  (≈ 1 min)

### SLIDE

`clickhouse/init/03_create_target_tables.sql` — the transactions target:

```sql
CREATE TABLE finwatch.transactions (
    id              String,
    account_id      String,
    merchant_id     Nullable(String),
    amount          Decimal(18, 2),
    currency        LowCardinality(String),     -- 5 distinct values → dict-encoded
    type            LowCardinality(String),
    status          LowCardinality(String),
    description     Nullable(String),
    ip_address      Nullable(String),
    device_id       Nullable(String),
    created_at      DateTime64(3, 'Asia/Ho_Chi_Minh'),
    updated_at      DateTime64(3, 'Asia/Ho_Chi_Minh'),
    cdc_op          LowCardinality(String),     -- c / u / d / r
    _source_ts_ms   Int64,
    _ingested_at    DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(_source_ts_ms)
PARTITION BY toYYYYMM(created_at)
ORDER BY (account_id, created_at, id);
```

### SCRIPT

Two design choices on this slide worth calling out. First, `LowCardinality(String)`
for the columns that only ever have a handful of values — currency, type, status.
ClickHouse stores those as dictionary-encoded integers under the hood, which makes
`GROUP BY currency` cost basically nothing. Second, the ORDER BY clause —
`(account_id, created_at, id)`. ClickHouse's primary key isn't a unique constraint
like in Postgres; it's the *sort order on disk*. Because the queries I care about
the most are "show me everything for account X in the last hour", ordering by
account first means those queries do a tight, sequential read instead of a full
scan. The partition `toYYYYMM(created_at)` keeps data physically separated by month
so old partitions can be dropped wholesale by TTL. And finally, `_source_ts_ms` is
the version column for ReplacingMergeTree — that's how duplicates get resolved.

---

## Slide 18 — The Materialized View (parser)  (≈ 1 min)

### SLIDE

`clickhouse/init/04_create_materialized_views.sql`:

```sql
CREATE MATERIALIZED VIEW finwatch.transactions_mv
TO finwatch.transactions AS
SELECT
    id, account_id, merchant_id,
    toDecimal128(amount, 2)                                AS amount,   -- string → Decimal
    currency, type, status, description, ip_address, device_id,
    fromUnixTimestamp64Milli(coalesce(created_at,  __source_ts_ms))
                                                            AS created_at,
    fromUnixTimestamp64Milli(coalesce(updated_at,  __source_ts_ms))
                                                            AS updated_at,
    __op            AS cdc_op,
    __source_ts_ms  AS _source_ts_ms
FROM finwatch.transactions_kafka;
```

**Three conversions live here:**

1. Decimal as string → `Decimal(18,2)` — no precision loss.
2. Epoch milliseconds → `DateTime64(3, 'Asia/Ho_Chi_Minh')` — local timezone.
3. CDC operation `__op` flattened to a regular column → queryable.

### SCRIPT

This SELECT is short but it does three jobs. First, the amount comes in from
Debezium as a string — and that's intentional, to preserve precision — so I cast it
to `Decimal(18,2)` here. Second, Debezium ships timestamps as epoch milliseconds
since 1970, but I want them displayed in Vietnam local time, so I use
`fromUnixTimestamp64Milli` plus the `'Asia/Ho_Chi_Minh'` timezone tag. The
`coalesce(created_at, __source_ts_ms)` is a safety net — if for some reason a row
doesn't carry its own timestamp, fall back to the Debezium source timestamp. Third,
I rename `__op` to `cdc_op` so anomaly queries can filter out deletes by saying
`WHERE cdc_op != 'd'`. The point of doing the parsing here, in a SQL view, rather
than in a Python sink, is that there's no Python process to crash, no batching
logic to maintain, and the whole transform is auditable as a single SELECT.

---

## Slide 19 — Querying with `FINAL`  (≈ 45 sec)

### SLIDE

`ReplacingMergeTree` deduplicates **eventually** — during background merges.
Until merges complete, duplicates *do* sit in the table.

→ Every analytical query in this project ends with `FINAL`:

```sql
SELECT count() FROM finwatch.transactions FINAL WHERE cdc_op != 'd';
```

→ `FINAL` forces ClickHouse to apply the dedup logic *at query time*, on the fly,
per ORDER BY key.

→ Trade-off: a bit slower, but correct. For dashboards on millions of rows the
latency overhead is still < 50 ms in our measurements.

### SCRIPT

One subtlety with ReplacingMergeTree: the deduplication is *eventually consistent*.
ClickHouse merges parts in the background on its own schedule — could be seconds,
could be minutes. Between merges, you can absolutely see the same primary key with
two different versions. So every analytical query in the project adds the `FINAL`
keyword, which tells ClickHouse to do the dedup *at read time*, on the fly. That's
slower than a naïve scan — but in our benchmarks even with FINAL on a few million
rows the dashboard queries come back in tens of milliseconds. Correctness here is
worth more than the few extra milliseconds.

---

## Slide 20 — Anomaly Rule #1: Velocity Check  (≈ 1 min)

### SLIDE

> "Flag any account that does more than 10 transactions, or more than 50 M VND
> total, in any 5-minute window."

```sql
SELECT
    account_id,
    count()                  AS txn_count,
    sum(toFloat64(amount))   AS total_amount,
    min(created_at)          AS window_start,
    max(created_at)          AS window_end,
    groupArray(type)         AS txn_types
FROM finwatch.transactions FINAL
WHERE created_at >= now() - INTERVAL 5 MINUTE
  AND cdc_op != 'd'
GROUP BY account_id
HAVING txn_count > 10 OR total_amount > 50000000
ORDER BY txn_count DESC;
```

Catches: card-testing bursts, account drain, kited cheque schemes.

### SCRIPT

This is the simplest of the four rules, but it catches a huge class of real-world
fraud. The idea is: in a healthy account, you don't see ten transactions in five
minutes — humans just don't shop that fast. So this rule groups transactions by
account over a five-minute sliding window and emits any account that crossed either
the count or the amount threshold. `txn_count > 10` catches *velocity* attacks —
the attacker testing if a stolen card works. `total_amount > 50_000_000` — fifty
million VND, roughly two thousand US dollars — catches *account-drain* attacks,
where the attacker is trying to move money out fast before the card gets blocked.
Note the structure: `GROUP BY account_id` followed by `HAVING` is the standard SQL
way to express "find groups whose aggregates exceed a threshold."

---

## Slide 21 — Anomaly Rule #2: Z-Score (statistical outliers)  (≈ 1 min 15 s)

### SLIDE

For each transaction, compute how many standard deviations it sits from the
account's own 30-day history. **z > 3 → 99.7 % confidence anomaly.**

```sql
SELECT t.id, t.account_id, t.amount, t.type, t.created_at,
       round((toFloat64(t.amount) - stats.avg_amount)
             / nullIf(stats.std_amount, 0), 2) AS z_score
FROM finwatch.transactions t FINAL
JOIN (
    SELECT account_id,
           avg(toFloat64(amount))        AS avg_amount,
           stddevPop(toFloat64(amount))  AS std_amount,
           count()                       AS txn_count_30d
    FROM finwatch.transactions FINAL
    WHERE created_at >= now() - INTERVAL 30 DAY AND cdc_op != 'd'
    GROUP BY account_id
    HAVING txn_count_30d >= 5
) stats ON t.account_id = stats.account_id
WHERE t.created_at >= now() - INTERVAL 10 MINUTE
  AND abs((toFloat64(t.amount) - stats.avg_amount)
          / nullIf(stats.std_amount, 0)) > 3;
```

Catches: a customer who normally spends 200 k VND suddenly transferring 50 M.

### SCRIPT

Velocity rules are coarse — they don't know that an account spending 50 million is
*normal* for a corporate customer but extraordinary for a student. The z-score rule
fixes that with per-account personalization. For each account I compute the mean
and standard deviation of its last thirty days of transactions, then for each new
transaction I compute `(amount − mean) ÷ stddev`. If the absolute value is greater
than three, statistically there's only a 0.3 % chance that transaction came from
the same distribution. The `HAVING txn_count_30d >= 5` clause is a guard — I don't
want to flag a brand-new account with two transactions just because its standard
deviation is undefined. `nullIf(stats.std_amount, 0)` prevents division-by-zero
when an account only ever did one identical-amount transaction. This pattern — a
self-join with per-key statistics — is something Postgres would struggle with on a
big table, but ClickHouse handles it in milliseconds because both sides of the join
are reading columns, not rows.

---

## Slide 22 — Anomaly Rule #3 & #4: Threshold + Composite  (≈ 45 sec)

### SLIDE

`anomaly_threshold.sql` is actually **four rules** in one file:

1. **Large single transaction** — `amount > 100 M VND` in the last hour.
2. **High-risk merchant** — join on `merchants.risk_level = 'high'` (gambling,
   crypto exchanges, etc.).
3. **Multi-currency in short window** — same account, >2 distinct currencies in
   10 minutes (laundering pattern).
4. **Failed transaction spike** — `>= 3` failures and `> 50 %` fail rate in 30
   minutes (carding pattern).

Each is a parameterized SQL query → can be parameterized, scheduled, or wired
straight into a Grafana alert.

### SCRIPT

For brevity I'm collapsing rules three and four onto one slide. The threshold file
in my repo actually contains four sub-rules. *Large single transaction* — anything
over 100 million VND in the last hour, which catches the classic "drain the
account in one shot" pattern. *High-risk merchant* — a join between transactions
and merchants where the merchant's risk level is "high". I seeded a couple of
high-risk merchants like "Online Casino XYZ" and "CryptoExchange ABC" precisely so
this rule has something to fire on. *Multi-currency in short window* — same
account hitting three or more currencies in ten minutes is a classic
money-laundering signature. And *failed transaction spike* — three or more
failures in thirty minutes with a fail rate above 50 % is what carders do when
they're brute-forcing CVVs. Each of these is a single, auditable SQL query — no
black box.

---

## Slide 23 — Monitoring & Dashboards  (≈ 1 min)

### SLIDE

**Grafana** (`grafana/provisioning/`) — auto-provisioned at first boot:

- Datasources: ClickHouse + Prometheus
- Dashboard: **FinWatch — Pipeline Health**
  - Transactions per minute (live)
  - Top merchants by volume (1 h)
  - Velocity alerts (count of flagged accounts, last 5 min)
  - Ingestion lag — `_ingested_at − created_at` (P50 / P95 / max)

**Prometheus** scrapes: ClickHouse `/metrics`.

**FinWatch web UI** (port 3002) — custom Next.js demo dashboard with live particles,
6 fraud-rule cards, per-hop trace view, and manual insert tool.

### SCRIPT

Grafana is provisioned as code, panels are version-controlled in the repo, and it's
wired to both ClickHouse and Prometheus. The flagship dashboard is *FinWatch —
Pipeline Health*, with four panels: transactions per minute coming from ClickHouse;
top merchants by volume; flagged-account count; and end-to-end ingestion lag, which
I compute as `_ingested_at` minus `created_at`. That last panel is how I notice in
real time that the pipeline is healthy. Alongside Grafana I built a custom Next.js
web UI on port 3002, purpose-built for the thesis demo — animated architecture flow,
all six fraud-rule cards, per-transaction tracer, and an insert-and-trace tool that
lets me show the committee a row crossing every pipeline stage live. Prometheus
scrapes ClickHouse metrics for operational dashboards.

---

## Slide 24 — Live Demo  (5–7 min)  ★

### SLIDE

```
LIVE DEMO

1.  Stack health         (docker compose ps + endpoints)
2.  Single-row CDC       (INSERT in PG → ClickHouse in seconds)
3.  Kafka in flight      (FinWatch /kafka, see the JSON event)
4.  Bulk load            (2 000 transactions @ 200 TPS)
5.  Fraud simulation     (velocity, large amount, multi-currency)
6.  Anomaly queries      (run all 4 rules)
7.  Grafana dashboard    (live update)
```

→ Follow `presentation/DEMO.md` step-by-step.

### SCRIPT

This is the demo block. I'm going to switch to my terminal and browser, and walk
through seven steps in this order. Please feel free to interrupt me at any step
and ask "what just happened" or "show me that file" — the whole project is on this
laptop. *[switch to terminal, follow `presentation/DEMO.md`]*

---

## Slide 25 — Testing  (≈ 45 sec)

### SLIDE

`tests/` — pytest, three suites:

| File                          | Verifies                                                  |
| ----------------------------- | --------------------------------------------------------- |
| `test_pipeline_health.py`     | every container is reachable + healthy + connector RUNNING|
| `test_data_integrity.py`      | PG row count ≈ CH row count (within lag tolerance); no NULL primary keys |
| `test_anomaly_detection.py`   | each anomaly rule returns rows after fraud injection      |

`pytest tests/ -v` → 14 tests, all green.

### SCRIPT

A defensible system needs tests, not just demos. There are three pytest files. One
just hits each component's health endpoint and verifies that the Debezium connector
is `RUNNING` — that's the smoke test. The second is more interesting: it generates
some transactions, waits for the pipeline lag, and asserts that the row count in
Postgres matches the row count in ClickHouse (FINAL-ed) within a tolerance. That's
how I guarantee no rows are being silently dropped. The third runs each of the four
anomaly rules after injecting known-bad data and asserts at least one row comes
back from each. Fourteen tests in total. They all pass on a clean `docker compose
up`.

---

## Slide 26 — Benchmark #1: End-to-End Latency  (≈ 1 min)

### SLIDE

`scripts/benchmark_latency.py` — insert a marked row in Postgres, poll ClickHouse
until it appears, record the elapsed time.

| Metric           | Target     | **Measured** |
| ---------------- | ---------- | ------------ |
| Avg              | < 5 000 ms | **1 235 ms** |
| Median           |    —       | **1 050 ms** |
| P95              | < 8 000 ms | **2 104 ms** |
| Max              |    —       | **3 800 ms** |
| Within 5 s SLA   | —          | **20 / 20**  |

Latency budget breakdown:
`Postgres commit (~50 ms) + WAL → Debezium (~200 ms) + Kafka (~50 ms) + CH MV (~500–1 500 ms) + poll granularity (200 ms)`.

### SCRIPT

This is the headline number. The latency benchmark works like this: I generate a
UUID, INSERT a transaction tagged with that UUID into Postgres, immediately start a
polling loop against ClickHouse asking "do you have this UUID yet?" with a 200ms
sleep, and stop the clock the moment it shows up. Running twenty samples, the
average was **1.2 seconds** end-to-end and the 95th percentile was **2.1 seconds**.
Both are well under my 5-second target. The breakdown is roughly: Postgres commit
is essentially free; the WAL-to-Debezium hop is around 200 ms because Debezium
polls the slot in a tight loop; Kafka adds about 50 ms because we're single-node;
the ClickHouse materialized view typically waits up to 1.5 seconds to batch inserts
for efficiency; and finally my polling has a 200 ms granularity, which by itself
adds up to 200 ms of measurement noise.

---

## Slide 27 — Benchmark #2: Throughput  (≈ 45 sec)

### SLIDE

`scripts/benchmark_throughput.py` — INSERT 10 000 transactions in batches of 100
as fast as possible.

| Metric                 | Target     | **Measured** |
| ---------------------- | ---------- | ------------ |
| Sustained insert rate  | > 1 000 TPS| **1 720 TPS**|
| CH query: 1 h volume   | < 500 ms   | **11 ms**    |
| CH query: top-20 merch | < 500 ms   | **23 ms**    |

Bottleneck is the Python generator, not the pipeline.

### SCRIPT

The throughput benchmark pushes ten thousand rows through as fast as the Python
generator can submit them. We measured **1 720 transactions per second** sustained,
well above the 1 000 TPS target. And critically, ClickHouse queries against the
freshly ingested data come back in *tens of milliseconds* — the 1-hour volume
query in 11 ms, the top-20-merchants query in 23 ms. The bottleneck at this scale
is actually the Python loader, not any part of the pipeline — the bottleneck is
me producing inserts, not Postgres or Kafka or ClickHouse processing them.

---

## Slide 28 — Lessons Learned  (≈ 1 min)

### SLIDE

Things I *thought* would be hard, but weren't:

- Wiring up the Docker network — Compose handled it.
- ClickHouse Kafka Engine — a single SETTINGS block did the job.

Things I *didn't think* would be hard, but were:

- **Decimal precision**: silently lost cents until I switched to `decimal.handling.mode=string`.
- **Timestamps**: Debezium epoch-ms vs. ClickHouse DateTime64 vs. Postgres TIMESTAMPTZ — three different mental models.
- **WAL bloat**: a single forgotten replication slot can kill the database — *heartbeats are not optional.*
- **`FINAL` is mandatory**: I shipped queries without it for a week and got intermittent ghosts.

### SCRIPT

If I were doing this again, the things I'd flag to a teammate aren't the things on
the architecture diagram. The Docker plumbing turned out to be the easy part —
Compose with proper `depends_on` and healthchecks just works. The hard parts were
all data-type and protocol details. I lost two days because amounts were
silently rounded — Debezium ships decimals as base64 bytes by default. I fixed
that with `decimal.handling.mode=string`. Timestamps were the second time-sink —
Postgres has TIMESTAMPTZ, Debezium emits epoch milliseconds, ClickHouse takes
DateTime64; three different mental models for the same wall-clock moment. WAL
bloat was the scariest thing I learned about — if I'd left a stale replication
slot during a weekend off, my dev Postgres would have crashed by Monday. And
`FINAL` — I omitted it on a dashboard query once and intermittently saw row counts
double during merges. That's why every analytical query in this repo ends in FINAL.

---

## Slide 29 — Limitations & Future Work  (≈ 45 sec)

### SLIDE

**Known limitations**

- Single-node everything → no HA, no horizontal scale.
- JSON over Kafka → ~50 % larger payloads than Avro.
- Rules are static SQL → no online learning.
- Passwords in `.env` → not Vault / KMS / Secrets Manager.

**Future work**

- Swap JSON → Avro by adding a schema registry (Apicurio or Confluent).
- Multi-broker Kafka with `replication.factor = 3` and `min.insync.replicas = 2`.
- A *scoring service* in Python/Rust that consumes Kafka, queries ClickHouse, and
  emits a composite fraud score back into a new `fraud_alerts` topic.
- Skip indexes & projections in ClickHouse for sub-millisecond hot queries.

### SCRIPT

I want to be explicit about what this *isn't*. It isn't production-ready. It's a
single-node demo on Docker — every component is a single replica. JSON over Kafka
costs roughly twice the bytes of Avro. The anomaly rules are static SQL — they
can't learn from feedback. And secrets are in a `.env` file. If I were extending
this, the four things on the right-hand side would be the next steps. Switch JSON
for Avro by adding a schema registry (Apicurio or Confluent). Run Kafka with three
brokers and proper ISR settings. Add a real scoring service in Python or Rust that
consumes from Kafka, queries ClickHouse for the account's history, computes a
weighted composite score, and writes back into a `fraud_alerts` topic that
downstream systems can subscribe to. And tune ClickHouse with skip indexes and
projections for the hottest dashboard queries.

---

## Slide 30 — Summary  (≈ 30 sec)

### SLIDE

**FinWatch in one line:** end-to-end CDC pipeline from Postgres to ClickHouse with
SQL-based fraud detection — **avg latency 1.2 s, sustained 1 720 TPS, on one laptop.**

**Deliverables**

- ✅ Reproducible Docker Compose stack (8 services)
- ✅ Four anomaly rules in pure SQL
- ✅ Grafana dashboard provisioned as code
- ✅ 14 automated tests, all green
- ✅ 8-chapter tutorial + operational runbook
- ✅ Latency + throughput benchmarks with documented methodology

→ Everything in `D:\Major\Graduate_Project\finwatch\`.

### SCRIPT

To wrap up: FinWatch is an end-to-end CDC pipeline that captures, ships, and
analyzes financial transactions in real time, with four SQL-based fraud-detection
rules layered on top — all running on a single laptop in under a minute and a half
of latency at over seventeen hundred transactions per second. Everything I just
described — the configs, the schemas, the queries, the tests, the benchmarks, the
runbook, and an eight-chapter tutorial — is in the repository on this machine.
Happy to answer any questions.

---

## Slide 31 — Q&A  (open)

### SLIDE

```
Questions?

Repo:    D:\Major\Graduate_Project\finwatch\
Tutorial: docs/tutorial/  (eight chapters)
Runbook:  docs/runbook.md
```

### SCRIPT

Thank you. I'm ready for questions.

---

## Appendix A — Likely Questions, Prepared Answers

> Have these on a separate page in front of you. The committee will *definitely*
> ask one or two of these.

**Q: Why not Kafka Connect's JDBC source instead of Debezium?**
JDBC source polls with a SELECT — it can't see deletes, and it's hard on the OLTP
database. Debezium reads the WAL once, sees everything including deletes, and has
near-zero load on Postgres.

**Q: What happens if Debezium dies for an hour?**
The replication slot in Postgres holds the WAL where Debezium left off. Kafka
keeps its consumer offsets. When Debezium comes back, it resumes from the exact
LSN it was at. No data loss — but WAL on the Postgres disk *will* grow during the
outage, which is the failure mode I'd monitor in production.

**Q: Why JSON, not Avro?**
JSON is debuggable end-to-end with `kafka-console-consumer`. Avro requires a schema
registry to read messages. For a thesis project, debuggability beats the 50 %
payload-size win. Switching to Avro is a clean upgrade path — add a registry and
update the `kafka_format` settings.

**Q: How do you handle schema changes in Postgres?**
Logical decoding in Postgres does *not* emit DDL events — so adding a column to
Postgres is invisible to Debezium until the next data write on that column. The
practical workflow is: (1) add column in Postgres, (2) backfill, (3) update the
materialized view in ClickHouse to project it, (4) update target table DDL. There
is no auto-propagation.

**Q: Why ReplacingMergeTree and not CollapsingMergeTree?**
Replacing keeps the *latest* version per key — natural fit for upserts.
Collapsing wants matched +1/−1 sign columns, which Debezium doesn't emit cleanly.
For pure CDC, Replacing is the standard pattern.

**Q: What's the recovery procedure if ClickHouse loses a partition?**
Truncate that partition, reset the Kafka consumer group offsets to the start of
the retention window (default 7 days), and let the materialized view re-ingest.
The pipeline is idempotent because of ReplacingMergeTree.

**Q: How do you avoid double-counting if Debezium re-sends a row?**
`_source_ts_ms` is the version column on ReplacingMergeTree. A re-sent row has
the same `(account_id, created_at, id)` *and* the same or lower `_source_ts_ms`
→ ClickHouse keeps only the highest version. Queries use `FINAL` to apply this
at read time before merges complete.

**Q: How would you scale this 100×?**
Three things in order: (1) Kafka multi-broker with proper partitioning by
`account_id` for ordered parallelism; (2) ClickHouse sharding with the same key,
plus ReplicatedReplacingMergeTree behind a Distributed table; (3) Debezium
parallel snapshot mode and multiple tasks per connector. The bottleneck always
moves to whichever layer you scaled last.
