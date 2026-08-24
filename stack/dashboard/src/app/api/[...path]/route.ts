import { NextRequest, NextResponse } from "next/server";
import { buildInternalServiceBaseUrlFromHostPort } from "@/lib/internal-request";

const AGENT_HOST = process.env.AGENT_HOST || "agent-1";
const AGENT_PORT = process.env.AGENT_PORT || "8101";
const AGENT_SERVICE_TOKEN = process.env.AGENT_SERVICE_TOKEN || "";
const MAX_PROXY_BODY_BYTES = 1024 * 1024;
const AGENT_BASE_URL = buildInternalServiceBaseUrlFromHostPort(
  AGENT_HOST,
  AGENT_PORT,
  "Agent internal URL",
);

type RouteParams = { path?: string[] };
type RouteContext = { params: Promise<RouteParams> };

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "user-agent",
]);

function buildAgentUrl(request: NextRequest, pathParts: string[]): string {
  const safePath = pathParts.map((part) => encodeURIComponent(part)).join("/");
  const url = new URL(`/api/${safePath}`, `${AGENT_BASE_URL}/`);
  request.nextUrl.searchParams.forEach((value, key) => {
    if (key !== "oc_service_token") url.searchParams.append(key, value);
  });
  return url.toString();
}

function buildForwardHeaders(request: NextRequest): Headers {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerKey)) return;
    if (!FORWARDED_REQUEST_HEADERS.has(lowerKey)) return;
    headers.set(key, value);
  });
  if (AGENT_SERVICE_TOKEN) {
    headers.set("X-OpenClaw-Service-Token", AGENT_SERVICE_TOKEN);
  }
  return headers;
}

function buildResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  return headers;
}

async function readBoundedBody(request: NextRequest): Promise<ArrayBuffer | undefined> {
  const contentLength = request.headers.get("content-length")?.trim() ?? "";
  if (contentLength) {
    if (!/^\d+$/.test(contentLength)) {
      throw new Error("Invalid Content-Length");
    }
    const parsedLength = Number.parseInt(contentLength, 10);
    if (!Number.isSafeInteger(parsedLength)) {
      throw new Error("Invalid Content-Length");
    }
    if (parsedLength > MAX_PROXY_BODY_BYTES) {
      throw new RangeError("Request body too large");
    }
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_PROXY_BODY_BYTES) {
    throw new RangeError("Request body too large");
  }
  return body.byteLength > 0 ? body : undefined;
}

async function proxyToAgent(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const method = request.method.toUpperCase();
  const canHaveBody = method !== "GET" && method !== "HEAD";
  let body: ArrayBuffer | undefined;

  try {
    body = canHaveBody ? await readBoundedBody(request) : undefined;
  } catch (error) {
    const status = error instanceof RangeError ? 413 : 400;
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Invalid request body",
      },
      { status },
    );
  }

  try {
    const upstream = await fetch(buildAgentUrl(request, params.path || []), {
      method,
      headers: buildForwardHeaders(request),
      body,
      cache: "no-store",
    });
    const payload = await upstream.arrayBuffer();
    return new NextResponse(payload, {
      status: upstream.status,
      headers: buildResponseHeaders(upstream),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not reach the agent API",
      },
      { status: 502 },
    );
  }
}

export const GET = proxyToAgent;
export const POST = proxyToAgent;
export const PUT = proxyToAgent;
export const PATCH = proxyToAgent;
export const DELETE = proxyToAgent;
