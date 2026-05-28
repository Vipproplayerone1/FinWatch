# ADR-0002: ClickHouse as the analytical engine

- **Status:** Accepted
- **Date:** 2026-04

## Context

The thesis needed a database that could:
1. Ingest streaming inserts at > 1000 TPS sustained.
2. Serve analytical aggregations (sums, group-by-account, window functions) on millions of rows in sub-second.
3. Run open-source on a single Docker host for the demo, and scale horizontally for a production hypothetical.
4. Consume directly from Kafka with no glue code.

## Decision

ClickHouse 24.3 with the `Kafka` engine + materialized view pattern.

- Source: `finwatch/clickhouse/init/02_create_kafka_tables.sql` (Kafka engine tables)
- Target: `finwatch/clickhouse/init/03_create_target_tables.sql` (`ReplacingMergeTree` per business table)
- MV: `finwatch/clickhouse/init/04_create_materialized_views.sql`

Tuned for low end-to-end latency via `stream_flush_interval_ms=500` and `stream_poll_timeout_ms=200` in `finwatch/clickhouse/users.d/streaming.xml`.

## Consequences

**Positive:**
- Sub-second analytical query on hundreds of thousands of rows (benchmarked at p50 ~1.0s end-to-end PG→CH via `scripts/benchmark_latency.py`).
- Sustained insert throughput ~1500 TPS on 1 host (`scripts/benchmark_throughput.py`).
- Native Kafka engine means no separate consumer service to operate.
- Columnar storage + LZ4 compression keeps disk cost low.
- Free + open-source (Apache 2.0).

**Negative:**
- `ReplacingMergeTree` requires `FINAL` for correct read semantics, which costs a final-pass merge at query time. Mitigated by the `cdc_op != 'd'` filter that skips tombstones early.
- ClickHouse is opinionated about clustering — multi-shard production deployment requires upfront sharding-key design (here: `account_id` hash).
- Less mature ecosystem than Postgres for connectors, ORMs, and tooling.

## Alternatives considered

- **TimescaleDB**: excellent for time-series PG-compatible workloads, but slower than ClickHouse on wide-aggregation queries (sum / group-by over millions of rows). Picked CH for analytical throughput.
- **Apache Druid**: comparable performance, but operationally heavier — multiple node roles (broker / historical / coordinator / overlord) for a single-host demo is overhead the thesis doesn't need.
- **Snowflake**: managed, very capable, but $-per-credit pricing is incompatible with a self-hosted thesis budget; also no direct Kafka consumer (would need Snowpipe or Kafka Connect Snowflake sink).
- **Elasticsearch**: text-search bias, not optimized for numeric aggregates. Rejected.

## References

- ClickHouse Kafka engine documentation: `https://clickhouse.com/docs/en/engines/table-engines/integrations/kafka`
- "ClickHouse: a fast open-source OLAP DBMS" — Yandex tech talk (2017–2024 evolution).
- Comparative analysis written up in `finwatch/docs/related-work.md`.
