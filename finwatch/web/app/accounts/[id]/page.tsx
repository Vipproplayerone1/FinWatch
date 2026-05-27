"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { SeverityBadge, RuleBadge } from "@/components/badges";

type Account = {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  balance: number;
  currency: string;
  status: string;
  created_at: string;
  updated_at: string;
};
type Txn = {
  id: string;
  type: string;
  status: string;
  amount: number;
  currency: string;
  description: string | null;
  merchant_name: string | null;
  created_at: string;
};
type Alert = {
  id: string;
  rule_code: string;
  severity: string;
  txn_count: number;
  total_amount: number;
  status: string;
  evidence: string;
  created_at: string;
};

const fetcher = (u: string) => fetch(u).then((r) => r.json());

const formatVND = (n: number, ccy = "VND") =>
  Number.isFinite(n)
    ? `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${ccy}`
    : "—";

const formatTime = (iso: string) => {
  const d = new Date(iso.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "active"    ? "text-accent-ok      bg-accent-ok/10"
  : status === "suspended" ? "text-accent-danger  bg-accent-danger/10"
  : status === "closed"    ? "text-gray-400       bg-gray-500/10"
  :                          "text-gray-300       bg-gray-500/10";
  return (
    <span className={`px-2 py-0.5 rounded text-xs uppercase font-medium ${cls}`}>{status}</span>
  );
}

const TOPUP_PRESETS = [1_000_000, 10_000_000, 100_000_000];

export default function AccountDetailPage({ params }: { params: { id: string } }) {
  const id = params.id;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupAmount, setTopupAmount] = useState<string>("10000000");

  const acctReq  = useSWR<{ account: Account; error?: string }>(`/api/accounts/${id}`,              fetcher, { refreshInterval: 5000 });
  const txnReq   = useSWR<{ rows: Txn[]    ; error?: string }>(`/api/accounts/${id}/transactions`,  fetcher, { refreshInterval: 5000 });
  const alertReq = useSWR<{ rows: Alert[]  ; error?: string }>(`/api/accounts/${id}/alerts`,        fetcher, { refreshInterval: 5000 });

  const account = acctReq.data?.account;
  const txns    = txnReq.data?.rows   ?? [];
  const alerts  = alertReq.data?.rows ?? [];

  async function lockOrUnlock(action: "lock" | "unlock") {
    if (busy) return;
    const verb = action === "lock" ? "Suspend" : "Reactivate";
    if (!confirm(`${verb} this account? This affects every transaction-creating code path.`)) return;
    setBusy(true);
    setActionError(null);
    try {
      const r = await fetch(`/api/accounts/${id}/${action}`, { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setActionError(body.error ? `${body.error} (current=${body.current_status ?? "?"})` : `HTTP ${r.status}`);
      }
      // Force SWR to refetch immediately.
      acctReq.mutate();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitTopup() {
    if (busy) return;
    const amt = Number(topupAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setActionError("Top-up amount must be > 0");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const r = await fetch(`/api/accounts/${id}/topup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amt }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setActionError(body.error ?? `HTTP ${r.status}`);
      } else {
        setTopupOpen(false);
        // Trigger immediate refetch — balance + transactions panel.
        acctReq.mutate();
        txnReq.mutate();
      }
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-[calc(100vh-3rem)]">
      <div className="max-w-[1400px] mx-auto px-5 lg:px-8 py-8">
        <div className="mb-4 text-xs">
          <Link href="/accounts" className="text-accent hover:underline">← Accounts</Link>
        </div>

        {!account ? (
          <div className="panel p-6 text-gray-400">
            {acctReq.data?.error ? `Error: ${acctReq.data.error}` : "Loading…"}
          </div>
        ) : (
          <>
            {/* Identity header + actions */}
            <header className="panel p-5 mb-4 flex flex-col md:flex-row md:items-end md:justify-between gap-3">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">{account.full_name}</h1>
                <div className="text-sm text-gray-400 mt-1">
                  {account.email}
                  {account.phone && <span className="text-gray-500"> · {account.phone}</span>}
                </div>
                <div className="text-xs text-gray-500 mt-1 font-mono">{account.id}</div>
              </div>
              <div className="flex flex-col md:items-end gap-2">
                <div className="font-mono text-3xl kpi-value">
                  {formatVND(Number(account.balance), account.currency)}
                </div>
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  <StatusBadge status={account.status} />
                  {account.status === "active" && (
                    <>
                      <button
                        disabled={busy}
                        onClick={() => { setActionError(null); setTopupOpen((v) => !v); }}
                        className="px-3 py-1.5 rounded text-sm bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30 disabled:opacity-50"
                      >
                        {topupOpen ? "Cancel" : "Top up balance"}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => lockOrUnlock("lock")}
                        className="px-3 py-1.5 rounded text-sm bg-accent-danger/20 text-accent-danger border border-accent-danger/40 hover:bg-accent-danger/30 disabled:opacity-50"
                      >
                        Suspend
                      </button>
                    </>
                  )}
                  {account.status === "suspended" && (
                    <button
                      disabled={busy}
                      onClick={() => lockOrUnlock("unlock")}
                      className="px-3 py-1.5 rounded text-sm bg-accent-ok/20 text-accent-ok border border-accent-ok/40 hover:bg-accent-ok/30 disabled:opacity-50"
                    >
                      Reactivate
                    </button>
                  )}
                </div>
                {topupOpen && account.status === "active" && (
                  <div className="mt-1 flex flex-col gap-2 items-end">
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        value={topupAmount}
                        onChange={(e) => setTopupAmount(e.target.value)}
                        placeholder="Amount in VND"
                        className="w-44 px-2 py-1.5 rounded bg-[#0c1220] border border-bg-ring/60 text-sm font-mono text-gray-200 focus:outline-none focus:border-accent/60"
                      />
                      <button
                        disabled={busy}
                        onClick={submitTopup}
                        className="px-3 py-1.5 rounded text-sm bg-accent-ok/20 text-accent-ok border border-accent-ok/40 hover:bg-accent-ok/30 disabled:opacity-50"
                      >
                        {busy ? "Posting…" : "Confirm deposit"}
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {TOPUP_PRESETS.map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setTopupAmount(String(n))}
                          className="px-2 py-0.5 text-[11px] rounded bg-bg-ring/40 text-gray-300 hover:bg-bg-ring/60"
                        >
                          +{(n / 1_000_000).toLocaleString()}M
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {actionError && <div className="text-xs text-accent-danger">Error: {actionError}</div>}
              </div>
            </header>

            <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Recent transactions */}
              <div className="panel p-4">
                <div className="panel-title mb-2">Recent transactions · last 20</div>
                <div className="overflow-auto scrollbar-thin max-h-[520px]">
                  <table className="w-full text-sm">
                    <thead className="text-xs uppercase text-gray-500 sticky top-0 bg-[#10172a]">
                      <tr>
                        <th className="text-left  py-2 pr-2">Time</th>
                        <th className="text-left  py-2 pr-2">Type</th>
                        <th className="text-left  py-2 pr-2">Merchant</th>
                        <th className="text-right py-2 pr-2">Amount</th>
                        <th className="text-left  py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {txns.map((t) => (
                        <tr
                          key={t.id}
                          className={`border-t border-bg-ring/30 ${t.status === "failed" ? "text-accent-danger/90" : ""}`}
                        >
                          <td className="py-1.5 pr-2 font-mono text-xs text-gray-400">{formatTime(t.created_at)}</td>
                          <td className="py-1.5 pr-2 text-gray-300">{t.type}</td>
                          <td className="py-1.5 pr-2 text-gray-300 truncate max-w-[180px]">{t.merchant_name ?? "—"}</td>
                          <td className="py-1.5 pr-2 text-right font-mono">{formatVND(Number(t.amount), t.currency)}</td>
                          <td className="py-1.5">{t.status}</td>
                        </tr>
                      ))}
                      {txns.length === 0 && (
                        <tr><td colSpan={5} className="py-6 text-center text-gray-500">No transactions yet.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Alert history */}
              <div className="panel p-4">
                <div className="panel-title mb-2">Alert history · last 20</div>
                <div className="overflow-auto scrollbar-thin max-h-[520px]">
                  <table className="w-full text-sm">
                    <thead className="text-xs uppercase text-gray-500 sticky top-0 bg-[#10172a]">
                      <tr>
                        <th className="text-left  py-2 pr-2">Time</th>
                        <th className="text-left  py-2 pr-2">Rule</th>
                        <th className="text-left  py-2 pr-2">Severity</th>
                        <th className="text-right py-2 pr-2">Txn count</th>
                        <th className="text-left  py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {alerts.map((a) => (
                        <tr key={a.id} className="border-t border-bg-ring/30">
                          <td className="py-1.5 pr-2 font-mono text-xs text-gray-400">{formatTime(a.created_at)}</td>
                          <td className="py-1.5 pr-2"><RuleBadge rule={a.rule_code} /></td>
                          <td className="py-1.5 pr-2"><SeverityBadge severity={a.severity} /></td>
                          <td className="py-1.5 pr-2 text-right font-mono text-gray-300">{a.txn_count}</td>
                          <td className="py-1.5 text-gray-300">{a.status}</td>
                        </tr>
                      ))}
                      {alerts.length === 0 && (
                        <tr><td colSpan={5} className="py-6 text-center text-gray-500">No alerts yet.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
