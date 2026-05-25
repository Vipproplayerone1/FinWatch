"use client";
import { useState, useEffect } from "react";
import useSWR from "swr";
import Link from "next/link";

type Row = {
  id: string;
  full_name: string;
  email: string;
  balance: number;
  status: string;
  open_alerts_24h: number;
};
type Resp = { rows: Row[]; error?: string };

const fetcher = (u: string) => fetch(u).then((r) => r.json());

const formatVND = (n: number) =>
  Number.isFinite(n)
    ? `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} VND`
    : "—";

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "active"    ? "text-accent-ok      bg-accent-ok/10"
  : status === "suspended" ? "text-accent-danger  bg-accent-danger/10"
  : status === "closed"    ? "text-gray-400       bg-gray-500/10"
  :                          "text-gray-300       bg-gray-500/10";
  return (
    <span className={`px-2 py-0.5 rounded text-xs uppercase font-medium ${cls}`}>
      {status}
    </span>
  );
}

export default function AccountsPage() {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");

  // Debounce the search input by 300 ms.
  useEffect(() => {
    const t = setTimeout(() => setQ(input.trim()), 300);
    return () => clearTimeout(t);
  }, [input]);

  const { data } = useSWR<Resp>(
    `/api/accounts/search?q=${encodeURIComponent(q)}&limit=50`,
    fetcher,
    { refreshInterval: 5000, revalidateOnFocus: false },
  );
  const rows = data?.rows ?? [];

  return (
    <main className="min-h-[calc(100vh-3rem)]">
      <div className="max-w-[1400px] mx-auto px-5 lg:px-8 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            Accounts <span className="text-accent">·</span> directory
          </h1>
          <p className="text-sm text-gray-400 mt-1 max-w-3xl">
            Search by name or email. Counts of <code className="text-gray-300">open</code>{" "}
            alerts in the last 24 hours come from <code className="text-gray-300">fraud_alerts FINAL</code>.
            Refresh every 5 s.
          </p>
        </header>

        <div className="panel p-4">
          <div className="mb-3 flex items-center gap-3">
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Search by name or email…"
              className="w-full max-w-md bg-[#0c1220] border border-bg-ring/60 rounded px-3 py-1.5 text-sm placeholder:text-gray-500 focus:outline-none focus:border-accent/60"
            />
            <span className="text-xs text-gray-500">{rows.length} accounts</span>
          </div>

          <div className="overflow-auto scrollbar-thin">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-gray-500">
                <tr className="border-b border-bg-ring/40">
                  <th className="text-left  py-2 pr-2">Name</th>
                  <th className="text-left  py-2 pr-2">Email</th>
                  <th className="text-right py-2 pr-2">Balance</th>
                  <th className="text-left  py-2 pr-2">Status</th>
                  <th className="text-right py-2 pr-2">Open alerts (24h)</th>
                  <th className="text-right py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-bg-ring/20 hover:bg-bg-ring/20">
                    <td className="py-2 pr-2 text-gray-100">{r.full_name}</td>
                    <td className="py-2 pr-2 text-gray-300">{r.email}</td>
                    <td className="py-2 pr-2 text-right font-mono kpi-value">
                      {formatVND(Number(r.balance))}
                    </td>
                    <td className="py-2 pr-2"><StatusBadge status={r.status} /></td>
                    <td className="py-2 pr-2 text-right font-mono">
                      {r.open_alerts_24h > 0 ? (
                        <span className="text-accent-warn">{r.open_alerts_24h}</span>
                      ) : (
                        <span className="text-gray-500">0</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <Link
                        href={`/accounts/${r.id}`}
                        className="text-accent hover:underline text-xs"
                      >
                        View →
                      </Link>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={6} className="py-8 text-center text-gray-500">
                    {data?.error ? `Error: ${data.error}` : "No accounts match."}
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
