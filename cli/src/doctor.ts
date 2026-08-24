import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AIDEPLOY_HOME, UserError } from './config.js';

/**
 * `aideploy doctor` — reconciles local state dirs against cloud reality by
 * tag. Every resource we create is tagged `aideploy-<deploy-id>`, so orphans
 * (cloud resources whose local state was lost) are always findable.
 */
export interface DoctorDeps {
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export interface DoctorReport {
  localDeploys: string[];
  destroyedDeploys: string[];
  missingStateDeploys: string[];
  invalidStateDeploys: string[];
  cloudDroplets: { id: number; name: string; tag: string; ip: string | null }[];
  orphans: string[]; // tags present in cloud with no local state
}

function hasValidTofuState(dir: string): 'valid' | 'missing' | 'invalid' {
  const path = join(dir, 'terraform.tfstate');
  if (!existsSync(path)) return 'missing';
  try {
    const state: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      state &&
      typeof state === 'object' &&
      !Array.isArray(state) &&
      typeof (state as any).version === 'number' &&
      Array.isArray((state as any).resources)
    ) {
      return 'valid';
    }
  } catch {
    // Classified below.
  }
  return 'invalid';
}

export async function doctor(doToken: string | undefined, deps: DoctorDeps = {}): Promise<DoctorReport> {
  const log = deps.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const fetchFn = deps.fetchImpl ?? fetch;

  const home = AIDEPLOY_HOME();
  const allDeployDirs = existsSync(home)
    ? readdirSync(home, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('adp-'))
        .map((e) => e.name)
        .sort()
    : [];
  const destroyedDeploys = allDeployDirs.filter(
    (id) => existsSync(join(home, id, 'destroyed.json')) && !existsSync(join(home, id, 'terraform.tfstate'))
  );
  const destroyedSet = new Set(destroyedDeploys);
  const stateDirs = allDeployDirs.filter((id) => !destroyedSet.has(id));
  const localDeploys = stateDirs.filter((id) => hasValidTofuState(join(home, id)) === 'valid');
  const missingStateDeploys = stateDirs.filter((id) => hasValidTofuState(join(home, id)) === 'missing');
  const invalidStateDeploys = stateDirs.filter((id) => hasValidTofuState(join(home, id)) === 'invalid');

  if (!doToken) {
    throw new UserError(
      'doctor needs a DigitalOcean API token to list cloud resources. ' +
        'Set DIGITALOCEAN_TOKEN in the environment and re-run.'
    );
  }

  const res = await fetchFn('https://api.digitalocean.com/v2/droplets?tag_name=aideploy&per_page=200', {
    headers: { Authorization: `Bearer ${doToken}` },
  });
  // Tag pagination note: we tag every droplet with both the generic `aideploy`
  // tag and the per-deploy `aideploy-<id>` tag so one call lists the fleet.
  if (res.status === 401) throw new UserError('DigitalOcean rejected the token (401).');
  if (!res.ok) throw new UserError(`DigitalOcean API error: HTTP ${res.status}`);
  const body = await res.json();
  const cloudDroplets = (body.droplets ?? []).map((d: any) => ({
    id: d.id as number,
    name: String(d.name),
    tag: String((d.tags ?? []).find((t: string) => t.startsWith('aideploy-adp-')) ?? ''),
    ip: d.networks?.v4?.find((n: any) => n.type === 'public')?.ip_address ?? null,
  }));

  const localTagSet = new Set(localDeploys.map((id) => `aideploy-${id}`));
  const orphans = cloudDroplets
    .map((d: { tag: string }) => d.tag)
    .filter((t: string) => t && !localTagSet.has(t));

  log(`Local deploy state dirs: ${localDeploys.length ? localDeploys.join(', ') : '(none)'}`);
  if (destroyedDeploys.length) log(`Local destroy receipts: ${destroyedDeploys.join(', ')}`);
  if (missingStateDeploys.length) {
    log(`LOCAL DIRECTORIES MISSING STATE: ${missingStateDeploys.join(', ')}`);
  }
  if (invalidStateDeploys.length) {
    log(`LOCAL DIRECTORIES WITH INVALID STATE: ${invalidStateDeploys.join(', ')}`);
  }
  log(`Cloud droplets tagged aideploy: ${cloudDroplets.length}`);
  for (const d of cloudDroplets) log(`  - ${d.name} (${d.tag || 'untagged?'}) ip=${d.ip ?? '?'}`);
  if (orphans.length) {
    log(`ORPHANS (cloud resources with no local state): ${orphans.join(', ')}`);
    log('Delete them in the DigitalOcean control panel, or re-create local state before `aideploy down`.');
  } else {
    log('No orphans: every cloud resource has matching local state.');
  }
  return { localDeploys, destroyedDeploys, missingStateDeploys, invalidStateDeploys, cloudDroplets, orphans };
}
