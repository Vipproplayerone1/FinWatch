import { Kafka, type Admin, type Consumer } from "kafkajs";

declare global {
  // eslint-disable-next-line no-var
  var __kafka: Kafka | undefined;
  // eslint-disable-next-line no-var
  var __kafkaAdmin: Admin | undefined;
}

function build(): Kafka {
  return new Kafka({
    clientId: "finwatch-ui",
    brokers: [process.env.KAFKA_BROKER ?? "kafka:9092"],
    connectionTimeout: 5_000,
    requestTimeout: 10_000,
  });
}

export const kafka: Kafka = global.__kafka ?? build();
if (process.env.NODE_ENV !== "production") {
  global.__kafka = kafka;
}

/**
 * Cached admin client. The first caller pays the connect() cost; subsequent
 * callers reuse the same connection. kafkajs is safe to share across requests.
 */
export async function getAdmin(): Promise<Admin> {
  if (global.__kafkaAdmin) return global.__kafkaAdmin;
  const admin = kafka.admin();
  await admin.connect();
  global.__kafkaAdmin = admin;
  return admin;
}

export interface KafkaMessageRecord {
  partition: number;
  offset: string;
  timestamp: string;
  key: string | null;
  value: unknown;
}

/**
 * Short-lived consumer that reads up to `limit` recent messages from `topic`.
 * Strategy:
 *   1. Pre-compute the cutoff offset per partition (high - limit, clamped to low).
 *   2. Subscribe from the beginning so we don't race a seek-to vs the consumer's
 *      first fetch (which empirically misses messages on a brand-new group).
 *   3. In eachMessage, skip messages with offset < cutoff. Once we've collected
 *      the expected count for all partitions, resolve and disconnect.
 *   4. Hard timeout (8 s) guarantees the request returns even if traffic stalls.
 *
 * This re-reads the whole topic backwards each call, but for our finite
 * finwatch.public.* topics (typically <1000 messages each) it's effectively
 * free and avoids the seek-after-join race in kafkajs.
 *
 * groupId is unique per call so we never interfere with debezium / clickhouse.
 */
export async function consumeRecent(topic: string, limit: number): Promise<KafkaMessageRecord[]> {
  const admin = await getAdmin();
  const offsets = await admin.fetchTopicOffsets(topic);

  // Per-partition: cutoff offset and expected count.
  const partitionPlan = new Map<number, { cutoff: bigint; expected: number }>();
  for (const p of offsets) {
    const high = BigInt(p.offset);
    const low = BigInt(p.low);
    const lag = high - low;                  // retained messages
    const want = lag < BigInt(limit) ? lag : BigInt(limit);
    partitionPlan.set(p.partition, {
      cutoff: high - want,                   // first offset we care about
      expected: Number(want),
    });
  }

  const expectedTotal = Array.from(partitionPlan.values()).reduce((s, p) => s + p.expected, 0);
  if (expectedTotal === 0) return [];

  const consumer: Consumer = kafka.consumer({
    groupId: `ui-browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionTimeout: 10_000,
    rebalanceTimeout: 8_000,
  });

  const collected: KafkaMessageRecord[] = [];
  const collectedByPart = new Map<number, number>();
  const HARD_TIMEOUT_MS = 8_000;

  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });

  return new Promise<KafkaMessageRecord[]>((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Disconnect in background. Resolving first guarantees the HTTP handler
      // unblocks even if disconnect() stalls (it sometimes does on hot reload).
      consumer.disconnect().catch(() => {});
      resolve(collected.slice(-limit));
    };

    const timer = setTimeout(finish, HARD_TIMEOUT_MS);

    consumer
      .run({
        autoCommit: false,
        eachMessage: async ({ partition, message }) => {
          if (done) return;
          const offsetBig = BigInt(message.offset);
          const plan = partitionPlan.get(partition);
          if (!plan || offsetBig < plan.cutoff) return; // before our tail window

          const rawValue = message.value?.toString("utf8") ?? null;
          let parsedValue: unknown = rawValue;
          if (rawValue) {
            try { parsedValue = JSON.parse(rawValue); } catch { parsedValue = rawValue; }
          }
          collected.push({
            partition,
            offset: message.offset,
            timestamp: message.timestamp,
            key: message.key ? message.key.toString("utf8") : null,
            value: parsedValue,
          });
          collectedByPart.set(partition, (collectedByPart.get(partition) ?? 0) + 1);

          // Finish as soon as every partition has yielded its expected count.
          let ready = true;
          for (const [part, p] of partitionPlan) {
            if ((collectedByPart.get(part) ?? 0) < p.expected) { ready = false; break; }
          }
          if (ready) finish();
        },
      })
      .catch((err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        consumer.disconnect().catch(() => {});
        reject(err);
      });
  });
}
