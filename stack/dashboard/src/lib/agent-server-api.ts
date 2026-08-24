import {
  buildInternalServiceBaseUrlFromHostPort,
  buildServiceRequestHeaders,
  normalizeInternalPath,
} from "./internal-request";

const AGENT_HOST = process.env.AGENT_HOST || "agent-1";
const AGENT_PORT = process.env.AGENT_PORT || "8101";
const AGENT_SERVICE_TOKEN = process.env.AGENT_SERVICE_TOKEN || "";
const AGENT_BASE_URL = buildInternalServiceBaseUrlFromHostPort(
  AGENT_HOST,
  AGENT_PORT,
  "Agent internal URL",
);

function agentUrl(path: string): string {
  const normalized = normalizeInternalPath(path);
  return new URL(normalized, `${AGENT_BASE_URL}/`).toString();
}

export async function agentRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { headers: initHeaders, ...fetchInit } = init ?? {};
  const response = await fetch(agentUrl(path), {
    ...fetchInit,
    headers: buildServiceRequestHeaders(initHeaders, AGENT_SERVICE_TOKEN),
    cache: "no-store",
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
