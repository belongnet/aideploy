import { jest } from '@jest/globals';
import { sendPing } from '../src/telemetry.js';
import { InterruptedError } from '../src/tofu.js';

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

  it('propagates an outer interruption and cancels the in-flight ping', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      setImmediate(() => controller.abort(new InterruptedError('SIGTERM')));
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as any;

    await expect(sendPing(true, event, { fetchImpl, signal: controller.signal })).rejects.toMatchObject({
      exitCode: 143,
      signal: 'SIGTERM',
    });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('times out a stalled endpoint and releases the internal timer', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })) as any;
      const ping = sendPing(true, event, { fetchImpl });
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(4000);
      await expect(ping).resolves.toBe('failed');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
