import { NextResponse } from "next/server";
import { pg } from "@/lib/pg";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ALLOWED_CCY = new Set(["VND", "USD", "EUR", "JPY", "THB"]);
const ALLOWED_TYPE = new Set(["purchase", "transfer", "withdrawal", "deposit", "refund"]);
const ALLOWED_STATUS = new Set(["completed", "failed", "pending", "flagged"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Body {
  account_id?: string;
  merchant_id?: string;
  amount?: number | string;
  currency?: string;
  type?: string;
  status?: string;
  description?: string;
}

export async function POST(req: Request) {
  let body: Body = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const account_id = String(body.account_id ?? "");
  const merchant_id = String(body.merchant_id ?? "");
  const amount = Number(body.amount);
  const currency = String(body.currency ?? "VND");
  const txnType = String(body.type ?? "purchase");
  const status  = String(body.status ?? "completed");
  const description = String(body.description ?? "Demo from UI");

  if (!UUID_RE.test(account_id))   return NextResponse.json({ error: "account_id must be a UUID" }, { status: 400 });
  if (!UUID_RE.test(merchant_id))  return NextResponse.json({ error: "merchant_id must be a UUID" }, { status: 400 });
  if (!Number.isFinite(amount) || amount <= 0)
    return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  if (!ALLOWED_CCY.has(currency))  return NextResponse.json({ error: `currency must be one of ${[...ALLOWED_CCY].join(",")}` }, { status: 400 });
  if (!ALLOWED_TYPE.has(txnType))  return NextResponse.json({ error: `type must be one of ${[...ALLOWED_TYPE].join(",")}` }, { status: 400 });
  if (!ALLOWED_STATUS.has(status)) return NextResponse.json({ error: `status must be one of ${[...ALLOWED_STATUS].join(",")}` }, { status: 400 });

  // We don't supply id; Postgres' default `gen_random_uuid()` generates one.
  const sql = `
    INSERT INTO transactions
      (account_id, merchant_id, amount, currency, type, status, description, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, created_at
  `;

  const submittedAt = Date.now();
  try {
    const r = await pg.query<{ id: string; created_at: Date }>(sql, [
      account_id, merchant_id, amount, currency, txnType, status, description,
      JSON.stringify({ source: "demo_ui_insert", submitted_at_ms: submittedAt }),
    ]);
    const row = r.rows[0];
    if (!row) return NextResponse.json({ error: "insert returned no row" }, { status: 500 });
    return NextResponse.json({
      id: row.id,
      created_at: row.created_at,
      submitted_at_ms: submittedAt,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
