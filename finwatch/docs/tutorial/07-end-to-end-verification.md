# Chapter 07 — End-to-end verification

## Why this matters

Each of the previous chapters focused on one stage. This chapter focuses on the *handoffs between stages* — the places the pipeline can silently break. You'll trace a single row from `psql INSERT` all the way to a ClickHouse query, confirm the data is identical at every hop, and measure how long each hop takes. When something goes wrong in the pipeline in the future, this chapter is the recipe for diagnosing *where*.

By the end of this chapter you'll be fluent in the end-to-end path, able to explain exactly what happens when a row is inserted, updated, or deleted, and able to quickly pinpoint which component is causing a problem.

---

## Theory

### The handoffs (and their failure modes)

```
 Postgres ──(WAL)──▶ Debezium ──(Kafka)──▶ Kafka Engine ──(MV)──▶ Target Table
     ▲                    ▲                    ▲                       ▲
     │                    │                    │                       │
  commit             replication         consumer group            background
  timestamp             slot             offset                    merges
```

Each arrow is a potential silent failure. Knowing what to check at each arrow is what distinguishes someone who has operated a pipeline from someone who has only built one.

| Handoff | What "works" looks like | What "broken" looks like |
|---|---|---|
| Postgres → Debezium (WAL) | `pg_replication_slots` shows slot active; `confirmed_flush_lsn` advances | Slot inactive, or lag in bytes growing |
| Debezium → Kafka (produce) | Topic offset grows shortly after Postgres write | Connector in FAILED state; topic offset stuck |
| Kafka → Kafka Engine (consume) | `system.kafka_consumers` shows assignments, group lag small | Empty consumers table, or lag growing |
| Kafka Engine → MV → Target (insert) | Row visible in target table (with FINAL) | Rows in Kafka Engine but not in target |

### Two kinds of latency

**End-to-end latency** = (time the row is queryable in ClickHouse) − (time Postgres committed the INSERT). For FinWatch, target is under 5 seconds per the thesis's performance targets. In a healthy lab environment you'll see 50–300 milliseconds.

**Per-stage latency** helps isolate issues:

- Postgres commit → Kafka message delivered = *Debezium latency* (WAL read + SMT transform + Kafka produce)
- Kafka delivered → ClickHouse target insert = *ClickHouse ingestion latency* (Kafka Engine poll + MV execution + MergeTree write)

### Verifying data integrity (not just presence)

"A row appeared in ClickHouse" is not the same as "the right row appeared". Integrity check:

- IDs match
- Amounts match (Decimal precision preserved)
- Timestamps match (timezone-aware)
- CDC op is correctly `c`/`u`/`d`
- For DELETEs: `__deleted` flag is set

---

## Hands-on

Make sure the full pipeline is up:

```bash
cd D:/Major/Graduate_Project/finwatch
docker compose up -d postgres zookeeper kafka debezium clickhouse
```

Wait for every service healthy:

```bash
docker compose ps --format "table {{.Name}}\t{{.Status}}"
```

And confirm the Debezium connector is RUNNING:

```bash
curl -s http://localhost:8083/connectors/finwatch-connector/status | python -m json.tool
```

---

### Part 1: INSERT — trace one row through every stage

Let's use a unique marker so we can find this row anywhere.

```bash
MARKER=$(date +%s%N)
echo "Marker: $MARKER"
```

(On Windows Git Bash, this gives you a nanosecond-precision integer. On PowerShell, use `[DateTime]::Now.Ticks`.)

#### Step 1 — Insert in Postgres and capture timestamps

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
INSERT INTO transactions (account_id, merchant_id, amount, type, status, description)
SELECT
    (SELECT id FROM accounts WHERE email='nguyenvana@email.com'),
    (SELECT id FROM merchants WHERE name='VinMart'),
    987654.32,
    'purchase',
    'completed',
    'E2E test $MARKER'
RETURNING
    id,
    amount,
    description,
    EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms;
"
```

Capture the UUID printed in the `id` column. Call it `$TXN_ID`. Capture `created_at_ms`.

#### Step 2 — Check Postgres WAL LSN advanced

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
SELECT
    slot_name,
    confirmed_flush_lsn,
    pg_current_wal_lsn() AS current_wal_lsn,
    pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes
FROM pg_replication_slots
WHERE slot_name = 'finwatch_slot';
"
```

`lag_bytes` should be small (usually under a few KB). If it's growing without bound, Debezium is stuck.

#### Step 3 — Check the Kafka topic received the message

```bash
docker exec finwatch-kafka kafka-console-consumer \
  --bootstrap-server kafka:9092 \
  --topic finwatch.public.transactions \
  --offset latest \
  --partition 0 \
  --max-messages 1 --timeout-ms 5000
```

Wait — this shows "latest" messages, but since we just inserted, we want to see the recent one. Easier: consume from a rewound position or let `--from-beginning` run after filtering by description.

