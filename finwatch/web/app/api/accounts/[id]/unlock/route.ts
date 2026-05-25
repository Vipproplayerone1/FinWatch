import { NextResponse } from "next/server";
import { pg } from "@/lib/pg";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "id must be a UUID" }, { status: 400 });

  try {
    const r = await pg.query<{ status: string }>(
      "UPDATE accounts SET status = 'active' WHERE id = $1 AND status = 'suspended' RETURNING status",
      [id],
    );
    if (r.rowCount === 0) {
      const cur = await pg.query<{ status: string }>(
        "SELECT status FROM accounts WHERE id = $1",
        [id],
      );
      if (cur.rowCount === 0)
        return NextResponse.json({ error: "account not found" }, { status: 404 });
      return NextResponse.json(
        { error: "not_suspended", current_status: cur.rows[0].status },
        { status: 409 },
      );
    }
    return NextResponse.json({ status: r.rows[0].status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
