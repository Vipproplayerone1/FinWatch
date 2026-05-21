# Chapter 04 — Debezium and CDC

## Why this matters

Postgres exposes changes through logical replication, but the format is Postgres-specific and binary. Something has to translate those changes into messages a generic streaming system (Kafka) can carry. That "something" is Debezium. It is the single component doing the hardest work in FinWatch: reading the WAL, parsing it, turning each change into a JSON event, and publishing that event to Kafka with strong durability guarantees.

By the end of this chapter you'll know what Debezium is (a Kafka Connect source connector), how it differs from older approaches to CDC, what every line in `finwatch-connector.json` does, how to register and restart it via REST, and how to read Debezium's own logs when it fails.

---

## Theory

### What CDC is (and what it isn't)

**Change Data Capture** is the pattern of observing inserts/updates/deletes in a source database and producing those changes as a stream of events. Two basic implementation approaches:

**1. Query-based CDC (poor).** Poll the source table every few seconds for rows where `updated_at > last_check`. Problems:
- Adds query load to the source
- Misses DELETEs entirely (a deleted row can't be SELECTed)
- Can miss rapid updates that happen between polls
- Requires `updated_at` column on every table

**2. Log-based CDC (good).** Read the database's internal change log (Postgres's WAL, MySQL's binlog, Oracle's redo log). Captures everything, no load on the source (the log is being written anyway), includes DELETEs. This is what Debezium does.

The tradeoff: log-based CDC is harder to build because you have to understand the internal log format of each database. Debezium hides that complexity behind a uniform interface.

### Kafka Connect in one paragraph

Debezium isn't a standalone program. It's a *connector plugin* for **Kafka Connect**, which is a framework (part of the Kafka ecosystem) for moving data between Kafka and other systems. Kafka Connect provides:

- A REST API for managing connectors
- Fault-tolerant worker processes that run connector tasks
- Persistent offset tracking (so connectors resume where they left off)
- Distributed execution (one connector, multiple worker nodes)

FinWatch runs one Kafka Connect worker (`finwatch-debezium`) with one connector (`finwatch-connector`). You register connectors by POSTing JSON to the worker's REST API.

### The Debezium event envelope

A change event from Debezium looks like this (before any transformations):

```json
{
  "schema": { ... },
  "payload": {
    "before": {
      "id": "abc-123",
      "balance": "1000.00"
    },
    "after": {
      "id": "abc-123",
      "balance": "900.00"
    },
    "source": {
      "version": "2.5",
      "name": "finwatch",
      "db": "finwatch",
      "schema": "public",
      "table": "accounts",
      "ts_ms": 1712345678901,
      "lsn": 47384729
    },
    "op": "u",
    "ts_ms": 1712345678903
  }
}
```

Key fields:

- `before` — the row as it was before the change (null for INSERT)
- `after` — the row as it is after (null for DELETE)
- `op` — `c` (create/insert), `u` (update), `d` (delete), `r` (read — from snapshot)
- `source` — metadata about where the event came from
- `ts_ms` at top level — when Debezium produced the event
- `source.ts_ms` — when the change happened at the source

This is powerful but verbose. Consumers often don't want the full envelope — they just want the row. That's what Single-Message Transforms fix.

### Single-Message Transforms (SMTs)

An SMT is a small transformation applied to each event as it passes through Kafka Connect. FinWatch uses one: `ExtractNewRecordState`, commonly called "unwrap". It replaces the full envelope with just the `after` field, flattened, and can add selected metadata as prefixed fields.

Before unwrap:

```json
{"before": {...}, "after": {"id": "abc", "balance": "900.00"}, "op": "u", ...}
```

After unwrap (with `add.fields=op,table,source.ts_ms`):

```json
{"id": "abc", "balance": "900.00", "__op": "u", "__table": "accounts", "__source_ts_ms": 1712345678901}
```

Much simpler for downstream consumers. ClickHouse's Kafka Engine, in particular, is much happier with flat records than with nested envelopes.

### How DELETEs are handled

When a row is deleted, there's no `after` state. Kafka-native behavior is to send a **tombstone** — a record with a key but null value. Tombstones are important for Kafka's log compaction feature but painful for most consumers.

FinWatch's SMT config handles this with two settings:

```json
"transforms.unwrap.drop.tombstones": "true",
"transforms.unwrap.delete.handling.mode": "rewrite",
```

- `drop.tombstones: true` — don't emit the classic null-value tombstone
- `delete.handling.mode: rewrite` — emit a normal message with the *before* state and a `__deleted: "true"` field

