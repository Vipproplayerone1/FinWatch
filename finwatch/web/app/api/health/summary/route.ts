import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Latency in milliseconds via dateDiff (matches dashboard_queries.sql pattern).
// tps_now = rows ingested in the last 5 seconds, divided by 5 (smoother than 1s windows).
// total_today uses Asia/Ho_Chi_Minh-localized created_at via an inline subquery
// (a WITH ... AS alias clashes with the SELECT-list alias inside ClickHouse's name resolution).
const SQL = `
SELECT
  round(avg(dateDiff('millisecond', created_at, _ingested_at)), 0)             AS avg_latency_ms,
  round(quantile(0.95)(dateDiff('millisecond', created_at, _ingested_at)), 0)  AS p95_latency_ms,
  round(countIf(_ingested_at > now() - INTERVAL 5 SECOND) / 5.0, 1)             AS tps_now,
  (
    SELECT count()
    FROM finwatch.transactions FINAL
    WHERE cdc_op != 'd' AND toDate(created_at) = today()
  )                                                                            AS total_today,
  count()                                                                      AS sample_rows
FROM finwatch.transactions FINAL
WHERE cdc_op != 'd'
  AND _ingested_at > now() - INTERVAL 5 MINUTE
`;

export async function GET() {
  try {
    const rows = await query<{
      avg_latency_ms: number | null;
      p95_latency_ms: number | null;
      tps_now: number | null;
      total_today: number | null;
      sample_rows: number | null;
    }>(SQL);
    const r = rows[0] ?? {};
    return NextResponse.json({
      avg_latency_ms: r.avg_latency_ms ?? null,
      p95_latency_ms: r.p95_latency_ms ?? null,
      tps_now: r.tps_now ?? 0,
      total_today: r.total_today ?? 0,
      sample_rows: r.sample_rows ?? 0,
      ts: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        avg_latency_ms: null,
        p95_latency_ms: null,
        tps_now: null,
        total_today: null,
        sample_rows: null,
        error: (err as Error).message,
      },
      { status: 503 },
    );
  }
}
