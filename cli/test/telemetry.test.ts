import { jest } from '@jest/globals';
import { sendPing } from '../src/telemetry.js';

const event = { event: 'deploy_completed' as const, cliVersion: '0.0.1', cloud: 'do', runtime: 'openclaw', ok: true };

describe('sendPing', () => {
  it('declined consent => provably zero network calls', async () => {
    const fetchImpl = jest.fn() as any;
    const result = await sendPing(false, event, { fetchImpl });
    expect(result).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('consented => one POST with the minimal payload', async () => {
    const fetchImpl = jest.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      expect(Object.keys(body).sort()).toEqual(['cliVersion', 'cloud', 'event', 'ok', 'runtime']);
      return new Response('ok', { status: 200 });
    }) as any;
    expect(await sendPing(true, event, { fetchImpl })).toBe('sent');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('endpoint unreachable => "failed" without throwing (deploy unaffected)', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('ENOTFOUND'); }) as any;
    expect(await sendPing(true, event, { fetchImpl })).toBe('failed');
  });

  it('non-2xx => "failed" without throwing', async () => {
    const fetchImpl = jest.fn(async () => new Response('teapot', { status: 418 })) as any;
    expect(await sendPing(true, event, { fetchImpl })).toBe('failed');
  });
});
