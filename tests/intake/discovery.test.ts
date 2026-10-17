import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createCatalogueIndex } from '@hedgenet/venue';
import { gammaPageSchema } from '../../packages/venue/src/catalogue.ts';
import { createJevClient, intakeExposure } from '../../packages/intake/src/index.ts';

afterEach(() => vi.useRealTimers());
function index(marketCount = 1, title = 'Rainfall in London?', startedAt = new Date().toISOString(), extra: unknown[] = []) {
  const events = gammaPageSchema.parse({ events: [...Array.from({ length: 7 }, (_, i) => ({
    id: String(i + 1), title: `${title} ${i + 1}`, active: true, closed: false,
    tags: [{ slug: 'unexpected-provider-tag', label: 'Unfamiliar' }],
    endDate: '2026-12-01T00:00:00Z',
    markets: Array.from({ length: marketCount }, (_, j) => ({ id: `${i + 1}${j + 1}`, question: title,
      active: true, closed: false, acceptingOrders: true, description: 'Synthetic full rule',
      version: 'v1', outcomes: '["Yes","No"]', clobTokenIds: '["100","101"]' })),
  })), ...extra] }).events;
  return createCatalogueIndex({ schemaVersion: 'catalogue-v1', parserVersion: 'gamma-discovery-v2',
    generationId: randomUUID(), dataMode: 'synthetic', source: 'https://gamma-api.polymarket.com/events/keyset',
    coverage: 'completed-open-event-walk', startedAt, completedAt: startedAt, pages: 1, events });
}
const input = { text: 'Rainfall in London will cost me $5,000. Hedge budget $100.',
  timezone: 'Europe/London', interpretedAt: '2026-10-17T19:00:00Z' };
function provider(fit = 'match', picks: Record<string, string> = { templateId: 'conditional_loss',
  observable: 'span-0', fixedLossUsd: 'span-1', budgetUsd: 'span-2', currency: 'USD', observationKind: 'binary' }): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const choice = id.startsWith('candidate_') ? fit : picks[id] ?? 'missing';
      return [id, { type: 'choice', choice, confidence: 1,
        probabilities: Object.fromEntries(Object.keys((question as any).criteria).map(key => [key, key === choice ? 1 : 0])) }];
    }));
    return Response.json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 99, output_tokens: 20 } });
  };
}

it('runs two bounded batches over cached candidates, retaining review status and missing observation facts', async () => {
  const result = await intakeExposure(input, { catalogue: index(), client: createJevClient({ apiKey: 'synthetic', fetchImpl: provider() }) });
  expect(result.discovery.status).toBe('suggestions');
  expect(result.discovery.suggestions).toHaveLength(3);
  expect(result.discovery.consideredEventIds).toEqual(['1', '2', '3', '4', '5']);
  expect(result.discovery.suggestions[0]).toMatchObject({ eventId: '1', reviewStatus: 'needs_rule_review' });
  expect(result.draft.fields.fixedLossUsd?.value).toBe('5000');
  expect(result.draft.missingFields).toContain('observation');
  expect(result.discovery.provider?.usage.input_tokens).toBe(99);
  expect(result.discovery.catalogue?.dataMode).toBe('synthetic');
});

it('keeps empty discovery, model non-match, oversized events and expired catalogue distinct', async () => {
  const client = createJevClient({ apiKey: 'synthetic', fetchImpl: provider() });
  expect((await intakeExposure(input, { catalogue: index(1, 'Unrelated sports'), client })).discovery.status).toBe('no_discovery_match');
  expect((await intakeExposure(input, { catalogue: index(9), client })).discovery.status).toBe('unsupported_structure');
  expect((await intakeExposure(input, { catalogue: index(1, 'Rainfall', '2020-01-01T00:00:00Z'), client })).discovery.status).toBe('catalogue_expired');
  expect((await intakeExposure(input, { catalogue: index(), client: createJevClient({ apiKey: 'synthetic', fetchImpl: provider('mismatch') }) }))
    .discovery.status).toBe('no_semantic_suggestion');
});

it('preserves the useful draft when candidate judgments fail, rather than claiming no compatible market', async () => {
  const good = provider();
  const result = await intakeExposure(input, { catalogue: index(), client: createJevClient({ apiKey: 'synthetic', fetchImpl: async (url, init) => {
    const request = JSON.parse(String(init?.body));
    return request.questions.templateId ? good(url, init) : new Response(null, { status: 503 });
  } }) });
  expect(result.discovery).toMatchObject({ status: 'dependency_unavailable', failure: 'http_error', suggestions: [] });
  expect(result.draft.fields.budgetUsd?.value).toBe('100');
});

it('requires the selected observable before top-k so rare budget words cannot displace relevant markets', async () => {
  const catalogue = index(1, 'Government budget vote', new Date().toISOString(), [{ id: 'btc', title: 'Bitcoin price below $70k?',
    active: true, closed: false, markets: [{ id: 'btc-market', question: 'Bitcoin price below $70k?',
      active: true, closed: false, acceptingOrders: true }] }]);
  const result = await intakeExposure({ ...input, text: 'I hold 2 BTC, reference $70,000; budget $1,000.' }, {
    catalogue, client: createJevClient({ apiKey: 'synthetic', fetchImpl: provider('match', {
      templateId: 'terminal_downside', observable: 'span-1', units: 'span-0', referencePriceUsd: 'span-2', budgetUsd: 'span-3',
    }) }),
  });
  expect(result.discovery.consideredEventIds).toEqual(['btc']);
  expect(result.discovery.suggestions[0]?.eventId).toBe('btc');
});

it('retrieves precipitation as a rainfall candidate without treating the terms as identical settlement rules', async () => {
  const result = await intakeExposure({ ...input, text: 'Rainfall costs $5,000. Budget $100.' }, { catalogue: index(1, 'Precipitation in London?'),
    client: createJevClient({ apiKey: 'synthetic', fetchImpl: provider() }) });
  expect(result.discovery.suggestions).toHaveLength(3);
  expect(result.discovery.suggestions.every(item => item.reviewStatus === 'needs_rule_review')).toBe(true);
});

it('enforces a shared ten-second ceiling even when the second call never returns', async () => {
  vi.useFakeTimers();
  const catalogue = index(), good = provider();
  const client = createJevClient({ apiKey: 'synthetic', fetchImpl: async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (!request.questions.templateId) return new Promise(() => {});
    await new Promise(resolve => setTimeout(resolve, 4990));
    return good(url, init);
  } });
  const pending = intakeExposure(input, { catalogue, client });
  await vi.advanceTimersByTimeAsync(10_000);
  const result = await pending;
  expect(result.discovery).toMatchObject({ status: 'dependency_unavailable', failure: 'timeout' });
  expect(result.draft.fields.fixedLossUsd?.value).toBe('5000');
});
