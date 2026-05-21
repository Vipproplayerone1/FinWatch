import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// UNION ALL of the six anomaly rules from clickhouse/queries/anomaly_*.sql,
// tagged with rule + severity for the AlertFeed component. One UNION branch
// per fraud typology that the simulator (scripts/simulate_fraud.py) can produce.
//
// Rules:
//   VELOCITY   — >10 txns or >50M VND in 5 min          (anomaly_velocity_check.sql)
//   LARGE_AMT  — single txn >100M VND in last 10 min    (anomaly_threshold.sql rule 1)
//   MULTI_CCY  — >2 distinct currencies in 10 min       (anomaly_threshold.sql rule 3)
//   ZSCORE     — |z| > 3 vs 30-day baseline in 10 min   (anomaly_zscore.sql)
//   HIGH_RISK  — txn against risk_level='high' merchant (anomaly_threshold.sql rule 2)
//   FAIL_SPIKE — >=3 failed AND >50% fail rate in 30min (anomaly_threshold.sql rule 4)
//
// Windowed to last 10 minutes so each fraud-sim run lights up the feed without
// dragging in historical noise. FAIL_SPIKE uses 30 min to match its query.
const SQL = `
SELECT * FROM (
  -- VELOCITY
  SELECT
    'VELOCITY'                                  AS rule,
    'high'                                      AS severity,
    account_id                                  AS subject,
    toUnixTimestamp64Milli(max(created_at))     AS detected_at_ms,
    concat(toString(count()), ' txns, ',
           toString(round(sum(toFloat64(amount)) / 1e6, 1)), 'M VND in 5 min') AS message
  FROM finwatch.transactions FINAL
  WHERE created_at >= now() - INTERVAL 10 MINUTE
    AND cdc_op != 'd'
  GROUP BY account_id
  HAVING count() > 10 OR sum(toFloat64(amount)) > 50000000

  UNION ALL

  -- LARGE_AMT
  SELECT
    'LARGE_AMT'                                  AS rule,
    'high'                                       AS severity,
    account_id                                   AS subject,
    toUnixTimestamp64Milli(created_at)           AS detected_at_ms,
    concat('Single txn ',
           toString(round(toFloat64(amount) / 1e6, 1)),
           'M ', toString(currency))             AS message
  FROM finwatch.transactions FINAL
  WHERE toFloat64(amount) > 100000000
    AND created_at >= now() - INTERVAL 10 MINUTE
    AND cdc_op != 'd'

  UNION ALL

  -- MULTI_CCY
  SELECT
    'MULTI_CCY'                                  AS rule,
    'medium'                                     AS severity,
    account_id                                   AS subject,
    toUnixTimestamp64Milli(max(created_at))      AS detected_at_ms,
    concat(toString(length(groupArray(DISTINCT currency))),
           ' currencies in 10 min: ',
           arrayStringConcat(groupArray(DISTINCT currency), ','))  AS message
  FROM finwatch.transactions FINAL
  WHERE created_at >= now() - INTERVAL 10 MINUTE
    AND cdc_op != 'd'
  GROUP BY account_id
  HAVING length(groupArray(DISTINCT currency)) > 2

  UNION ALL

  -- ZSCORE
  SELECT
    'ZSCORE'                                     AS rule,
    'medium'                                     AS severity,
    t.account_id                                 AS subject,
    toUnixTimestamp64Milli(t.created_at)         AS detected_at_ms,
    concat('z=',
           toString(round((toFloat64(t.amount) - stats.avg_amount)
                         / nullIf(stats.std_amount, 0), 1)),
           ' vs 30d avg ',
           toString(round(stats.avg_amount / 1e3, 0)), 'k')  AS message
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
    AND abs((toFloat64(t.amount) - stats.avg_amount)
          / nullIf(stats.std_amount, 0)) > 3

  UNION ALL

  -- HIGH_RISK (mule-account typology)
  -- Aggregated per-account so the feed doesn't get flooded with one alert
  -- per txn when a single account routes multiple payments to a high-risk
  -- merchant.
  SELECT
    'HIGH_RISK'                                  AS rule,
    'high'                                       AS severity,
    t.account_id                                 AS subject,
    toUnixTimestamp64Milli(max(t.created_at))    AS detected_at_ms,
    concat(toString(count()), ' txns to high-risk merchant: ',
           any(m.name))                          AS message
  FROM finwatch.transactions t FINAL
  INNER JOIN finwatch.merchants m FINAL ON t.merchant_id = m.id
  WHERE m.risk_level = 'high'
    AND t.created_at >= now() - INTERVAL 10 MINUTE
    AND t.cdc_op != 'd'
  GROUP BY t.account_id

  UNION ALL

  -- FAIL_SPIKE (card-testing typology)
  -- 30-minute window matches anomaly_threshold.sql rule 4; gate is the same
  -- (>=3 failed AND >50% fail rate).
  SELECT
    'FAIL_SPIKE'                                 AS rule,
    'high'                                       AS severity,
    account_id                                   AS subject,
    toUnixTimestamp64Milli(max(created_at))      AS detected_at_ms,
    concat(toString(countIf(status='failed')), '/',
           toString(count()), ' failed (',
           toString(round(countIf(status='failed') / count() * 100, 0)),
           '% fail rate, 30 min)')               AS message
  FROM finwatch.transactions FINAL
  WHERE created_at >= now() - INTERVAL 30 MINUTE
    AND cdc_op != 'd'
  GROUP BY account_id
  HAVING countIf(status = 'failed') >= 3
     AND countIf(status = 'failed') / count() > 0.5
)
ORDER BY detected_at_ms DESC
LIMIT 50
`;

export async function GET() {
  try {
    const rows = await query<{
      rule: string;
      severity: string;
      subject: string;
      detected_at_ms: number;
      message: string;
    }>(SQL);
    return NextResponse.json({ alerts: rows, ts: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { alerts: [], error: (err as Error).message },
      { status: 503 },
    );
  }
}
