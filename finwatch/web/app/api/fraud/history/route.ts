import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";
import { historySql, type RuleId } from "@/lib/fraud-rules";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const RULE_IDS: RuleId[] = ["R1", "R2", "R3", "R4", "R5", "R6"];
const isRuleId = (s: string): s is RuleId => (RULE_IDS as string[]).includes(s);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ruleRaw = url.searchParams.get("rule") ?? "";
  const minutesRaw = Number(url.searchParams.get("minutes") ?? 30);
  const minutes = Number.isFinite(minutesRaw) ? Math.trunc(minutesRaw) : 30;

  if (!isRuleId(ruleRaw)) {
    return NextResponse.json(
      { error: `rule must be one of ${RULE_IDS.join(",")}` },
      { status: 400 },
    );
  }

  try {
    const rows = await query<{ bucket: string; flags: number }>(historySql(ruleRaw, minutes));
    return NextResponse.json({ rule: ruleRaw, minutes, points: rows });
  } catch (err) {
    return NextResponse.json(
      { rule: ruleRaw, minutes, points: [], error: (err as Error).message },
      { status: 503 },
    );
  }
}