So downstream, a DELETE looks like:

```json
{"id": "abc", "balance": "900.00", "__op": "d", "__deleted": "true", ...}
```

ClickHouse can see the deletion happened, knows which row was deleted (by ID), and can decide what to do (ignore, mark deleted, etc.). Chapter 06 covers how we actually handle deletes in ClickHouse.

### Snapshot mode revisited

When a Debezium connector starts for the first time against a database, it has a choice:

| `snapshot.mode` | Behavior |
|---|---|
| `initial` | Snapshot once on first connection. Resume streaming on later restarts. **This is what FinWatch uses.** |
| `never` | Skip snapshot entirely. Start streaming from the current WAL position. (You lose historical data.) |
| `always` | Snapshot every time the connector starts. |
| `when_needed` | Snapshot only if the replication slot is gone or too far behind. |
| `exported` | Snapshot in a separate transaction to minimize locking. |

`initial` is almost always what you want. New ClickHouse instance? Point it at Kafka from the beginning of the topic and it'll see all snapshot events plus all streaming events. No extra config needed.

### Decimal handling — an honest digression

Postgres `DECIMAL(18, 2)` values don't map cleanly to Kafka Connect's schema types. Debezium gives three options:

| `decimal.handling.mode` | Wire format | Pros / cons |
|---|---|---|
| `precise` | Custom struct with scale + unscaled int64 bytes | Exact, but complex for consumers to parse |
| `double` | 64-bit floating point | Simple, but *lossy* — same problem as using FLOAT in the schema |
| `string` | Plain string like `"123.45"` | Simple, exact, slightly larger payload |

FinWatch uses `string`. Downstream, ClickHouse parses the string back into its own `Decimal(18, 2)` type in the materialized view. No precision is lost. Never use `double` for money.

---

## How it's used in FinWatch

### The connector config

Open `D:/Major/Graduate_Project/finwatch/debezium/connectors/finwatch-connector.json`. Walk through each section.

#### Identity and class

```json
"name": "finwatch-connector",
"connector.class": "io.debezium.connector.postgresql.PostgresConnector",
"tasks.max": "1",
```

- `name` — unique in this Connect worker. The REST API uses this name.
- `connector.class` — tells Kafka Connect which plugin to use. This one ships with the `debezium/connect:2.5` image.
- `tasks.max: 1` — Postgres logical replication from a single slot is inherently single-task. Setting this higher wouldn't help.

#### Database connection

```json
"database.hostname": "postgres",
"database.port": "5432",
"database.user": "debezium",
"database.password": "debezium_secret_2024",
"database.dbname": "finwatch",
```

Straightforward — credentials for the replication user created in the init SQL. The hostname is `postgres` (not `localhost`) because Debezium runs in a different container and reaches Postgres via the Docker network.

#### The CDC plumbing

```json
"topic.prefix": "finwatch",
"plugin.name": "pgoutput",
"slot.name": "finwatch_slot",
"publication.name": "finwatch_pub",
```

- `topic.prefix: "finwatch"` — Kafka topics will be named `finwatch.<schema>.<table>`, so `finwatch.public.transactions`, etc.
- `plugin.name: "pgoutput"` — use Postgres's built-in logical decoding plugin (vs alternatives like `wal2json`).
- `slot.name: "finwatch_slot"` — the name of the replication slot Debezium will create and reuse.
- `publication.name: "finwatch_pub"` — the publication defined in the init SQL.

These four values together say: "Connect to Postgres, use this slot+publication, output to Kafka topics prefixed with `finwatch.`"

#### What to capture

```json
"table.include.list": "public.accounts,public.merchants,public.transactions",
```

Explicit allow-list. If you add a fourth table, you must add it here *and* to the publication. Belt-and-suspenders, but it prevents accidentally streaming tables you didn't mean to.

#### Serialization

```json
"key.converter": "org.apache.kafka.connect.json.JsonConverter",
"key.converter.schemas.enable": "false",
"value.converter": "org.apache.kafka.connect.json.JsonConverter",
"value.converter.schemas.enable": "false",
```

All messages — keys and values — are JSON. `schemas.enable: false` means "don't embed the schema in every message" — that would double the payload size and we don't need it.

Alternative: Avro converters give you smaller binary messages with evolving schemas enforced automatically, but you'd need to deploy and operate a schema registry. FinWatch chose JSON for simplicity and debuggability — you can open a message in the internal Kafka browser at `http://localhost:3002/kafka` and read it with your eyes.

