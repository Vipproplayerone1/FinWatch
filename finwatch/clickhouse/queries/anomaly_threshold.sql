-- ============================================
-- Rule: LARGE_AMT
-- Output: per-transaction rows where amount > 100M VND in the last hour.
--
-- Threat model:
--   Business Email Compromise (BEC) and CEO fraud, where the attacker
--   impersonates an executive and authorizes a one-shot wire transfer
--   to a controlled account. The signal is a single transaction whose
--   absolute amount is unusual for retail/SMB context.
--
-- Threshold justification:
--   - 100M VND ≈ 4,000 USD: above the SBV Circular 35/2018 reporting
--     threshold for VND-denominated suspicious-transaction reports
--     (200M VND single transaction), set conservatively so analysts see
--     candidates BEFORE the regulatory threshold to allow review.
--   - 1-hour window: most BEC transfers happen during business hours
--     and analysts triage within an hour; longer windows would
--     accumulate too many post-resolved cases.
--   - Evaluation (evaluation/report_*.md, seed=42): TP=10 / FP=0 / FN=0
--     on synthetic labelled data. Both wire-fraud (250M) and
--     account-takeover outlier (350M) victims correctly fire here.
--
-- Known evasions:
--   - Structuring: split a 250M transfer into three 90M transfers.
--     Compensating control: VELOCITY total_amount clause (50M / 5 min)
--     catches sequential splits; future work: explicit structuring
--     detection on (account, time-window) aggregates.
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
-- Rule: HIGH_RISK
-- Output: per-transaction rows joined to merchants where m.risk_level='high'.
--
-- Threat model:
--   Mule-account funneling: legitimate-looking accounts repeatedly
--   route value through shell merchants, sanctions-listed counterparties,
--   or known crypto-to-fiat off-ramps. The signal is the COUNTERPARTY,
--   not the amount or velocity — each individual transaction may look
--   ordinary in isolation.
--
-- Threshold justification:
--   - risk_level='high': curated label in the merchants table, set at
--     onboarding from external lists (OFAC, regional regulator
--     watchlists) and updated periodically. NOT a learned threshold —
--     a human-maintained classification.
--   - 1-hour window: matches LARGE_AMT for consistency. Short enough
--     that the same merchant appearing repeatedly within the window
--     is a stronger signal than a once-per-day occurrence.
--   - Evaluation (evaluation/report_*.md, seed=42): TP=5 / FP=0 / FN=0.
--
-- Known evasions:
--   - Layering through low/medium-risk intermediaries before reaching
--     the high-risk endpoint. Compensating control: MULTI_CCY catches
--     the currency-hopping variant; future work: graph-based merchant
--     risk propagation (transitive risk score).
--   - Merchant onboarding gap: if a high-risk entity is mislabelled
--     'low' at onboarding, this rule misses it. Compensating control:
--     periodic batch re-classification (out of scope for the streaming
--     pipeline).
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
-- Rule: MULTI_CCY
-- Output: account_id with >2 distinct currencies in any 10-min window.
--
-- Threat model:
--   The "layering" phase of money laundering — fragmenting a single
--   value across multiple currencies in rapid succession to obscure
--   the audit trail. A legitimate user in Vietnam rarely transacts
--   in 3+ currencies within minutes; typical retail behavior is
--   VND-dominant with occasional USD purchases.
--
-- Threshold justification:
--   - currency_count > 2: empirical floor — 1 currency is normal, 2 is
--     plausible (e.g. tourist buying USD then VND lunch), 3+ in 10 min
--     is highly anomalous for retail/SMB.
--   - 10-min window: long enough to capture multi-leg layering, short
--     enough to avoid lumping unrelated daily activity.
--   - Evaluation (evaluation/report_*.md, seed=42): TP=5 / FP=0 / FN=0.
--
-- Known evasions:
--   - Hop through 2 currencies per session, repeat across sessions
--     spaced > 10 min apart. Compensating control: VELOCITY across
--     longer windows; future work: session-level rather than
--     wall-clock-window aggregation.
--   - Use stable-coin proxies (crypto) for the leg the bank cannot
--     observe. Out of scope — the pipeline only sees bank-side legs.
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
-- Rule: FAIL_SPIKE
-- Output: account_id with >=3 failed txns AND fail_rate >50% in 30 min.
--
-- Threat model:
--   Card-testing — the attacker has a batch of stolen card numbers
--   (from a leak or skimmer) and probes them via small charges to find
--   which still work. The signal is a burst of declines / CVV
--   mismatches that wouldn't pattern-match velocity (low-amount, low
--   total) but DO concentrate the failure rate on one source.
--
-- Threshold justification:
--   - failed_count >= 3: absolute floor — one or two failures per
--     account is normal (typos, expired cards). Three in a 30-min
--     window starts to be unusual.
--   - fail_rate_pct > 50: rate guard — high absolute failure count
--     alone (e.g. 3 out of 100 legitimate retries) is not card-testing;
--     the SIGNATURE is that the attacker has nothing else going on,
--     so the failure rate dominates.
--   - 30-min window: short enough to catch the test campaign while
--     it is still active and stop it before the attacker abandons the
--     account.
--   - Evaluation (evaluation/report_*.md, seed=42): TP=5 / FP=0 / FN=0.
--
-- Known evasions:
--   - Interleave 1 successful charge per 1 failed charge to keep
--     fail_rate ≤ 50%. Compensating control: VELOCITY catches the
--     count burst (rule fires on either rate or count signal); future
--     work: declined-only velocity rule.
--   - Spread test charges across many victim accounts (one failure
--     each). Not caught — per-account aggregation. Future work:
--     per-merchant or per-source-IP failure spike.
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
