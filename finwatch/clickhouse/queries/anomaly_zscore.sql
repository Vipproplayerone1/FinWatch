-- ============================================
-- Rule: ZSCORE
-- Output: per-transaction rows where |amount - account_mean_30d| / std_30d > 3.
--
-- Threat model:
--   Account-takeover via compromised credentials. The attacker's behavior
--   (single huge transfer to a controlled destination) differs sharply
--   from the legitimate cardholder's historical pattern (many small
--   retail purchases). The rule asks: "is THIS transaction statistically
--   inconsistent with how this account normally behaves?"
--
-- Threshold justification:
--   - |z| > 3: the classical "three-sigma rule" — under a Gaussian
--     assumption, ~99.7% of values fall within ±3σ, so a z-score above
--     3 has < 0.3% expected legitimate occurrence. This is the textbook
--     statistical anomaly threshold (see e.g. Pukelsheim 1994,
--     "The three sigma rule", The American Statistician).
--   - txn_count_30d >= 5: refuses to compute z-scores for accounts with
--     too little history (avoids spurious flags on brand-new accounts).
--   - 30-day baseline: long enough to capture monthly salary / bill
--     cycles; short enough to adapt when the cardholder's behavior
--     genuinely shifts.
--   - Caveat: real txn amounts are log-normal, not Gaussian
--     (generate_transactions.py models this since the log-normal
--     migration). z-score is still informative as a rank statistic
--     under skewed distributions, but a log-transform variant would
--     be more rigorous — future work.
--   - Evaluation (evaluation/report_*.md, seed=42): TP=5 / FP=0 / FN=0
--     on synthetic labelled data with 20 backdated baseline txns per
--     victim. Treat this F1 as a floor — production accounts have
--     hundreds of historical txns, giving sharper stddev and likely
--     better recall.
--
-- Known evasions:
--   - Pre-warm the account with several large legitimate-looking
--     transactions to inflate the historical mean before the attack
--     (slow-burn ATO). Compensating control: VELOCITY would catch the
--     pre-warm burst if it happens in 5 min.
--   - Attacker chooses an amount close to the historical max
--     (|z| < 3 but still large). Compensating control: LARGE_AMT for
--     absolute thresholds.
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
