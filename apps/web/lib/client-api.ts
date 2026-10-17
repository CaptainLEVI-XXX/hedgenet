// Browser-side request helpers. Types only from server modules; no server code is bundled.
import type { Preview } from './preview.ts';
import type { LiveIntakeResult } from './live-intake.ts';
import type { ExampleId } from './presets.ts';
import type { NeuralInput, NeuralPreview } from './neural-contract.ts';

export type { Preview, LiveIntakeResult };
export type ApiFailure = { code: string; message: string; status: number };
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

async function postJson<T>(path: string, body: unknown, signal: AbortSignal, pick: (json: any) => T): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    return { ok: false, error: { code: 'network_error', message: 'The local server could not be reached.', status: 0 } };
  }
  let json: any = null;
  try { json = await response.json(); } catch { json = null; }
  if (!response.ok || !json?.ok) {
    return { ok: false, error: { code: json?.error?.code ?? 'server_error', status: response.status,
      message: json?.error?.message ?? `The server returned an error (${response.status}).` } };
  }
  return { ok: true, data: pick(json) };
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
