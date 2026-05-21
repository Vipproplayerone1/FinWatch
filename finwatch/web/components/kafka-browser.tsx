"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import useSWR from "swr";

interface TopicRow { name: string; partitionCount: number; messageCount: string }
interface KafkaMessage {
  partition: number;
  offset: string;
  timestamp: string;
  key: string | null;
  value: unknown;
}
interface PartitionLag {
  partition: number;
  current: string;
  logEnd: string;
  lag: string;
}
interface GroupReport { groupId: string; partitions: PartitionLag[]; hint?: string }
interface ConfigRow { name: string; value: string; isDefault: boolean }
interface MetadataResp {
  topic: string;
  partitions: number;
  replicationFactor: number;
  configs: ConfigRow[];
  error?: string;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

const MAX_DOM_ROWS = 200;
const MESSAGES_LIVE_INTERVAL_MS = 1000;

type Tab = "messages" | "consumers" | "metadata";

export function KafkaBrowser() {
  const [active, setActive] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("messages");
  const [liveTail, setLiveTail] = useState(false);

  const { data: topicsData, error: topicsErr } = useSWR<{ topics: TopicRow[]; error?: string }>(
    "/api/kafka/topics",
    fetcher,
    { refreshInterval: 30_000, revalidateOnFocus: false },
  );

  useEffect(() => {
    if (!active && topicsData?.topics?.length) {
      setActive(topicsData.topics[0]!.name);
    }
  }, [topicsData, active]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
      <Sidebar
        topics={topicsData?.topics ?? []}
        active={active}
        onSelect={(t) => { setActive(t); setLiveTail(false); }}
        error={topicsData?.error ?? (topicsErr ? "network error" : undefined)}
      />
      <section className="panel p-5 min-h-[600px]">
        {!active && <Empty>Pick a topic on the left to inspect.</Empty>}
        {active && (
          <>
            <header className="flex flex-col gap-2 mb-3 border-b border-bg-ring/40 pb-2">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="font-mono text-sm text-accent">{active}</h2>
                <Tabs tab={tab} onChange={setTab} />
                {tab === "messages" && (
                  <label className="ml-auto inline-flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={liveTail}
                      onChange={(e) => setLiveTail(e.target.checked)}
                    />
                    Live tail (1 s)
                  </label>
                )}
              </div>
            </header>
            {tab === "messages"  && <MessagesPanel  topic={active} liveTail={liveTail} />}
            {tab === "consumers" && <ConsumersPanel topic={active} />}
            {tab === "metadata"  && <MetadataPanel  topic={active} />}
          </>
        )}
      </section>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-gray-500 text-sm py-12 text-center">{children}</div>;
}

function ErrorBanner({ msg }: { msg: string }) {
  return (
    <div className="mb-3 text-xs px-3 py-2 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-300">
      {msg}
    </div>
  );
}

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const items: { id: Tab; label: string }[] = [
    { id: "messages",  label: "Messages"  },
    { id: "consumers", label: "Consumers" },
    { id: "metadata",  label: "Metadata"  },
  ];
  return (
    <div className="flex gap-1">
      {items.map((i) => (
        <button
          key={i.id}
          onClick={() => onChange(i.id)}
          className={`px-3 py-1 rounded-md text-xs transition ${
            tab === i.id
              ? "bg-accent/15 text-accent border border-accent/40"
              : "text-gray-300 hover:bg-bg-ring/40 border border-transparent"
          }`}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

function Sidebar({
  topics, active, onSelect, error,
}: {
  topics: TopicRow[];
  active: string | null;
  onSelect: (t: string) => void;
  error?: string;
}) {
  return (
    <aside className="panel p-4 lg:max-h-[640px] overflow-auto scrollbar-thin">
      <div className="panel-title mb-3">Topics</div>
      {error && <ErrorBanner msg={error} />}
      {topics.length === 0 && !error && (
        <div className="text-xs text-gray-500 py-6 text-center">no finwatch.public.* topics</div>
      )}
      <ul className="space-y-1">
        {topics.map((t) => {
          const isActive = active === t.name;
          return (
            <li key={t.name}>
              <button
                onClick={() => onSelect(t.name)}
                className={`w-full text-left px-2 py-2 rounded-md transition ${
                  isActive
                    ? "bg-accent/15 border border-accent/40"
                    : "border border-transparent hover:bg-bg-ring/40"
                }`}
              >
                <div className="font-mono text-xs text-gray-200 truncate">{t.name}</div>
                <div className="text-[10px] text-gray-500 flex justify-between mt-0.5">
                  <span>{t.partitionCount} partition{t.partitionCount === 1 ? "" : "s"}</span>
                  <span>{Number(t.messageCount).toLocaleString()} msgs</span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function formatTs(s: string) {
  // kafkajs timestamps are millisecond epoch in a string.
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return new Date(n).toLocaleTimeString();
}

function parseAmount(value: unknown): string {
  if (value && typeof value === "object" && "amount" in value) {
    const v = (value as { amount: unknown }).amount;
    if (typeof v === "number") return v.toLocaleString();
    if (typeof v === "string") return v;
  }
  return "—";
}

function MessagesPanel({ topic, liveTail }: { topic: string; liveTail: boolean }) {
  const { data, error, isLoading } = useSWR<{ messages: KafkaMessage[]; error?: string }>(
    `/api/kafka/messages?topic=${encodeURIComponent(topic)}&limit=50`,
    fetcher,
    {
      refreshInterval: liveTail ? MESSAGES_LIVE_INTERVAL_MS : 0,
      revalidateOnFocus: false,
      keepPreviousData: true,
    },
  );

  // Append-only tail buffer: keep messages we've ever seen (de-duped) so live
  // tail doesn't lose history when the upstream call returns only the latest 50.
  const [seen, setSeen] = useState<KafkaMessage[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    if (!data?.messages) return;
    setSeen((prev) => {
      const key = (m: KafkaMessage) => `${m.partition}:${m.offset}`;
      const known = new Set(prev.map(key));
      const fresh = data.messages.filter((m) => !known.has(key(m)));
      if (fresh.length === 0) return prev;
      // Prepend newest first (kafkajs returns ascending order; reverse).
      const merged = [...fresh.reverse(), ...prev];
      return merged.slice(0, MAX_DOM_ROWS);
    });
  }, [data]);

  // Reset buffer when the topic changes or live tail flips off.
  useEffect(() => { setSeen([]); setOpenKey(null); }, [topic]);

  const rows = useMemo(() => (seen.length > 0 ? seen : (data?.messages ?? []).slice().reverse()), [seen, data]);

  return (
    <div>
      {data?.error && <ErrorBanner msg={data.error} />}
      {error && !data?.error && <ErrorBanner msg="failed to fetch messages" />}
      {isLoading && rows.length === 0 && <Empty>Loading messages…</Empty>}
      {!isLoading && rows.length === 0 && !data?.error && (
        <Empty>No messages on this topic yet. Run "Drive normal load" on /demo.</Empty>
      )}
      {rows.length > 0 && (
        <div className="overflow-auto scrollbar-thin max-h-[640px] border border-bg-ring/40 rounded-md">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[#10172a] text-[10px] uppercase text-gray-500">
              <tr>
                <th className="text-left px-2 py-1.5">Time</th>
                <th className="text-left px-2 py-1.5">Part</th>
                <th className="text-left px-2 py-1.5">Offset</th>
                <th className="text-left px-2 py-1.5">Key</th>
                <th className="text-right px-2 py-1.5">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const key = `${m.partition}:${m.offset}`;
                const open = openKey === key;
                return (
                  <Fragment key={key}>
                    <tr
                      className="border-t border-bg-ring/30 hover:bg-bg-ring/30 cursor-pointer"
                      onClick={() => setOpenKey(open ? null : key)}
                    >
                      <td className="px-2 py-1 font-mono text-gray-400">{formatTs(m.timestamp)}</td>
                      <td className="px-2 py-1 text-gray-300">{m.partition}</td>
                      <td className="px-2 py-1 font-mono text-gray-300">{m.offset}</td>
                      <td className="px-2 py-1 font-mono text-gray-400">
                        {m.key ? m.key.slice(0, 8) : "—"}
                      </td>
                      <td className="px-2 py-1 text-right font-mono kpi-value">
                        {parseAmount(m.value)}
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-t border-bg-ring/30">
                        <td colSpan={5} className="px-2 py-2 bg-[#0c1220]">
                          <pre className="text-[11px] font-mono text-gray-300 overflow-auto scrollbar-thin max-h-72">
{JSON.stringify(m.value, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-2 text-[10px] text-gray-500 text-right">
        {rows.length} row{rows.length === 1 ? "" : "s"} {liveTail && "· live tailing"}
      </div>
    </div>
  );
}

function ConsumersPanel({ topic }: { topic: string }) {
  const { data, error } = useSWR<{ groups: GroupReport[]; producerNote?: string; error?: string }>(
    `/api/kafka/consumers?topic=${encodeURIComponent(topic)}`,
    fetcher,
    { refreshInterval: 5_000, revalidateOnFocus: false },
  );

  if (data?.error) return <ErrorBanner msg={data.error} />;
  if (error) return <ErrorBanner msg="failed to fetch consumers" />;
  if (!data) return <Empty>Loading consumer offsets…</Empty>;

  return (
    <div className="space-y-4">
      {data.producerNote && (
        <div className="text-[11px] text-gray-500 italic">{data.producerNote}</div>
      )}
      {data.groups.map((g) => {
        const aggLag = g.partitions.reduce(
          (sum, p) => sum + BigInt(p.lag),
          0n,
        );
        const aggIsBig = aggLag > 1000n;
        return (
          <div key={g.groupId} className="panel p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="font-mono text-sm text-gray-100">{g.groupId}</div>
              <div className={`text-xs font-mono ${aggIsBig ? "text-rose-300" : "text-gray-400"}`}>
                total lag: {aggLag.toString()}
              </div>
            </div>
            {g.hint && <div className="text-[11px] text-amber-400 mb-2">{g.hint}</div>}
            {g.partitions.length === 0 && !g.hint && (
              <div className="text-[11px] text-gray-500">no partitions reported</div>
            )}
            {g.partitions.length > 0 && (
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase text-gray-500">
                  <tr>
                    <th className="text-left py-1">Partition</th>
                    <th className="text-right py-1">Current</th>
                    <th className="text-right py-1">Log end</th>
                    <th className="text-right py-1">Lag</th>
                  </tr>
                </thead>
                <tbody>
                  {g.partitions.map((p) => {
                    const big = BigInt(p.lag) > 1000n;
                    return (
                      <tr key={p.partition} className={`border-t border-bg-ring/30 ${big ? "bg-rose-500/10" : ""}`}>
                        <td className="py-1 text-gray-300">{p.partition}</td>
                        <td className="py-1 text-right font-mono text-gray-300">{p.current}</td>
                        <td className="py-1 text-right font-mono text-gray-300">{p.logEnd}</td>
                        <td className={`py-1 text-right font-mono ${big ? "text-rose-300" : "text-gray-200"}`}>
                          {p.lag}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MetadataPanel({ topic }: { topic: string }) {
  const { data, error } = useSWR<MetadataResp>(
    `/api/kafka/metadata?topic=${encodeURIComponent(topic)}`,
    fetcher,
    { refreshInterval: 30_000, revalidateOnFocus: false },
  );

  if (data?.error) return <ErrorBanner msg={data.error} />;
  if (error) return <ErrorBanner msg="failed to fetch metadata" />;
  if (!data) return <Empty>Loading metadata…</Empty>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <KV k="partitions"          v={String(data.partitions)} />
        <KV k="replication.factor"  v={String(data.replicationFactor)} />
      </div>
      <div>
        <div className="panel-title mb-2">Topic configs</div>
        <table className="w-full text-xs border border-bg-ring/40 rounded-md overflow-hidden">
          <thead className="bg-[#10172a] text-[10px] uppercase text-gray-500">
            <tr>
              <th className="text-left px-2 py-1.5">Name</th>
              <th className="text-left px-2 py-1.5">Value</th>
              <th className="text-left px-2 py-1.5">Default?</th>
            </tr>
          </thead>
          <tbody>
            {data.configs.length === 0 && (
              <tr><td colSpan={3} className="px-2 py-3 text-center text-gray-500">No surfaced configs.</td></tr>
            )}
            {data.configs.map((c) => (
              <tr key={c.name} className="border-t border-bg-ring/30">
                <td className="px-2 py-1 font-mono text-gray-200">{c.name}</td>
                <td className="px-2 py-1 font-mono text-gray-300">{c.value || "(empty)"}</td>
                <td className="px-2 py-1 text-gray-500">{c.isDefault ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="panel p-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{k}</div>
      <div className="text-lg font-semibold kpi-value text-gray-100 mt-1">{v}</div>
    </div>
  );
}
