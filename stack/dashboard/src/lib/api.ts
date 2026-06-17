/**
 * API client for the per-agent dashboard.
 *
 * All requests go to /api/* which Next.js rewrites to the agent backend
 * running on port 810N (configured via AGENT_PORT env var).
 */

/* ------------------------------------------------------------------ */
/*  Generic fetcher                                                    */
/* ------------------------------------------------------------------ */

async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "Unknown error");
    throw new Error(`API ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

/* ------------------------------------------------------------------ */
/*  Status & Stats                                                     */
/* ------------------------------------------------------------------ */

export const fetchStatus = () =>
  request<{
    name: string;
    status: string;
    uptime: string;
    version: string;
  }>("/api/system/status");

export const fetchStats = () =>
  request<{
    messagesToday: number;
    totalConversations: number;
    activeChannels: number;
    activeTasks: number;
  }>("/api/analytics/stats");

export const fetchMessageVolume = () =>
  request<{ date: string; messages: number }[]>("/api/analytics/volume");

/* ------------------------------------------------------------------ */
/*  Conversations                                                      */
/* ------------------------------------------------------------------ */

export const fetchConversations = (params?: {
  search?: string;
  starred?: boolean;
}) => {
  const qs = new URLSearchParams();
  if (params?.search) qs.set("search", params.search);
  if (params?.starred) qs.set("starred", "true");
  const suffix = qs.toString() ? `?${qs}` : "";
  return request<
    {
      id: string;
      channelType: string;
      contactName: string;
      lastMessage: string;
      lastMessageAt: string;
      messageCount: number;
      starred: boolean;
    }[]
  >(`/api/conversations${suffix}`);
};

export const fetchConversationMessages = (id: string) =>
  request<
    {
      id: string;
      conversationId: string;
      role: string;
      content: string;
      createdAt: string;
    }[]
  >(`/api/conversations/${id}/messages`);

export const toggleStar = (id: string, starred: boolean) =>
  request<{ ok: boolean }>(`/api/conversations/${id}/star`, {
    method: "POST",
    body: JSON.stringify({ starred }),
  });

/* ------------------------------------------------------------------ */
/*  Tasks                                                              */
/* ------------------------------------------------------------------ */

export interface TaskSummary {
  id: string;
  name: string;
  description: string;
  trigger: string;
  action: string;
  enabled: boolean;
  lastRun: string | null;
  runCount: number;
  // Circuit-breaker health fields emitted by the agent's Task model.
  consecutive_errors?: number;
  last_error?: string | null;
  auto_disabled_at?: string | null;
  auto_disabled_reason?: string | null;
}

export const fetchTasks = () => request<TaskSummary[]>("/api/tasks");

export const toggleTask = (id: string, enabled: boolean) =>
  request<{ ok: boolean }>(`/api/tasks/${id}/toggle`, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });

export const generateTask = (description: string) =>
  request<{
    name: string;
    trigger: string;
    action: string;
    description: string;
  }>("/api/tasks/generate", {
    method: "POST",
    body: JSON.stringify({ description }),
  });

export const createTask = (task: {
  name: string;
  description: string;
  trigger: string;
  action: string;
}) =>
  request<{ id: string }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(task),
  });

export const testTask = (id: string) =>
  request<{ output: string }>(`/api/tasks/${id}/test`, { method: "POST" });

/* ------------------------------------------------------------------ */
/*  Channels                                                           */
/* ------------------------------------------------------------------ */

export const fetchChannels = () =>
  request<
    {
      id: string;
      type: string;
      name: string;
      status: string;
      lastActivity: string | null;
    }[]
  >("/api/channels");

export const addChannel = (channel: { type: string; token: string }) =>
  request<{ id: string }>("/api/channels", {
    method: "POST",
    body: JSON.stringify({
      type: channel.type,
      name:
        channel.type === "telegram"
          ? "Telegram"
          : channel.type === "whatsapp"
            ? "WhatsApp"
            : channel.type === "slack"
              ? "Slack"
              : channel.type,
      status: "connected",
      config:
        channel.type === "whatsapp"
          ? { accessToken: channel.token }
          : { botToken: channel.token },
    }),
  });

export const connectTelegramChannel = (channel: {
  token: string;
  ownerChatId: string;
  ownerUserId?: string;
  name?: string;
}) =>
  request<{
    success: boolean;
    promptTriggered: boolean;
    promptResult: Record<string, unknown> | null;
  }>("/dashboard-api/channels/telegram/connect", {
    method: "POST",
    body: JSON.stringify(channel),
  });

export const removeChannel = (id: string) =>
  request<{ ok: boolean }>(`/api/channels/${id}`, { method: "DELETE" });

/* ------------------------------------------------------------------ */
/*  Analytics                                                          */
/* ------------------------------------------------------------------ */

export const fetchAnalyticsVolume = () =>
  request<{ date: string; messages: number }[]>("/api/analytics/volume");

export const fetchResponseTimes = () =>
  request<{ bucket: string; count: number }[]>("/api/analytics/response-times");

export const fetchTaskUsage = () =>
  request<{ name: string; runs: number }[]>("/api/analytics/task-usage");

export const fetchAiUsage = () =>
  request<{
    totalCalls: number;
    totalTokens: number;
    estimatedCost: number;
    dailyUsage: { date: string; calls: number; tokens: number }[];
  }>("/api/analytics/ai-usage");

/* ------------------------------------------------------------------ */
/*  Settings                                                           */
/* ------------------------------------------------------------------ */

export interface DashboardConfig {
  name: string;
  personality: string;
  modelProvider: string;
  model: string;
  authMethod: string;
  connectedAs: string | null;
  pruneEnabled: boolean;
  pruneAfterDays: number;
  pruneKeepStarred: boolean;
  autonomousMode: boolean;
  serverInfo: {
    ip: string;
    tailscaleIp: string;
    provider: string;
    region: string;
  };
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function normalizeConfig(raw: Record<string, unknown>): DashboardConfig {
  const serverInfo =
    raw.serverInfo && typeof raw.serverInfo === "object"
      ? (raw.serverInfo as Record<string, unknown>)
      : {};

  return {
    name: stringValue(raw.name ?? raw.agent_name, "My Agent"),
    personality: stringValue(raw.personality ?? raw.system_prompt),
    modelProvider: stringValue(raw.modelProvider ?? raw.model_provider, "openai"),
    model: stringValue(raw.model),
    authMethod: stringValue(raw.authMethod ?? raw.auth_method, "oauth"),
    connectedAs:
      typeof (raw.connectedAs ?? raw.connected_as) === "string"
        ? ((raw.connectedAs ?? raw.connected_as) as string)
        : null,
    pruneEnabled: booleanValue(raw.pruneEnabled ?? raw.prune_enabled, true),
    pruneAfterDays: numberValue(raw.pruneAfterDays ?? raw.prune_after_days, 90),
    pruneKeepStarred: booleanValue(
      raw.pruneKeepStarred ?? raw.prune_keep_starred,
      true,
    ),
    autonomousMode: booleanValue(
      raw.autonomousMode ?? raw.autonomous_mode,
      true,
    ),
    serverInfo: {
      ip: stringValue(serverInfo.ip),
      tailscaleIp: stringValue(serverInfo.tailscaleIp ?? serverInfo.tailscale_ip),
      provider: stringValue(serverInfo.provider),
      region: stringValue(serverInfo.region),
    },
  };
}

function normalizeConfigUpdate(
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    switch (key) {
      case "name":
        out.agent_name = value;
        break;
      case "personality":
        out.system_prompt = value;
        break;
      case "modelProvider":
        out.model_provider = value;
        break;
      case "authMethod":
        out.auth_method = value;
        break;
      case "pruneEnabled":
        out.prune_enabled = value;
        break;
      case "pruneAfterDays":
        out.prune_after_days = value;
        break;
      case "pruneKeepStarred":
        out.prune_keep_starred = value;
        break;
      case "autonomousMode":
        out.autonomous_mode = value;
        break;
      default:
        out[key] = value;
    }
  }
  return out;
}

export const fetchConfig = async () =>
  normalizeConfig(await request<Record<string, unknown>>("/api/config"));

export const updateConfig = (
  updates: Record<string, unknown>
) =>
  request<{ ok: boolean }>("/api/config", {
    method: "PUT",
    body: JSON.stringify(normalizeConfigUpdate(updates)),
  });

export const fetchAutonomy = () =>
  request<{ autonomousMode: boolean }>("/dashboard-api/autonomy");

export const updateAutonomy = (autonomousMode: boolean) =>
  request<{ ok: boolean; autonomousMode: boolean }>("/dashboard-api/autonomy", {
    method: "PATCH",
    body: JSON.stringify({ autonomousMode }),
  });

export const pruneNow = () =>
  request<{ deleted: number }>("/api/conversations/prune", { method: "POST" });

export const restartAgent = () =>
  request<{ ok: boolean }>("/api/system/restart", { method: "POST" });

export const clearData = () =>
  request<{ ok: boolean }>("/api/system/clear-data", { method: "POST" });

export const exportData = () =>
  request<{ url: string }>("/api/system/export", { method: "POST" });

export const shutDown = () =>
  request<{ ok: boolean }>("/api/system/shutdown", { method: "POST" });

export const runPatch = (script: string) =>
  request<{ ok: boolean; output: string; exitCode?: number }>(
    "/dashboard-api/maintenance/run",
    {
      method: "POST",
      body: JSON.stringify({ script }),
    },
  );

/* ------------------------------------------------------------------ */
/*  Recovery                                                          */
/* ------------------------------------------------------------------ */

export interface RecoveryArtifact {
  name: string;
  type: string;
  sha256: string;
  bytes: number;
  remotePath: string;
}

export interface RecoveryManifest {
  version: number;
  runId: string;
  mode: string;
  deployId: string;
  timestamp: string;
  targetUrl: string;
  provider: string;
  nativeProvider: string;
  bucket: string;
  prefix: string;
  includeStorage: string;
  hostname: string;
  artifacts: RecoveryArtifact[];
}

export interface RecoveryBackupRun {
  id: string;
  mode: string;
  status: string;
  source: string;
  provider: string;
  nativeProvider: string;
  cloudProvider: string;
  bucket: string;
  prefix: string;
  archiveRoot: string;
  startedAt: string;
  updatedAt: string;
  error: string;
  catalogStatus: string;
  catalogMessage: string;
  remoteManifestPath: string;
  restoreEligible: boolean;
  restoreBlockedReason: string;
  manifestAvailable: boolean;
  artifactCount: number;
  totalBytes: number;
}

export interface RecoveryOverview {
  stateDir: string;
  readable: boolean;
  status: "healthy" | "empty" | "unavailable";
  message: string;
  catalogStatus: string;
  catalogMessage: string;
  latestRun: RecoveryBackupRun | null;
  backups: RecoveryBackupRun[];
  latestRestore: RecoveryRestoreRun | null;
  restores: RecoveryRestoreRun[];
}

export interface RecoveryPreview {
  backup: RecoveryBackupRun;
  manifest: RecoveryManifest | null;
  restorePlan: string[];
}

export interface RecoveryRestoreRun {
  id: string;
  backupRunId: string;
  status: string;
  mode: string;
  productionOverwrite: boolean;
  logPath: string;
  message: string;
  error: string;
  updatedAt: string;
}

export interface RecoveryArtifactChange {
  name: string;
  type: string;
  change: "added" | "removed" | "changed" | "unchanged";
  beforeSha256: string;
  afterSha256: string;
  beforeBytes: number;
  afterBytes: number;
  beforeRemotePath: string;
  afterRemotePath: string;
}

export interface RecoveryMergePreview {
  runId: string;
  baselineRunId: string;
  baselineLabel: string;
  destructive: boolean;
  summary: string;
  artifactChanges: RecoveryArtifactChange[];
  manifestDiff: string;
  decision: {
    action: "record-merge-request";
    label: string;
  };
}

export interface RestorePlaceholderResult {
  ok: boolean;
  placeholder: boolean;
  destructive?: boolean;
  started?: boolean;
  executorPid?: number;
  restoreRunId: string;
  runId: string;
  message: string;
}

export interface RecoveryRestoreRequestOptions {
  mergeReviewed?: boolean;
  confirmation?: string;
}

export const fetchRecoveryOverview = () =>
  request<RecoveryOverview>("/dashboard-api/recovery");

export const fetchRecoveryPreview = (runId: string) => {
  const qs = new URLSearchParams({ runId });
  return request<RecoveryPreview>(`/dashboard-api/recovery/preview?${qs}`);
};

export const fetchRecoveryMergePreview = (runId: string) => {
  const qs = new URLSearchParams({ runId });
  return request<RecoveryMergePreview>(`/dashboard-api/recovery/merge?${qs}`);
};

export const requestRecoveryRestore = (
  runId: string,
  mode: "full" | "merge" = "full",
  options: RecoveryRestoreRequestOptions = {},
) =>
  request<RestorePlaceholderResult>("/dashboard-api/recovery/restore", {
    method: "POST",
    body: JSON.stringify({ runId, mode, ...options }),
  });

/* ------------------------------------------------------------------ */
/*  First-run AI setup                                                 */
/* ------------------------------------------------------------------ */

/** Check which AI providers need setup (consumer login) */
export const fetchSetupStatus = () =>
  request<{
    setupRequired: boolean;
    providers: {
      id: string;
      name: string;
      authMethod: "consumer" | "api_key";
      connected: boolean;
    }[];
  }>("/dashboard-api/setup/status");

export interface ProviderConnectSession {
  id: string;
  provider: "openai" | "anthropic";
  status:
    | "idle"
    | "running"
    | "awaiting_input"
    | "completed"
    | "error"
    | "cancelled";
  url: string;
  logs: string;
  inputLabel: string;
  inputPlaceholder: string;
  startedAt: number;
  finishedAt: number;
}

export const startProviderConnect = (provider: "openai" | "anthropic") =>
  request<{ success: boolean; session: ProviderConnectSession | null }>(
    `/dashboard-api/providers/${provider}/connect/start`,
    {
      method: "POST",
    },
  );

export const submitProviderConnect = (
  provider: "openai" | "anthropic",
  input: string,
) =>
  request<{ success: boolean; session: ProviderConnectSession | null }>(
    `/dashboard-api/providers/${provider}/connect/submit`,
    {
      method: "POST",
      body: JSON.stringify({ input }),
    },
  );

export const fetchProviderConnectSession = (
  provider: "openai" | "anthropic",
) =>
  request<{ success: boolean; session: ProviderConnectSession | null }>(
    `/dashboard-api/providers/${provider}/connect/session`,
  );

export const cancelProviderConnect = (provider: "openai" | "anthropic") =>
  request<{ success: boolean; session: ProviderConnectSession | null }>(
    `/dashboard-api/providers/${provider}/connect/cancel`,
    {
      method: "POST",
    },
  );

/** Mark first-run setup as complete */
export const completeSetup = () =>
  request<{ ok: boolean }>("/dashboard-api/setup/complete", {
    method: "POST",
  });

/* ------------------------------------------------------------------ */
/*  Supabase Storage                                                   */
/* ------------------------------------------------------------------ */

/** Get a signed URL for a file stored in the deployment's storage bucket */
export const getStorageSignedUrl = (storagePath: string) => {
  const params = new URLSearchParams({ path: storagePath });
  return request<{ signedUrl: string }>(
    `/dashboard-api/storage?${params}`,
  );
};

/* ------------------------------------------------------------------ */
/*  KMS / Secret Providers                                             */
/* ------------------------------------------------------------------ */

export interface SecretProviderInfo {
  id: "env" | "doppler" | "aws-sm" | "gcp-sm" | "azure-kv";
  name: string;
  configured: boolean;
  selected?: boolean;
  cloudNative?: boolean;
}

/** List which KMS providers are configured */
export const fetchSecretProviders = () =>
  request<{
    providers: SecretProviderInfo[];
    secretManagement?: {
      selection: string;
      effectiveProvider: string;
      cloudNativeProvider: string | null;
      supportedProviders: string[];
    };
  }>(
    "/dashboard-api/secrets/providers",
  );

/** Validate (and optionally resolve) a secret reference */
export const validateSecretRef = (value: string, resolve = false) =>
  request<{
    valid: boolean;
    isRef?: boolean;
    scheme?: string;
    resolved?: boolean;
    error?: string;
  }>("/dashboard-api/secrets/validate", {
    method: "POST",
    body: JSON.stringify({ value, resolve }),
  });

/** Get detailed KMS credential status + field definitions */
export const fetchKmsConfig = () =>
  request<{
    providers: Record<
      string,
      {
        configured: boolean;
        source: "dashboard" | "environment" | "none";
        fields: Record<string, { set: boolean; masked?: string }>;
      }
    >;
    fields: Record<
      string,
      { key: string; label: string; placeholder: string; secret?: boolean }[]
    >;
  }>("/dashboard-api/secrets/configure");

/** Save KMS provider credentials */
export const saveKmsCredentials = (
  providerId: string,
  credentials: Record<string, string>,
) =>
  request<{ ok: boolean }>("/dashboard-api/secrets/configure", {
    method: "POST",
    body: JSON.stringify({ providerId, credentials }),
  });

/** Remove saved KMS provider credentials */
export const removeKmsCredentials = (providerId: string) =>
  request<{ ok: boolean }>("/dashboard-api/secrets/configure", {
    method: "DELETE",
    body: JSON.stringify({ providerId }),
  });
