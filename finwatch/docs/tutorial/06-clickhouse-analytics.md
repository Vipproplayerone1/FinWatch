# Chapter 06 — ClickHouse: real-time analytics

## Why this matters

This is where the data turns into answers. Everything before this chapter was about *moving* the data; ClickHouse is where you *query* it. Dashboards, fraud detection, reconciliation, business intelligence — all of it runs on queries that ClickHouse answers in milliseconds over tables with billions of rows.

By the end of this chapter you'll understand why ClickHouse is dramatically faster than Postgres for analytics (hint: columns vs rows), how it pulls messages out of Kafka using a special "Kafka Engine" table, how Materialized Views act as always-on stream processors, and how `ReplacingMergeTree` cleans up the duplicates that inevitably result from at-least-once delivery. You'll also see the trap of the `FINAL` keyword and when to use it.

---

## Theory

### OLAP vs OLTP, one more time

In chapter 02 you learned Postgres is OLTP — optimized for many small writes, each correct and durable. ClickHouse is OLAP — optimized for queries over millions or billions of rows. They're different *kinds* of database, not just different brands. Four key differences:

| Aspect | OLTP (Postgres) | OLAP (ClickHouse) |
|---|---|---|
| Storage | Row-oriented (all columns of one row stored together) | Column-oriented (all values of one column stored together) |
| Writes | Individual rows, millisecond latency | Bulk inserts, efficient compression |
| Reads | Point lookups by primary key | Scans over many rows, aggregations |
| Indexes | B-tree for precise lookups | Sparse primary index + skip indexes |

If you tried to use Postgres for `SELECT SUM(amount) FROM transactions WHERE created_at > now() - INTERVAL '1 day'` on a billion-row table, Postgres would read every row and take many seconds. ClickHouse reads only the `amount` and `created_at` columns, heavily compressed, and answers in milliseconds.

### Why columnar storage is so much faster for analytics

A `transactions` table with 15 columns and 1 billion rows, stored row-oriented, looks like:

```
[id1, account1, amount1, ..., created1], [id2, account2, amount2, ..., created2], ...
```

Your query on `SUM(amount)` has to skip 14 unrelated fields for every row — most of the disk I/O is waste.

Stored column-oriented:

```
amount column:      [amount1, amount2, amount3, ..., amountN]     (compressed tightly — similar values next to each other)
created_at column:  [created1, created2, created3, ..., createdN]
id column:          [id1, id2, id3, ..., idN]
...
```

Now your query reads only `amount` and `created_at`, and those columns compress exceptionally well because adjacent values are often similar (rates, timestamps, repeated strings). 10–20x compression is normal. Reading 20x less data means 20x faster queries.

Column storage makes point lookups (`WHERE id = 'abc'`) slower than a row-oriented database. That's fine — ClickHouse isn't for point lookups, it's for analytics.

### The MergeTree family

ClickHouse's main table engine family is MergeTree. All variants share:

- Data sorted on disk by a primary key (the `ORDER BY` clause — this is the *sorting* key, not a uniqueness key)
- Data split into disk parts by a partition key (optional)
- Background merges that combine small parts into big ones

Variants:

| Engine | Purpose |
|---|---|
| `MergeTree` | Plain columnar table. No deduplication, no aggregation. |
| `ReplacingMergeTree` | **Replaces duplicates** based on the sort key during merges. FinWatch uses this. |
| `SummingMergeTree` | Sums rows with the same sort key. Useful for pre-aggregated metrics. |
| `AggregatingMergeTree` | Like Summing but for any aggregate function. |
| `CollapsingMergeTree` | Cancel out pairs of rows (e.g., insert + delete). |
| `VersionedCollapsingMergeTree` | Ordered collapsing. |
| `Kafka` | Special — reads from Kafka, not a storage engine. |

### ReplacingMergeTree and why it exists for CDC

CDC delivery is at-least-once. Debezium might re-send a row after a restart. Kafka retention might replay. ClickHouse might re-ingest after a crash. The pipeline *will* produce duplicates at some rate. You need a way to live with that.

`ReplacingMergeTree(version)` solves it:

- Rows with the same `ORDER BY` key are considered duplicates
- When ClickHouse merges parts in the background, duplicates are collapsed
- The row kept is the one with the **highest** value of the `version` column

