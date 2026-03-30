import { NextResponse } from "next/server";

import { agentRequest } from "@/lib/agent-server-api";

export async function POST() {
  try {
    const data = await agentRequest("/api/setup/complete", {
      method: "POST",
      body: JSON.stringify({}),
    });
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not finish setup",
      },
      { status: 500 },
    );
  }
}
