import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { NextRequest, type NextResponse } from "next/server";

import { config, proxy } from "./proxy";

const AUTH_COOKIE = "aideploy_dash_auth";
const ORIGINAL_DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
const ORIGINAL_BOOTSTRAP_TOKEN = process.env.DASHBOARD_BOOTSTRAP_TOKEN;
type NextRequestInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;

function restoreEnvironment(): void {
  if (ORIGINAL_DASHBOARD_TOKEN === undefined) {
    delete process.env.DASHBOARD_TOKEN;
  } else {
    process.env.DASHBOARD_TOKEN = ORIGINAL_DASHBOARD_TOKEN;
  }
  if (ORIGINAL_BOOTSTRAP_TOKEN === undefined) {
    delete process.env.DASHBOARD_BOOTSTRAP_TOKEN;
  } else {
    process.env.DASHBOARD_BOOTSTRAP_TOKEN = ORIGINAL_BOOTSTRAP_TOKEN;
  }
}

afterEach(restoreEnvironment);

function configureTokens(): void {
  process.env.DASHBOARD_TOKEN = "dashboard-secret";
  process.env.DASHBOARD_BOOTSTRAP_TOKEN = "bootstrap-secret";
}

function makeRequest(
  path: string,
  init: NextRequestInit = {},
  baseUrl = "https://dashboard.test",
): NextRequest {
  const url = new URL(path, baseUrl);
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", url.host);
  return new NextRequest(url, { ...init, headers });
}

function assertSecurityHeaders(response: NextResponse): void {
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
}

test("health checks bypass authentication but retain security headers", () => {
  delete process.env.DASHBOARD_TOKEN;
  delete process.env.DASHBOARD_BOOTSTRAP_TOKEN;

  const response = proxy(makeRequest("/api/healthz"));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
  assertSecurityHeaders(response);
});

test("missing dashboard configuration fails closed for pages and APIs", async () => {
  delete process.env.DASHBOARD_TOKEN;
  delete process.env.DASHBOARD_BOOTSTRAP_TOKEN;

  const pageResponse = proxy(makeRequest("/"));
  const apiResponse = proxy(makeRequest("/dashboard-api/status"));

  assert.equal(pageResponse.status, 503);
  assert.match(await pageResponse.text(), /authentication is not configured/i);
  assert.equal(apiResponse.status, 503);
  assert.deepEqual(await apiResponse.json(), {
    error: "Dashboard authentication is not configured",
  });
  assertSecurityHeaders(pageResponse);
  assertSecurityHeaders(apiResponse);
});

test("bootstrap fails closed when it is unconfigured or invalid", async () => {
  process.env.DASHBOARD_TOKEN = "dashboard-secret";
  delete process.env.DASHBOARD_BOOTSTRAP_TOKEN;

  const unconfigured = proxy(makeRequest("/bootstrap?token=bootstrap-secret"));
  assert.equal(unconfigured.status, 503);

  process.env.DASHBOARD_BOOTSTRAP_TOKEN = "bootstrap-secret";
  const invalid = proxy(makeRequest("/bootstrap?token=wrong"));
  assert.equal(invalid.status, 401);
  assert.match(await invalid.text(), /link is invalid/i);
});

test("valid bootstrap creates a secure authentication cookie and redirects", () => {
  configureTokens();

  const response = proxy(
    makeRequest(
      "/bootstrap?token=bootstrap-secret",
      { headers: { "x-forwarded-proto": "https" } },
      "http://dashboard.test",
    ),
  );

  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://dashboard.test/");
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, new RegExp(`${AUTH_COOKIE}=dashboard-secret`, "i"));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /Path=\//i);
  assertSecurityHeaders(response);
});

test("an authenticated bootstrap request redirects without replacing its cookie", () => {
  configureTokens();

  const response = proxy(
    makeRequest("/bootstrap?token=wrong", {
      headers: { cookie: `${AUTH_COOKIE}=dashboard-secret` },
    }),
  );

  assert.equal(response.status, 307);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("header, bearer, and cookie authentication are accepted", () => {
  configureTokens();

  const headerResponse = proxy(
    makeRequest("/", {
      headers: { "x-aideploy-dashboard-token": "dashboard-secret" },
    }),
  );
  const bearerResponse = proxy(
    makeRequest("/", {
      headers: { authorization: "Bearer dashboard-secret" },
    }),
  );
  const cookieResponse = proxy(
    makeRequest("/", {
      headers: { cookie: `${AUTH_COOKIE}=dashboard-secret` },
    }),
  );

  for (const response of [headerResponse, bearerResponse, cookieResponse]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-middleware-next"), "1");
    assertSecurityHeaders(response);
  }
});

test("unauthenticated pages and APIs return the appropriate 401 response", async () => {
  configureTokens();

  const pageResponse = proxy(makeRequest("/settings"));
  const apiResponse = proxy(makeRequest("/api/settings"));

  assert.equal(pageResponse.status, 401);
  assert.match(pageResponse.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(apiResponse.status, 401);
  assert.deepEqual(await apiResponse.json(), { error: "Unauthorized" });
});

test("cookie-authenticated writes enforce same-origin requests", async () => {
  configureTokens();
  const cookie = `${AUTH_COOKIE}=dashboard-secret`;

  const sameOrigin = proxy(
    makeRequest("/api/settings", {
      method: "POST",
      headers: { cookie, origin: "https://dashboard.test" },
    }),
  );
  const crossOrigin = proxy(
    makeRequest("/api/settings", {
      method: "POST",
      headers: { cookie, origin: "https://evil.test" },
    }),
  );
  const headerAuthenticated = proxy(
    makeRequest("/api/settings", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://evil.test",
        "x-aideploy-dashboard-token": "dashboard-secret",
      },
    }),
  );

  assert.equal(sameOrigin.status, 200);
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), { error: "CSRF check failed" });
  assert.equal(headerAuthenticated.status, 200);
});

test("the proxy matcher excludes only public framework assets", () => {
  assert.deepEqual(config.matcher, [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ]);
});
