# FinWatch — Related work and architectural alternatives

This document is the comparative analysis the defense committee will ask for. For each major architectural choice in FinWatch, we name the strongest alternative, its known characteristics, and why FinWatch did not pick it. None of the rejected alternatives is *wrong* — they are different points in the design space with different trade-offs.

## 1. Streaming ingestion: Debezium vs Spark Streaming vs Flink vs Snowpipe

The role: capture every row-level mutation from PostgreSQL and propagate it to the analytics layer with as little latency as feasible.

### Debezium (chosen)

A Kafka Connect source connector that reads Postgres's logical WAL via the `pgoutput` plugin and publishes row events to Kafka topics. Open-source (Apache 2.0), runs as a single JVM service inside Kafka Connect.

**Why we picked it:**
- Captures **every** change without modifying the application (true log-based CDC).
- Built-in offset management via Postgres replication slots — automatic resume after consumer downtime.
- Mature SMT (Single Message Transform) ecosystem — `ExtractNewRecordState` flattens the Debezium envelope so downstream code does not need to know the envelope format.
- Cited in industry case studies at Wepay, Convoy, Trivago — production track record.

**Trade-offs:**
- One extra service in the operational footprint.
- Tightly coupled to Postgres WAL format; cross-DB portability is good but not free (MySQL connector has different semantics).

### Apache Spark Structured Streaming

A micro-batch streaming engine on top of Spark Core. Reads from Kafka, transforms with DataFrame API, writes to a sink (S3 / Delta Lake / Iceberg / JDBC).

**Why we did not pick it:**
- Spark is **not** a CDC capture tool — it would consume from a CDC-fed Kafka topic, not extract from Postgres. So Spark complements Debezium, it doesn't replace it. The thesis scope is the end-to-end pipeline, and adding Spark as an intermediate transform layer would add cost without solving a problem we have.
- Spark micro-batches have a floor latency of ~1–10 seconds depending on tuning (Armbrust et al., 2018, *SIGMOD*). Continuous processing mode trims this but is marked experimental. We can hit ~1 s without Spark.
- Spark cluster operations are heavyweight: driver + workers + memory tuning, not "one container."

**Where it would win:** complex multi-table joins, windowed aggregations expressed in DataFrame API rather than SQL, or pipelines that fan out to many sinks. Not our use case.

### Apache Flink

A true streaming dataflow engine with event-time semantics, watermarks, and exactly-once via aligned barriers. Reads from Kafka, writes to many sinks. Apache 2.0.

**Why we did not pick it:**
- Same first point as Spark: Flink isn't the CDC source — it would consume from a CDC-fed Kafka topic, so it doesn't replace Debezium.
- Flink's strength (event-time + complex CEP / windowed analytics with strong consistency guarantees) is overkill for the rule-based detection in scope. Our rules are simple SQL aggregations that ClickHouse runs sub-second.
- Operationally Flink is similar to Spark in weight — a JobManager + TaskManagers cluster, statesnapshots in RocksDB, savepoint management.

**Where it would win:** complex temporal joins (e.g. session window + fraud-graph correlation), stateful per-user features (running counters with exactly-once semantics across restarts), or sub-100-ms-latency streaming with strong consistency. Not our use case.

### Snowflake Snowpipe / Streams

Snowflake's continuous-ingest service (Snowpipe) plus the Streams + Tasks pattern for change detection within Snowflake.

**Why we did not pick it:**
- Pricing: ~$2 per credit, with ingestion + warehouse costs that quickly exceed a student budget for a 24/7 demo stack.
- Vendor lock-in is incompatible with the thesis's "on-premise compliance posture" framing for Vietnamese banking.
- No direct Postgres CDC — we'd still need Debezium → Snowpipe, adding a service to host.

**Where it would win:** an enterprise already on Snowflake, willing to pay for managed service. Not our setting.

### Verdict

For the thesis goal (sub-second CDC from one Postgres OLTP to one analytical store, on a single host, open-source), Debezium + Kafka is the best-fit point in the design space. Spark or Flink would be appropriate if we needed cross-table stateful transforms before landing in the analytical store; we do not.

---

## 2. Analytical store: ClickHouse vs Druid vs TimescaleDB vs Elasticsearch

The role: store the streamed transaction events for high-throughput analytical queries (rule SQL, dashboards, ad-hoc analyst exploration).

See also: [ADR-0002](./decisions/0002-clickhouse-over-alternatives.md).

### ClickHouse (chosen)

Columnar OLAP database with Kafka engine for native streaming consumption, materialized views for ETL-on-write, and `ReplacingMergeTree` for at-least-once dedup at the storage layer. Apache 2.0.

**Why we picked it:**
- **Native Kafka consumer.** A `Kafka(...) ENGINE` table reads directly from a topic — no separate consumer service, no Kafka Connect Sink, no glue code.
- Sub-second analytical queries on hundreds of thousands of rows benchmarked at p50 ~1.0 s end-to-end.
- Free + open-source, single-node deployable, also clusterable when needed.
- The `ReplacingMergeTree(_source_ts_ms)` + `FINAL` pattern gives clean dedup semantics for at-least-once delivery without bespoke consumer logic.

### Apache Druid

A real-time analytical database originally from Metamarkets. Strong time-series + cardinality features (HyperLogLog, theta-sketch).

