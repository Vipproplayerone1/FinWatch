# Chapter 05 — Kafka: the streaming backbone

## Why this matters

Kafka is the middle of the pipeline and, arguably, the reason FinWatch can be reliable at all. It's what lets Postgres and ClickHouse be loosely coupled — neither has to know the other exists, neither has to be up at the same time, and neither is slowed down by the other. Kafka is also where debugging lives: if something is wrong in the pipeline, the first question is always "is the message in Kafka?"

By the end of this chapter you'll know what topics, partitions, and offsets actually are; how consumer groups share work; why Kafka is durable without being a database; and how to inspect, consume, and produce messages from the command line. You'll also run a live CDC watch — insert a row in Postgres and see it appear in Kafka seconds later.

---

## Theory

### Kafka in one sentence

Kafka is a distributed, append-only log you can publish to and read from, with strong ordering and durability guarantees.

Everything else — topics, partitions, offsets, consumer groups — is terminology for how that log is organized, scaled, and shared.

### Topic

A **topic** is a named stream of messages. FinWatch has three topics that carry CDC data:

- `finwatch.public.accounts`
- `finwatch.public.merchants`
- `finwatch.public.transactions`

(Plus several `_finwatch_connect_*` internal topics for Kafka Connect's own state.)

Producers append messages to a topic. Consumers read from a topic. A topic persists messages on disk for as long as retention policy says (default: 7 days).

A topic is just a logical name. The real data lives in partitions.

### Partition

A **partition** is an ordered, immutable log file on disk. A topic is divided into one or more partitions. Each partition lives on one Kafka broker (server). Each message in a partition gets a sequentially-assigned **offset** — an integer 0, 1, 2, ... that never repeats within that partition.

```
 Topic: finwatch.public.transactions
 ┌─────────────────────────────────────────────┐
 │ Partition 0                                 │
 │  offset 0: {id:"a", amount:"1.00"}         │
 │  offset 1: {id:"b", amount:"2.50"}         │
 │  offset 2: {id:"c", amount:"9.99"}         │
 │  ...                                       │
 └─────────────────────────────────────────────┘
```

FinWatch topics all have **1 partition** — this is the default Debezium behavior for Postgres CDC, and keeps global ordering trivially simple. Multi-partition topics are faster but require careful thought about which messages go to which partition.

Within a partition, messages are *strictly ordered*. Across partitions, there's no order guarantee. So a 1-partition topic gives you total ordering; a 10-partition topic gives you 10 independent ordering streams.

### Offset

The offset is the "row number" of a message in its partition. It's the unit of consumer progress. A consumer reading offset 5 has processed messages 0 through 5 and will see 6 next.

Two special offsets:
- **Earliest offset** — first message still in the log (may not be 0 if older messages aged out of retention)
- **Latest offset** — one past the most recently written message (where the next write will go, called "high watermark")

Consumers track their position by committing offsets. More in a minute.

### Broker

A **broker** is a Kafka server process. A Kafka cluster is typically 3+ brokers for redundancy. FinWatch runs 1 broker (`finwatch-kafka`) — simpler for learning, no redundancy. In production you want ≥3 so one can die without downtime.

### ZooKeeper (the fossil)

Legacy Kafka uses **ZooKeeper** to store cluster metadata (broker list, topic list, ACLs, etc.). FinWatch uses the Confluent Kafka 7.6 image, which still uses ZooKeeper. Hence `finwatch-zookeeper`.

Modern Kafka (3.3+) supports **KRaft mode** (Kafka-Raft) where the brokers handle metadata themselves, no ZooKeeper needed. You don't need to worry about this for FinWatch — the ZK dependency is invisible from outside.

### Producer

A producer sends messages to a topic. In FinWatch, the producer is the Debezium Kafka Connect worker. Every CDC event Debezium emits is a produce call against a partition of a topic.

Producers choose which partition to write to (usually via a key hash — "route all messages with the same key to the same partition"). Debezium uses the Postgres primary key (`id`) as the Kafka key, so all events for the same row go to the same partition and stay in order.

### Consumer and consumer group

A **consumer** reads messages from a topic. A **consumer group** is a named set of consumers that *share* the partitions of a topic — each partition is assigned to exactly one consumer in the group.

```
 Topic: with 3 partitions
 Group "clickhouse_transactions" with 2 consumers:
   Partition 0 → Consumer A
   Partition 1 → Consumer A
   Partition 2 → Consumer B

 If Consumer B dies, Kafka rebalances:
   Partition 0 → Consumer A
   Partition 1 → Consumer A
   Partition 2 → Consumer A  (A now handles everything)
```

Consumer groups give you horizontal scaling (more consumers = more parallelism) and fault tolerance (one dies, the rest pick up).

Different groups reading the same topic are completely independent — each group has its own offset per partition.

FinWatch's ClickHouse consumers use group names like `clickhouse_transactions`, `clickhouse_accounts`, `clickhouse_merchants`. Each has its own offset tracking.

### Committed offset

A consumer "commits" its offset to tell Kafka "I have processed up to this point; if I die and restart, resume from here."

Commits can be automatic (every N seconds or N messages) or manual. ClickHouse's Kafka Engine commits automatically.

If a consumer dies before committing, it may re-process some recent messages on restart. This is the **at-least-once** delivery semantic — the default, and what FinWatch uses. Downstream deduplication (ReplacingMergeTree, chapter 06) handles the possible duplicates.

### Exactly-once, and why FinWatch doesn't need it

Kafka can be configured for exactly-once semantics using transactions and idempotent producers. It's powerful but adds complexity. For FinWatch's use case — analytics where a duplicate row is cleaned up by ReplacingMergeTree — at-least-once with downstream dedup is the pragmatic choice.

### Durability and replication

Each partition can be replicated across multiple brokers. A message is considered "committed" when it's on all in-sync replicas. If the leader broker fails, a replica is promoted. Readers never see uncommitted messages.

FinWatch runs one broker with replication factor 1 (the three `REPLICATION_FACTOR: 1` lines in `docker-compose.yml`). No redundancy — if the broker dies, data is at risk until it recovers. Production setups use RF=3 on a 3-broker cluster.

### Retention

Messages don't live forever. Kafka deletes old data based on:

- **Time-based retention** — default 7 days. Messages older than this are deleted.
- **Size-based retention** — cap the partition log file at some size.
- **Log compaction** — an alternative retention policy that keeps only the latest message per key. Useful for state topics but not for CDC change streams.

FinWatch uses the default time-based retention. You saw the effect in chapter 03 — old snapshot messages had expired and `earliest offset == latest offset` on the FinWatch topics. This is normal; CDC pipelines don't need old messages forever because the downstream analytical database has them.

---

## How it's used in FinWatch

### The Kafka broker config (from docker-compose)

```yaml
kafka:
  image: confluentinc/cp-kafka:7.6.0
  environment:
    KAFKA_BROKER_ID: 1
    KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT
    KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092,PLAINTEXT_HOST://localhost:29092
    KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
    KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
    KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"
```

Key points:

**Two listeners:**
- `PLAINTEXT://kafka:9092` — used by other Docker containers (Debezium, ClickHouse, and the `web` service for the internal Kafka browser) on the shared Docker network. The hostname `kafka` resolves inside Docker.
- `PLAINTEXT_HOST://localhost:29092` — used by tools running on your host machine. `29092` is the port mapped out via `ports: [29092:29092]`.

This dual-listener setup is essential for Docker. If Kafka advertised only `kafka:9092`, host-side tools couldn't connect; if it advertised only `localhost:29092`, containers inside the network would fail. With both, each caller uses the address that works from where it is.

**Auto-create topics:** enabled. Debezium's topics get created on first write without explicit admin action. Convenient for dev, sometimes disabled in production to enforce governance.

**RF=1 everywhere:** single-broker, no redundancy.

### The internal Kafka browser

FinWatch ships its own read-only Kafka inspector inside the `web` service. It's a Next.js page at `/kafka` that talks to Kafka via `kafkajs`. Useful during learning:

- http://localhost:3002/kafka
- Browse the three `finwatch.public.*` topics
- Inspect the last 50 messages with full JSON expand (live-tail mode polls every 1 s)
- See per-partition consumer lag for the `clickhouse_<table>` groups
- Read topic configs (`cleanup.policy`, `retention.ms`, `replication.factor`, …)

It is read-only on purpose — no produce, no admin actions. If you need to write to Kafka, use `kafka-console-producer` from inside the broker container.

### What Debezium produces to Kafka

For each row change in `accounts`/`merchants`/`transactions`:

- Kafka key: JSON containing the Postgres primary key, e.g., `{"id":"abc-123-..."}`. This ensures all events for the same row go to the same partition and preserve order.
- Kafka value: JSON with the flattened row plus `__op`, `__table`, `__source_ts_ms`, `__deleted`.
- Target topic: `finwatch.public.<table>`.
- Headers: Debezium sets some, mostly unused by FinWatch's consumers.

### Who consumes FinWatch's Kafka topics

Only one: ClickHouse's Kafka Engine tables (chapter 06). ClickHouse uses three consumer groups:

- `clickhouse_accounts` → reads `finwatch.public.accounts`
- `clickhouse_merchants` → reads `finwatch.public.merchants`
- `clickhouse_transactions` → reads `finwatch.public.transactions`

Each group has one consumer (because each Kafka Engine table has `kafka_num_consumers = 1`). ClickHouse commits offsets automatically as it ingests.

---

## Hands-on

Make sure the stack has Postgres, Kafka, Debezium at minimum:

```bash
cd D:/Major/Graduate_Project/finwatch
docker compose up -d postgres zookeeper kafka debezium
```

### Step 1 — List all topics

```bash
docker exec finwatch-kafka kafka-topics --bootstrap-server kafka:9092 --list
```

Expected (order may vary):

```
__consumer_offsets
_finwatch_connect_configs
_finwatch_connect_offsets
_finwatch_connect_status
finwatch.public.accounts
finwatch.public.merchants
finwatch.public.transactions
```

Underscore-prefixed topics are internal. `__consumer_offsets` is Kafka's own topic for tracking where consumer groups are reading. You generally don't read/write it directly.

### Step 2 — Describe a topic

```bash
docker exec finwatch-kafka kafka-topics --bootstrap-server kafka:9092 \
  --describe --topic finwatch.public.transactions
```

Expected:

```
Topic: finwatch.public.transactions  TopicId: ...  PartitionCount: 1  ReplicationFactor: 1
        Topic: finwatch.public.transactions  Partition: 0  Leader: 1  Replicas: 1  Isr: 1
```

Meaning:
- 1 partition (partition 0)
- Replication factor 1 (no replicas)
- Leader is broker ID 1 (our only broker)
- In-sync replica set is just `{1}`

### Step 3 — Inspect offset range

```bash
# Earliest offset (oldest message still retained)
docker exec finwatch-kafka kafka-run-class kafka.tools.GetOffsetShell \
  --broker-list kafka:9092 --topic finwatch.public.transactions --time -2

# Latest offset (next message's offset)
docker exec finwatch-kafka kafka-run-class kafka.tools.GetOffsetShell \
  --broker-list kafka:9092 --topic finwatch.public.transactions --time -1
```

Output format is `topic:partition:offset`. If both are the same, the partition contains no live messages (older ones aged out of retention, nothing new yet).

### Step 4 — Produce a test message (manually)

You normally don't produce to CDC topics — Debezium owns them. But for learning:

```bash
docker exec -it finwatch-kafka kafka-console-producer \
  --bootstrap-server kafka:9092 \
  --topic test-playground
```

Type a few lines, each line is one message. Press Ctrl+C to quit. This auto-creates the `test-playground` topic. Then:

```bash
docker exec finwatch-kafka kafka-console-consumer \
  --bootstrap-server kafka:9092 \
  --topic test-playground \
  --from-beginning \
  --max-messages 10 --timeout-ms 5000
```

You should see the lines you typed. Delete the playground topic when done:

```bash
docker exec finwatch-kafka kafka-topics --bootstrap-server kafka:9092 \
  --delete --topic test-playground
```

### Step 5 — Live CDC watch

This is the flagship demo. You'll watch a Postgres INSERT become a Kafka message in real time.

**Terminal 1** — start a consumer from the latest offset:

```bash
docker exec finwatch-kafka kafka-console-consumer \
  --bootstrap-server kafka:9092 \
  --topic finwatch.public.transactions \
  --timeout-ms 30000
```

Without `--from-beginning`, this reads only new messages. It will hang waiting for input (for up to 30 seconds).

**Terminal 2** — insert a row:

```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c "
INSERT INTO transactions (account_id, merchant_id, amount, type, status, description)
SELECT
    (SELECT id FROM accounts LIMIT 1),
    (SELECT id FROM merchants LIMIT 1),
    555.55, 'purchase', 'completed', 'Chapter 05 live CDC demo';
"
```

Terminal 1 will print a JSON message within 1–2 seconds. Example:

```json
{"id":"abc-...","account_id":"...","merchant_id":"...","amount":"555.55",...,"description":"Chapter 05 live CDC demo",...,"__op":"c","__table":"transactions","__source_ts_ms":1712345678901}
```

This is the chain you learned about in chapters 03 and 04 in action: `psql INSERT → WAL record → Debezium decodes → Kafka message → console consumer prints`. Typical latency: tens of milliseconds.

### Step 6 — Consumer groups: list and describe

List all consumer groups:

```bash
docker exec finwatch-kafka kafka-consumer-groups --bootstrap-server kafka:9092 --list
```

Expected (your list may vary):

```
clickhouse_accounts
clickhouse_merchants
clickhouse_transactions
finwatch-connect
```

Describe one to see its position and lag:

```bash
docker exec finwatch-kafka kafka-consumer-groups --bootstrap-server kafka:9092 \
  --describe --group clickhouse_transactions
```

Expected:

```
GROUP                    TOPIC                            PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG  CONSUMER-ID              HOST              CLIENT-ID
clickhouse_transactions  finwatch.public.transactions     0          171468          171468          0    ClickHouse-...           /172.18.0.x/...  ClickHouse-...
```

- `CURRENT-OFFSET` — where this group has committed
- `LOG-END-OFFSET` — latest offset in the partition
- `LAG` — difference. 0 means fully caught up. A big number means ClickHouse is falling behind.

**Lag is the single most important operational metric for a Kafka-based pipeline.** If it starts climbing, investigate immediately.

### Step 7 — Read from a specific offset

To replay history (e.g., for debugging):

```bash
docker exec finwatch-kafka kafka-console-consumer \
  --bootstrap-server kafka:9092 \
  --topic finwatch.public.transactions \
  --offset 100 \
  --partition 0 \
  --max-messages 5 --timeout-ms 10000
```

This reads 5 messages starting at offset 100 of partition 0. Useful for inspecting a specific message after you've found a problem.

### Step 8 — Produce with a key

Keys matter for partitioning. Here's how to produce with a key (just for learning — you won't do this with the CDC topics):

