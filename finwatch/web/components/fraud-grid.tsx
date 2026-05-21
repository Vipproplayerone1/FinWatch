"use client";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";

type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6";

const RULE_ORDER: RuleId[] = ["R1", "R2", "R3", "R4", "R5", "R6"];

const RULE_ACCENT: Record<RuleId, string> = {
  R1: "from-rose-500/20    to-rose-500/0    border-rose-500/40    text-rose-300",
  R2: "from-violet-500/20  to-violet-500/0  border-violet-500/40  text-violet-300",
  R3: "from-orange-500/20  to-orange-500/0  border-orange-500/40  text-orange-300",
  R4: "from-pink-500/20    to-pink-500/0    border-pink-500/40    text-pink-300",
  R5: "from-amber-500/20   to-amber-500/0   border-amber-500/40   text-amber-300",
  R6: "from-red-500/20     to-red-500/0     border-red-500/40     text-red-300",
};

interface RuleResp {
  rule: RuleId;
  shortName: string;
  threshold: string;
  sourceFile: string;
  columns: string[];
  count: number;
  rows: Array<Record<string, unknown>>;
  sql: string;
  error?: string;
}

interface HistResp {
  rule: RuleId;
  points: Array<{ bucket: string; flags: number }>;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

function fmtCellValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "string") {
    if (v.length > 36 && /^[0-9a-f-]+$/i.test(v)) return v.slice(0, 8) + "…";
    return v;
  }
  return String(v);
}

function Sparkline({ points }: { points: Array<{ flags: number }> }) {
  if (!points || points.length === 0) {
    return <div className="h-8 text-[10px] text-gray-600 flex items-center">no history</div>;
  }
  const w = 100;
  const h = 28;
  const max = Math.max(1, ...points.map((p) => Number(p.flags) || 0));
  const step = points.length > 1 ? w / (points.length - 1) : 0;
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(2)} ${(h - ((Number(p.flags) || 0) / max) * h).toFixed(2)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-8" preserveAspectRatio="none">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function CountUp({ value }: { value: number }) {
  // Tween from previous → next over 700ms. Pure useState-driven, no Framer.
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    const start = performance.now();
    const dur = 700;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span>{display.toLocaleString()}</span>;
}

function ColorZScore({ z }: { z: number | null | undefined }) {
  if (z === null || z === undefined || !Number.isFinite(z)) return <span className="text-gray-500">—</span>;
  const abs = Math.abs(z);
  const cls =
    abs >= 8 ? "text-rose-400 font-semibold" :
    abs >= 5 ? "text-orange-400" :
    "text-amber-300";
  return <span className={cls}>{z.toFixed(2)}</span>;
}

