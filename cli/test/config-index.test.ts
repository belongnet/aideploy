import { assertDeployId, assertNodeVersion, deployDir, newDeployId, resourceTag, UserError } from '../src/config.js';
import { isDirectExecution, main } from '../src/index.js';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

describe('assertNodeVersion', () => {
  it('rejects Node below the 18.3 floor with instructions, not a stack trace', () => {
    expect(() => assertNodeVersion('16.20.0')).toThrow(/requires Node 18\.3/);
    expect(() => assertNodeVersion('18.2.0')).toThrow(UserError);
  });
  it('accepts current Node', () => {
    expect(() => assertNodeVersion('18.3.0')).not.toThrow();
    expect(() => assertNodeVersion('22.18.0')).not.toThrow();
  });
});

describe('ids and tags', () => {
  it('deploy ids are short, prefixed, and cloud-tag safe', () => {
    const id = newDeployId();
    expect(id).toMatch(/^adp-[0-9a-f]{8}$/);
    expect(resourceTag(id)).toBe(`aideploy-${id}`);
    expect(resourceTag(id)).not.toContain(':'); // DO tags reject colons
  });

  it('rejects path traversal and non-canonical custom ids before resolving state', () => {
    for (const id of ['../../tmp/owned', 'adp-../owned', 'ADP-UPPER', 'adp-under_score', 'adp-', `adp-${'a'.repeat(60)}`]) {
      expect(() => assertDeployId(id)).toThrow(/Invalid deploy id/);
      expect(() => deployDir(id)).toThrow(UserError);
    }
  });
});

describe('main (arg surface)', () => {
  it('help exits 0 and shows the 4 prerequisites + hosted-wizard route', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => (chunks.push(String(s)), true);
    try {
      expect(await main(['help'])).toBe(0);
    } finally {
      (process.stdout as any).write = orig;
    }
    const out = chunks.join('');
    expect(out).toMatch(/BotFather/);
    expect(out).toMatch(/Tailscale/);
    expect(out).toMatch(/Kimi/);
    expect(out).toMatch(/utm_source=cli/);
  });

  it('unknown command exits 1 with guidance', async () => {
    expect(await main(['frobnicate'])).toBe(1);
  });

  it('unsupported cloud is a clear golden-path error', async () => {
    expect(await main(['up', '--cloud', 'aws'])).toBe(1);
  });

  it('unknown runtime is rejected', async () => {
    expect(await main(['up', '--runtime', 'skynet'])).toBe(1);
  });

  it('down without a deploy id prints usage', async () => {
    expect(await main(['down'])).toBe(1);
  });

  it('turns parser failures into short user errors instead of throwing internals', async () => {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => (chunks.push(String(s)), true);
    try {
      expect(await main(['up', '--unknown-option'])).toBe(1);
      expect(await main(['up', '--region'])).toBe(1);
    } finally {
      (process.stderr as any).write = orig;
    }
    const out = chunks.join('');
    expect(out).toMatch(/Invalid command arguments/);
    expect(out).toMatch(/aideploy help/);
    expect(out).not.toMatch(/\n\s+at /);
  });

  it('never accepts a DigitalOcean token in argv', async () => {
    const token = 'dop_v1_' + 'b'.repeat(64);
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => (chunks.push(String(s)), true);
    try {
      expect(await main(['doctor', '--do-token', token])).toBe(1);
    } finally {
      (process.stderr as any).write = orig;
    }
    expect(chunks.join('')).toMatch(/never accepted on the command line/);
    expect(chunks.join('')).not.toContain(token);
  });
});

describe('npm bin direct execution', () => {
  it('resolves the npm-created symlink before comparing module URLs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aideploy-bin-'));
    try {
      const target = join(dir, 'index.js');
      const bin = join(dir, 'aideploy');
      writeFileSync(target, '#!/usr/bin/env node\n');
      symlinkSync(target, bin);
      expect(isDirectExecution(pathToFileURL(target).href, bin)).toBe(true);
      expect(isDirectExecution(pathToFileURL(target).href, join(dir, 'missing'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
