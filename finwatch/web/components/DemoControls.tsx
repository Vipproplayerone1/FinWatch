"use client";
import { useEffect, useState } from "react";

type ScenarioMeta = {
  name: string;
  rule: string;
  typology: string;
  story: string;
};

type ScenarioResult = {
  scenario: string;
  rule: string;
  rowsInserted: number;
  durationMs: number;
  details: string;
};

type TickRuleResult = {
  rule_code: string;
  new?: number;
  dedup?: number;
  skipped?: number;
  error?: string;
};

type TickResponse = {
  rules?: TickRuleResult[];
  dedup_seconds?: number;
  error?: string;
};

type LoadResult = {
  rowsInserted: number;
  tps: number;
  durationMs: number;
};

const ruleBadgeColor: Record<string, string> = {
  VELOCITY:   "bg-rose-500/20    text-rose-300    border-rose-500/40",
  LARGE_AMT:  "bg-orange-500/20  text-orange-300  border-orange-500/40",
  MULTI_CCY:  "bg-amber-500/20   text-amber-300   border-amber-500/40",
  ZSCORE:     "bg-violet-500/20  text-violet-300  border-violet-500/40",
  HIGH_RISK:  "bg-pink-500/20    text-pink-300    border-pink-500/40",
  FAIL_SPIKE: "bg-red-500/20     text-red-300     border-red-500/40",
};

export function DemoControls() {
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(
    "Click a scenario to drive the pipeline from this page — no terminal needed."
  );

  useEffect(() => {
    fetch("/api/scenarios/list")
      .then((r) => r.json())
      .then((d) => setScenarios(d.scenarios ?? []))
      .catch(() => setStatus("Could not load scenarios — check `docker compose logs web`."));
  }, []);

  async function runScenario(name: string) {
    setBusy(name);
    setStatus(`Running ${name} …`);
    try {
      const r = await fetch("/api/scenarios/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: name }),
      });
      const j = (await r.json()) as ScenarioResult & { error?: string };
      if (!r.ok || j.error) {
        setStatus(`Error in ${name}: ${j.error ?? r.statusText}`);
        return;
      }

      const base = `OK · ${j.rule} fired · ${j.rowsInserted} rows in ${(j.durationMs / 1000).toFixed(1)}s`;
      setStatus(`${base} · running detection …`);

      try {
        const tr = await fetch("/api/fraud/tick", { method: "POST" });
        const tj = (await tr.json()) as TickResponse;
        if (!tr.ok || tj.error) {
          setStatus(`${base} · tick error: ${tj.error ?? tr.statusText}`);
        } else {
          const raised = (tj.rules ?? []).reduce((sum, x) => sum + (x.new ?? 0), 0);
          const deduped = (tj.rules ?? []).reduce((sum, x) => sum + (x.dedup ?? 0), 0);
          if (raised > 0) {
            setStatus(`${base} · ${raised} new alert${raised === 1 ? "" : "s"} raised — see /alerts`);
          } else {
            setStatus(`${base} · no new alert (deduped=${deduped}; threshold may not be crossed)`);
          }
        }
      } catch (e) {
        setStatus(`${base} · tick network error: ${(e as Error).message}`);
      }
    } catch (e) {
      setStatus(`Network error running ${name}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function driveLoad() {
    setBusy("__load__");
    setStatus("Driving 200 synthetic txns …");
    try {
      const r = await fetch("/api/load/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: 200 }),
      });
      const j = (await r.json()) as LoadResult & { error?: string };
      if (!r.ok || j.error) {
        setStatus(`Load error: ${j.error ?? r.statusText}`);
      } else {
        setStatus(
          `OK · ${j.rowsInserted} txns in ${(j.durationMs / 1000).toFixed(1)}s ≈ ${j.tps} TPS · TPS chart should rise within ~2 s`,
        );
      }
    } catch (e) {
      setStatus(`Network error: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const anyBusy = busy !== null;

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="panel-title">Demo controls — drive the pipeline from here</div>
        <div className="text-xs text-gray-500">
          {scenarios.length} fraud typologies + load generator
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {scenarios.map((s) => {
          const color = ruleBadgeColor[s.rule] ?? "bg-gray-500/20 text-gray-300 border-gray-500/40";
          const isBusy = busy === s.name;
          return (
            <button
              key={s.name}
              onClick={() => runScenario(s.name)}
              disabled={anyBusy}
              title={`${s.typology}\n\n${s.story}`}
              className={`group relative text-left rounded-md border ${color}
                          px-3 py-2.5 hover:brightness-125 transition
                          disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <div className="text-xs uppercase tracking-wider opacity-70">
                {s.rule}
              </div>
              <div className="text-sm font-semibold mt-0.5">
                {isBusy ? "running…" : s.name}
              </div>
              <div className="text-[10px] opacity-60 mt-0.5 truncate">
                {s.typology}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-3">
        <button
          onClick={driveLoad}
          disabled={anyBusy}
          className="rounded-md border border-accent/40 bg-accent/10 text-accent
                     px-4 py-2 hover:bg-accent/20 transition
                     disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold"
          title="Insert 200 random txns to drive the TPS chart and live stream."
        >
          {busy === "__load__" ? "Driving load…" : "Drive normal load (200 txns)"}
        </button>
        <div className="text-xs text-gray-400 flex-1 min-h-[1.5rem]">
          {status}
        </div>
      </div>
    </div>
  );
}