```bash
docker exec -it finwatch-kafka kafka-console-producer \
  --bootstrap-server kafka:9092 \
  --topic test-keyed \
  --property "parse.key=true" \
  --property "key.separator=:"
```

Then type:

```
user-1:{"event":"login"}
user-1:{"event":"click"}
user-2:{"event":"login"}
```

All `user-1` events go to the same partition. All `user-2` events go to some (possibly different) partition. Cleanup:

```bash
docker exec finwatch-kafka kafka-topics --bootstrap-server kafka:9092 \
  --delete --topic test-keyed
```

### Step 9 — Inspect the internal Kafka browser

Open http://localhost:3002/kafka. Click `finwatch.public.transactions` in the left sidebar.

You'll see:
- Recent messages (the "Messages" tab, loaded by default) — newest at the top, click a row to expand the full JSON
- Consumer groups reading this topic (the "Consumers" tab — `clickhouse_transactions` should appear with near-zero lag)
- Topic configs (the "Metadata" tab — retention, compression, cleanup policy)
- A "Live tail" toggle: when on, new messages prepend every second — useful while running `generate_transactions.py`

The Messages view is the single most useful debug tool. When you think "did my event reach Kafka?", this is where you look first.

---

## Checkpoints

1. Why does each FinWatch CDC topic have exactly 1 partition rather than, say, 10?
2. If two separate consumer groups both read `finwatch.public.transactions`, do they interfere with each other's progress?
3. What does it mean if `LAG` in `kafka-consumer-groups --describe` is growing instead of staying near zero?
4. Why do the FinWatch services talk to Kafka as `kafka:9092` rather than `localhost:9092`?

