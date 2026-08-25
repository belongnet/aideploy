import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { deployDir, UserError } from '../src/config.js';
import { up, waitForRuntimeReady } from '../src/deploy.js';
import { down } from '../src/down.js';
import { main, runWithSignals } from '../src/index.js';
import { INTERRUPT_GRACE_MS, InterruptedError, abortable, execCommand } from '../src/tofu.js';

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const accountUuid = '11111111-2222-4333-8444-555555555555';
const secrets = {
  doToken: `dop_v1_${'a'.repeat(64)}`,
  aiApiKey: `sk-test-${'x'.repeat(24)}`,
  aiProvider: 'openai' as const,
  telegramBotToken: `123456789:${'A'.repeat(35)}`,
  telegramUserId: '123456789',
  tailscaleAuthKey: 'tskey-auth-xyz123',
};
const baseOpts = {
  cloud: 'do' as const,
  runtime: 'openclaw' as const,
  region: 'nyc3',
  channel: 'telegram' as const,
  telemetryConsent: false,
  cliVersion: '0.0.1-test',
};

let home: string;
let assets: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aideploy-interrupt-home-'));
  process.env.AIDEPLOY_HOME = home;
  assets = mkdtempSync(join(tmpdir(), 'aideploy-interrupt-assets-'));
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
  delete process.env.AIDEPLOY_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(assets, { recursive: true, force: true });
});

function doApiFetch(): typeof fetch {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/account')) return okJson({ account: { uuid: accountUuid } });
    if (url.includes('/regions')) return okJson({ regions: [{ slug: 'nyc3', available: true }] });
    if (url.includes('/sizes')) {
      return okJson({
        sizes: [{ slug: 's-2vcpu-4gb', available: true, memory: 4096, regions: ['nyc3'] }],
      });
    }
    return okJson({});
  }) as unknown as typeof fetch;
}

function writeStateFromArgs(args: string[]): string {
  const stateArg = args.find((arg) => arg.startsWith('-state='));
  if (!stateArg) throw new Error('test apply did not receive a state path');
  const statePath = stateArg.slice('-state='.length);
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 4,
      resources: [
        {
          mode: 'managed',
          type: 'digitalocean_droplet',
          name: 'agent',
          instances: [{ schema_version: 1, attributes: { id: '123456789' } }],
        },
      ],
    })
  );
  chmodSync(statePath, 0o644);
  return statePath;
}

function tofuOutput(): string {
  return JSON.stringify({
    droplet_ip: { value: '203.0.113.7' },
    tailscale_hostname: { value: 'aideploy-adp-interrupt' },
    gateway_token: { value: 'gateway-token-123' },
  });
}

async function destroySavedDeploy(
  deployId: string,
  expectedResources: 'managed' | 'absent' = 'managed'
): Promise<void> {
  const dir = deployDir(deployId);
  const statePath = join(dir, 'terraform.tfstate');
  const exec = jest.fn(async (
    _cmd: string,
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; interruptGraceMs?: number | null }
  ) => {
    if (args[0] === 'destroy') {
      expect(args).toEqual([
        'destroy',
        '-auto-approve',
        '-input=false',
        '-no-color',
        `-state=${statePath}`,
      ]);
      expect(opts?.interruptGraceMs).toBeNull();
      expect(opts?.env?.TF_CLI_ARGS_destroy).toBe(
        `-var-file=${join(dir, 'deploy.auto.tfvars.json')} -var-file=${join(dir, 'secrets.auto.tfvars.json')}`
      );
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { resources?: Array<{ type?: string }> };
      if (expectedResources === 'managed') {
        expect(state.resources?.some((resource) => resource.type === 'digitalocean_droplet')).toBe(true);
      } else {
        expect(state.resources).toEqual([]);
      }
    }
    return { stdout: '', code: 0 };
  }) as any;
  await down(deployId, {
    exec,
    ensureTofuImpl: jest.fn(async () => '/fake/tofu') as any,
    assetsDir: assets,
    log: () => {},
  });
  expect(exec.mock.calls.some((call: any[]) => call[1][0] === 'destroy')).toBe(true);
  expect(existsSync(join(dir, 'terraform.tfstate'))).toBe(false);
  expect(existsSync(join(dir, 'secrets.auto.tfvars.json'))).toBe(false);
  expect(existsSync(join(dir, 'destroyed.json'))).toBe(true);
}

