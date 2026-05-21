"use client";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";

interface RecentTxn {
  id: string;
  amount: number;
  currency: string;
  type: string;
  status: string;
  source_ts_ms: number;
  is_fraud: number;
}

interface PipelineStats {
  nodes: Record<"postgres" | "debezium" | "kafka" | "clickhouse", { eventsPerMin: number }>;
}

interface Particle {
  key: string;          // unique per spawn
  txnId: string;
  type: string;
  amount: number;
  isFraud: boolean;
  isHighlight: boolean;
  spawnedAt: number;    // wall clock; used to schedule unmount
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

// Particles ride this path: from PG node center → debezium → kafka → CH center.
// The path string is also the offset-path used by CSS animation.
const VIEW_W = 1000;
const VIEW_H = 220;
const Y = 110;
const NODE_R = 32;

const NODES = [
  { key: "postgres",   x: 100, label: "PostgreSQL", short: "PG"  },
  { key: "debezium",   x: 380, label: "Debezium",   short: "DB"  },
  { key: "kafka",      x: 660, label: "Kafka",      short: "KF"  },
  { key: "clickhouse", x: 920, label: "ClickHouse", short: "CH"  },
] as const;

const TRAVEL_PATH = `M ${NODES[0].x + NODE_R} ${Y} ` +
                    `L ${NODES[1].x - NODE_R} ${Y} ` +
                    `M ${NODES[1].x + NODE_R} ${Y} ` +
                    `L ${NODES[2].x - NODE_R} ${Y} ` +
                    `M ${NODES[2].x + NODE_R} ${Y} ` +
                    `L ${NODES[3].x - NODE_R} ${Y}`;

const SEGMENTS = [
  { from: NODES[0], to: NODES[1] },
  { from: NODES[1], to: NODES[2] },
  { from: NODES[2], to: NODES[3] },
];

const TYPE_COLOR: Record<string, string> = {
  purchase:   "#10b981",
  transfer:   "#f59e0b",
  withdrawal: "#ef4444",
  deposit:    "#22d3ee",
  refund:     "#a78bfa",
};
function colorFor(type: string) { return TYPE_COLOR[type] ?? "#9ca3af"; }

// Log-scaled radius. 0 → 3px floor; 100M → ~10px; 1B → ~12px ceiling.
function radiusFor(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 3;
  const r = 3 + Math.log10(amount + 1) * 1.3;
  return Math.max(3, Math.min(12, r));
}

const MAX_PARTICLES = 50;
const PARTICLE_TTL_MS = 2600;  // matches the CSS keyframe duration (2.5s) + 100ms buffer
const POLL_MS = 500;

export function ArchitectureFlow({
  highlightId,
  onNodeClick,
}: {
  highlightId?: string;
  onNodeClick?: (nodeName: string) => void;
}) {
  const [particles, setParticles] = useState<Particle[]>([]);
  const sinceRef = useRef<number>(Date.now() - 5_000);   // start "now - 5s" so we don't replay everything
  const seenIdsRef = useRef<Set<string>>(new Set());

  // Recent-transactions polling.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try {
        const r = await fetch(`/api/transactions/recent?since=${sinceRef.current}`);
        const j = (await r.json()) as { rows?: RecentTxn[]; serverTs?: number };
        if (!cancelled && j.rows && j.rows.length) {
          // Each row newer than our cursor spawns one particle. Bound concurrent count.
          const now = Date.now();
          setParticles((prev) => {
            const fresh: Particle[] = [];
            for (const row of j.rows!) {
              if (seenIdsRef.current.has(row.id)) continue;
              seenIdsRef.current.add(row.id);
              fresh.push({
                key: `${row.id}-${row.source_ts_ms}-${now + fresh.length}`,
                txnId: row.id,
                type: row.type,
                amount: Number(row.amount) || 0,
                isFraud: Number(row.is_fraud) > 0,
                isHighlight: !!highlightId && row.id === highlightId,
                spawnedAt: now,
              });
            }
            const merged = [...prev, ...fresh];
            // Drop oldest when over cap. FIFO.
            if (merged.length > MAX_PARTICLES) {
              return merged.slice(merged.length - MAX_PARTICLES);
            }
            return merged;
          });
          // Advance cursor.
          sinceRef.current = Math.max(
            sinceRef.current,
            ...j.rows.map((r) => Number(r.source_ts_ms) || 0),
          );
          // Prevent the seen-set from growing forever; trim at 500.
          if (seenIdsRef.current.size > 500) {
            const keep = Array.from(seenIdsRef.current).slice(-250);
            seenIdsRef.current = new Set(keep);
          }
        }
      } catch {
        // network blip; just retry on next tick
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_MS);
      }
    }
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [highlightId]);

  // GC particles whose animation has ended.
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - PARTICLE_TTL_MS;
      setParticles((prev) => prev.filter((p) => p.spawnedAt > cutoff));
    }, 500);
    return () => clearInterval(t);
  }, []);

  // Node badges.
  const { data: stats } = useSWR<PipelineStats>("/api/pipeline-stats", fetcher, {
    refreshInterval: 5000, revalidateOnFocus: false,
  });

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="panel-title">PostgreSQL → Debezium → Kafka → ClickHouse · live particles</div>
        <div className="text-xs text-gray-500">
          {particles.length} in flight · cap {MAX_PARTICLES}
        </div>
      </div>

      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="w-full h-auto select-none" preserveAspectRatio="xMidYMid meet">
        {/* Pipes */}
        {SEGMENTS.map((s, i) => (
          <line
            key={`pipe-${i}`}
            x1={s.from.x + NODE_R}
            y1={Y}
            x2={s.to.x - NODE_R}
            y2={Y}
            stroke="#1f2937"
            strokeWidth="8"
            strokeLinecap="round"
          />
        ))}
        {SEGMENTS.map((s, i) => (
          <line
            key={`pipe-inner-${i}`}
            x1={s.from.x + NODE_R}
            y1={Y}
            x2={s.to.x - NODE_R}
            y2={Y}
            stroke="#0e1424"
            strokeWidth="3"
            strokeLinecap="round"
          />
        ))}

        {/* Particles */}
        {particles.map((p) => {
          const r = radiusFor(p.amount);
          const fill = colorFor(p.type);
          const className = p.isFraud ? "particle particle-fraud" : "particle";
          return (
            <g key={p.key} style={{ offsetPath: `path("${TRAVEL_PATH}")` }} className={className}>
              {/* Highlight ring (blue) for the user-submitted insert. */}
              {p.isHighlight && (
                <circle cx={0} cy={0} r={r + 6} fill="none" stroke="#3b82f6" strokeWidth="2" opacity="0.9" />
              )}
              <circle cx={0} cy={0} r={r} fill={fill} opacity="0.95">
                <title>{p.type} · {p.amount.toLocaleString()} {p.txnId.slice(0, 8)}…</title>
              </circle>
            </g>
          );
        })}

        {/* Nodes (drawn last so they sit above particles) */}
        {NODES.map((n) => {
          const eventsPerMin = stats?.nodes?.[n.key]?.eventsPerMin ?? 0;
          return (
            <g
              key={n.key}
              transform={`translate(${n.x},${Y})`}
              className="cursor-pointer"
              onClick={() => onNodeClick?.(n.key)}
            >
              <circle r={NODE_R} fill="#0c1220" stroke="#22d3ee" strokeWidth="2" />
              <text textAnchor="middle" y={4} fontSize="14" fontWeight="600" fill="#e5e7eb">
                {n.short}
              </text>
              <text textAnchor="middle" y={NODE_R + 18} fontSize="13" fontWeight="600" fill="#e5e7eb">
                {n.label}
              </text>
              <g transform={`translate(0, ${NODE_R + 32})`}>
                <rect x="-46" y="-9" width="92" height="18" rx="4" fill="#10172a" stroke="#1f2937" />
                <text textAnchor="middle" y="4" fontSize="10" fill="#9ca3af">
                  {Number(eventsPerMin).toLocaleString()} events/min
                </text>
              </g>
            </g>
          );
        })}
      </svg>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-gray-500">
        <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 mr-1.5 align-middle" /> purchase</span>
        <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500   mr-1.5 align-middle" /> transfer</span>
        <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-rose-500    mr-1.5 align-middle" /> withdrawal</span>
        <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-cyan-400    mr-1.5 align-middle" /> deposit</span>
        <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-violet-400  mr-1.5 align-middle" /> refund</span>
        <span className="ml-auto">size = log<sub>10</sub>(amount) · red glow = amount &gt; 100M VND</span>
      </div>
    </div>
  );
}
