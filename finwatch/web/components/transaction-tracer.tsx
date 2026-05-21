"use client";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";

interface TxnRow {
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
}

interface TxnFull {
  id: string;
  account_id: string;
  merchant_id: string | null;
  amount: number;
  currency: string;
  type: string;
  status: string;
  description: string | null;
  created_at: string;
  source_ts_ms: number;
  ingested_at: string;
  ingested_at_ms: number;
  cdc_op: string;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

// Per-hop latency thresholds (ms).
const GREEN_MAX = 1000;
const AMBER_MAX = 3000;

function latencyColor(ms: number) {
  if (ms < GREEN_MAX) return "bg-emerald-500/30 border-emerald-500/60 text-emerald-300";
  if (ms < AMBER_MAX) return "bg-amber-500/30  border-amber-500/60  text-amber-300";
  return "bg-rose-500/30 border-rose-500/60 text-rose-300";
}

function fmtMs(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatAmount(a: number | string, ccy: string) {
  const n = typeof a === "string" ? parseFloat(a) : a;
  if (!Number.isFinite(n)) return `— ${ccy}`;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${ccy}`;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
      }}
      className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border border-bg-ring/60 hover:bg-bg-ring/40 text-gray-400"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

export function TransactionTracer({ txnId: initialId }: { txnId?: string }) {
  // selectedId can be set from the sidebar or from a prop.
  const [selectedId, setSelectedId] = useState<string | undefined>(initialId);
  const [searchValue, setSearchValue] = useState("");

  useEffect(() => { setSelectedId(initialId); }, [initialId]);

  const { data: recent } = useSWR<{ rows: TxnRow[] }>(
    "/api/transactions/live",
    fetcher,
    { refreshInterval: 2000, revalidateOnFocus: false },
  );

  const { data: detail, isLoading } = useSWR<{ found: boolean; txn?: TxnFull; error?: string }>(
    selectedId ? `/api/transactions/${selectedId}` : null,
    fetcher,
    { refreshInterval: 5000, revalidateOnFocus: false },
  );

  const stages = useMemo(() => {
    if (!detail?.txn) return null;
    const t = detail.txn;
    const pgMs = t.source_ts_ms;
    const dbMs = pgMs + 50;
    const kafkaMs = pgMs + 200;
    const chMs = t.ingested_at_ms;
    return {
      pg:    { ts: pgMs,    label: "PostgreSQL commit",   sub: "from _source_ts_ms (WAL commit time)" },
      debe:  { ts: dbMs,    label: "Debezium captured",   sub: "estimated: pgMs + 50 ms (WAL read lag)" },
      kafka: { ts: kafkaMs, label: "Kafka available",     sub: "estimated: pgMs + 200 ms (produce + replicate)" },
      ch:    { ts: chMs,    label: "ClickHouse visible",  sub: "from _ingested_at (measured, real)" },
      total: chMs - pgMs,
    };
  }, [detail]);

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const v = searchValue.trim();
    if (v) setSelectedId(v);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
      {/* Sidebar */}
      <aside className="panel p-4">
        <form onSubmit={submitSearch} className="mb-3">
          <label className="panel-title block mb-2">Find transaction</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder="UUID…"
              className="flex-1 px-2 py-1.5 rounded-md bg-[#0c1220] border border-bg-ring/60 text-sm font-mono text-gray-200 focus:outline-none focus:border-accent/60"
            />
            <button
              type="submit"
              className="px-3 py-1.5 rounded-md bg-accent/20 border border-accent/40 text-accent text-sm hover:bg-accent/30"
            >
              Trace
            </button>
          </div>
        </form>

        <div className="panel-title mb-2 mt-4">Recent 20</div>
        <ul className="space-y-1 max-h-[60vh] overflow-auto scrollbar-thin pr-1">
          {(recent?.rows ?? []).map((r) => {
            const active = r.id === selectedId;
            return (
              <li key={r.id}>
                <button
                  onClick={() => setSelectedId(r.id)}
                  className={`w-full text-left px-2 py-1.5 rounded-md text-xs transition ${
                    active
                      ? "bg-accent/15 border border-accent/40 text-gray-100"
                      : "border border-transparent hover:bg-bg-ring/40 text-gray-300"
                  }`}
                >
                  <div className="font-mono text-[10px] truncate text-gray-400">{r.id}</div>
                  <div className="flex justify-between items-center mt-0.5">
                    <span className="text-gray-200 truncate">{r.account_name ?? "—"}</span>
                    <span className="font-mono text-gray-300 ml-2">
                      {formatAmount(r.amount, r.currency)}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
          {(!recent || recent.rows.length === 0) && (
            <li className="text-xs text-gray-500 py-3 text-center">No recent transactions.</li>
          )}
        </ul>
      </aside>

      {/* Main pane */}
      <section className="panel p-5">
        {!selectedId && (
          <div className="text-gray-400 text-sm py-12 text-center">
            Select a transaction from the left to trace its journey.
          </div>
        )}

        {selectedId && isLoading && !detail && (
          <div className="text-gray-400 text-sm py-12 text-center">Loading {selectedId}…</div>
        )}

        {selectedId && detail && !detail.found && (
          <div className="text-amber-400 text-sm py-12 text-center">
            Transaction <span className="font-mono">{selectedId}</span> not (yet) visible in ClickHouse.
            <div className="text-xs text-gray-500 mt-2">CDC may still be replicating — try again in ~1 s.</div>
          </div>
        )}

        {detail?.txn && stages && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="panel-title">Transaction</div>
                <div className="font-mono text-sm text-gray-200 mt-1 flex items-center gap-2">
                  {detail.txn.id}
                  <CopyButton value={detail.txn.id} />
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {formatAmount(detail.txn.amount, detail.txn.currency)} · {detail.txn.type} · {detail.txn.status}
                </div>
              </div>
              <div className="text-right">
                <div className="panel-title">Total end-to-end</div>
                <div className={`mt-1 inline-block px-3 py-1.5 rounded-md border ${latencyColor(stages.total)}`}>
                  <span className="text-lg font-semibold kpi-value">{fmtMs(stages.total)}</span>
                </div>
              </div>
            </div>

            {/* 4 stacked stages with latency bars between */}
            <ol className="space-y-2">
              {(() => {
                const items = [stages.pg, stages.debe, stages.kafka, stages.ch];
                return items.map((s, i) => (
                  <li key={s.label}>
                    <div className="flex items-start gap-3 p-3 rounded-md border border-bg-ring/40 bg-[#0e1424]">
                      <div className="w-7 h-7 rounded-full bg-accent/20 border border-accent/40 text-accent text-xs flex items-center justify-center font-semibold">
                        {i + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-gray-100">{s.label}</div>
                        <div className="text-xs text-gray-500">{s.sub}</div>
                        <div className="font-mono text-xs text-gray-300 mt-1">
                          {new Date(s.ts).toISOString()} · <span className="text-gray-500">{s.ts}</span>
                        </div>
                      </div>
                    </div>
                    {i < items.length - 1 && (
                      <div className="flex justify-center my-1">
                        {(() => {
                          const dt = items[i + 1]!.ts - s.ts;
                          return (
                            <div className={`text-xs px-2 py-0.5 rounded-md border ${latencyColor(dt)}`}>
                              {fmtMs(dt)}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </li>
                ));
              })()}
            </ol>

            {/* Raw JSON */}
            <details className="rounded-md border border-bg-ring/40 bg-[#0c1220]">
              <summary className="cursor-pointer px-3 py-2 panel-title hover:bg-bg-ring/30 rounded-md">
                Raw metadata (toggle)
              </summary>
              <pre className="text-xs font-mono text-gray-300 p-3 overflow-auto scrollbar-thin">
                {JSON.stringify(detail.txn, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </section>
    </div>
  );
}
