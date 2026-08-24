import { jest } from '@jest/globals';
import {
  FALLBACK_REGIONS,
  assertCredentialShapes,
  assertRegion,
  assertSize,
  fetchDoAccountUuid,
  fetchDoCatalog,
} from '../src/validate.js';
import { UserError } from '../src/config.js';

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('fetchDoAccountUuid', () => {
  it('returns the stable account identity behind a token', async () => {
    const fetchImpl = jest.fn(async () => okJson({ account: { uuid: '11111111-2222-4333-8444-555555555555' } })) as any;
    await expect(fetchDoAccountUuid('token', { fetchImpl })).resolves.toBe(
      '11111111-2222-4333-8444-555555555555'
    );
  });

  it('fails closed when account identity cannot be verified', async () => {
    const unreachable = jest.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    await expect(fetchDoAccountUuid('token', { fetchImpl: unreachable })).rejects.toThrow(/Could not verify/);

    const malformed = jest.fn(async () => okJson({ account: {} })) as any;
    await expect(fetchDoAccountUuid('token', { fetchImpl: malformed })).rejects.toThrow(/invalid account identity/);
  });
});

describe('fetchDoCatalog', () => {
  it('returns live regions/sizes from the DO API', async () => {
    const fetchImpl = jest.fn(async (url: any) => {
      if (String(url).includes('/regions')) {
        return okJson({ regions: [{ slug: 'nyc3', available: true }, { slug: 'dead1', available: false }] });
      }
      return okJson({ sizes: [{ slug: 's-2vcpu-4gb', available: true, memory: 4096, regions: ['nyc3'] }, { slug: 's-1vcpu-1gb', available: true, memory: 1024, regions: ['nyc3'] }] });
    }) as any;
    const catalog = await fetchDoCatalog('dop_v1_' + 'a'.repeat(64), { fetchImpl });
    expect(catalog.regions).toEqual(['nyc3']);
    expect(catalog.sizes).toEqual(['s-2vcpu-4gb']); // <4GB filtered: agents need memory
    expect(catalog.sizeRegions).toEqual({ 's-2vcpu-4gb': ['nyc3'] });
    expect(catalog.fromFallback).toBe(false);
  });

  it('propagates 401 as a real auth error (never falls back)', async () => {
    const fetchImpl = jest.fn(async () => new Response('unauthorized', { status: 401 })) as any;
    await expect(fetchDoCatalog('bad', { fetchImpl })).rejects.toThrow(/rejected the API token/);
  });

  it('propagates 429 with actionable wording', async () => {
    const fetchImpl = jest.fn(async () => new Response('slow down', { status: 429 })) as any;
    await expect(fetchDoCatalog('t', { fetchImpl })).rejects.toThrow(/rate limit/);
  });

  it('falls back with a warning when the API is unreachable', async () => {
    const warn = jest.fn();
    const fetchImpl = jest.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    const catalog = await fetchDoCatalog('t', { fetchImpl, warn });
    expect(catalog.fromFallback).toBe(true);
    expect(catalog.regions).toEqual(FALLBACK_REGIONS);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('assertRegion', () => {
  it('rejects a region not in the catalog, listing available ones', () => {
    expect(() => assertRegion({ regions: ['nyc3'], sizes: [], sizeRegions: {}, fromFallback: false }, 'mars1')).toThrow(/not available/);
  });
});

describe('assertSize', () => {
  const catalog = {
    regions: ['nyc3', 'sfo3'],
    sizes: ['s-2vcpu-4gb'],
    sizeRegions: { 's-2vcpu-4gb': ['nyc3'] },
    fromFallback: false,
  };

  it('rejects unknown and region-incompatible sizes before provisioning', () => {
    expect(() => assertSize(catalog, 's-8vcpu-32gb', 'nyc3')).toThrow(/not available on your DigitalOcean account/);
    expect(() => assertSize(catalog, 's-2vcpu-4gb', 'sfo3')).toThrow(/not available in region/);
    expect(() => assertSize(catalog, 's-2vcpu-4gb', 'nyc3')).not.toThrow();
  });
});

describe('assertCredentialShapes', () => {
  const good = {
    doToken: 'dop_v1_' + 'a'.repeat(64),
    telegramBotToken: '123456789:' + 'A'.repeat(35),
    telegramUserId: '123456789',
    aiApiKey: 'sk-test-' + 'x'.repeat(24),
    tailscaleAuthKey: 'tskey-auth-abc123',
  };
  it('accepts well-shaped credentials', () => {
    expect(() => assertCredentialShapes(good)).not.toThrow();
  });
  it('rejects malformed DO tokens with a pointer to the token page', () => {
    expect(() => assertCredentialShapes({ ...good, doToken: 'not-a-token' })).toThrow(/DigitalOcean API token/);
  });
  it('rejects malformed Telegram tokens with a BotFather pointer', () => {
    expect(() => assertCredentialShapes({ ...good, telegramBotToken: 'nope' })).toThrow(/BotFather/);
  });
  it('rejects a non-numeric Telegram owner id', () => {
    expect(() => assertCredentialShapes({ ...good, telegramUserId: '../../owner' })).toThrow(/numeric Telegram account ID/);
  });
  it('rejects too-short AI keys', () => {
    expect(() => assertCredentialShapes({ ...good, aiApiKey: 'short' })).toThrow(/too short/);
  });
  it('rejects malformed Tailscale keys', () => {
    expect(() => assertCredentialShapes({ ...good, tailscaleAuthKey: 'nokey' })).toThrow(/Tailscale/);
  });
  it('rejects Tailscale API and OAuth client secrets that cannot join a device', () => {
    expect(() => assertCredentialShapes({ ...good, tailscaleAuthKey: `tskey-${'api'}-abc123` })).toThrow(/device auth key/);
    expect(() => assertCredentialShapes({ ...good, tailscaleAuthKey: `tskey-${'client'}-abc123` })).toThrow(/device auth key/);
  });
});
