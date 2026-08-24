import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { TofuManifest, compatibleSystemTofu, ensureTofu, platformKey, sha256 } from '../src/tofu.js';
import { UserError } from '../src/config.js';

const zipBytes = Buffer.from('fake-zip-bytes-for-checksum');
const manifest = (over: Partial<TofuManifest> = {}): TofuManifest => ({
  version: '1.10.3',
  baseUrl: 'https://example.invalid/download',
  sha256: { darwin_arm64: sha256(zipBytes), linux_amd64: sha256(zipBytes) },
  ...over,
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aideploy-test-'));
  process.env.AIDEPLOY_HOME = home;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('platformKey', () => {
  it('maps darwin/arm64 and linux/x64', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin_arm64');
    expect(platformKey('linux', 'x64')).toBe('linux_amd64');
  });
  it('rejects unsupported platforms with a clear error', () => {
    expect(() => platformKey('win32' as NodeJS.Platform, 'x64')).toThrow(UserError);
  });
});

describe('compatibleSystemTofu', () => {
  it('accepts a same-minor system binary', async () => {
    const exec = jest.fn(async () => ({ stdout: '{"terraform_version":"1.10.9"}', code: 0 })) as any;
    expect(await compatibleSystemTofu(manifest(), exec)).toBe('tofu');
  });
  it('rejects a different-minor system binary', async () => {
    const exec = jest.fn(async () => ({ stdout: '{"terraform_version":"1.8.0"}', code: 0 })) as any;
    expect(await compatibleSystemTofu(manifest(), exec)).toBeNull();
  });
  it('returns null when tofu is absent', async () => {
    const exec = jest.fn(async () => { throw new UserError('not found'); }) as any;
    expect(await compatibleSystemTofu(manifest(), exec)).toBeNull();
  });
});

describe('ensureTofu', () => {
  const noSystem = jest.fn(async (cmd: string, args: string[]) => {
    if (cmd === 'tofu') throw new UserError('no system tofu');
    if (cmd === 'unzip') {
      // emulate unzip extracting the binary
      const dir = args[args.length - 1];
      writeFileSync(join(dir, 'tofu'), '#!/bin/sh\n');
      return { stdout: '', code: 0 };
    }
    return { stdout: '', code: 0 };
  }) as any;

  it('downloads, verifies checksum, caches, and reuses the cache', async () => {
    const fetchImpl = jest.fn(async () => new Response(zipBytes, { status: 200 })) as any;
    const bin = await ensureTofu(manifest(), { execImpl: noSystem, fetchImpl, platform: 'darwin', arch: 'arm64' });
    expect(existsSync(bin)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // second call: cache hit, no new download
    await ensureTofu(manifest(), { execImpl: noSystem, fetchImpl, platform: 'darwin', arch: 'arm64' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('repairs a corrupted cached binary from the re-verified archive without trusting a marker', async () => {
    const fetchImpl = jest.fn(async () => new Response(zipBytes, { status: 200 })) as any;
    const bin = await ensureTofu(manifest(), { execImpl: noSystem, fetchImpl, platform: 'darwin', arch: 'arm64' });
    writeFileSync(bin, 'tampered-binary');
    await ensureTofu(manifest(), { execImpl: noSystem, fetchImpl, platform: 'darwin', arch: 'arm64' });
    expect(readFileSync(bin, 'utf8')).toBe('#!/bin/sh\n');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed on checksum mismatch', async () => {
    const fetchImpl = jest.fn(async () => new Response(Buffer.from('tampered-bytes'), { status: 200 })) as any;
    await expect(
      ensureTofu(manifest(), { execImpl: noSystem, fetchImpl, platform: 'darwin', arch: 'arm64' })
    ).rejects.toThrow(/checksum mismatch/i);
  });

  it('fails closed when a platform checksum is missing or malformed', async () => {
    const m = manifest({ sha256: { darwin_arm64: 'not-a-sha256' } });
    await expect(
      ensureTofu(m, { execImpl: noSystem, fetchImpl: jest.fn() as any, platform: 'darwin', arch: 'arm64' })
    ).rejects.toThrow(/release-packaging bug/i);
  });

  it('surfaces HTTP failures with the URL', async () => {
    const fetchImpl = jest.fn(async () => new Response('nope', { status: 503 })) as any;
    await expect(
      ensureTofu(manifest(), { execImpl: noSystem, fetchImpl, platform: 'linux', arch: 'x64' })
    ).rejects.toThrow(/HTTP 503/);
  });
});
