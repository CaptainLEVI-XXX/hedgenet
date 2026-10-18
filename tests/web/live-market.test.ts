import { afterEach, expect, it, vi } from 'vitest';
import type { ExposureDraft } from '../../packages/intake/src/index.ts';
import { rememberLiveSelection, inspectLiveMarket } from '../../apps/web/lib/live-market.ts';

const draft: ExposureDraft = { schemaVersion: 'exposure-draft-v1', draftId: 'draft-1', revision: 1,
  text: 'I lose $1000 if this exact condition occurs.', timezone: 'UTC', interpretedAt: '2026-10-18T00:00:00Z',
  questionVersion: 'exposure-questions-v1', status: 'needs_clarification', spans: [], fields: {},
  missingFields: ['resolutionSource'], provider: null, failure: null };
const conditionId = `0x${'b'.repeat(64)}`;
const market = { id: '11', slug: 'specific-condition', question: 'Specific condition?', description: 'YES if the specified condition occurs. Otherwise NO.',
  version: 'v1', conditionId, outcomes: '["No","Yes"]', clobTokenIds: '["102","101"]',
  active: true, closed: false, acceptingOrders: true, enableOrderBook: true, negRisk: false,
  orderMinSize: 5, orderPriceMinTickSize: 0.01, feesEnabled: false };
const event = { id: '1', slug: 'actual-event', title: 'Actual event', active: true, closed: false, markets: [market] };
const book = (asset_id: string, price: string) => ({ market: conditionId, asset_id,
  hash: asset_id, bids: [], asks: [{ price, size: '100' }], min_order_size: '5', tick_size: '0.01', neg_risk: false });
const provider = (value: unknown = event): typeof fetch => async url =>
  Response.json(String(url).endsWith('/books') ? [book('102', '0.81'), book('101', '0.23')] : value);
afterEach(() => vi.useRealTimers());

it('reads selected live rules and exact YES/NO books without claiming a neural hedge', async () => {
  const selectionToken = rememberLiveSelection(draft, ['1']);
  const result = await inspectLiveMarket({ selectionToken, eventId: '1' }, provider());
  expect(result.status).toBe('books_ready');
  expect(result.markets).toEqual([{ marketId: '11', question: market.question,
    description: market.description, url: 'https://polymarket.com/event/actual-event/specific-condition',
    yesAsk: '0.23', noAsk: '0.81', fee: 'No trading fee' }]);
  expect(result.snapshotId).toBeTruthy();
  expect(result).not.toHaveProperty('proposal');
  expect(result).not.toHaveProperty('positions');
});

it('rejects unselected identities and expired selections instead of accepting arbitrary market IDs', async () => {
  vi.useFakeTimers();
  const selectionToken = rememberLiveSelection(draft, ['1']);
  await expect(inspectLiveMarket({ selectionToken, eventId: '2' }, provider())).rejects.toMatchObject({ code: 'event_not_selected', status: 403 });
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  await expect(inspectLiveMarket({ selectionToken, eventId: '1' }, provider())).rejects.toMatchObject({ code: 'selection_expired', status: 410 });
});

it('keeps unknown fees and oversized events review-only, and dependency failures distinct', async () => {
  const selectionToken = rememberLiveSelection(draft, ['1']);
  const input = { selectionToken, eventId: '1' };
  const unknownFees = await inspectLiveMarket(input, provider({ ...event, markets: [{ ...market, feesEnabled: undefined }] }));
  expect(unknownFees.status).toBe('review_only');
  expect(unknownFees.reason).toMatch(/fee_unavailable/);
  expect(unknownFees.markets[0]).toMatchObject({ yesAsk: null, noAsk: null, fee: null });
  const oversized = await inspectLiveMarket(input, provider({ ...event, markets: Array.from({ length: 9 }, (_, i) => ({ ...market, id: String(i + 1) })) }));
  expect(oversized.status).toBe('review_only');
  expect(oversized.markets).toHaveLength(9);
  expect(oversized.reason).toMatch(/8/);
  await expect(inspectLiveMarket(input, async () => new Response(null, { status: 503 })))
    .rejects.toMatchObject({ status: 503, code: 'market_data_unavailable' });
});
