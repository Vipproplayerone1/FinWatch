-- ============================================
-- Kafka Engine: Fraud Alerts
-- ============================================
-- Debezium emits decimal as String and timestamps as Nullable(String) (ISO).
-- evidence is a JSONB column on the Postgres side; Debezium serialises it as
-- a JSON string, so the Kafka engine column is plain String here too.
CREATE TABLE IF NOT EXISTS finwatch.fraud_alerts_kafka (
    id              String,
    account_id      String,
    rule_code       String,
    severity        String,
    txn_count       String,
    total_amount    String,
    evidence        String,
    status          String,
    notes           Nullable(String),
    created_at      Nullable(String),
    resolved_at     Nullable(String),
    __deleted       Nullable(String),
    __op            String,
    __table         String,
    __source_ts_ms  Int64
) ENGINE = Kafka
SETTINGS
    kafka_broker_list = 'kafka:9092',
    kafka_topic_list = 'finwatch.public.fraud_alerts',
    kafka_group_name = 'clickhouse_fraud_alerts',
    kafka_format = 'JSONEachRow',
    kafka_num_consumers = 1,
    kafka_max_block_size = 65536,
    kafka_skip_broken_messages = 10;

-- ============================================
-- Target Table: Fraud Alerts (ReplacingMergeTree)
-- ============================================
CREATE TABLE IF NOT EXISTS finwatch.fraud_alerts (
    id              String,
    account_id      String,
    rule_code       LowCardinality(String),
    severity        LowCardinality(String),
    txn_count       UInt32,
    total_amount    Decimal(18, 2),
    evidence        String,
    status          LowCardinality(String),
    notes           Nullable(String),
    created_at      DateTime64(3, 'Asia/Ho_Chi_Minh'),
    resolved_at     Nullable(DateTime64(3, 'Asia/Ho_Chi_Minh')),
    cdc_op          LowCardinality(String),
    _source_ts_ms   Int64,
    _ingested_at    DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(_source_ts_ms)
PARTITION BY toYYYYMM(created_at)
ORDER BY (account_id, created_at, id)
SETTINGS index_granularity = 8192;

-- ============================================
-- MV: Fraud Alerts Kafka -> Target
-- ============================================
CREATE MATERIALIZED VIEW IF NOT EXISTS finwatch.fraud_alerts_mv
TO finwatch.fraud_alerts AS
SELECT
    id,
    account_id,
    rule_code,
    severity,
    toUInt32(txn_count)                              AS txn_count,
    toDecimal128(total_amount, 2)                    AS total_amount,
    evidence,
    status,
    notes,
    if(
        created_at IS NOT NULL AND created_at != '',
        parseDateTimeBestEffort(created_at),
        fromUnixTimestamp64Milli(__source_ts_ms)
    )                                                AS created_at,
    if(
        resolved_at IS NOT NULL AND resolved_at != '',
        parseDateTimeBestEffort(resolved_at),
        NULL
    )                                                AS resolved_at,
    __op                                             AS cdc_op,
    __source_ts_ms                                   AS _source_ts_ms
FROM finwatch.fraud_alerts_kafka;
