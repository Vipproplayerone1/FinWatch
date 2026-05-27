import { NextResponse } from "next/server";
import { ch } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ALLOWED_RULES = new Set(["VELOCITY","LARGE_AMT","MULTI_CCY","ZSCORE","HIGH_RISK","FAIL_SPIKE"]);
const ALLOWED_SEV   = new Set(["low","medium","high","critical"]);

type Firing = {
  id: string;
  rule_code: string;
  severity: string;
  txn_count: number;
  total_amount: number;
  evidence: string;
  status: string;
  created_at: string;
};

type Row = Firing & {
  account_id: string;
  account_name: string | null;
};

type Group = {
  account_id: string;
  account_name: string | null;
  last_seen: string;
  total_firings: number;
  firings: Firing[];
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rule = (url.searchParams.get("rule") ?? "").trim();
  const severity = (url.searchParams.get("severity") ?? "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 500), 1), 2000);

  if (rule && !ALLOWED_RULES.has(rule))
    return NextResponse.json({ error: "invalid rule" }, { status: 400 });
  if (severity && !ALLOWED_SEV.has(severity))
    return NextResponse.json({ error: "invalid severity" }, { status: 400 });

  // Build the WHERE clause inline so empty filters are no-ops. Filter values are
  // strictly validated above; nothing else is interpolated from user input.
  const ruleClause = rule     ? `AND fa.rule_code = {rule:String}`        : "";
  const sevClause  = severity ? `AND fa.severity  = {severity:String}`    : "";

  const sql = `
    SELECT
      fa.id                       AS id,
      fa.account_id               AS account_id,
      a.full_name                 AS account_name,
      fa.rule_code                AS rule_code,
      fa.severity                 AS severity,
      fa.txn_count                AS txn_count,
      toFloat64(fa.total_amount)  AS total_amount,
      fa.evidence                 AS evidence,
      fa.status                   AS status,
      fa.created_at               AS created_at
    FROM finwatch.fraud_alerts fa FINAL
    LEFT JOIN finwatch.accounts a FINAL ON a.id = fa.account_id
    WHERE fa.cdc_op != 'd'
      ${ruleClause}
      ${sevClause}
    ORDER BY fa.created_at DESC
    LIMIT {limit:UInt32}
  `;

  try {
    const rs = await ch.query({
      query: sql,
      format: "JSONEachRow",
      query_params: { rule, severity, limit },
    });
    const rows = (await rs.json()) as Row[];

    // Group by account_id, preserving newest-first order from the SELECT.
    const byAccount = new Map<string, Group>();
    for (const r of rows) {
      const firing: Firing = {
        id: r.id,
        rule_code: r.rule_code,
        severity: r.severity,
        txn_count: r.txn_count,
        total_amount: r.total_amount,
        evidence: r.evidence,
        status: r.status,
        created_at: r.created_at,
      };
      const existing = byAccount.get(r.account_id);
      if (existing) {
        existing.firings.push(firing);
        existing.total_firings += 1;
        if (r.created_at > existing.last_seen) existing.last_seen = r.created_at;
      } else {
        byAccount.set(r.account_id, {
          account_id: r.account_id,
          account_name: r.account_name,
          last_seen: r.created_at,
          total_firings: 1,
          firings: [firing],
        });
      }
    }
    const groups = [...byAccount.values()].sort((a, b) =>
      a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0,
    );
    const totalFirings = rows.length;

    return NextResponse.json({ groups, total_firings: totalFirings, ts: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { groups: [], total_firings: 0, error: (err as Error).message },
      { status: 503 },
    );
  }
}
