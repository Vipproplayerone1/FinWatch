import { NextResponse } from "next/server";
import { pg } from "@/lib/pg";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOPUP = 10_000_000_000; // 10 billion VND cap — sanity bound for the demo

interface Body { amount?: number | string }

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "id must be a UUID" }, { status: 400 });

  let body: Body = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0)
    return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  if (amount > MAX_TOPUP)
    return NextResponse.json({ error: `amount must be <= ${MAX_TOPUP}` }, { status: 400 });

  const submittedAt = Date.now();
  const client = await pg.connect();
  try {
    await client.query("BEGIN");

    const acctRes = await client.query<{ status: string; currency: string }>(
      "SELECT status, currency FROM accounts WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (acctRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "account not found" }, { status: 404 });
    }
    const { status, currency } = acctRes.rows[0];
    if (status !== "active") {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: `cannot top up account in status '${status}'`, current_status: status },
        { status: 409 },
      );
    }

    // Top-up records as a deposit transaction so it flows through CDC and
    // appears in /accounts/[id] Recent transactions like any other ledger
    // entry. No merchant — deposits don't need one (transactions.merchant_id
    // is nullable).
    const meta = JSON.stringify({ source: "ui_topup", submitted_at_ms: submittedAt });
    const tx = await client.query<{ id: string; created_at: Date }>(
      `
      INSERT INTO transactions
        (account_id, merchant_id, amount, currency, type, status, description, metadata)
      VALUES ($1, NULL, $2, $3, 'deposit', 'completed', 'Top up via UI', $4)
      RETURNING id, created_at
      `,
      [id, amount, currency || "VND", meta],
    );
    const upd = await client.query<{ balance: string }>(
      "UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING balance",
      [amount, id],
    );
    await client.query("COMMIT");
    return NextResponse.json({
      accepted: true,
      txn_id: tx.rows[0].id,
      id: tx.rows[0].id,
      created_at: tx.rows[0].created_at,
      new_balance: Number(upd.rows[0].balance),
      submitted_at_ms: submittedAt,
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  } finally {
    client.release();
  }
}
