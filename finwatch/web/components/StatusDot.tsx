export type StatusDotState = "ok" | "warn" | "err";

const COLOR: Record<StatusDotState, string> = {
  ok:   "bg-emerald-500",
  warn: "bg-amber-500",
  err:  "bg-rose-500",
};

const LABEL: Record<StatusDotState, string> = {
  ok:   "healthy",
  warn: "degraded",
  err:  "down",
};

/**
 * 10 px round status indicator. Shared across the /stack health cards and the
 * /clickhouse consumer freshness table. Use `pulse` for an attention-grabbing
 * variant during incidents.
 */
export function StatusDot({ state, pulse = false }: { state: StatusDotState; pulse?: boolean }) {
  return (
    <span
      role="status"
      aria-label={LABEL[state]}
      title={LABEL[state]}
      className={`inline-block w-2.5 h-2.5 rounded-full ${COLOR[state]} ${pulse ? "animate-pulseDot" : ""}`}
    />
  );
}
