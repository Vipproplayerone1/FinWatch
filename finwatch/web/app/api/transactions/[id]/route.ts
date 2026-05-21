import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const id = params.id;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid uuid" }, { status: 400 });
  }

  const sql = `
    SELECT
      id, account_id, merchant_id,
      toFloat64(amount) AS amount,
      currency, type, status, description,
      toString(created_at)   AS created_at,
      _source_ts_ms          AS source_ts_ms,
      toString(_ingested_at) AS ingested_at,
      toUnixTimestamp64Milli(_ingested_at) AS ingested_at_ms,
      cdc_op
    FROM finwatch.transactions FINAL
    WHERE id = '${id}' AND cdc_op != 'd'
    LIMIT 1
  `;

  try {
    const rows = await query(sql);
    if (rows.length === 0) {
      return NextResponse.json({ found: false }, { status: 404 });
    }
    return NextResponse.json({ found: true, txn: rows[0] });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 503 });
  }
}
