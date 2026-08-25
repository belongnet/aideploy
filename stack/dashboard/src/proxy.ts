import { NextRequest, NextResponse } from "next/server";

const AUTH_COOKIE = "aideploy_dash_auth";
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function secureEquals(provided: string, expected: string): boolean {
  if (!provided || !expected || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function bearerToken(request: NextRequest): string {
  const value = request.headers.get("authorization")?.trim() ?? "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function dashboardToken(): string {
  return process.env.DASHBOARD_TOKEN?.trim() ?? "";
}

function bootstrapToken(): string {
  return process.env.DASHBOARD_BOOTSTRAP_TOKEN?.trim() ?? "";
}

function authorizedByHeader(request: NextRequest, token: string): boolean {
  const candidates = [
    request.headers.get("x-aideploy-dashboard-token")?.trim() ?? "",
    bearerToken(request),
  ];
  return candidates.some((candidate) => secureEquals(candidate, token));
}

function authorizedByCookie(request: NextRequest, token: string): boolean {
  return secureEquals(request.cookies.get(AUTH_COOKIE)?.value.trim() ?? "", token);
}

function jsonResponse(status: number, error: string): NextResponse {
  return withSecurityHeaders(NextResponse.json({ error }, { status }));
}

function htmlResponse(status: number, title: string, body: string): NextResponse {
  return withSecurityHeaders(
    new NextResponse(
      `<!doctype html><html><body style="font-family:sans-serif;padding:24px"><h2>${title}</h2><p>${body}</p></body></html>`,
      {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    ),
  );
}

function withSecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/dashboard-api/");
}

function isAllowedUnauthenticatedPath(pathname: string): boolean {
  return pathname === "/bootstrap" || pathname === "/api/healthz";
}

function originMatchesHost(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

function isSecureRequest(request: NextRequest): boolean {
  const forwardedProto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() ??
    "";
  return forwardedProto === "https" || request.nextUrl.protocol === "https:";
}

function requireSameOriginForCookieWrite(request: NextRequest): NextResponse | null {
  if (!WRITE_METHODS.has(request.method)) return null;
  if (!authorizedByCookie(request, dashboardToken())) return null;
  if (authorizedByHeader(request, dashboardToken())) return null;
  return originMatchesHost(request)
    ? null
    : jsonResponse(403, "CSRF check failed");
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = dashboardToken();

  if (pathname === "/bootstrap") {
    if (!token || !bootstrapToken()) {
      return htmlResponse(
        503,
        "Dashboard unavailable",
        "Dashboard bootstrap is not configured on this server.",
      );
    }
    if (authorizedByCookie(request, token)) {
      return withSecurityHeaders(NextResponse.redirect(new URL("/", request.url)));
    }
    const providedToken = request.nextUrl.searchParams.get("token")?.trim() ?? "";
    if (!secureEquals(providedToken, bootstrapToken())) {
      return htmlResponse(401, "Unauthorized", "This dashboard link is invalid.");
    }

    const response = withSecurityHeaders(NextResponse.redirect(new URL("/", request.url)));
    response.cookies.set(AUTH_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecureRequest(request),
      path: "/",
    });
    return response;
  }

  if (isAllowedUnauthenticatedPath(pathname)) {
    return withSecurityHeaders(NextResponse.next());
  }

  if (!token) {
    if (isApiPath(pathname)) {
      return jsonResponse(503, "Dashboard authentication is not configured");
    }
    return htmlResponse(
      503,
      "Dashboard unavailable",
      "Dashboard authentication is not configured on this server.",
    );
  }

  if (!authorizedByCookie(request, token) && !authorizedByHeader(request, token)) {
    if (isApiPath(pathname)) return jsonResponse(401, "Unauthorized");
    return htmlResponse(
      401,
      "Unauthorized",
      "Open this dashboard from the secure deploy link.",
    );
  }

  const csrfResponse = requireSameOriginForCookieWrite(request);
  if (csrfResponse) return csrfResponse;

  return withSecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
