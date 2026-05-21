import { NextResponse } from "next/server";
import { SCENARIOS } from "@/lib/scenarios";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return NextResponse.json({ scenarios: SCENARIOS });
}
