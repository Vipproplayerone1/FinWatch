import { FraudDetectionGrid } from "@/components/fraud-grid";

export const metadata = { title: "FinWatch · Fraud rules" };

export default function FraudPage() {
  return (
    <main className="min-h-[calc(100vh-3rem)]">
      <div className="max-w-[1400px] mx-auto px-5 lg:px-8 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            Fraud detection <span className="text-accent">·</span> 6 rules
          </h1>
          <p className="text-sm text-gray-400 mt-1 max-w-3xl">
            Each card runs one rule from <code className="text-gray-300">clickhouse/queries/anomaly_*.sql</code> against
            live data. Counts refresh every 10 s; sparklines show the last 30 minutes of flagged events.
          </p>
        </header>
        <FraudDetectionGrid />
      </div>
    </main>
  );
}
