import { afterEach, expect, it, vi } from 'vitest';
import { createValuationProblem, evaluatePositions } from '@hedgenet/core';
import { assertBooksFresh, fetchBookSnapshot } from '@hedgenet/venue';

const conditionId = `0x${'a'.repeat(64)}`;
const legs = [
  { legId: 'yes', protocol: 'ctf', assetId: '101', conditionId },
  { legId: 'no', protocol: 'ctf', assetId: '102', conditionId },
];
function book(asset_id: string, asks = [{ price: '0.500', size: '4.00' }, { price: '0.200', size: '10.000' }]) {
  return { market: conditionId, asset_id, timestamp: '1700000000000', hash: `book-${asset_id}`,
    bids: [{ price: '0.10', size: '10' }], asks, min_order_size: '5.0', tick_size: '0.01', neg_risk: false };
}
const reply = (books: unknown[]): typeof fetch => async () => Response.json(books);
afterEach(() => vi.restoreAllMocks());

it('joins shuffled books by identity and values exact unreserved depth through the financial boundary', async () => {
  const snapshot = await fetchBookSnapshot(legs, { dataMode: 'synthetic', fetchImpl: async (url, init) => {
    expect(String(url)).toBe('https://clob.polymarket.com/books');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual([{ token_id: '101' }, { token_id: '102' }]);
    return Response.json([book('102', []), book('101')]);
  } });
  expect(snapshot.books.map(book => book.legId)).toEqual(['yes', 'no']);
  expect(snapshot.books[0]).toMatchObject({ minShares: '5', asks: [{ price: '0.2', size: '10' }, { price: '0.5', size: '4' }],
    venueTimestamp: '1700000000000' });
  expect(snapshot.books[1]?.asks).toEqual([]);
  const problem = createValuationProblem({ schemaVersion: 'valuation-v1', currency: 'USD', dataMode: 'synthetic',
    snapshotId: snapshot.snapshotId, rulesHash: 'b'.repeat(64), budgetUsd: '1.8',
    states: [{ stateId: 'loss', originalLossUsd: '20' }], legs: snapshot.books.map(book => ({
      legId: book.legId, asks: book.asks, minShares: book.minShares, fee: { kind: 'none' },
      payouts: [{ stateId: 'loss', payoutPerShare: book.legId === 'yes' ? '1' : '0' }],
    })) });
  expect(evaluatePositions(problem, { schemaVersion: 'positions-v1', valuationHash: problem.contentHash,
    positions: [{ legId: 'yes', shares: '9' }, { legId: 'no', shares: '0' }] }).totalCostUsd).toBe('1.8');
});

it('rejects incomplete, duplicate, unexpected or wrongly bound books instead of inventing empty liquidity', async () => {
  for (const rows of [[book('101')], [book('101'), book('101')], [book('101'), book('999')],
    [book('101'), { ...book('102'), market: `0x${'b'.repeat(64)}` }]]) {
    await expect(fetchBookSnapshot(legs, { dataMode: 'synthetic', fetchImpl: reply(rows) })).rejects.toThrow();
  }
  await expect(fetchBookSnapshot([{ ...legs[0], protocol: 'v2' }], { dataMode: 'synthetic', fetchImpl: reply([]) })).rejects.toThrow();
  await expect(fetchBookSnapshot([legs[0], legs[0]], { dataMode: 'synthetic', fetchImpl: reply([]) })).rejects.toThrow();
});

it('rejects malformed prices, precision and missing constraints without monetary coercion', async () => {
  for (const change of [{ asks: [{ price: 'NaN', size: '1' }] }, { asks: [{ price: '0.2', size: '-1' }] },
    { asks: [{ price: '0.201', size: '1' }] }, { asks: [{ price: '0.2', size: '1.0000000000001' }] },
    { asks: [{ price: 0.2, size: '1' }] }, { min_order_size: undefined }, { tick_size: undefined }]) {
    await expect(fetchBookSnapshot([legs[0]], { dataMode: 'synthetic', fetchImpl: reply([{ ...book('101'), ...change }]) })).rejects.toThrow();
  }
});

it('checks host freshness and content integrity rather than requiring a recent venue update', async () => {
  const snapshot = await fetchBookSnapshot(legs, { dataMode: 'synthetic', fetchImpl: reply([book('101'), book('102')]) });
  expect(() => assertBooksFresh(snapshot, snapshot.fetchStartedAtMs + 30_000)).not.toThrow();
  expect(() => assertBooksFresh(snapshot, snapshot.fetchStartedAtMs + 30_001)).toThrow(/stale/i);
  expect(() => assertBooksFresh(snapshot, snapshot.fetchStartedAtMs - 1)).toThrow();
  const changed = structuredClone(snapshot);
  changed.books[0]!.asks[0]!.size = '1000';
  expect(() => assertBooksFresh(changed)).toThrow(/hash/i);
  const clock = vi.spyOn(Date, 'now');
  const start = Date.parse('2026-10-17T20:00:00Z');
  clock.mockReturnValueOnce(start).mockReturnValue(start + 5001);
  await expect(fetchBookSnapshot(legs, { dataMode: 'synthetic', fetchImpl: reply([book('101'), book('102')]) })).rejects.toThrow(/span/i);
});
