import { NextResponse } from "next/server";
import { ch } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  id: string;
  type: string;
  status: string;
  amount: number;
  currency: string;
  description: string | null;
  merchant_name: string | null;
  created_at: string;
};

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "id must be a UUID" }, { status: 400 });

  const sql = `
    SELECT
      t.id                  AS id,
      t.type                AS type,
      t.status              AS status,
      toFloat64(t.amount)   AS amount,
      t.currency            AS currency,
      t.description         AS description,
      m.name                AS merchant_name,
      t.created_at          AS created_at
    FROM finwatch.transactions t FINAL
    LEFT JOIN finwatch.merchants m FINAL ON m.id = t.merchant_id
    WHERE t.account_id = {id:String}
      AND t.cdc_op != 'd'
    ORDER BY t.created_at DESC
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
