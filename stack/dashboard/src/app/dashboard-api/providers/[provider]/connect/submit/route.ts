import { NextResponse } from "next/server";

import { submitProviderConnectInput } from "@/lib/provider-connect";
import { readJsonBody, requestBodyErrorResponse } from "@/lib/request-body";

function normalizeProvider(provider: string): "openai" | "anthropic" | null {
  return provider === "openai" || provider === "anthropic" ? provider : null;
}

export async function POST(
  request: Request,
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
    const body = await readJsonBody<{ input?: string }>(request);
    const session = await submitProviderConnectInput(provider, body.input || "");
    return NextResponse.json({ success: true, session });
  } catch (error) {
    const bodyError = requestBodyErrorResponse(error);
    if (bodyError) return bodyError;

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to submit connect flow input",
      },
      { status: 400 },
    );
  }
}
