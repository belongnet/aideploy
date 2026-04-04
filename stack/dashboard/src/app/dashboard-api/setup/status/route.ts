import { NextResponse } from "next/server";

import {
  readAuthProfiles,
  readOpenClawConfig,
  type AuthProfile,
} from "@/lib/openclaw-runtime";

const PROVIDERS = [
  {
    id: "openai",
    name: "ChatGPT / OpenAI",
    profileKeys: ["openai-codex:default", "openai:default"],
    defaultAuthMethod: "consumer" as const,
  },
  {
    id: "anthropic",
    name: "Claude / Anthropic",
    profileKeys: ["anthropic:default"],
    defaultAuthMethod: "consumer" as const,
  },
  {
    id: "gemini",
    name: "Gemini / Google",
    profileKeys: ["google:default", "gemini:default"],
    defaultAuthMethod: "api_key" as const,
  },
  {
    id: "kimi",
    name: "Kimi / Moonshot AI",
    profileKeys: ["kimi:default"],
    defaultAuthMethod: "api_key" as const,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    profileKeys: ["deepseek:default"],
    defaultAuthMethod: "api_key" as const,
  },
];

function configuredPrimaryModelFromConfig(
  config: Record<string, unknown>,
): string {
  const agents =
    config.agents && typeof config.agents === "object"
      ? (config.agents as Record<string, unknown>)
      : {};
  const defaults =
    agents.defaults && typeof agents.defaults === "object"
      ? (agents.defaults as Record<string, unknown>)
      : {};
  const model =
    defaults.model && typeof defaults.model === "object"
      ? (defaults.model as Record<string, unknown>)
      : {};
  return typeof model.primary === "string" ? model.primary.trim() : "";
}

function inferModelProvider(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return "";
  if (
    normalized.startsWith("openai-codex/") ||
    normalized.startsWith("openai/")
  ) {
    return "openai";
  }
  if (normalized.startsWith("anthropic/")) return "anthropic";
  if (
    normalized.startsWith("google/") ||
    normalized.startsWith("gemini/")
  ) {
    return "gemini";
  }
  if (normalized.startsWith("kimi/")) return "kimi";
  if (normalized.startsWith("deepseek/")) return "deepseek";
  return "";
}

function profileHasCredential(profile: AuthProfile | null): boolean {
  return Boolean(
    profile &&
      (profile.accessToken ||
        profile.apiKey ||
        (profile as AuthProfile & { access?: string }).access ||
        (profile as AuthProfile & { token?: string }).token),
  );
}

function inferAuthMethod(
  profile: AuthProfile | null,
  fallback: "consumer" | "api_key",
): "consumer" | "api_key" {
  const authType = String(profile?.authType ?? "")
    .trim()
    .toLowerCase();
  if (
    authType === "oauth" ||
    authType === "consumer" ||
    authType === "subscription_token" ||
    authType === "token"
  ) {
    return "consumer";
  }
  if (authType === "api_key") return "api_key";
  if (profile?.apiKey && !profile.accessToken) return "api_key";
  if (profile?.accessToken) return "consumer";
  return fallback;
}

function resolveStoredProfile(
  profiles: Record<string, AuthProfile>,
  profileKeys: string[],
): AuthProfile | null {
  for (const key of profileKeys) {
    const profile = profiles[key];
    if (profile && typeof profile === "object") {
      return profile;
    }
  }
  return null;
}

export async function GET() {
  try {
    const [store, openClawConfig] = await Promise.all([
      readAuthProfiles(),
      readOpenClawConfig(),
    ]);
    const currentModel = configuredPrimaryModelFromConfig(openClawConfig);
    const currentProvider = inferModelProvider(currentModel);

    const providers = PROVIDERS.map((provider) => {
      const profile = resolveStoredProfile(
        store.profiles,
        provider.profileKeys,
      );
      const connected = profileHasCredential(profile);
      return {
        id: provider.id,
        name: provider.name,
        authMethod: inferAuthMethod(profile, provider.defaultAuthMethod),
        connected,
      };
    });

    const activeProvider = currentProvider
      ? providers.find((provider) => provider.id === currentProvider) ?? null
      : null;
    const setupRequired = activeProvider
      ? !activeProvider.connected
      : !providers.some((provider) => provider.connected);

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