#### The SMT

```json
"transforms": "unwrap",
"transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
"transforms.unwrap.drop.tombstones": "true",
"transforms.unwrap.delete.handling.mode": "rewrite",
"transforms.unwrap.add.fields": "op,table,source.ts_ms",
```

This is the envelope-to-flat-row transform explained above. The `add.fields` config adds `__op`, `__table`, `__source_ts_ms` to each message — the only metadata the tutorial's ClickHouse layer needs. Add more if your downstream wants more.

#### Decimal and time handling

```json
"decimal.handling.mode": "string",
"time.precision.mode": "connect",
"tombstones.on.delete": "false",
```

- `decimal.handling.mode: "string"` — explained above.
- `time.precision.mode: "connect"` — use Kafka Connect's standard millisecond precision for timestamps. Alternative `adaptive_time_microseconds` gives microsecond precision; `connect` is usually fine.
- `tombstones.on.delete: "false"` — defense in depth with the SMT setting. No tombstones, no matter what.

#### Operations

```json
"heartbeat.interval.ms": "5000",
"snapshot.mode": "initial",
"errors.log.enable": "true",
"errors.log.include.messages": "true"
```

- `heartbeat.interval.ms: 5000` — every 5 seconds Debezium sends a no-op event to advance `confirmed_flush_lsn`. This is critical for idle databases — without heartbeats, if no one writes to your tables, the slot position never advances, and the WAL accumulates indefinitely.
- `snapshot.mode: initial` — see theory section.
- `errors.log.*` — verbose logging. Good for learning; in production you might send errors to a dead-letter queue instead.

### The Kafka Connect worker config (in docker-compose)

In `docker-compose.yml` under the `debezium` service:

```yaml
environment:
  GROUP_ID: finwatch-connect
  BOOTSTRAP_SERVERS: kafka:9092
  CONFIG_STORAGE_TOPIC: _finwatch_connect_configs
  OFFSET_STORAGE_TOPIC: _finwatch_connect_offsets
  STATUS_STORAGE_TOPIC: _finwatch_connect_status
  CONFIG_STORAGE_REPLICATION_FACTOR: 1
  OFFSET_STORAGE_REPLICATION_FACTOR: 1
  STATUS_STORAGE_REPLICATION_FACTOR: 1
  KEY_CONVERTER: org.apache.kafka.connect.json.JsonConverter
  VALUE_CONVERTER: org.apache.kafka.connect.json.JsonConverter
  KEY_CONVERTER_SCHEMAS_ENABLE: "false"
  VALUE_CONVERTER_SCHEMAS_ENABLE: "false"
```

- `GROUP_ID` — identifies this Connect cluster. All workers sharing this group cooperate.
- Three internal topics (`_finwatch_connect_configs`, `_offsets`, `_status`) — Kafka Connect stores its own state in Kafka itself. This is why connector registrations survive worker restarts: the config is in a Kafka topic, not on disk.
- Replication factor 1 — single-broker dev setup. In production this would be 3.

---

## Hands-on

### Step 1 — Check the Connect REST API is up

```bash
curl -s http://localhost:8083/
```

Expected:

```json
{"version":"3.6.0","commit":"...","kafka_cluster_id":"..."}
```

If you see `Connection refused`, check `docker compose ps debezium`. The container takes ~30 seconds to start.

### Step 2 — List connectors

```bash
curl -s http://localhost:8083/connectors
```

Expected after FinWatch has been registered:

```
["finwatch-connector"]
```

If you get `[]` (empty), the connector isn't registered. Register it (step 3).

### Step 3 — Register the connector manually (what `wait_for_services.py` does)

```bash
curl -X POST http://localhost:8083/connectors \
  -H "Content-Type: application/json" \
  -d @debezium/connectors/finwatch-connector.json
```

Expected (201 Created):

```json
{
  "name": "finwatch-connector",
  "config": { ... },
  "tasks": [],
  "type": "source"
}
```

If you get a 409 Conflict, the connector already exists. To update its config in place:

```bash
curl -X PUT http://localhost:8083/connectors/finwatch-connector/config \
  -H "Content-Type: application/json" \
  -d "$(cat debezium/connectors/finwatch-connector.json | python -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["config"]))')"
```

The PUT endpoint takes just the `config` sub-object, not the full file.

### Step 4 — Check connector status

```bash
curl -s http://localhost:8083/connectors/finwatch-connector/status | python -m json.tool
```

Expected (healthy):

