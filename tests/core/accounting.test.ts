import { expect, it } from 'vitest';
import { summarizeScenarioLosses } from '@hedgenet/core';

const input = {
  schemaVersion: 'accounting-v1', currency: 'USD', totalCostUsd: '900',
  scenarios: [
    { stateId: 'rain', originalLossUsd: '10000', payoutUsd: '3000' },
    { stateId: 'dry', originalLossUsd: '0', payoutUsd: '0' },
  ],
};

it('includes the full premium in every state and compares the same worst-loss objective', () => {
  const result = summarizeScenarioLosses(input);
  expect(result.scenarios).toEqual([
    { stateId: 'rain', originalLossUsd: '10000', payoutUsd: '3000', netLossUsd: '7900' },
    { stateId: 'dry', originalLossUsd: '0', payoutUsd: '0', netLossUsd: '900' },
  ]);
  expect(result.worstOriginalLossUsd).toBe('10000');
  expect(result.worstNetLossUsd).toBe('7900');
  expect(result.riskReductionUsd).toBe('2100');
});

it('retains state gains and floors only aggregate risk, not the signed state values', () => {
  const result = summarizeScenarioLosses({ ...input, totalCostUsd: '0.3', scenarios: [
    { stateId: 'one', originalLossUsd: '0.1', payoutUsd: '0.5' },
    { stateId: 'two', originalLossUsd: '0.2', payoutUsd: '0.8' },
  ] });
  expect(result.scenarios.map(state => state.netLossUsd)).toEqual(['-0.1', '-0.3']);
  expect(result.worstNetLossUsd).toBe('0');
  expect(result.riskReductionUsd).toBe('0.2');
});

it('reports an expensive hedge as worse and a no-hedge basket as unchanged', () => {
  const expensive = summarizeScenarioLosses({ ...input, totalCostUsd: '11000' });
  expect(expensive.worstNetLossUsd).toBe('18000');
  expect(expensive.riskReductionUsd).toBe('-8000');
  const noHedge = summarizeScenarioLosses({ ...input, totalCostUsd: '0', scenarios: [
    { stateId: 'rain', originalLossUsd: '10000', payoutUsd: '0' },
    { stateId: 'dry', originalLossUsd: '0', payoutUsd: '0' },
  ] });
  expect(noHedge.worstNetLossUsd).toBe('10000');
  expect(noHedge.riskReductionUsd).toBe('0');
});

it('preserves sub-cent costs and full scalar-product precision', () => {
  const result = summarizeScenarioLosses({ ...input, totalCostUsd: '2.112', scenarios: [
    { stateId: 'tiny', originalLossUsd: '0.000000000000000000000001', payoutUsd: '0' },
  ] });
  expect(result.worstNetLossUsd).toBe('2.112000000000000000000001');
});

it('rejects duplicate, empty, missing and oversized state sets instead of losing scenarios', () => {
  for (const scenarios of [[], [input.scenarios[0], input.scenarios[0]],
    [{ stateId: '', originalLossUsd: '1', payoutUsd: '0' }],
    [{ stateId: ' ', originalLossUsd: '1', payoutUsd: '0' }],
    [{ stateId: 'missing', originalLossUsd: '1' }]]) {
    expect(() => summarizeScenarioLosses({ ...input, scenarios })).toThrow();
  }
  const scenarios = Array.from({ length: 32 }, (_, i) => ({
    stateId: `state-${i}`, originalLossUsd: String(i), payoutUsd: '0',
  }));
  expect(summarizeScenarioLosses({ ...input, scenarios }).worstNetLossUsd).toBe('931');
  expect(() => summarizeScenarioLosses({ ...input, scenarios: [
    ...scenarios, { stateId: 'overflow', originalLossUsd: '999', payoutUsd: '0' },
  ] })).toThrow();
});

it('rejects unknown versions, injected result claims and invalid money at the boundary', () => {
  for (const invalid of [
    { ...input, schemaVersion: 'accounting-v2' },
    { ...input, currency: 'BTC' },
    { ...input, worstNetLossUsd: '0' },
    { ...input, totalCostUsd: '-1' },
    { ...input, totalCostUsd: 900 },
    { ...input, totalCostUsd: 'NaN' },
    { ...input, totalCostUsd: '0.0000000000000000000000001' },
    { ...input, scenarios: [{ stateId: 'bad', originalLossUsd: '-1', payoutUsd: '0' }] },
    { ...input, scenarios: [{ stateId: 'bad', originalLossUsd: '1', payoutUsd: '-1' }] },
  ]) {
    expect(() => summarizeScenarioLosses(invalid)).toThrow();
  }
});
