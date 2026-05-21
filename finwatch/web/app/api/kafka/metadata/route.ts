import { NextResponse } from "next/server";
import { ConfigResourceTypes } from "kafkajs";
import { getAdmin } from "@/lib/kafka";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const FINWATCH_TOPIC = /^finwatch\.public\./;

// Configs we explicitly surface in the UI. Other configs are dropped to keep
// the key-value table focused on what matters for a CDC + retention review.
const SURFACE_CONFIGS = new Set([
  "cleanup.policy",
  "retention.ms",
  "segment.bytes",
  "min.insync.replicas",
  "compression.type",
  "max.message.bytes",
]);

interface ConfigRow {
  name: string;
  value: string;
  isDefault: boolean;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const topic = url.searchParams.get("topic") ?? "";
  if (!topic) {
    return NextResponse.json(
      { error: "topic query param required" },
      { status: 400 },
    );
  }
  if (!FINWATCH_TOPIC.test(topic)) {
    return NextResponse.json(
      { error: "topic must match finwatch.public.*" },
      { status: 400 },
    );
  }

  try {
    const admin = await getAdmin();

    // Partitions + replication.factor come from topic metadata, not configs.
    const meta = await admin.fetchTopicMetadata({ topics: [topic] });
    const topicMeta = meta.topics.find((t) => t.name === topic);
    const partitions = topicMeta?.partitions.length ?? 0;
    const replicationFactor = topicMeta?.partitions[0]?.replicas.length ?? 0;

    // Per-config values via describeConfigs.
    const desc = await admin.describeConfigs({
      includeSynonyms: false,
      resources: [{ type: ConfigResourceTypes.TOPIC, name: topic }],
    });
    const entries = desc.resources[0]?.configEntries ?? [];
    const configs: ConfigRow[] = entries
      .filter((e) => SURFACE_CONFIGS.has(e.configName))
      .map((e) => ({
        name: e.configName,
        value: e.configValue ?? "",
        // `isDefault` not always present in older brokers; fall back to false.
        isDefault: (e as { isDefault?: boolean }).isDefault ?? false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({
      topic,
      partitions,
      replicationFactor,
      configs,
      ts: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 503 },
    );
  }
}
