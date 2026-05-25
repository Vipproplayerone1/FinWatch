import { NextResponse } from "next/server";
import { pg } from "@/lib/pg";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ALLOWED_CCY = new Set(["VND", "USD", "EUR", "JPY", "THB"]);
const ALLOWED_TYPE = new Set(["purchase", "transfer", "withdrawal", "deposit", "refund"]);
const DEBIT_TYPES = new Set(["purchase", "transfer", "withdrawal"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Body {
  account_id?: string;
  merchant_id?: string;
  merchant?: string;
  amount?: number | string;
  currency?: string;
  type?: string;
  description?: string;
}

export async function POST(req: Request) {
  let body: Body = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const account_id = String(body.account_id ?? "");
  const merchant_id_raw = body.merchant_id ? String(body.merchant_id) : "";
  const merchant_name = body.merchant ? String(body.merchant) : "";
  const amount = Number(body.amount);
  const currency = String(body.currency ?? "VND");
  const txnType = String(body.type ?? "purchase");
  const description_in = body.description ? String(body.description) : "Demo from UI";

  if (!UUID_RE.test(account_id))
    return NextResponse.json({ error: "account_id must be a UUID" }, { status: 400 });
  if (!Number.isFinite(amount) || amount <= 0)
    return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  if (!ALLOWED_CCY.has(currency))
    return NextResponse.json({ error: `currency must be one of ${[...ALLOWED_CCY].join(",")}` }, { status: 400 });
  if (!ALLOWED_TYPE.has(txnType))
    return NextResponse.json({ error: `type must be one of ${[...ALLOWED_TYPE].join(",")}` }, { status: 400 });
  if (!merchant_id_raw && !merchant_name)
    return NextResponse.json({ error: "merchant_id or merchant (name) is required" }, { status: 400 });
  if (merchant_id_raw && !UUID_RE.test(merchant_id_raw))
    return NextResponse.json({ error: "merchant_id must be a UUID" }, { status: 400 });

  const submittedAt = Date.now();
  const client = await pg.connect();
  try {
    await client.query("BEGIN");

    // Resolve merchant_id from either UUID or name (so curl-friendly callers
    // can pass {merchant:"VinMart"} like the verification block does).
    let merchant_id: string | null = null;
    if (merchant_id_raw) {
      merchant_id = merchant_id_raw;
    } else {
      const m = await client.query<{ id: string }>(
        "SELECT id FROM merchants WHERE name = $1 LIMIT 1",
        [merchant_name],
      );
      if (m.rowCount === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: `merchant not found: ${merchant_name}` }, { status: 400 });
      }
      merchant_id = m.rows[0].id;
    }

    // Lock the account row so concurrent inserts see a consistent balance.
    const acctRes = await client.query<{ id: string; balance: string; status: string }>(
      "SELECT id, balance, status FROM accounts WHERE id = $1 FOR UPDATE",
      [account_id],
    );
    if (acctRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "account not found" }, { status: 404 });
    }
    const acct = acctRes.rows[0];
    const balance = Number(acct.balance);

    const meta = JSON.stringify({ source: "demo_ui_insert", submitted_at_ms: submittedAt });
    const insertSql = `
      INSERT INTO transactions
        (account_id, merchant_id, amount, currency, type, status, description, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, created_at
    `;

    // Branch 1: account not active → record as failed, no balance change.
    if (acct.status !== "active") {
      const desc = `rejected: account ${acct.status}`;
      const r = await client.query<{ id: string; created_at: Date }>(insertSql, [
        account_id, merchant_id, amount, currency, txnType, "failed", desc, meta,
      ]);
      await client.query("COMMIT");
      return NextResponse.json({
        accepted: false,
        reason: acct.status,
        txn_id: r.rows[0].id,
        created_at: r.rows[0].created_at,
        submitted_at_ms: submittedAt,
      });
    }

    // Branch 2: debit type with insufficient funds → failed, no balance change.
    if (DEBIT_TYPES.has(txnType) && balance < amount) {
      const r = await client.query<{ id: string; created_at: Date }>(insertSql, [
        account_id, merchant_id, amount, currency, txnType, "failed", "insufficient funds", meta,
      ]);
      await client.query("COMMIT");
      return NextResponse.json({
        accepted: false,
        reason: "insufficient_funds",
        txn_id: r.rows[0].id,
        created_at: r.rows[0].created_at,
        balance,
        submitted_at_ms: submittedAt,
      });
    }

    // Branch 3: completed → debit/credit balance.
    const r = await client.query<{ id: string; created_at: Date }>(insertSql, [
      account_id, merchant_id, amount, currency, txnType, "completed", description_in, meta,
    ]);
    const sign = DEBIT_TYPES.has(txnType) ? -1 : 1;
    const upd = await client.query<{ balance: string }>(
      "UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING balance",
      [sign * amount, account_id],
    );
    await client.query("COMMIT");
    return NextResponse.json({
      accepted: true,
      txn_id: r.rows[0].id,
      created_at: r.rows[0].created_at,
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
