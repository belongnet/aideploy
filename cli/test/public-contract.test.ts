import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoot = resolve(cliRoot, '../..');
const publicRoot = existsSync(join(privateRoot, 'oss', 'public-root'))
  ? join(privateRoot, 'oss', 'public-root')
  : resolve(cliRoot, '..');

const text = (path: string) => readFileSync(path, 'utf8');

describe('release and cleanup shell contracts', () => {
  it('only enforces the public version for actual GitHub tag refs', () => {
    const script = join(cliRoot, 'scripts/verify-version-contract.sh');
    const publicVersion = text(join(publicRoot, 'VERSION')).trim();
    const run = (ref: string, refName: string) => spawnSync(script, [], {
      cwd: cliRoot,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_REF: ref, GITHUB_REF_NAME: refName },
    });

    expect(run('refs/pull/369/merge', '369/merge').status).toBe(0);
    expect(run('refs/heads/main', 'main').status).toBe(0);
    expect(run('refs/tags/v0.0.0', 'v0.0.0').status).not.toBe(0);
    expect(run(`refs/tags/v${publicVersion}`, `v${publicVersion}`).status).toBe(0);
  });

  it('does not delete a DigitalOcean tag that the provider proves is absent', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'aideploy-do-cleanup-'));
    const fakeCurl = join(fixture, 'curl');
    writeFileSync(fakeCurl, `#!/bin/sh
case " $* " in
  *" -X DELETE "*) printf '403'; exit 0 ;;
  *"/droplets?"*) printf '{"droplets":[],"links":{"pages":{}}}' ;;
  *"/firewalls?"*) printf '{"firewalls":[],"links":{"pages":{}}}' ;;
  *"/tags?"*) printf '{"tags":[],"links":{"pages":{}}}' ;;
  *) exit 64 ;;
esac
`);
    chmodSync(fakeCurl, 0o755);

    try {
      const result = spawnSync(join(cliRoot, 'scripts/digitalocean-e2e-cleanup.sh'), ['adp-oss-test01'], {
        cwd: cliRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fixture}:${process.env.PATH ?? ''}`,
          DIGITALOCEAN_TOKEN: 'test-token',
          DIGITALOCEAN_API_ROOT: 'https://api.example.test/v2',
        },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('zero droplets or firewalls; per-run metadata tag absent');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('reports zero billable resources when tag metadata cannot be deleted', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'aideploy-do-cleanup-'));
    const fakeCurl = join(fixture, 'curl');
    writeFileSync(fakeCurl, `#!/bin/sh
case " $* " in
  *" -X DELETE "*) printf '403'; exit 0 ;;
  *"/droplets?"*) printf '{"droplets":[],"links":{"pages":{}}}' ;;
  *"/firewalls?"*) printf '{"firewalls":[],"links":{"pages":{}}}' ;;
  *"/tags?"*) printf '{"tags":[{"name":"aideploy-adp-oss-test01"}],"links":{"pages":{}}}' ;;
  *) exit 64 ;;
