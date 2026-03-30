import { NextResponse } from "next/server";

import { agentRequest } from "@/lib/agent-server-api";

export async function GET() {
  try {
    const data = await agentRequest<{
      setupRequired: boolean;
      providers: {
        id: string;
        name: string;
        authMethod: "consumer" | "api_key";
        connected: boolean;
      }[];
    }>("/api/setup/status");
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not load setup status",
      },
      { status: 500 },
    );
  }
}
