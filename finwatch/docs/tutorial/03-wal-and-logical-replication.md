# Chapter 03 — WAL and logical replication

## Why this matters

Everything you learn about Change Data Capture (chapter 04), Kafka (chapter 05), and ClickHouse (chapter 06) rests on what this chapter teaches. The WAL is the thing that makes CDC possible. Without understanding it, Debezium feels like magic; with it, Debezium feels obvious.

This is the chapter where you understand *how* Postgres durably records every change, why that same mechanism can be co-opted to stream changes to other systems in real time, and what the ten lines of `postgresql.conf` actually do. It's also the chapter that teaches you how to diagnose the number-one failure mode of a CDC pipeline: a replication slot that grows unbounded and fills up your disk.

---

## Theory

### The problem the WAL solves

Imagine Postgres just wrote every UPDATE directly to the data files on disk. If the server crashes halfway through writing, you get a corrupt row — half the old version, half the new. Recovery is impossible; the database is broken.

The fix is the **Write-Ahead Log** (WAL). Before Postgres writes any change to the table data files, it first writes a record describing that change to the WAL. Only after the WAL record is safely on disk (`fsync`'d) does Postgres tell the client "your COMMIT succeeded" and start applying the change to the data files.

If Postgres crashes, on restart it:

1. Reads the WAL from the last checkpoint forward
2. Replays every committed change
3. Ignores uncommitted changes

The data files end up in a consistent state. This is **durability** — the 'D' in ACID. The WAL is how Postgres keeps its promise.

### The WAL's second life: replication

Postgres engineers noticed: the WAL already describes every change to the database. If you could stream the WAL to another Postgres server, that server could replay the changes and stay in sync. This is **replication**.

There are two flavors:

- **Physical replication** — ship the raw WAL bytes to a second Postgres. The second server is a binary clone. Fast, simple, but tightly coupled: both servers must run the same Postgres version, the same schema, the same OS architecture.
- **Logical replication** — decode the WAL into logical row changes (INSERT these columns, UPDATE these columns) and ship *those*. Slower, more CPU-intensive, but flexible: the receiver doesn't have to be Postgres, doesn't have to have the same schema, can subscribe to only specific tables.

CDC tools like Debezium use **logical replication**. The receiver isn't another Postgres — it's Kafka. The logical change events are what eventually become JSON messages on a Kafka topic.

### The players in logical replication

Four concepts you need to keep straight:

**1. WAL level.** Postgres has three WAL verbosity modes:
- `minimal` — enough to recover a crash, not enough to replicate
- `replica` — enough for physical replication
- `logical` — enough for logical decoding

For CDC you need `wal_level = logical`. This forces Postgres to include extra info (primary keys, full before/after row images for some operations) in every WAL record. It costs a little disk and CPU.

**2. Output plugin.** Raw WAL is binary and Postgres-specific. An *output plugin* decodes it into a format consumers can understand. Postgres ships with `pgoutput`, the default logical decoding plugin since Postgres 10. Debezium uses it. Other plugins exist (`wal2json`, `decoderbufs`), but `pgoutput` is the mainstream choice.

**3. Publication.** A named list of tables that should be published to logical consumers. FinWatch creates one:

```sql
CREATE PUBLICATION finwatch_pub FOR TABLE accounts, merchants, transactions;
```

This tells Postgres: "when logical consumers subscribe to `finwatch_pub`, send them changes to these three tables, and only these three." You can have multiple publications, each with different table sets, for different consumers.

**4. Replication slot.** A server-side persistent cursor into the WAL. Each logical consumer (Debezium is one) gets a slot. The slot records *how far into the WAL that consumer has acknowledged*. Postgres uses this to decide which WAL files it can delete.

Crucial point: **Postgres does not delete WAL files past the oldest active slot.** If Debezium goes down and never comes back, the slot stays at its position forever, and the WAL grows forever, and eventually Postgres crashes because the disk is full.

### The LSN — Log Sequence Number

Every record in the WAL has an LSN — a monotonically increasing 64-bit number expressed as two hex chunks like `0/1A3F5B8`. Think of it as an offset into the whole WAL. You can subtract LSNs to measure how far behind a replica is. The CDC world talks in LSNs the same way file systems talk in byte offsets.

```
 WAL as a growing file:
     ┌────────────────────────────────────────────┐
     │ ...INSERT...UPDATE...COMMIT...DELETE...    │
     └────────────────────────────────────────────┘
                                 ▲
                     0/1A3F5B8  (LSN — current write position)
                         ▲
                     0/1A3F500  (slot's confirmed position — WAL before this can be deleted)
```

The difference (`0/1A3F5B8` - `0/1A3F500` = 184 bytes) is the **replication lag**. Chapter 05 will show you how to measure this.

### Snapshot, then stream

When Debezium starts up for the first time against a table:

1. **Snapshot phase.** It runs a `SELECT *` on each table in the publication to capture the current state, and sends each existing row as an "initial" event to Kafka.
2. **Streaming phase.** It opens the replication slot and starts receiving WAL events for every subsequent change.

Both phases produce events with the same shape downstream — Kafka consumers can't tell a snapshot row from a streaming row (unless they look at metadata). This is important: it means you can spin up a new ClickHouse instance against an existing Postgres and get the full history by replaying the topic.

---

## How it's used in FinWatch

### The Postgres config

Open `D:/Major/Graduate_Project/finwatch/postgres/postgresql.conf`:

```ini
# Network — listen on all interfaces for Docker networking
listen_addresses = '*'

# WAL Configuration for CDC
wal_level = logical
max_replication_slots = 4
max_wal_senders = 4
wal_keep_size = 1024   # MB

# Logging
log_statement = 'mod'
log_replication_commands = on

# Performance
shared_buffers = 256MB
work_mem = 16MB
```

Line by line:

| Setting | What it does | Why this value |
|---|---|---|
| `listen_addresses = '*'` | Accept connections from any network interface | Debezium (running in another container) needs to reach Postgres |
| `wal_level = logical` | Include the extra info needed for logical decoding | Without this, CDC is impossible — full stop |
| `max_replication_slots = 4` | How many logical consumers can subscribe simultaneously | FinWatch only has one (Debezium), but 4 gives headroom |
| `max_wal_senders = 4` | How many WAL-sending processes can run | One per active slot, plus buffer |
| `wal_keep_size = 1024` (MB) | Minimum WAL size to retain even without a slot | Safety buffer — if a slot disappears briefly, there's WAL for it to reconnect to |
| `log_statement = 'mod'` | Log every INSERT/UPDATE/DELETE | Helpful for learning; would be expensive in production |
| `log_replication_commands = on` | Log replication protocol traffic | Helpful for debugging CDC issues |

Settings that are *not* there but you should know exist:
- `max_slot_wal_keep_size` — a cap on how much WAL a slot can hold back. Setting it prevents runaway disk growth but can break replication if the consumer falls too far behind. Trade-off. Leaving it unset (as here) means unbounded — safer for data, riskier for disk.

### The publication (from chapter 02)

From `postgres/init/01_init_schema.sql`:

```sql
CREATE ROLE debezium WITH LOGIN PASSWORD 'debezium_secret_2024' REPLICATION;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO debezium;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO debezium;

CREATE PUBLICATION finwatch_pub FOR TABLE accounts, merchants, transactions;
```

- The `debezium` role has `REPLICATION` — this is what lets it open a slot.
- `SELECT` on tables is needed for the **snapshot phase**.
- The publication is scoped to exactly the three tables we care about. Any other table you create (user preferences, audit logs, whatever) won't be streamed unless you add it to the publication.

### The slot (created by Debezium, not the init script)

The replication slot is created *by Debezium* when the connector starts. FinWatch's connector config (you'll see this in chapter 04) names it:

