-- ============================================
-- Target Table: Transactions (ReplacingMergeTree)
-- ============================================
CREATE TABLE IF NOT EXISTS finwatch.transactions (
    id              String,
    account_id      String,
    merchant_id     Nullable(String),
    amount          Decimal(18, 2),
    currency        LowCardinality(String),
    type            LowCardinality(String),
    status          LowCardinality(String),
    description     Nullable(String),
    ip_address      Nullable(String),
    device_id       Nullable(String),
    created_at      DateTime64(3, 'Asia/Ho_Chi_Minh'),
    updated_at      DateTime64(3, 'Asia/Ho_Chi_Minh'),
    cdc_op          LowCardinality(String),
    _source_ts_ms   Int64,
    _ingested_at    DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(_source_ts_ms)
PARTITION BY toYYYYMM(created_at)
ORDER BY (account_id, created_at, id)
SETTINGS index_granularity = 8192;

-- ============================================
-- Target Table: Accounts
-- ============================================
CREATE TABLE IF NOT EXISTS finwatch.accounts (
    id              String,
    full_name       String,
    email           String,
    phone           Nullable(String),
    balance         Decimal(18, 2),
    currency        LowCardinality(String),
    status          LowCardinality(String),
    created_at      DateTime64(3, 'Asia/Ho_Chi_Minh'),
    updated_at      DateTime64(3, 'Asia/Ho_Chi_Minh'),
    cdc_op          LowCardinality(String),
    _source_ts_ms   Int64,
    _ingested_at    DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(_source_ts_ms)
ORDER BY id
SETTINGS index_granularity = 8192;

-- ============================================
-- Target Table: Merchants
-- ============================================
CREATE TABLE IF NOT EXISTS finwatch.merchants (
    id              String,
    name            String,
    category        LowCardinality(String),
    mcc_code        Nullable(String),
    risk_level      LowCardinality(String),
    country         LowCardinality(String),
    created_at      DateTime64(3, 'Asia/Ho_Chi_Minh'),
    updated_at      DateTime64(3, 'Asia/Ho_Chi_Minh'),
    cdc_op          LowCardinality(String),
    _source_ts_ms   Int64,
    _ingested_at    DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(_source_ts_ms)
ORDER BY id
SETTINGS index_granularity = 8192;