esac
`);
    chmodSync(fakeCurl, 0o755);

    try {
      const result = spawnSync(join(cliRoot, 'scripts/digitalocean-e2e-cleanup.sh'), ['adp-oss-test01'], {
        cwd: cliRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fixture}:${process.env.PATH ?? ''}`,
          DIGITALOCEAN_TOKEN: 'test-token',
          DIGITALOCEAN_API_ROOT: 'https://api.example.test/v2',
        },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('zero droplets or firewalls');
      expect(result.stderr).toContain('non-billable per-run metadata tag retained');
      expect(result.stderr).toContain('lacks tag-delete permission');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('published deployment contract', () => {
  it('declares every tfvar written by deploy.ts and tags droplets for doctor', () => {
    const terraform = text(join(publicRoot, 'terraform/self-host-digitalocean/main.tf'));
    const variables = new Set([...terraform.matchAll(/variable "([a-z_]+)"/g)].map((match) => match[1]));
    for (const name of [
      'do_token',
      'deploy_id',
      'resource_tag',
      'region',
      'droplet_size',
      'runtime',
      'channel',
      'enable_tailscale',
      'ai_provider',
      'ai_api_key',
      'telegram_bot_token',
      'telegram_user_id',
      'tailscale_auth_key',
    ]) {
      expect(variables).toContain(name);
    }
    expect(terraform).toContain('tags = ["aideploy", var.resource_tag]');
    expect(terraform).toContain('output "droplet_ip"');
    expect(terraform).toContain('output "tailscale_hostname"');
    expect(terraform).toContain('output "gateway_token"');
    expect(terraform).toContain('output "hermes_webui_owner_password"');
    expect(terraform).toContain('["openai", "anthropic", "kimi"]');
  });

  it('ships runnable runtime assets with no on-VM build contexts', () => {
    const compose = text(join(publicRoot, 'stack/runtime/openclaw/docker-compose.yml'));
    const bootstrap = text(join(publicRoot, 'stack/runtime/bootstrap.sh'));
    expect(compose).not.toMatch(/^\s*build:/m);
    expect(compose).toMatch(/aideploy-openclaw-runtime:RELEASE_TAG/);
    expect(bootstrap).toMatch(/install_openclaw/);
    expect(bootstrap).toMatch(/install_hermes/);
    expect(bootstrap).toMatch(/OpenClaw image was not pinned/);
    expect(bootstrap).toContain('dmPolicy:"allowlist"');
    expect(bootstrap).toContain('TELEGRAM_ALLOWED_USERS');
    expect(bootstrap).toContain('kimi/kimi-for-coding');
    expect(bootstrap).toContain('KIMI_API_KEY');
    expect(bootstrap).toContain('type:"api_key",key:$api_key');
    expect(bootstrap).not.toContain('authType:"api_key"');
    expect(bootstrap).toContain('models:{($model):{}}');
    expect(bootstrap).toContain('baseUrl:"https://api.kimi.com/coding/"');
    expect(bootstrap).toContain('api:"anthropic-messages"');
    expect(bootstrap).toContain('id:"kimi-for-coding"');
    expect(bootstrap).toContain('tailscale serve --bg --yes');
    expect(bootstrap).toContain('tailscale_is_connected');
    expect(bootstrap).toContain('scrub_tailscale_auth_key');
    expect(bootstrap).toContain('.tailscale_auth_key = ""');
    expect(bootstrap).toContain(".tailscale_auth_key | type == \"string\"");
    expect(bootstrap).toContain('Tailscale is not connected and its one-off auth key has already been consumed');
    const tailscaleConnect = bootstrap.slice(
      bootstrap.indexOf('connect_tailscale()'),
      bootstrap.indexOf('load_tailscale_dns_name()'),
    );
    expect(tailscaleConnect.indexOf('if tailscale_is_connected; then')).toBeLessThan(
      tailscaleConnect.indexOf('if [ -z "$auth_key" ]; then'),
    );
    expect(tailscaleConnect.indexOf('tailscale up --authkey="$auth_key"')).toBeLessThan(
      tailscaleConnect.lastIndexOf('scrub_tailscale_auth_key'),
    );
    expect(bootstrap.indexOf('connect_tailscale "$tailscale_key" "$hostname"')).toBeLessThan(
      bootstrap.indexOf('tailscale_key=""'),
    );
    expect(bootstrap).toContain('start_bootstrap_status');
    expect(bootstrap).toContain('serve_bootstrap_status');
    expect(bootstrap).toContain('aideploy-bootstrap-status.service');
    expect(bootstrap).toContain('PUBLIC_STATUS_FILE="$PUBLIC_STATUS_ROOT/status.json"');
    expect(bootstrap).toContain('ReadOnlyPaths=/run/aideploy');
    expect(bootstrap.indexOf('serve_bootstrap_status\n')).toBeLessThan(bootstrap.indexOf('install_openclaw "$deploy_id"'));
    const statusServer = text(join(publicRoot, 'stack/runtime/status_server.py'));
    expect(statusServer).toContain('PUBLIC_FIELDS');
    expect(statusServer).toContain('HTTPStatus.SERVICE_UNAVAILABLE');
    expect(statusServer).toContain('Cache-Control');
    expect(statusServer).not.toContain('config.json');
    expect(bootstrap).toContain('local version="1.98.8"');
    expect(bootstrap).toContain('tailscale_${version}_${arch}.tgz');
    expect(bootstrap).toContain('3a55b5900dd7e11e09b6c74d1e46d223d549dfbefbdc1f044a8ab7bdbafb933c');
    expect(bootstrap).not.toContain('https://tailscale.com/install.sh');
    expect(bootstrap).toContain('node /app/openclaw.mjs agent');
    expect(bootstrap).toContain('--local');
    expect(bootstrap).toContain('AIDEPLOY_MODEL_READY');
    expect(bootstrap).toContain('modelVerified:true');
    expect(bootstrap).toContain('openclaw.control.settings.v1');
    expect(bootstrap).toContain('openclaw.control.token.v1:');
    expect(bootstrap).toContain('--arg dashboard_origin "https://$TAILSCALE_DNS_NAME"');
    expect(bootstrap).toContain('controlUi:{allowedOrigins:[$dashboard_origin]}');
    expect(bootstrap).toContain('trustedProxies:["127.0.0.1","::1"]');
    expect(bootstrap).toContain('allowTailscale:false');
    expect(bootstrap).not.toContain('allowTailscale:true');
    const autopair = text(join(publicRoot, 'stack/runtime/openclaw/autopair.sh'));
    expect(autopair).toContain('devices list --json');
    expect(autopair).toContain('devices approve "$request_id"');
    expect(autopair).not.toMatch(/\|\s*python3\s+-\s*<</);
    expect(bootstrap).toContain('aideploy-openclaw-autopair.service');
    expect(bootstrap).toContain('systemctl is-active --quiet aideploy-openclaw-autopair.service');
    expect(bootstrap).toContain('listen 127.0.0.1:18790');
    expect(bootstrap).toContain('location = /_aideploy/status');
    expect(bootstrap).toContain('X-Aideploy-Bootstrap-Status "1"');
    expect(bootstrap).toContain('verify_openclaw_remote_gateway "$gateway_token"');
    expect(bootstrap).toContain('/app/openclaw.mjs gateway call health');
    expect(bootstrap.indexOf('verify_openclaw_model "$provider" "$model" "$deploy_id"')).toBeLessThan(
      bootstrap.indexOf('serve_dashboard 18790'),
    );
    expect(bootstrap.indexOf('serve_dashboard 18790')).toBeLessThan(
      bootstrap.lastIndexOf('verify_openclaw_remote_gateway "$gateway_token"'),
    );
    expect(compose).toContain('network_mode: host');
    expect(compose).toContain('--bind loopback');

    const hermesCompose = text(join(publicRoot, 'stack/runtime/hermes/docker-compose.yml'));
    const hermesManifest = JSON.parse(text(join(publicRoot, 'stack/runtime/hermes/manifest.json')));
    expect(hermesManifest.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(hermesManifest.installUrl).toContain(`/${hermesManifest.sourceCommit}/`);
    expect(hermesManifest.sourceArchiveUrl).toContain(`/${hermesManifest.sourceCommit}`);
    expect(hermesManifest.sourceArchiveSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bootstrap).toContain("--branch '\"$source_commit\"'");
    expect(bootstrap).toContain('git -C "$install_dir" fetch --depth 1 origin "$HERMES_SOURCE_COMMIT"');
    expect(bootstrap).toContain('git -C "$install_dir" checkout --detach FETCH_HEAD');
    expect(bootstrap).toContain('local version="1.3.14"');
    expect(bootstrap).toContain('if [ "$installed_version" = "$version" ]');
    expect(bootstrap).toContain('bun-v${version}/bun-linux-${arch}.zip');
    expect(bootstrap).toContain('951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f');
    expect(bootstrap).toContain('a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b');
    expect(bootstrap).not.toContain('https://bun.sh/install');
    for (const browserDependency of [
      'fonts-noto-color-emoji',
      'libasound2t64',
      'libatk-bridge2.0-0t64',
      'libatk1.0-0t64',
      'libatspi2.0-0t64',
      'libcairo2',
      'libcups2t64',
      'libdbus-1-3',
      'libgbm1',
      'libglib2.0-0t64',
      'libnspr4',
      'libnss3',
      'libpango-1.0-0',
      'libxcomposite1',
      'libxdamage1',
      'libxfixes3',
      'libxkbcommon0',
      'libxrandr2',
    ]) {
      expect(bootstrap).toContain(browserDependency);
    }
    expect(bootstrap).toContain('status "running" "gstack_fetch"');
    expect(bootstrap).toContain('status "running" "gstack_setup"');
    expect(bootstrap).toContain('export PATH=/home/aideploy/.bun/bin:/home/aideploy/.local/bin:$PATH');
    const hermesInstall = bootstrap.slice(bootstrap.indexOf('install_hermes()'));
    expect(hermesInstall.indexOf('\n  install_bun\n')).toBeLessThan(
      hermesInstall.indexOf('status "running" "gstack_fetch"'),
    );
    expect(hermesInstall.indexOf('\n  install_gstack_browser_dependencies\n')).toBeLessThan(
      hermesInstall.indexOf('status "running" "gstack_fetch"'),
    );
    expect(bootstrap).toContain('AIDEPLOY_HERMES_MODEL_READY');
    expect(bootstrap.indexOf('verify_hermes_model "$provider" "$model" "$gateway_token" "$deploy_id"')).toBeLessThan(
      bootstrap.indexOf('serve_dashboard 3001'),
    );
    expect(hermesCompose).toContain('WEBUI_AUTH: "true"');
    expect(hermesCompose).toContain('ENABLE_SIGNUP: "false"');
    expect(hermesCompose).toContain('WEBUI_ADMIN_PASSWORD');

    const tofuManifest = JSON.parse(text(join(cliRoot, 'assets/opentofu.json')));
    expect(Object.values(tofuManifest.sha256)).toHaveLength(4);
    expect(Object.values(tofuManifest.sha256).every((value) => /^[a-f0-9]{64}$/.test(String(value)))).toBe(true);
    expect(tofuManifest.checksumsSource.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('documents a one-off Tailscale enrollment credential instead of a reusable key', () => {
    const rootReadme = text(join(publicRoot, 'README.md'));
    const selfHost = text(join(publicRoot, 'docs/self-host.md'));
    const cliReadme = text(join(cliRoot, 'README.md'));
    const cliEntry = text(join(cliRoot, 'src/index.ts'));

    for (const publishedText of [rootReadme, selfHost, cliReadme, cliEntry]) {
      expect(publishedText).toMatch(/one-off Tailscale auth key/i);
      expect(publishedText).not.toMatch(/reusable Tailscale auth key/i);
    }
    expect(selfHost).toContain('leave\n**Reusable** off');
  });

  it('signs the browser into the URL-scoped OpenClaw token store', () => {
    const bootstrap = text(join(publicRoot, 'stack/runtime/bootstrap.sh'));
    const script = bootstrap.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
    expect(script).toBeTruthy();

    const localStorage = new Map<string, string>();
    const sessionStorage = new Map<string, string>();
    const redirects: string[] = [];
    const history: string[] = [];
    const location = {
      host: 'agent.example.ts.net',
      protocol: 'https:',
      search: '?token=private-gateway-token',
      replace: (value: string) => redirects.push(value),
    };
    const window = {
      location,
      history: { replaceState: (_state: unknown, _title: string, value: string) => history.push(value) },
      localStorage: {
        getItem: (key: string) => localStorage.get(key) ?? null,
        setItem: (key: string, value: string) => localStorage.set(key, value),
      },
      sessionStorage: {
        getItem: (key: string) => sessionStorage.get(key) ?? null,
        setItem: (key: string, value: string) => sessionStorage.set(key, value),
      },
    };
    const main = { innerHTML: '' };

    runInNewContext(script!, {
      URLSearchParams,
      document: { querySelector: () => main },
      window,
    });

    const gatewayUrl = 'wss://agent.example.ts.net';
    const globalSettings = JSON.parse(localStorage.get('openclaw.control.settings.v1')!);
    const scopedSettings = JSON.parse(localStorage.get(`openclaw.control.settings.v1:${gatewayUrl}`)!);
    expect(sessionStorage.get(`openclaw.control.token.v1:${gatewayUrl}`)).toBe('private-gateway-token');
    expect(localStorage.has(`openclaw.control.token.v1:${gatewayUrl}`)).toBe(false);
    expect(globalSettings).toEqual(scopedSettings);
    expect(scopedSettings).toMatchObject({
      gatewayUrl,
      sessionKey: 'main',
      lastActiveSessionKey: 'main',
    });
    expect(scopedSettings).not.toHaveProperty('token');
    expect(history).toEqual(['/']);
    expect(redirects).toEqual(['/']);
  });
});

describe('public workflows', () => {
  it('publishes one canonical identity and complete automation/resume guidance', () => {
    const readme = text(join(publicRoot, 'README.md'));
    const cliReadme = text(join(cliRoot, 'README.md'));
    const selfHost = text(join(publicRoot, 'docs/self-host.md'));
    const dockerfile = text(join(publicRoot, 'stack/runtime/openclaw/Dockerfile'));
    const packageMetadata = JSON.parse(text(join(cliRoot, 'package.json')));
    const staleRepository = ['https:/', 'github.com', 'aideploy', 'aideploy'].join('/');
    const placeholderImageOwner = ['ghcr.io', 'OWNER'].join('/');
    const placeholderWorkflow = ['github.com', 'OWNER', 'REPO'].join('/');

    expect(readme).toContain('https://github.com/belongnet/aideploy');
    expect(readme).toContain('aideploy-base-$release.manifest.json.sigstore.json');
    expect(readme).toContain('cosign verify-blob');
    expect(readme).toContain('m.commitSha');
    expect(readme).toContain('m.sourceTreeSha');
    expect(readme).toContain("git rev-parse 'HEAD^{tree}'");
    expect(readme).toContain('m.runtimeImages.openclaw');
    expect(readme).toContain('ghcr.io/belongnet/aideploy-openclaw-runtime@$digest');
    expect(readme).toContain(
      'https://github.com/belongnet/aideploy/.github/workflows/release.yml@refs/tags/$release',
    );
    expect(readme).not.toContain(staleRepository);
    expect(readme).not.toContain(placeholderImageOwner);
    expect(readme).not.toContain(placeholderWorkflow);
    expect(cliReadme).toContain('https://github.com/belongnet/aideploy');
    expect(dockerfile).toContain('org.opencontainers.image.source="https://github.com/belongnet/aideploy"');
    expect(packageMetadata.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/belongnet/aideploy.git',
      directory: 'cli',
    });
    expect(packageMetadata.homepage).toBe('https://github.com/belongnet/aideploy#readme');
    expect(packageMetadata.bugs).toEqual({ url: 'https://github.com/belongnet/aideploy/issues' });
    expect(selfHost).toContain('AIDEPLOY_AI_PROVIDER');
    expect(selfHost).toContain('`--yes-telemetry` or `--no-telemetry`');
    expect(selfHost).toContain('`/v2/account` must identify the same account UUID');
    expect(selfHost).toContain('original one-off Tailscale key saved in');
  });

  it('fails the README quick start closed before executing unverified source', () => {
    const readme = text(join(publicRoot, 'README.md'));
    const quickStart = [...readme.matchAll(/```bash\n([\s\S]*?)\n```/g)]
      .map((match) => match[1])
      .find((block) => block.includes('git clone --branch'));
    expect(quickStart).toContain('set -Eeuo pipefail');

    const fixture = mkdtempSync(join(tmpdir(), 'aideploy-readme-gate-'));
    const bin = join(fixture, 'bin');
    const checkout = join(fixture, 'aideploy');
    const logPath = join(fixture, 'executed.log');
    const expectedCommit = 'a'.repeat(40);
    const expectedTree = 'b'.repeat(40);
    const digest = `sha256:${'c'.repeat(64)}`;
    mkdirSync(join(checkout, 'cli', 'scripts'), { recursive: true });
    mkdirSync(join(checkout, 'cli', 'dist'), { recursive: true });
    mkdirSync(join(fixture, 'tmp'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    const executable = (path: string, lines: string[]) => {
      writeFileSync(path, `${lines.join('\n')}\n`);
      chmodSync(path, 0o755);
    };
    executable(join(bin, 'git'), [
      '#!/bin/sh',
      'case "$1" in',
      '  clone) exit 0 ;;',
      '  rev-parse)',
      '    case "$2" in',
      '      HEAD) printf "%s\\n" "$AIDEPLOY_TEST_COMMIT" ;;',
      '      "HEAD^{tree}") printf "%s\\n" "$AIDEPLOY_TEST_TREE" ;;',
      '      *) exit 64 ;;',
      '    esac ;;',
      '  *) exit 64 ;;',
      'esac',
    ]);
    executable(join(bin, 'curl'), [
      '#!/bin/sh',
      'out=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-o" ]; then out="$2"; break; fi',
      '  shift',
      'done',
      'case "$out" in',
      '  *.sigstore.json) printf "{\\"bundle\\":true}\\n" > "$out" ;;',
      `  *) printf "%s\\n" '${JSON.stringify({
        commitSha: expectedCommit,
        sourceTreeSha: expectedTree,
        runtimeImages: { openclaw: digest },
      })}' > "$out" ;;`,
      'esac',
    ]);
    executable(join(bin, 'cosign'), [
      '#!/bin/sh',
      '[ "${AIDEPLOY_TEST_FAIL_COSIGN:-}" = manifest ] && [ "$1" = verify-blob ] && exit 42',
      '[ "${AIDEPLOY_TEST_FAIL_COSIGN:-}" = image ] && [ "$1" = verify ] && exit 43',
      'exit 0',
    ]);
    executable(join(bin, 'npm'), [
      '#!/bin/sh',
      'printf "npm\\n" >> "$AIDEPLOY_TEST_LOG"',
    ]);
    executable(join(bin, 'node'), [
      '#!/bin/sh',
      'if [ "$1" = "-e" ]; then exec "$AIDEPLOY_TEST_REAL_NODE" "$@"; fi',
      'printf "deploy\\n" >> "$AIDEPLOY_TEST_LOG"',
    ]);
    executable(join(checkout, 'cli', 'scripts', 'vendor-assets.sh'), [
      '#!/bin/sh',
      'printf "vendor\\n" >> "$AIDEPLOY_TEST_LOG"',
    ]);
    executable(join(checkout, 'cli', 'scripts', 'pin-image-digests.sh'), [
      '#!/bin/sh',
      'printf "pin\\n" >> "$AIDEPLOY_TEST_LOG"',
    ]);

    const run = (actualCommit: string, actualTree: string, failCosign = '') =>
      spawnSync('bash', ['-c', quickStart!], {
        cwd: fixture,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          TMPDIR: join(fixture, 'tmp'),
          AIDEPLOY_TEST_COMMIT: actualCommit,
          AIDEPLOY_TEST_TREE: actualTree,
          AIDEPLOY_TEST_FAIL_COSIGN: failCosign,
          AIDEPLOY_TEST_LOG: logPath,
          AIDEPLOY_TEST_REAL_NODE: process.execPath,
        },
      });
    const executionLog = () => (existsSync(logPath) ? text(logPath) : '');

    try {
      const badSignature = run(expectedCommit, expectedTree, 'manifest');
      expect(badSignature.status).not.toBe(0);
      expect(executionLog()).toBe('');

      rmSync(logPath, { force: true });
      const movedTag = run('d'.repeat(40), expectedTree);
      expect(movedTag.status).not.toBe(0);
      expect(executionLog()).toBe('');

      rmSync(logPath, { force: true });
      const changedTree = run(expectedCommit, 'e'.repeat(40));
      expect(changedTree.status).not.toBe(0);
      expect(executionLog()).toBe('');

      rmSync(logPath, { force: true });
      const badImageSignature = run(expectedCommit, expectedTree, 'image');
      expect(badImageSignature.status).not.toBe(0);
      expect(executionLog()).toBe('');

      rmSync(logPath, { force: true });
      const verified = run(expectedCommit, expectedTree);
      expect(verified.status).toBe(0);
      expect(executionLog()).toBe('vendor\npin\nnpm\nnpm\ndeploy\n');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('vendors before digest pinning and publishes retry-idempotently from the checked-in version', () => {
    const release = text(join(publicRoot, '.github/workflows/release.yml'));
    expect(release.indexOf('cli/scripts/vendor-assets.sh')).toBeGreaterThan(-1);
    expect(release.indexOf('cli/scripts/pin-image-digests.sh')).toBeGreaterThan(
      release.indexOf('cli/scripts/vendor-assets.sh'),
    );
    expect(release).not.toMatch(/npm version/);
    expect(release).toContain('cli/scripts/verify-version-contract.sh');
    expect(release).toContain('npm view "aideploy@$version" dist.integrity');
    expect(release).toContain('gh release view "$GITHUB_REF_NAME"');
    expect(release).toContain('gh release edit "$GITHUB_REF_NAME" --prerelease');
    expect(release).toContain('release_flags+=(--prerelease)');
    expect(release).toContain('image: [openclaw-runtime]');
    expect(release).not.toContain('hermes-gateway');
    expect(release).toMatch(/gh release create/);
  });

  it('runs distinct credential-free runtime smoke paths with boot checks enabled', () => {
    const ci = text(join(publicRoot, '.github/workflows/ci.yml'));
    expect(ci).toContain('./cli/scripts/runtime-smoke.sh ${{ matrix.runtime }}');
    expect(ci).toContain("SMOKE_UP: '1'");
    const smoke = text(join(cliRoot, 'scripts/runtime-smoke.sh'));
    expect(smoke).toMatch(/openclaw\) smoke_openclaw/);
    expect(smoke).toMatch(/hermes\) smoke_hermes/);
    expect(smoke).toContain('cleanup_openclaw_smoke()');
    expect(smoke).toContain('trap cleanup_openclaw_smoke EXIT');
    const cleanupStart = smoke.indexOf('cleanup_openclaw_smoke()');
    const trapDisarm = smoke.indexOf('trap - EXIT', cleanupStart);
    const composeCleanup = smoke.indexOf('docker compose', cleanupStart);
    expect(trapDisarm).toBeGreaterThan(cleanupStart);
    expect(composeCleanup).toBeGreaterThan(trapDisarm);
    expect(smoke).toContain('docker run --rm --user 0:0 --entrypoint sh');
    expect(smoke).toContain("-c 'rm -rf /cleanup/state /cleanup/workspace'");
    expect(smoke).toContain('--continue-at -');
    expect(smoke).toContain('PIP_NO_CACHE_DIR=1');
    expect(smoke).not.toContain('trap cleanup EXIT');
    expect(smoke).toContain('Hermes gateway boot smoke: PASS');
  });

  it('tests an exact release, rotates providers, and isolates cleanup credentials', () => {
    const e2e = text(join(publicRoot, '.github/workflows/e2e-live.yml'));
    expect(e2e).toContain('E2E_TG_CHAT_ID: ${{ secrets.E2E_TG_CHAT_ID }}');
    expect(e2e).toContain('AIDEPLOY_TG_USER_ID: ${{ secrets.E2E_TG_CHAT_ID }}');
    expect(e2e).toContain('E2E_TG_SESSION: ${{ secrets.E2E_TG_SESSION }}');
    expect(e2e).toMatch(/uses: tailscale\/github-action@[a-f0-9]{40}/);
    expect(e2e).toContain('tailscale-e2e-auth-key.sh mint');
    expect(e2e).toContain('tailscale-e2e-auth-key.sh revoke');
    expect(e2e).not.toContain('E2E_TS_KEY');
    expect(e2e).not.toContain('aideploy@latest');
    expect(e2e).toContain('npm pack --silent --json "aideploy@$RELEASE_VERSION"');
    expect(e2e).toContain('verify OpenClaw private browser sign-in, pairing, and live model response');
    expect(e2e).toContain('openclaw.control.token.v1:');
    expect(e2e).toContain('$dashboard_url/_aideploy/status');
    expect(e2e).toContain('.state == "ready" and .step == "complete"');
    expect(e2e).toContain('OPENCLAW_GATEWAY_URL="$gateway_url"');
    expect(e2e).toContain('/app/openclaw.mjs gateway call health');
    expect(e2e).toContain('/app/openclaw.mjs gateway call agent');
    expect(e2e).toContain('--expect-final');
    expect(e2e).toContain('--params "$rpc_params"');
    expect(e2e).not.toContain('/app/openclaw.mjs agent');
    expect(e2e).toContain('verify Hermes private owner sign-in');
    expect(e2e).toContain('providers=(openai anthropic kimi)');
    expect(e2e).toContain('provider-cleanup:');
    expect(e2e).toContain('revoke-tailscale-key:');
    expect(e2e).toContain('digitalocean-e2e-cleanup.sh');
    const publicRevokeJob = e2e.slice(e2e.indexOf('revoke-tailscale-key:'));
    expect(publicRevokeJob).not.toContain('continue-on-error: true');
    expect(publicRevokeJob).not.toContain("steps.key_artifact.outcome == 'success'");

    const candidatePath = join(privateRoot, '.github/workflows/oss-cli-digitalocean-e2e.yml');
    if (existsSync(candidatePath)) {
      const candidate = text(candidatePath);
      expect(candidate).toContain("github.ref == 'refs/heads/main'");
      expect(candidate.match(/environment: oss-e2e/g)).toHaveLength(3);
      const candidateRevokeJob = candidate.slice(candidate.indexOf('revoke-tailscale-key:'));
      expect(candidateRevokeJob).not.toContain('continue-on-error: true');
      expect(candidateRevokeJob).not.toContain("steps.key_artifact.outcome == 'success'");
    }
  });

  it('pins every public action to a full commit and denies permissions by default', () => {
    for (const workflow of ['ci.yml', 'e2e-live.yml', 'release.yml']) {
      const yaml = text(join(publicRoot, '.github/workflows', workflow));
      expect(yaml).toContain('permissions: {}');
      for (const match of yaml.matchAll(/uses:\s+([^\s#]+)/g)) {
        const reference = match[1];
        if (reference.startsWith('./') || reference.startsWith('docker://')) continue;
        expect(reference).toMatch(/@[a-f0-9]{40}$/);
      }
    }
  });

  it('installs Gitleaks from its canonical Go module path', () => {
    const toolingPath = join(privateRoot, '.github/workflows/oss-tooling-ci.yml');
    if (!existsSync(toolingPath)) return;
    const tooling = text(toolingPath);
    expect(tooling).toContain('go install github.com/zricethezav/gitleaks/v8@v8.30.1');
    expect(tooling).not.toContain('go install github.com/gitleaks/gitleaks/v8');
  });
});
