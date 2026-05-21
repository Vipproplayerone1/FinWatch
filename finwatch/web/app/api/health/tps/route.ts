import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// One row per second over the last 60 seconds (gaps included via WITH FILL).
// Bucketing via intDiv(toUnixTimestamp64Milli(...), 1000) avoids toStartOfSecond,
// which requires DateTime64 input and rejects the DateTime returned by now().
const SQL = `
SELECT
  intDiv(toUnixTimestamp64Milli(_ingested_at), 1000) AS t,
  count()                                            AS tps
FROM finwatch.transactions FINAL
WHERE cdc_op != 'd'
  AND _ingested_at > now() - INTERVAL 60 SECOND
GROUP BY t
ORDER BY t ASC WITH FILL
  FROM toUnixTimestamp(now() - INTERVAL 60 SECOND)
  TO   toUnixTimestamp(now())
  STEP 1
`;

export async function GET() {
  try {
    const rows = await query<{ t: number; tps: number }>(SQL);
    return NextResponse.json({ points: rows, ts: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { points: [], error: (err as Error).message },
      { status: 503 },
    );
  }
}
