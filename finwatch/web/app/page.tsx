import { ArchitectureFlow } from "@/components/architecture-flow";
import { HealthKpis } from "@/components/HealthKpis";
import { TpsChart } from "@/components/TpsChart";
import { TransactionStream } from "@/components/TransactionStream";
import { AlertFeed } from "@/components/AlertFeed";
import { DemoControls } from "@/components/DemoControls";

export default function Page() {
  return (
    <main className="min-h-screen p-5 lg:p-8">
      <header className="mb-5 flex flex-col lg:flex-row lg:items-end lg:justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            FinWatch <span className="text-accent">·</span> Real-Time Transaction Monitoring
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            PostgreSQL → Debezium → Kafka → ClickHouse · sub-second CDC pipeline
          </p>
          <p className="text-xs text-gray-500 mt-1">
            New: <a href="/demo" className="text-accent hover:underline">open the insert-and-trace demo tool →</a>
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span className="inline-block w-2 h-2 rounded-full bg-accent-ok animate-pulseDot" />
          live · polling every 1 s
        </div>
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <div className="lg:col-span-2"><ArchitectureFlow title="Pipeline Flow · live particles" /></div>
        <div><HealthKpis /></div>
      </section>

      <section className="mb-4"><DemoControls /></section>

      <section className="mb-4"><TpsChart /></section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-h-[460px]">
        <TransactionStream />
        <AlertFeed />
      </section>

      <footer className="mt-6 text-center text-xs text-gray-600">
        FinWatch demo UI · ClickHouse {process.env.CLICKHOUSE_HOST ?? "clickhouse"}:{process.env.CLICKHOUSE_PORT ?? "8123"}
      </footer>
    </main>
  );
}
