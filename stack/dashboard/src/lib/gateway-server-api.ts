import {
  normalizeInternalServiceBaseUrl,
  buildServiceRequestHeaders,
  normalizeInternalPath,
} from "./internal-request";

const GATEWAY_INTERNAL_URL = process.env.GATEWAY_INTERNAL_URL || "";
const AGENT_SERVICE_TOKEN = process.env.AGENT_SERVICE_TOKEN || "";

function gatewayUrl(path: string): string {
  if (!GATEWAY_INTERNAL_URL) {
    throw new Error("Gateway internal URL is not configured");
  }

  const normalized = normalizeInternalPath(path);
  const url = new URL(
    normalized,
    `${normalizeInternalServiceBaseUrl(
      GATEWAY_INTERNAL_URL,
      "Gateway internal URL",
    )}/`,
  );
  return url.toString();
}

export async function gatewayRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { headers: initHeaders, ...fetchInit } = init ?? {};
  const response = await fetch(gatewayUrl(path), {
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
          : raw || `Gateway API ${response.status}`;
    throw new Error(detail);
  }

  return data as T;
}
