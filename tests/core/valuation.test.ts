import { expect, it } from 'vitest';
import { createValuationProblem, evaluatePositions } from '@hedgenet/core';

// Synthetic trusted inputs, not parsed venue rules or live liquidity.
const input = {
  schemaVersion: 'valuation-v1', currency: 'USD', dataMode: 'synthetic',
  snapshotId: 'synthetic-book-1', rulesHash: 'a'.repeat(64), budgetUsd: '10',
  states: [
    { stateId: 'loss', originalLossUsd: '10' },
    { stateId: 'safe', originalLossUsd: '0' },
  ],
  legs: [{
    legId: 'synthetic:yes', minShares: '2', fee: { kind: 'none' },
    asks: [{ price: '0.5', size: '5' }, { price: '0.2', size: '4' }],
    payouts: [
      { stateId: 'loss', payoutPerShare: '1' },
      { stateId: 'safe', payoutPerShare: '0' },
    ],
  }],
};

function propose(problem: { contentHash: string }, shares = '5') {
  return { schemaVersion: 'positions-v1', valuationHash: problem.contentHash,
    positions: [{ legId: 'synthetic:yes', shares }] };
}

it('walks cheapest reserved levels and includes the full cost in every scenario', () => {
  const before = structuredClone(input);
  const problem = createValuationProblem(input);
  const result = evaluatePositions(problem, propose(problem));
  expect(result.totalPremiumUsd).toBe('1.6');
  expect(result.totalFeeUsd).toBe('0');
  expect(result.totalCostUsd).toBe('1.6');
  expect(result.positions[0]?.fills).toEqual([
    { price: '0.2', shares: '3', premiumUsd: '0.6', feeUsd: '0' },
    { price: '0.5', shares: '2', premiumUsd: '1', feeUsd: '0' },
  ]);
  expect(result.scenarios).toEqual([
    { stateId: 'loss', originalLossUsd: '10', payoutUsd: '5', netLossUsd: '6.6' },
    { stateId: 'safe', originalLossUsd: '0', payoutUsd: '0', netLossUsd: '1.6' },
  ]);
  expect(result.worstNetLossUsd).toBe('6.6');
  expect(result.riskReductionUsd).toBe('3.4');
  expect(result.improvesModeledRisk).toBe(true);
  expect(result.dataMode).toBe('synthetic');
  expect(result.feePolicy).toBe('ceil-5dp-per-level-v1');
  expect(input).toEqual(before);
  expect(createValuationProblem(input)).toEqual(problem);
  expect(evaluatePositions(problem, propose(problem))).toEqual(result);
});

it('merges before reserving, applies the reserve once, and uses only three distinct levels', () => {
  const problem = createValuationProblem({ ...input, legs: [{ ...input.legs[0], asks: [
    { price: '0.2', size: '3' }, { price: '0.2', size: '2' },
    { price: '0.3', size: '10' }, { price: '0.4', size: '1' },
    { price: '0.5', size: '100' },
  ] }] });
  expect(evaluatePositions(problem, propose(problem, '13')).totalCostUsd).toBe('3.5');
  expect(() => evaluatePositions(problem, propose(problem, '14'))).toThrow(/capacity/i);
  const ten = createValuationProblem({ ...input, legs: [{ ...input.legs[0], asks: [{ price: '0.2', size: '10' }] }] });
  expect(evaluatePositions(ten, propose(ten, '9')).totalCostUsd).toBe('1.8');
  expect(() => evaluatePositions(ten, propose(ten, '10'))).toThrow(/capacity/i);
});

it('charges the exponent-one fee and enforces exact budget boundaries without cents tolerance', () => {
  const withFee = { ...input, budgetUsd: '2.112', legs: [{ ...input.legs[0],
    asks: [{ price: '0.2', size: '12' }], fee: { kind: 'curve', rate: '0.07', exponent: 1 },
  }] };
  const problem = createValuationProblem(withFee);
  const result = evaluatePositions(problem, propose(problem, '10'));
  expect(result.totalPremiumUsd).toBe('2');
  expect(result.totalFeeUsd).toBe('0.112');
  expect(result.totalCostUsd).toBe('2.112');
  for (const budgetUsd of ['2.111999999999', '2.11']) {
    const lower = createValuationProblem({ ...withFee, budgetUsd });
    expect(() => evaluatePositions(lower, propose(lower, '10'))).toThrow(/budget/i);
  }
});

it('rounds the declared fee estimate up separately per consumed level, including tiny fees', () => {
  const problem = createValuationProblem({ ...input, legs: [{ ...input.legs[0], minShares: '1',
    asks: [{ price: '0.5', size: '2' }, { price: '0.6', size: '2' }],
    fee: { kind: 'curve', rate: '0.00002', exponent: 1 },
  }] });
  const result = evaluatePositions(problem, propose(problem, '2'));
  // 1 × .00002 × .5 × .5 = .000005; at .6 => .0000048.
  expect(result.positions[0]?.fills.map(fill => fill.feeUsd)).toEqual(['0.00001', '0.00001']);
  expect(result.totalFeeUsd).toBe('0.00002');
  expect(result.totalCostUsd).toBe('1.10002');
});

