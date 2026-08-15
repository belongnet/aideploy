import { UserError } from './config.js';

/**
 * Dynamic cloud validation (eng review 4A): regions/sizes fetched live from
 * the DO API at prompt time so nothing is copied from the wizard and nothing
 * drifts. A minimal hardcoded fallback is used ONLY when the API is
 * unreachable — with a warning, never silently.
 */
export const FALLBACK_REGIONS = ['nyc1', 'nyc3', 'sfo3', 'ams3', 'fra1', 'lon1', 'sgp1', 'blr1', 'syd1'];
export const FALLBACK_SIZES = ['s-2vcpu-4gb', 's-4vcpu-8gb'];
export const DEFAULT_SIZE = 's-2vcpu-4gb';

export interface DoCatalog {
  regions: string[];
  sizes: string[];
  sizeRegions: Record<string, string[]>;
  fromFallback: boolean;
}

export interface ValidateDeps {
  fetchImpl?: typeof fetch;
  warn?: (msg: string) => void;
}

const DO_API = 'https://api.digitalocean.com/v2';

async function doGet(path: string, token: string, fetchFn: typeof fetch): Promise<any> {
  const res = await fetchFn(`${DO_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (res.status === 401) {
    throw new UserError(
      'DigitalOcean rejected the API token (401). Create a token with read+write scope at ' +
        'https://cloud.digitalocean.com/account/api/tokens and try again.'
    );
  }
  if (res.status === 429) {
    throw new UserError('DigitalOcean API rate limit hit (429). Wait a minute and re-run.');
  }
  if (!res.ok) throw new UserError(`DigitalOcean API error: HTTP ${res.status} on ${path}`);
  return res.json();
}

/**
 * Resolve the stable cloud-account identity behind a token. Tokens can rotate,
 * but a saved deployment must never resume against a different account.
 */
export async function fetchDoAccountUuid(token: string, deps: ValidateDeps = {}): Promise<string> {
  const fetchFn = deps.fetchImpl ?? fetch;
  let body: any;
  try {
    body = await doGet('/account', token, fetchFn);
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(
      'Could not verify the DigitalOcean account behind this API token. No resources were created; try again.'
    );
  }

  const uuid = String(body?.account?.uuid ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
    throw new UserError(
      'DigitalOcean returned an invalid account identity. No resources were created; try again.'
    );
  }
  return uuid;
}

/** Validates the token AND returns the live region/size catalog in one pass. */
export async function fetchDoCatalog(token: string, deps: ValidateDeps = {}): Promise<DoCatalog> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const warn = deps.warn ?? ((m) => process.stderr.write(`${m}\n`));
  try {
    const [regionsRes, sizesRes] = await Promise.all([
      doGet('/regions?per_page=200', token, fetchFn),
      doGet('/sizes?per_page=200', token, fetchFn),
    ]);
    const regions = (regionsRes.regions ?? [])
      .filter((r: any) => r.available)
      .map((r: any) => String(r.slug));
    const sizes = (sizesRes.sizes ?? [])
      .filter((s: any) => s.available && s.memory >= 4096)
      .map((s: any) => String(s.slug));
    const sizeRegions = Object.fromEntries(
      (sizesRes.sizes ?? [])
        .filter((s: any) => s.available && s.memory >= 4096)
        .map((s: any) => [String(s.slug), Array.isArray(s.regions) ? s.regions.map(String) : []])
    );
    if (regions.length === 0 || sizes.length === 0) throw new Error('empty catalog');
    return { regions, sizes, sizeRegions, fromFallback: false };
  } catch (err) {
    if (err instanceof UserError) throw err; // auth/rate errors are real, not fallback cases
    warn(
      'Could not reach the DigitalOcean API for live region/size lists — using a built-in fallback. ' +
        'The deploy itself still validates against the real API.'
    );
    return {
      regions: FALLBACK_REGIONS,
      sizes: FALLBACK_SIZES,
      sizeRegions: Object.fromEntries(FALLBACK_SIZES.map((size) => [size, FALLBACK_REGIONS])),
      fromFallback: true,
    };
  }
}

export function assertSize(catalog: DoCatalog, size: string, region: string): void {
  if (!catalog.sizes.includes(size)) {
    throw new UserError(
      `Droplet size "${size}" is not available on your DigitalOcean account. ` +
        `Available: ${catalog.sizes.slice(0, 12).join(', ')}${catalog.sizes.length > 12 ? ', …' : ''}`
    );
  }
  const regions = catalog.sizeRegions[size] ?? [];
  if (regions.length > 0 && !regions.includes(region)) {
    throw new UserError(
      `Droplet size "${size}" is not available in region "${region}". ` +
        `Choose another size or one of: ${regions.slice(0, 12).join(', ')}${regions.length > 12 ? ', …' : ''}`
    );
  }
}

export function assertRegion(catalog: DoCatalog, region: string): void {
  if (!catalog.regions.includes(region)) {
    throw new UserError(
      `Region "${region}" is not available on your DigitalOcean account. ` +
        `Available: ${catalog.regions.slice(0, 12).join(', ')}${catalog.regions.length > 12 ? ', …' : ''}`
    );
  }
}

/** Basic shape checks so typos fail in seconds, not after a cloud call. */
export function assertCredentialShapes(input: {
  doToken: string;
  telegramBotToken: string;
  telegramUserId: string;
  aiApiKey: string;
  tailscaleAuthKey: string;
}): void {
  if (!/^do[op]_v1_[0-9a-f]{64}$/.test(input.doToken)) {
    throw new UserError(
      'That does not look like a DigitalOcean API token (expected dop_v1_… / doo_v1_…). ' +
        'Create one at https://cloud.digitalocean.com/account/api/tokens'
    );
  }
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(input.telegramBotToken)) {
    throw new UserError(
      'That does not look like a Telegram bot token (expected 123456789:AA…). Get one from @BotFather.'
    );
  }
  if (!/^[1-9]\d{4,14}$/.test(input.telegramUserId)) {
    throw new UserError(
      'That does not look like your numeric Telegram account ID. ' +
        'Send /start to @userinfobot in Telegram and copy the number it returns.'
    );
  }
  if (input.aiApiKey.trim().length < 20) {
    throw new UserError('That AI provider API key looks too short. Paste the full key.');
  }
  if (!/^tskey-auth-[A-Za-z0-9_-]{6,}$/.test(input.tailscaleAuthKey)) {
    throw new UserError(
      'That does not look like a Tailscale device auth key (expected tskey-auth-…). API and OAuth client keys cannot join a VM. ' +
        'Create a one-off key with Reusable disabled at https://login.tailscale.com/admin/settings/keys'
    );
  }
}