**Why we did not pick it:**
- Operational overhead is much higher: 5 service types (Broker, Coordinator, Overlord, Historical, MiddleManager) plus deep storage and metadata store. A single-host thesis demo can't reasonably show this without becoming a Druid tutorial.
- Schema-on-ingest is restrictive — adding a new column at the source requires reingestion or a roll-up rewrite.
- RAM-hungry; needs significant heap tuning for the JVM cluster.

**Where it would win:** high-cardinality time-series with sub-second aggregations on billions of events. Overkill for our scale.

### TimescaleDB

A Postgres extension that adds time-partitioned hypertables. Same SQL as Postgres, no new operational model.

**Why we did not pick it:**
- It's still Postgres underneath, which means the OLTP database and analytics database share a process. Defeats the separation-of-concerns goal that CDC is supposed to enable.
- Wide-aggregation queries (sum / group-by-account over millions of rows) are slower than columnar engines like ClickHouse by 5–50× depending on the query.

**Where it would win:** time-series workloads on existing Postgres deployments where adding a separate analytical store is operationally prohibitive. Not our setting — we explicitly separate OLTP from analytics.

### Elasticsearch

Document store with strong full-text search and decent numeric aggregation.

**Why we did not pick it:**
- Bias toward text-search; numeric aggregation is OK but not its strength.
- JVM heap overhead per node is substantial.
- Aggregation API is less expressive than SQL for the kind of windowed group-by we need.

**Where it would win:** when fraud detection is text-heavy (e.g. transaction descriptions parsed for keywords). Not the case here.

### Verdict

ClickHouse is the right primary store for our scale and shape (numeric aggregation over time-windowed transaction data, with native Kafka ingestion). TimescaleDB would be the alternative pick if we wanted to keep the OLTP + analytics in one engine, accepting slower wide-aggregation queries; we explicitly didn't.

---

## 3. Serialization: JSON vs Avro vs Protobuf

See [ADR-0003](./decisions/0003-json-over-avro.md). Short version:

- **JSON (chosen):** simple, no schema registry, debuggable with `kafka-console-consumer`. Wire-efficiency cost (~3-5× vs Avro) is acceptable at our scale.
- **Avro:** smaller wire size, compile-time schema enforcement, but requires a Schema Registry — one more service.
- **Protobuf:** similar trade-off to Avro, plus the team has less tooling familiarity.

For a multi-team production deployment moving multi-region traffic, Avro is the right answer. For a single-host thesis demo, JSON is.

---

## 4. Fraud detection: rule-based vs ML

See [ADR-0006](./decisions/0006-rule-based-over-ml.md). Short version:

- **Rule-based (chosen):** explainable; no labelled training data needed; thresholds are dials, not retraining runs.
- **Supervised ML (e.g. gradient boosting):** higher recall potential but loses explainability and requires labelled fraud cases the thesis does not have.
- **Unsupervised ML (e.g. isolation forest):** can be added as a secondary scorer overlaying the rules. Architecture supports it (consume same Kafka topic, write `ml_score` column to `fraud_alerts`). Future work.

---

## 5. Closed-loop ledger: application-layer vs database trigger

See [ADR-0005](./decisions/0005-application-layer-ledger.md). Short version:

- **Application-layer (chosen):** consistent across web API, generator, simulator — three insertion paths obeying one Python helper + one TypeScript route. A trigger cannot distinguish `intent: completed` from `intent: failed` for scenarios that legitimately record failures.
- **Database trigger:** would catch every insert regardless of source, but cannot honour caller intent for the card-testing scenario. Rejected.

---

## 6. Operational deployment: Docker Compose vs Kubernetes

**Docker Compose (chosen):** single `docker-compose.yml`, all services on one host, reproducible by `docker compose up -d`. Right for a single-developer thesis demo.

**Kubernetes:** would be appropriate for production HA (3-broker Kafka cluster, PG replica set, ClickHouse multi-shard). The thesis explicitly puts this in scope of [`limitations.md`](./limitations.md) §L4.3 as future work.

---

## Suggested reading

The architectural choices above lean on these works:

- Kleppmann, M. (2017). *Designing Data-Intensive Applications.* O'Reilly. — Chapter 11 on CDC vs dual-write; Chapter 8 on at-least-once delivery semantics.
- Akidau, T. et al. (2015). *"The Dataflow Model: A Practical Approach to Balancing Correctness, Latency, and Cost in Massive-Scale, Unbounded, Out-of-Order Data Processing."* PVLDB 8(12). — Foundational paper on streaming semantics; Flink and Spark Streaming both implement these ideas.
- Armbrust, M. et al. (2018). *"Structured Streaming: A Declarative API for Real-Time Applications in Apache Spark."* SIGMOD. — Spark's micro-batch model and its latency floor.
- Molnar, C. (2022). *Interpretable Machine Learning.* — Discussion of the explainability trade-off in regulated domains (relevant to the rule-based vs ML choice).
- Debezium project documentation (version 2.5): `https://debezium.io/documentation/reference/2.5/`
- ClickHouse documentation: `https://clickhouse.com/docs/en/engines/table-engines/integrations/kafka` (Kafka engine), `https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/replacingmergetree` (dedup).
- Pukelsheim, F. (1994). *"The three sigma rule."* The American Statistician 48(2). — Cited in `anomaly_zscore.sql` as the |z|>3 justification.

A formal bibliography for the thesis manuscript is maintained separately in the thesis modules.
