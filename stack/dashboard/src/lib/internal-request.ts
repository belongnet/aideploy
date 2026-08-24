import net from "node:net";

function isPrivateOrReservedIpv4(host: string): boolean {
  const octets = host.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isPrivateOrReservedIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    return net.isIP(mapped) === 4 && isPrivateOrReservedIpv4(mapped);
  }
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80") ||
    lower.startsWith("ff") ||
    lower.startsWith("2001:db8")
  );
}

export function isInternalServiceHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return false;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home")
  ) {
    return true;
  }

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return isPrivateOrReservedIpv4(host);
  if (ipVersion === 6) return isPrivateOrReservedIpv6(host);

  return !host.includes(".");
}

export function normalizeInternalServiceBaseUrl(
  raw: string,
  label = "Internal service URL",
): string {
  let url: URL;
  try {
    url = new URL(raw.endsWith("/") ? raw : `${raw}/`);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials`);
  }
  if (url.search || url.hash) {
    throw new Error(`${label} must not include query or fragment`);
  }
  if (!isInternalServiceHost(url.hostname)) {
    throw new Error(`${label} must target an internal host`);
  }
  return url.toString().replace(/\/+$/, "");
}

export function buildInternalServiceBaseUrlFromHostPort(
  host: string,
  port: string,
  label = "Internal service URL",
): string {
  const cleanHost = host.trim();
  const cleanPort = port.trim();
  if (!cleanHost || /[\s/@?#\\]/.test(cleanHost)) {
    throw new Error(`${label} host is invalid`);
  }
  if (!/^\d{1,5}$/.test(cleanPort)) {
    throw new Error(`${label} port is invalid`);
  }
  const parsedPort = Number.parseInt(cleanPort, 10);
  if (parsedPort < 1 || parsedPort > 65535) {
    throw new Error(`${label} port is invalid`);
  }
  return normalizeInternalServiceBaseUrl(
    `http://${cleanHost}:${parsedPort}`,
    label,
  );
}

export function normalizeInternalPath(path: string): string {
  const trimmed = path.trim();
  return `/${trimmed.replace(/^\/+/, "")}`;
}

export function buildServiceRequestHeaders(
  initHeaders: HeadersInit | undefined,
  serviceToken: string,
): Headers {
  const headers = new Headers(initHeaders);

  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (serviceToken) {
    headers.set("X-OpenClaw-Service-Token", serviceToken);
  }

  return headers;
}
