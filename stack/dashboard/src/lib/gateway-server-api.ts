const GATEWAY_INTERNAL_URL = process.env.GATEWAY_INTERNAL_URL || "";
const AGENT_SERVICE_TOKEN = process.env.AGENT_SERVICE_TOKEN || "";

function gatewayUrl(path: string): string {
  if (!GATEWAY_INTERNAL_URL) {
    throw new Error("Gateway internal URL is not configured");
  }

  const normalized = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(normalized, GATEWAY_INTERNAL_URL.endsWith("/")
    ? GATEWAY_INTERNAL_URL
    : `${GATEWAY_INTERNAL_URL}/`);
  if (AGENT_SERVICE_TOKEN) {
    url.searchParams.set("oc_service_token", AGENT_SERVICE_TOKEN);
  }
  return url.toString();
}

export async function gatewayRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(gatewayUrl(path), {
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
          : raw || `Gateway API ${response.status}`;
    throw new Error(detail);
  }

  return data as T;
}
