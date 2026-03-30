import { NextResponse } from "next/server";

import {
  readAuthProfiles,
  ensureModelForProvider,
  restartGateway,
} from "@/lib/openclaw-runtime";

/**
 * Detect which AI provider has credentials and set the model accordingly,
 * then restart the gateway so the new config takes effect.
 */
export async function POST() {
  try {
    const store = await readAuthProfiles();
    const providerKeys: Record<string, string> = {
      "openai-codex:default": "openai",
      "anthropic:default": "anthropic",
    };
    for (const [profileKey, provider] of Object.entries(providerKeys)) {
      const profile = store.profiles[profileKey];
      if (profile && (profile.accessToken || profile.apiKey)) {
        await ensureModelForProvider(provider);
        break;
      }
    }
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
