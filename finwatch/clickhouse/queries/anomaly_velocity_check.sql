-- ============================================
-- Rule: VELOCITY
-- Output: account_id flagged when count(txn) > 10 OR sum(amount) > 50M VND
--         within a rolling 5-minute window.
--
-- Threat model:
--   Card-cloning / skimmer attacks where the attacker rushes to drain
--   the balance with many rapid micro-purchases before the cardholder
--   notices and the bank revokes the card. The `OR amount > 50M` clause
--   also catches a single large transfer (BEC/wire fraud) within the
--   same 5-min window — these overlap with LARGE_AMT by design.
--
-- Threshold justification:
--   - txn_count > 10 / 5 min: a legitimate retail customer almost never
--     exceeds ~2 purchases per minute. SBV Circular 35/2018 on
--     suspicious transaction reporting cites "unusually frequent
--     activity" as a flag. 10 in 5 min ≈ one every 30 s — well above
--     legitimate retail behavior.
--   - total_amount > 50M VND / 5 min: ~2,000 USD aggregate in 5 minutes
--     is high-velocity by VND retail standards; the threshold is below
--     LARGE_AMT (100M) so this rule can catch SPLIT large transfers
--     that would individually evade LARGE_AMT.
--   - Evaluation (evaluation/report_*.md, seed=42): TP=15 / FP=0 / FN=0
--     on synthetic labelled data; macro-F1 = 1.000. Note that wire-fraud
--     and account-takeover outlier victims also correctly fire this
--     rule (overlap, not false positives).
--
-- Known evasions:
--   - Spread purchases across >5 min windows (sub-threshold velocity).
--     Compensating control: HIGH_RISK catches the merchant signal;
--     ZSCORE catches amount deviation vs history.
--   - Split a single large transfer across multiple low-risk accounts
--     (smurfing). Not caught by this rule — future work: structuring
--     detection at the destination-account level.
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