```json
{
    "name": "finwatch-connector",
    "connector": {
        "state": "RUNNING",
        "worker_id": "172.18.0.5:8083"
    },
    "tasks": [
        {
            "id": 0,
            "state": "RUNNING",
            "worker_id": "172.18.0.5:8083"
        }
    ],
    "type": "source"
}
```

Both `connector.state` AND `tasks[0].state` must be `RUNNING`. A `connector.state: RUNNING` with `tasks[0].state: FAILED` means the connector is registered but can't do its job — look at task failure details (step 5).

### Step 5 — Get task failure details

If a task is in `FAILED` state:

```bash
curl -s http://localhost:8083/connectors/finwatch-connector/status | python -m json.tool
```

The failed task entry includes a `trace` field with the full Java stack trace. Read from the top of the trace for the actual exception.

Or check Debezium's logs directly:

```bash
docker compose logs debezium | tail -80
```

### Step 6 — List the topics Debezium created

```bash
docker exec finwatch-kafka kafka-topics --bootstrap-server kafka:9092 --list | grep finwatch
```

Expected:

```
finwatch.public.accounts
finwatch.public.merchants
finwatch.public.transactions
```

Plus the internal topics (`_finwatch_connect_configs`, etc.) if you remove the grep filter.

### Step 7 — Read one CDC message

Earlier we saw old snapshot messages might have expired from Kafka retention. To be safe, insert a fresh row and consume it:

In one terminal:

```bash
docker exec finwatch-kafka kafka-console-consumer \
  --bootstrap-server kafka:9092 \
  --topic finwatch.public.transactions \
  --max-messages 1 \
  --timeout-ms 15000
```

In another terminal:

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
INSERT INTO transactions (account_id, merchant_id, amount, type, status, description)
SELECT
    (SELECT id FROM accounts LIMIT 1),
    (SELECT id FROM merchants LIMIT 1),
    99.00, 'purchase', 'completed', 'Chapter 04 test';
"
```

The consumer terminal should print one JSON message within a few seconds:

```json
{"id":"...","account_id":"...","merchant_id":"...","amount":"99.00","currency":"VND","type":"purchase","status":"completed","description":"Chapter 04 test","metadata":"{}","ip_address":null,"device_id":null,"created_at":"2026-...Z","updated_at":"2026-...Z","__deleted":"false","__op":"c","__table":"transactions","__source_ts_ms":1712345678901}
```

Field by field:
- The payload is a flat object (SMT worked)
- `__op: "c"` means create (INSERT)
- `__table: "transactions"` tells a downstream consumer which table
- `__source_ts_ms` is when Postgres committed
- `__deleted: "false"` is added by the rewrite mode — always "false" for INSERT/UPDATE

### Step 8 — Trigger an UPDATE and watch

```bash
# In the consumer terminal:
docker exec finwatch-kafka kafka-console-consumer \
  --bootstrap-server kafka:9092 \
  --topic finwatch.public.transactions \
  --max-messages 1 --timeout-ms 15000

# In another terminal:
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
UPDATE transactions
SET status = 'flagged'
WHERE description = 'Chapter 04 test';
"
```

The consumer will print a message with `__op: "u"` and the row's new state (status = 'flagged'). Notice the `updated_at` timestamp is now different — the trigger advanced it.

### Step 9 — Trigger a DELETE

```bash
# Consumer:
docker exec finwatch-kafka kafka-console-consumer \
  --bootstrap-server kafka:9092 \
  --topic finwatch.public.transactions \
  --max-messages 1 --timeout-ms 15000

# In another terminal:
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
DELETE FROM transactions WHERE description = 'Chapter 04 test';
"
```

The message has `__op: "d"` and `__deleted: "true"`. The payload contains the row's *last known state* (because of `delete.handling.mode: rewrite`) — all fields are populated from the row before it was deleted.

### Step 10 — Restart the connector

Two ways to restart:

**Restart just the tasks** (safer, faster):

```bash
curl -X POST http://localhost:8083/connectors/finwatch-connector/restart?includeTasks=true
```

**Delete and re-register** (nuclear option — will re-snapshot if the slot doesn't exist):

```bash
curl -X DELETE http://localhost:8083/connectors/finwatch-connector
# ... wait a few seconds ...
curl -X POST http://localhost:8083/connectors \
  -H "Content-Type: application/json" \
  -d @debezium/connectors/finwatch-connector.json
