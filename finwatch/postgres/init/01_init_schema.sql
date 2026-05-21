-- ============================================
-- FinWatch Database Schema
-- ============================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- ACCOUNTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS accounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name       VARCHAR(255) NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    phone           VARCHAR(20),
    balance         DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    currency        VARCHAR(3) NOT NULL DEFAULT 'VND',
    status          VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'closed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- MERCHANTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS merchants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(255) NOT NULL,
    category        VARCHAR(100) NOT NULL,
    mcc_code        VARCHAR(4),
    risk_level      VARCHAR(20) NOT NULL DEFAULT 'low'
                    CHECK (risk_level IN ('low', 'medium', 'high')),
    country         VARCHAR(3) NOT NULL DEFAULT 'VN',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- TRANSACTIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id      UUID NOT NULL REFERENCES accounts(id),
    merchant_id     UUID REFERENCES merchants(id),
    amount          DECIMAL(18, 2) NOT NULL,
    currency        VARCHAR(3) NOT NULL DEFAULT 'VND',
    type            VARCHAR(20) NOT NULL
                    CHECK (type IN ('purchase', 'transfer', 'withdrawal', 'refund', 'deposit')),
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'failed', 'flagged')),
    description     TEXT,
    metadata        JSONB DEFAULT '{}',
    ip_address      VARCHAR(45),
    device_id       VARCHAR(100),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX idx_transactions_account_id ON transactions(account_id);
CREATE INDEX idx_transactions_merchant_id ON transactions(merchant_id);
CREATE INDEX idx_transactions_created_at ON transactions(created_at);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_type ON transactions(type);
CREATE INDEX idx_accounts_status ON accounts(status);
CREATE INDEX idx_merchants_risk_level ON merchants(risk_level);

-- ============================================
-- UPDATED_AT TRIGGER
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_accounts_updated_at
    BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_merchants_updated_at
    BEFORE UPDATE ON merchants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_transactions_updated_at
    BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- DEBEZIUM USER & PUBLICATION
-- ============================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'debezium') THEN
        CREATE ROLE debezium WITH LOGIN PASSWORD 'debezium_secret_2024' REPLICATION;
    END IF;
END
$$;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO debezium;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO debezium;

-- Publication for CDC
CREATE PUBLICATION finwatch_pub FOR TABLE accounts, merchants, transactions;

-- ============================================
-- SEED DATA: Merchants
-- ============================================
INSERT INTO merchants (name, category, mcc_code, risk_level, country) VALUES
    ('VinMart', 'grocery', '5411', 'low', 'VN'),
    ('Shopee Vietnam', 'e-commerce', '5999', 'medium', 'VN'),
    ('Grab Vietnam', 'ride-hailing', '4121', 'low', 'VN'),
    ('Tiki', 'e-commerce', '5999', 'medium', 'VN'),
    ('Circle K Vietnam', 'convenience', '5411', 'low', 'VN'),
    ('FPT Shop', 'electronics', '5732', 'medium', 'VN'),
    ('The Gioi Di Dong', 'electronics', '5732', 'medium', 'VN'),
    ('Highland Coffee', 'food-beverage', '5812', 'low', 'VN'),
    ('Online Casino XYZ', 'gambling', '7995', 'high', 'KH'),
    ('CryptoExchange ABC', 'crypto', '6051', 'high', 'SG'),
    ('Lotte Mart', 'grocery', '5411', 'low', 'VN'),
    ('Be Group', 'ride-hailing', '4121', 'low', 'VN')
ON CONFLICT DO NOTHING;

-- ============================================
-- SEED DATA: Accounts
-- ============================================
INSERT INTO accounts (full_name, email, phone, balance, currency, status) VALUES
    ('Nguyen Van A', 'nguyenvana@email.com', '0901234567', 50000000.00, 'VND', 'active'),
    ('Tran Thi B', 'tranthib@email.com', '0912345678', 120000000.00, 'VND', 'active'),
    ('Le Van C', 'levanc@email.com', '0923456789', 8000000.00, 'VND', 'active'),
    ('Pham Thi D', 'phamthid@email.com', '0934567890', 250000000.00, 'VND', 'active'),
    ('Hoang Van E', 'hoangvane@email.com', '0945678901', 15000000.00, 'VND', 'active'),
    ('Vo Thi F', 'vothif@email.com', '0956789012', 75000000.00, 'VND', 'active'),
    ('Dang Van G', 'dangvang@email.com', '0967890123', 3000000.00, 'VND', 'active'),
    ('Bui Thi H', 'buithih@email.com', '0978901234', 500000000.00, 'VND', 'active'),
    ('Do Van I', 'dovani@email.com', '0989012345', 42000000.00, 'VND', 'active'),
    ('Ngo Thi K', 'ngothik@email.com', '0990123456', 95000000.00, 'VND', 'active')
ON CONFLICT DO NOTHING;
