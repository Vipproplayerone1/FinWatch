# FinWatch System Architecture

## High-Level Architecture

```
                          FinWatch Architecture
   ┌─────────────────────────────────────────────────────────────┐
   │                                                             │
   │  ┌──────────┐    ┌──────────┐    ┌───────┐    ┌──────────┐│
   │  │PostgreSQL │───>│ Debezium │───>│ Kafka │───>│ClickHouse││
   │  │  (OLTP)  │CDC │(Connect) │    │       │    │  (OLAP)  ││
   │  └──────────┘    └──────────┘    └───────┘    └──────────┘│
   │       │                              │              │      │
   │       │                              │              │      │
   │       │                                        ┌────┴───┐ │
   │       │                                        │Grafana │ │
   │       │                                        └────────┘ │
   │       │                                                   │
   │       │         ┌────────────┐                             │
   │       └────────>│ Prometheus │─────────> Grafana           │
   │                 └────────────┘                             │
   └─────────────────────────────────────────────────────────────┘
```

## Component Descriptions

### PostgreSQL (Source Database)
- **Role:** OLTP source database storing accounts, merchants, and transactions.
- **CDC Support:** WAL-level set to `logical` with a publication (`finwatch_pub`) for the three core tables.
- **Dedicated CDC User:** A `debezium` role with `REPLICATION` and `SELECT` privileges.

### Debezium (Change Data Capture)
- **Role:** Captures row-level changes from PostgreSQL's WAL using the `pgoutput` plugin.
- **Output:** Produces JSON events (via `ExtractNewRecordState` SMT) to Kafka topics.
- **Topics Created:** `finwatch.public.accounts`, `finwatch.public.merchants`, `finwatch.public.transactions`.
- **Snapshot:** On first run, performs an initial snapshot of all existing data.

### Apache Kafka (Event Streaming)
- **Role:** Distributed, fault-tolerant message broker decoupling producers (Debezium) from consumers (ClickHouse).
- **Partitions:** Auto-created topics with default partitioning.
- **Delivery Semantics:** At-least-once delivery; deduplication handled downstream.

### ClickHouse (Analytics Database)
- **Role:** Columnar OLAP database for sub-second analytical queries.
- **Ingestion Pattern:**
  1. **Kafka Engine tables** consume from Kafka topics.
  2. **Materialized Views** transform and route data to target tables.
  3. **ReplacingMergeTree tables** store final data with deduplication.

### Grafana
- **Role:** Technical monitoring dashboards using ClickHouse and Prometheus datasources.
- **Provisioned:** Datasources for ClickHouse and Prometheus auto-configured.

### Prometheus
- **Role:** Metrics collection from ClickHouse. Kafka and Debezium would need a JMX-to-Prometheus exporter sidecar to scrape (not configured).

### FinWatch Web UI (live demo dashboard)
- **Role:** Single-page Next.js 14 dashboard purpose-built for thesis demos. Sits beside Grafana but is tuned for **visual storytelling in front of an audience** rather than long-tail analytics.
- **Port:** `${WEB_PORT:-3002}` (default 3002).
- **Data path:** Browser polls Next.js API routes (1–2 s) → server-side `@clickhouse/client` queries ClickHouse HTTP on `clickhouse:8123` over the internal `finwatch-net`. No direct browser → ClickHouse calls, so credentials stay server-side and there's no CORS to manage.
- **Surfaces:** (1) animated PG → Debezium → Kafka → ClickHouse flow, (2) latency / TPS / total KPIs, (3) TPS sparkline over the last 60 s, (4) live transaction stream with merchant/account enrichment, (5) fraud alert feed combining the velocity, large-amount, multi-currency, and z-score rules from `clickhouse/queries/anomaly_*.sql`.
- **Source location:** `finwatch/web/` — see its `README.md` for local-dev instructions.

## Data Flow

```
1. Application writes to PostgreSQL (INSERT/UPDATE/DELETE)
2. PostgreSQL writes to WAL (Write-Ahead Log)
3. Debezium reads WAL via logical replication slot
4. Debezium transforms change events using ExtractNewRecordState SMT
5. Events published to Kafka topics as JSON
6. ClickHouse Kafka Engine tables consume events
7. Materialized Views parse and transform events:
   - String timestamps → DateTime64 via parseDateTimeBestEffort()
   - String decimals → Decimal128
8. Data lands in ReplacingMergeTree target tables
9. Dashboards query ClickHouse using FINAL keyword for deduplication
```

## Serialization Format

**JSON (without schema)** is used throughout the pipeline:
- **Debezium → Kafka:** `JsonConverter` with `schemas.enable=false`
- **Kafka → ClickHouse:** `JSONEachRow` format in Kafka Engine
- **Rationale:** Simplifies development and debugging. Switching to Avro for schema evolution and smaller payloads would require adding a schema registry and updating all `kafka_format` settings — out of scope.

