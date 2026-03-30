const AGENT_HOST = process.env.AGENT_HOST || "agent-1";
const AGENT_PORT = process.env.AGENT_PORT || "8101";
const AGENT_SERVICE_TOKEN = process.env.AGENT_SERVICE_TOKEN || "";

function agentUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`http://${AGENT_HOST}:${AGENT_PORT}${normalized}`);
  if (AGENT_SERVICE_TOKEN) {
    url.searchParams.set("oc_service_token", AGENT_SERVICE_TOKEN);
  }
  return url.toString();
}

export async function agentRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(agentUrl(path), {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    ...init,
  });

  const raw = await response.text();
  const data = raw ? JSON.parse(raw) : null;
  if (!response.ok) {
    const detail =
      data && typeof data.detail === "string"
        ? data.detail
        : data && typeof data.error === "string"
          ? data.error
          : raw || `Agent API ${response.status}`;
    throw new Error(detail);
  }

  return data as T;
}
