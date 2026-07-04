import assert from "node:assert/strict";
import test from "node:test";

test("secret provider API host classifier rejects private and reserved hosts", async () => {
  const { isPrivateOrReservedSecretApiHost } = await import("./secret-resolver");

  for (const host of [
    "localhost",
    "metadata.google.internal",
    "127.0.0.1",
    "10.0.0.5",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.10",
    "198.51.100.10",
    "203.0.113.10",
    "::1",
    "fc00::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateOrReservedSecretApiHost(host), true, host);
  }

  assert.equal(isPrivateOrReservedSecretApiHost("api.doppler.com"), false);
  assert.equal(
    isPrivateOrReservedSecretApiHost("secretmanager.googleapis.com"),
    false,
  );
});

test("trustedSecretApiBase rejects unsafe bearer-token destinations", async () => {
  const { trustedSecretApiBase } = await import("./secret-resolver");

  assert.equal(
    trustedSecretApiBase("https://api.doppler.com/v3/", "DOPPLER_API_BASE"),
    "https://api.doppler.com/v3",
  );
  for (const url of [
    "http://api.doppler.com/v3",
    "https://user:pass@api.doppler.com/v3",
    "https://100.64.0.5/v3",
    "https://metadata.google.internal/v3",
    "https://api.doppler.com/v3?token=abc",
  ]) {
    assert.throws(
      () => trustedSecretApiBase(url, "DOPPLER_API_BASE"),
      /DOPPLER_API_BASE must be an https URL on a public provider host/,
    );
  }
});
