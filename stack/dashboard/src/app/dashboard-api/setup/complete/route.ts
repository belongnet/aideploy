import { NextResponse } from "next/server";

import { restartGateway } from "@/lib/openclaw-runtime";

export async function POST() {
  try {
    await restartGateway();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not finish setup",
      },
      { status: 500 },
    );
  }
}
