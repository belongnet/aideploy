import { NextRequest, NextResponse } from "next/server";
import {
  RestoreRequestValidationError,
  createRestorePlaceholder,
} from "@/lib/recovery-server";
import { readJsonBody, requestBodyErrorResponse } from "@/lib/request-body";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let body: {
    runId?: unknown;
    mode?: unknown;
    mergeReviewed?: unknown;
    confirmation?: unknown;
  };
  try {
    body = await readJsonBody(request);
  } catch (error) {
    const bodyError = requestBodyErrorResponse(error);
    if (bodyError) return bodyError;
    throw error;
  }
  const runId = typeof body?.runId === "string" ? body.runId.trim() : "";
  const mode = body?.mode === "merge" ? "merge" : "full";
  const confirmation =
    typeof body?.confirmation === "string" ? body.confirmation.trim() : "";

  if (!runId) {
    return NextResponse.json({ error: "Missing restore runId" }, { status: 400 });
  }

  try {
    const result = await createRestorePlaceholder(runId, {
      mode,
      mergeReviewed: body?.mergeReviewed === true,
      confirmation,
    });
    if (!result) {
      return NextResponse.json({ error: "Backup run not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof RestoreRequestValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
