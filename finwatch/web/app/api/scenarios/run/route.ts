import { NextResponse } from "next/server";
import { isScenarioName, runScenario } from "@/lib/scenarios";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: Request) {
  let body: { scenario?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const name = body.scenario;
  if (!name || typeof name !== "string" || !isScenarioName(name)) {
    return NextResponse.json(
      { error: `unknown scenario '${name}'` },
      { status: 400 },
    );
  }

  try {
    const result = await runScenario(name);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, scenario: name },
      { status: 500 },
    );
  }
}
