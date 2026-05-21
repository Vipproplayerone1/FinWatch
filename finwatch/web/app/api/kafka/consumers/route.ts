import { NextResponse } from "next/server";
import { getAdmin } from "@/lib/kafka";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const FINWATCH_TOPIC_PATTERN = /^finwatch\.public\.(?<table>.+)$/;

// In this project, the ClickHouse Kafka-engine creates one consumer group per
// table: `clickhouse_<table>`. Debezium is the *producer* for the topic and
// has no consumer group of its own — its position is tracked via the Connect
// REST API (visible on /stack). So for each finwatch.public.<table> topic we
// only surface the ClickHouse consumer group's lag.

interface PartitionLag {
  partition: number;
  current: string;     // current committed offset
  logEnd: string;      // log-end (next-to-write) offset
  lag: string;         // logEnd - current (bigint serialized as string)
}

interface GroupReport {
  groupId: string;
  partitions: PartitionLag[];
  hint?: string;       // set when the group has no committed offsets yet
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const topic = url.searchParams.get("topic") ?? "";
  if (!topic) {
    return NextResponse.json(
      { groups: [], error: "topic query param required" },
      { status: 400 },
    );
  }
  const match = FINWATCH_TOPIC_PATTERN.exec(topic);
  if (!match || !match.groups?.table) {
    return NextResponse.json(
      { groups: [], error: "topic must match finwatch.public.<table>" },
      { status: 400 },
    );
  }
  const table = match.groups.table;

  try {
    const admin = await getAdmin();

    // Log-end offsets per partition for this topic.
    const topicOffsets = await admin.fetchTopicOffsets(topic);
    const logEndByPartition = new Map<number, string>();
    for (const p of topicOffsets) logEndByPartition.set(p.partition, p.offset);

    // The expected ClickHouse Kafka-engine consumer group for this topic.
    const expectedGroup = `clickhouse_${table}`;

    // Find it in the live group list. If absent, surface a hint — the engine
    // table may not have been queried yet (groups are lazily registered on
    // first poll).
    const all = await admin.listGroups();
    const matched = all.groups.find((g) => g.groupId === expectedGroup);

    let group: GroupReport;
    if (!matched) {
      group = {
        groupId: expectedGroup,
        partitions: [],
        hint: "ClickHouse Kafka-engine group not yet registered (no commits seen)",
      };
    } else {
      try {
        const offsets = await admin.fetchOffsets({ groupId: expectedGroup, topics: [topic] });
        const topicEntry = offsets.find((e) => e.topic === topic);
        const parts = topicEntry?.partitions ?? [];
        if (parts.length === 0) {
          group = {
            groupId: expectedGroup,
            partitions: [],
            hint: "group exists but has no committed offsets on this topic",
          };
        } else {
          const partitions: PartitionLag[] = parts.map((p) => {
            const logEnd = logEndByPartition.get(p.partition) ?? "0";
            const current = p.offset === "-1" ? "0" : p.offset;
            const lag = BigInt(logEnd) - BigInt(current);
            return {
              partition: p.partition,
              current,
              logEnd,
              lag: lag.toString(),
            };
          });
          group = { groupId: expectedGroup, partitions };
        }
      } catch (e) {
        group = {
          groupId: expectedGroup,
          partitions: [],
          hint: `error fetching offsets: ${(e as Error).message}`,
        };
      }
    }

    return NextResponse.json({
      groups: [group],
      producerNote: "Debezium produces to this topic via Kafka Connect — its position is on /stack, not in consumer-group form.",
      ts: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { groups: [], error: (err as Error).message },
      { status: 503 },
    );
  }
}
