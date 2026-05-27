import type { ReactNode } from "react";

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function severityRank(s: string): number {
  return SEVERITY_RANK[s] ?? 0;
}

export function maxSeverity(severities: string[]): string {
  let best = "low";
  let bestRank = 0;
  for (const s of severities) {
    const r = severityRank(s);
    if (r > bestRank) {
      best = s;
      bestRank = r;
    }
  }
  return bestRank === 0 ? "low" : best;
}

export function severityDotClass(severity: string): string {
  switch (severity) {
    case "critical": return "bg-red-400";
    case "high":     return "bg-accent-danger";
    case "medium":   return "bg-accent-warn";
    case "low":      return "bg-gray-400";
    default:         return "bg-gray-400";
  }
}

export function SeverityBadge({ severity }: { severity: string }): ReactNode {
  const cls =
    severity === "critical" ? "text-red-300       bg-red-500/15"
  : severity === "high"     ? "text-accent-danger bg-accent-danger/10"
  : severity === "medium"   ? "text-accent-warn   bg-accent-warn/10"
  : severity === "low"      ? "text-gray-300      bg-gray-500/10"
  :                            "text-gray-300      bg-gray-500/10";
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-medium ${cls}`}>{severity}</span>
  );
}

export function RuleBadge({ rule }: { rule: string }): ReactNode {
  return (
    <span className="px-2 py-0.5 rounded text-[10px] uppercase font-mono bg-bg-ring/40 text-gray-200">
      {rule}
    </span>
  );
}
