import { expect, it } from 'vitest';
import { createValuationProblem, decodeNeuralProposal } from '@hedgenet/core';

const model = { modelVersion: 'synthetic-untrained', weightsHash: 'b'.repeat(64),
  featureVersion: 'features-v1', contractHash: 'c'.repeat(64) };
const input = { schemaVersion: 'valuation-v1', currency: 'USD', dataMode: 'synthetic',
  snapshotId: 'decoder-fixture', rulesHash: 'a'.repeat(64), budgetUsd: '2.112',
  states: [{ stateId: 'wet', originalLossUsd: '100' }, { stateId: 'dry', originalLossUsd: '0' }],
  legs: [{ legId: 'yes', minShares: '2', fee: { kind: 'curve', rate: '0.07', exponent: 1 },
    asks: [{ price: '0.2', size: '12' }],
    payouts: [{ stateId: 'wet', payoutPerShare: '1' }, { stateId: 'dry', payoutPerShare: '0' }] }] };
const output = (valuationHash: string, values = [1]) => ({ schemaVersion: 'neural-proposal-v1',
  runId: 'synthetic-run', valuationHash, ...model, legIds: ['yes'], values, inferenceMs: 4 });

it('keeps the exact fee-inclusive budget boundary and scales below it without a second reserve', () => {
  const problem = createValuationProblem(input);
  const exact = decodeNeuralProposal(problem, model, output(problem.contentHash));
  expect(exact.proposal.positions[0]?.shares).toBe('10');
  expect(exact.valuation.totalCostUsd).toBe('2.112');
  expect(exact.repair.budgetScaled).toBe(false);
  expect(exact.outcome).toBe('improvement');
  const lower = createValuationProblem({ ...input, budgetUsd: '2.111999999999' });
  const scaled = decodeNeuralProposal(lower, model, output(lower.contentHash));
  expect(scaled.proposal.positions[0]?.shares).toBe('9');
  expect(scaled.valuation.totalCostUsd).toBe('1.9008');
  expect(scaled.repair.budgetScaled).toBe(true);
});

it('clamps, floors and drops minimum orders instead of increasing or optimizing them', () => {
  const problem = createValuationProblem(input);
  const small = decodeNeuralProposal(problem, model, output(problem.contentHash, [0.199]));
  expect(small.proposal.positions[0]?.shares).toBe('0');
  expect(small.repair.droppedLegIds).toEqual(['yes']);
  const large = decodeNeuralProposal(problem, model, output(problem.contentHash, [2]));
  expect(large.proposal.positions[0]?.shares).toBe('10');
  expect(large.repair.clampedLegIds).toEqual(['yes']);
  const negative = decodeNeuralProposal(problem, model, output(problem.contentHash, [-1]));
  expect(negative.proposal.positions[0]?.shares).toBe('0');
  expect(negative.outcome).toBe('no_improvement');
  const minimum = createValuationProblem({ ...input, budgetUsd: '2.11', legs: [{ ...input.legs[0], minShares: '10' }] });
  expect(decodeNeuralProposal(minimum, model, output(minimum.contentHash)).proposal.positions[0]?.shares).toBe('0');
});

it('preserves relative scaling across asymmetric legs and does not spend spare money', () => {
  const problem = createValuationProblem({ ...input, budgetUsd: '1.8', legs: [
    { ...input.legs[0], fee: { kind: 'none' } },
    { ...input.legs[0], legId: 'no', minShares: '1', fee: { kind: 'none' }, asks: [{ price: '0.7', size: '6' }],
      payouts: [{ stateId: 'wet', payoutPerShare: '0' }, { stateId: 'dry', payoutPerShare: '1' }] },
  ] });
  const result = decodeNeuralProposal(problem, model, { ...output(problem.contentHash, [0.8, 0.4]), legIds: ['yes', 'no'] });
  expect(result.proposal.positions).toEqual([{ legId: 'yes', shares: '5' }, { legId: 'no', shares: '1' }]);
  expect(result.valuation.totalCostUsd).toBe('1.7'); // No optimizer spends the remaining 0.1.
  expect(() => decodeNeuralProposal(problem, model,
    { ...output(problem.contentHash, [0.8, 0.4]), legIds: ['no', 'yes'] })).toThrow(/identity/i);
});

it('rejects stale bindings, wrong order/dimensions and nonfinite numeric responses', () => {
  const problem = createValuationProblem(input);
  const response = output(problem.contentHash);
  for (const patch of [
    { valuationHash: 'd'.repeat(64) }, { modelVersion: 'other' }, { weightsHash: 'd'.repeat(64) },
    { contractHash: 'd'.repeat(64) }, { featureVersion: 'features-v0' }, { legIds: ['wrong'] },
    { values: [NaN] }, { values: [Infinity] }, { values: [] }, { values: ['1'] }, { values: [1, 0] },
  ]) expect(() => decodeNeuralProposal(problem, model, { ...response, ...patch })).toThrow();
  expect(() => decodeNeuralProposal({ ...problem, budgetUsd: '3' }, model, response)).toThrow(/hash/i);
  const changed = createValuationProblem({ ...input, budgetUsd: '3' });
  expect(() => decodeNeuralProposal(changed, model, response)).toThrow(/binding/i);
});

it('keeps harmful decoded evidence as no_improvement and handles empty capacity', () => {
  const problem = createValuationProblem({ ...input, budgetUsd: '10',
    states: [{ stateId: 'wet', originalLossUsd: '4' }, { stateId: 'dry', originalLossUsd: '2' }],
    legs: [{ ...input.legs[0], fee: { kind: 'none' }, asks: [{ price: '0.6', size: '12' }] }] });
  const harmful = decodeNeuralProposal(problem, model, output(problem.contentHash));
  expect(harmful.proposal.positions[0]?.shares).toBe('10'); // Not replaced by the teacher's 2 shares.
  expect(harmful.valuation.worstNetLossUsd).toBe('8');
  expect(harmful.valuation.riskReductionUsd).toBe('-4');
  expect(harmful.outcome).toBe('no_improvement');
  const empty = createValuationProblem({ ...input, legs: [{ ...input.legs[0], asks: [] }] });
  expect(decodeNeuralProposal(empty, model, output(empty.contentHash)).proposal.positions[0]?.shares).toBe('0');
});
