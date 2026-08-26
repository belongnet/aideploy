import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helper = join(cliRoot, 'scripts/tailscale-e2e-auth-key.sh');
// Provider-shaped fake keys trigger GitHub secret-scanning alerts even when
// they are deliberately invalid, so keep this lifecycle fixture unambiguous.
const fakeAuthKey = 'tskey-test-fixture';

describe('Tailscale E2E key lifecycle', () => {
  let temp: string;

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'aideploy-tailscale-helper-'));
    const curl = join(temp, 'curl');
    writeFileSync(
      curl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_CURL_LOG"
if [[ "$*" == *'/oauth/token'* ]]; then
  printf '{"access_token":"oauth-test-token"}'
elif [[ "$*" == *'-X DELETE'* ]]; then
  printf '{}'
else
  printf '{"id":"key-123","key":"${fakeAuthKey}"}'
fi
`
    );
    chmodSync(curl, 0o755);
  });

  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  it('exports the cleanup id before the masked key and revokes it', () => {
    expect(fakeAuthKey).toMatch(/^tskey-/);
    expect(fakeAuthKey).not.toMatch(/^tskey-(?:auth|api)-/);
    const output = join(temp, 'github-output');
    const keyIdFile = join(temp, 'cleanup', 'tailscale-key-id');
    const curlLog = join(temp, 'curl.log');
    const env = {
      ...process.env,
      PATH: `${temp}${delimiter}${process.env.PATH ?? ''}`,
      GITHUB_OUTPUT: output,
      TAILSCALE_KEY_ID_FILE: keyIdFile,
      FAKE_CURL_LOG: curlLog,
      TS_OAUTH_CLIENT_ID: 'client-id',
      TS_OAUTH_CLIENT_SECRET: 'client-secret',
    };
    const mint = spawnSync('bash', [helper, 'mint'], { env, encoding: 'utf8' });
    expect(mint.status).toBe(0);
    expect(mint.stdout).toContain(`::add-mask::${fakeAuthKey}`);
    expect(readFileSync(output, 'utf8')).toBe(`key_id=key-123\nauth_key=${fakeAuthKey}\n`);
    expect(readFileSync(keyIdFile, 'utf8')).toBe('key-123\n');
    expect(statSync(keyIdFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(curlLog, 'utf8')).toContain('"keyType":"auth"');

    const revoke = spawnSync('bash', [helper, 'revoke', 'key-123'], { env, encoding: 'utf8' });
    expect(revoke.status).toBe(0);
    expect(readFileSync(curlLog, 'utf8')).toContain('-X DELETE');
  });
});
