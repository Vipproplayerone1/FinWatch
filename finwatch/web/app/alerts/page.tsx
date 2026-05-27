"use client";
import { useState } from "react";
import useSWR from "swr";
import { AlertCard, type AlertGroup } from "@/components/AlertCard";

type Resp = { groups: AlertGroup[]; total_firings: number; error?: string };

const fetcher = (u: string) => fetch(u).then((r) => r.json());

const RULES = ["VELOCITY", "LARGE_AMT", "MULTI_CCY", "ZSCORE", "HIGH_RISK", "FAIL_SPIKE"] as const;
const SEVERITIES = ["low", "medium", "high", "critical"] as const;

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs uppercase font-mono transition ${
        active
          ? "bg-accent/20 text-accent border border-accent/40"
          : "bg-bg-ring/30 text-gray-400 border border-bg-ring/50 hover:text-gray-200"
      }`}
    >
      {children}
    </button>
  );
}

export default function AlertsPage() {
  const [rule, setRule] = useState<string>("");
  const [severity, setSeverity] = useState<string>("");

  const params = new URLSearchParams();
  if (rule) params.set("rule", rule);
  if (severity) params.set("severity", severity);

  const { data } = useSWR<Resp>(
    `/api/alerts?${params.toString()}`,
    fetcher,
    { refreshInterval: 5000, revalidateOnFocus: false },
  );
  const groups = data?.groups ?? [];
  const totalFirings = data?.total_firings ?? 0;

  return (
    <main className="min-h-[calc(100vh-3rem)]">
      <div className="max-w-[1400px] mx-auto px-5 lg:px-8 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            Alert queue <span className="text-accent">·</span> {groups.length} account
            {groups.length === 1 ? "" : "s"} · {totalFirings} firing{totalFirings === 1 ? "" : "s"}
          </h1>
          <p className="text-sm text-gray-400 mt-1 max-w-3xl">
            One card per account. Each card stacks every rule that fired and folds repeat firings
            under an expand toggle. Written by <code className="text-gray-300">scripts/fraud_alert_worker.py</code>.
            Refreshes every 5 s.
          </p>
        </header>

        <div className="panel p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500 mr-1 uppercase">Rule:</span>
            <Chip active={rule === ""} onClick={() => setRule("")}>All</Chip>
            {RULES.map((r) => (
              <Chip key={r} active={rule === r} onClick={() => setRule(r === rule ? "" : r)}>{r}</Chip>
            ))}
          </div>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500 mr-1 uppercase">Severity:</span>
            <Chip active={severity === ""} onClick={() => setSeverity("")}>All</Chip>
            {SEVERITIES.map((s) => (
              <Chip key={s} active={severity === s} onClick={() => setSeverity(s === severity ? "" : s)}>{s}</Chip>
            ))}
          </div>

          <div className="space-y-2">
            {groups.map((g) => (
              <AlertCard key={g.account_id} group={g} />
            ))}
            {groups.length === 0 && (
              <div className="py-8 text-center text-gray-500">
                {data?.error ? `Error: ${data.error}` : "No alerts match these filters."}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
