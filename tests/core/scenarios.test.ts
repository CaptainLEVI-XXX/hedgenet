import { expect, it } from 'vitest';
import { buildScenarios, createValuationProblem, evaluatePositions } from '@hedgenet/core';

const asset = { schemaVersion: 'loss-v1', currency: 'USD', templateId: 'terminal_downside',
  units: '2', referencePriceUsd: '10' };
const weather = { schemaVersion: 'loss-v1', currency: 'USD', templateId: 'threshold_loss',
  direction: 'above', threshold: '-2', lossRateUsd: '3', maxLossUsd: '1' };
const bound = (value: string, inclusive: boolean) => ({ value, inclusive });
const bucket = (id: string, lower: ReturnType<typeof bound> | null, upper: ReturnType<typeof bound> | null) =>
  ({ marketId: id, yesLegId: `${id}:yes`, noLegId: `${id}:no`, lower, upper });
const numeric = { schemaVersion: 'settlement-v1', kind: 'numeric_partition', domain: 'continuous', buckets: [
  bucket('synthetic:low', bound('0', true), bound('5', false)),
  bucket('synthetic:mid', bound('5', true), bound('10', false)),
  bucket('synthetic:high', bound('10', true), null),
] };

it('keeps one-sided payouts at shared boundaries and covers the full asset domain', () => {
  const before = structuredClone(numeric);
  const result = buildScenarios(asset, numeric);
  expect(result.states.map(state => state.originalLossUsd)).toEqual(['20', '10', '10', '0', '0', '0']);
  expect(result.states.map(state => state.location)).toEqual([
    { kind: 'numeric', value: '0', side: 'at' },
    { kind: 'numeric', value: '5', side: 'below' },
    { kind: 'numeric', value: '5', side: 'at' },
    { kind: 'numeric', value: '10', side: 'below' },
    { kind: 'numeric', value: '10', side: 'at' },
    { kind: 'tail', direction: 'positive' },
  ]);
  expect(result.legs.map(leg => leg.payouts.map(payout => payout.payoutPerShare))).toEqual([
    ['1', '1', '0', '0', '0', '0'], ['0', '0', '1', '1', '1', '1'],
    ['0', '0', '1', '1', '0', '0'], ['1', '1', '0', '0', '1', '1'],
    ['0', '0', '0', '0', '1', '1'], ['1', '1', '1', '1', '0', '0'],
  ]);
  expect(buildScenarios(asset, { ...numeric, buckets: [...numeric.buckets].reverse() })).toEqual(result);
  expect(numeric).toEqual(before);
  const problem = createValuationProblem({
    schemaVersion: 'valuation-v1', currency: 'USD', dataMode: 'synthetic',
    snapshotId: 'synthetic:intervals', rulesHash: 'a'.repeat(64), budgetUsd: '2',
    states: result.states.map(({ stateId, originalLossUsd }) => ({ stateId, originalLossUsd })),
    legs: result.legs.map(leg => ({ ...leg, minShares: '1', fee: { kind: 'none' }, asks: [{ price: '0.2', size: '20' }] })),
  });
  const quote = evaluatePositions(problem, { schemaVersion: 'positions-v1', valuationHash: problem.contentHash,
    positions: result.legs.map(leg => ({ legId: leg.legId, shares: leg.legId === 'synthetic:low:yes' ? '10' : '0' })) });
  expect(quote.worstNetLossUsd).toBe('12');
  expect(quote.riskReductionUsd).toBe('8');
});

it('retains exact symbolic nonterminating cap breakpoints and both weather tails', () => {
  const settlement = { ...numeric, buckets: [
    bucket('cold', null, bound('-3', false)),
    bucket('middle', bound('-3', true), bound('0', false)),
    bucket('warm', bound('0', true), null),
  ] };
  for (const [direction, expected] of [
    ['above', ['0', '0', '0', '0', '1', '1', '1', '1']],
    ['below', ['1', '1', '1', '1', '0', '0', '0', '0']],
  ] as const) {
    const result = buildScenarios({ ...weather, direction }, settlement);
    expect(result.states.map(state => state.originalLossUsd)).toEqual(expected);
    expect(result.states.filter(state => state.location.kind === 'loss_cap')).toHaveLength(1);
    expect(result.states.filter(state => state.location.kind === 'loss_cap')[0]?.originalLossUsd).toBe('1');
    const middle = result.states.slice(3, 5).map(state => state.location.kind);
    expect(middle).toEqual(direction === 'above' ? ['numeric', 'loss_cap'] : ['loss_cap', 'numeric']);
  }
});

