import { NextResponse } from "next/server";
import { ch } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  id: string;
  rule_code: string;
  severity: string;
  txn_count: number;
  total_amount: number;
  status: string;
  evidence: string;
  created_at: string;
};

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "id must be a UUID" }, { status: 400 });

  const sql = `
    SELECT
      id,
      rule_code,
      severity,
      txn_count,
      toFloat64(total_amount) AS total_amount,
      status,
      evidence,
      created_at
    FROM finwatch.fraud_alerts FINAL
    WHERE account_id = {id:String}
      AND cdc_op != 'd'
    ORDER BY created_at DESC
    LIMIT 20
  `;

  try {
    const rs = await ch.query({
      query: sql,
      format: "JSONEachRow",
      query_params: { id },
    });
    const rows = (await rs.json()) as Row[];
    return NextResponse.json({ rows, ts: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { rows: [], error: (err as Error).message },
      { status: 503 },
    );
  }
}
