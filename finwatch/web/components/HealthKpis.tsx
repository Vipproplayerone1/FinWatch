"use client";
import useSWR from "swr";

type Summary = {
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  tps_now: number | null;
  total_today: number | null;
  sample_rows: number | null;
  error?: string;
};

const fetcher = (u: string) => fetch(u).then((r) => r.json());
const fmt = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString();
const fmtMs = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${Math.round(Number(n))} ms`;

function Tile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="panel p-4">
      <div className="panel-title">{label}</div>
      <div className={`mt-2 text-3xl font-semibold kpi-value ${accent ?? "text-gray-100"}`}>
        {value}
      </div>
    </div>
  );
}

export function HealthKpis() {
  const { data } = useSWR<Summary>("/api/health/summary", fetcher, {
    refreshInterval: 2000,
    revalidateOnFocus: false,
  });

  const avg = data?.avg_latency_ms ?? null;
  const accent =
    avg === null ? undefined :
    avg < 1500 ? "text-accent-ok" :
    avg < 5000 ? "text-accent-warn" : "text-accent-danger";

  return (
    <div className="grid grid-cols-2 gap-3">
      <Tile label="Avg latency (PG → CH)" value={fmtMs(avg)} accent={accent} />
      <Tile label="P95 latency"            value={fmtMs(data?.p95_latency_ms)} />
      <Tile label="TPS (last 5s avg)"      value={fmt(data?.tps_now)} accent="text-accent" />
      <Tile label="Total today"            value={fmt(data?.total_today)} />
    </div>
  );
}
