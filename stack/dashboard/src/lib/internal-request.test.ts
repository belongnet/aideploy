import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInternalServiceBaseUrlFromHostPort,
  buildServiceRequestHeaders,
  isInternalServiceHost,
  normalizeInternalServiceBaseUrl,
  normalizeInternalPath,
} from "./internal-request";

test("normalizeInternalPath treats absolute-looking input as an internal path", () => {
  assert.equal(normalizeInternalPath("/api/status"), "/api/status");
  assert.equal(normalizeInternalPath("api/status"), "/api/status");
  assert.equal(normalizeInternalPath("//evil.example/api/status"), "/evil.example/api/status");
});

test("isInternalServiceHost allows only loopback, private, and Docker-style hosts", () => {
  assert.equal(isInternalServiceHost("agent-1"), true);
  assert.equal(isInternalServiceHost("openclaw-gateway"), true);
  assert.equal(isInternalServiceHost("host.docker.internal"), true);
  assert.equal(isInternalServiceHost("127.0.0.1"), true);
  assert.equal(isInternalServiceHost("172.20.0.5"), true);
  assert.equal(isInternalServiceHost("::1"), true);

  assert.equal(isInternalServiceHost("api.example.com"), false);
  assert.equal(isInternalServiceHost("8.8.8.8"), false);
});

test("normalizeInternalServiceBaseUrl rejects token-exfiltration targets", () => {
  assert.equal(
    normalizeInternalServiceBaseUrl("http://openclaw-gateway:18789/"),
    "http://openclaw-gateway:18789",
  );
  assert.equal(
    normalizeInternalServiceBaseUrl("https://host.docker.internal:18790"),
    "https://host.docker.internal:18790",
  );

  assert.throws(
    () => normalizeInternalServiceBaseUrl("https://api.example.com"),
    /internal host/,
  );
  assert.throws(
    () => normalizeInternalServiceBaseUrl("https://user:pass@openclaw-gateway"),
    /credentials/,
  );
  assert.throws(
    () => normalizeInternalServiceBaseUrl("file:///etc/passwd"),
    /HTTP or HTTPS/,
  );
  assert.throws(
    () => normalizeInternalServiceBaseUrl("http://openclaw-gateway?token=abc"),
    /query or fragment/,
  );
});

test("buildInternalServiceBaseUrlFromHostPort validates host and port inputs", () => {
  assert.equal(
    buildInternalServiceBaseUrlFromHostPort("agent-1", "8101"),
    "http://agent-1:8101",
  );

  assert.throws(
    () => buildInternalServiceBaseUrlFromHostPort("api.example.com", "8101"),
    /internal host/,
  );
  assert.throws(
    () => buildInternalServiceBaseUrlFromHostPort("agent-1/path", "8101"),
    /host is invalid/,
  );
  assert.throws(
    () => buildInternalServiceBaseUrlFromHostPort("agent-1", "70000"),
    /port is invalid/,
  );
});

test("buildServiceRequestHeaders preserves content type and makes the service token authoritative", () => {
  const headers = buildServiceRequestHeaders(
    {
      "Content-Type": "text/plain",
      "X-OpenClaw-Service-Token": "caller-controlled",
    },
    "trusted-service-token",
  );

  assert.equal(headers.get("Content-Type"), "text/plain");
  assert.equal(
    headers.get("X-OpenClaw-Service-Token"),
    "trusted-service-token",
  );
});

test("buildServiceRequestHeaders defaults JSON content type", () => {
  const headers = buildServiceRequestHeaders(undefined, "");

  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.has("X-OpenClaw-Service-Token"), false);
});
