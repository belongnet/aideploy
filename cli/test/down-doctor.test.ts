import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { down } from '../src/down.js';
import { doctor } from '../src/doctor.js';
import { deployDir } from '../src/config.js';

let home: string;
let assets: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aideploy-home-'));
  process.env.AIDEPLOY_HOME = home;
  assets = mkdtempSync(join(tmpdir(), 'aideploy-assets-'));
  mkdirSync(join(assets, 'terraform', 'digitalocean'), { recursive: true });
  writeFileSync(join(assets, 'opentofu.json'), JSON.stringify({ version: '1.10.3', baseUrl: 'https://x.invalid', sha256: {} }));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(assets, { recursive: true, force: true });
});

describe('down', () => {
  it('rejects traversal ids before looking for state', async () => {
    await expect(down('../../tmp/owned', { assetsDir: assets })).rejects.toThrow(/Invalid deploy id/);
  });

  it('missing state => UserError pointing at doctor + manual cleanup, no tofu call', async () => {
    const exec = jest.fn() as any;
    await expect(down('adp-ghost1', { exec, assetsDir: assets })).rejects.toThrow(/aideploy doctor/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('happy path: runs tofu destroy against the saved state', async () => {
    const dir = deployDir('adp-gone01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'terraform.tfstate'), JSON.stringify({ version: 4, resources: [] }));
    writeFileSync(join(dir, 'terraform.tfstate.backup'), 'secret backup');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ deployId: 'adp-gone01', cloud: 'do', runtime: 'openclaw', region: 'nyc3', cliVersion: '0.0.1' }));
    writeFileSync(join(dir, 'deploy.auto.tfvars.json'), '{}');
    writeFileSync(join(dir, 'secrets.auto.tfvars.json'), '{}');
    writeFileSync(join(dir, 'access.json'), '{"password":"owner-secret"}');
    const calls: string[][] = [];
    const exec = jest.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { stdout: '', code: 0 };
    }) as any;
    await down('adp-gone01', { exec, ensureTofuImpl: jest.fn(async () => '/fake/tofu') as any, assetsDir: assets, log: () => {} });
    expect(calls.some((c) => c[1] === 'destroy')).toBe(true);
    for (const name of ['terraform.tfstate', 'terraform.tfstate.backup', 'config.json', 'deploy.auto.tfvars.json', 'secrets.auto.tfvars.json', 'access.json']) {
      expect(existsSync(join(dir, name))).toBe(false);
    }
    const receiptPath = join(dir, 'destroyed.json');
    expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
    const receipt = readFileSync(receiptPath, 'utf8');
    expect(receipt).toContain('adp-gone01');
    expect(receipt).not.toContain('do_token');
  });

  it('keeps state and credentials when destroy fails', async () => {
    const dir = deployDir('adp-keep01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'terraform.tfstate'), JSON.stringify({ version: 4, resources: [] }));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ deployId: 'adp-keep01', cloud: 'do', runtime: 'openclaw', region: 'nyc3' }));
    writeFileSync(join(dir, 'deploy.auto.tfvars.json'), '{}');
    writeFileSync(join(dir, 'secrets.auto.tfvars.json'), '{"do_token":"secret"}');
    const exec = jest.fn(async () => { throw new Error('provider unavailable'); }) as any;
    await expect(
      down('adp-keep01', { exec, ensureTofuImpl: jest.fn(async () => '/fake/tofu') as any, assetsDir: assets, log: () => {} })
    ).rejects.toThrow(/provider unavailable/);
    expect(existsSync(join(dir, 'terraform.tfstate'))).toBe(true);
    expect(existsSync(join(dir, 'secrets.auto.tfvars.json'))).toBe(true);
    expect(existsSync(join(dir, 'destroyed.json'))).toBe(false);
  });

  it('refuses to destroy state with infrastructure assets from a different CLI release', async () => {
    const dir = deployDir('adp-version1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'terraform.tfstate'), JSON.stringify({ version: 4, resources: [] }));
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        deployId: 'adp-version1',
        cloud: 'do',
        runtime: 'openclaw',
        region: 'nyc3',
        cliVersion: '0.4.2-beta.1',
      })
    );
    writeFileSync(join(dir, 'deploy.auto.tfvars.json'), '{}');
    writeFileSync(join(dir, 'secrets.auto.tfvars.json'), '{}');
    const exec = jest.fn() as any;
    await expect(
      down('adp-version1', { exec, assetsDir: assets, cliVersion: '0.4.2-beta.2' })
    ).rejects.toThrow(/npx aideploy@0\.4\.2-beta\.1 down adp-version1/);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('doctor', () => {
  const droplets = {
    droplets: [
      { id: 1, name: 'aideploy-adp-live01', tags: ['aideploy', 'aideploy-adp-live01'], networks: { v4: [{ type: 'public', ip_address: '203.0.113.9' }] } },
      { id: 2, name: 'aideploy-adp-orphan', tags: ['aideploy', 'aideploy-adp-orphan'], networks: { v4: [] } },
    ],
  };

  it('flags cloud droplets with no local state as orphans', async () => {
    mkdirSync(join(home, 'adp-live01'), { recursive: true });
    writeFileSync(join(home, 'adp-live01', 'terraform.tfstate'), JSON.stringify({ version: 4, resources: [] }));
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify(droplets), { status: 200 })) as any;
    const report = await doctor('dop_v1_' + 'a'.repeat(64), { fetchImpl, log: () => {} });
    expect(report.localDeploys).toEqual(['adp-live01']);
    expect(report.destroyedDeploys).toEqual([]);
    expect(report.missingStateDeploys).toEqual([]);
    expect(report.invalidStateDeploys).toEqual([]);
    expect(report.orphans).toEqual(['aideploy-adp-orphan']);
    expect(fetchImpl.mock.calls[0][0]).toContain('tag_name=aideploy');
  });

  it('does not mistake empty or corrupt directories for usable local state', async () => {
    mkdirSync(join(home, 'adp-empty01'), { recursive: true });
    mkdirSync(join(home, 'adp-broken1'), { recursive: true });
    writeFileSync(join(home, 'adp-broken1', 'terraform.tfstate'), '{not-json');
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify(droplets), { status: 200 })) as any;
    const report = await doctor('dop_v1_' + 'a'.repeat(64), { fetchImpl, log: () => {} });
    expect(report.localDeploys).toEqual([]);
    expect(report.missingStateDeploys).toEqual(['adp-empty01']);
    expect(report.invalidStateDeploys).toEqual(['adp-broken1']);
    expect(report.orphans).toEqual(['aideploy-adp-live01', 'aideploy-adp-orphan']);
  });

  it('recognizes a scrubbed destroy receipt without calling it missing state', async () => {
    mkdirSync(join(home, 'adp-old0001'), { recursive: true });
    writeFileSync(join(home, 'adp-old0001', 'destroyed.json'), '{"deployId":"adp-old0001"}');
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ droplets: [] }), { status: 200 })) as any;
    const report = await doctor('dop_v1_' + 'a'.repeat(64), { fetchImpl, log: () => {} });
    expect(report.destroyedDeploys).toEqual(['adp-old0001']);
    expect(report.missingStateDeploys).toEqual([]);
  });

  it('requires a token with a clear error', async () => {
    await expect(doctor(undefined, { log: () => {} })).rejects.toThrow(/DigitalOcean API token/);
  });

  it('surfaces 401 clearly', async () => {
    const fetchImpl = jest.fn(async () => new Response('no', { status: 401 })) as any;
    await expect(doctor('bad-token', { fetchImpl, log: () => {} })).rejects.toThrow(/401/);
  });
});
