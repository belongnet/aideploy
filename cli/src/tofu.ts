import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { binDir, UserError } from './config.js';

/**
 * OpenTofu acquisition (design doc, eng review 3A):
 *  - exact version pinned in assets/opentofu.json
 *  - expected SHA256 per platform independently reviewed and committed
 *  - verified BEFORE first execution; checksum mismatch fails closed
 *  - cached at ~/.aideploy/bin/<version>/; corrupted cache re-verified
 *  - a preexisting system binary is used only if version-compatible
 * OpenTofu (MPL-2.0) rather than Terraform (BUSL) keeps the license story clean.
 */
export interface TofuManifest {
  version: string;
  baseUrl: string; // e.g. https://github.com/opentofu/opentofu/releases/download
  sha256: Record<string, string>; // "<os>_<arch>" -> reviewed release-archive sha256
}

export interface TofuDeps {
  fetchImpl?: typeof fetch;
  execImpl?: typeof execCommand;
  platform?: NodeJS.Platform;
  arch?: string;
  signal?: AbortSignal;
}

type InterruptSignal = 'SIGINT' | 'SIGTERM';
export const INTERRUPT_GRACE_MS = 5000;

/** A graceful process interruption with the conventional shell exit code. */
export class InterruptedError extends UserError {
  readonly exitCode: 130 | 143;
  readonly signal: InterruptSignal;

  constructor(signal: InterruptSignal) {
    super(`Interrupted by ${signal}.`);
    this.name = 'InterruptedError';
    this.signal = signal;
    this.exitCode = signal === 'SIGTERM' ? 143 : 130;
  }
}

export function interruptionError(signal?: AbortSignal): InterruptedError {
  return signal?.reason instanceof InterruptedError
    ? signal.reason
    : new InterruptedError('SIGINT');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw interruptionError(signal);
}

/** Race work against a user interrupt while still observing its eventual rejection. */
export function abortable<T>(work: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  const promise = Promise.resolve(work);
  if (!signal) return promise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (next: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      next();
    };
    const onAbort = () => finish(() => reject(interruptionError(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : null;
  if (!os || !cpu) {
    throw new UserError(
      `Unsupported platform ${platform}/${arch}. aideploy supports macOS and Linux on amd64/arm64. ` +
        'A compatible system OpenTofu binary does not make other operating systems safe because ' +
        'the CLI also requires POSIX process-group signal handling.'
    );
  }
  return `${os}_${cpu}`;
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Runs a command, resolving stdout; rejects with stderr on non-zero exit. */
export function execCommand(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: 'inherit' | 'pipe';
    signal?: AbortSignal;
    /**
     * Force-kill the isolated process group after this many milliseconds.
     * Use `null` for state-mutating commands that must finish their own
     * interrupt reconciliation before the caller exits.
     */
    interruptGraceMs?: number | null;
  } = {}
): Promise<{ stdout: string; code: number }> {
  throwIfAborted(opts.signal);
  return new Promise((resolve, reject) => {
    // A terminal sends Ctrl-C to every process in its foreground group. Give
    // the command its own group so the CLI can forward exactly one interrupt
    // instead of turning one Ctrl-C into OpenTofu's unsafe second interrupt.
    const isolatedProcessGroup = process.platform !== 'win32';
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: opts.stdio === 'inherit' ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
      detached: isolatedProcessGroup,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;
    const cleanup = () => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (forceKill) clearTimeout(forceKill);
    };
    const finish = (next: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      next();
    };
    const onAbort = () => {
      signalChildGroup(child, 'SIGINT', isolatedProcessGroup);
      const interruptGraceMs =
        opts.interruptGraceMs === undefined ? INTERRUPT_GRACE_MS : opts.interruptGraceMs;
      if (interruptGraceMs !== null) {
        forceKill = setTimeout(
          () => signalChildGroup(child, 'SIGKILL', isolatedProcessGroup),
          interruptGraceMs
        );
        forceKill.unref();
      }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (err) =>
      finish(() =>
        reject(opts.signal?.aborted ? interruptionError(opts.signal) : new UserError(`failed to run ${cmd}: ${err.message}`))
      )
    );
    child.on('close', (code) => {
      finish(() => {
        if (opts.signal?.aborted) reject(interruptionError(opts.signal));
        else if (code === 0) resolve({ stdout, code: 0 });
        else reject(new UserError(`${cmd} ${args[0] ?? ''} exited ${code}${stderr ? `:\n${stderr.slice(-2000)}` : ''}`));
      });
    });
  });
}

function signalChildGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  isolatedProcessGroup: boolean
): void {
  if (!child.pid) return;
  if (isolatedProcessGroup) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already be gone; fall back to the child handle so an
      // independently surviving process still receives the shutdown signal.
    }
  }
  child.kill(signal);
}

