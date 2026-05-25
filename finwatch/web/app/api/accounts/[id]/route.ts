import { NextResponse } from "next/server";
import { ch } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  balance: number;
  currency: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "id must be a UUID" }, { status: 400 });

  const sql = `
    SELECT
      id, full_name, email, phone,
      toFloat64(balance) AS balance,
      currency, status, created_at, updated_at
    FROM finwatch.accounts FINAL
    WHERE id = {id:String}
      AND cdc_op != 'd'
    LIMIT 1
  `;

  try {
    const rs = await ch.query({
      query: sql,
      format: "JSONEachRow",
      query_params: { id },
    });
    const rows = (await rs.json()) as Row[];
    if (rows.length === 0)
      return NextResponse.json({ error: "account not found" }, { status: 404 });
    return NextResponse.json({ account: rows[0], ts: Date.now() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 503 });
  }
}
