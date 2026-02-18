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
  }>("/api/setup/status");

/** Submit a consumer session token for a provider (stored locally in Postgres) */
export const submitProviderToken = (
  provider: string,
  token: string
) =>
  request<{ ok: boolean; connectedAs?: string }>("/api/setup/connect", {
    method: "POST",
    body: JSON.stringify({ provider, token }),
  });

/** Mark first-run setup as complete */
export const completeSetup = () =>
  request<{ ok: boolean }>("/api/setup/complete", { method: "POST" });
