"use client";
import useSWR from "swr";

type Alert = {
  rule: string;
  severity: "high" | "medium" | string;
  subject: string;
  detected_at_ms: number;
  message: string;
};
type Resp = { alerts: Alert[]; error?: string };

const fetcher = (u: string) => fetch(u).then((r) => r.json());

const ruleLabel: Record<string, string> = {
  VELOCITY:   "Velocity",
  LARGE_AMT:  "Large amount",
  MULTI_CCY:  "Multi-currency",
  ZSCORE:     "Z-score",
  HIGH_RISK:  "High-risk merchant",
  FAIL_SPIKE: "Failure spike",
};

const severityDot = (s: string) =>
  s === "high"   ? "bg-accent-danger" :
  s === "medium" ? "bg-accent-warn"   :
  "bg-gray-500";

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function AlertFeed() {
  const { data } = useSWR<Resp>("/api/alerts/recent", fetcher, {
    refreshInterval: 1500,
    revalidateOnFocus: false,
  });

  const alerts = data?.alerts ?? [];

  return (
    <div className="panel p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <div className="panel-title">Fraud alerts · last 10 min</div>
        <div className="text-xs text-gray-500">{alerts.length} active</div>
      </div>
      <div className="overflow-auto scrollbar-thin flex-1 space-y-2">
        {alerts.length === 0 && (
          <div className="text-center text-gray-500 py-8 text-sm">
            No anomalies detected. Run <code className="text-gray-300">scripts/simulate_fraud.py --pattern all</code>
          </div>
        )}
        {alerts.map((a, i) => (
          <div
            key={`${a.rule}-${a.subject}-${a.detected_at_ms}-${i}`}
            className="flex items-start gap-3 p-2.5 rounded-md border border-bg-ring/60 bg-[#0e1424] animate-slideIn"
          >
            <span className={`mt-1.5 inline-block w-2 h-2 rounded-full ${severityDot(a.severity)} animate-pulseDot`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-semibold uppercase tracking-wider text-gray-100">
                  {ruleLabel[a.rule] ?? a.rule}
                </span>
                <span className="text-gray-500 font-mono">
                  {new Date(a.detected_at_ms).toLocaleTimeString()}
                </span>
              </div>
              <div className="text-sm text-gray-200 mt-0.5">{a.message}</div>
              <div className="text-xs text-gray-500 font-mono mt-0.5">acct {truncate(a.subject, 18)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
