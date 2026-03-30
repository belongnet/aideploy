import { NextResponse } from "next/server";

import { readAuthProfiles } from "@/lib/openclaw-runtime";

const PROVIDERS = [
  { id: "openai", name: "ChatGPT / OpenAI", profileKey: "openai-codex:default" },
  { id: "anthropic", name: "Claude / Anthropic", profileKey: "anthropic:default" },
];

export async function GET() {
  try {
    const store = await readAuthProfiles();
    const providers = PROVIDERS.map((p) => {
      const profile = store.profiles[p.profileKey];
      const connected = Boolean(
        profile && (profile.accessToken || profile.apiKey),
      );
      return {
        id: p.id,
        name: p.name,
        authMethod: "consumer" as const,
        connected,
      };
    });
    const setupRequired = !providers.some((p) => p.connected);
    return NextResponse.json({ setupRequired, providers });
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
