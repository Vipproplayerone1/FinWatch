-- ============================================
-- MV: Transactions Kafka -> Target
-- ============================================
-- Debezium sends timestamps as ISO strings (time.precision.mode=connect)
-- and decimals as strings (decimal.handling.mode=string).
CREATE MATERIALIZED VIEW IF NOT EXISTS finwatch.transactions_mv
TO finwatch.transactions AS
SELECT
    id,
    account_id,
    merchant_id,
    toDecimal128(amount, 2)                         AS amount,
    currency,
    type,
    status,
    description,
    ip_address,
    device_id,
    if(
        created_at IS NOT NULL AND created_at != '',
        parseDateTimeBestEffort(created_at),
        fromUnixTimestamp64Milli(__source_ts_ms)
    )                                               AS created_at,
    if(
        updated_at IS NOT NULL AND updated_at != '',
        parseDateTimeBestEffort(updated_at),
        fromUnixTimestamp64Milli(__source_ts_ms)
    )                                               AS updated_at,
    __op                                            AS cdc_op,
    __source_ts_ms                                  AS _source_ts_ms
FROM finwatch.transactions_kafka;

-- ============================================
-- MV: Accounts Kafka -> Target
-- ============================================
CREATE MATERIALIZED VIEW IF NOT EXISTS finwatch.accounts_mv
TO finwatch.accounts AS
SELECT
    id,
    full_name,
    email,
    phone,
    toDecimal128(balance, 2)                        AS balance,
    currency,
    status,
    if(
        created_at IS NOT NULL AND created_at != '',
        parseDateTimeBestEffort(created_at),
        fromUnixTimestamp64Milli(__source_ts_ms)
    )                                               AS created_at,
    if(
        updated_at IS NOT NULL AND updated_at != '',
        parseDateTimeBestEffort(updated_at),
        fromUnixTimestamp64Milli(__source_ts_ms)
    )                                               AS updated_at,
    __op                                            AS cdc_op,
    __source_ts_ms                                  AS _source_ts_ms
FROM finwatch.accounts_kafka;

-- ============================================
-- MV: Merchants Kafka -> Target
-- ============================================
CREATE MATERIALIZED VIEW IF NOT EXISTS finwatch.merchants_mv
TO finwatch.merchants AS
SELECT
    id,
    name,
    category,
    mcc_code,
    risk_level,
    country,
    if(
        created_at IS NOT NULL AND created_at != '',
        parseDateTimeBestEffort(created_at),
        fromUnixTimestamp64Milli(__source_ts_ms)
    )                                               AS created_at,
    if(
        updated_at IS NOT NULL AND updated_at != '',
        parseDateTimeBestEffort(updated_at),
        fromUnixTimestamp64Milli(__source_ts_ms)
    )                                               AS updated_at,
    __op                                            AS cdc_op,
    __source_ts_ms                                  AS _source_ts_ms
FROM finwatch.merchants_kafka;
