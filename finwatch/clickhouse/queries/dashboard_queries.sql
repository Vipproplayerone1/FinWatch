-- ============================================
-- Dashboard: Real-time transaction volume (last 1 hour, per minute)
-- ============================================
SELECT
    toStartOfMinute(created_at) AS minute,
    count()                     AS txn_count,
    sum(toFloat64(amount))      AS total_amount,
    countIf(status = 'failed')  AS failed_count,
    countIf(status = 'flagged') AS flagged_count
FROM finwatch.transactions FINAL
WHERE created_at >= now() - INTERVAL 1 HOUR
  AND cdc_op != 'd'
GROUP BY minute
ORDER BY minute;

-- ============================================
-- Dashboard: Transaction type breakdown
-- ============================================
SELECT
    type,
    count()                AS txn_count,
    sum(toFloat64(amount)) AS total_amount,
    avg(toFloat64(amount)) AS avg_amount
FROM finwatch.transactions FINAL
WHERE created_at >= now() - INTERVAL 24 HOUR
  AND cdc_op != 'd'
GROUP BY type
ORDER BY txn_count DESC;

-- ============================================
-- Dashboard: Top merchants by volume
-- ============================================
SELECT
    m.name,
    m.category,
    m.risk_level,
    count()                  AS txn_count,
    sum(toFloat64(t.amount)) AS total_amount
FROM finwatch.transactions t FINAL
INNER JOIN finwatch.merchants m FINAL ON t.merchant_id = m.id
WHERE t.created_at >= now() - INTERVAL 24 HOUR
  AND t.cdc_op != 'd'
GROUP BY m.name, m.category, m.risk_level
ORDER BY total_amount DESC
LIMIT 20;

-- ============================================
-- Dashboard: Pipeline health -- ingestion lag
-- ============================================
SELECT
    toStartOfMinute(_ingested_at) AS ingested_minute,
    count()                       AS rows_ingested,
    avg(dateDiff('millisecond',
        created_at,
        _ingested_at
    ))                            AS avg_lag_ms,
    max(dateDiff('millisecond',
        created_at,
        _ingested_at
    ))                            AS max_lag_ms
FROM finwatch.transactions
WHERE _ingested_at >= now() - INTERVAL 1 HOUR
GROUP BY ingested_minute
ORDER BY ingested_minute;