FinWatch uses `_source_ts_ms` (when Postgres committed) as the version. Two messages for the same row `id` — one from initial snapshot, one from a later UPDATE — will eventually merge into just the UPDATE.

Critical caveat: **merges happen in the background, whenever ClickHouse feels like it.** Until a merge runs, *both* rows are visible in queries. For a freshly-inserted duplicate, a plain `SELECT` will see both. This is why FinWatch queries use `FINAL`.

### The `FINAL` modifier

```sql
SELECT count() FROM finwatch.transactions FINAL;
```

`FINAL` forces ClickHouse to merge parts on the fly during the query. Slower (maybe 2–5x) but guaranteed to see only the latest version of each row.

When to use:
- **Interactive queries and dashboards**: use FINAL for correctness
- **Ad-hoc aggregations you know will take seconds**: FINAL is fine
- **High-throughput scoring pipelines**: skip FINAL, accept occasional duplicates, deduplicate downstream if needed

For FinWatch (dashboards, anomaly detection, reconciliation), we use FINAL. Performance is still excellent.

### The Kafka Engine table

A `Kafka` engine table isn't a storage table — it's a *consumer*. When you `SELECT` from it, ClickHouse reads from Kafka and returns whatever messages it pulls. Each SELECT consumes messages (advances the consumer group's offset).

Useful for one-off debugging, but hostile for production queries — each query would steal messages from the real pipeline. So in practice you never query the Kafka engine directly. Instead you wire a **Materialized View** to it.

### Materialized Views as stream processors

ClickHouse's Materialized View isn't like Postgres's — it's not "a cached query result you refresh periodically". It's a trigger: every INSERT into a source table automatically runs a SELECT and writes the result to a target table.

```
┌──────────────────┐       ┌────────────────┐       ┌──────────────────┐
│ Kafka Engine     │       │ Materialized   │       │ Target Table     │
│ table            │──────▶│ View           │──────▶│ (ReplacingMerge- │
│ (consumes Kafka) │ reads │ (runs SELECT)  │ writes│  Tree)           │
└──────────────────┘       └────────────────┘       └──────────────────┘
```

When Kafka Engine receives a batch of messages, ClickHouse runs the MV's SELECT against those messages and inserts the results into the target table. This is the "cheat code" — the stream processing happens for free, just by virtue of the MV existing.

For FinWatch, the MV's SELECT does three things:

1. Parse the `amount` string into a `Decimal(18, 2)` (because Debezium sent it as a string per `decimal.handling.mode=string`)
2. Parse the `created_at`/`updated_at` ISO strings into `DateTime64(3, 'Asia/Ho_Chi_Minh')`
3. Rename `__op` → `cdc_op` and keep `__source_ts_ms` as `_source_ts_ms` (the version for ReplacingMergeTree)

---

## How it's used in FinWatch

The ClickHouse side is split across four files, each runs once when the `clickhouse-data` volume is fresh.

### `01_create_databases.sql`

Trivially creates the database:

```sql
CREATE DATABASE IF NOT EXISTS finwatch;
```

Everything else lives in `finwatch.*`.

### `02_create_kafka_engines.sql` — the three Kafka consumers

Excerpt (`finwatch.transactions_kafka`):

```sql
CREATE TABLE IF NOT EXISTS finwatch.transactions_kafka (
    id              String,
    account_id      String,
    merchant_id     Nullable(String),
    amount          String,          -- Debezium sends decimal as string
    currency        String,
    type            String,
    status          String,
    description     Nullable(String),
    ip_address      Nullable(String),
    device_id       Nullable(String),
    created_at      Nullable(String),
    updated_at      Nullable(String),
    __deleted       Nullable(String),
    __op            String,
    __table         String,
    __source_ts_ms  Int64
) ENGINE = Kafka
SETTINGS
    kafka_broker_list = 'kafka:9092',
    kafka_topic_list = 'finwatch.public.transactions',
    kafka_group_name = 'clickhouse_transactions',
    kafka_format = 'JSONEachRow',
    kafka_num_consumers = 1,
    kafka_max_block_size = 65536,
    kafka_skip_broken_messages = 10;
```

Notable design decisions:

- **Every column is a `String` or `Nullable(String)` at this stage.** Why? Because Debezium sends decimals and timestamps as strings, and we don't want the Kafka engine to crash on a parse error mid-stream. We'll convert types in the materialized view, where any failure only affects one row.
- **`amount` specifically is String.** Conversion to Decimal happens in the MV. If we declared it `Decimal(18,2)` here, a malformed message would break the consumer for the whole topic.
- **`kafka_format = 'JSONEachRow'`** matches what Debezium produces (one JSON object per Kafka message, with `schemas.enable: false`).
- **`kafka_group_name = 'clickhouse_transactions'`** — each table has a distinct group so offsets don't collide. Changing this name causes ClickHouse to re-read the topic from the beginning (as a new consumer group).
- **`kafka_skip_broken_messages = 10`** — if up to 10 messages are malformed, skip them and continue. The 11th will stop consumption. Safer than `kafka_skip_broken_messages = 0` (stop on any error), less safe than `1000000` (never stop).
- **`kafka_max_block_size = 65536`** (transactions only) — batch up to 65k messages before flushing to the MV. Trade-off: larger blocks are more efficient; smaller blocks give lower ingestion latency. 64k is the default.

### `03_create_target_tables.sql` — the ReplacingMergeTree destinations

`finwatch.transactions`:

```sql
CREATE TABLE IF NOT EXISTS finwatch.transactions (
    id              String,
    account_id      String,
    merchant_id     Nullable(String),
    amount          Decimal(18, 2),
    currency        LowCardinality(String),
    type            LowCardinality(String),
    status          LowCardinality(String),
    description     Nullable(String),
    ip_address      Nullable(String),
    device_id       Nullable(String),
    created_at      DateTime64(3, 'Asia/Ho_Chi_Minh'),
    updated_at      DateTime64(3, 'Asia/Ho_Chi_Minh'),
    cdc_op          LowCardinality(String),
    _source_ts_ms   Int64,
    _ingested_at    DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(_source_ts_ms)
PARTITION BY toYYYYMM(created_at)
ORDER BY (account_id, created_at, id)
SETTINGS index_granularity = 8192;
```

Key choices:

- **`Decimal(18, 2)`** matches Postgres exactly. Money stays exact.
- **`LowCardinality(String)`** — a ClickHouse optimization for columns with few distinct values (like `currency`, `type`, `status`). Stored as a small integer with a dictionary. Huge compression win.
- **`DateTime64(3, 'Asia/Ho_Chi_Minh')`** — millisecond precision timestamps in Vietnam's timezone. Queries return times already in local time.
- **`ENGINE = ReplacingMergeTree(_source_ts_ms)`** — dedup by sort key, keep the row with the latest `_source_ts_ms`.
- **`PARTITION BY toYYYYMM(created_at)`** — store each month's data in its own disk directory. Queries filtered by month skip unrelated partitions entirely.
- **`ORDER BY (account_id, created_at, id)`** — this is the *sort/primary key* (ClickHouse's primary key is sparse — it indexes every 8192nd row). Queries filtered by `account_id` or a date range hit the index; other filters scan more broadly.
- **`_ingested_at DateTime64(3) DEFAULT now64(3)`** — records when the row arrived in ClickHouse. Useful for measuring end-to-end pipeline latency.

`finwatch.accounts` and `finwatch.merchants` are similar but simpler — both use `ORDER BY id` (no time partitioning) because they're slowly-changing reference data.

### `04_create_materialized_views.sql` — the stream processor

`finwatch.transactions_mv`:

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS finwatch.transactions_mv
TO finwatch.transactions AS
SELECT
    id,
    account_id,
    merchant_id,
    toDecimal128(amount, 2)                         AS amount,
    currency,
    type,
    status,
    description,
    ip_address,
    device_id,
    if(
        created_at IS NOT NULL AND created_at != '',
        parseDateTimeBestEffort(created_at),
        fromUnixTimestamp64Milli(__source_ts_ms)
    )                                               AS created_at,
    if(
        updated_at IS NOT NULL AND updated_at != '',
        parseDateTimeBestEffort(updated_at),
        fromUnixTimestamp64Milli(__source_ts_ms)
    )                                               AS updated_at,
    __op                                            AS cdc_op,
    __source_ts_ms                                  AS _source_ts_ms
FROM finwatch.transactions_kafka;
```

Line by line:

- **`TO finwatch.transactions`** — the target table. MV writes here instead of creating its own storage.
- **`toDecimal128(amount, 2)`** — parse the string "123.45" back into `Decimal(18, 2)`.
- **`parseDateTimeBestEffort(created_at)`** — parse ISO timestamp string "2026-04-21T12:41:43.983702Z" into DateTime64. If the string is null or empty (which happens sometimes with late-binding Debezium fields), fall back to `fromUnixTimestamp64Milli(__source_ts_ms)` which always has a valid value.
- **`__op AS cdc_op`** — rename for cleanliness.
- **`__source_ts_ms AS _source_ts_ms`** — this becomes the version column ReplacingMergeTree uses.

The `if(... IS NOT NULL AND ... != '', ..., fallback)` pattern is important: it prevents one malformed timestamp from breaking the whole pipeline. You get a row with a synthetic timestamp (the CDC event's source time, which is always valid) instead of a failed insert.

---

## Hands-on

Make sure all the pipeline services are up:

```bash
cd D:/Major/Graduate_Project/finwatch
docker compose up -d postgres zookeeper kafka debezium clickhouse
```

Wait for ClickHouse to be healthy:

```bash
docker compose ps clickhouse
# Should show (healthy)
```

### Step 1 — Connect to ClickHouse

Use `clickhouse-client` inside the container:

```bash
docker exec -it finwatch-clickhouse clickhouse-client --database=finwatch
```

You land in:

```
finwatch-clickhouse :)
```

### Step 2 — List tables

```sql
SHOW TABLES;
```

Expected:

```
accounts
accounts_kafka
accounts_mv
merchants
merchants_kafka
merchants_mv
transactions
transactions_kafka
transactions_mv
```

Three sets of three: the Kafka engine consumer, the target table, and the materialized view in between.

### Step 3 — Look at the Kafka engine config

```sql
SHOW CREATE TABLE transactions_kafka FORMAT Vertical;
```

Vertical format shows each column on its own line. You'll see the `ENGINE = Kafka` clause with the settings you learned about.

### Step 4 — Count rows by table

```sql
SELECT count() FROM accounts FINAL;
SELECT count() FROM merchants FINAL;
SELECT count() FROM transactions FINAL;
```

Expected (your numbers will vary based on how much you've played with the system):

```
count()
-------
     10

count()
-------
     12

count()
-------
 171463
```

`FINAL` gives you the deduplicated count. Without it:

```sql
SELECT count() FROM transactions;
```

may be *larger*, because of un-merged duplicates in the raw data. Do a spot check:

```sql
SELECT count() AS with_final
FROM transactions FINAL;

SELECT count() AS without_final
FROM transactions;
```

If they match exactly, all merges have happened. If `without_final` is bigger, there are pending duplicates.

### Step 5 — Query some transactions

```sql
SELECT
    id,
    account_id,
    amount,
    type,
    status,
    created_at
FROM transactions FINAL
ORDER BY created_at DESC
LIMIT 5;
```

This should be fast (milliseconds even on a million rows). Notice `created_at` is displayed in Vietnam time (UTC+7), and `amount` has the expected two decimal places.

### Step 6 — See the Kafka consumer group from ClickHouse's side

```sql
SELECT
    database,
    table,
    consumer_id,
    assignments
FROM system.kafka_consumers
FORMAT Vertical;
```

Each Kafka Engine table has one consumer. `assignments` shows which partitions it's reading. Note the consumer IDs — they match what you'd see in Kafka's `kafka-consumer-groups --describe`.

### Step 7 — Watch end-to-end latency

Run this query while inserting data in Postgres:

```sql
SELECT
    dateDiff('millisecond',
        fromUnixTimestamp64Milli(_source_ts_ms),
        _ingested_at
    ) AS pipeline_lag_ms,
    count()
FROM transactions
WHERE _ingested_at >= now() - INTERVAL 1 MINUTE
GROUP BY pipeline_lag_ms
ORDER BY pipeline_lag_ms DESC
LIMIT 10;
```

`_source_ts_ms` is when Postgres committed. `_ingested_at` is when the row arrived in ClickHouse. The difference is the total pipeline latency: Postgres → Debezium → Kafka → ClickHouse Kafka Engine → MV → target table.

For a healthy pipeline, you'll see tens to low hundreds of milliseconds. Values in seconds or higher indicate backpressure somewhere — chapter 07 covers how to isolate which stage.

### Step 8 — Trigger a live insert in Postgres and watch it appear

**Terminal 1**:

```bash
docker exec -it finwatch-clickhouse clickhouse-client --database=finwatch \
  -q "SELECT id, amount, description, _ingested_at FROM transactions FINAL WHERE description LIKE 'Chapter 06%' ORDER BY _ingested_at DESC"
```

Empty result — no such row yet.

**Terminal 2**:

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
INSERT INTO transactions (account_id, merchant_id, amount, type, status, description)
SELECT
    (SELECT id FROM accounts LIMIT 1),
    (SELECT id FROM merchants LIMIT 1),
    12345.67, 'purchase', 'completed', 'Chapter 06 end-to-end test';
"
```

**Back to Terminal 1**, wait a few seconds, re-run the SELECT. You should see the new row.

### Step 9 — Disable FINAL and see the unmerged truth

Insert the same description twice to force a visible duplicate:

```bash
# Terminal 2:
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
UPDATE transactions
SET status = 'flagged'
WHERE description = 'Chapter 06 end-to-end test';
"
```

In ClickHouse:

```sql
SELECT count() AS with_final FROM transactions FINAL WHERE description = 'Chapter 06 end-to-end test';
SELECT count() AS without_final FROM transactions WHERE description = 'Chapter 06 end-to-end test';
```

`with_final` should be 1 (the latest state), `without_final` might be 2 (original INSERT + the UPDATE, both still in the log until merges happen). This is the ReplacingMergeTree illusion — the truth has two rows; the view with FINAL collapses them.

### Step 10 — Force a merge and see the duplicate disappear

You can manually trigger merges:

```sql
OPTIMIZE TABLE transactions FINAL;
```

This is expensive on big tables — ClickHouse re-writes parts. Useful for debugging. After it completes:

```sql
SELECT count() AS without_final FROM transactions WHERE description = 'Chapter 06 end-to-end test';
```

Should be 1 now. In production you don't run `OPTIMIZE FINAL` routinely — you just query with `FINAL` when correctness matters, and let background merges do their thing.

### Step 11 — A join across tables

This is what you couldn't do in Postgres at scale. In ClickHouse:

```sql
SELECT
    m.name AS merchant,
    m.category,
    count() AS txn_count,
    sum(t.amount) AS total_amount
FROM transactions t FINAL
INNER JOIN merchants m FINAL ON t.merchant_id = m.id
WHERE t.created_at >= now() - INTERVAL 1 HOUR
GROUP BY m.name, m.category
ORDER BY total_amount DESC
LIMIT 10;
```

Fast — typically well under a second even on millions of rows.

### Step 12 — Exit the client

```
exit
```

Or Ctrl+D.

---

## Checkpoints

1. Why is every column in `transactions_kafka` declared as `String` instead of the "real" type like `Decimal(18, 2)` for `amount`?
2. What does `ReplacingMergeTree(_source_ts_ms)` do when there are two rows with the same `(account_id, created_at, id)` sort key?
3. Why does `SELECT count() FROM transactions` (without FINAL) sometimes return a larger number than `SELECT count() FROM transactions FINAL`?
4. If you changed `kafka_group_name` in the Kafka Engine config from `clickhouse_transactions` to `clickhouse_transactions_v2`, what would happen?

(Answers at the bottom.)

---

## Troubleshooting

**Problem:** `SHOW TABLES FROM finwatch` returns nothing, but ClickHouse is running.
**Cause:** The init SQL scripts didn't run. They only run on first boot of a fresh `clickhouse-data` volume. If the volume existed before, the scripts were skipped.
**Fix:** Either run them manually:

```bash
docker exec -i finwatch-clickhouse clickhouse-client --database=default \
  < clickhouse/init/01_create_databases.sql
docker exec -i finwatch-clickhouse clickhouse-client --database=finwatch \
  < clickhouse/init/02_create_kafka_engines.sql
# ... and so on for 03 and 04
```

Or wipe the volume and restart:

```bash
docker compose stop clickhouse
docker volume rm finwatch_clickhouse-data
docker compose up -d clickhouse
```

---

**Problem:** ClickHouse Kafka Engine isn't consuming — `system.kafka_consumers` is empty, or the target table has no rows even though Kafka has messages.
**Cause:** Usually either (a) the Kafka Engine table doesn't exist, (b) the Materialized View doesn't exist, or (c) the broker address is wrong.
**Fix:** Check the chain:

```sql
SHOW CREATE TABLE transactions_kafka;
-- Make sure kafka_broker_list = 'kafka:9092' (not 'localhost:9092')

SHOW CREATE TABLE transactions_mv;
-- Make sure it says "TO finwatch.transactions"

SELECT * FROM system.kafka_consumers;
-- Should show one consumer per Kafka Engine table
```

If the MV is missing:

```bash
docker exec -i finwatch-clickhouse clickhouse-client \
  --database=finwatch < clickhouse/init/04_create_materialized_views.sql
```

---

**Problem:** Target table is filling up with rows where `created_at` looks wrong (e.g., 1970).
**Cause:** Debezium is sending `created_at` as `null` or empty string, and the MV's fallback is using `__source_ts_ms` — which should be valid, unless that's also malformed.
**Fix:** Look at raw Kafka messages:

```bash
docker exec finwatch-kafka kafka-console-consumer \
  --bootstrap-server kafka:9092 \
  --topic finwatch.public.transactions \
  --max-messages 1 --timeout-ms 15000
```

Check the `created_at` and `__source_ts_ms` fields. If `__source_ts_ms` is `0`, Debezium's `heartbeat.interval.ms` or `time.precision.mode` is misconfigured. Usually a connector restart fixes it.

---

**Problem:** Queries without FINAL return wrong results (too many rows).
**Cause:** Unmerged duplicates in the ReplacingMergeTree, which is normal.
**Fix:** Either use FINAL in your query (preferred), or run `OPTIMIZE TABLE ... FINAL` (expensive, don't do routinely), or design queries that don't care about exact dedup (e.g., `count()` on a low-duplicate workload).

---

**Problem:** `SELECT count() FROM transactions_kafka` returns 0 or hangs.
**Cause:** You're querying a Kafka Engine table, which *consumes* messages from Kafka on read. If there are no pending messages (all have been consumed by the MV already), it returns 0 or blocks waiting for new messages. Don't query Kafka Engine tables directly for data — they're meant to feed the MV, not to be read.
**Fix:** Query `transactions` (the target table) instead. Kafka Engine tables are write-only from your perspective.

---

## Where to go next

You've now built and observed the full pipeline: Postgres → CDC → Kafka → ClickHouse. Next chapter ties it all together with an end-to-end walkthrough, testing UPDATEs and DELETEs, and measuring latency at every stage.

Next: **[Chapter 07 — End-to-end verification](07-end-to-end-verification.md)**.

---

### Checkpoint answers

1. Debezium serializes decimals as strings and timestamps as ISO strings. If the Kafka Engine table declared `amount` as `Decimal(18, 2)`, a malformed (or missing) field would crash consumption for the whole topic until the bad message expired. By using `String` everywhere, the Kafka Engine is as forgiving as possible; type-parsing happens in the Materialized View, where a bad row is an isolated failure rather than a pipeline stop.

2. It keeps the row with the highest `_source_ts_ms` value. If they have the same value (unlikely but possible), the engine picks one deterministically but you shouldn't rely on which. In practice `_source_ts_ms` comes from Postgres commit time and is monotonically increasing for a given row, so "highest wins" means "latest wins".

3. ReplacingMergeTree collapses duplicates only during background merges. A row that was just inserted (say, via an UPDATE that generated a CDC event identical-keyed to an existing row) sits alongside the old version until ClickHouse decides to merge those parts. `FINAL` forces a logical merge during the query — you see the dedup result. Without FINAL, you see the raw state, which can include transient duplicates.

4. ClickHouse would treat `clickhouse_transactions_v2` as a brand-new consumer group with no committed offsets. The default Kafka behavior for new groups (controlled by `auto.offset.reset`) is to start from the earliest offset — so it would re-read the entire topic from the beginning. In FinWatch that means re-inserting every CDC event, which ReplacingMergeTree would eventually deduplicate, but you'd see a large burst of work and temporary duplicates.
