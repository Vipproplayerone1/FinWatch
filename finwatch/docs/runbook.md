# FinWatch Operational Runbook

## Starting and Stopping

### Start the full stack
```bash
cd finwatch
docker compose up -d
# Wait for services to be ready (~60s)
python scripts/wait_for_services.py
```

### Stop the stack (preserve data)
```bash
docker compose down
```

### Stop the stack (destroy data)
```bash
docker compose down -v
```

### Restart a single service
```bash
docker compose restart <service>
# e.g., docker compose restart clickhouse
```

## Checking Connector Status

```bash
# List all connectors
curl http://localhost:8083/connectors

# Detailed status
curl http://localhost:8083/connectors/finwatch-connector/status | python -m json.tool

# Expected: connector.state = "RUNNING", tasks[0].state = "RUNNING"
```

### Re-register connector after failure
```bash
python scripts/wait_for_services.py
```

### Delete and recreate connector
```bash
curl -X DELETE http://localhost:8083/connectors/finwatch-connector
python scripts/wait_for_services.py
```

## Handling Replication Slot Growth

PostgreSQL retains WAL segments as long as Debezium's replication slot is active. If Debezium is down for an extended period, WAL can grow unbounded.

### Check replication slot status
```bash
docker exec finwatch-postgres psql -U finwatch -d finwatch -c \
  "SELECT slot_name, active, restart_lsn, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag FROM pg_replication_slots;"
```

### If WAL is too large and Debezium is permanently down
```bash
# Drop the replication slot (WARNING: loses CDC position)
docker exec finwatch-postgres psql -U finwatch -d finwatch -c \
  "SELECT pg_drop_replication_slot('finwatch_slot');"

# Then re-register the connector (will do a new initial snapshot)
python scripts/wait_for_services.py
```

## Recovery Procedures

### Debezium Failure Recovery
1. Check logs: `docker compose logs debezium --tail 100`
2. Restart: `docker compose restart debezium`
3. Verify connector: `curl http://localhost:8083/connectors/finwatch-connector/status`
4. If connector is FAILED, re-register: `python scripts/wait_for_services.py`

### Kafka Failure Recovery
1. Check logs: `docker compose logs kafka --tail 100`
2. Restart: `docker compose restart kafka`
3. Wait for Kafka to be healthy: `docker compose ps`
4. Restart Debezium (reconnects to Kafka): `docker compose restart debezium`
5. ClickHouse Kafka engines auto-reconnect

### ClickHouse Failure Recovery
1. Check logs: `docker compose logs clickhouse --tail 100`
2. Restart: `docker compose restart clickhouse`
3. Kafka Engine tables resume from last committed consumer offset
4. Verify data: `docker exec finwatch-clickhouse clickhouse-client -q "SELECT count() FROM finwatch.transactions FINAL"`

### Full Pipeline Reset
```bash
# Stop everything and destroy volumes
docker compose down -v

# Start fresh
docker compose up -d
sleep 60
python scripts/wait_for_services.py

# Verify
docker exec finwatch-clickhouse clickhouse-client -q "SELECT count() FROM finwatch.merchants FINAL"
# Expected: 12
```

## Common Error Messages

| Error | Cause | Solution |
|---|---|---|
| `Connection to postgres:5432 refused` | PostgreSQL not listening on 0.0.0.0 | Ensure `listen_addresses = '*'` in postgresql.conf |
| `Replication slot "finwatch_slot" already exists` | Previous connector instance | Delete old connector, then re-register |
| `Topic finwatch.public.transactions not found` | No transactions inserted yet | Insert a transaction to auto-create the topic |
| `Cannot read from Kafka: ...broker not available` | Kafka not ready | Wait for Kafka healthcheck, restart ClickHouse |
| `FINAL keyword` performance warning | Large table scans | Expected behavior; use time-range filters to limit scope |

## Adding New Tables to CDC

1. **PostgreSQL:** Create the table and add it to the publication:
   ```sql
   ALTER PUBLICATION finwatch_pub ADD TABLE new_table;
   GRANT SELECT ON new_table TO debezium;
   ```

2. **Debezium:** Update the connector config to include the new table:
   ```bash
   curl -X PUT http://localhost:8083/connectors/finwatch-connector/config \
     -H "Content-Type: application/json" \
     -d '{ ... "table.include.list": "public.accounts,public.merchants,public.transactions,public.new_table" ... }'
   ```

3. **ClickHouse:** Create Kafka engine, target table, and materialized view following the patterns in `clickhouse/init/`.

## Useful Commands

### Check Kafka topic lag
```bash
docker exec finwatch-kafka kafka-consumer-groups --bootstrap-server kafka:9092 --describe --all-groups
```

### View recent Kafka messages
```bash
docker exec finwatch-kafka kafka-console-consumer \
  --bootstrap-server kafka:9092 \
  --topic finwatch.public.transactions \
  --from-beginning --max-messages 5
```

### Check ClickHouse ingestion
```bash
docker exec finwatch-clickhouse clickhouse-client -q \
  "SELECT count(), max(_ingested_at) FROM finwatch.transactions"
```

### Generate test data
```bash
python scripts/generate_transactions.py --count 1000 --tps 100
python scripts/simulate_fraud.py --pattern all
```