Alternative: use the internal Kafka browser at http://localhost:3002/kafka, click `finwatch.public.transactions`, browse messages and find yours by description.

For a command-line approach, use a script that filters by description:

```bash
docker exec finwatch-kafka kafka-console-consumer \
  --bootstrap-server kafka:9092 \
  --topic finwatch.public.transactions \
  --from-beginning \
  --timeout-ms 10000 | grep "E2E test $MARKER"
```

(Slow for big topics — works for recent messages.)

You should see one JSON line with your description. Extract `__source_ts_ms` from it (you can eyeball it or use `jq` if installed). Call it `$KAFKA_SOURCE_TS`.

#### Step 4 — Check ClickHouse target table

```bash
docker exec finwatch-clickhouse clickhouse-client --database=finwatch -q "
SELECT
    id,
    amount,
    description,
    cdc_op,
    _source_ts_ms,
    toUnixTimestamp64Milli(_ingested_at) AS ingested_at_ms
FROM transactions FINAL
WHERE description = 'E2E test $MARKER'
FORMAT Vertical
"
```

Expected (all values should match what you inserted):

```
Row 1:
──────
id:              <the UUID from step 1>
amount:          987654.32
description:     E2E test <your marker>
cdc_op:          c
_source_ts_ms:   <close to created_at_ms from step 1>
ingested_at_ms:  <slightly higher than _source_ts_ms>
```

If `cdc_op = 'r'` instead of `'c'`, Debezium's snapshot was still running when this INSERT happened — the `r` means "row read from snapshot", but the value itself is the same. Usually `c` for a live INSERT.

#### Step 5 — Compute per-stage latencies

From the data you've collected:

- `A` = Postgres commit time (from `created_at_ms` in step 1)
- `B` = CDC event's source time (from `__source_ts_ms` in Kafka, or `_source_ts_ms` in ClickHouse)
- `C` = ClickHouse ingested time (`_ingested_at` in step 4, converted to ms)

