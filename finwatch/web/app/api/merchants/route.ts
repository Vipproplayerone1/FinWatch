import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SQL = `
SELECT id, name, category, risk_level
FROM finwatch.merchants FINAL
WHERE cdc_op != 'd'
ORDER BY name
`;

export async function GET() {
  try {
    const rows = await query<{ id: string; name: string; category: string; risk_level: string }>(SQL);
    return NextResponse.json({ merchants: rows });
  } catch (err) {
    return NextResponse.json({ merchants: [], error: (err as Error).message }, { status: 503 });
  }
}