describe('signal lifecycle', () => {
  it('returns 130 with recovery guidance for an interrupted mutable command', async () => {
    const controller = new AbortController();
    controller.abort(new InterruptedError('SIGINT'));
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(main(['up', '--yes-telemetry'], { signal: controller.signal })).resolves.toBe(130);
      expect(stderr.mock.calls.flat().join('')).toMatch(/Interrupted safely.*state were kept private/i);
      expect(stderr.mock.calls.flat().join('')).toMatch(/--deploy-id <that-id>/);
    } finally {
      stderr.mockRestore();
    }
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('waits for graceful %s cleanup and removes process signal listeners', async (signalName, exitCode) => {
    const signalSource = new EventEmitter();
    let cleanupFinished = false;
    const run = runWithSignals(
      async (signal) => {
        try {
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return 0;
        } catch (error) {
          await new Promise((resolve) => setImmediate(resolve));
          cleanupFinished = true;
          if (error instanceof InterruptedError) return error.exitCode;
          throw error;
        }
      },
      signalSource as any
    );

    signalSource.emit(signalName);
    signalSource.emit(signalName);

    await expect(run).resolves.toBe(exitCode);
    expect(cleanupFinished).toBe(true);
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
  });

  it('observes work that rejects after an already-aborted race', async () => {
    const controller = new AbortController();
    controller.abort(new InterruptedError('SIGINT'));
    const then = jest.fn((_resolve: (value: never) => void, reject: (error: Error) => void) => {
      reject(new Error('late work failure'));
    });

    await expect(abortable({ then }, controller.signal)).rejects.toMatchObject({ exitCode: 130 });
    expect(then).toHaveBeenCalledTimes(1);
  });

  it('interrupts a spawned command with a conventional exit error', async () => {
    const controller = new AbortController();
    const command = execCommand(
      process.execPath,
      ['--input-type=module', '-e', 'setInterval(() => {}, 1000)'],
      { signal: controller.signal }
    );
    setTimeout(() => controller.abort(new InterruptedError('SIGINT')), 50);

    await expect(command).rejects.toMatchObject({ exitCode: 130, signal: 'SIGINT' });
  });

  it('isolates child commands from the CLI foreground process group', async () => {
    if (process.platform === 'win32') return;
    const parentGroup = (
      await execCommand('ps', ['-o', 'pgid=', '-p', String(process.pid)])
    ).stdout.trim();
    const childGroup = (await execCommand('sh', ['-c', 'ps -o pgid= -p $$'])).stdout.trim();
    expect(childGroup).not.toBe(parentGroup);
  });

  it('force-kills an unresponsive child after the bounded interrupt grace period', async () => {
    expect(INTERRUPT_GRACE_MS).toBe(5000);
    const controller = new AbortController();
    const readyPath = join(home, 'ignore-signal-ready');
    const command = execCommand(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { writeFileSync } from 'node:fs'; process.on('SIGINT', () => {}); writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setInterval(() => {}, 1000);`,
      ],
      { signal: controller.signal, interruptGraceMs: 50 }
    );
    for (let attempt = 0; attempt < 50 && !existsSync(readyPath); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(readyPath)).toBe(true);
    const startedAt = Date.now();
    controller.abort(new InterruptedError('SIGTERM'));

    await expect(command).rejects.toMatchObject({ exitCode: 143, signal: 'SIGTERM' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
  });

  it('force-kills an unresponsive command process group including descendants', async () => {
    if (process.platform === 'win32') return;
    const controller = new AbortController();
    const readyPath = join(home, 'process-group-pids');
    const grandchildSource = "process.on('SIGINT', () => {}); setInterval(() => {}, 1000);";
    const parentSource = [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "process.on('SIGINT', () => {});",
      `const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(grandchildSource)}], { stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(readyPath)}, process.pid + '\\n' + child.pid + '\\n');`,
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const command = execCommand(
      process.execPath,
      ['--input-type=module', '-e', parentSource],
      { signal: controller.signal, interruptGraceMs: 50 }
    );
    for (let attempt = 0; attempt < 100 && !existsSync(readyPath); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(readyPath)).toBe(true);
    const pids = readFileSync(readyPath, 'utf8').trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    controller.abort(new InterruptedError('SIGINT'));
    await expect(command).rejects.toMatchObject({ exitCode: 130 });

    const isLive = async (pid: number) => {
      try {
        const { stdout } = await execCommand('ps', ['-o', 'stat=', '-p', String(pid)]);
        const state = stdout.trim();
        return state.length > 0 && !state.startsWith('Z');
      } catch {
        return false;
      }
    };
    for (let attempt = 0; attempt < 100 && (await Promise.all(pids.map(isLive))).some(Boolean); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect(Promise.all(pids.map(isLive))).resolves.toEqual([false, false]);
  });

  it('does not schedule forced termination when graceful cleanup is required', async () => {
    const controller = new AbortController();
    const readyPath = join(home, 'graceful-state-ready');
    const command = execCommand(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { writeFileSync } from 'node:fs'; process.on('SIGINT', () => setTimeout(() => process.exit(0), 75)); writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setInterval(() => {}, 1000);`,
      ],
      { signal: controller.signal, interruptGraceMs: null }
    );
    for (let attempt = 0; attempt < 50 && !existsSync(readyPath); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(readyPath)).toBe(true);
    const timerSpy = jest.spyOn(global, 'setTimeout');
    try {
      controller.abort(new InterruptedError('SIGINT'));
      expect(timerSpy).not.toHaveBeenCalled();
    } finally {
      timerSpy.mockRestore();
    }
    await expect(command).rejects.toMatchObject({ exitCode: 130 });
  });
});

