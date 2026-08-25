import { interruptionError, throwIfAborted } from './tofu.js';

/**
 * Consent-based telemetry (design doc, funnel instrumentation):
 *  - explicit consent prompt during the interactive flow
 *  - declined => provably zero network calls (tested)
 *  - a single deploy-completed ping: version, cloud, runtime, success/fail —
 *    NO identifiers, NO credentials, NO IP-derived fields added by us
 *  - endpoint unreachable => deploy outcome unaffected, failure swallowed
 */
export interface TelemetryEvent {
  event: 'deploy_completed' | 'deploy_failed';
  cliVersion: string;
  cloud: string;
  runtime: string;
  ok: boolean;
}

export interface TelemetryDeps {
  fetchImpl?: typeof fetch;
  endpoint?: string;
  signal?: AbortSignal;
}

export const DEFAULT_ENDPOINT = 'https://ping.aideploy.co/v1/event';

export async function sendPing(
  consent: boolean,
  event: TelemetryEvent,
  deps: TelemetryDeps = {}
): Promise<'sent' | 'skipped' | 'failed'> {
  if (!consent) return 'skipped';
  const fetchFn = deps.fetchImpl ?? fetch;
  throwIfAborted(deps.signal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  timeout.unref();
  const onInterrupt = () => controller.abort(interruptionError(deps.signal));
  deps.signal?.addEventListener('abort', onInterrupt, { once: true });
  try {
    const res = await fetchFn(deps.endpoint ?? DEFAULT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    throwIfAborted(deps.signal);
    return res.ok ? 'sent' : 'failed';
  } catch {
    if (deps.signal?.aborted) throw interruptionError(deps.signal);
    return 'failed'; // never let telemetry affect the deploy
  } finally {
    clearTimeout(timeout);
    deps.signal?.removeEventListener('abort', onInterrupt);
  }
}
