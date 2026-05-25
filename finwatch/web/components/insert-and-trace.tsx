"use client";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { ArchitectureFlow } from "./architecture-flow";
import { TransactionTracer } from "./transaction-tracer";

interface Account { id: string; full_name: string; email: string }
interface Merchant { id: string; name: string; risk_level: string }

const CURRENCIES = ["VND", "USD", "EUR", "JPY", "THB"] as const;
const TYPES = ["purchase", "transfer", "withdrawal"] as const;
const STATUSES = ["completed", "failed", "pending"] as const;

const fetcher = (u: string) => fetch(u).then((r) => r.json());

type Stage = "pending" | "active" | "done";

interface StageState {
  pg: Stage;     pgMs?: number;
  debe: Stage;   debeMs?: number;
  kafka: Stage;  kafkaMs?: number;
  ch: Stage;    chMs?: number;
}

const INITIAL_STAGES: StageState = {
  pg: "pending", debe: "pending", kafka: "pending", ch: "pending",
};

function StageRow({ label, sub, state, ms, totalMs }: { label: string; sub: string; state: Stage; ms?: number; totalMs?: number }) {
  const dot =
    state === "done"   ? "bg-emerald-500" :
    state === "active" ? "bg-amber-500 animate-pulse" :
    "bg-gray-600";
  return (
    <div className="flex items-start gap-3 p-2.5 rounded-md border border-bg-ring/40 bg-[#0e1424]">
      <div className={`mt-1.5 w-2.5 h-2.5 rounded-full ${dot}`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-100">
          {state === "done" ? "✓ " : state === "active" ? "⋯ " : "○ "}
          {label}
        </div>
        <div className="text-[11px] text-gray-500">{sub}</div>
      </div>
      <div className="text-xs font-mono text-gray-300 self-center min-w-[80px] text-right">
        {state === "done"
          ? (typeof totalMs === "number" ? `${totalMs} ms` : (typeof ms === "number" ? `${ms} ms` : ""))
          : state === "active" ? "waiting…" : "—"}
      </div>
    </div>
  );
}

const PRESETS = [
  { scenario: "card-cloning",     label: "Velocity (card-cloning)",   sub: "15 rapid micro-purchases" },
  { scenario: "wire-fraud",       label: "Large amount (wire-fraud)", sub: "250M VND single transfer" },
  { scenario: "fx-laundering",    label: "Multi-currency (FX)",       sub: "5 currencies in 10 min" },
];

export function InsertAndTrace() {
  const { data: accountsData } = useSWR<{ accounts: Account[] }>("/api/accounts", fetcher, { revalidateOnFocus: false });
  const { data: merchantsData } = useSWR<{ merchants: Merchant[] }>("/api/merchants", fetcher, { revalidateOnFocus: false });

  const [accountId, setAccountId]   = useState<string>("");
  const [merchantId, setMerchantId] = useState<string>("");
  const [amount, setAmount]         = useState<string>("150000");
  const [currency, setCurrency]     = useState<typeof CURRENCIES[number]>("VND");
  const [type, setType]             = useState<typeof TYPES[number]>("purchase");
  const [status, setStatus]         = useState<typeof STATUSES[number]>("completed");
  const [description, setDescription] = useState<string>("Demo from UI");

  const [lastId, setLastId]   = useState<string | undefined>(undefined);
  const [stages, setStages]   = useState<StageState>(INITIAL_STAGES);
  const [toast, setToast]     = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [busy, setBusy]       = useState<string | null>(null);

  // Default-select first option once data lands.
  useEffect(() => {
    if (accountsData?.accounts?.[0] && !accountId) setAccountId(accountsData.accounts[0].id);
  }, [accountsData, accountId]);
  useEffect(() => {
    if (merchantsData?.merchants?.[0] && !merchantId) setMerchantId(merchantsData.merchants[0].id);
  }, [merchantsData, merchantId]);

  async function submitInsert() {
    setToast(null);
    if (!accountId || !merchantId) { setToast({ kind: "err", msg: "Pick account and merchant" }); return; }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) { setToast({ kind: "err", msg: "Amount must be > 0" }); return; }

    setBusy("insert");
    setStages({ pg: "active", debe: "pending", kafka: "pending", ch: "pending" });

    const submittedAt = Date.now();
    try {
      const r = await fetch("/api/insert-transaction", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: accountId, merchant_id: merchantId, amount: amt, currency, type, status, description }),
      });
      const j = await r.json();
      if (!r.ok) { setToast({ kind: "err", msg: j.error ?? r.statusText }); setBusy(null); setStages(INITIAL_STAGES); return; }

      const id: string | undefined = j.id ?? j.txn_id;
      if (!id) {
        setToast({ kind: "err", msg: "Insert succeeded but API returned no row id" });
        setBusy(null);
        setStages(INITIAL_STAGES);
        return;
      }
      setLastId(id);
      const pgMs = Date.now() - submittedAt;
      setStages({ pg: "done", pgMs, debe: "active", kafka: "pending", ch: "pending" });

      // The ledger may have rejected the txn (status='failed' with a reason).
      // The row still exists in PG and will propagate to CH, so we keep tracing,
      // but tell the user up front so the toast isn't misleading.
      const headline =
        j.accepted === false
          ? (j.reason === "insufficient_funds"
              ? `Rejected (insufficient funds) · row ${id.slice(0, 8)}… still flows to CDC`
              : `Rejected (account ${j.reason}) · row ${id.slice(0, 8)}… still flows to CDC`)
          : `Inserted ${id.slice(0, 8)}… — waiting for CDC`;
      setToast({ kind: j.accepted === false ? "err" : "ok", msg: headline });

      // Poll for the row to appear in ClickHouse. Use the same submittedAt
      // baseline so per-hop "ms" is consistent.
      const deadline = Date.now() + 30_000;
      let appearedAt: number | null = null;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 500));
        try {
          const cr = await fetch(`/api/transactions/${id}`);
          if (cr.ok) {
            const cj = await cr.json();
            if (cj.found) { appearedAt = Date.now(); break; }
          }
        } catch { /* keep polling */ }
        // Move the visible stage forward at 800ms / 1600ms heuristics so the
        // UI looks alive while we wait.
        const elapsed = Date.now() - submittedAt;
        setStages((s) => ({
          ...s,
          debe:  elapsed >  800 ? "done" : s.debe,
          debeMs: elapsed > 800 ? Math.min(elapsed, 800) : s.debeMs,
          kafka: elapsed > 1600 ? "active" : s.kafka,
        }));
      }

      if (appearedAt) {
        const totalMs = appearedAt - submittedAt;
        setStages({
          pg:   "done", pgMs,
          debe: "done", debeMs: Math.min(800, totalMs),
          kafka:"done", kafkaMs: Math.min(1600, totalMs),
          ch:   "done", chMs: totalMs,
        });
        setToast({ kind: "ok", msg: `Visible in ClickHouse in ${totalMs} ms` });
      } else {
        setToast({ kind: "err", msg: "Row never appeared in ClickHouse within 30 s — check connector" });
      }
    } catch (e) {
      setToast({ kind: "err", msg: (e as Error).message });
      setStages(INITIAL_STAGES);
    } finally {
      setBusy(null);
    }
  }

  async function runPreset(scenario: string) {
    setBusy(scenario);
    setToast(null);
    try {
      const r = await fetch("/api/scenarios/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario }),
      });
      const j = await r.json();
      if (!r.ok) setToast({ kind: "err", msg: j.error ?? r.statusText });
      else setToast({ kind: "ok", msg: `${j.rule} fired · ${j.rowsInserted} rows in ${(j.durationMs/1000).toFixed(1)}s` });
    } catch (e) {
      setToast({ kind: "err", msg: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Preset strip */}
      <div className="panel p-4">
        <div className="panel-title mb-2">Try sample fraud patterns</div>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.scenario}
              onClick={() => runPreset(p.scenario)}
              disabled={busy !== null}
              className="rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-300 px-3 py-2 hover:bg-rose-500/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
              title={p.sub}
            >
              <div className="text-sm font-semibold">{busy === p.scenario ? "running…" : p.label}</div>
              <div className="text-[10px] opacity-70">{p.sub}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-4">
        {/* LEFT: form */}
        <div className="panel p-5">
          <div className="panel-title mb-3">Insert transaction</div>
          <div className="space-y-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-gray-500">Account</label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full mt-1 px-2 py-1.5 rounded-md bg-[#0c1220] border border-bg-ring/60 text-sm text-gray-200 focus:outline-none focus:border-accent/60"
              >
                {(accountsData?.accounts ?? []).map((a) => (
                  <option key={a.id} value={a.id}>{a.full_name} · {a.email}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs uppercase tracking-wider text-gray-500">Merchant</label>
              <select
                value={merchantId}
                onChange={(e) => setMerchantId(e.target.value)}
                className="w-full mt-1 px-2 py-1.5 rounded-md bg-[#0c1220] border border-bg-ring/60 text-sm text-gray-200 focus:outline-none focus:border-accent/60"
              >
                {(merchantsData?.merchants ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}{m.risk_level === "high" ? " · HIGH RISK" : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-xs uppercase tracking-wider text-gray-500">Amount</label>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  min={0}
                  className="w-full mt-1 px-2 py-1.5 rounded-md bg-[#0c1220] border border-bg-ring/60 text-sm font-mono text-gray-200 focus:outline-none focus:border-accent/60"
                />
              </div>
              <div className="w-28">
                <label className="text-xs uppercase tracking-wider text-gray-500">Currency</label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value as typeof CURRENCIES[number])}
                  className="w-full mt-1 px-2 py-1.5 rounded-md bg-[#0c1220] border border-bg-ring/60 text-sm text-gray-200 focus:outline-none focus:border-accent/60"
                >
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs uppercase tracking-wider text-gray-500">Type</label>
              <div className="mt-1 flex gap-2">
                {TYPES.map((t) => (
                  <label key={t} className={`px-3 py-1.5 rounded-md border text-sm cursor-pointer ${type === t ? "border-accent/60 bg-accent/10 text-accent" : "border-bg-ring/60 text-gray-300 hover:bg-bg-ring/40"}`}>
                    <input type="radio" name="type" value={t} checked={type === t} onChange={() => setType(t)} className="hidden" />
                    {t}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs uppercase tracking-wider text-gray-500">Status</label>
              <div className="mt-1 flex gap-2">
                {STATUSES.map((s) => (
                  <label key={s} className={`px-3 py-1.5 rounded-md border text-sm cursor-pointer ${status === s ? "border-accent/60 bg-accent/10 text-accent" : "border-bg-ring/60 text-gray-300 hover:bg-bg-ring/40"}`}>
                    <input type="radio" name="status" value={s} checked={status === s} onChange={() => setStatus(s)} className="hidden" />
                    {s}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs uppercase tracking-wider text-gray-500">Description</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full mt-1 px-2 py-1.5 rounded-md bg-[#0c1220] border border-bg-ring/60 text-sm text-gray-200 focus:outline-none focus:border-accent/60"
              />
            </div>

            <button
              onClick={submitInsert}
              disabled={busy !== null}
              className="w-full mt-2 px-4 py-2.5 rounded-md bg-accent/20 border border-accent/40 text-accent font-semibold hover:bg-accent/30 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === "insert" ? "Inserting & tracing…" : "Insert & Trace"}
            </button>

            {toast && (
              <div className={`mt-2 text-xs px-3 py-2 rounded-md border ${
                toast.kind === "ok"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-rose-500/40 bg-rose-500/10 text-rose-300"
              }`}>
                {toast.msg}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: live flow + stages */}
        <div className="space-y-4">
          <ArchitectureFlow highlightId={lastId} />

          <div className="panel p-4">
            <div className="panel-title mb-2">Propagation status</div>
            <div className="space-y-2">
              <StageRow label="PostgreSQL commit"  sub="Postgres returned id"               state={stages.pg}    ms={stages.pgMs} />
              <StageRow label="Debezium captured"  sub="estimated read lag ~50 ms"          state={stages.debe}  ms={stages.debeMs} />
              <StageRow label="Kafka available"    sub="estimated produce + replicate"      state={stages.kafka} ms={stages.kafkaMs} />
              <StageRow label="ClickHouse visible" sub="measured: row appears via FINAL"    state={stages.ch}    totalMs={stages.chMs} />
            </div>
          </div>
        </div>
      </div>

      {/* TRACER (auto-mounts once we have an id and the row is visible) */}
      {lastId && stages.ch === "done" && (
        <div>
          <div className="panel-title my-3">Per-hop trace</div>
          <TransactionTracer txnId={lastId} />
        </div>
      )}
    </div>
  );
}
