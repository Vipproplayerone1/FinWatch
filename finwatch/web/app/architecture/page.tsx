import { ArchitectureFlow } from "@/components/architecture-flow";

export const metadata = { title: "FinWatch · Architecture" };

export default function ArchitecturePage() {
  return (
    <main className="min-h-[calc(100vh-3rem)] bg-gradient-to-b from-[#0a0f1c] via-[#0b1224] to-[#0a0f1c]">
      <div className="max-w-[1400px] mx-auto px-5 lg:px-8 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            Pipeline <span className="text-accent">·</span> live flow
          </h1>
          <p className="text-sm text-gray-400 mt-1 max-w-3xl">
            Each particle below is one real database row flowing through Change Data Capture.
            Color = transaction type · size = amount · pulsing red glow = fraud-flagged (amount &gt; 100M VND).
          </p>
        </header>
        <ArchitectureFlow />
      </div>
    </main>
  );
}
