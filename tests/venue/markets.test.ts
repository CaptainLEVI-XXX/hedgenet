import { expect, it } from 'vitest';
import { createValuationProblem, evaluatePositions } from '@hedgenet/core';
import { assertMarketSnapshotFresh, fetchEventRules, fetchMarketSnapshot } from '@hedgenet/venue';

const conditionId = `0x${'a'.repeat(64)}`;
const market = () => ({ id: '11', question: 'Synthetic rain?', description: 'YES if the stipulated rain condition occurs.',
  resolutionSource: 'Synthetic weather station', endDate: '2026-12-01T00:00:00Z', conditionId,
  version: 'v1', outcomes: '["No","Yes"]', clobTokenIds: '["102","101"]',
  active: true, closed: false, acceptingOrders: true, enableOrderBook: true, negRisk: false,
  orderMinSize: 5, orderPriceMinTickSize: 0.01, feesEnabled: true,
  feeSchedule: { rate: 0.02, exponent: 1, takerOnly: true } });
const event = () => ({ id: '1', title: 'Synthetic weather', description: 'Synthetic event rules',
  active: true, closed: false, markets: [market()] });
const book = (asset_id: string) => ({ market: conditionId, asset_id, timestamp: '1700000000000', hash: asset_id,
  bids: [], asks: [{ price: '0.20', size: '10' }], min_order_size: '5', tick_size: '0.01', neg_risk: false });
function provider(value: unknown, books: unknown[] = [book('102'), book('101')]): typeof fetch {
  return async url => String(url).endsWith('/books') ? Response.json(books) : Response.json(value);
}
const options = (value: unknown, books?: unknown[]) => ({ dataMode: 'synthetic' as const, fetchImpl: provider(value, books) });

it.each(['live', 'recorded'] as const)('joins published display metadata by exact market identity in %s snapshots', async dataMode => {
  const data = { ...event(), slug: 'weather-event', markets: [
    { ...market(), slug: 'rain-market' },
    { ...market(), id: '12', question: 'Other condition?', slug: 'other-market',
      outcomes: '["Yes","No"]', clobTokenIds: '["201","202"]' },
  ] };
  const opts = { dataMode, fetchImpl: provider(data, [book('202'), book('101'), book('201'), book('102')]) };
  const rules = await fetchEventRules('1', opts);
  expect(rules.slug).toBe('weather-event');
  expect(rules.markets.map(m => m.slug)).toEqual(['rain-market', 'other-market']);
  const snapshot = await fetchMarketSnapshot({ eventId: '1', expectedRulesHash: rules.rulesHash, marketIds: ['12', '11'] }, opts);
  expect(snapshot.legs.map(leg => [leg.marketId, leg.side, leg.assetId, leg.question, leg.url])).toEqual([
    ['11', 'YES', '101', 'Synthetic rain?', 'https://polymarket.com/event/weather-event/rain-market'],
    ['11', 'NO', '102', 'Synthetic rain?', 'https://polymarket.com/event/weather-event/rain-market'],
    ['12', 'YES', '201', 'Other condition?', 'https://polymarket.com/event/weather-event/other-market'],
    ['12', 'NO', '202', 'Other condition?', 'https://polymarket.com/event/weather-event/other-market'],
  ]);
  const changed = structuredClone(snapshot);
  changed.legs[0]!.url = 'https://polymarket.com/event/other';
  expect(() => assertMarketSnapshotFresh(changed)).toThrow(/hash/i);
  const changedSlug = structuredClone(snapshot);
  changedSlug.event.markets[0]!.slug = 'changed';
  expect(() => assertMarketSnapshotFresh(changedSlug)).toThrow(/hash/i);
});

it('uses only valid published slugs, with event fallback only for an absent market slug', async () => {
  for (const [dataMode, eventSlug, marketSlug, expected] of [
    ['recorded', 'weather-event', undefined, 'https://polymarket.com/event/weather-event'],
    ['recorded', 'weather-event', null, 'https://polymarket.com/event/weather-event'],
    ['synthetic', 'weather-event', 'rain-market', null],
    ['recorded', undefined, 'rain-market', null],
    ['recorded', null, 'rain-market', null],
    ['recorded', '../weather', 'rain-market', null],
    ['recorded', 'weather-event', '../rain', null],
    ['recorded', 'weather-event', 'rain?redirect=other', null],
    ['recorded', 'weather-event', '', null],
  ] as const) {
    const data = { ...event(), slug: eventSlug, markets: [{ ...market(), slug: marketSlug }] };
    const opts = { dataMode, fetchImpl: provider(data) };
    const rules = await fetchEventRules('1', opts);
    expect(rules.slug).toBe(eventSlug ?? null);
    expect(rules.markets[0]!.slug).toBe(marketSlug ?? null);
    const snapshot = await fetchMarketSnapshot({ eventId: '1', expectedRulesHash: rules.rulesHash, marketIds: ['11'] }, opts);
    expect(snapshot.legs.map(leg => leg.url)).toEqual([expected, expected]);
  }
});

it('keeps published slug changes out of the resolution confirmation hash', async () => {
  const original = await fetchEventRules('1', options(event()));
  const data = { ...event(), slug: 'published-event', markets: [{ ...market(), slug: 'published-market' }] };
  const changed = await fetchEventRules('1', options(data));
  expect(changed.slug).toBe('published-event');
  expect(changed.rulesHash).toBe(original.rulesHash);
  const opts = { dataMode: 'recorded' as const, fetchImpl: provider(data) };
  const snapshot = await fetchMarketSnapshot({ eventId: '1', expectedRulesHash: original.rulesHash, marketIds: ['11'] }, opts);
  expect(snapshot.legs[0]!.url).toBe('https://polymarket.com/event/published-event/published-market');
});

