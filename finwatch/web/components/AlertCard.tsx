"use client";
import { useState } from "react";
import Link from "next/link";
import {
  SeverityBadge,
  RuleBadge,
  maxSeverity,
  severityRank,
  severityDotClass,
} from "@/components/badges";

export type Firing = {
  id: string;
  rule_code: string;
  severity: string;
  txn_count: number;
  total_amount: number;
  evidence: string;
  status: string;
  created_at: string;
};

export type AlertGroup = {
  account_id: string;
  account_name: string | null;
  last_seen: string;
  total_firings: number;
  firings: Firing[];
};

const formatVND = (n: number) =>
  Number.isFinite(n) && n > 0
    ? `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} VND`
    : "—";

function parseChDate(s: string): Date {
  // ClickHouse DateTime64 comes back as "YYYY-MM-DD HH:mm:ss.SSS" without zone.
  // The fraud_alerts column is stored as 'Asia/Ho_Chi_Minh' so the wall-clock
  // matches what the user expects locally; treat as local-time.
  return new Date(s.replace(" ", "T"));
}

function formatRelative(iso: string): string {
  const d = parseChDate(iso);
  const ms = Date.now() - d.getTime();
  if (!Number.isFinite(ms)) return iso;
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60)  return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60)  return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24)   return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Per-rule evidence formatter. Shapes documented in
// scripts/fraud_alert_worker.py:117-216.
function formatEvidence(ruleCode: string, raw: string): string | null {
  if (!raw) return null;
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
  }
  const num = (v: unknown): string => {
    if (typeof v === "number") return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v;
    }
    return String(v);
  };
  switch (ruleCode) {
    case "VELOCITY": {
      const w = e.window_seconds;
      const types = Array.isArray(e.txn_types) ? (e.txn_types as string[]).join(", ") : "";
      return `window ${w}s · types [${types}]`;
    }
    case "LARGE_AMT": {
      const txn = typeof e.txn_id === "string" ? truncate(e.txn_id, 8) : "";
      return `txn ${txn} · ${e.currency} · ${e.type}`;
    }
    case "ZSCORE": {
      const z = num(e.z_score);
      const avg = num(e.avg_amount);
      const std = num(e.std_amount);
      return `z=${z} · avg ${avg} · std ${std} · n=${e.txn_count_30d ?? "?"}`;
    }
    case "HIGH_RISK": {
      return `merchant ${e.merchant_name ?? "?"} · risk ${e.risk_level ?? "?"} · ${e.type ?? ""}`;
    }
    case "MULTI_CCY": {
      const ccys = Array.isArray(e.currencies) ? (e.currencies as string[]).join(", ") : "";
      return `${e.currency_count ?? "?"} currencies: [${ccys}]`;
    }
    case "FAIL_SPIKE": {
      return `${e.failed_count}/${e.total_count} failed · rate ${num(e.fail_rate_pct)}%`;
    }
    default:
      return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
  }
}

type RuleBucket = {
  rule_code: string;
  severity: string;
  firings: Firing[];
};

function bucketByRule(firings: Firing[]): RuleBucket[] {
  const buckets = new Map<string, RuleBucket>();
  for (const f of firings) {
    const existing = buckets.get(f.rule_code);
    if (existing) {
      existing.firings.push(f);
      if (severityRank(f.severity) > severityRank(existing.severity)) {
        existing.severity = f.severity;
      }
    } else {
      buckets.set(f.rule_code, {
        rule_code: f.rule_code,
        severity: f.severity,
        firings: [f],
      });
    }
  }
  // Order rule buckets by max severity desc, then by firing count desc.
  return [...buckets.values()].sort((a, b) => {
    const ds = severityRank(b.severity) - severityRank(a.severity);
    if (ds !== 0) return ds;
    return b.firings.length - a.firings.length;
  });
}

export function AlertCard({ group }: { group: AlertGroup }) {
  const [open, setOpen] = useState(false);
  const buckets = bucketByRule(group.firings);
  const maxSev = maxSeverity(group.firings.map((f) => f.severity));
  const totalAmount = group.firings.reduce((sum, f) => sum + Number(f.total_amount || 0), 0);
  const openCount = group.firings.filter((f) => f.status === "open").length;
  const accountLabel = group.account_name ?? truncate(group.account_id, 12);

  return (
    <div className="border border-bg-ring/60 bg-[#0e1424] rounded-md transition hover:border-bg-ring">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left p-3 flex items-start gap-3"
      >
        <span
          className={`mt-1.5 inline-block w-2.5 h-2.5 rounded-full ${severityDotClass(maxSev)} ${
            maxSev === "critical" ? "animate-pulseDot" : ""
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/accounts/${group.account_id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-sm font-semibold text-gray-100 hover:text-accent hover:underline"
            >
              {accountLabel}
            </Link>
            <span className="text-xs text-gray-500 font-mono">{truncate(group.account_id, 10)}</span>
            <span className="ml-auto text-xs text-gray-500">last seen {formatRelative(group.last_seen)}</span>
          </div>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {buckets.map((b) => (
              <span key={b.rule_code} className="inline-flex items-center gap-1">
                <RuleBadge rule={b.rule_code} />
                <SeverityBadge severity={b.severity} />
                {b.firings.length > 1 && (
                  <span className="text-[10px] text-gray-500 font-mono">×{b.firings.length}</span>
                )}
              </span>
            ))}
          </div>
          <div className="mt-2 text-xs text-gray-400">
            {buckets.length} rule{buckets.length === 1 ? "" : "s"} · {group.total_firings} firing
            {group.total_firings === 1 ? "" : "s"} · {formatVND(totalAmount)} · {openCount} open
          </div>
        </div>
        <span className={`text-gray-500 text-lg transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>

      {open && (
        <div className="border-t border-bg-ring/40 px-3 py-2 space-y-2">
          {buckets.map((b) => (
            <div key={b.rule_code} className="pt-1 pb-2">
              <div className="flex items-center gap-2">
                <RuleBadge rule={b.rule_code} />
                <SeverityBadge severity={b.severity} />
                <span className="text-xs text-gray-500">
                  {b.firings.length} firing{b.firings.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="mt-1.5 space-y-1.5">
                {b.firings.map((f) => {
                  const ev = formatEvidence(f.rule_code, f.evidence);
                  return (
                    <li key={f.id} className="text-xs text-gray-300 leading-snug">
                      <div className="flex items-center gap-2 text-gray-400">
                        <span>{formatRelative(f.created_at)}</span>
                        <span className="text-gray-600">·</span>
                        <span>{formatVND(Number(f.total_amount))}</span>
                        <span className="text-gray-600">·</span>
                        <span>{f.txn_count} txn{f.txn_count === 1 ? "" : "s"}</span>
                        <span className="text-gray-600">·</span>
                        <span className="font-mono text-[10px]">{f.status}</span>
                      </div>
                      {ev && (
                        <div className="text-gray-500 font-mono text-[11px] mt-0.5">{ev}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
