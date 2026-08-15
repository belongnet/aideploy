import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DeployConfig,
  Secrets,
  UserError,
  deployDir,
  newDeployId,
  resourceTag,
} from './config.js';
import { TofuManifest, ensureTofu, execCommand } from './tofu.js';
import {
  assertRegion,
  assertSize,
  fetchDoAccountUuid,
  fetchDoCatalog,
  DEFAULT_SIZE,
  DoCatalog,
} from './validate.js';
import { sendPing } from './telemetry.js';

/**
 * `aideploy up` orchestration (design doc, CLI v1 mechanics):
 * assets vendored into the npm package (version-aligned by construction),
 * state at ~/.aideploy/<deploy-id>/, resources tagged aideploy-<deploy-id>,
 * idempotent per deploy-id, teardown + doctor always printed.
 */
export interface UpOptions {
  deployId?: string;
  cloud: 'do';
  runtime: 'openclaw' | 'hermes';
  region: string;
  size?: string;
  channel: 'telegram';
  telemetryConsent: boolean;
  cliVersion: string;
}

export interface UpDeps {
  exec?: typeof execCommand;
  ensureTofuImpl?: typeof ensureTofu;
  fetchImpl?: typeof fetch;
  assetsDir?: string;
  manifest?: TofuManifest;
  log?: (msg: string) => void;
  waitForRuntimeImpl?: (url: string) => Promise<void>;
  tailnetInfoImpl?: typeof readTailnetInfo;
}

export function defaultAssetsDir(): string {
  // dist/deploy.js -> package root /assets (vendored terraform + manifest)
  return process.env.AIDEPLOY_ASSETS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
}

export function loadManifest(assetsDir: string): TofuManifest {
  const p = join(assetsDir, 'opentofu.json');
  if (!existsSync(p)) throw new UserError(`Missing OpenTofu manifest at ${p} (broken package).`);
  return JSON.parse(readFileSync(p, 'utf8')) as TofuManifest;
}

interface SecretTfvars {
  do_token: string;
  ai_provider: Secrets['aiProvider'];
  ai_api_key: string;
  telegram_bot_token: string;
  telegram_user_id: string;
  tailscale_auth_key: string;
}

function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  // writeFileSync's mode only applies on creation. Correct pre-existing files too.
  chmodSync(path, 0o600);
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function readJsonObject(path: string, label: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new UserError(`Cannot safely resume: ${label} is missing at ${path}. Run \`aideploy doctor\` before creating anything else.`);
  }
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object');
    return value as Record<string, unknown>;
  } catch {
    throw new UserError(`Cannot safely resume: ${label} at ${path} is not valid JSON. Run \`aideploy doctor\` before creating anything else.`);
  }
}

