import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evaluatePositions } from '@hedgenet/core';
import { fetchEventRules, fetchMarketSnapshot } from '@hedgenet/venue';
import { assembleConfirmedValuation, confirmExposure, createRuleReview, reviseBudget } from '../../packages/intake/src/index.ts';
import type { ExposureDraft } from '../../packages/intake/src/index.ts';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-17T19:00:00Z'); });
afterEach(() => vi.useRealTimers());

const conditionId = `0x${'b'.repeat(64)}`;
const description = 'Rainfall at station KJFK totals at least 1 mm during November 30, 2026 UTC, per NOAA.';
const data = { id: '31', title: 'Synthetic rain condition', description, active: true, closed: false,
  markets: [{ id: '32', question: 'Rain at JFK?', description, resolutionSource: 'NOAA',
    conditionId, version: 'v1', outcomes: '["No","Yes"]', clobTokenIds: '["302","301"]',
    active: true, closed: false, acceptingOrders: true, enableOrderBook: true, negRisk: false,
    feesEnabled: false, orderMinSize: 1, orderPriceMinTickSize: 0.01 }] };
const fetchImpl: typeof fetch = async url => String(url).endsWith('/books') ? Response.json(['302', '301'].map(asset_id => ({
  market: conditionId, asset_id, timestamp: '1700000000000', hash: asset_id, bids: [],
  asks: [{ price: '0.2', size: '100' }], min_order_size: '1', tick_size: '0.01', neg_risk: false,
}))) : Response.json(data);
const options = { dataMode: 'synthetic' as const, fetchImpl };
const semantics = { observable: 'rainfall', unit: 'mm', location: 'KJFK', resolutionSource: 'NOAA',
  observation: { kind: 'window' as const, start: '2026-11-30T00:00:00Z', end: '2026-12-01T00:00:00Z', timezone: 'UTC', statistic: 'sum' } };
const loss = { schemaVersion: 'loss-v1' as const, currency: 'USD' as const, templateId: 'conditional_loss' as const,
  conditionId, fixedLossUsd: '100' };
const settlement = { schemaVersion: 'settlement-v1', kind: 'binary', conditionId,
  marketId: '32', yesLegId: 'polymarket:ctf:32:yes', noLegId: 'polymarket:ctf:32:no' };
const draft: ExposureDraft = { schemaVersion: 'exposure-draft-v1', draftId: 'd1', revision: 1,
  text: 'Rain costs $100 at JFK; budget $10.', timezone: 'UTC', interpretedAt: '2026-10-17T19:00:00Z',
  questionVersion: 'exposure-questions-v1', status: 'needs_clarification', spans: [], fields: {}, missingFields: [], provider: null, failure: null };
const acknowledged = ['loss', 'budget', 'semantics', 'market_rules', 'normal_resolution_only', 'collateral_usd_parity'];
const reviewInput = () => ({ semantics: structuredClone(semantics), settlement: structuredClone(settlement),
  evidence: [{ marketId: '32', quote: description }] });
async function setup() {
  const rules = await fetchEventRules('31', options);
  const review = createRuleReview(rules, reviewInput());
  const request = { draftId: draft.draftId, expectedRevision: 1, loss, semantics, budgetUsd: '10',
    eventId: '31', rulesHash: rules.rulesHash, reviewHash: review.contentHash, acknowledged };
  return { rules, review, request };
}

