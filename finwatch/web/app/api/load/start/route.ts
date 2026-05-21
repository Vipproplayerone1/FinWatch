import { NextResponse } from "next/server";
import { driveLoad } from "@/lib/scenarios";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: Request) {
  let body: { count?: number } = {};
  try {
    body = await req.json();
  } catch {
    // body is optional — default count is fine
  }

  const raw = Number(body.count ?? 200);
  const count = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 2000) : 200;

  try {
    const result = await driveLoad(count);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
