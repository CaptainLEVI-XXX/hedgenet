// Browser-side request helpers. Types only from server modules; no server code is bundled.
import type { Preview } from './preview.ts';
import type { LiveIntakeResult } from './live-intake.ts';
import type { LiveMarketResult } from './live-market.ts';
import type { ExampleId } from './presets.ts';
import type { NeuralInput, NeuralPreview } from './neural-contract.ts';

export type { Preview, LiveIntakeResult };
export type ApiFailure = { code: string; message: string; status: number };
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

async function postJson<T>(path: string, body: unknown, signal: AbortSignal, pick: (json: any) => T): Promise<ApiResult<T>> {
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, signal });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      return { ok: false, error: { code: 'network_error', message: 'The server could not be reached.', status: 0 } };
    }
    let text = '';
    try { text = await response.text(); } catch { signal.throwIfAborted(); }
    // CreateOS returns this before forwarding to the sleeping app. Other 503s
    // and unknown network outcomes must not replay potentially executed work.
    if (response.status === 503 && response.headers.get('content-type')?.startsWith('text/plain')
      && text.trim() === 'Sandbox is waking up. Retry in a moment.') {
      if (attempt >= 20) return { ok: false, error: { code: 'sandbox_waking', status: 503,
        message: 'The demo sandbox is still waking up. Wait a moment, then retry; your inputs are kept.' } };
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 3000);
        signal.addEventListener('abort', abort, { once: true });
      });
      continue;
    }
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* Non-JSON server failure. */ }
    if (!response.ok || !json?.ok) {
      return { ok: false, error: { code: json?.error?.code ?? 'server_error', status: response.status,
        message: json?.error?.message ?? `The server returned an error (${response.status}).` } };
    }
    return { ok: true, data: pick(json) };
  }
}

export function requestPreview(input: { example: ExampleId; budgetUsd: string; revision: number }, signal: AbortSignal) {
  return postJson<Preview>('/api/preview', input, signal, json => json.preview);
}

export function requestLiveIntake(text: string, signal: AbortSignal) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return postJson<LiveIntakeResult>('/api/intake', { text, timezone }, signal, json => json);
}

export function requestNeural(input: NeuralInput, signal: AbortSignal) {
  return postJson<NeuralPreview>('/api/neural', input, signal, json => json.preview);
}

export function requestLiveMarket(input: { selectionToken: string; eventId: string }, signal: AbortSignal) {
  return postJson<LiveMarketResult>('/api/market', input, signal, json => json);
}
