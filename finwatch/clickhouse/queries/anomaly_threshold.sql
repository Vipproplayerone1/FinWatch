-- ============================================
-- Rule 1: Large single transaction (>100M VND)
-- ============================================
SELECT
    id, account_id, merchant_id,
    amount, currency, type, status, created_at
FROM finwatch.transactions FINAL
WHERE toFloat64(amount) > 100000000
  AND created_at >= now() - INTERVAL 1 HOUR
  AND cdc_op != 'd'
ORDER BY amount DESC;

-- ============================================
-- Rule 2: High-risk merchant transactions
-- ============================================
SELECT
    t.id, t.account_id, t.amount, t.type, t.created_at,
    m.name AS merchant_name, m.risk_level
FROM finwatch.transactions t FINAL
INNER JOIN finwatch.merchants m FINAL ON t.merchant_id = m.id
WHERE m.risk_level = 'high'
  AND t.created_at >= now() - INTERVAL 1 HOUR
  AND t.cdc_op != 'd'
ORDER BY t.created_at DESC;

-- ============================================
-- Rule 3: Multi-currency in short window
-- ============================================
SELECT
    account_id,
    groupArray(DISTINCT currency)        AS currencies,
    length(groupArray(DISTINCT currency)) AS currency_count,
    count()                              AS txn_count,
    min(created_at)                      AS first_txn,
    max(created_at)                      AS last_txn
FROM finwatch.transactions FINAL
WHERE created_at >= now() - INTERVAL 10 MINUTE
  AND cdc_op != 'd'
GROUP BY account_id
HAVING currency_count > 2
ORDER BY currency_count DESC;

-- ============================================
-- Rule 4: Failed transaction spike
-- ============================================
SELECT
    account_id,
    countIf(status = 'failed')          AS failed_count,
    count()                             AS total_count,
    round(countIf(status = 'failed') / count() * 100, 1) AS fail_rate_pct
FROM finwatch.transactions FINAL
WHERE created_at >= now() - INTERVAL 30 MINUTE
  AND cdc_op != 'd'
GROUP BY account_id
HAVING failed_count >= 3 AND fail_rate_pct > 50
ORDER BY failed_count DESC;
