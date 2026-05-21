import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Incremental fetch for ArchitectureFlow. Caller passes `?since=<epoch ms>`,
// we return up to 100 rows with `_source_ts_ms > since`, ascending so the
// caller can spawn particles in temporal order.
//
// `is_fraud` is a simple amount-based heuristic for the particle highlight
// (the LARGE_AMT rule's threshold). The actual anomaly engine runs in the
// /api/alerts/recent feed; this flag exists purely for the visual.

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw && /^\d+$/.test(sinceRaw) ? sinceRaw : "0";

  const sql = `
    SELECT
      id,
      account_id,
      toFloat64(amount)            AS amount,
      currency,
      type,
      status,
      _source_ts_ms                AS source_ts_ms,
      multiIf(toFloat64(amount) > 100000000, 1, 0) AS is_fraud
    FROM finwatch.transactions FINAL
    WHERE _source_ts_ms > ${since}
      AND cdc_op != 'd'
    ORDER BY _source_ts_ms ASC
    LIMIT 100
  `;

  try {
    const rows = await query<{
      id: string; account_id: string; amount: number; currency: string;
      type: string; status: string; source_ts_ms: number; is_fraud: number;
    }>(sql);
    return NextResponse.json({ rows, serverTs: Date.now() });
  } catch (err) {
    return NextResponse.json({ rows: [], error: (err as Error).message }, { status: 503 });
  }
}
