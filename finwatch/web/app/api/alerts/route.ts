import { NextResponse } from "next/server";
import { ch } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ALLOWED_RULES = new Set(["VELOCITY","LARGE_AMT","MULTI_CCY","ZSCORE","HIGH_RISK","FAIL_SPIKE"]);
const ALLOWED_SEV   = new Set(["low","medium","high","critical"]);

type Row = {
  id: string;
  account_id: string;
  account_name: string | null;
  rule_code: string;
  severity: string;
  txn_count: number;
  total_amount: number;
  status: string;
  created_at: string;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rule = (url.searchParams.get("rule") ?? "").trim();
  const severity = (url.searchParams.get("severity") ?? "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 500);

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
    return NextResponse.json({ rows, ts: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { rows: [], error: (err as Error).message },
      { status: 503 },
    );
  }
}