```json
"slot.name": "finwatch_slot"
```

So after Debezium has started once, `SELECT * FROM pg_replication_slots` will show `finwatch_slot` in the active state.

---

## Hands-on

Make sure the stack is running per chapter 01:

```bash
conda activate C:\ProgramData\miniconda3\envs\graduate_env
cd D:/Major/Graduate_Project/finwatch
docker compose up -d postgres zookeeper kafka debezium
```

### Step 1 — Confirm `wal_level = logical`

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "SHOW wal_level;"
```

Expected:

```
 wal_level
-----------
 logical
```

If you see `replica` or `minimal`, CDC cannot work. Check that `postgres/postgresql.conf` has the right line and that `docker-compose.yml` mounts it at `/etc/postgresql/postgresql.conf`.

### Step 2 — List all replication slots

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
SELECT
    slot_name,
    plugin,
    slot_type,
    active,
    active_pid,
    restart_lsn,
    confirmed_flush_lsn
FROM pg_replication_slots;
"
```

Expected (assuming Debezium registered):

```
   slot_name   |  plugin  | slot_type | active | active_pid | restart_lsn | confirmed_flush_lsn
---------------+----------+-----------+--------+------------+-------------+---------------------
 finwatch_slot | pgoutput | logical   | t      |     12345  | 0/1A3F500   | 0/1A3F500
```

