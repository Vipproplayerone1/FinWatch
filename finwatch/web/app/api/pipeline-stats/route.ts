import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// FinWatch is a single-chain CDC pipeline: every committed PG row passes
// through Debezium -> Kafka -> ClickHouse exactly once. So every node in
// the diagram reports the same throughput. We measure it via the rate of
// rows landing in ClickHouse over the last minute.
const SQL = `
SELECT count() AS events_last_minute
FROM finwatch.transactions FINAL
WHERE cdc_op != 'd'
  AND _ingested_at > now() - INTERVAL 1 MINUTE
`;

export async function GET() {
  try {
    const rows = await query<{ events_last_minute: number }>(SQL);
    const epm = Number(rows[0]?.events_last_minute ?? 0);
    return NextResponse.json({
      nodes: {
        postgres:   { eventsPerMin: epm },
        debezium:   { eventsPerMin: epm },
        kafka:      { eventsPerMin: epm },
        clickhouse: { eventsPerMin: epm },
      },
      serverTs: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { nodes: null, error: (err as Error).message },
      { status: 503 },
    );
  }
}
