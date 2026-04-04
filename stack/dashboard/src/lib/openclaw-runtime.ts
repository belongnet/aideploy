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
}

const RUNTIME_CONFIG = `${SECRETS_ROOT}/default/.openclaw/openclaw.json`;
const SOURCE_CONFIG = `${HOME_ROOT}/.openclaw/openclaw.json`;

const DEFAULT_MODELS: Record<string, string> = {
  openai: "openai-codex/gpt-5.3-codex",
  anthropic: "anthropic/claude-opus-4-6",
};
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
  const json = JSON.stringify(applyManagedCommandConfig(config, telegramAllowFrom), null, 2);
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
