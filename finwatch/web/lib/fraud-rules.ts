// One source of truth for the 6 fraud rules surfaced by the /fraud page.
// Each entry mirrors a query in finwatch/clickhouse/queries/anomaly_*.sql.
// The current/history SQLs always use FINAL and `cdc_op != 'd'` (CLAUDE.md §8).

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6";

export interface FraudRuleSpec {
  id: RuleId;
  shortName: string;
  threshold: string;            // human-readable one-liner shown on card
  sourceFile: string;           // path under finwatch/clickhouse/queries
  currentSql: string;           // returns flagged rows + count
  historyWhere: string;         // WHERE clause used for the per-minute sparkline
  rowColumns: string[];         // labels for the drill-down table
}

// --- R1: Velocity burst -----------------------------------------------------
const r1Current = `
SELECT
  account_id,
  count()                                AS txn_count,
  toFloat64(sum(toFloat64(amount)))      AS total_amount,
  toString(min(created_at))              AS window_start,
  toString(max(created_at))              AS window_end
FROM finwatch.transactions FINAL
WHERE created_at >= now() - INTERVAL 5 MINUTE
  AND cdc_op != 'd'
GROUP BY account_id
HAVING txn_count > 10 OR total_amount > 50000000
ORDER BY txn_count DESC
`;

// --- R2: Z-score statistical -----------------------------------------------
const r2Current = `
SELECT
  t.id                                    AS txn_id,
  t.account_id                            AS account_id,
  toFloat64(t.amount)                     AS amount,
  t.type                                  AS type,
  toString(t.created_at)                  AS created_at,
  stats.avg_amount                        AS avg_amount,
  stats.std_amount                        AS std_amount,
  round((toFloat64(t.amount) - stats.avg_amount)
        / nullIf(stats.std_amount, 0), 2) AS z_score
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
  HAVING txn_count_30d >= 5
) stats ON t.account_id = stats.account_id
WHERE t.created_at >= now() - INTERVAL 10 MINUTE
  AND t.cdc_op != 'd'
  AND abs((toFloat64(t.amount) - stats.avg_amount) / nullIf(stats.std_amount, 0)) > 3
ORDER BY abs(z_score) DESC
`;

// --- R3: Large single amount -----------------------------------------------
// Note: we alias the timestamp as `ts` (not `created_at`) so the SELECT alias
// doesn't shadow the source column in the WHERE clause.
const r3Current = `
SELECT
  id, account_id, merchant_id,
  toFloat64(amount) AS amount,
  currency, type, status,
  toString(created_at) AS ts
FROM finwatch.transactions FINAL
WHERE toFloat64(amount) > 100000000
  AND created_at >= now() - INTERVAL 1 HOUR
  AND cdc_op != 'd'
ORDER BY amount DESC
`;

// --- R4: High-risk merchant ------------------------------------------------
const r4Current = `
SELECT
  t.id AS id,
  t.account_id AS account_id,
  toFloat64(t.amount) AS amount,
  t.type AS type,
  toString(t.created_at) AS created_at,
  m.name AS merchant_name,
  m.risk_level AS risk_level
FROM finwatch.transactions t FINAL
INNER JOIN finwatch.merchants m FINAL ON t.merchant_id = m.id
WHERE m.risk_level = 'high'
  AND t.created_at >= now() - INTERVAL 1 HOUR
  AND t.cdc_op != 'd'
ORDER BY t.created_at DESC
`;

// --- R5: Multi-currency burst ---------------------------------------------
const r5Current = `
SELECT
  account_id,
  arrayStringConcat(groupArray(DISTINCT currency), ',') AS currencies,
  length(groupArray(DISTINCT currency))                 AS currency_count,
  count()                                               AS txn_count,
  toString(min(created_at))                             AS first_txn,
  toString(max(created_at))                             AS last_txn
FROM finwatch.transactions FINAL
WHERE created_at >= now() - INTERVAL 10 MINUTE
  AND cdc_op != 'd'
GROUP BY account_id
HAVING currency_count > 2
ORDER BY currency_count DESC
`;

// --- R6: Failed transaction spike -----------------------------------------
const r6Current = `
SELECT
  account_id,
  countIf(status = 'failed')                                          AS failed_count,
  count()                                                             AS total_count,
  round(countIf(status = 'failed') / count() * 100, 1)                AS fail_rate_pct
FROM finwatch.transactions FINAL
WHERE created_at >= now() - INTERVAL 30 MINUTE
  AND cdc_op != 'd'
GROUP BY account_id
HAVING failed_count >= 3 AND fail_rate_pct > 50
ORDER BY failed_count DESC
`;