Usually `A ≈ B` (Debezium's source.ts_ms is set to the Postgres commit time). `C - A` is the end-to-end latency.

Quick script:

```sql
-- Run in ClickHouse
SELECT
    description,
    _source_ts_ms AS source_ts_ms,
    toUnixTimestamp64Milli(_ingested_at) AS ingested_ms,
    toUnixTimestamp64Milli(_ingested_at) - _source_ts_ms AS e2e_latency_ms
FROM transactions FINAL
WHERE description = 'E2E test $MARKER';
```

For a lab environment, expect `e2e_latency_ms` in the range 30–300 ms. If it's above 1000 ms, something's backlogged.

---

### Part 2: UPDATE — confirm `__op: "u"` flows through

#### Step 1 — Update in Postgres

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
UPDATE transactions
SET status = 'flagged',
    amount = 100.00
WHERE description = 'E2E test $MARKER'
RETURNING id, amount, status, updated_at;
"
```

#### Step 2 — Check ClickHouse reflects the update

```bash
docker exec finwatch-clickhouse clickhouse-client --database=finwatch -q "
SELECT
    id,
    amount,
    status,
    cdc_op,
    _source_ts_ms
FROM transactions FINAL
WHERE description = 'E2E test $MARKER'
FORMAT Vertical
"
```

Expected:
- `amount: 100.00` (the new value)
- `status: flagged`
- `cdc_op: u` (update)
- `_source_ts_ms` higher than it was before (new commit timestamp)

Because the target table is ReplacingMergeTree and uses `_source_ts_ms` as the version, FINAL returns the newest version — which is this update. The original INSERT row isn't returned (even though it's still physically on disk until the next merge).

#### Step 3 — Confirm the old row still exists before merge

Without FINAL:

```sql
SELECT id, amount, status, cdc_op, _source_ts_ms
FROM transactions
WHERE description = 'E2E test $MARKER'
ORDER BY _source_ts_ms;
```

You may see two rows (the original INSERT and the UPDATE). Or you may see just the UPDATE, if merges already ran. Both are correct states.

---

### Part 3: DELETE — confirm `__op: "d"` and the rewrite

#### Step 1 — Delete in Postgres

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
DELETE FROM transactions WHERE description = 'E2E test $MARKER';
"
```

#### Step 2 — Check what's in ClickHouse

```bash
docker exec finwatch-clickhouse clickhouse-client --database=finwatch -q "
SELECT
    id,
    amount,
    status,
    cdc_op,
    _source_ts_ms
FROM transactions FINAL
WHERE description = 'E2E test $MARKER'
FORMAT Vertical
"
```

Expected — a single row with `cdc_op: d` — the delete event, carrying the row's pre-delete state (thanks to `delete.handling.mode: rewrite`).

#### Step 3 — Intentional behavior: the row is not actually removed from ClickHouse

This is a key FinWatch design decision. ClickHouse keeps the `cdc_op: d` row forever (or until you explicitly filter it out). This lets you:

- Audit deleted transactions
- Detect unusual delete patterns (maybe someone's wiping their tracks)
- Recover from accidental deletes (the data's still there)

Queries that should exclude deletes simply filter `WHERE cdc_op != 'd'`. Look at `clickhouse/queries/*.sql` — every query that cares uses this filter.

If you wanted to actually delete the row from ClickHouse, you'd need an explicit `DELETE FROM finwatch.transactions WHERE ...` or an ALTER TABLE DELETE. That's a lightweight delete in ClickHouse, not free — columns are re-written. Use sparingly.

---

### Part 4: measure end-to-end latency at scale

You've seen one row's journey. Now measure the aggregate latency of many.

Use the benchmark script:

```bash
conda activate C:\ProgramData\miniconda3\envs\graduate_env
cd D:/Major/Graduate_Project/finwatch
python scripts/benchmark_latency.py --samples 20
```

This inserts 20 marker rows in Postgres and polls ClickHouse for each to appear, recording the latency. Typical output:

```
  ✅ Sample 1: E2E = 145 ms (PG insert: 8 ms, Pipeline: 137 ms)
  ✅ Sample 2: E2E = 98 ms ...
  ...
📊 Results (20/20 successful):
   Min:    85 ms
   Max:    412 ms
   Avg:    176 ms
   Median: 158 ms
   P95:    370 ms

   🎯 Within 5000ms target: 20/20 (100%)
```

The `<5000ms target` is the thesis's performance claim. Healthy lab runs beat it by 10–50x.

---

### Part 5: measure throughput

How many transactions per second can you pump through? Use the other script:

```bash
python scripts/benchmark_throughput.py --total 10000 --batch-size 100
```

This inserts 10,000 transactions in batches of 100, as fast as Postgres accepts them. You're measuring Postgres's write speed, not the pipeline's — but check ClickHouse after to confirm they all arrived:

```bash
docker exec finwatch-clickhouse clickhouse-client --database=finwatch -q "
SELECT
    countIf(description = 'throughput-test') AS arrived
FROM transactions FINAL
WHERE description = 'throughput-test'
  AND _ingested_at >= now() - INTERVAL 5 MINUTE
"
```

If this matches 10,000, the pipeline kept up. If lower, check the consumer group lag:

```bash
docker exec finwatch-kafka kafka-consumer-groups \
  --bootstrap-server kafka:9092 \
  --describe --group clickhouse_transactions
```

A lag that's decreasing is fine — ClickHouse is catching up. A lag that keeps growing means the pipeline is not keeping up with the write rate, and you'd need to investigate (ClickHouse throughput, network, Kafka consumer config).

---

### Part 6: simulated failure drills

These drills teach you how the pipeline behaves when components fail, and how to recover.

#### Drill A: kill ClickHouse mid-stream

```bash
# Terminal 1: produce steady load
python scripts/generate_transactions.py --count 2000 --tps 50

# Terminal 2: kill ClickHouse
docker compose stop clickhouse
# Wait 10 seconds
docker compose start clickhouse
# Wait for healthy
docker compose ps clickhouse
```

During the outage, Kafka keeps accumulating messages. The `clickhouse_transactions` consumer group's lag grows. When ClickHouse restarts, it resumes from its committed offset and catches up. No data is lost.

Verify:

```bash
# Should eventually show ~2000 rows
docker exec finwatch-clickhouse clickhouse-client --database=finwatch -q "
SELECT count() FROM transactions FINAL
WHERE description LIKE '%Auto-generated%'
  AND created_at >= now() - INTERVAL 10 MINUTE
"
```

#### Drill B: kill Debezium mid-stream

```bash
# Terminal 1: load
python scripts/generate_transactions.py --count 2000 --tps 50

# Terminal 2:
docker compose stop debezium
# Wait 10 seconds, note Postgres's slot:
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
SELECT slot_name, active, confirmed_flush_lsn
FROM pg_replication_slots;
"
# active should be 'f' (false)

# Restart:
docker compose start debezium
# Wait for healthy, then:
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
SELECT slot_name, active, confirmed_flush_lsn
FROM pg_replication_slots;
"
# active should be 't' (true) again
```

During the outage, Debezium isn't consuming the WAL. Postgres holds the WAL for it (until `max_slot_wal_keep_size` is hit, which we haven't set — unbounded retention). When Debezium restarts, it resumes from its slot's position.

#### Drill C: the scary one — kill Postgres mid-stream

```bash
docker compose stop postgres
# ... wait ...
docker compose start postgres
```

Debezium detects the disconnection, retries, and reconnects. The replication slot state was persisted to Postgres's disk, so it survives the restart. No slot needs to be recreated.

All three drills pass because the pipeline is loosely coupled via Kafka and Postgres's durable WAL + replication slot. This is the architectural payoff.

---

## Checkpoints

1. When a row is INSERTed in Postgres, which of `_source_ts_ms`, `_ingested_at`, and `updated_at` comes from Postgres, and which is set by ClickHouse?
2. After a DELETE in Postgres, why does the row still appear in `finwatch.transactions FINAL`?
3. If ClickHouse is down for an hour and Postgres receives 10,000 new INSERTs during that hour, where does the data live until ClickHouse comes back?
4. You run `SELECT count() FROM transactions` (no FINAL) and get 1,000,000. Then you run it again and get 999,983. How is this possible?

(Answers at the bottom.)

---

## Troubleshooting

**Problem:** You inserted in Postgres, the row appears in Kafka, but it's not in ClickHouse.
**Cause:** Materialized View broken, or Kafka Engine stalled, or target table missing.
**Fix:** Walk the chain bottom-up. Check the MV exists:

```sql
SHOW CREATE TABLE finwatch.transactions_mv;
```

Check the Kafka Engine has active consumers:

```sql
SELECT database, table, assignments FROM system.kafka_consumers;
```

Check ClickHouse's error log for recent errors:

```sql
SELECT event_time, message FROM system.errors ORDER BY event_time DESC LIMIT 10;
```

Or at the container level:

```bash
docker compose logs clickhouse | tail -50
```

If the Kafka engine itself is fine but the MV errors during parsing (e.g., a bad timestamp), you'll see those errors here.

---

**Problem:** End-to-end latency is suddenly in seconds instead of milliseconds.
**Cause:** One of Kafka Engine's `max_block_size` batching, Postgres slot lag, Debezium slow, or ClickHouse slow.
**Fix:** Check each stage's queue:

```bash
# Postgres → Debezium
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
SELECT slot_name, pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes
FROM pg_replication_slots;
"

# Debezium → Kafka is instant; check Kafka → ClickHouse
docker exec finwatch-kafka kafka-consumer-groups \
  --bootstrap-server kafka:9092 --describe --group clickhouse_transactions
```

The stage with the biggest lag is where you look. Then dive into logs.

---

**Problem:** After a DELETE in Postgres, you see the row in ClickHouse with `cdc_op = 'd'` — but then a *later* query returns the row with `cdc_op != 'd'`.
**Cause:** A new INSERT with a similar description happened after the DELETE, and your query matches both.
**Fix:** Filter more precisely (by id, not description), or add `WHERE cdc_op != 'd'` if you're counting "live" rows.

---

**Problem:** After restarting Debezium, the connector is in `RUNNING` state but no new messages appear in Kafka.
**Cause:** Rare — usually a Kafka Connect internal topic issue.
**Fix:**

```bash
docker compose logs debezium | grep -i "error\|warn" | tail -30
```

If you see "Failed to establish connection to Kafka", restart debezium and kafka together:

```bash
docker compose restart kafka
docker compose restart debezium
```

---

## Where to go next

You've proven the whole pipeline works end-to-end and you know how to diagnose it. One piece remains — putting the data in front of humans. The final chapter covers dashboards.

Next: **[Chapter 08 — Dashboards: Grafana](08-dashboards-grafana.md)**.

---

### Checkpoint answers

1. `_source_ts_ms` comes from Postgres's commit time (Debezium reads it from the WAL). `updated_at` also comes from Postgres — the trigger on UPDATE sets it to `NOW()` at commit time. `_ingested_at` is set by ClickHouse via `DEFAULT now64(3)` when the MV writes into the target table — so it reflects "when ClickHouse finished processing this row". The difference between `_source_ts_ms` and `_ingested_at` gives you the downstream latency (Kafka + ClickHouse stages).

2. Because FinWatch chose not to physically delete rows in ClickHouse. The DELETE in Postgres becomes a `cdc_op = 'd'` row with the row's pre-delete state preserved (via `delete.handling.mode: rewrite`). `FINAL` returns this row like any other. Queries that want to exclude deletes filter `WHERE cdc_op != 'd'`. The design choice is auditable deletes — you can always see what was deleted.

3. In Kafka. Debezium keeps producing to the topic (since it and Kafka are up). The topic retains messages for 7 days by default. The ClickHouse consumer group's offset doesn't advance during the outage, but Kafka doesn't care — it keeps the messages. When ClickHouse comes back, it resumes from its saved offset and catches up. This is Kafka's role as a buffer.

4. Background merges happened between the two queries. A `ReplacingMergeTree` with duplicates can shrink in row count when merges run (duplicates are collapsed). The first query saw 1,000,000 rows, many of which were un-merged duplicates; the second query, a few seconds later, saw the post-merge state. Without FINAL, counts are never reliable on a ReplacingMergeTree.
