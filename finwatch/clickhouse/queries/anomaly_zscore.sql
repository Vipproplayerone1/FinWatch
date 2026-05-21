-- ============================================
-- Z-Score Anomaly: Transactions deviating >3 sigma
-- from account's 30-day average
-- ============================================
SELECT
    t.id,
    t.account_id,
    t.amount,
    t.type,
    t.merchant_id,
    t.created_at,
    stats.avg_amount,
    stats.std_amount,
    stats.txn_count_30d,
    round((toFloat64(t.amount) - stats.avg_amount)
        / nullIf(stats.std_amount, 0), 2)   AS z_score
FROM finwatch.transactions t FINAL
INNER JOIN (
    SELECT
        account_id,
        avg(toFloat64(amount))       AS avg_amount,
        stddevPop(toFloat64(amount)) AS std_amount,
        count()                      AS txn_count_30d
    FROM finwatch.transactions FINAL
    WHERE created_at >= now() - INTERVAL 30 DAY
      AND cdc_op != 'd'
    GROUP BY account_id
    HAVING txn_count_30d >= 5   -- need enough history
) stats ON t.account_id = stats.account_id
WHERE t.created_at >= now() - INTERVAL 10 MINUTE
  AND t.cdc_op != 'd'
  AND abs((toFloat64(t.amount) - stats.avg_amount)
        / nullIf(stats.std_amount, 0)) > 3
ORDER BY abs(z_score) DESC;
