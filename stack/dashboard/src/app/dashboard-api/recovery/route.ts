import { NextResponse } from "next/server";
import { getRecoveryOverview } from "@/lib/recovery-server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getRecoveryOverview());
}
