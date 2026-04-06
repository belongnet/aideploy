import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { resolveValueTree } from "@/lib/secret-resolver";

const SECRETS_ROOT =
  process.env.AIDEPLOY_RUNTIME_SECRETS_ROOT || "/run/aideploy-secrets";
const HOME_ROOT = process.env.AIDEPLOY_HOME_ROOT || "/home/aideploy";

const RUNTIME_AUTH_PROFILES = `${SECRETS_ROOT}/default/.openclaw/agents/main/agent/auth-profiles.json`;
const SOURCE_AUTH_PROFILES = `${HOME_ROOT}/.openclaw/agents/main/agent/auth-profiles.json`;

export interface AuthProfile {
  provider: string;
  authType: string;
  updatedAt: string;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface AuthProfileStore {
  version: number;
  profiles: Record<string, AuthProfile>;
}

async function readFirstAvailableJson<T>(
  paths: string[],
  transform: (parsed: unknown) => Promise<T> | T,
): Promise<T | null> {
  let lastError: unknown = null;

  for (const path of paths) {
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw);
      return await transform(parsed);
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  if (lastError) throw lastError;
  return null;
}

async function readRawAuthProfiles(): Promise<AuthProfileStore> {
  const store = await readFirstAvailableJson(
    [RUNTIME_AUTH_PROFILES, SOURCE_AUTH_PROFILES],
    (parsed) => {
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Auth profiles file must contain a JSON object");
      }
      if (typeof (parsed as AuthProfileStore).profiles !== "object") {
        throw new Error("Auth profiles file is missing the profiles object");
      }
      return parsed as AuthProfileStore;
    },
  );

  return store ?? { version: 1, profiles: {} };
}

export async function readAuthProfilesForUpdate(): Promise<AuthProfileStore> {
  return readRawAuthProfiles();
}

async function readRawOpenClawConfig(): Promise<Record<string, unknown>> {
  const config = await readFirstAvailableJson(
    [RUNTIME_CONFIG, SOURCE_CONFIG],
    (parsed) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("openclaw.json must contain a JSON object");
      }
      return parsed as Record<string, unknown>;
    },
  );

  return config ?? {};
}

export async function readAuthProfiles(): Promise<AuthProfileStore> {
  const parsed = await readRawAuthProfiles();
  return (await resolveValueTree(parsed, "auth.profiles")) as AuthProfileStore;
}

export async function writeAuthProfiles(
  store: AuthProfileStore,
): Promise<void> {
  const json = JSON.stringify(store, null, 2);
  for (const path of [RUNTIME_AUTH_PROFILES, SOURCE_AUTH_PROFILES]) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, json, { mode: 0o600 });
    } catch {
      // best effort for source path
    }
  }

  try {
    const config = await readRawOpenClawConfig();
    await writeOpenClawConfig(config);
  } catch {
    // Config sync is best effort when auth changes.
  }
}

const RUNTIME_CONFIG = `${SECRETS_ROOT}/default/.openclaw/openclaw.json`;
const SOURCE_CONFIG = `${HOME_ROOT}/.openclaw/openclaw.json`;

const DEFAULT_MODELS: Record<string, string> = {
  openai: "openai-codex/gpt-5.3-codex",
  anthropic: "anthropic/claude-opus-4-6",
};
const RUNTIME_MODE = String(
  process.env.AIDEPLOY_AGENT_RUNTIME || process.env.AIDEPLOY_RUNTIME_MODE || "docker",
)
  .trim()
  .toLowerCase();
const ANTHROPIC_BILLING_PROXY_BASE_URL =
  "http://anthropic-billing-proxy:18801";
