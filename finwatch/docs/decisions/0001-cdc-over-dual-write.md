# ADR-0001: Change Data Capture over dual-write

- **Status:** Accepted
- **Date:** 2026-04 (project inception)
- **Deciders:** thesis author, advisor at VNUK Đà Nẵng

## Context

To get OLTP transaction data into the analytics layer in near-real time, the project needed a way to propagate row-level changes from PostgreSQL to ClickHouse with sub-second latency. Two patterns were considered:

1. **Dual-write at the application level** — the application writes to PG and publishes to Kafka in the same code path.
2. **Change Data Capture (CDC) via Debezium** — Debezium reads PG's logical WAL and publishes row events to Kafka; the application only writes to PG.

## Decision

CDC via Debezium PostgresConnector with the `pgoutput` plugin. Configured in `finwatch/debezium/connectors/finwatch-connector.json`. Requires `wal_level=logical` (set in `finwatch/postgres/postgresql.conf`) and a publication + replication slot owned by the `debezium` role (created in `finwatch/postgres/init/01_init_schema.sql`).

## Consequences

**Positive:**
- Application code stays unaware of the analytics path; the OLTP team can iterate independently of the analytics team.
- WAL captures **every** mutation — no race between application-level commit and Kafka publish (the central failure mode of dual-write under crash).
- Replay is built in: Debezium tracks offsets in the replication slot. If Kafka consumers fall behind or restart, Debezium resumes from the last committed offset.
- Schema evolution is partly automatic — `ExtractNewRecordState` SMT flattens envelopes, so column additions in PG appear as new fields in the Kafka payload without connector reconfiguration (column drops still require care).

**Negative:**
- Adds a dependency: a healthy Debezium Kafka Connect cluster is now part of the critical path.
- Requires `wal_level=logical` on PG, which is a small performance cost (~5% on write-heavy workloads per the PG docs).
- Replication slot management: if Debezium is permanently removed without dropping the slot, the WAL grows unboundedly (operational gotcha addressed in `finwatch/docs/runbook.md`).

## Alternatives considered

- **Dual-write** (rejected): the application would have to coordinate two writes per transaction, and a crash between the PG commit and the Kafka publish silently loses an event from the analytics layer. Even with outbox patterns, the ergonomics are worse than CDC.
- **Triggers → table → poll** (rejected): writes a duplicate row to an audit table inside a trigger, then a polling loop ships those rows to Kafka. Higher OLTP overhead, harder to scale, and creates yet another delivery path the team has to maintain.

## References

- Debezium PG connector documentation: `https://debezium.io/documentation/reference/2.5/connectors/postgresql.html`
- "Designing Data-Intensive Applications" (Kleppmann, 2017), Chapter 11 — discussion of dual-write failure modes.
