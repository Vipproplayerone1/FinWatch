import { NextResponse } from "next/server";
import { consumeRecent } from "@/lib/kafka";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const FINWATCH_TOPIC = /^finwatch\.public\./;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const topic = url.searchParams.get("topic") ?? "";
  const limitRaw = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500)
    : 50;

  if (!topic) {
    return NextResponse.json(
      { messages: [], error: "topic query param required" },
      { status: 400 },
    );
  }
  if (!FINWATCH_TOPIC.test(topic)) {
    return NextResponse.json(
      { messages: [], error: "topic must match finwatch.public.*" },
      { status: 400 },
    );
  }

  try {
    const messages = await consumeRecent(topic, limit);
    return NextResponse.json({ messages, ts: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { messages: [], error: (err as Error).message },
      { status: 503 },
    );
  }
}
