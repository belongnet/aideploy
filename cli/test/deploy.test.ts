import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { readTailnetInfo, runtimeWaitAttempts, up, waitForRuntimeReady } from '../src/deploy.js';
import { deployDir } from '../src/config.js';

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const DO_ACCOUNT_UUID = '11111111-2222-4333-8444-555555555555';
const OTHER_DO_ACCOUNT_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function doApiFetch(accountUuid: string = DO_ACCOUNT_UUID): any {
  return jest.fn(async (url: any, init?: any) => {
    const s = String(url);
    if (s.endsWith('/account')) return okJson({ account: { uuid: accountUuid } });
    if (s.includes('/regions')) return okJson({ regions: [{ slug: 'nyc3', available: true }] });
    if (s.includes('/sizes')) return okJson({ sizes: [{ slug: 's-2vcpu-4gb', available: true, memory: 4096, regions: ['nyc3'] }] });
    if (s.includes('ping')) return okJson({ ok: true });
    return okJson({});
  });
}

let home: string;
let assets: string;
const secrets = {
  doToken: 'dop_v1_' + 'a'.repeat(64),
  aiApiKey: 'sk-test-' + 'x'.repeat(24),
  aiProvider: 'openai' as const,
  telegramBotToken: '123456789:' + 'A'.repeat(35),
  telegramUserId: '123456789',
  tailscaleAuthKey: 'tskey-auth-xyz123',
};
const tailnetInfoImpl = jest.fn(async () => ({ dnsSuffix: 'example.ts.net' })) as any;
const baseOpts = {
  cloud: 'do' as const,
  runtime: 'openclaw' as const,
  region: 'nyc3',
  channel: 'telegram' as const,
  telemetryConsent: true,
  cliVersion: '0.0.1-test',
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aideploy-home-'));
  process.env.AIDEPLOY_HOME = home;
  assets = mkdtempSync(join(tmpdir(), 'aideploy-assets-'));
  mkdirSync(join(assets, 'terraform', 'digitalocean'), { recursive: true });
  mkdirSync(join(assets, 'stack', 'runtime'), { recursive: true });
  writeFileSync(join(assets, 'terraform', 'digitalocean', 'main.tf'), '# test module');
  writeFileSync(join(assets, 'stack', 'runtime', 'bootstrap.sh'), '#!/bin/sh\n');
  writeFileSync(
    join(assets, 'opentofu.json'),
    JSON.stringify({ version: '1.10.3', baseUrl: 'https://x.invalid', sha256: {} })
  );
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(assets, { recursive: true, force: true });
});

function fakeTofu(): { exec: any; ensureTofuImpl: any; calls: string[][] } {
  const calls: string[][] = [];
  const exec = jest.fn(async (cmd: string, args: string[], opts?: any) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'apply') {
      // emulate state file creation
      const stateArg = args.find((a) => a.startsWith('-state='));
      if (stateArg) {
        const statePath = stateArg.slice('-state='.length);
        writeFileSync(statePath, JSON.stringify({ version: 4, resources: [] }));
        // Deliberately emulate a permissive host umask; `up` must correct it.
        chmodSync(statePath, 0o644);
      }
    }
    if (args[0] === 'output') {
      return {
        stdout: JSON.stringify({
          droplet_ip: { value: '203.0.113.7' },
          tailscale_hostname: { value: 'aideploy-adp-test01' },
          gateway_token: { value: 'gateway-token-123' },
          hermes_webui_owner_email: { value: 'owner@aideploy.local' },
          hermes_webui_owner_password: { value: 'owner-password-1234567890' },
        }),
        code: 0,
      };
    }
    return { stdout: '', code: 0 };
  });
  return { exec, ensureTofuImpl: jest.fn(async () => '/fake/tofu') as any, calls };
}