```

Note: the replication slot `finwatch_slot` in Postgres *persists even if you delete the Debezium connector*. You have to drop the slot manually if you want a truly fresh start:

```sql
SELECT pg_drop_replication_slot('finwatch_slot');
```

---

## Checkpoints

1. Why does Debezium run inside Kafka Connect rather than as a standalone process?
2. What's the difference between `snapshot.mode: initial` and `snapshot.mode: always`?
3. If you wanted to stream changes from a fourth Postgres table called `fraud_alerts`, what are the two places you'd need to update?
4. A DELETE event shows up in Kafka with `__op: "d"` and `__deleted: "true"`. Where did the field values in the payload come from — the row as it existed before the DELETE, or the (non-existent) post-DELETE state?

(Answers at the bottom.)

---

## Troubleshooting

**Problem:** `curl http://localhost:8083/connectors` times out or refuses connection.
**Cause:** Debezium container not running, or not finished booting.
**Fix:**

```bash
docker compose ps debezium
docker compose logs debezium | tail -50
```

If you see `Failed to start Connect worker`, something's misconfigured — check `docker-compose.yml` for typos in env vars.

---

**Problem:** Connector status shows `state: FAILED` with trace mentioning `could not open publication`.
**Cause:** The `finwatch_pub` publication doesn't exist in Postgres (perhaps Postgres was wiped after connector registration).
**Fix:**

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SELECT * FROM pg_publication;"
```

If empty, recreate:

```sql
CREATE PUBLICATION finwatch_pub FOR TABLE accounts, merchants, transactions;
```

Then restart the connector: `curl -X POST http://localhost:8083/connectors/finwatch-connector/restart`.

---

**Problem:** Connector starts, but Kafka topics aren't appearing.
**Cause:** Usually `table.include.list` doesn't match any existing tables, or `topic.prefix` is missing.
**Fix:** Double-check `table.include.list` uses full `schema.table` names like `public.transactions`, not just `transactions`.

---

**Problem:** CDC events stop flowing suddenly; connector status is still `RUNNING`.
**Cause:** Frequent culprit — `confirmed_flush_lsn` isn't advancing, often because a consumer of an internal topic (the Connect offset topic) is stuck.
**Fix:**

```bash
docker compose logs debezium | grep -i "heartbeat\|lsn\|slot"
```

Usually restarting the connector clears it:

```bash
curl -X POST http://localhost:8083/connectors/finwatch-connector/restart?includeTasks=true
```

If problem persists, take a full connector restart (step 10 above), but note: if the Postgres slot has fallen too far behind, you may need to re-snapshot.

---

**Problem:** You inserted a transaction and nothing showed up in Kafka, but `pg_replication_slots` says `active = t`.
**Cause:** Your insert might have been into a table not in `finwatch_pub`, or the INSERT was rolled back.
**Fix:** Confirm the table:

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
SELECT pubname, schemaname, tablename FROM pg_publication_tables WHERE pubname = 'finwatch_pub';
"
```

Only tables listed there stream. If `accounts/merchants/transactions` is missing, the publication is broken.

---

## Where to go next

You now understand how changes become Kafka messages. Next, you'll zoom into Kafka itself — what topics, partitions, and offsets really are, and how to watch CDC events flow in real time.

Next: **[Chapter 05 — Kafka: the streaming backbone](05-kafka-streaming.md)**.

---

### Checkpoint answers

1. Kafka Connect provides built-in fault tolerance (offsets stored in Kafka topics, automatic task restarts), distributed execution, and a uniform REST API that works for any connector. Reinventing those in a standalone process would duplicate a lot of Kafka Connect. Running Debezium as a Connect plugin gets all of that for free.

2. `initial` snapshots once — on first connection to a new database when the slot doesn't exist yet. On subsequent restarts it resumes from the slot's saved position (incremental streaming). `always` re-snapshots every single time the connector starts, which for a large table is very expensive and usually sends duplicates downstream.

3. (a) Add it to the publication: `ALTER PUBLICATION finwatch_pub ADD TABLE fraud_alerts;` (b) Add it to `table.include.list` in the connector config: `"table.include.list": "public.accounts,public.merchants,public.transactions,public.fraud_alerts"`, then POST to `/connectors/finwatch-connector/config` to update. (Optional but often desirable: restart the connector so it picks up immediately.)

4. The payload contains the row's *pre-DELETE* state — the `before` field in the raw envelope. With `delete.handling.mode: rewrite`, the SMT takes that `before` state, flattens it, and adds `__deleted: "true"`. So downstream you can tell *which row* was deleted (by primary key), and *what its values were* at the moment of deletion.
