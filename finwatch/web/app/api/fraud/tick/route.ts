import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const WORKER_URL = process.env.FRAUD_WORKER_URL ?? "http://fraud-worker:5000";

type RuleResult = {
  rule_code: string;
  new?: number;
  dedup?: number;
  skipped?: number;
  elapsed_ms?: number;
  error?: string;
};

type WorkerResponse = {
  rules?: RuleResult[];
  dedup_seconds?: number;
  error?: string;
};

export async function POST() {
  try {
    const r = await fetch(`${WORKER_URL}/tick`, {
      method: "POST",
      cache: "no-store",
    });
    const text = await r.text();
    let body: WorkerResponse;
    try {
      body = JSON.parse(text) as WorkerResponse;
    } catch {
      return NextResponse.json(
        { error: `worker returned non-JSON (status ${r.status}): ${text.slice(0, 200)}` },
        { status: 503 },
      );
    }
    if (!r.ok) {
      return NextResponse.json(body, { status: r.status });
    }
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { error: `cannot reach fraud-worker at ${WORKER_URL}: ${(e as Error).message}` },
      { status: 503 },
    );
  }
}