function secureStateFiles(dir: string): void {
  for (const name of ['terraform.tfstate', 'terraform.tfstate.backup']) {
    const path = join(dir, name);
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}

/** Start a child while a private umask is active, then restore the caller's umask. */
export function execPrivate<T>(operation: () => Promise<T>): Promise<T> {
  const previous = process.umask(0o077);
  try {
    return operation();
  } finally {
    process.umask(previous);
  }
}

/** Renders deployment inputs and enforces private permissions on every write. */
export function writeDeployFiles(dir: string, cfg: DeployConfig, secrets: Secrets): void {
  ensurePrivateDir(dir);
  writePrivateJson(join(dir, 'config.json'), cfg);
  const tfvars = {
    deploy_id: cfg.deployId,
    resource_tag: resourceTag(cfg.deployId),
    region: cfg.region,
    droplet_size: cfg.size,
    runtime: cfg.runtime,
    channel: cfg.channel,
    enable_tailscale: cfg.tailscale,
  };
  writePrivateJson(join(dir, 'deploy.auto.tfvars.json'), tfvars);
  const secretVars: SecretTfvars = {
    do_token: secrets.doToken,
    ai_provider: secrets.aiProvider,
    ai_api_key: secrets.aiApiKey,
    telegram_bot_token: secrets.telegramBotToken,
    telegram_user_id: secrets.telegramUserId,
    tailscale_auth_key: secrets.tailscaleAuthKey,
  };
  writePrivateJson(join(dir, 'secrets.auto.tfvars.json'), secretVars);
}

function validateResume(
  dir: string,
  requested: Omit<DeployConfig, 'createdAt' | 'cliVersion'>,
  suppliedSecrets: Secrets,
  currentCliVersion: string
): DeployConfig {
  const saved = readJsonObject(join(dir, 'config.json'), 'saved deployment config');
  const savedSecrets = readJsonObject(join(dir, 'secrets.auto.tfvars.json'), 'saved deployment credentials');
  readJsonObject(join(dir, 'deploy.auto.tfvars.json'), 'saved deployment variables');

  const savedProvider = saved.aiProvider ?? savedSecrets.ai_provider;
  const changedFields: string[] = [];
  const comparisons: Array<[string, unknown, unknown]> = [
    ['cloud', saved.cloud, requested.cloud],
    ['DigitalOcean account', saved.digitalOceanAccountUuid, requested.digitalOceanAccountUuid],
    ['runtime', saved.runtime, requested.runtime],
    ['region', saved.region, requested.region],
    ['size', saved.size, requested.size],
    ['channel', saved.channel, requested.channel],
    ['Tailscale setting', saved.tailscale, requested.tailscale],
    ['AI provider', savedProvider, requested.aiProvider],
  ];
  for (const [label, before, after] of comparisons) {
    if (before !== after) changedFields.push(label);
  }

  const runtimeSecretsMatch =
    savedSecrets.ai_provider === suppliedSecrets.aiProvider &&
    savedSecrets.ai_api_key === suppliedSecrets.aiApiKey &&
    savedSecrets.telegram_bot_token === suppliedSecrets.telegramBotToken &&
    savedSecrets.telegram_user_id === suppliedSecrets.telegramUserId &&
    savedSecrets.tailscale_auth_key === suppliedSecrets.tailscaleAuthKey;
  if (!runtimeSecretsMatch) changedFields.push('runtime credentials');

  if (saved.cliVersion !== currentCliVersion) changedFields.push('CLI version');

  if (saved.deployId !== requested.deployId) changedFields.push('deploy id');
  if (changedFields.length > 0) {
    throw new UserError(
      `Refusing to resume ${requested.deployId} because immutable inputs changed: ${changedFields.join(', ')}. ` +
        'Re-run with the original inputs, or choose a new --deploy-id for a replacement deployment.'
    );
  }
  if (typeof saved.createdAt !== 'string' || saved.createdAt.length === 0) {
    throw new UserError(`Cannot safely resume ${requested.deployId}: its saved config has no creation timestamp.`);
  }

  return {
    ...requested,
    createdAt: saved.createdAt,
    cliVersion: currentCliVersion,
  };
}

async function assertNoCloudDeployCollision(
  deployId: string,
  doToken: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const tag = resourceTag(deployId);
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.digitalocean.com/v2/droplets?tag_name=${encodeURIComponent(tag)}&per_page=1`,
      { headers: { Authorization: `Bearer ${doToken}`, 'Content-Type': 'application/json' } }
    );
  } catch {
    throw new UserError(`Could not verify that deploy id ${deployId} is unused in DigitalOcean. No resources were created; try again.`);
  }
  if (response.status === 401) throw new UserError('DigitalOcean rejected the API token (401).');
  if (!response.ok) throw new UserError(`DigitalOcean API error while checking deploy id ${deployId}: HTTP ${response.status}`);
  const body = (await response.json()) as { droplets?: unknown[] };
  if ((body.droplets ?? []).length > 0) {
    throw new UserError(
      `DigitalOcean already has a VM tagged ${tag}, but no usable local state exists. ` +
        'Run `aideploy doctor` and recover or remove that deployment before reusing this id.'
    );
  }
}

export interface UpResult {
  deployId: string;
  dashboardUrl: string | null;
  browserSignInUrl: string | null;
  dropletIp: string | null;
  tailscaleHostname: string | null;
  hermesWebuiOwnerEmail: string | null;
  hermesWebuiOwnerPassword: string | null;
  accessFile: string | null;
  resumed: boolean;
}

export interface RuntimeWaitDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
}

export function runtimeWaitAttempts(runtime: UpOptions['runtime']): number {
  // Hermes installs its pinned Python runtime, builds gstack, downloads its
  // Playwright browser, and starts Open WebUI on first boot. Those network-heavy
  // clean-host steps need a wider budget than OpenClaw's image pull.
  return runtime === 'hermes' ? 480 : 240;
}

export interface TailnetInfo {
  dnsSuffix: string;
}

/**
 * Confirm the user's device is on the tailnet before creating paid resources.
 * The suffix is needed for the HTTPS certificate name exposed by Tailscale
 * Serve; the VM auth key must belong to this same tailnet.
 */
export async function readTailnetInfo(exec: typeof execCommand = execCommand): Promise<TailnetInfo> {
  let stdout: string;
  try {
    ({ stdout } = await exec('tailscale', ['status', '--json']));
  } catch {
    throw new UserError(
      'Tailscale is not running on this device. Install it, sign in to the same tailnet as the VM auth key, and re-run.'
    );
  }

  try {
    const status = JSON.parse(stdout);
    const suffix = String(status?.CurrentTailnet?.MagicDNSSuffix ?? status?.MagicDNSSuffix ?? '')
      .replace(/\.$/, '')
      .toLowerCase();
    const httpsDomains = Array.isArray(status?.CertDomains) ? status.CertDomains : [];
    if (
      status?.BackendState !== 'Running' ||
      status?.CurrentTailnet?.MagicDNSEnabled === false ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net$/.test(suffix)
    ) {
      throw new Error('tailnet status is incomplete');
    }
    if (httpsDomains.length === 0) {
      throw new UserError(
        'Tailscale HTTPS is not enabled for this tailnet. Enable HTTPS certificates in the Tailscale admin console, then re-run.'
      );
    }
    return { dnsSuffix: suffix };
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(
      'Could not read a running MagicDNS tailnet from `tailscale status`. Sign in to Tailscale, enable MagicDNS, and re-run.'
    );
  }
}

/** Wait until cloud-init has started the browser surface over Tailscale. */
export async function waitForRuntimeReady(url: string, deps: RuntimeWaitDeps = {}): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleepImpl ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = deps.attempts ?? 240;
  const delayMs = deps.delayMs ?? 5000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (response.headers.get('x-aideploy-bootstrap-status') === '1') {
        const payload: unknown = await response.json().catch(() => null);
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const status = payload as Record<string, unknown>;
          if (status.state === 'ready') return;
          if (status.state === 'failed') {
            const step = typeof status.step === 'string' ? status.step.slice(0, 80) : 'bootstrap';
            const message = typeof status.message === 'string' ? status.message.slice(0, 300) : 'Setup failed.';
            throw new UserError(
              `The VM bootstrap failed during ${step}: ${message} ` +
                'Your state was kept: re-run the same command to resume, or use ' +
                '`tailscale ssh root@<hostname>` and inspect /var/log/aideploy-bootstrap.log.'
            );
          }
        }
      } else if (response.ok) {
        return;
      }
    } catch (err) {
      if (err instanceof UserError) throw err;
      // Bootstrap and tailnet DNS commonly need several minutes. Retry below.
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new UserError(
    `The VM exists, but the runtime did not become reachable at ${url}. ` +
      'Your state was kept: re-run the same command to resume, or use ' +
      '`tailscale ssh root@<hostname>` and inspect /var/log/aideploy-bootstrap.log.'
  );
}

export async function up(opts: UpOptions, secrets: Secrets, deps: UpDeps = {}): Promise<UpResult> {
  const exec = deps.exec ?? execCommand;
  const log = deps.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const assetsDir = deps.assetsDir ?? defaultAssetsDir();
  const manifest = deps.manifest ?? loadManifest(assetsDir);

  // Local tailnet + live cloud validation before any resource is created.
  const tailnet = await (deps.tailnetInfoImpl ?? readTailnetInfo)(exec);
  const [catalog, digitalOceanAccountUuid]: [DoCatalog, string] = await Promise.all([
    fetchDoCatalog(secrets.doToken, { fetchImpl: deps.fetchImpl }),
    fetchDoAccountUuid(secrets.doToken, { fetchImpl: deps.fetchImpl }),
  ]);
  assertRegion(catalog, opts.region);
  const size = opts.size ?? DEFAULT_SIZE;
  assertSize(catalog, size, opts.region);

  const deployId = opts.deployId ?? newDeployId();
  const dir = deployDir(deployId);
  const statePath = join(dir, 'terraform.tfstate');
  let resumed = existsSync(statePath);
  log(`Deployment id: ${deployId}`);
  const requested = {
    deployId,
    cloud: opts.cloud,
    digitalOceanAccountUuid,
    runtime: opts.runtime,
    aiProvider: secrets.aiProvider,
    region: opts.region,
    size,
    channel: opts.channel,
    tailscale: true,
  };
  const tfDir = join(assetsDir, 'terraform', 'digitalocean');
  if (!existsSync(tfDir)) throw new UserError(`Vendored terraform assets missing at ${tfDir} (broken package).`);
  const bootstrap = join(assetsDir, 'stack', 'runtime', 'bootstrap.sh');
  if (!existsSync(join(tfDir, 'main.tf')) || !existsSync(bootstrap)) {
    throw new UserError(
      `Vendored deployment contract is incomplete (${join(tfDir, 'main.tf')} / ${bootstrap}). ` +
        'This package must be rebuilt by the release workflow.'
    );
  }

  let cfg: DeployConfig;
  if (resumed) {
    // A state file alone is not enough: every immutable input must match the
    // saved deployment before `apply` can be allowed to mutate paid resources.
    const state = readJsonObject(statePath, 'OpenTofu state');
    if (typeof state.version !== 'number' || !Array.isArray(state.resources)) {
      throw new UserError(
        `Cannot safely resume ${deployId}: ${statePath} is not a complete OpenTofu state file. ` +
          'Run `aideploy doctor` before creating anything else.'
      );
    }
    cfg = validateResume(dir, requested, secrets, opts.cliVersion);
    secureStateFiles(dir);
    log(`Existing state for ${deployId} found — immutable inputs match; resuming idempotently.`);
  } else {
    const managedFiles = ['config.json', 'deploy.auto.tfvars.json', 'secrets.auto.tfvars.json'];
    const presentManagedFiles = managedFiles.filter((name) => existsSync(join(dir, name)));
    if (presentManagedFiles.length > 0 && presentManagedFiles.length < managedFiles.length) {
      throw new UserError(
        `Cannot create ${deployId}: its local directory contains an incomplete deployment checkpoint but no OpenTofu state. ` +
          'Run `aideploy doctor` before creating anything else, or use a new --deploy-id.'
      );
    }
    await assertNoCloudDeployCollision(deployId, secrets.doToken, deps.fetchImpl ?? fetch);
    if (presentManagedFiles.length === managedFiles.length) {
      // Downloads, `tofu init`, and an early failed apply can all stop before
      // OpenTofu writes state. A complete, matching local checkpoint is safe
      // to retry only after proving its exact resource tag is still unused.
      cfg = validateResume(dir, requested, secrets, opts.cliVersion);
      resumed = true;
      log(`Complete pre-apply checkpoint for ${deployId} found; inputs match and no cloud VM exists — retrying.`);
    } else {
      cfg = { ...requested, createdAt: new Date().toISOString(), cliVersion: opts.cliVersion };
    }
    // Reusing an explicitly destroyed id starts a new lifecycle. Do not let
    // its old receipt hide a new pre-state checkpoint from `aideploy doctor`.
    rmSync(join(dir, 'destroyed.json'), { force: true });
  }
  writeDeployFiles(dir, cfg, secrets);
  ensurePrivateDir(join(dir, '.terraform'));

  const tofu = await (deps.ensureTofuImpl ?? ensureTofu)(manifest, { execImpl: exec, fetchImpl: deps.fetchImpl });

  log('Initializing infrastructure engine...');
  await execPrivate(() => exec(tofu, ['init', '-input=false', '-no-color'], { cwd: tfDir, env: envFor(dir) }));
  log('Creating your agent VM (this takes a few minutes)...');
  let ok = false;
  try {
    await execPrivate(() =>
      exec(tofu, ['apply', '-auto-approve', '-input=false', '-no-color', `-state=${statePath}`], {
        cwd: tfDir,
        env: envFor(dir),
        stdio: 'inherit',
      })
    );
    secureStateFiles(dir);
    const { stdout } = await execPrivate(() =>
      exec(tofu, ['output', '-no-color', `-state=${statePath}`, '-json'], {
        cwd: tfDir,
        env: envFor(dir),
      })
    );
    const outputs = JSON.parse(stdout);
    const dropletIp: string | null = outputs?.droplet_ip?.value ?? null;
    const tailscaleShortHostname: string | null = outputs?.tailscale_hostname?.value ?? null;
    const hermesWebuiOwnerEmail: string | null =
      opts.runtime === 'hermes' ? (outputs?.hermes_webui_owner_email?.value ?? null) : null;
    const hermesWebuiOwnerPassword: string | null =
      opts.runtime === 'hermes' ? (outputs?.hermes_webui_owner_password?.value ?? null) : null;
    if (!tailscaleShortHostname) {
      throw new UserError('OpenTofu did not return the Tailscale hostname (broken deployment contract).');
    }
    const tailscaleHostname = `${tailscaleShortHostname}.${tailnet.dnsSuffix}`;
    const dashboardUrl = `https://${tailscaleHostname}`;
    const gatewayToken: string | null = outputs?.gateway_token?.value ?? null;
    if (!gatewayToken) {
      throw new UserError('OpenTofu did not return the browser gateway credential (broken deployment contract).');
    }
    const browserSignInUrl =
      opts.runtime === 'openclaw'
        ? `${dashboardUrl}/_aideploy/bootstrap?token=${encodeURIComponent(gatewayToken)}`
        : dashboardUrl;
    let accessFile: string | null = null;
    if (opts.runtime === 'openclaw') {
      accessFile = join(dir, 'access.json');
      writePrivateJson(accessFile, {
        dashboardUrl,
        browserSignInUrl,
        gatewayToken,
      });
    } else {
      if (!hermesWebuiOwnerEmail || !hermesWebuiOwnerPassword) {
        throw new UserError('OpenTofu did not return the Hermes browser owner credential (broken deployment contract).');
      }
      accessFile = join(dir, 'access.json');
      writePrivateJson(accessFile, {
        dashboardUrl,
        email: hermesWebuiOwnerEmail,
        password: hermesWebuiOwnerPassword,
      });
    }
    log(`VM created. Waiting for ${opts.runtime} to become ready at ${dashboardUrl}...`);
    const readinessUrl = opts.runtime === 'openclaw' ? `${dashboardUrl}/_aideploy/status` : dashboardUrl;
    await (
      deps.waitForRuntimeImpl ??
      ((url) => waitForRuntimeReady(url, {
        fetchImpl: deps.fetchImpl,
        attempts: runtimeWaitAttempts(opts.runtime),
      }))
    )(readinessUrl);
    ok = true;
    return {
      deployId,
      dropletIp,
      tailscaleHostname,
      dashboardUrl,
      browserSignInUrl,
      hermesWebuiOwnerEmail,
      hermesWebuiOwnerPassword,
      accessFile,
      resumed,
    };
  } finally {
    // OpenTofu may write state before returning an error. Never leave that
    // secret-bearing file at the host's default umask.
    secureStateFiles(dir);
    await sendPing(
      opts.telemetryConsent,
      { event: ok ? 'deploy_completed' : 'deploy_failed', cliVersion: opts.cliVersion, cloud: opts.cloud, runtime: opts.runtime, ok },
      { fetchImpl: deps.fetchImpl }
    );
  }

  function envFor(stateDir: string): NodeJS.ProcessEnv {
    return {
      TF_IN_AUTOMATION: '1',
      TF_DATA_DIR: join(stateDir, '.terraform'),
      TF_CLI_ARGS_apply: `-var-file=${join(stateDir, 'deploy.auto.tfvars.json')} -var-file=${join(stateDir, 'secrets.auto.tfvars.json')}`,
      TF_CLI_ARGS_destroy: `-var-file=${join(stateDir, 'deploy.auto.tfvars.json')} -var-file=${join(stateDir, 'secrets.auto.tfvars.json')}`,
    };
  }
}
