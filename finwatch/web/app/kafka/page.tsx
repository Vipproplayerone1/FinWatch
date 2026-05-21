import { KafkaBrowser } from "@/components/kafka-browser";

export const metadata = { title: "FinWatch · Kafka" };

export default function KafkaPage() {
  return (
    <main className="min-h-[calc(100vh-3rem)]">
      <div className="max-w-[1400px] mx-auto px-5 lg:px-8 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            Kafka <span className="text-accent">·</span> topic browser
          </h1>
          <p className="text-sm text-gray-400 mt-1 max-w-3xl">
            Internal read-only browser for the three <code className="text-gray-300">finwatch.public.*</code> CDC
            topics. Inspect recent messages, watch the live tail during a demo, see per-partition consumer lag
            for Debezium / ClickHouse, and read topic configs — no need to leave the page.
          </p>
        </header>
        <KafkaBrowser />
      </div>
    </main>
  );
}
