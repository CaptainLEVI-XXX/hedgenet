import { expect, it } from 'vitest';
import { createValuationProblem, solveTeacher } from '@hedgenet/core';

const fixture = () => ({ schemaVersion: 'valuation-v1', currency: 'USD', dataMode: 'synthetic',
  snapshotId: 'teacher-fixture', rulesHash: 'a'.repeat(64), budgetUsd: '10',
  states: [{ stateId: 'loss', originalLossUsd: '4' }, { stateId: 'safe', originalLossUsd: '2' }],
  legs: [{ legId: 'yes', minShares: '1', fee: { kind: 'none' }, asks: [{ price: '0.6', size: '12' }],
    payouts: [{ stateId: 'loss', payoutPerShare: '1' }, { stateId: 'safe', payoutPerShare: '0' }] }],
});

it('minimizes premium-inclusive worst loss, not payout shortfall, then uses the cheapest risk-equivalent basket', async () => {
  const result = await solveTeacher(createValuationProblem(fixture()));
  expect(result.proposal.positions).toEqual([{ legId: 'yes', shares: '2' }]);
  expect(result.valuation.totalCostUsd).toBe('1.2');
  expect(result.valuation.worstNetLossUsd).toBe('3.2');
  const tie = fixture(); tie.states[0]!.originalLossUsd = '10'; tie.states[1]!.originalLossUsd = '6';
  tie.legs[0]!.asks[0]!.price = '0.8'; tie.legs[0]!.minShares = '5';
  const zero = await solveTeacher(createValuationProblem(tie));
  expect(zero.proposal.positions[0]?.shares).toBe('0'); // q=5 also risks 10, but costs 4.
  expect(zero.valuation.worstNetLossUsd).toBe('10');
});

it('merges raw depth, reserves once, and never includes the fourth price level', async () => {
  const data = fixture(); data.budgetUsd = '100'; data.states[0]!.originalLossUsd = '100'; data.states[1]!.originalLossUsd = '0';
  data.legs[0]!.asks = [{ price: '0.5', size: '1000' }, { price: '0.2', size: '3' },
    { price: '0.4', size: '10' }, { price: '0.2', size: '2' }, { price: '0.3', size: '3' }];
  const result = await solveTeacher(createValuationProblem(data));
  expect(result.proposal.positions[0]?.shares).toBe('15');
  expect(result.valuation.totalCostUsd).toBe('5');
  expect(result.valuation.worstNetLossUsd).toBe('90');
});

it('respects fee-inclusive exact budgets and labels conservative approximation explicitly', async () => {
  const data = fixture(); data.states[0]!.originalLossUsd = '100'; data.states[1]!.originalLossUsd = '0';
  data.legs[0]!.asks = [{ price: '0.2', size: '12' }];
  const input = { ...data, legs: [{ ...data.legs[0], fee: { kind: 'curve', rate: '0.07', exponent: 1 } }] };
  const exact = await solveTeacher(createValuationProblem({ ...input, budgetUsd: '2.112' }));
  expect(exact.proposal.positions[0]?.shares).toBe('10');
  expect(exact.valuation.totalCostUsd).toBe('2.112');
  const below = await solveTeacher(createValuationProblem({ ...input, budgetUsd: '2.111999999999' }));
  expect(below.proposal.positions[0]?.shares).toBe('9');
  const approximate = await solveTeacher(createValuationProblem({ ...input, budgetUsd: '1.046669',
    legs: [{ ...input.legs[0], asks: [{ price: '0.333333', size: '4' }] }] }));
  expect(approximate.proposal.positions[0]?.shares).toBe('2'); // Exact accounting permits 3; conservative reference does not.
  expect(approximate.referencePolicy).toBe('ceil-unit-premium-fee-loss-floor-budget-1e5-v1');
  const tiny = { ...input, legs: [{ ...input.legs[0], asks: [{ price: '0.333333', size: '2' }] }] };
  const rounded = await solveTeacher(createValuationProblem({ ...tiny, budgetUsd: '0.3489' }));
  expect(rounded.valuation.totalCostUsd).toBe('0.348893');
  // Ceil(premium + raw fee) = 0.34889 would incorrectly admit a share at this budget.
  const noShare = await solveTeacher(createValuationProblem({ ...tiny, budgetUsd: '0.34889' }));
  expect(noShare.proposal.positions[0]?.shares).toBe('0');
});

it('returns valid no-hedge labels for empty/zero capacity but rejects corruption and unsupported solver range', async () => {
  const empty = fixture(); empty.legs[0]!.asks = [];
  expect((await solveTeacher(createValuationProblem(empty))).proposal.positions[0]?.shares).toBe('0');
  expect((await solveTeacher(createValuationProblem({ ...fixture(), budgetUsd: '0' }))).valuation.totalCostUsd).toBe('0');
  const problem = createValuationProblem(fixture());
  await expect(solveTeacher({ ...problem, budgetUsd: '100' })).rejects.toThrow(/hash/i);
  await expect(solveTeacher(createValuationProblem({ ...fixture(), budgetUsd: '10000001' }))).rejects.toMatchObject({ code: 'out_of_range' });
});

it('matches independently enumerated small portfolios on both risk and the cost tie-break', async () => {
  for (let trial = 0; trial < 16; trial++) {
    const prices = [20 + trial, 31 + trial % 4, 15 + trial % 7];
    const loss = [5 + trial % 3, 2, 1];
    const budgetCents = 100 + trial * 7;
    const matrix = [[1, 0, 0], [0, 1, 0], [1, 0, 1]];
    let bestRisk = Infinity, bestCost = Infinity;
    for (let a = 0; a <= 3; a++) for (let b = 0; b <= 3; b++) for (let c = 0; c <= 3; c++) {
      if (b === 1) continue; // Venue minimum 2 for the middle leg.
      const q = [a, b, c], cost = q.reduce((sum, qty, j) => sum + qty * prices[j]!, 0);
      if (cost > budgetCents) continue;
      const risk = Math.max(0, ...loss.map((l, s) => l * 100 + cost - q.reduce((sum, qty, j) => sum + qty * matrix[j]![s]! * 100, 0)));
      if (risk < bestRisk || (risk === bestRisk && cost < bestCost)) { bestRisk = risk; bestCost = cost; }
    }
    const problem = createValuationProblem({ ...fixture(), budgetUsd: String(budgetCents / 100),
      states: loss.map((l, s) => ({ stateId: `s${s}`, originalLossUsd: String(l) })),
      legs: prices.map((p, j) => ({ legId: `leg${j}`, minShares: j === 1 ? '2' : '1', fee: { kind: 'none' },
        asks: [{ price: String(p / 100), size: '4' }], payouts: loss.map((_l, s) => ({ stateId: `s${s}`, payoutPerShare: String(matrix[j]![s]) })) })) });
    const result = await solveTeacher(problem);
    expect(result.valuation.worstNetLossUsd).toBe(String(bestRisk / 100));
    expect(result.valuation.totalCostUsd).toBe(String(bestCost / 100));
  }
});
