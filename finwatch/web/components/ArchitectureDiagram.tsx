"use client";

const NODES = [
  { x: 60,  label: "PostgreSQL",  sub: "WAL · logical" },
  { x: 240, label: "Debezium",    sub: "CDC connector" },
  { x: 420, label: "Kafka",       sub: "topics · JSON" },
  { x: 600, label: "ClickHouse",  sub: "ReplacingMT" },
];
const Y = 70;
const R = 22;

export function ArchitectureDiagram() {
  return (
    <div className="panel p-4">
      <div className="panel-title mb-3">Pipeline Flow</div>
      <svg viewBox="0 0 700 140" className="w-full h-32">
        {/* Connecting lines */}
        {NODES.slice(0, -1).map((n, i) => {
          const next = NODES[i + 1];
          const id = `seg-${i}`;
          const d = `M ${n.x + R} ${Y} L ${next.x - R} ${Y}`;
          return (
            <g key={id}>
              <path d={d} stroke="#1f2937" strokeWidth="2" fill="none" />
              <path id={id} d={d} fill="none" stroke="none" />
              {[0, 1, 2].map((k) => (
                <circle
                  key={k}
                  r="4"
                  fill="#22d3ee"
                  className={`flow-dot ${k === 1 ? "delay-1" : k === 2 ? "delay-2" : ""}`}
                  style={{ offsetPath: `path("${d}")` }}
                />
              ))}
            </g>
          );
        })}

        {/* Nodes */}
        {NODES.map((n) => (
          <g key={n.label}>
            <circle
              cx={n.x}
              cy={Y}
              r={R}
              fill="#121826"
              stroke="#22d3ee"
              strokeWidth="2"
              className="animate-pulseDot"
            />
            <text x={n.x} y={Y + 5} textAnchor="middle" fontSize="11" fill="#e5e7eb">
              {n.label.slice(0, 2).toUpperCase()}
            </text>
            <text x={n.x} y={Y + 44} textAnchor="middle" fontSize="11" fill="#e5e7eb" fontWeight="600">
              {n.label}
            </text>
            <text x={n.x} y={Y + 58} textAnchor="middle" fontSize="9" fill="#6b7280">
              {n.sub}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
