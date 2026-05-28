# ADR-0003: JSON envelopes (no Schema Registry)

- **Status:** Accepted
- **Date:** 2026-04

## Context

Debezium can serialize Kafka payloads as JSON (no external dependency) or Avro / Protobuf (requires a Schema Registry, typically Confluent's). The downstream ClickHouse Kafka engine table accepts both via `kafka_format='JSONEachRow'` or `'AvroConfluent'`.

## Decision

JSON with `key.converter=org.apache.kafka.connect.json.JsonConverter` and `value.converter` set the same. No schema registry.

Settings live in `finwatch/debezium/connectors/finwatch-connector.json`:
```json
{"value.converter": "org.apache.kafka.connect.json.JsonConverter",
 "value.converter.schemas.enable": "false",
 "decimal.handling.mode": "string",
 "time.precision.mode": "connect"}
```

## Consequences

**Positive:**
- One fewer service to operate (no schema registry container, no separate auth surface).
- Payloads are human-readable in `docker exec kafka kafka-console-consumer` — invaluable during demo and debugging.
- ClickHouse's `JSONEachRow` is the simplest input format; no schema file management on the consumer side.

**Negative:**
- Schema is not enforced at the wire: if the application accidentally writes a new column type, downstream consumers see runtime errors rather than build-time errors.
- JSON is larger on the wire (~3-5x) than Avro for the same row. Within scope this is acceptable; for production multi-region traffic it would matter.
- No automatic schema evolution narrative — column adds work, but column type changes need manual coordination.

## Alternatives considered

- **Avro + Schema Registry** (rejected for scope): Better wire efficiency and compile-time guarantees, but operationally adds another service. The thesis explicitly favours operational simplicity over wire efficiency.
- **Protobuf**: same trade-off as Avro, plus the team has less Protobuf tooling familiarity.

## Future work

If FinWatch ever evolves beyond the thesis demo into a multi-team production deployment, switch to Avro with Schema Registry. The migration path is well-trodden:
- Add `schema-registry` service to `docker-compose.yml`.
- Change `value.converter` to `io.confluent.connect.avro.AvroConverter`.
- Change ClickHouse `kafka_format` to `AvroConfluent`.
- Update `kafka_schema_registry_url` setting on each Kafka engine table.

No application code changes needed.