const DEFAULT_MEDIA_TOOL_CONFIG = {
  media: {
    concurrency: 2,
    audio: {
      enabled: true,
      maxBytes: 20 * 1024 * 1024,
    },
  },
} as const;
const DEFAULT_EXEC_CONFIG = {
  host: "gateway",
  security: "full",
  ask: "off",
} as const;
const DEFAULT_ELEVATED_DEFAULT = "full";
const DEFAULT_OPENAI_AUDIO_TRANSCRIPTION_MODEL = {
  provider: "openai",
  model: "gpt-4o-mini-transcribe",
} as const;
const DEFAULT_WHISPER_AUDIO_TRANSCRIPTION_MODEL = {
  type: "cli",
  command: "whisper",
  args: ["--model", "base", "{{MediaPath}}"],
  timeoutSeconds: 45,
} as const;

function normalizeAllowedSenders(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    const item = typeof value === "string" ? value.trim() : String(value ?? "").trim();
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

function configuredPrimaryModelFromConfig(
  config: Record<string, unknown>,
): string {
  const agents = (config.agents ?? {}) as Record<string, unknown>;
  const defaults = (agents.defaults ?? {}) as Record<string, unknown>;
  const model = (defaults.model ?? {}) as Record<string, unknown>;
  return typeof model.primary === "string" ? model.primary.trim() : "";
}

function inferModelProvider(model: string): string {
  const raw = model.trim().toLowerCase();
  if (!raw) return "";
  const provider = raw.split("/", 1)[0]?.trim() ?? "";
  if (provider === "openai-codex") return "openai";
  return provider;
}

function normalizeAuthType(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function anthropicBillingProxyBaseUrlForRuntime(runtime: string): string {
  return runtime === "" || runtime === "docker"
    ? ANTHROPIC_BILLING_PROXY_BASE_URL
    : "";
}

function configUsesAnthropicBillingProxy(
  config: Record<string, unknown>,
): boolean {
  const proxyBaseUrl = anthropicBillingProxyBaseUrlForRuntime(RUNTIME_MODE);
  if (!proxyBaseUrl) return false;
  const models = (config.models ?? {}) as Record<string, unknown>;
  const providers = (models.providers ?? {}) as Record<string, unknown>;
  const anthropic = (providers.anthropic ?? {}) as Record<string, unknown>;
  return (
    typeof anthropic.baseUrl === "string" &&
    anthropic.baseUrl.trim() === proxyBaseUrl
  );
}

function findAnthropicProfile(store: AuthProfileStore): AuthProfile | null {
  const explicit = store.profiles["anthropic:default"];
  if (explicit && typeof explicit === "object") return explicit;
  for (const profile of Object.values(store.profiles)) {
    if (
      profile &&
      typeof profile === "object" &&
      normalizeAuthType(profile.provider) === "anthropic"
    ) {
      return profile;
    }
  }
  return null;
}

function isAnthropicOauthProfile(profile: AuthProfile | null): boolean {
  if (!profile) return false;
  const authType = normalizeAuthType(profile.authType);
  if (!["oauth", "consumer", "subscription_token", "token"].includes(authType)) {
    return false;
  }
  return Boolean(profile.accessToken?.trim());
}

function isAnthropicApiKeyProfile(profile: AuthProfile | null): boolean {
  if (!profile) return false;
  const authType = normalizeAuthType(profile.authType);
  if (authType === "api_key") return true;
  return Boolean(profile.apiKey?.trim()) && !profile.accessToken?.trim();
}

function applyAnthropicBillingProxyConfig(
  config: Record<string, unknown>,
  store: AuthProfileStore,
): Record<string, unknown> {
  const next = { ...config };
  const primaryModel = configuredPrimaryModelFromConfig(next);
  const proxyBaseUrl = anthropicBillingProxyBaseUrlForRuntime(RUNTIME_MODE);
  let enableProxy = false;

  if (proxyBaseUrl && inferModelProvider(primaryModel) === "anthropic") {
    const profile = findAnthropicProfile(store);
    if (isAnthropicApiKeyProfile(profile)) {
      enableProxy = false;
    } else if (isAnthropicOauthProfile(profile)) {
      enableProxy = true;
    } else {
      enableProxy = configUsesAnthropicBillingProxy(next);
    }
  }

  const models = { ...((next.models ?? {}) as Record<string, unknown>) };
  const providers = { ...((models.providers ?? {}) as Record<string, unknown>) };
  const anthropic = {
    ...((providers.anthropic ?? {}) as Record<string, unknown>),
  };

  if (enableProxy && proxyBaseUrl) {
    anthropic.baseUrl = proxyBaseUrl;
    providers.anthropic = anthropic;
  } else {
    delete anthropic.baseUrl;
    if (Object.keys(anthropic).length > 0) providers.anthropic = anthropic;
    else delete providers.anthropic;
  }

  if (Object.keys(providers).length > 0) models.providers = providers;
  else delete models.providers;

  if (Object.keys(models).length > 0) next.models = models;
  else delete next.models;

  return next;
}

function normalizeManagedAudioModels(
  existingModels: unknown,
  primaryModel: string,
): Record<string, unknown>[] {
  const next = Array.isArray(existingModels)
    ? existingModels
        .filter(
          (entry): entry is Record<string, unknown> =>
            Boolean(entry) &&
            typeof entry === "object" &&
            !Array.isArray(entry),
        )
        .map((entry) => ({ ...entry }))
    : [];
  if (
    inferModelProvider(primaryModel) === "openai" &&
    !next.some((entry) => String(entry.provider ?? "").trim() === "openai")
  ) {
    next.unshift({ ...DEFAULT_OPENAI_AUDIO_TRANSCRIPTION_MODEL });
  }
  if (
    !next.some((entry) => {
      const type = String(entry.type ?? "cli").trim();
      return type === "cli" && String(entry.command ?? "").trim() === "whisper";
    })
  ) {
    next.push({ ...DEFAULT_WHISPER_AUDIO_TRANSCRIPTION_MODEL });
  }
  return next;
}

function applyManagedCommandConfig(
  config: Record<string, unknown>,
  telegramAllowFrom?: string[],
): Record<string, unknown> {
  const next = { ...config };
  const agents = ((next.agents ?? {}) as Record<string, unknown>);
  const defaults = ((agents.defaults ?? {}) as Record<string, unknown>);
  if (typeof defaults.elevatedDefault !== "string" || !defaults.elevatedDefault.trim()) {
    defaults.elevatedDefault = DEFAULT_ELEVATED_DEFAULT;
  }

  const tools = ((next.tools ?? {}) as Record<string, unknown>);
  const media = ((tools.media ?? {}) as Record<string, unknown>);
  if (
    typeof media.concurrency !== "number" ||
    media.concurrency < 1
  ) {
    media.concurrency = DEFAULT_MEDIA_TOOL_CONFIG.media.concurrency;
  }
  const audio = ((media.audio ?? {}) as Record<string, unknown>);
  if (typeof audio.enabled !== "boolean") {
    audio.enabled = DEFAULT_MEDIA_TOOL_CONFIG.media.audio.enabled;
  }
  if (typeof audio.maxBytes !== "number" || audio.maxBytes < 1) {
    audio.maxBytes = DEFAULT_MEDIA_TOOL_CONFIG.media.audio.maxBytes;
  }
  audio.models = normalizeManagedAudioModels(
    audio.models,
    configuredPrimaryModelFromConfig(next),
  );
  media.audio = audio;
  tools.media = media;

  const execConfig = ((tools.exec ?? {}) as Record<string, unknown>);
  if (typeof execConfig.host !== "string" || !execConfig.host.trim()) {
    execConfig.host = DEFAULT_EXEC_CONFIG.host;
  }
  if (typeof execConfig.security !== "string" || !execConfig.security.trim()) {
    execConfig.security = DEFAULT_EXEC_CONFIG.security;
  }
  if (typeof execConfig.ask !== "string" || !execConfig.ask.trim()) {
    execConfig.ask = DEFAULT_EXEC_CONFIG.ask;
  }

  const elevated = ((tools.elevated ?? {}) as Record<string, unknown>);
  if (typeof elevated.enabled !== "boolean") {
    elevated.enabled = true;
  }
  const allowFromRaw = elevated.allowFrom;
  const allowFrom =
    allowFromRaw && typeof allowFromRaw === "object" && !Array.isArray(allowFromRaw)
      ? { ...(allowFromRaw as Record<string, unknown>) }
      : {};
  const normalizedTelegramAllowFrom = normalizeAllowedSenders(
    telegramAllowFrom ??
      ((((next.channels ?? {}) as Record<string, unknown>).telegram as
        | { allowFrom?: unknown }
        | undefined)?.allowFrom),
  );
  if (normalizedTelegramAllowFrom.length > 0) {
    allowFrom.telegram = normalizedTelegramAllowFrom;
  } else {
    delete allowFrom.telegram;
  }

  elevated.allowFrom = allowFrom;
  tools.exec = execConfig;
  tools.elevated = elevated;
  agents.defaults = defaults;
  next.agents = agents;
  next.tools = tools;
  return next;
}

/**
 * Read the merged openclaw.json config from the runtime secrets path,
 * falling back to the home-root copy. Any secret references
 * (env://, doppler://, aws-sm://, gcp-sm://, azure-kv://) found in
 * the config values are resolved before the config is returned.
 */
export async function readOpenClawConfig(): Promise<Record<string, unknown>> {
  const parsed = await readRawOpenClawConfig();
  return (await resolveValueTree(parsed, "openclaw.config")) as Record<
    string,
    unknown
  >;
}

/**
 * Write the openclaw.json config to both runtime and home-root paths.
 */
export async function writeOpenClawConfig(
  config: Record<string, unknown>,
  telegramAllowFrom?: string[],
): Promise<void> {
  let authStore: AuthProfileStore = { version: 1, profiles: {} };
  try {
    authStore = await readRawAuthProfiles();
  } catch {
    // First-run installs may not have auth profiles yet.
  }
  const json = JSON.stringify(
    applyManagedCommandConfig(
      applyAnthropicBillingProxyConfig(config, authStore),
      telegramAllowFrom,
    ),
    null,
    2,
  );
  for (const path of [RUNTIME_CONFIG, SOURCE_CONFIG]) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, json, { mode: 0o644 });
    } catch {
      // best effort for source path
    }
  }
}

