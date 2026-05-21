import { NextResponse } from "next/server";
import { query } from "./clickhouse";
import { RULES, type RuleId } from "./fraud-rules";

export async function handleRule(id: RuleId) {
  const spec = RULES[id];
  try {
    const rows = await query(spec.currentSql);
    return NextResponse.json({
      rule: spec.id,
      shortName: spec.shortName,
      threshold: spec.threshold,
      sourceFile: spec.sourceFile,
      columns: spec.rowColumns,
      count: rows.length,
      rows,
      sql: spec.currentSql.trim(),
    });
  } catch (err) {
    return NextResponse.json(
      { rule: id, count: 0, rows: [], error: (err as Error).message },
      { status: 503 },
    );
  }
}