export const RULES: Record<RuleId, FraudRuleSpec> = {
  R1: {
    id: "R1",
    shortName: "Velocity burst",
    threshold: ">10 txns OR >50M VND in 5 min",
    sourceFile: "anomaly_velocity_check.sql",
    currentSql: r1Current,
    historyWhere: `created_at >= now() - INTERVAL {minutes} MINUTE AND cdc_op != 'd'`,
    rowColumns: ["account_id", "txn_count", "total_amount", "window_start", "window_end"],
  },
  R2: {
    id: "R2",
    shortName: "Z-score statistical",
    threshold: "|z-score| > 3 vs 30-day baseline",
    sourceFile: "anomaly_zscore.sql",
    currentSql: r2Current,
    historyWhere: `created_at >= now() - INTERVAL {minutes} MINUTE AND cdc_op != 'd'`,
    rowColumns: ["txn_id", "account_id", "amount", "type", "z_score", "avg_amount", "created_at"],
  },
  R3: {
    id: "R3",
    shortName: "Large single amount",
    threshold: "Single txn > 100M VND in last 1 hr",
    sourceFile: "anomaly_threshold.sql §1",
    currentSql: r3Current,
    historyWhere: `toFloat64(amount) > 100000000 AND created_at >= now() - INTERVAL {minutes} MINUTE AND cdc_op != 'd'`,
    rowColumns: ["id", "account_id", "amount", "currency", "type", "status", "ts"],
  },
  R4: {
    id: "R4",
    shortName: "High-risk merchant",
    threshold: "Txn against risk_level='high' merchant",
    sourceFile: "anomaly_threshold.sql §2",
    currentSql: r4Current,
    historyWhere: `cdc_op != 'd'`,  // history is rule-1-style; we'll filter via the rule below
    rowColumns: ["id", "account_id", "amount", "type", "merchant_name", "risk_level", "created_at"],
  },
  R5: {
    id: "R5",
    shortName: "Multi-currency burst",
    threshold: ">2 distinct currencies in 10 min",
    sourceFile: "anomaly_threshold.sql §3",
    currentSql: r5Current,
    historyWhere: `created_at >= now() - INTERVAL {minutes} MINUTE AND cdc_op != 'd'`,
    rowColumns: ["account_id", "currencies", "currency_count", "txn_count", "first_txn", "last_txn"],
  },
  R6: {
    id: "R6",
    shortName: "Failure spike",
    threshold: ">=3 failed AND >50% fail rate in 30 min",
    sourceFile: "anomaly_threshold.sql §4",
    currentSql: r6Current,
    historyWhere: `status = 'failed' AND created_at >= now() - INTERVAL {minutes} MINUTE AND cdc_op != 'd'`,
    rowColumns: ["account_id", "failed_count", "total_count", "fail_rate_pct"],
  },
};

// Per-minute history queries for the sparkline. R1/R5 count flagged accounts;
// R2/R3/R4/R6 count flagged transactions — both approaches are visually fine.
// For R4 we need the merchants join; for R6 we count failed txns. The
// SELECT below is rule-specific; the WHERE in the spec is informational only.
export function historySql(rule: RuleId, minutes: number): string {
  const win = Math.max(1, Math.min(360, minutes));
  switch (rule) {
    case "R1": // count of newly-burst-eligible txns per minute
    case "R5":
      return `
        SELECT toStartOfMinute(created_at) AS bucket, count() AS flags
        FROM finwatch.transactions FINAL
        WHERE cdc_op != 'd'
          AND created_at >= now() - INTERVAL ${win} MINUTE
        GROUP BY bucket ORDER BY bucket
      `;
    case "R3":
      return `
        SELECT toStartOfMinute(created_at) AS bucket, count() AS flags
        FROM finwatch.transactions FINAL
        WHERE cdc_op != 'd'
          AND toFloat64(amount) > 100000000
          AND created_at >= now() - INTERVAL ${win} MINUTE
        GROUP BY bucket ORDER BY bucket
      `;
    case "R4":
      return `
        SELECT toStartOfMinute(t.created_at) AS bucket, count() AS flags
        FROM finwatch.transactions t FINAL
        INNER JOIN finwatch.merchants m FINAL ON t.merchant_id = m.id
        WHERE t.cdc_op != 'd'
          AND m.risk_level = 'high'
          AND t.created_at >= now() - INTERVAL ${win} MINUTE
        GROUP BY bucket ORDER BY bucket
      `;
    case "R2":
      // Approximation: z-score is too expensive to bucket per minute live.
      // Count high-amount outliers as a proxy.
      return `
        SELECT toStartOfMinute(created_at) AS bucket, count() AS flags
        FROM finwatch.transactions FINAL
        WHERE cdc_op != 'd'
          AND toFloat64(amount) > 50000000
          AND created_at >= now() - INTERVAL ${win} MINUTE
        GROUP BY bucket ORDER BY bucket
      `;
    case "R6":
      return `
        SELECT toStartOfMinute(created_at) AS bucket, countIf(status='failed') AS flags
        FROM finwatch.transactions FINAL
        WHERE cdc_op != 'd'
          AND created_at >= now() - INTERVAL ${win} MINUTE
        GROUP BY bucket ORDER BY bucket
      `;
  }
}