Meanings:
- `plugin = pgoutput` → the logical decoding plugin (the one Debezium asked for)
- `slot_type = logical` → it's a logical slot, not physical
- `active = t` → there's a live consumer (Debezium)
- `active_pid` → Postgres process serving that consumer
- `restart_lsn` → the earliest WAL position Postgres still needs to keep for this slot
- `confirmed_flush_lsn` → the position the consumer confirmed it has processed

If `active = f` (false) and Debezium is meant to be running, Debezium is not connected. Check `docker compose logs debezium`.

### Step 3 — Look at the publication

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
SELECT
    pubname,
    puballtables,
    pubinsert,
    pubupdate,
    pubdelete,
    pubtruncate
FROM pg_publication;
"
```

Expected:

```
   pubname    | puballtables | pubinsert | pubupdate | pubdelete | pubtruncate
--------------+--------------+-----------+-----------+-----------+-------------
 finwatch_pub | f            | t         | t         | t         | t
```

- `puballtables = f` → not all tables, only the ones we named
- `pubinsert/update/delete/truncate = t` → all four operation types are published

Which tables specifically?

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
SELECT pubname, schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'finwatch_pub';
"
```

Expected:

```
   pubname    | schemaname |  tablename
--------------+------------+--------------
 finwatch_pub | public     | accounts
 finwatch_pub | public     | merchants
 finwatch_pub | public     | transactions
```

### Step 4 — Check the current WAL position

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
SELECT
    pg_current_wal_lsn() AS current_lsn,
    pg_current_wal_insert_lsn() AS insert_lsn;
"
```

Expected (your numbers will differ):

```
 current_lsn | insert_lsn
-------------+------------
 0/1A3F5B8   | 0/1A3F5B8
```

This is the "end of the WAL" — where the next write will go.

### Step 5 — Insert a row and watch the LSN advance

In a single compound command:

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
SELECT pg_current_wal_lsn() AS before;

INSERT INTO transactions (account_id, merchant_id, amount, type, status, description)
SELECT
    (SELECT id FROM accounts WHERE email = 'nguyenvana@email.com'),
    (SELECT id FROM merchants WHERE name = 'VinMart'),
    42.00,
    'purchase',
    'completed',
    'WAL advance test';

SELECT pg_current_wal_lsn() AS after;
"
```

`before` and `after` should differ — the INSERT wrote WAL bytes. The difference is roughly the size of the WAL record that describes your insert (plus some overhead).

### Step 6 — Measure replication lag

How far behind is Debezium? You compare the current WAL end to the slot's confirmed position:

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
SELECT
    slot_name,
    pg_current_wal_lsn() AS current_wal,
    confirmed_flush_lsn AS slot_confirmed,
    pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes
FROM pg_replication_slots
WHERE slot_name = 'finwatch_slot';
"
```

Expected (your numbers will differ, healthy `lag_bytes` is small — tens to thousands of bytes):

```
   slot_name   | current_wal | slot_confirmed | lag_bytes
---------------+-------------+----------------+-----------
 finwatch_slot | 0/1A40C00   | 0/1A40B80      |       128
```

**This is the single most important query to know for operating CDC.** If `lag_bytes` grows into gigabytes, your consumer is falling behind. If it stops changing, your consumer is dead.

### Step 7 — Watch WAL consumption in real time (optional)

Run this in one terminal, and issue some INSERTs in another, and you'll see the current WAL advance:

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
SELECT pg_current_wal_lsn(), NOW();
"
```

Just repeat this a few times after some INSERTs. The LSN grows.

### Step 8 — Look at the Debezium snapshot behavior

Debezium's snapshot mode is configured in `debezium/connectors/finwatch-connector.json`:

```json
"snapshot.mode": "initial"
```

This means: on first startup against a database, do a snapshot once. On subsequent startups (if the slot still exists), skip the snapshot and resume streaming from the slot's position.

Other modes exist: `never`, `always`, `when_needed`. For FinWatch, `initial` is the right choice — you get a full copy of accounts/merchants/transactions on first boot, then incremental updates forever after.

---

## Checkpoints

1. What's the difference between physical replication and logical replication, and why does Debezium need the logical kind?
2. What happens to disk usage if Debezium is stopped for a week but the replication slot is not dropped?
3. Why must `wal_level` be set to `logical` for CDC, and what does that cost?
4. What's the purpose of `restart_lsn` vs `confirmed_flush_lsn` on a replication slot?

(Answers at the bottom.)

