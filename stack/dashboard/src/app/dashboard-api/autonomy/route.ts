import { NextRequest, NextResponse } from "next/server";

import {
  readAutonomyEnabled,
  writeAutonomyEnabled,
} from "@/lib/openclaw-runtime";
import { readJsonBody, requestBodyErrorResponse } from "@/lib/request-body";

export async function GET() {
  try {
    return NextResponse.json({
      autonomousMode: await readAutonomyEnabled(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not load autonomy",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request);
    const enabled = body.autonomousMode ?? body.autonomous_mode;
    if (typeof enabled !== "boolean") {
      return NextResponse.json(
        { error: "autonomousMode must be a boolean" },
        { status: 400 },
      );
    }

    await writeAutonomyEnabled(enabled);
    return NextResponse.json({ ok: true, autonomousMode: enabled });
  } catch (error) {
    const bodyError = requestBodyErrorResponse(error);
    if (bodyError) return bodyError;

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not save autonomy",
      },
      { status: 500 },
    );
  }
}
