-- ============================================
-- FinWatch Fraud Workflow Layer
-- ============================================
-- Adds the fraud_alerts case log + replication hooks. The detection rules
-- still live in clickhouse/queries/anomaly_*.sql; this table is the
-- analyst-facing case shape that the fraud_alert_worker writes back into
-- Postgres so it round-trips through Debezium like the other CDC tables.

-- ============================================
-- FRAUD ALERTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS fraud_alerts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id      UUID NOT NULL REFERENCES accounts(id),
    rule_code       VARCHAR(32) NOT NULL
                    CHECK (rule_code IN ('VELOCITY','LARGE_AMT','MULTI_CCY','ZSCORE','HIGH_RISK','FAIL_SPIKE')),
    severity        VARCHAR(16) NOT NULL
                    CHECK (severity IN ('low','medium','high','critical')),
    txn_count       INT NOT NULL DEFAULT 0,
    total_amount    DECIMAL(18, 2) NOT NULL DEFAULT 0,
    evidence        JSONB NOT NULL DEFAULT '{}',
    status          VARCHAR(16) NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','closed_fraud','closed_clean')),
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_account_id  ON fraud_alerts(account_id);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_created_at  ON fraud_alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_dedup       ON fraud_alerts(account_id, rule_code, created_at);

-- ============================================
-- DEBEZIUM GRANTS
-- ============================================
-- ALL TABLES IN SCHEMA public already grants SELECT to debezium via 01_init_schema.sql,
-- but we make the new privileges explicit and additionally allow INSERT/UPDATE
-- since the fraud_alert_worker writes here (insert) and an analyst would later
-- close cases (update). Debezium itself only needs SELECT, but keeping the grant
-- shape uniform avoids surprises if we share the role across writers.
GRANT SELECT, INSERT, UPDATE ON fraud_alerts TO debezium;

-- ============================================
-- PUBLICATION
-- ============================================
ALTER PUBLICATION finwatch_pub ADD TABLE public.fraud_alerts;
