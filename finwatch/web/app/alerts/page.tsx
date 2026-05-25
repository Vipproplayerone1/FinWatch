"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";

type Row = {
  id: string;
  account_id: string;
  account_name: string | null;
  rule_code: string;
  severity: string;
  txn_count: number;
  total_amount: number;
  status: string;
  created_at: string;
};
type Resp = { rows: Row[]; error?: string };

const fetcher = (u: string) => fetch(u).then((r) => r.json());

const RULES = ["VELOCITY", "LARGE_AMT", "MULTI_CCY", "ZSCORE", "HIGH_RISK", "FAIL_SPIKE"] as const;
const SEVERITIES = ["low", "medium", "high", "critical"] as const;

const formatVND = (n: number) =>
  Number.isFinite(n) && n > 0
    ? `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} VND`
    : "—";

const formatTime = (iso: string) => {
  const d = new Date(iso.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

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

function SeverityBadge({ severity }: { severity: string }) {
  const cls =
    severity === "critical" ? "text-red-300       bg-red-500/15"
  : severity === "high"     ? "text-accent-danger bg-accent-danger/10"
  : severity === "medium"   ? "text-accent-warn   bg-accent-warn/10"
  : severity === "low"      ? "text-gray-300      bg-gray-500/10"
  :                            "text-gray-300      bg-gray-500/10";
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-medium ${cls}`}>{severity}</span>
  );
}

function RuleBadge({ rule }: { rule: string }) {
  return (
    <span className="px-2 py-0.5 rounded text-[10px] uppercase font-mono bg-bg-ring/40 text-gray-200">
      {rule}
    </span>
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
  const rows = data?.rows ?? [];

  return (
    <main className="min-h-[calc(100vh-3rem)]">
      <div className="max-w-[1400px] mx-auto px-5 lg:px-8 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            Alert queue <span className="text-accent">·</span> {rows.length} cases
          </h1>
          <p className="text-sm text-gray-400 mt-1 max-w-3xl">
            Open cases written by <code className="text-gray-300">scripts/fraud_alert_worker.py</code>{" "}
            (1 h dedup per account+rule). Refresh every 5 s.
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
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500 mr-1 uppercase">Severity:</span>
            <Chip active={severity === ""} onClick={() => setSeverity("")}>All</Chip>
            {SEVERITIES.map((s) => (
              <Chip key={s} active={severity === s} onClick={() => setSeverity(s === severity ? "" : s)}>{s}</Chip>
            ))}
          </div>

          <div className="overflow-auto scrollbar-thin">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-gray-500 sticky top-0 bg-[#10172a]">
                <tr>
                  <th className="text-left  py-2 pr-2">Time</th>
                  <th className="text-left  py-2 pr-2">Account</th>
                  <th className="text-left  py-2 pr-2">Rule</th>
                  <th className="text-left  py-2 pr-2">Severity</th>
                  <th className="text-right py-2 pr-2">Txn count</th>
                  <th className="text-right py-2 pr-2">Total amount</th>
                  <th className="text-left  py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-bg-ring/30 hover:bg-bg-ring/20">
                    <td className="py-1.5 pr-2 font-mono text-xs text-gray-400">{formatTime(r.created_at)}</td>
                    <td className="py-1.5 pr-2">
                      <Link
                        href={`/accounts/${r.account_id}`}
                        className="text-accent hover:underline"
                      >
                        {r.account_name ?? r.account_id}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-2"><RuleBadge rule={r.rule_code} /></td>
                    <td className="py-1.5 pr-2"><SeverityBadge severity={r.severity} /></td>
                    <td className="py-1.5 pr-2 text-right font-mono text-gray-300">{r.txn_count}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{formatVND(Number(r.total_amount))}</td>
                    <td className="py-1.5 text-gray-300">{r.status}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={7} className="py-8 text-center text-gray-500">
                    {data?.error ? `Error: ${data.error}` : "No alerts match these filters."}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}
