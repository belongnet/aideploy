import { NextResponse } from "next/server";

const DEFAULT_JSON_BODY_LIMIT_BYTES = 64 * 1024;

export class RequestBodyError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
    this.code = code;
  }
}

function maxJsonBodyBytes(): number {
  const raw = process.env.AIDEPLOY_DASHBOARD_JSON_MAX_BODY_BYTES;
  if (!raw) return DEFAULT_JSON_BODY_LIMIT_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_JSON_BODY_LIMIT_BYTES;
}

function assertContentLength(request: Request, maxBytes: number) {
  const raw = request.headers.get("content-length");
  if (raw === null) return;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new RequestBodyError("Invalid Content-Length header.", 400, "INVALID_CONTENT_LENGTH");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maxBytes) {
    throw new RequestBodyError("Request body is too large.", 413, "REQUEST_BODY_TOO_LARGE");
  }
}

export async function readJsonBody<T = unknown>(request: Request): Promise<T> {
  const maxBytes = maxJsonBodyBytes();
  assertContentLength(request, maxBytes);
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) {
    throw new RequestBodyError("Request body is too large.", 413, "REQUEST_BODY_TOO_LARGE");
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    throw new RequestBodyError("Invalid JSON body.", 400, "INVALID_JSON");
  }
}

export function requestBodyErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof RequestBodyError)) return null;
  return NextResponse.json(
    { error: error.message, code: error.code },
    { status: error.status },
  );
}
