import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stagedPublicRoot = resolve(cliRoot, '../public-root');
const publicRoot = existsSync(join(stagedPublicRoot, 'stack/runtime/status_server.py'))
  ? stagedPublicRoot
  : resolve(cliRoot, '..');
const statusServer = join(publicRoot, 'stack/runtime/status_server.py');

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port');
  await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolveStop();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveStop();
    });
  });
}

describe('private bootstrap status server', () => {
  it('returns only sanitized status fields and keeps the root unready', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'aideploy-status-'));
    const statusFile = join(fixture, 'status.json');
    const port = await unusedPort();
    writeFileSync(statusFile, JSON.stringify({
      state: 'running',
      step: 'hermes_install',
      message: 'Installing Hermes',
      updatedAt: '2026-07-20T00:00:00Z',
      secret: 'must-not-leak',
    }));

    const child = spawn('python3', [statusServer], {
      env: {
        ...process.env,
        AIDEPLOY_STATUS_FILE: statusFile,
        AIDEPLOY_STATUS_PORT: String(port),
      },
      stdio: 'ignore',
    });

    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          response = await fetch(`http://127.0.0.1:${port}/_aideploy/status`);
          break;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        }
      }
      expect(response?.status).toBe(200);
      expect(response?.headers.get('cache-control')).toBe('no-store');
      expect(response?.headers.get('x-aideploy-bootstrap-status')).toBe('1');
      expect(await response?.json()).toEqual({
        state: 'running',
        step: 'hermes_install',
        message: 'Installing Hermes',
        updatedAt: '2026-07-20T00:00:00Z',
      });

      const root = await fetch(`http://127.0.0.1:${port}/`);
      expect(root.status).toBe(503);
      expect(root.headers.get('x-aideploy-bootstrap-status')).toBe('1');
      expect(await root.json()).toMatchObject({ state: 'running', step: 'hermes_install' });
    } finally {
      await stop(child);
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
