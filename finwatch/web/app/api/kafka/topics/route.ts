import { NextResponse } from "next/server";
import { getAdmin } from "@/lib/kafka";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const FINWATCH_TOPIC = /^finwatch\.public\./;

export async function GET() {
  try {
    const admin = await getAdmin();
    const all = await admin.listTopics();
    const filtered = all.filter((name) => FINWATCH_TOPIC.test(name)).sort();
    if (filtered.length === 0) {
      return NextResponse.json({ topics: [] });
    }

    const meta = await admin.fetchTopicMetadata({ topics: filtered });
    const partitionCounts = new Map<string, number>();
    for (const t of meta.topics) {
      partitionCounts.set(t.name, t.partitions.length);
    }

    // Sum (high - low) per topic to estimate retained messages.
    const topics = await Promise.all(
      filtered.map(async (name) => {
        try {
          const offsets = await admin.fetchTopicOffsets(name);
          const messageCount = offsets.reduce(
            (sum, p) => sum + (BigInt(p.offset) - BigInt(p.low)),
            0n,
          );
          return {
            name,
            partitionCount: partitionCounts.get(name) ?? 0,
            messageCount: messageCount.toString(),
          };
        } catch {
          return {
            name,
            partitionCount: partitionCounts.get(name) ?? 0,
            messageCount: "0",
          };
        }
      }),
    );

    return NextResponse.json({ topics });
  } catch (err) {
    return NextResponse.json(
      { topics: [], error: (err as Error).message },
      { status: 503 },
    );
  }
}
