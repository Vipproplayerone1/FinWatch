import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SQL = `
SELECT
  t.id            AS id,
  t.amount        AS amount,
  t.currency      AS currency,
  t.type          AS type,
  t.status        AS status,
  toString(t.created_at)    AS created_at,
  t._source_ts_ms           AS source_ts_ms,
  toString(t._ingested_at)  AS ingested_at,
  a.full_name     AS account_name,
  m.name          AS merchant_name,
  m.category      AS merchant_category,
  m.risk_level    AS merchant_risk
FROM finwatch.transactions t FINAL
LEFT JOIN finwatch.accounts  a FINAL ON t.account_id  = a.id
LEFT JOIN finwatch.merchants m FINAL ON t.merchant_id = m.id
WHERE t.cdc_op != 'd'
ORDER BY t._source_ts_ms DESC
LIMIT 20
`;

export async function GET() {
  try {
    const rows = await query(SQL);
    return NextResponse.json({ rows, ts: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { rows: [], error: (err as Error).message },
      { status: 503 },
    );
  }
}
