import { NextResponse } from "next/server";

import { startProviderConnectSession } from "@/lib/provider-connect";

function normalizeProvider(provider: string): "openai" | "anthropic" | null {
  return provider === "openai" || provider === "anthropic" ? provider : null;
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider: rawProvider } = await context.params;
  const provider = normalizeProvider(rawProvider);
  if (!provider) {
    return NextResponse.json(
      { error: "Connect flow is not supported for this provider" },
      { status: 400 },
    );
  }

  try {
    const session = await startProviderConnectSession(provider);
    return NextResponse.json({ success: true, session });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to start connect flow",
      },
      { status: 400 },
    );
  }
}
