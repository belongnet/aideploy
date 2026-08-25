import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeployConfig, UserError, deployDir } from './config.js';
import { abortable, ensureTofu, execCommand } from './tofu.js';
import { execPrivate, loadManifest } from './deploy.js';

export interface DownDeps {
  exec?: typeof execCommand;
  ensureTofuImpl?: typeof ensureTofu;
  fetchImpl?: typeof fetch;
  assetsDir?: string;
  log?: (msg: string) => void;
  cliVersion?: string;
  signal?: AbortSignal;
}

/**
 * `aideploy down <deploy-id>` — full teardown from local state. Tolerant of
 * resources already deleted cloud-side (tofu destroy handles 404s as gone).
 * If state is missing entirely, points at `aideploy doctor` instead of dying
 * with a stack trace (state loss must never strand paid resources).
 */
export async function down(deployId: string, deps: DownDeps = {}): Promise<void> {
  const exec = deps.exec ?? execCommand;
  const log = deps.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const dir = deployDir(deployId);
  const statePath = join(dir, 'terraform.tfstate');
  if (!existsSync(statePath)) {
    throw new UserError(
      `No local state for "${deployId}" at ${statePath}.\n` +
        `If the VM still exists, run \`aideploy doctor\` to list resources tagged aideploy-${deployId}, ` +
        'then delete them from your DigitalOcean control panel.'
    );
  }
  let cfg: DeployConfig;
  try {
    cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as DeployConfig;
  } catch {
    throw new UserError(
      `Cannot safely destroy "${deployId}": its saved config is missing or invalid. ` +
        'Run `aideploy doctor` and recover the local deployment files first.'
    );
  }
  if (deps.cliVersion && (typeof cfg.cliVersion !== 'string' || !cfg.cliVersion)) {
    throw new UserError(
      `Cannot safely destroy ${deployId}: its saved config has no CLI version. ` +
        'Run `aideploy doctor` and recover the original deployment metadata first.'
    );
  }
  if (deps.cliVersion && cfg.cliVersion !== deps.cliVersion) {
    throw new UserError(
      `Refusing to destroy ${deployId} with aideploy@${deps.cliVersion}: its state was created by aideploy@${cfg.cliVersion}. ` +
        `Run \`npx aideploy@${cfg.cliVersion} down ${deployId}\` so teardown uses the matching infrastructure assets.`
    );
  }
  for (const required of ['deploy.auto.tfvars.json', 'secrets.auto.tfvars.json']) {
    if (!existsSync(join(dir, required))) {
      throw new UserError(
        `Cannot safely destroy "${deployId}": ${required} is missing. ` +
          'Run `aideploy doctor` and recover the local deployment files first.'
      );
    }
  }
  secureRetainedFiles(dir);
  const assetsDir =
    deps.assetsDir ??
    process.env.AIDEPLOY_ASSETS_DIR ??
    join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
  const tofu = await abortable(
    (deps.ensureTofuImpl ?? ensureTofu)(loadManifest(assetsDir), {
      execImpl: exec,
      fetchImpl: deps.fetchImpl,
      signal: deps.signal,
    }),
    deps.signal
  );
  const tfDir = join(assetsDir, 'terraform', cfg.cloud === 'do' ? 'digitalocean' : cfg.cloud);
  log(`Destroying deploy ${deployId} (${cfg.runtime} in ${cfg.region})...`);
  try {
    await execPrivate(() =>
      exec(tofu, ['destroy', '-auto-approve', '-input=false', '-no-color', `-state=${statePath}`], {
        cwd: tfDir,
        env: {
          TF_IN_AUTOMATION: '1',
          TF_DATA_DIR: join(dir, '.terraform'),
          TF_CLI_ARGS_destroy: `-var-file=${join(dir, 'deploy.auto.tfvars.json')} -var-file=${join(dir, 'secrets.auto.tfvars.json')}`,
        },
        stdio: 'inherit',
        signal: deps.signal,
        // Never hard-kill state mutation on a timer. OpenTofu must be allowed
        // to finish provider cancellation and persist its recovery state.
        interruptGraceMs: null,
      })
    );
  } finally {
    // OpenTofu can rewrite state during destroy. A failed or interrupted
    // teardown must retain every recovery file with private permissions.
    secureRetainedFiles(dir);
  }

  // Destroy succeeded: retain only an explicitly non-secret receipt. Keeping
  // tfvars or state would retain cloud, AI, Telegram, and Tailscale secrets.
  for (const name of [
    'terraform.tfstate',
    'terraform.tfstate.backup',
    'deploy.auto.tfvars.json',
    'secrets.auto.tfvars.json',
    'access.json',
    'config.json',
  ]) {
    rmSync(join(dir, name), { force: true });
  }
  rmSync(join(dir, '.terraform'), { recursive: true, force: true });
  const receiptPath = join(dir, 'destroyed.json');
  writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        deployId,
        cloud: cfg.cloud,
        runtime: cfg.runtime,
        region: cfg.region,
        destroyedAt: new Date().toISOString(),
        cliVersion: cfg.cliVersion,
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  chmodSync(receiptPath, 0o600);
  log(`Deploy ${deployId} destroyed. Credentials and OpenTofu state were scrubbed; receipt: ${receiptPath}`);
}

function secureRetainedFiles(dir: string): void {
  chmodSync(dir, 0o700);
  const terraformDir = join(dir, '.terraform');
  if (existsSync(terraformDir)) chmodSync(terraformDir, 0o700);
  for (const name of [
    'terraform.tfstate',
    'terraform.tfstate.backup',
    'config.json',
    'deploy.auto.tfvars.json',
    'secrets.auto.tfvars.json',
    'access.json',
  ]) {
    const path = join(dir, name);
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}
