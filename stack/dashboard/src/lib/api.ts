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

export const fetchTasks = () =>
  request<
    {
      id: string;
      name: string;
      description: string;
      trigger: string;
      action: string;
      enabled: boolean;
      lastRun: string | null;
      runCount: number;
    }[]
  >("/api/tasks");

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

export const fetchConfig = () =>
  request<{
    name: string;
    personality: string;
    modelProvider: string;
    model: string;
    authMethod: string;
    connectedAs: string | null;
    pruneEnabled: boolean;
    pruneAfterDays: number;
    pruneKeepStarred: boolean;
    serverInfo: {
      ip: string;
      tailscaleIp: string;
      provider: string;
      region: string;
    };
  }>("/api/config");

export const updateConfig = (
  updates: Record<string, unknown>
) =>
  request<{ ok: boolean }>("/api/config", {
    method: "PATCH",
    body: JSON.stringify(updates),
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
}

/** List which KMS providers are configured */
export const fetchSecretProviders = () =>
  request<{ providers: SecretProviderInfo[] }>(
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
