import { NextRequest, NextResponse } from "next/server";
import { getRecoveryPreview } from "@/lib/recovery-server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId")?.trim();

  if (!runId) {
    return NextResponse.json(
      { error: "Missing 'runId' query parameter" },
      { status: 400 },
    );
  }

  const preview = await getRecoveryPreview(runId);
  if (!preview) {
    return NextResponse.json({ error: "Backup run not found" }, { status: 404 });
  }

  return NextResponse.json(preview);
}
