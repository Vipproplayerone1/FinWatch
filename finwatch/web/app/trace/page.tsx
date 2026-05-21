import { TransactionTracer } from "@/components/transaction-tracer";

export const metadata = { title: "FinWatch · Trace" };

export default function TracePage() {
  return (
    <main className="min-h-[calc(100vh-3rem)]">
      <div className="max-w-[1400px] mx-auto px-5 lg:px-8 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            Transaction <span className="text-accent">·</span> end-to-end trace
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Pick a transaction to see its journey through PG → Debezium → Kafka → ClickHouse with per-hop latency.
          </p>
        </header>
        <TransactionTracer />
      </div>
    </main>
  );
}
