import { NextResponse } from "next/server";

import { getProviderConnectSession } from "@/lib/provider-connect";

function normalizeProvider(provider: string): "openai" | "anthropic" | null {
  return provider === "openai" || provider === "anthropic" ? provider : null;
}

export async function GET(
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

  return NextResponse.json({
    success: true,
    session: getProviderConnectSession(provider),
  });
}
