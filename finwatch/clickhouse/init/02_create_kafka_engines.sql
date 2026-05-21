-- ============================================
-- Kafka Engine: Transactions
-- ============================================
-- Note: Debezium with time.precision.mode=connect sends timestamps as ISO strings.
-- __source_ts_ms is epoch milliseconds (Int64).
CREATE TABLE IF NOT EXISTS finwatch.transactions_kafka (
    id              String,
    account_id      String,
    merchant_id     Nullable(String),
    amount          String,          -- Debezium sends decimal as string
    currency        String,
    type            String,
    status          String,
    description     Nullable(String),
    ip_address      Nullable(String),
    device_id       Nullable(String),
    created_at      Nullable(String),
    updated_at      Nullable(String),
    __deleted       Nullable(String),
    __op            String,
    __table         String,
    __source_ts_ms  Int64
) ENGINE = Kafka
SETTINGS
    kafka_broker_list = 'kafka:9092',
    kafka_topic_list = 'finwatch.public.transactions',
    kafka_group_name = 'clickhouse_transactions',
    kafka_format = 'JSONEachRow',
    kafka_num_consumers = 1,
    kafka_max_block_size = 65536,
    kafka_skip_broken_messages = 10;

-- ============================================
-- Kafka Engine: Accounts
-- ============================================
CREATE TABLE IF NOT EXISTS finwatch.accounts_kafka (
    id              String,
    full_name       String,
    email           String,
    phone           Nullable(String),
    balance         String,
    currency        String,
    status          String,
    created_at      Nullable(String),
    updated_at      Nullable(String),
    __deleted       Nullable(String),
    __op            String,
    __table         String,
    __source_ts_ms  Int64
) ENGINE = Kafka
SETTINGS
    kafka_broker_list = 'kafka:9092',
    kafka_topic_list = 'finwatch.public.accounts',
    kafka_group_name = 'clickhouse_accounts',
    kafka_format = 'JSONEachRow',
    kafka_num_consumers = 1,
    kafka_skip_broken_messages = 10;

-- ============================================
-- Kafka Engine: Merchants
-- ============================================
CREATE TABLE IF NOT EXISTS finwatch.merchants_kafka (
    id              String,
    name            String,
    category        String,
    mcc_code        Nullable(String),
    risk_level      String,
    country         String,
    created_at      Nullable(String),
    updated_at      Nullable(String),
    __deleted       Nullable(String),
    __op            String,
    __table         String,
    __source_ts_ms  Int64
) ENGINE = Kafka
SETTINGS
    kafka_broker_list = 'kafka:9092',
    kafka_topic_list = 'finwatch.public.merchants',
    kafka_group_name = 'clickhouse_merchants',
    kafka_format = 'JSONEachRow',
    kafka_num_consumers = 1,
    kafka_skip_broken_messages = 10;
