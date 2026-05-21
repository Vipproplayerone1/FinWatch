-- ============================================
-- Velocity Check: Accounts with >10 txns in 5 minutes
-- or >50M VND total in 5 minutes
-- ============================================
SELECT
    account_id,
    count()                     AS txn_count,
    sum(toFloat64(amount))      AS total_amount,
    min(created_at)             AS window_start,
    max(created_at)             AS window_end,
    dateDiff('second', min(created_at), max(created_at)) AS window_seconds,
    groupArray(type)            AS txn_types,
    groupArray(status)          AS txn_statuses
FROM finwatch.transactions FINAL
WHERE created_at >= now() - INTERVAL 5 MINUTE
  AND cdc_op != 'd'
GROUP BY account_id
HAVING txn_count > 10 OR total_amount > 50000000
ORDER BY txn_count DESC;