it('assembles confirmed rain loss against fresh, identity-joined books and independently checks the result', async () => {
  const { rules, review, request } = await setup();
  const confirmed = confirmExposure(draft, request, review);
  const snapshot = await fetchMarketSnapshot({ eventId: '31', expectedRulesHash: rules.rulesHash, marketIds: ['32'] }, options);
  const result = assembleConfirmedValuation(confirmed, review, snapshot);
  expect(result.valuation.states.map(state => state.originalLossUsd)).toEqual(['0', '100']);
  expect(result.valuation.legs.map(leg => leg.legId)).toEqual(['polymarket:ctf:32:yes', 'polymarket:ctf:32:no']);
  const measured = evaluatePositions(result.valuation, { schemaVersion: 'positions-v1', valuationHash: result.valuation.contentHash,
    positions: result.valuation.legs.map((leg, index) => ({ legId: leg.legId, shares: index === 0 ? '50' : '0' })) });
  expect(measured.totalCostUsd).toBe('10');
  expect(measured.improvesModeledRisk).toBe(true); // Loss: dry=10, rainy=100+10−50=60, versus 100 unhedged.
  expect(measured.worstNetLossUsd).toBe('60');
  expect(result.exposureHash).toBe(confirmed.contentHash);
  const revised = reviseBudget(confirmed, { expectedRevision: 1, budgetUsd: '0' });
  expect(revised.revision).toBe(2);
  expect(revised.loss).toEqual(confirmed.loss);
  expect(revised.contentHash).not.toBe(confirmed.contentHash);
  expect(assembleConfirmedValuation(revised, review, snapshot).valuation.budgetUsd).toBe('0');
  expect(() => reviseBudget(revised, { expectedRevision: 1, budgetUsd: '20' })).toThrow(/revision/i);
});

it('blocks exact date, station, unit, source and aggregation mismatches regardless of model suggestions', async () => {
  const { review, request } = await setup();
  for (const patch of [{ location: 'KLGA' }, { unit: 'inches' }, { resolutionSource: 'Other' },
    { observable: 'temperature' }, { observation: { ...semantics.observation, statistic: 'maximum' } },
    { observation: { ...semantics.observation, start: '2026-12-30T00:00:00Z', end: '2026-12-31T00:00:00Z' } }]) {
    expect(() => confirmExposure(draft, { ...request, semantics: { ...semantics, ...patch } }, review)).toThrow(/mismatch/i);
  }
  expect(() => confirmExposure(draft, { ...request, semantics: { ...semantics, resolutionSource: null } }, review)).toThrow();
  expect(() => confirmExposure(draft, { ...request, loss: { ...loss, conditionId: 'different' } }, review)).toThrow(/condition/i);
});

it('requires explicit acknowledgments, current revision and unchanged host-owned review', async () => {
  const { rules, review, request } = await setup();
  for (const patch of [{ expectedRevision: 2 }, { draftId: 'someone-else' }, { acknowledged: ['loss'] },
    { rulesHash: 'f'.repeat(64) }, { reviewHash: 'f'.repeat(64) }]) {
    expect(() => confirmExposure(draft, { ...request, ...patch }, review)).toThrow();
  }
  expect(() => createRuleReview(rules, { ...reviewInput(), evidence: [{ marketId: '32', quote: 'Invented station rules' }] })).toThrow(/evidence/i);
  const changed = structuredClone(review);
  changed.semantics.location = 'KLGA';
  expect(() => confirmExposure(draft, request, changed)).toThrow(/hash/i);
  expect(() => createRuleReview(rules, { ...reviewInput(), settlement: { ...settlement, yesLegId: 'polymarket:ctf:32:no' } })).toThrow(/identity/i);
});

it('blocks stale snapshots, changed review/rules and modified confirmed financial values', async () => {
  const { rules, review, request } = await setup();
  const confirmed = confirmExposure(draft, request, review);
  const snapshot = await fetchMarketSnapshot({ eventId: '31', expectedRulesHash: rules.rulesHash, marketIds: ['32'] }, options);
  expect(() => assembleConfirmedValuation(confirmed, review, snapshot, snapshot.event.fetchStartedAtMs + 30_001)).toThrow(/stale/i);
  expect(() => assembleConfirmedValuation({ ...confirmed, budgetUsd: '999' }, review, snapshot)).toThrow(/hash/i);
  const newRules = await fetchEventRules('31', { dataMode: 'synthetic', fetchImpl: async () => Response.json({ ...data, description: 'Updated parent rules' }) });
  const changedReview = createRuleReview(newRules, reviewInput());
  expect(() => assembleConfirmedValuation(confirmed, changedReview, snapshot)).toThrow(/review|rules/i);
});