it('binds proposals and payouts by identity, not their array position', () => {
  const problem = createValuationProblem({ ...input, legs: [input.legs[0], {
    ...input.legs[0], legId: 'synthetic:no', asks: [{ price: '0.1', size: '10' }],
    payouts: [{ stateId: 'safe', payoutPerShare: '1' }, { stateId: 'loss', payoutPerShare: '0' }],
  }] });
  const proposal = { ...propose(problem), positions: [
    { legId: 'synthetic:no', shares: '2' }, { legId: 'synthetic:yes', shares: '5' },
  ] };
  const result = evaluatePositions(problem, proposal);
  expect(result.totalCostUsd).toBe('1.8');
  expect(result.scenarios.map(state => state.netLossUsd)).toEqual(['6.8', '-0.2']);
  expect(evaluatePositions(problem, { ...proposal, positions: [...proposal.positions].reverse() })).toEqual(result);
  for (const positions of [[], [proposal.positions[0]], [proposal.positions[0], proposal.positions[0]],
    [...proposal.positions, { legId: 'unknown', shares: '0' }]]) {
    expect(() => evaluatePositions(problem, { ...proposal, positions })).toThrow();
  }
});

it('accepts zero orders on empty books but rejects unavailable, fractional and subminimum orders', () => {
  const empty = createValuationProblem({ ...input, budgetUsd: '0', legs: [{ ...input.legs[0], asks: [] }] });
  const result = evaluatePositions(empty, propose(empty, '0'));
  expect(result.totalCostUsd).toBe('0');
  expect(result.riskReductionUsd).toBe('0');
  expect(result.improvesModeledRisk).toBe(false);
  expect(() => evaluatePositions(empty, propose(empty, '2'))).toThrow(/capacity/i);
  const problem = createValuationProblem(input);
  for (const shares of ['1', '4.9', '-1', '5.0', '5e0', 'NaN', 5]) {
    expect(() => evaluatePositions(problem, { ...propose(problem), positions: [{ legId: 'synthetic:yes', shares }] })).toThrow();
  }
});

it('does not label a feasible harmful or sub-cent improvement as a useful hedge', () => {
  const harmful = createValuationProblem({ ...input, states: [
    { stateId: 'loss', originalLossUsd: '1' }, { stateId: 'safe', originalLossUsd: '0' },
  ] });
  const result = evaluatePositions(harmful, propose(harmful));
  expect(result.scenarios.map(state => state.netLossUsd)).toEqual(['-2.4', '1.6']);
  expect(result.riskReductionUsd).toBe('-0.6');
  expect(result.improvesModeledRisk).toBe(false);
  for (const [price, expected] of [['0.991', false], ['0.99', true]] as const) {
    const tiny = createValuationProblem({ ...input, legs: [{ ...input.legs[0], minShares: '1', asks: [{ price, size: '2' }] }] });
    expect(evaluatePositions(tiny, propose(tiny, '1')).improvesModeledRisk).toBe(expected);
  }
});

it('rejects stale bindings and forged cost claims rather than trusting proposer metadata', () => {
  const problem = createValuationProblem(input);
  for (const changed of [
    { ...problem, budgetUsd: '11' }, { ...problem, rulesHash: 'b'.repeat(64) },
    { ...problem, legs: [{ ...problem.legs[0], asks: [{ price: '0.1', size: '10' }] }] },
    { ...problem, states: [{ stateId: 'loss', originalLossUsd: '100' }, problem.states[1]] },
  ]) expect(() => evaluatePositions(changed, propose(problem))).toThrow(/hash/i);
  expect(() => evaluatePositions(problem, { ...propose(problem), valuationHash: 'b'.repeat(64) })).toThrow(/hash/i);
  expect(() => evaluatePositions(problem, { ...propose(problem), totalCostUsd: '0' })).toThrow();
});

it('rejects unknown fees, malformed books and incomplete or duplicate scenario identities', () => {
  for (const invalid of [
    { ...input, budgetUsd: '-1' }, { ...input, dataMode: 'guaranteed' },
    { ...input, currency: 'EUR' }, { ...input, rulesHash: 'not-a-hash' },
    { ...input, rulesHash: `${'a'.repeat(64)}\n` },
    { ...input, states: [] }, { ...input, states: [input.states[0], input.states[0]] },
    { ...input, legs: [] }, { ...input, legs: [input.legs[0], input.legs[0]] },
    { ...input, legs: Array.from({ length: 17 }, (_, i) => ({ ...input.legs[0], legId: `leg-${i}` })) },
    ...[
      { asks: undefined }, { fee: null }, { fee: { kind: 'curve', rate: '0.07', exponent: 2 } },
      { fee: { kind: 'curve', rate: '-0.01', exponent: 1 } },
      { asks: [{ price: '0', size: '10' }] }, { asks: [{ price: '1', size: '10' }] },
      { asks: [{ price: '0.1', size: '-1' }] }, { asks: [{ price: 'NaN', size: '10' }] },
      { asks: Array.from({ length: 1001 }, () => ({ price: '0.1', size: '1' })) },
      { payouts: [{ stateId: 'loss', payoutPerShare: '1' }] },
      { payouts: [{ stateId: 'loss', payoutPerShare: '1' }, { stateId: 'loss', payoutPerShare: '0' }] },
      { payouts: [{ stateId: 'wrong', payoutPerShare: '1' }, { stateId: 'safe', payoutPerShare: '0' }] },
      { payouts: [{ stateId: 'loss', payoutPerShare: '0.5' }, { stateId: 'safe', payoutPerShare: '0' }] },
    ].map(change => ({ ...input, legs: [{ ...input.legs[0], ...change }] })),
  ]) expect(() => createValuationProblem(invalid)).toThrow();
});
