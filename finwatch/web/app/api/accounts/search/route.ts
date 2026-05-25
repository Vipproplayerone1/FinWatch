import { NextResponse } from "next/server";
import { ch } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Row = {
  id: string;
  full_name: string;
  email: string;
  balance: number;
  status: string;
  open_alerts_24h: number;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);

  const sql = `
    SELECT
      a.id                                            AS id,
      a.full_name                                     AS full_name,
      a.email                                         AS email,
      toFloat64(a.balance)                            AS balance,
      a.status                                        AS status,
      coalesce(al.open_24h, 0)                        AS open_alerts_24h
    FROM finwatch.accounts a FINAL
    LEFT JOIN (
      SELECT account_id, count() AS open_24h
      FROM finwatch.fraud_alerts FINAL
      WHERE created_at >= now() - INTERVAL 24 HOUR
        AND status = 'open'
        AND cdc_op != 'd'
      GROUP BY account_id
    ) al ON al.account_id = a.id
    WHERE a.cdc_op != 'd'
      AND (
        {q:String} = ''
        OR positionCaseInsensitive(a.full_name, {q:String}) > 0
        OR positionCaseInsensitive(a.email,     {q:String}) > 0
      )
    ORDER BY a.full_name
    LIMIT {limit:UInt32}
  `;

  try {
    const rs = await ch.query({
      query: sql,
      format: "JSONEachRow",
      query_params: { q, limit },
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