describe('deployment recovery', () => {
  it('scrubs local secrets when OpenTofu confirms resources are already absent', async () => {
    const deployId = 'adp-alreadygone';
    const dir = deployDir(deployId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'terraform.tfstate'), JSON.stringify({ version: 4, resources: [] }));
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ deployId, cloud: 'do', runtime: 'openclaw', region: 'nyc3', cliVersion: '0.0.1-test' })
    );
    writeFileSync(join(dir, 'deploy.auto.tfvars.json'), '{}');
    writeFileSync(join(dir, 'secrets.auto.tfvars.json'), '{"do_token":"secret"}');

    await destroySavedDeploy(deployId, 'absent');
  });

  it('secures state after an interrupted apply and can tear the checkpoint down', async () => {
    const deployId = 'adp-interrupt1';
    const controller = new AbortController();
    const exec = jest.fn(async (
      _cmd: string,
      args: string[],
      opts?: { signal?: AbortSignal; interruptGraceMs?: number | null }
    ) => {
      if (args[0] === 'apply') {
        expect(opts?.interruptGraceMs).toBeNull();
        writeStateFromArgs(args);
        setImmediate(() => controller.abort(new InterruptedError('SIGINT')));
        return await new Promise<never>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true });
        });
      }
      if (args[0] === 'output') return { stdout: tofuOutput(), code: 0 };
      return { stdout: '', code: 0 };
    }) as any;

    await expect(
      up({ ...baseOpts, deployId }, secrets, {
        exec,
        ensureTofuImpl: jest.fn(async () => '/fake/tofu') as any,
        fetchImpl: doApiFetch(),
        assetsDir: assets,
        tailnetInfoImpl: jest.fn(async () => ({ dnsSuffix: 'example.ts.net' })) as any,
        signal: controller.signal,
        log: () => {},
      })
    ).rejects.toBeInstanceOf(InterruptedError);

    const dir = deployDir(deployId);
    expect(statSync(join(dir, 'terraform.tfstate')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, 'secrets.auto.tfvars.json'))).toBe(true);
    expect(existsSync(join(dir, 'destroyed.json'))).toBe(false);
    await destroySavedDeploy(deployId);
  });

  it('can tear down partial state written before a quota failure', async () => {
    const deployId = 'adp-quota001';
    const exec = jest.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'apply') {
        writeStateFromArgs(args);
        throw new UserError('quota exceeded');
      }
      return { stdout: '', code: 0 };
    }) as any;

    await expect(
      up({ ...baseOpts, deployId }, secrets, {
        exec,
        ensureTofuImpl: jest.fn(async () => '/fake/tofu') as any,
        fetchImpl: doApiFetch(),
        assetsDir: assets,
        tailnetInfoImpl: jest.fn(async () => ({ dnsSuffix: 'example.ts.net' })) as any,
        log: () => {},
      })
    ).rejects.toThrow(/quota exceeded/);

    await destroySavedDeploy(deployId);
  });

  it('can tear down a VM after a structured bootstrap failure', async () => {
    const deployId = 'adp-bootfail';
    const exec = jest.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'apply') writeStateFromArgs(args);
      if (args[0] === 'output') return { stdout: tofuOutput(), code: 0 };
      return { stdout: '', code: 0 };
    }) as any;
    const waitForRuntimeImpl = (url: string) =>
      waitForRuntimeReady(url, {
        attempts: 1,
        delayMs: 1,
        deployId,
        fetchImpl: jest.fn(async () =>
          new Response(
            JSON.stringify({ state: 'failed', step: 'runtime_bootstrap', message: 'Setup failed.' }),
            { status: 503, headers: { 'x-aideploy-bootstrap-status': '1' } }
          )) as any,
      });

    await expect(
      up({ ...baseOpts, deployId }, secrets, {
        exec,
        ensureTofuImpl: jest.fn(async () => '/fake/tofu') as any,
        fetchImpl: doApiFetch(),
        assetsDir: assets,
        tailnetInfoImpl: jest.fn(async () => ({ dnsSuffix: 'example.ts.net' })) as any,
        waitForRuntimeImpl,
        log: () => {},
      })
    ).rejects.toThrow(/bootstrap failed during runtime_bootstrap.*--deploy-id adp-bootfail/i);

    await destroySavedDeploy(deployId);
  });

  it('keeps state and credentials if teardown itself is interrupted', async () => {
    const deployId = 'adp-downstop';
    const dir = deployDir(deployId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'terraform.tfstate'), JSON.stringify({ version: 4, resources: [] }));
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ deployId, cloud: 'do', runtime: 'openclaw', region: 'nyc3', cliVersion: '0.0.1-test' })
    );
    writeFileSync(join(dir, 'deploy.auto.tfvars.json'), '{}');
    writeFileSync(join(dir, 'secrets.auto.tfvars.json'), '{"do_token":"secret"}');
    writeFileSync(join(dir, 'terraform.tfstate.backup'), '{"serial":1}');
    writeFileSync(join(dir, 'access.json'), '{"gatewayToken":"secret"}');
    mkdirSync(join(dir, '.terraform'), { recursive: true });
    for (const name of ['terraform.tfstate.backup', 'access.json']) {
      chmodSync(join(dir, name), 0o644);
    }
    chmodSync(join(dir, '.terraform'), 0o755);
    const controller = new AbortController();
    const exec = jest.fn(async (
      _cmd: string,
      args: string[],
      opts?: { signal?: AbortSignal; interruptGraceMs?: number | null }
    ) => {
      if (args[0] !== 'destroy') return { stdout: '', code: 0 };
      expect(opts?.interruptGraceMs).toBeNull();
      setImmediate(() => controller.abort(new InterruptedError('SIGINT')));
      return await new Promise<never>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true });
      });
    }) as any;

    await expect(
      down(deployId, {
        exec,
        ensureTofuImpl: jest.fn(async () => '/fake/tofu') as any,
        assetsDir: assets,
        log: () => {},
        signal: controller.signal,
      })
    ).rejects.toBeInstanceOf(InterruptedError);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const name of [
      'terraform.tfstate',
      'config.json',
      'deploy.auto.tfvars.json',
      'secrets.auto.tfvars.json',
      'terraform.tfstate.backup',
      'access.json',
    ]) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
    expect(statSync(join(dir, '.terraform')).mode & 0o777).toBe(0o700);
    expect(existsSync(join(dir, 'terraform.tfstate'))).toBe(true);
    expect(readFileSync(join(dir, 'secrets.auto.tfvars.json'), 'utf8')).toContain('secret');
    expect(existsSync(join(dir, 'destroyed.json'))).toBe(false);
  });

  it('stops readiness retries when the outer deployment signal aborts', async () => {
    const controller = new AbortController();
    const sleepImpl = jest.fn(async () => {});
    const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
      setImmediate(() => controller.abort(new InterruptedError('SIGTERM')));
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as any;

    await expect(
      waitForRuntimeReady('https://aideploy-adp-stopped.example.ts.net', {
        fetchImpl,
        sleepImpl,
        attempts: 20,
        delayMs: 1,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ exitCode: 143, signal: 'SIGTERM' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('clears the default readiness backoff timer immediately on interruption', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    try {
      const wait = waitForRuntimeReady('https://aideploy-adp-backoff.example.ts.net', {
        fetchImpl: jest.fn(async () => new Response('starting', { status: 503 })) as any,
        attempts: 2,
        delayMs: 5000,
        signal: controller.signal,
      });
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(jest.getTimerCount()).toBe(1);
      controller.abort(new InterruptedError('SIGINT'));
      await expect(wait).rejects.toMatchObject({ exitCode: 130 });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('times out an individual stalled readiness request', async () => {
    let requestSignal: AbortSignal | null = null;
    const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as any;

    await expect(
      waitForRuntimeReady('https://aideploy-adp-timeout.example.ts.net', {
        fetchImpl,
        attempts: 1,
        delayMs: 1,
        requestTimeoutMs: 10,
      })
    ).rejects.toThrow(/did not become reachable/);
    expect(requestSignal).not.toBeNull();
    expect(requestSignal!.aborted).toBe(true);
  });

  it('preserves the readiness timeout signal through up orchestration', async () => {
    const deployId = 'adp-readysig';
    const controller = new AbortController();
    let readinessSignal: AbortSignal | null = null;
    const fetchImpl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/account')) return okJson({ account: { uuid: accountUuid } });
      if (url.includes('/regions')) return okJson({ regions: [{ slug: 'nyc3', available: true }] });
      if (url.includes('/sizes')) {
        return okJson({
          sizes: [{ slug: 's-2vcpu-4gb', available: true, memory: 4096, regions: ['nyc3'] }],
        });
      }
      if (url.includes('/droplets?')) return okJson({ droplets: [] });
      readinessSignal = init?.signal as AbortSignal;
      setImmediate(() => controller.abort(new InterruptedError('SIGINT')));
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as any;
    const exec = jest.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'apply') writeStateFromArgs(args);
      if (args[0] === 'output') return { stdout: tofuOutput(), code: 0 };
      return { stdout: '', code: 0 };
    }) as any;

    await expect(
      up({ ...baseOpts, deployId }, secrets, {
        exec,
        ensureTofuImpl: jest.fn(async () => '/fake/tofu') as any,
        fetchImpl,
        assetsDir: assets,
        tailnetInfoImpl: jest.fn(async () => ({ dnsSuffix: 'example.ts.net' })) as any,
        signal: controller.signal,
        log: () => {},
      })
    ).rejects.toBeInstanceOf(InterruptedError);
    expect(readinessSignal).not.toBeNull();
    expect(readinessSignal).not.toBe(controller.signal);
    expect(readinessSignal!.aborted).toBe(true);
  });

  it('reports an interruption that arrives during completion telemetry', async () => {
    const deployId = 'adp-pingstop';
    const controller = new AbortController();
    const fetchImpl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/account')) return okJson({ account: { uuid: accountUuid } });
      if (url.includes('/regions')) return okJson({ regions: [{ slug: 'nyc3', available: true }] });
      if (url.includes('/sizes')) {
        return okJson({
          sizes: [{ slug: 's-2vcpu-4gb', available: true, memory: 4096, regions: ['nyc3'] }],
        });
      }
      if (url.includes('/droplets?')) return okJson({ droplets: [] });
      if (url === 'https://ping.aideploy.co/v1/event') {
        setImmediate(() => controller.abort(new InterruptedError('SIGTERM')));
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      return new Response('ready', { status: 200 });
    }) as any;
    const exec = jest.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'apply') writeStateFromArgs(args);
      if (args[0] === 'output') return { stdout: tofuOutput(), code: 0 };
      return { stdout: '', code: 0 };
    }) as any;

    await expect(
      up({ ...baseOpts, deployId, telemetryConsent: true }, secrets, {
        exec,
        ensureTofuImpl: jest.fn(async () => '/fake/tofu') as any,
        fetchImpl,
        assetsDir: assets,
        tailnetInfoImpl: jest.fn(async () => ({ dnsSuffix: 'example.ts.net' })) as any,
        signal: controller.signal,
        log: () => {},
      })
    ).rejects.toMatchObject({ exitCode: 143, signal: 'SIGTERM' });
  });
});
