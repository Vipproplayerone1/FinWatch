# ADR-0004: ReplacingMergeTree for at-least-once deduplication

- **Status:** Accepted
- **Date:** 2026-04

## Context

Kafka (and therefore Debezium → Kafka → ClickHouse) provides at-least-once delivery semantics. The same row event can land in ClickHouse twice — for example, when a Kafka consumer offset commit fails after the message was already read into the engine table.

The thesis needed a deduplication strategy that:
1. Tolerates duplicate Kafka messages without manual cleanup.
2. Handles UPDATE events correctly (latest version wins).
3. Handles DELETE events correctly (preserves the tombstone for audit, but excludes deleted rows from analytical queries).

## Decision

`ReplacingMergeTree(_source_ts_ms)` for every target table, where `_source_ts_ms` is the Debezium `source.ts_ms` field — the timestamp the row was committed in PG.

All target tables in `finwatch/clickhouse/init/03_create_target_tables.sql` use this engine. The `ORDER BY` keys include the primary key fields so duplicate rows merge correctly.

For correctness, every analytical query must include:
- `FINAL` — forces a final-pass merge to resolve duplicates at read time.
- `WHERE cdc_op != 'd'` — excludes Debezium tombstone rows (DELETE events).

This invariant is codified in `CLAUDE.md` §11 rule 5.

## Consequences

**Positive:**
- Idempotent at the storage layer: the same Kafka message replayed multiple times produces a single visible row.
- Update semantics are correct: an UPDATE in PG produces a new row in CH with a later `_source_ts_ms`; `FINAL` picks the latest version.
- Deletes are preserved as tombstones, giving us an audit trail of every change, while the `cdc_op != 'd'` filter keeps deleted rows out of business queries.

**Negative:**
- Every analytical query carries the `FINAL + cdc_op != 'd'` boilerplate. A forgotten clause produces stale or duplicated data. Mitigation: explicit rule in `CLAUDE.md` and consistent enforcement in all `anomaly_*.sql` and `dashboard_queries.sql`.
- `FINAL` is more expensive than a plain `SELECT` — it forces a merge across all parts containing the matching ORDER BY key. For most analytical queries this is acceptable; for high-frequency dashboard refreshes it adds CPU.
- Background merges are best-effort: the storage may briefly contain duplicates between merges. `FINAL` resolves this at query time but does not eliminate the underlying transient state.

## Alternatives considered

- **CollapsingMergeTree** with a `sign` column: similar dedup semantics but requires inserting an explicit "delete" row with `sign=-1`. Harder to integrate with Debezium's `op` field semantics; rejected for ergonomics.
- **Application-level dedup via `id` uniqueness on the consumer**: requires a stateful consumer (or a lookup table), which adds operational complexity. Rejected.
- **ClickHouse `Distributed` + `ReplacingMergeTree` shards** (future): same engine choice, just scaled out. Not needed for the single-host thesis demo.

## References

- ClickHouse ReplacingMergeTree documentation: `https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/replacingmergetree`
- "Kleppmann (2017): Designing Data-Intensive Applications" — Chapter 8 on at-least-once vs exactly-once.