(Answers at the bottom.)

---

## Troubleshooting

**Problem:** `kafka-topics --list` returns nothing (not even an error, just silence), then times out.
**Cause:** Kafka broker not responding — either not started, not finished bootstrapping, or health check failing.
**Fix:**

```bash
docker compose ps kafka
docker compose logs kafka | tail -30
```

Look for `started (kafka.server.KafkaServer)`. If absent, wait longer or check for config errors. Common issue: ZooKeeper isn't up yet.

---

**Problem:** `Error while fetching metadata with correlation id ... : {topic=LEADER_NOT_AVAILABLE}` when producing or consuming.
**Cause:** The broker is still starting, or the topic's partition leader is unavailable.
**Fix:** Wait 20 seconds and retry. If persistent:

```bash
docker compose restart kafka
```

---

**Problem:** Consumer prints old messages even though you just inserted in Postgres.
**Cause:** You're running the consumer with `--from-beginning`, which replays the whole topic from offset 0.
**Fix:** Remove `--from-beginning`, or use `--offset latest`. For debugging specifically the latest N messages:

```bash
docker exec finwatch-kafka kafka-console-consumer \
  --bootstrap-server kafka:9092 \
  --topic finwatch.public.transactions \
  --offset latest --partition 0 \
  --max-messages 1 --timeout-ms 30000
```