function RuleCard({ rule }: { rule: RuleId }) {
  const { data, mutate } = useSWR<RuleResp>(
    `/api/fraud/${rule.toLowerCase()}`,
    fetcher,
    { refreshInterval: 10_000, revalidateOnFocus: false },
  );
  const { data: hist } = useSWR<HistResp>(
    `/api/fraud/history?rule=${rule}&minutes=30`,
    fetcher,
    { refreshInterval: 30_000, revalidateOnFocus: false },
  );

  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const prevCount = useRef<number>(data?.count ?? 0);
  const [pulseKey, setPulseKey] = useState(0);

  useEffect(() => {
    if (!data) return;
    if (data.count > prevCount.current) {
      setPulseKey((k) => k + 1);
    }
    prevCount.current = data.count;
  }, [data?.count]);

  const accent = RULE_ACCENT[rule];

  return (
    <div
      key={pulseKey}
      className={`relative panel p-4 border bg-gradient-to-br ${accent.split(" ").slice(0, 3).join(" ")} new-flag-pulse-target`}
      style={{ animation: pulseKey > 0 ? "new-flag-pulse 1.5s ease-out 1" : undefined }}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className={`text-[10px] uppercase tracking-wider font-mono ${accent.split(" ").pop()}`}>
            {rule} · {data?.sourceFile ?? "—"}
          </div>
          <div className="text-base font-semibold text-gray-100 mt-0.5">
            {data?.shortName ?? "Loading…"}
          </div>
        </div>
        <button
          onClick={() => mutate()}
          className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border border-bg-ring/60 hover:bg-bg-ring/40 text-gray-400"
          title="Refresh now"
        >
          refresh
        </button>
      </div>

      <div className="text-xs text-gray-400 mt-1">{data?.threshold ?? ""}</div>

      <div className="flex items-end justify-between mt-3">
        <div className={`text-4xl font-semibold kpi-value count-up-pulse ${accent.split(" ").pop()}`}>
          <CountUp value={Number(data?.count ?? 0)} />
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-gray-500">flagged now</div>
          <div className={`mt-1 ${accent.split(" ").pop()} w-28`}>
            <Sparkline points={hist?.points ?? []} />
          </div>
          <div className="text-[10px] text-gray-500">last 30 min</div>
        </div>
      </div>

      <button
        onClick={() => setOpen((o) => !o)}
        className="mt-3 text-xs px-3 py-1.5 rounded-md border border-bg-ring/60 hover:bg-bg-ring/40 text-gray-200"
      >
        {open ? "Hide details" : "View details"}
      </button>

      {open && data && (
        <div className="mt-3 space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="panel-title">SQL</div>
              <button
                onClick={async () => { await navigator.clipboard.writeText(data.sql); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border border-bg-ring/60 hover:bg-bg-ring/40 text-gray-400"
              >
                {copied ? "copied" : "copy"}
              </button>
            </div>
            <pre className="text-[11px] font-mono text-gray-300 bg-[#0c1220] border border-bg-ring/40 rounded-md p-2 overflow-auto scrollbar-thin max-h-48">
{data.sql}
            </pre>
          </div>
          <div>
            <div className="panel-title mb-1">Flagged ({data.rows.length})</div>
            {data.rows.length === 0 ? (
              <div className="text-xs text-gray-500 px-2 py-2">No rows currently flagged.</div>
            ) : (
              <div className="overflow-auto scrollbar-thin max-h-64 border border-bg-ring/40 rounded-md">
                <table className="w-full text-xs">
                  <thead className="bg-[#10172a] text-gray-500 uppercase text-[10px] sticky top-0">
                    <tr>
                      {data.columns.map((c) => (
                        <th key={c} className="text-left px-2 py-1.5">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.slice(0, 50).map((row, i) => (
                      <tr key={i} className="border-t border-bg-ring/30 hover:bg-bg-ring/30">
                        {data.columns.map((c) => (
                          <td key={c} className="px-2 py-1 font-mono text-gray-300">
                            {rule === "R2" && c === "z_score"
                              ? <ColorZScore z={Number(row[c])} />
                              : fmtCellValue(row[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function FraudDetectionGrid() {
  // Pull the 6 cards' counts to compose the summary strip.
  const counts = RULE_ORDER.map((id) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { data } = useSWR<RuleResp>(`/api/fraud/${id.toLowerCase()}`, fetcher, {
      refreshInterval: 10_000, revalidateOnFocus: false,
    });
    return data?.count ?? 0;
  });
  const total = counts.reduce((a, b) => a + b, 0);
  const [now, setNow] = useState<string>(new Date().toLocaleTimeString());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <div className="panel p-3 mb-4 flex flex-wrap items-center gap-x-6 gap-y-1">
        <div>
          <span className="panel-title">Total flagged across 6 rules</span>
          <span className="ml-3 text-2xl font-semibold text-accent kpi-value">{total.toLocaleString()}</span>
        </div>
        <div className="ml-auto text-xs text-gray-500">last refresh: {now}</div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {RULE_ORDER.map((id) => <RuleCard key={id} rule={id} />)}
      </div>
    </div>
  );
}
