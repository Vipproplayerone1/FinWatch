import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SQL = `
SELECT id, full_name, email, status
FROM finwatch.accounts FINAL
WHERE cdc_op != 'd' AND status = 'active'
ORDER BY full_name
`;

export async function GET() {
  try {
    const rows = await query<{ id: string; full_name: string; email: string; status: string }>(SQL);
    return NextResponse.json({ accounts: rows });
  } catch (err) {
    return NextResponse.json({ accounts: [], error: (err as Error).message }, { status: 503 });
  }
}
