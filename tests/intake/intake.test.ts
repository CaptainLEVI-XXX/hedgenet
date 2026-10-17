import { expect, it, vi } from 'vitest';
import { createJevClient, interpretExposure } from '../../packages/intake/src/index.ts';

// Synthetic API boundary: choices are specified by the test, not computed from the implementation.
function provider(picks: Record<string, string>, mutate?: (body: any) => void): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, value]) => {
      const options = Object.keys((value as any).criteria);
      const choice = picks[id] ?? 'missing';
      return [id, { type: 'choice', choice, confidence: 0.9,
        probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 1 : 0])) }];
    }));
    const body = { model: 'jev-1.13.0', answers, usage: { input_tokens: 123, output_tokens: 45 } };
    mutate?.(body);
    return Response.json(body);
  };
}
const context = { timezone: 'America/New_York', interpretedAt: '2026-10-17T19:00:00Z' };
const client = (picks: Record<string, string>, mutate?: (body: any) => void) =>
  createJevClient({ apiKey: 'synthetic-test-key', fetchImpl: provider(picks, mutate) });

it('copies asymmetric holdings/reference/budget roles with exact source offsets, never confirming them', async () => {
  const text = 'I hold 2 BTC, reference $70,000.50; budget $1,000 on November 30.';
  const result = await interpretExposure({ text, ...context }, client({ templateId: 'terminal_downside',
    units: 'span-0', referencePriceUsd: 'span-2', budgetUsd: 'span-3', observable: 'span-1',
    observationKind: 'point', observationDate: 'span-4', currency: 'USD' }));
  expect(result.status).toBe('needs_clarification');
  expect(result.fields.units).toMatchObject({ value: '2', confirmed: false });
  expect(result.fields.referencePriceUsd?.value).toBe('70000.5');
  expect(result.fields.budgetUsd?.value).toBe('1000');
  expect(result.fields.observable?.value).toBe('bitcoin');
  expect(result.fields.observationDate?.value).toBe('November 30');
  expect(result.missingFields).toContain('observation'); // No invented year/time/source.
  for (const field of Object.values(result.fields)) {
    if (field.provenance.kind === 'user_span') {
      const { start, end, raw } = field.provenance;
      expect(text.slice(start, end)).toBe(raw);
    }
  }
  expect(result.provider).toMatchObject({ model: 'jev-1.13.0', usage: { input_tokens: 123, output_tokens: 45 } });
});

it('supports negative weather thresholds and zero budgets without inventing a loss cap', async () => {
  const result = await interpretExposure({ text: 'Temperature below -5°C costs $500 per degree; budget $0.', ...context },
    client({ templateId: 'threshold_loss', observable: 'span-0', threshold: 'span-1', lossRateUsd: 'span-2',
      budgetUsd: 'span-3', direction: 'below', currency: 'USD', observationKind: 'window' }));
  expect(result.fields.threshold?.value).toBe('-5');
  expect(result.fields.budgetUsd?.value).toBe('0');
  expect(result.fields.maxLossUsd).toBeUndefined();
  expect(result.missingFields).toEqual(expect.arrayContaining(['maxLossUsd', 'observation', 'location', 'resolutionSource']));
});

it('rejects negative holdings, unsupported paths and ambiguous roles rather than quietly repairing them', async () => {
  const negative = await interpretExposure({ text: '-2 BTC $70,000 $100', ...context },
    client({ templateId: 'terminal_downside', units: 'span-0', referencePriceUsd: 'span-2', budgetUsd: 'span-3' }));
  expect(negative.fields.units).toBeUndefined();
  expect(negative.missingFields).toContain('units');
  const unsupported = await interpretExposure({ text: 'Protect whenever BTC touches $50,000 intraday.', ...context },
    client({ templateId: 'terminal_downside', observationKind: 'unsupported_path' }));
  expect(unsupported.status).toBe('unsupported');
  const ambiguous = await interpretExposure({ text: '2 BTC $70,000 $100', ...context },
    client({ templateId: 'terminal_downside', units: 'span-0' }, body => {
      body.answers.units.probabilities['span-0'] = 0.79;
      body.answers.units.probabilities.missing = 0.21;
    }));
  expect(ambiguous.fields.units).toBeUndefined();
  expect(ambiguous.missingFields).toContain('units');
});

it('preserves exact large decimals and does not extract partial exponential or malformed numeric tokens', async () => {
  const result = await interpretExposure({ text: 'Hold 999999999999.123456789123 BTC. Budget $1e3, not $12,34 or 1.2.3.', ...context },
    client({ templateId: 'terminal_downside', units: 'span-0' }));
  expect(result.fields.units?.value).toBe('999999999999.123456789123');
  expect(result.spans.filter(span => span.kind === 'number')).toHaveLength(1);
  expect(result.fields.budgetUsd).toBeUndefined();
});

it('validates transport identities, choices, distributions, primitive and usage before interpreting', async () => {
  const question = { q: { type: 'choice' as const, instructions: 'Which?', criteria: { a: 'A', b: 'B' } } };
  const valid = await client({ q: 'a' }).ask({}, question);
  expect(valid.answers.q?.choice).toBe('a');
  for (const mutate of [
    (b: any) => { b.model = 'jev-latest'; },
    (b: any) => { delete b.answers.q; },
    (b: any) => { b.answers.extra = b.answers.q; },
    (b: any) => { b.answers.q.type = 'noul'; },
    (b: any) => { b.answers.q.choice = 'invented'; },
    (b: any) => { b.answers.q.probabilities = { a: 0.9, b: 0.9 }; },
    (b: any) => { b.answers.q.probabilities = { a: 0.1, b: 0.9 }; },
    (b: any) => { b.answers.q.probabilities = { a: 1 }; },
    (b: any) => { b.usage.input_tokens = -1; },
  ]) await expect(client({ q: 'a' }, mutate).ask({}, question)).rejects.toMatchObject({ code: 'invalid_response' });
});

it('returns manual-entry dependency failure, never no-match, and bounds a stalled provider without retries', async () => {
  const input = { text: '2 BTC', ...context };
  const offline = createJevClient({ apiKey: 'synthetic', fetchImpl: async () => new Response('private vendor details', { status: 429 }) });
  const failed = await interpretExposure(input, offline);
  expect(failed).toMatchObject({ status: 'dependency_unavailable', failure: 'http_error', fields: {} });
  expect(JSON.stringify(failed)).not.toContain('private vendor details');
  vi.useFakeTimers();
  try {
    const stalled = createJevClient({ apiKey: 'synthetic', fetchImpl: async () => new Promise(() => {}) });
    const pending = interpretExposure(input, stalled);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ status: 'dependency_unavailable', failure: 'timeout' });
  } finally { vi.useRealTimers(); }
});

it('rejects over-limit text, spans and invalid interpretation context before external work', async () => {
  const never = createJevClient({ apiKey: 'synthetic', fetchImpl: async () => { throw new Error('must not call'); } });
  for (const patch of [{ text: 'x'.repeat(4001) }, { text: Array(31).fill('$2').join(' ') },
    { timezone: 'unknown' }, { interpretedAt: 'tomorrow' }]) {
    await expect(interpretExposure({ text: '2 BTC', ...context, ...patch }, never)).rejects.toThrow();
  }
});