it('joins numeric partitions in canonical order for asset downside and capped continuous weather loss', async () => {
  for (const weather of [false, true]) {
    const semantic = weather ? { ...semantics, observable: 'temperature', unit: '°C' } : {
      observable: 'bitcoin', unit: 'USD', location: null, resolutionSource: 'Synthetic price feed',
      observation: { kind: 'point', at: '2026-11-30T00:00:00Z', timezone: 'UTC', statistic: 'spot' },
    };
    const lossRule = weather ? { schemaVersion: 'loss-v1', currency: 'USD', templateId: 'threshold_loss',
      threshold: '-5', direction: 'below', lossRateUsd: '2', maxLossUsd: '30' } : {
      schemaVersion: 'loss-v1', currency: 'USD', templateId: 'terminal_downside', units: '2', referencePriceUsd: '100',
    };
    const markets = [1, 2, 3].map(i => ({ ...data.markets[0], id: String(40 + i),
      conditionId: `0x${String(i).repeat(64)}`, clobTokenIds: JSON.stringify([String(400 + 2 * i), String(399 + 2 * i)]),
      description: `Synthetic continuous ${weather ? 'temperature' : 'price'} bucket ${i}.` }));
    const opts = { dataMode: 'synthetic' as const, fetchImpl: (async url => String(url).endsWith('/books')
      ? Response.json(markets.flatMap(market => JSON.parse(market.clobTokenIds).map((asset_id: string) => ({
        asset_id, market: market.conditionId, hash: asset_id, bids: [], asks: [{ price: '0.2', size: '100' }],
        min_order_size: '1', tick_size: '0.01', neg_risk: false,
      })))) : Response.json({ ...data, markets: [...markets].reverse() })) as typeof fetch };
    const rules = await fetchEventRules('31', opts);
    const bounds = weather ? [null, '-5', '10', null] : ['0', '50', '100', null];
    const buckets = markets.map((market, i) => ({ marketId: market.id, yesLegId: `polymarket:ctf:${market.id}:yes`,
      noLegId: `polymarket:ctf:${market.id}:no`, lower: bounds[i] === null ? null : { value: bounds[i], inclusive: true },
      upper: bounds[i + 1] === null ? null : { value: bounds[i + 1], inclusive: false } }));
    const review = createRuleReview(rules, { semantics: semantic,
      settlement: { schemaVersion: 'settlement-v1', kind: 'numeric_partition', domain: 'continuous', buckets: [...buckets].reverse() },
      evidence: markets.map(market => ({ marketId: market.id, quote: market.description })) });
    const confirmed = confirmExposure(draft, { draftId: draft.draftId, expectedRevision: 1, loss: lossRule, semantics: semantic,
      budgetUsd: '10', eventId: '31', rulesHash: rules.rulesHash, reviewHash: review.contentHash, acknowledged }, review);
    const snapshot = await fetchMarketSnapshot({ eventId: '31', expectedRulesHash: rules.rulesHash, marketIds: ['43', '42', '41'] }, opts);
    const { valuation } = assembleConfirmedValuation(confirmed, review, snapshot);
    const result = evaluatePositions(valuation, { schemaVersion: 'positions-v1', valuationHash: valuation.contentHash,
      positions: valuation.legs.map(leg => ({ legId: leg.legId, shares: leg.legId === 'polymarket:ctf:41:yes' ? '50' : '0' })) });
    expect(result.worstNetLossUsd).toBe(weather ? '10' : '160');
    expect(valuation.legs[0]?.legId).toBe('polymarket:ctf:41:yes');
  }
});
