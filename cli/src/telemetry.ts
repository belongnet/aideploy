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
}

export const DEFAULT_ENDPOINT = 'https://ping.aideploy.co/v1/event';

export async function sendPing(
  consent: boolean,
  event: TelemetryEvent,
  deps: TelemetryDeps = {}
): Promise<'sent' | 'skipped' | 'failed'> {
  if (!consent) return 'skipped';
  const fetchFn = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchFn(deps.endpoint ?? DEFAULT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(4000),
    });
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed'; // never let telemetry affect the deploy
  }
}