describe('up', () => {
  it('happy path: validates live, writes files (secrets 0600), applies, returns dashboard URL, pings once', async () => {
    const { exec, ensureTofuImpl } = fakeTofu();
    const fetchImpl = doApiFetch();
    const result = await up({ ...baseOpts, deployId: 'adp-test01' }, secrets, {
      exec,
      ensureTofuImpl,
      fetchImpl,
      assetsDir: assets,
      tailnetInfoImpl,
    });
    expect(result.deployId).toBe('adp-test01');
    expect(result.dashboardUrl).toBe('https://aideploy-adp-test01.example.ts.net');
    expect(result.browserSignInUrl).toBe(
      'https://aideploy-adp-test01.example.ts.net/_aideploy/bootstrap?token=gateway-token-123'
    );
    const dir = deployDir('adp-test01');
    expect(existsSync(join(dir, 'config.json'))).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, '.terraform')).mode & 0o777).toBe(0o700);
    for (const name of ['config.json', 'deploy.auto.tfvars.json', 'secrets.auto.tfvars.json', 'terraform.tfstate']) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
    const tfvars = JSON.parse(readFileSync(join(dir, 'deploy.auto.tfvars.json'), 'utf8'));
    expect(tfvars.resource_tag).toBe('aideploy-adp-test01');
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(config.digitalOceanAccountUuid).toBe(DO_ACCOUNT_UUID);
    const secretTfvars = JSON.parse(readFileSync(join(dir, 'secrets.auto.tfvars.json'), 'utf8'));
    expect(secretTfvars.telegram_user_id).toBe('123456789');
    expect(result.accessFile).toBe(join(dir, 'access.json'));
    expect(statSync(result.accessFile!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(result.accessFile!, 'utf8'))).toEqual({
      dashboardUrl: 'https://aideploy-adp-test01.example.ts.net',
      browserSignInUrl: 'https://aideploy-adp-test01.example.ts.net/_aideploy/bootstrap?token=gateway-token-123',
      gatewayToken: 'gateway-token-123',
    });
    const pings = (fetchImpl.mock.calls as any[]).filter((c) => String(c[0]).startsWith('https://ping.'));
    expect(pings).toHaveLength(1);
    expect(JSON.parse(pings[0][1].body).event).toBe('deploy_completed');
  });

  it('is idempotent per deploy-id (reports resumed on second run)', async () => {
    const { exec, ensureTofuImpl } = fakeTofu();
    const first = await up({ ...baseOpts, deployId: 'adp-twice1' }, secrets, { exec, ensureTofuImpl, fetchImpl: doApiFetch(), assetsDir: assets, tailnetInfoImpl });
    expect(first.resumed).toBe(false);
    const second = await up({ ...baseOpts, deployId: 'adp-twice1' }, secrets, { exec, ensureTofuImpl, fetchImpl: doApiFetch(), assetsDir: assets, tailnetInfoImpl });
    expect(second.resumed).toBe(true);
  });

  it('allows token rotation only when DigitalOcean proves the account is unchanged', async () => {
    const { exec, ensureTofuImpl, calls } = fakeTofu();
    await up({ ...baseOpts, deployId: 'adp-account1' }, secrets, {
      exec,
      ensureTofuImpl,
      fetchImpl: doApiFetch(),
      assetsDir: assets,
      tailnetInfoImpl,
    });

    const rotatedSecrets = { ...secrets, doToken: 'dop_v1_' + 'b'.repeat(64) };
    await expect(
      up({ ...baseOpts, deployId: 'adp-account1' }, rotatedSecrets, {
        exec,
        ensureTofuImpl,
        fetchImpl: doApiFetch(DO_ACCOUNT_UUID),
        assetsDir: assets,
        tailnetInfoImpl,
      })
    ).resolves.toMatchObject({ resumed: true });
    const callsAfterSameAccountResume = calls.length;

    await expect(
      up({ ...baseOpts, deployId: 'adp-account1' }, { ...rotatedSecrets, doToken: 'dop_v1_' + 'c'.repeat(64) }, {
        exec,
        ensureTofuImpl,
        fetchImpl: doApiFetch(OTHER_DO_ACCOUNT_UUID),
        assetsDir: assets,
        tailnetInfoImpl,
      })
    ).rejects.toThrow(/immutable inputs changed: DigitalOcean account/);
    expect(calls).toHaveLength(callsAfterSameAccountResume);
  });

  it('stores Hermes browser owner access privately and returns it to the caller', async () => {
    const { exec, ensureTofuImpl } = fakeTofu();
    const result = await up({ ...baseOpts, runtime: 'hermes', deployId: 'adp-hermes01' }, secrets, {
      exec,
      ensureTofuImpl,
      fetchImpl: doApiFetch(),
      assetsDir: assets,
      tailnetInfoImpl,
    });
    expect(result.hermesWebuiOwnerEmail).toBe('owner@aideploy.local');
    expect(result.hermesWebuiOwnerPassword).toBe('owner-password-1234567890');
    expect(result.accessFile).toBe(join(deployDir('adp-hermes01'), 'access.json'));
    expect(statSync(result.accessFile!).mode & 0o777).toBe(0o600);
    expect(readFileSync(result.accessFile!, 'utf8')).toContain('owner@aideploy.local');
  });

  it('refuses to resume when immutable configuration or runtime credentials drift', async () => {
    const { exec, ensureTofuImpl, calls } = fakeTofu();
    await up({ ...baseOpts, deployId: 'adp-stable1' }, secrets, {
      exec,
      ensureTofuImpl,
      fetchImpl: doApiFetch(),
      assetsDir: assets,
      tailnetInfoImpl,
    });
    const callsAfterCreate = calls.length;

    await expect(
      up({ ...baseOpts, deployId: 'adp-stable1', runtime: 'hermes' }, secrets, {
        exec,
        ensureTofuImpl,
        fetchImpl: doApiFetch(),
        assetsDir: assets,
        tailnetInfoImpl,
      })
    ).rejects.toThrow(/immutable inputs changed: runtime/);
    await expect(
      up({ ...baseOpts, deployId: 'adp-stable1' }, { ...secrets, aiApiKey: 'sk-test-' + 'y'.repeat(24) }, {
        exec,
        ensureTofuImpl,
        fetchImpl: doApiFetch(),
        assetsDir: assets,
        tailnetInfoImpl,
      })
    ).rejects.toThrow(/runtime credentials/);
    await expect(
      up({ ...baseOpts, deployId: 'adp-stable1', cliVersion: '0.0.2-test' }, secrets, {
        exec,
        ensureTofuImpl,
        fetchImpl: doApiFetch(),
        assetsDir: assets,
        tailnetInfoImpl,
      })
    ).rejects.toThrow(/CLI version/);

    expect(calls).toHaveLength(callsAfterCreate);
  });

  it('refuses partial local state instead of overwriting evidence or creating a duplicate', async () => {
    const dir = deployDir('adp-partial1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{}');
    const { exec, ensureTofuImpl } = fakeTofu();
    await expect(
      up({ ...baseOpts, deployId: 'adp-partial1' }, secrets, {
        exec,
        ensureTofuImpl,
        fetchImpl: doApiFetch(),
        assetsDir: assets,
        tailnetInfoImpl,
      })
    ).rejects.toThrow(/contains an incomplete deployment checkpoint but no OpenTofu state/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('retries a complete matching pre-apply checkpoint after an engine download failure', async () => {
    const { exec } = fakeTofu();
    const ensureFailOnce = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('download interrupted'))
      .mockResolvedValue('/fake/tofu') as any;
    const messages: string[] = [];
    const dir = deployDir('adp-retry01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'destroyed.json'), '{"deployId":"adp-retry01"}');

    await expect(
      up({ ...baseOpts, deployId: 'adp-retry01' }, secrets, {
        exec,
        ensureTofuImpl: ensureFailOnce,
        fetchImpl: doApiFetch(),
        assetsDir: assets,
        tailnetInfoImpl,
        log: (message) => messages.push(message),
      })
    ).rejects.toThrow(/download interrupted/);

    expect(existsSync(join(dir, 'terraform.tfstate'))).toBe(false);
    expect(existsSync(join(dir, 'destroyed.json'))).toBe(false);
    for (const name of ['config.json', 'deploy.auto.tfvars.json', 'secrets.auto.tfvars.json']) {
      expect(existsSync(join(dir, name))).toBe(true);
    }

    const result = await up({ ...baseOpts, deployId: 'adp-retry01' }, secrets, {
      exec,
      ensureTofuImpl: ensureFailOnce,
      fetchImpl: doApiFetch(),
      assetsDir: assets,
      tailnetInfoImpl,
      log: (message) => messages.push(message),
    });
    expect(result.resumed).toBe(true);
    expect(messages).toContain('Deployment id: adp-retry01');
    expect(messages.join('\n')).toMatch(/Complete pre-apply checkpoint.*retrying/);
  });

  it('refuses a pre-apply checkpoint when credentials drift or its cloud tag is occupied', async () => {
    const { exec } = fakeTofu();
    const failDownload = jest.fn(async () => {
      throw new Error('download interrupted');
    }) as any;
    await expect(
      up({ ...baseOpts, deployId: 'adp-check01' }, secrets, {
        exec,
        ensureTofuImpl: failDownload,
        fetchImpl: doApiFetch(),
        assetsDir: assets,
        tailnetInfoImpl,
      })
    ).rejects.toThrow(/download interrupted/);

    await expect(
      up({ ...baseOpts, deployId: 'adp-check01' }, { ...secrets, aiApiKey: 'sk-test-' + 'z'.repeat(24) }, {
        exec,
        ensureTofuImpl: jest.fn(async () => '/fake/tofu') as any,
        fetchImpl: doApiFetch(),
        assetsDir: assets,
        tailnetInfoImpl,
      })
    ).rejects.toThrow(/runtime credentials/);

    const occupiedFetch = doApiFetch();
    occupiedFetch.mockImplementation(async (url: any) => {
      const value = String(url);
      if (value.endsWith('/account')) return okJson({ account: { uuid: DO_ACCOUNT_UUID } });
      if (value.includes('/regions')) return okJson({ regions: [{ slug: 'nyc3', available: true }] });
      if (value.includes('/sizes')) {
        return okJson({ sizes: [{ slug: 's-2vcpu-4gb', available: true, memory: 4096, regions: ['nyc3'] }] });
      }
      if (value.includes('/droplets?tag_name=aideploy-adp-check01')) return okJson({ droplets: [{ id: 7 }] });
      return okJson({});
    });
    await expect(
      up({ ...baseOpts, deployId: 'adp-check01' }, secrets, {
        exec,
        ensureTofuImpl: jest.fn(async () => '/fake/tofu') as any,
        fetchImpl: occupiedFetch,
        assetsDir: assets,
        tailnetInfoImpl,
      })
    ).rejects.toThrow(/already has a VM tagged/);
  });

  it('refuses a malformed or incomplete state file before any infrastructure command', async () => {
    const dir = deployDir('adp-badstate');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'terraform.tfstate'), '{}');
    writeFileSync(join(dir, 'config.json'), '{}');
    writeFileSync(join(dir, 'deploy.auto.tfvars.json'), '{}');
    writeFileSync(join(dir, 'secrets.auto.tfvars.json'), '{}');
    const { exec, ensureTofuImpl } = fakeTofu();
    await expect(
      up({ ...baseOpts, deployId: 'adp-badstate' }, secrets, {
        exec,
        ensureTofuImpl,
        fetchImpl: doApiFetch(),
        assetsDir: assets,
        tailnetInfoImpl,
      })
    ).rejects.toThrow(/not a complete OpenTofu state file/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses a custom id already present in DigitalOcean when local state is absent', async () => {
    const fetchImpl = doApiFetch();
    fetchImpl.mockImplementation(async (url: any) => {
      const s = String(url);
      if (s.endsWith('/account')) return okJson({ account: { uuid: DO_ACCOUNT_UUID } });
      if (s.includes('/regions')) return okJson({ regions: [{ slug: 'nyc3', available: true }] });
      if (s.includes('/sizes')) return okJson({ sizes: [{ slug: 's-2vcpu-4gb', available: true, memory: 4096, regions: ['nyc3'] }] });
      if (s.includes('/droplets?tag_name=aideploy-adp-cloud01')) return okJson({ droplets: [{ id: 7 }] });
      return okJson({});
    });
    const { exec, ensureTofuImpl } = fakeTofu();
    await expect(
      up({ ...baseOpts, deployId: 'adp-cloud01' }, secrets, {
        exec,
        ensureTofuImpl,
        fetchImpl,
        assetsDir: assets,
        tailnetInfoImpl,
      })
    ).rejects.toThrow(/already has a VM tagged/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('invalid region fails BEFORE any tofu call (no resources created)', async () => {
    const { exec, ensureTofuImpl } = fakeTofu();
    await expect(
      up({ ...baseOpts, region: 'mars1' }, secrets, { exec, ensureTofuImpl, fetchImpl: doApiFetch(), assetsDir: assets, tailnetInfoImpl })
    ).rejects.toThrow(/not available/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('invalid or region-incompatible size fails BEFORE any tofu call', async () => {
    const { exec, ensureTofuImpl } = fakeTofu();
    await expect(
      up({ ...baseOpts, size: 's-8vcpu-32gb' }, secrets, {
        exec,
        ensureTofuImpl,
        fetchImpl: doApiFetch(),
        assetsDir: assets,
        tailnetInfoImpl,
      })
    ).rejects.toThrow(/Droplet size/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('failed apply still pings deploy_failed and rethrows', async () => {
    const fetchImpl = doApiFetch();
    const exec = jest.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'apply') throw new Error('quota exceeded');
      return { stdout: '', code: 0 };
    }) as any;
    await expect(
      up({ ...baseOpts, deployId: 'adp-fail01' }, secrets, {
        exec,
        ensureTofuImpl: jest.fn(async () => '/fake/tofu') as any,
        fetchImpl,
        assetsDir: assets,
        tailnetInfoImpl,
      })
    ).rejects.toThrow(/quota/);
    const pings = (fetchImpl.mock.calls as any[]).filter((c) => String(c[0]).includes('ping'));
    expect(pings).toHaveLength(1);
    expect(JSON.parse(pings[0][1].body).event).toBe('deploy_failed');
  });

  it('does not report success until the Tailscale runtime is reachable', async () => {
    const { exec, ensureTofuImpl } = fakeTofu();
    const fetchImpl = doApiFetch();
    const waitForRuntimeImpl = jest.fn(async () => {
      throw new Error('runtime never started');
    });
    await expect(
      up({ ...baseOpts, deployId: 'adp-notready' }, secrets, {
        exec,
        ensureTofuImpl,
        fetchImpl,
        waitForRuntimeImpl,
        assetsDir: assets,
        tailnetInfoImpl,
      })
    ).rejects.toThrow(/runtime never started/);
    expect(waitForRuntimeImpl).toHaveBeenCalledWith(
      'https://aideploy-adp-test01.example.ts.net/_aideploy/status'
    );
    const pings = (fetchImpl.mock.calls as any[]).filter((call) => String(call[0]).startsWith('https://ping.'));
    expect(JSON.parse(pings[0][1].body).event).toBe('deploy_failed');
  });

  it('consent declined => no ping call even on success', async () => {
    const { exec, ensureTofuImpl } = fakeTofu();
    const fetchImpl = doApiFetch();
    await up({ ...baseOpts, deployId: 'adp-noping', telemetryConsent: false }, secrets, { exec, ensureTofuImpl, fetchImpl, assetsDir: assets, tailnetInfoImpl });
    const pings = (fetchImpl.mock.calls as any[]).filter((c) => String(c[0]).startsWith('https://ping.'));
    expect(pings).toHaveLength(0);
  });

  it('missing vendored terraform assets is a clear packaging error', async () => {
    rmSync(join(assets, 'terraform'), { recursive: true, force: true });
    const { exec, ensureTofuImpl } = fakeTofu();
    await expect(
      up(baseOpts, secrets, { exec, ensureTofuImpl, fetchImpl: doApiFetch(), assetsDir: assets, tailnetInfoImpl })
    ).rejects.toThrow(/Vendored terraform assets missing/);
  });

  it('missing runtime bootstrap is a clear packaging error before tofu init', async () => {
    rmSync(join(assets, 'stack'), { recursive: true, force: true });
    const { exec, ensureTofuImpl } = fakeTofu();
    await expect(
      up(baseOpts, secrets, { exec, ensureTofuImpl, fetchImpl: doApiFetch(), assetsDir: assets, tailnetInfoImpl })
    ).rejects.toThrow(/deployment contract is incomplete/);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('readTailnetInfo', () => {
  it('returns the HTTPS MagicDNS suffix from a running local tailnet', async () => {
    const exec = jest.fn(async () => ({
      stdout: JSON.stringify({
        BackendState: 'Running',
        MagicDNSSuffix: 'example.ts.net',
        CurrentTailnet: { MagicDNSSuffix: 'example.ts.net', MagicDNSEnabled: true },
        CertDomains: ['laptop.example.ts.net'],
      }),
      code: 0,
    })) as any;
    await expect(readTailnetInfo(exec)).resolves.toEqual({ dnsSuffix: 'example.ts.net' });
  });

  it('fails before provisioning when Tailscale HTTPS is unavailable', async () => {
    const exec = jest.fn(async () => ({
      stdout: JSON.stringify({
        BackendState: 'Running',
        MagicDNSSuffix: 'example.ts.net',
        CurrentTailnet: { MagicDNSSuffix: 'example.ts.net', MagicDNSEnabled: true },
        CertDomains: [],
      }),
      code: 0,
    })) as any;
    await expect(readTailnetInfo(exec)).rejects.toThrow(/HTTPS is not enabled/);
  });
});

describe('waitForRuntimeReady', () => {
  it('reserves a longer cold-boot budget for Hermes', () => {
    expect(runtimeWaitAttempts('openclaw')).toBe(240);
    expect(runtimeWaitAttempts('hermes')).toBe(480);
  });

  it('retries transient tailnet failures and returns on the first healthy response', async () => {
    const responses: Array<Error | Response> = [
      new Error('dns pending'),
      new Response('starting', { status: 503 }),
      new Response('ready', { status: 200 }),
    ];
    const fetchImpl = jest.fn(async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next as Response;
    }) as any;
    const sleepImpl = jest.fn(async () => {});
    await expect(
      waitForRuntimeReady('https://aideploy-adp-ready.example.ts.net', { fetchImpl, sleepImpl, attempts: 3, delayMs: 1 })
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps state and gives a resume/log path when readiness times out', async () => {
    const fetchImpl = jest.fn(async () => new Response('no', { status: 503 })) as any;
    await expect(
      waitForRuntimeReady('https://aideploy-adp-stuck.example.ts.net', {
        fetchImpl,
        sleepImpl: async () => {},
        attempts: 2,
        delayMs: 1,
        deployId: 'adp-stuck01',
      })
    ).rejects.toThrow(/state was kept.*--deploy-id adp-stuck01.*aideploy-bootstrap\.log/i);
  });

  it('does not declare a structured bootstrap status ready while it is still running', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ state: 'running', step: 'openclaw_remote_gateway' }),
        {
          status: 200,
          headers: { 'x-aideploy-bootstrap-status': '1' },
        }
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ state: 'ready', step: 'complete' }),
        {
          status: 200,
          headers: { 'x-aideploy-bootstrap-status': '1' },
        }
      )) as any;
    const sleepImpl = jest.fn(async () => {});

    await expect(
      waitForRuntimeReady('https://aideploy-adp-ready.example.ts.net/_aideploy/status', {
        fetchImpl,
        sleepImpl,
        attempts: 2,
        delayMs: 1,
      })
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it('fails early with the sanitized private bootstrap phase', async () => {
    const fetchImpl = jest.fn(async () => new Response(
      JSON.stringify({
        state: 'failed',
        step: 'gstack_install',
        message: 'Setup failed with exit code 1.',
      }),
      {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'x-aideploy-bootstrap-status': '1',
        },
      }
    )) as any;
    await expect(
      waitForRuntimeReady('https://aideploy-adp-failed.example.ts.net', {
        fetchImpl,
        sleepImpl: async () => {},
        attempts: 20,
        delayMs: 1,
        deployId: 'adp-failed01',
      })
    ).rejects.toThrow(/failed during gstack_install.*--deploy-id adp-failed01/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
