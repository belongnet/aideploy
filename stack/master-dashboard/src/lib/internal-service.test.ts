import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentInternalUrl,
  buildInternalServiceBaseUrlFromHostPort,
  isInternalServiceHost,
  resolveAgentInternalHost,
} from "./internal-service";

test("isInternalServiceHost allows only internal service hosts", () => {
  assert.equal(isInternalServiceHost("agent-1"), true);
  assert.equal(isInternalServiceHost("openclaw-gateway"), true);
  assert.equal(isInternalServiceHost("host.docker.internal"), true);
  assert.equal(isInternalServiceHost("127.0.0.1"), true);
  assert.equal(isInternalServiceHost("172.20.0.5"), true);
  assert.equal(isInternalServiceHost("::1"), true);

  assert.equal(isInternalServiceHost("api.example.com"), false);
  assert.equal(isInternalServiceHost("8.8.8.8"), false);
});

test("buildInternalServiceBaseUrlFromHostPort rejects public or malformed targets", () => {
  assert.equal(
    buildInternalServiceBaseUrlFromHostPort("agent-1", 8101),
    "http://agent-1:8101",
  );

  assert.throws(
    () => buildInternalServiceBaseUrlFromHostPort("api.example.com", 8101),
    /internal host/,
  );
  assert.throws(
    () => buildInternalServiceBaseUrlFromHostPort("agent-1/path", 8101),
    /host is invalid/,
  );
  assert.throws(
    () => buildInternalServiceBaseUrlFromHostPort("agent-1", 70000),
    /port is invalid/,
  );
});

test("resolveAgentInternalHost validates rendered templates", () => {
  assert.equal(resolveAgentInternalHost("agent-{index1}", 8101), "agent-1");
  assert.equal(resolveAgentInternalHost("agent-{index0}", 8102), "agent-1");

  assert.throws(
    () => resolveAgentInternalHost("api.example.com", 8101),
    /internal host/,
  );
  assert.throws(
    () => resolveAgentInternalHost("agent-{index1}/path", 8101),
    /internal host/,
  );
});

test("buildAgentInternalUrl preserves path as an internal URL", () => {
  assert.equal(
    buildAgentInternalUrl("agent-{index1}", 8101, "/health"),
    "http://agent-1:8101/health",
  );
  assert.equal(
    buildAgentInternalUrl("agent-{index1}", 8102, "api/status"),
    "http://agent-2:8102/api/status",
  );
});