/**
 * Ensure openclaw.json has a primary model set for the given provider.
 * Called after OAuth completes so deployments that started unconfigured
 * (no credentials at provision time) get the correct model written.
 */
export async function ensureModelForProvider(
  provider: string,
): Promise<boolean> {
  const config = await readRawOpenClawConfig();
  const agents = (config.agents ?? {}) as Record<string, unknown>;
  const defaults = (agents.defaults ?? {}) as Record<string, unknown>;
  const model = (defaults.model ?? {}) as Record<string, unknown>;
  const current = typeof model.primary === "string" ? model.primary : "";

  // Already has a model matching this provider
  if (current && current.includes(provider)) return false;
  if (provider === "openai" && current.includes("openai")) return false;

  const target = DEFAULT_MODELS[provider];
  if (!target) return false;

  const updated = {
    ...config,
    agents: {
      ...agents,
      defaults: {
        ...defaults,
        model: { ...model, primary: target },
        ...(provider === "anthropic"
          ? { models: { [target]: { params: { context1m: true } } } }
          : {}),
      },
    },
  };
  await writeOpenClawConfig(updated);
  return true;
}

export async function configureTelegramOwnerPrivilegedAccess(
  ownerChatId: string,
): Promise<boolean> {
  const normalizedOwnerChatId = ownerChatId.trim();
  if (!normalizedOwnerChatId) return false;

  const config = await readRawOpenClawConfig();
  const updated = applyManagedCommandConfig(config, [normalizedOwnerChatId]);
  if (JSON.stringify(updated) === JSON.stringify(config)) return false;
  await writeOpenClawConfig(updated, [normalizedOwnerChatId]);
  return true;
}

export async function restartGateway(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      ["restart", "openclaw-gateway"],
      { timeout: 30_000 },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}