Then insert in Postgres in another terminal — this message will be the one you just inserted.

---

**Problem:** You see a topic `finwatch.public.transactions` but it has 0 messages (earliest offset == latest offset == 0).
**Cause:** Either (a) no writes have happened yet, (b) Debezium has not finished its initial snapshot, or (c) messages were wiped by retention.
**Fix:** Insert a new row in Postgres and watch. If Debezium is healthy, the message arrives within seconds. If nothing happens, check Debezium connector status (chapter 04).

---

**Problem:** `kafka-consumer-groups --describe --group clickhouse_transactions` says `Consumer group ... has no active members`.
**Cause:** ClickHouse isn't running, or ClickHouse's Kafka Engine table hasn't been created yet, or the consumer group hasn't committed any offset yet.
**Fix:** Normal if you're following the tutorial and haven't started ClickHouse yet — the group will materialize once ClickHouse connects (chapter 06). If ClickHouse is running but the group is empty, check ClickHouse's Kafka Engine configuration (chapter 06 troubleshooting).

---

## Where to go next

You now have a full picture of how data gets *into* Kafka. In the next chapter you'll learn how it gets *out* — into ClickHouse, where it becomes queryable for analytics.

Next: **[Chapter 06 — ClickHouse: real-time analytics](06-clickhouse-analytics.md)**.