---

## Troubleshooting

**Problem:** `SELECT wal_level` shows `replica` instead of `logical`.
**Cause:** Either the config file wasn't read, or the setting was overridden somewhere, or Postgres wasn't restarted after changing it.
**Fix:** `wal_level` requires a restart to change. Verify:

```bash
docker compose logs postgres | grep wal_level
```

You should see an entry confirming `wal_level = logical` at startup. If not, check the volume mount in `docker-compose.yml`:

```yaml
volumes:
  - ./postgres/postgresql.conf:/etc/postgresql/postgresql.conf
```

Make sure `command: postgres -c config_file=/etc/postgresql/postgresql.conf` is in the compose file — otherwise Postgres uses the default config and ignores yours.

---

**Problem:** `pg_replication_slots` shows `active = f` and your CDC pipeline is dead.
**Cause:** Debezium is disconnected. Could be: Debezium container is stopped, network between containers is broken, or the replication user lost its REPLICATION privilege.
**Fix:**

```bash
docker compose ps debezium                  # Check if it's running
docker compose logs debezium | tail -50     # Look for errors
```

Common error in the logs: `could not connect to server: Connection refused` — means Debezium started before Postgres was ready. Restart Debezium:

```bash
docker compose restart debezium
```

After 30 seconds, re-check `pg_replication_slots` — `active` should flip to `t`.

---

**Problem:** Disk usage on the Postgres volume is growing and won't stop.
**Cause:** You have an inactive replication slot that's pinning WAL.
**Fix:** Find the culprit:

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
SELECT
    slot_name,
    active,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS wal_retained
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC;
"
```

If you see a slot that's inactive and holding multiple GB of WAL, you have two choices:

1. **Bring the consumer back up** — preferred. This is Debezium, bring it online.
2. **Drop the slot** — only if you're certain you don't need the data. `SELECT pg_drop_replication_slot('finwatch_slot');` — after this, Postgres can delete the retained WAL on the next checkpoint. But the consumer, when it comes back, will have lost its place. You'd need to re-snapshot.

---

**Problem:** You added a new column to `transactions` with `ALTER TABLE`, but Debezium doesn't send the new column.
**Cause:** Logical decoding captures schema changes, but the connector may need its topic schema refreshed. For FinWatch's JSON converter this is mostly automatic, but there's a subtlety around how downstream schemas interpret new fields.
**Fix:** Usually a connector restart is enough:

```bash
curl -X POST http://localhost:8083/connectors/finwatch-connector/restart
```

If you *removed* a column, Debezium will keep sending the last known version — a deeper "schema evolution" topic that chapter 04 touches.

---

## Where to go next

You now understand the mechanism Postgres uses to make every change visible, and what it costs to expose that mechanism for CDC. Next, you learn how Debezium talks to this machinery and converts raw WAL records into Kafka messages.

Next: **[Chapter 04 — Debezium and CDC](04-debezium-cdc.md)**.

---

### Checkpoint answers

1. **Physical replication** ships raw WAL bytes — the receiver must be another Postgres of the same major version. **Logical replication** decodes the WAL into logical change events (rows with column values), which can be consumed by anything. Debezium needs the logical kind because Kafka isn't a Postgres replica — it's a different system entirely. Logical decoding is the only way to translate WAL into generic change events.

2. The replication slot keeps `restart_lsn` pinned at the position Debezium reached before stopping. Postgres refuses to delete any WAL newer than that position, because it would break Debezium's ability to resume. WAL accumulates on disk until either (a) Debezium reconnects and advances the slot, or (b) the slot is manually dropped. A week of transactions at 1000 TPS could be tens of GB — easily enough to fill a small Postgres volume and cause a hard outage. This is the single most common failure mode for CDC in production.

3. `logical` enables full logical decoding, which requires Postgres to include primary key information and, for some operations, full before/after row images in the WAL. This makes the WAL somewhat larger (more bytes per change) and slightly slower to produce (more CPU per change). The cost is real but usually small — maybe 10–15% overhead on write throughput.

4. `restart_lsn` is the oldest WAL position the slot might still need to replay — Postgres must keep WAL from this position forward. `confirmed_flush_lsn` is the position the consumer has explicitly confirmed it has processed and persisted. `confirmed_flush_lsn` is always `>=` `restart_lsn`. The consumer updates `confirmed_flush_lsn` after it's sure the data is safe downstream (e.g., Kafka has acked the produce). WAL between `restart_lsn` and `confirmed_flush_lsn` might be deletable soon; WAL before `restart_lsn` can be deleted now.
