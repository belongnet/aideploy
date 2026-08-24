import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Deploy state layout (design doc, CLI v1 mechanics):
 *   ~/.aideploy/<deploy-id>/config.json        — non-secret choices
 *   ~/.aideploy/<deploy-id>/terraform.tfstate  — OpenTofu state
 *   ~/.aideploy/<deploy-id>/secrets.auto.tfvars.json — 0600, local only
 *   ~/.aideploy/bin/<tofu-version>/tofu        — cached verified binary
 * State loss must never mean unfindable paid resources: every cloud resource
 * carries both `aideploy` and `aideploy-<deploy-id>` tags so `doctor` can
 * list the fleet and identify orphans in one API call.
 */
export interface DeployConfig {
  deployId: string;
  cloud: 'do';
  digitalOceanAccountUuid: string;
  runtime: 'openclaw' | 'hermes';
  aiProvider: 'openai' | 'anthropic' | 'kimi';
  region: string;
  size: string;
  channel: 'telegram';
  tailscale: boolean;
  createdAt: string;
  cliVersion: string;
}

export interface Secrets {
  doToken: string;
  aiApiKey: string;
  aiProvider: 'openai' | 'anthropic' | 'kimi';
  telegramBotToken: string;
  telegramUserId: string;
  tailscaleAuthKey: string;
}

export const AIDEPLOY_HOME = () => process.env.AIDEPLOY_HOME ?? join(homedir(), '.aideploy');
const DEPLOY_ID_PATTERN = /^adp-[a-z0-9](?:[a-z0-9-]{0,42}[a-z0-9])?$/;

export function assertDeployId(id: string): void {
  if (!DEPLOY_ID_PATTERN.test(id)) {
    throw new UserError(
      `Invalid deploy id "${id}". Use a lowercase id like adp-1a2b3c4d ` +
        '(letters, digits, and internal hyphens only; 48 characters maximum).'
    );
  }
}

export function deployDir(id: string): string {
  assertDeployId(id);
  const home = resolve(AIDEPLOY_HOME());
  const target = resolve(home, id);
  if (dirname(target) !== home) {
    throw new UserError(`Deploy id "${id}" resolves outside the aideploy state directory.`);
  }
  return target;
}
export const binDir = (tofuVersion: string) => join(AIDEPLOY_HOME(), 'bin', tofuVersion);

export function newDeployId(): string {
  // Short, cloud-tag-safe, collision-resistant enough for a per-user namespace.
  return `adp-${randomBytes(4).toString('hex')}`;
}

export function resourceTag(deployId: string): string {
  assertDeployId(deployId);
  // DO tags may not contain ':' — use the documented `aideploy-<id>` form.
  return `aideploy-${deployId}`;
}

export const VALID_RUNTIMES = ['openclaw', 'hermes'] as const;
export const VALID_CLOUDS = ['do'] as const;
export const VALID_CHANNELS = ['telegram'] as const;

/** Node floor per design doc: clear error, not a stack trace. */
export function assertNodeVersion(versionString: string = process.versions.node): void {
  const major = Number(versionString.split('.')[0]);
  const minor = Number(versionString.split('.')[1] ?? 0);
  if (major < 18 || (major === 18 && minor < 3)) {
    throw new UserError(
      `aideploy requires Node 18.3 or newer (found ${versionString}). ` +
        'Install a current Node from https://nodejs.org and re-run.'
    );
  }
}

/** Errors shown to the user without a stack trace. */
export class UserError extends Error {
  readonly isUserError = true;
}
