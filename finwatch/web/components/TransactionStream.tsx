"use client";
import useSWR from "swr";

type Row = {
  id: string;
  amount: string | number;
  currency: string;
  type: string;
  status: string;
  created_at: string;
  source_ts_ms: number;
  ingested_at: string;
  account_name: string | null;
  merchant_name: string | null;
  merchant_category: string | null;
  merchant_risk: string | null;
};
type Resp = { rows: Row[]; error?: string };

const fetcher = (u: string) => fetch(u).then((r) => r.json());

const statusColor = (s: string) =>
  s === "completed" ? "text-accent-ok" :
  s === "failed"    ? "text-accent-danger" :
  s === "flagged"   ? "text-accent-warn" :
  "text-gray-300";

const formatAmount = (a: string | number, ccy: string) => {
  const n = typeof a === "string" ? parseFloat(a) : a;
  if (!Number.isFinite(n)) return `— ${ccy}`;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${ccy}`;
};

const formatTime = (iso: string) => {
  const d = new Date(iso.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
};

export function TransactionStream() {
  const { data } = useSWR<Resp>("/api/transactions/live", fetcher, {
    refreshInterval: 1000,
    revalidateOnFocus: false,
  });

  const rows = data?.rows ?? [];

  return (
    <div className="panel p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <div className="panel-title">Live transaction stream</div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="inline-block w-2 h-2 rounded-full bg-accent-ok animate-pulseDot" />
          {rows.length} latest
        </div>
      </div>
      <div className="overflow-auto scrollbar-thin flex-1">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-[#10172a] text-xs uppercase text-gray-500">
            <tr>
              <th className="text-left py-2 pr-2">Time</th>
              <th className="text-left py-2 pr-2">Account → Merchant</th>
              <th className="text-right py-2 pr-2">Amount</th>
              <th className="text-left py-2 pr-2">Type</th>
              <th className="text-left py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={`${r.id}-${r.source_ts_ms}`}
                className="border-t border-bg-ring/40 animate-fadeIn"
              >
                <td className="py-1.5 pr-2 text-gray-400 font-mono text-xs">
                  {formatTime(r.created_at)}
                </td>
                <td className="py-1.5 pr-2 truncate max-w-[260px]">
                  <span className="text-gray-100">{r.account_name ?? "—"}</span>
                  <span className="text-gray-600 mx-1">→</span>
                  <span className="text-gray-300">{r.merchant_name ?? "—"}</span>
                  {r.merchant_risk === "high" && (
                    <span className="ml-2 text-[10px] uppercase text-accent-danger">high-risk</span>
                  )}
                </td>
                <td className="py-1.5 pr-2 text-right font-mono kpi-value">
                  {formatAmount(r.amount, r.currency)}
                </td>
                <td className="py-1.5 pr-2 text-gray-300">{r.type}</td>
                <td className={`py-1.5 ${statusColor(r.status)}`}>{r.status}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={5} className="py-8 text-center text-gray-500">
                Waiting for transactions… run <code className="text-gray-300">scripts/generate_transactions.py</code>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