## Deduplication Strategy

ClickHouse uses **ReplacingMergeTree** engine with `_source_ts_ms` as the version column:
- On background merges, ClickHouse keeps only the row with the highest `_source_ts_ms` per primary key.
- Queries use the `FINAL` keyword to get deduplicated results before merges complete.
- This handles at-least-once delivery from Kafka and CDC update events.

## Fraud workflow layer

On top of the pipeline, FinWatch adds a closed **detect → action → reject** loop so the
demo behaves like a real fraud-monitoring system, not just a CDC showcase.

**Moving parts:**

1. **`fraud_alerts` table** (Postgres) — an immutable case log:
   `id, account_id, rule_code, severity, txn_count, total_amount, evidence (JSONB),
   status (open/closed_fraud/closed_clean), notes, created_at, resolved_at`.
   Replicated through Debezium → Kafka → ClickHouse exactly like the other three
   tables. See `postgres/init/02_fraud_workflow.sql` and `clickhouse/init/05_fraud_alerts.sql`.

2. **`fraud_alert_worker.py`** — every 30 s, runs the six existing
   `clickhouse/queries/anomaly_*.sql` queries against ClickHouse, classifies severity per
   rule, aggregates rows by `account_id`, and inserts new cases into Postgres
   `fraud_alerts`. Dedup window: 1 hour per `(account_id, rule_code)`.

3. **Application-layer balance ledger** — `accounts.balance` is updated inside every
   transaction-creating code path (`/api/insert-transaction`,
   `scripts/generate_transactions.py`, `scripts/simulate_fraud.py`) using
   `SELECT … FOR UPDATE` on the account row. Suspended/closed accounts → the txn lands
   as `status='failed'`, description `rejected: account <status>`. Debit with insufficient
   balance → `status='failed'`, description `insufficient funds`. The ledger is enforced
   in application code rather than a Postgres trigger so the simulator (which inserts
   directly to PG, bypassing the API) follows the same rules.

4. **Lock / unlock UI** — `/accounts/[id]` shows balance, status, last 20 txns and last 20
   alerts. **Suspend** / **Reactivate** buttons call `POST /api/accounts/[id]/lock` and
   `/unlock`, which flip `accounts.status`. Within ~1 s, all three transaction-creating
   paths refuse to insert `completed` rows for that account.

**Closed-loop sequence:**

```mermaid
sequenceDiagram
    autonumber
    participant Client as Generator / simulator / UI
    participant API as /api/insert-transaction
    participant PG as Postgres (accounts, transactions, fraud_alerts)
    participant Dbz as Debezium → Kafka
    participant CH as ClickHouse (FINAL views)
    participant W as fraud_alert_worker
    participant Analyst as Analyst (/accounts/[id])

    Client->>API: insert(account, amount, type)
    API->>PG: BEGIN; SELECT balance,status FROM accounts FOR UPDATE
    alt status != active
        API->>PG: INSERT txn (status='failed', desc='rejected: account ...')
    else debit & balance < amount
        API->>PG: INSERT txn (status='failed', desc='insufficient funds')
    else accepted
        API->>PG: INSERT txn (status='completed') ; UPDATE accounts SET balance=balance±amount
    end
    PG-->>API: COMMIT
    PG->>Dbz: WAL change events
    Dbz->>CH: JSON event into transactions_kafka → mv → transactions
    Note over W,CH: every 30 s
    W->>CH: anomaly_*.sql (FINAL, cdc_op != 'd')
    CH-->>W: candidate rows
    W->>PG: INSERT INTO fraud_alerts (dedup by (account_id, rule_code, 1h))
    PG->>Dbz: WAL change event
    Dbz->>CH: fraud_alerts_kafka → mv → fraud_alerts
    Analyst->>CH: GET /accounts/[id]/alerts (FINAL)
    Analyst->>API: POST /api/accounts/[id]/lock
    API->>PG: UPDATE accounts SET status='suspended'
    Note over Client,PG: All three insert paths now route this account's txns to status='failed'.
```

## Fault Tolerance

| Component | Recovery Mechanism |
|---|---|
| PostgreSQL | WAL persists changes; replication slot tracks Debezium position |
| Debezium | Stores offsets in Kafka internal topics; resumes from last committed offset |
| Kafka | Replicated log (single-node in dev); consumer group offsets tracked |
| ClickHouse | Kafka consumer group offsets; ReplacingMergeTree handles duplicates |

## Security Considerations

- Dedicated `debezium` user with minimal privileges (SELECT + REPLICATION only)
- Passwords stored in `.env` file (excluded from version control via `.gitignore`)
- Internal Docker network (`finwatch-net`) isolates services
- No external ports exposed except for development access