it('preserves a singleton resolving outcome instead of discarding a zero-width bucket', () => {
  const settlement = { ...numeric, buckets: [
    bucket('below', null, bound('-2', false)),
    bucket('exact', bound('-2', true), bound('-2', true)),
    bucket('above', bound('-2', false), null),
  ] };
  const result = buildScenarios(weather, settlement);
  const exact = result.legs.find(leg => leg.legId === 'exact:yes')!;
  const winners = exact.payouts.filter(payout => payout.payoutPerShare === '1');
  expect(winners).toHaveLength(1);
  expect(result.states.find(state => state.stateId === winners[0]?.stateId)?.location)
    .toEqual({ kind: 'numeric', value: '-2', side: 'at' });
  expect(result.states.flatMap(state => state.location.kind === 'numeric' && state.location.value === '-2'
    ? [state.location.side] : [])).toEqual(['below', 'at', 'above']);
});

it('does not step across narrow intervals or round near a cap at twelve decimal places', () => {
  const settlement = { ...numeric, buckets: [
    bucket('low', null, bound('0.333333333333', false)),
    bucket('narrow', bound('0.333333333333', true), bound('0.333333333334', false)),
    bucket('high', bound('0.333333333334', true), null),
  ] };
  const result = buildScenarios({ ...weather, threshold: '0' }, settlement);
  expect(result.states.map(state => state.originalLossUsd)).toEqual(['0', '0', '0.999999999999',
    '0.999999999999', '1', '1', '1', '1']);
  const cap = result.states.find(state => state.location.kind === 'loss_cap')!;
  expect(result.legs.find(leg => leg.legId === 'narrow:yes')?.payouts.find(payout => payout.stateId === cap.stateId)?.payoutPerShare).toBe('1');
});

it('maps an exact binary condition to false/true losses and complementary payouts', () => {
  const loss = { schemaVersion: 'loss-v1', currency: 'USD', templateId: 'conditional_loss', conditionId: 'rain-a', fixedLossUsd: '5000' };
  const settlement = { schemaVersion: 'settlement-v1', kind: 'binary', conditionId: 'rain-a', marketId: 'rain', yesLegId: 'yes', noLegId: 'no' };
  const result = buildScenarios(loss, settlement);
  expect(result.states.map(state => state.originalLossUsd)).toEqual(['0', '5000']);
  expect(result.states.map(state => state.location)).toEqual([
    { kind: 'condition', conditionId: 'rain-a', occurs: false },
    { kind: 'condition', conditionId: 'rain-a', occurs: true },
  ]);
  expect(result.legs.map(leg => leg.payouts.map(payout => payout.payoutPerShare))).toEqual([['0', '1'], ['1', '0']]);
  expect(() => buildScenarios(loss, { ...settlement, conditionId: 'rain-b' })).toThrow();
  expect(() => buildScenarios(asset, settlement)).toThrow();
  expect(() => buildScenarios(loss, numeric)).toThrow();
  expect(() => buildScenarios(loss, { ...settlement, noLegId: 'yes' })).toThrow();
});

it('rejects gaps, overlaps, missing tails, empty buckets and ambiguous identities', () => {
  for (const buckets of [
    numeric.buckets.slice(1),
    [bucket('a', bound('1', true), bound('5', false)), numeric.buckets[1], numeric.buckets[2]],
    [bucket('a', null, bound('5', false)), numeric.buckets[1], numeric.buckets[2]],
    [numeric.buckets[0], numeric.buckets[1], bucket('c', bound('10', true), bound('20', true))],
    [numeric.buckets[0], bucket('b', bound('6', true), bound('10', false)), numeric.buckets[2]],
    [numeric.buckets[0], bucket('b', bound('4', true), bound('10', false)), numeric.buckets[2]],
    [numeric.buckets[0], bucket('b', bound('5', false), bound('10', false)), numeric.buckets[2]],
    [bucket('a', bound('0', true), bound('5', true)), numeric.buckets[1], numeric.buckets[2]],
    [numeric.buckets[0], bucket('b', bound('5', true), bound('5', false)), numeric.buckets[2]],
    [numeric.buckets[0], { ...numeric.buckets[1], marketId: 'synthetic:low' }, numeric.buckets[2]],
    [numeric.buckets[0], { ...numeric.buckets[1], yesLegId: 'synthetic:low:no' }, numeric.buckets[2]],
    Array.from({ length: 9 }, (_, i) => bucket(`b${i}`, bound(String(i), true), i === 8 ? null : bound(String(i + 1), false))),
  ]) expect(() => buildScenarios(asset, { ...numeric, buckets })).toThrow();
  expect(() => buildScenarios(weather, numeric)).toThrow(); // Missing negative tail.
  expect(() => buildScenarios(asset, { ...numeric, domain: 'integer' })).toThrow();
  expect(() => buildScenarios(asset, { ...numeric, guaranteed: true })).toThrow();
});