---

### Checkpoint answers

1. Debezium produces CDC events keyed by primary key. With 1 partition, total order across all events is preserved — if account X is updated three times, those three events arrive in order. With 10 partitions, events for *different rows* can interleave freely, but Debezium's keying ensures events for the *same row* still go to the same partition and stay in order. One partition is simpler and usually sufficient — the bottleneck for CDC isn't Kafka throughput. You'd use more partitions only if you expected >~100k ev/s per topic and wanted multi-consumer parallelism.

2. No — completely independent. Each consumer group tracks its own offset per partition. Group A could be reading offset 1000 while Group B is reading offset 50. They don't see each other and don't affect each other's progress.

3. The consumer is slower than the producer. Either the consumer is under-provisioned (not enough CPU/memory for ClickHouse to keep up), or it's hit a transient error and is retrying, or there's a downstream bottleneck (disk full, etc.). Growing lag is the pipeline's way of telling you "the producer is faster than the consumer; this won't be real-time much longer."

4. Services inside the Docker network reach each other by service name, which resolves to the container's internal IP. `localhost` inside a container refers to the *container itself*, not the host machine — so `localhost:9092` from inside Debezium would try to find Kafka in the Debezium container, which fails. `kafka:9092` correctly addresses the Kafka broker on the shared Docker network. Tools running on your host machine, however, would use `localhost:29092` — the external listener port mapped out from the container.