it('binds full rules, reversed YES/NO identities and exact fees to independently valued positions', async () => {
  const data = event(), opts = options(data);
  const rules = await fetchEventRules('1', opts);
  const snapshot = await fetchMarketSnapshot({ eventId: '1', expectedRulesHash: rules.rulesHash, marketIds: ['11'] }, opts);
  expect(snapshot.event.markets[0]).toMatchObject({ description: data.markets[0]!.description,
    fee: { kind: 'curve', rate: '0.02', exponent: 1 }, observation: null });
  expect(snapshot.legs.map(leg => [leg.side, leg.assetId])).toEqual([['YES', '101'], ['NO', '102']]);
  const problem = createValuationProblem({ schemaVersion: 'valuation-v1', currency: 'USD', dataMode: 'synthetic',
    snapshotId: snapshot.snapshotId, rulesHash: snapshot.event.rulesHash, budgetUsd: '1.8288',
    states: [{ stateId: 'rain', originalLossUsd: '20' }], legs: snapshot.legs.map(leg => {
      const quote = snapshot.books.books.find(book => book.legId === leg.legId)!;
      return { legId: leg.legId, minShares: quote.minShares, asks: quote.asks, fee: leg.fee,
        payouts: [{ stateId: 'rain', payoutPerShare: leg.side === 'YES' ? '1' : '0' }] };
    }) });
  expect(evaluatePositions(problem, { schemaVersion: 'positions-v1', valuationHash: problem.contentHash,
    positions: snapshot.legs.map(leg => ({ legId: leg.legId, shares: leg.side === 'YES' ? '9' : '0' })) }).totalCostUsd).toBe('1.8288');
  expect(() => assertMarketSnapshotFresh(snapshot, snapshot.event.fetchStartedAtMs + 30_000)).not.toThrow();
  expect(() => assertMarketSnapshotFresh(snapshot, snapshot.event.fetchStartedAtMs + 30_001)).toThrow(/stale/i);
  const changed = structuredClone(snapshot);
  changed.legs[0]!.fee = { kind: 'none' };
  expect(() => assertMarketSnapshotFresh(changed)).toThrow(/hash/i);
});

it('keeps pricing changes out of the confirmation hash but invalidates changed resolution material', async () => {
  const data = event();
  const original = await fetchEventRules('1', options(data));
  const repriced = { ...data, volume: '99999', markets: [{ ...data.markets[0], outcomePrices: '["0.9","0.1"]',
    feeSchedule: { rate: 0.04, exponent: 1, takerOnly: true } }] };
  expect((await fetchEventRules('1', options(repriced))).rulesHash).toBe(original.rulesHash);
  for (const next of [{ ...data, description: 'Changed parent rules' },
    { ...data, markets: [{ ...data.markets[0], description: 'Changed settlement condition' }] },
    { ...data, markets: [{ ...data.markets[0], resolutionSource: 'Other station' }] }]) {
    await expect(fetchMarketSnapshot({ eventId: '1', expectedRulesHash: original.rulesHash, marketIds: ['11'] }, options(next)))
      .rejects.toMatchObject({ code: 'rules_changed' });
  }
});

it('requires explicit supported fee metadata and preserves exact numeric source tokens', async () => {
  for (const patch of [{ feesEnabled: undefined }, { feeSchedule: undefined },
    { feeSchedule: { rate: 0.02, exponent: 2, takerOnly: true } },
    { feesEnabled: false }, { feeSchedule: { rate: -0.01, exponent: 1, takerOnly: true } }]) {
    const data = { ...event(), markets: [{ ...market(), ...patch }] }, opts = options(data);
    const rules = await fetchEventRules('1', opts);
    expect(rules.markets[0]?.fee).toBeNull();
    await expect(fetchMarketSnapshot({ eventId: '1', expectedRulesHash: rules.rulesHash, marketIds: ['11'] }, opts))
      .rejects.toMatchObject({ code: 'fee_unavailable' });
  }
  const free = { ...event(), markets: [{ ...market(), feesEnabled: false, feeSchedule: null }] };
  expect((await fetchEventRules('1', options(free))).markets[0]?.fee).toEqual({ kind: 'none' });
  const text = JSON.stringify(event()).replace('"rate":0.02', '"rate":0.0200000000000000001');
  const exact = await fetchEventRules('1', { dataMode: 'synthetic', fetchImpl: async () => new Response(text) });
  expect(exact.markets[0]?.fee).toBeNull(); // Must not round the numeric token into an accepted 0.02.
});

it('blocks closed/unknown status, unsupported protocols and changed book constraints', async () => {
  for (const patch of [{ active: false }, { closed: true }, { acceptingOrders: undefined },
    { enableOrderBook: false }, { version: 'v2' }, { clobTokenIds: '["101","101"]' }]) {
    const data = { ...event(), markets: [{ ...market(), ...patch }] }, opts = options(data);
    const rules = await fetchEventRules('1', opts);
    await expect(fetchMarketSnapshot({ eventId: '1', expectedRulesHash: rules.rulesHash, marketIds: ['11'] }, opts)).rejects.toThrow();
  }
  const opts = options(event(), [{ ...book('101'), min_order_size: '6' }, book('102')]);
  const rules = await fetchEventRules('1', opts);
  await expect(fetchMarketSnapshot({ eventId: '1', expectedRulesHash: rules.rulesHash, marketIds: ['11'] }, opts))
    .rejects.toMatchObject({ code: 'constraints_changed' });
  await expect(fetchMarketSnapshot({ eventId: '1', expectedRulesHash: rules.rulesHash, marketIds: ['11', '11'] }, opts)).rejects.toThrow();
  await expect(fetchEventRules('2', options(event()))).rejects.toThrow(/identity/i);
});
