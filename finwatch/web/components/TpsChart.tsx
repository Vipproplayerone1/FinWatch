"use client";
import useSWR from "swr";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Point = { t: number; tps: number };
type Resp = { points: Point[]; error?: string };

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function TpsChart() {
  const { data } = useSWR<Resp>("/api/health/tps", fetcher, {
    refreshInterval: 1500,
    revalidateOnFocus: false,
  });

  const points = (data?.points ?? []).map((p) => ({
    t: p.t,
    tps: Number(p.tps) || 0,
    label: new Date(p.t * 1000).toLocaleTimeString(),
  }));

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between">
        <div className="panel-title">TPS · last 60 seconds</div>
        <div className="text-xs text-gray-500">{points.length} points</div>
      </div>
      <div className="mt-2 h-32">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="tpsFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.6} />
                <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="label" tick={false} axisLine={false} />
            <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
            <Tooltip
              contentStyle={{ background: "#0b0f17", border: "1px solid #1f2937", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "#9ca3af" }}
              formatter={(v: number) => [`${v} tps`, "Rate"]}
            />
            <Area type="monotone" dataKey="tps" stroke="#22d3ee" strokeWidth={2} fill="url(#tpsFill)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
