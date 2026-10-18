import { afterEach, expect, it, vi } from 'vitest';
import { requestPreview } from '../../apps/web/lib/client-api.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const input = { example: 'crypto' as const, budgetUsd: '300', revision: 7 };
const waking = () => new Response('Sandbox is waking up. Retry in a moment.\n', {
  status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '3' },
});
const success = () => Response.json({ ok: true, preview: { revision: 7, unspentBudgetUsd: '0.01' } });

it('recovers the same request after the explicit CreateOS wake-up response', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(waking()).mockResolvedValueOnce(waking()).mockResolvedValueOnce(success()));
  const result = requestPreview(input, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(6000);
  expect(await result).toEqual({ ok: true, data: { revision: 7, unspentBudgetUsd: '0.01' } });
});

it('never retries application failures, generic gateway errors, rate limits or unknown network outcomes', async () => {
  const responses = [
    Response.json({ ok: false, error: { code: 'model_unavailable', message: 'Model unavailable.' } }, { status: 503 }),
    new Response('Service unavailable', { status: 503 }),
    new Response('Too many requests', { status: 429 }),
    new Response('Bad gateway', { status: 502 }),
  ];
  for (const response of responses) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(success()));
    expect(await requestPreview(input, new AbortController().signal)).toMatchObject({ ok: false, error: { status: response.status } });
  }
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('connection lost')).mockResolvedValueOnce(success()));
  expect(await requestPreview(input, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'network_error' } });
});

it('bounds wake-up waiting and reports a retryable hosting error', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => waking()));
  const result = requestPreview(input, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(61_000);
  expect(await result).toMatchObject({ ok: false, error: { status: 503, code: 'sandbox_waking' } });
});

it('cancels wake-up waiting when the user leaves or edits the request', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(waking()).mockResolvedValueOnce(success()));
  const result = requestPreview(input, controller.signal);
  const cancelled = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(1000);
  controller.abort();
  await cancelled;
  expect(vi.getTimerCount()).toBe(0);
});
