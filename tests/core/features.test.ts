import { expect, it } from 'vitest';
import { createFeatureContract, createValuationProblem, encodeFeatures } from '@hedgenet/core';

const source = { schemaVersion: 'valuation-v1', currency: 'USD', dataMode: 'synthetic',
  snapshotId: 'feature-fixture', rulesHash: 'a'.repeat(64), budgetUsd: '25',
  states: [{ stateId: 'state-0', originalLossUsd: '100' }, { stateId: 'state-1', originalLossUsd: '20' }],
  legs: [{ legId: 'yes', minShares: '2', fee: { kind: 'curve', rate: '0.07', exponent: 1 },
    asks: [{ price: '0.2', size: '3' }, { price: '0.2', size: '2' }, { price: '0.4', size: '10' },
      { price: '0.6', size: '2' }, { price: '0.9', size: '999' }],
    payouts: [{ stateId: 'state-1', payoutPerShare: '0' }, { stateId: 'state-0', payoutPerShare: '1' }] },
  { legId: 'no', minShares: '1', fee: { kind: 'none' }, asks: [],
    payouts: [{ stateId: 'state-0', payoutPerShare: '0' }, { stateId: 'state-1', payoutPerShare: '1' }] }] };
const specification = () => ({ schemaVersion: 'feature-contract-v1', featureVersion: 'features-v1',
  rulesHash: source.rulesHash, legIds: ['yes', 'no'], lossScaleUsd: '100',
  ranges: Array.from({ length: 738 }, () => ({ min: '0', max: '1' })) });

it('encodes exactly 738 leg-major features with masks, canonical payouts and once-reserved depth', () => {
  const problem = createValuationProblem(source), contract = createFeatureContract(specification());
  const encoded = encodeFeatures(problem, contract);
  expect(encoded.values).toHaveLength(738);
  expect(encoded.values.slice(0, 4)).toEqual([0.25, 1, 1, Math.fround(0.2)]);
  expect(encoded.values.slice(4, 34)).toEqual(Array(30).fill(0));
  expect(encoded.values.slice(34, 66)).toEqual([1, 1, ...Array(30).fill(0)]);
  expect(encoded.values.slice(66, 130)).toEqual([1, ...Array(31).fill(0), 0, 1, ...Array(30).fill(0)]);
  expect(encoded.values.slice(130, 578)).toEqual(Array(448).fill(0));
  expect(encoded.values.slice(578, 588)).toEqual([1, 0.07, 0.02, 0.01, 0.2, 0.04, 0.4, 0.09, 0.6, 0.01].map(Math.fround));
  expect(encoded.values.slice(588, 598)).toEqual([0, 0, 0.01, 0.01, 0, 0, 0, 0, 0, 0].map(Math.fround));
  expect(encoded.values.slice(598)).toEqual(Array(140).fill(0));
  expect(encoded.capacities).toEqual(['14', '0']);
  expect(encoded.valuationHash).toBe(problem.contentHash);
  expect(encoded.contractHash).toBe(contract.contentHash);
});

it('checks decimal bounds before lossy FP32 conversion and never clamps the exposure', () => {
  const spec = specification(); spec.ranges[0]!.max = '0.25';
  const contract = createFeatureContract(spec);
  expect(encodeFeatures(createValuationProblem(source), contract).values[0]).toBe(0.25);
  const over = createValuationProblem({ ...source, budgetUsd: '25.000000000001' });
  expect(Math.fround(Number('25.000000000001') / 100)).toBe(0.25);
  expect(() => encodeFeatures(over, contract)).toThrow(/range/i);
  expect(() => createFeatureContract({ ...spec, lossScaleUsd: '0' })).toThrow();
  expect(() => createFeatureContract({ ...spec, ranges: spec.ranges.slice(1) })).toThrow();
});

it('rejects rule/order/hash drift but permits changing losses and canonical scenario counts', () => {
  const contract = createFeatureContract(specification()), problem = createValuationProblem(source);
  expect(() => encodeFeatures({ ...problem, budgetUsd: '1' }, contract)).toThrow(/hash/i);
  expect(() => encodeFeatures(problem, { ...contract, lossScaleUsd: '101' })).toThrow(/hash/i);
  expect(() => encodeFeatures(createValuationProblem({ ...source, rulesHash: 'b'.repeat(64) }), contract)).toThrow(/rules/i);
  expect(() => encodeFeatures(createValuationProblem({ ...source, legs: [...source.legs].reverse() }), contract)).toThrow(/order/i);
  expect(() => encodeFeatures(createValuationProblem({ ...source, states: [...source.states].reverse() }), contract)).toThrow(/order/i);
  const extra = createValuationProblem({ ...source,
    states: [...source.states, { stateId: 'state-2', originalLossUsd: '33' }],
    legs: source.legs.map(leg => ({ ...leg, payouts: [...leg.payouts, { stateId: 'state-2', payoutPerShare: '0' }] })) });
  expect(encodeFeatures(extra, contract).values[4]).toBe(Math.fround(0.33));
});