/** True when a system `tofu` exists and matches the pinned minor version. */
export async function compatibleSystemTofu(
  manifest: TofuManifest,
  exec: typeof execCommand = execCommand,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const { stdout } = await exec('tofu', ['version', '-json'], { signal });
    const version = JSON.parse(stdout).terraform_version ?? JSON.parse(stdout).version;
    if (typeof version === 'string') {
      const [maj, min] = version.split('.');
      const [pmaj, pmin] = manifest.version.split('.');
      if (maj === pmaj && min === pmin) return 'tofu';
    }
    return null;
  } catch (error) {
    if (error instanceof InterruptedError || signal?.aborted) {
      throw interruptionError(signal);
    }
    return null;
  }
}

/**
 * Returns the path to a verified tofu binary, downloading + verifying if
 * needed. Fail-closed on any checksum problem.
 */
export async function ensureTofu(manifest: TofuManifest, deps: TofuDeps = {}): Promise<string> {
  const exec = deps.execImpl ?? execCommand;
  const fetchFn = deps.fetchImpl ?? fetch;
  throwIfAborted(deps.signal);

  // Validate the complete CLI platform contract before accepting a system
  // binary. On Windows, child.kill('SIGINT') is a hard termination rather than
  // OpenTofu's graceful state-writing interrupt path.
  const key = platformKey(deps.platform, deps.arch);

  const system = await compatibleSystemTofu(manifest, exec, deps.signal);
  if (system) return system;

  const expected = manifest.sha256[key];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new UserError(
      `Missing or invalid pinned checksum for platform ${key} in this build. ` +
        'This is a release-packaging bug — install OpenTofu manually (https://opentofu.org) and re-run.'
    );
  }

  const dir = binDir(manifest.version);
  const bin = join(dir, 'tofu');
  const zipPath = join(dir, 'tofu.zip');
  mkdirSync(dir, { recursive: true });

  // The manifest authenticates the archive, not a mutable local marker. On
  // every cache hit, hash the archive and compare the current binary with a
  // fresh extraction from that verified archive. This detects both archive
  // and binary corruption without downloading again for a healthy cache.
  if (existsSync(zipPath) && sha256(readFileSync(zipPath)) === expected) {
    await repairBinaryFromVerifiedArchive(zipPath, dir, bin, exec, deps.signal);
    return bin;
  }
  rmSync(zipPath, { force: true });
  rmSync(bin, { force: true });
  rmSync(join(dir, '.sha256'), { force: true });

  const url = `${manifest.baseUrl}/v${manifest.version}/tofu_${manifest.version}_${key}.zip`;
  process.stderr.write(`Downloading OpenTofu ${manifest.version} (${key})...\n`);
  const res = await abortable(fetchFn(url, { signal: deps.signal }), deps.signal);
  if (!res.ok) throw new UserError(`OpenTofu download failed: HTTP ${res.status} for ${url}`);
  const zip = Buffer.from(await abortable(res.arrayBuffer(), deps.signal));

  const actual = sha256(zip);
  if (actual !== expected) {
    throw new UserError(
      `OpenTofu download checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…). ` +
        'Refusing to execute an unverified binary. Re-run to retry, or install OpenTofu manually.'
    );
  }

  writeFileSync(zipPath, zip);
  await repairBinaryFromVerifiedArchive(zipPath, dir, bin, exec, deps.signal);
  return bin;
}

async function repairBinaryFromVerifiedArchive(
  zipPath: string,
  dir: string,
  bin: string,
  exec: typeof execCommand,
  signal?: AbortSignal
): Promise<void> {
  const verifyDir = mkdtempSync(join(dir, '.verify-'));
  try {
    await exec('unzip', ['-o', '-q', zipPath, 'tofu', '-d', verifyDir], { signal });
    let candidate = join(verifyDir, 'tofu');
    if (!existsSync(candidate)) {
      const windowsCandidate = join(verifyDir, 'tofu.exe');
      if (!existsSync(windowsCandidate)) {
        throw new UserError('OpenTofu archive did not contain the expected binary.');
      }
      candidate = windowsCandidate;
    }
    const verifiedBinaryHash = sha256(readFileSync(candidate));
    const cachedBinaryHash = existsSync(bin) ? sha256(readFileSync(bin)) : null;
    if (cachedBinaryHash !== verifiedBinaryHash) {
      rmSync(bin, { force: true });
      renameSync(candidate, bin);
    }
    chmodSync(bin, 0o755);
  } finally {
    rmSync(verifyDir, { recursive: true, force: true });
  }
}
