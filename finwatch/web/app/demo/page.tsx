import { InsertAndTrace } from "@/components/insert-and-trace";

export const metadata = { title: "FinWatch · Insert & trace demo" };

export default function DemoPage() {
  return (
    <main className="min-h-[calc(100vh-3rem)]">
      <div className="max-w-[1400px] mx-auto px-5 lg:px-8 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            Insert &amp; trace <span className="text-accent">·</span> drive the pipeline by hand
          </h1>
          <p className="text-sm text-gray-400 mt-1 max-w-3xl">
            Insert a transaction directly into PostgreSQL and watch it propagate live through Debezium → Kafka → ClickHouse.
            The particle for your row is highlighted with a blue ring.
          </p>
        </header>
        <InsertAndTrace />
      </div>
    </main>
  );
}
