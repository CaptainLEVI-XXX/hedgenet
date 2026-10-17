import assert from 'node:assert/strict';
import { buildScenarios, createValuationProblem, evaluatePositions, lossAt, summarizeScenarioLosses } from '@hedgenet/core';
import { exposureFixtures } from '../tests/fixtures/exposures.ts';

console.log('HedgeNet — synthetic financial foundation demo');
console.log('No live market data, neural inference, code-generation agent, or trades.\n');

for (const fixture of exposureFixtures) {
  console.log(fixture.name);
  console.table(fixture.cases.map(({ observation, lossUsd }) => {
    const actual = lossAt(fixture.template, observation);
    assert.equal(actual, lossUsd);
    return {
      observation: observation.kind === 'numeric' ? observation.value : String(observation.occurs),
      originalLossUsd: actual,
    };
  }));
}

const rain = exposureFixtures[3];
const result = summarizeScenarioLosses({
  schemaVersion: 'accounting-v1',
  currency: 'USD',
  totalCostUsd: '900',
  scenarios: rain.cases.map(({ observation }) => ({
    stateId: observation.occurs ? 'rain' : 'dry',
    originalLossUsd: lossAt(rain.template, observation),
    payoutUsd: observation.occurs ? '3000' : '0',
  })),
});
assert.equal(result.worstNetLossUsd, '2900');
assert.equal(result.riskReductionUsd, '2100');
console.log('Hypothetical basket: $900 cost, $3,000 payout only in the rain state.');
console.table(result.scenarios);
console.log(`Worst modeled loss: $${result.worstOriginalLossUsd} → $${result.worstNetLossUsd}`);
console.log(`Modeled risk reduction: $${result.riskReductionUsd}`);
console.log('Accounting only: market compatibility, order books, fees and budget feasibility are not checked here.');

console.log('\nIndependent position valuation — synthetic books and stipulated payouts.');
for (const example of [
  { fixture: exposureFixtures[0], payouts: ['1', '1', '0', '0'],
    fee: { kind: 'curve', rate: '0.07', exponent: 1 }, cost: '633.6', reduction: '2366.4',
    netLosses: ['15133.6', '1383.6', '633.6', '633.6'] },
  { fixture: exposureFixtures[1], payouts: ['1', '1', '1', '1', '0', '0'],
    fee: { kind: 'none' }, cost: '600', reduction: '2400',
    netLosses: ['2600', '2600', '-900', '-2399.5', '600', '600'] },
]) {
  const problem = createValuationProblem({
    schemaVersion: 'valuation-v1', currency: 'USD', dataMode: 'synthetic',
    snapshotId: `synthetic:${example.fixture.name}`, rulesHash: 'a'.repeat(64), budgetUsd: '1000',
    states: example.fixture.cases.map(({ observation }, index) => ({
      stateId: `state-${index}`, originalLossUsd: lossAt(example.fixture.template, observation),
    })),
    legs: [{
      legId: 'synthetic:yes', minShares: '5', fee: example.fee,
      asks: [{ price: '0.2', size: '4000' }],
      payouts: example.payouts.map((payoutPerShare, index) => ({ stateId: `state-${index}`, payoutPerShare })),
    }],
  });
  const quote = evaluatePositions(problem, {
    schemaVersion: 'positions-v1', valuationHash: problem.contentHash,
    positions: [{ legId: 'synthetic:yes', shares: '3000' }],
  });
  assert.equal(quote.totalCostUsd, example.cost);
  assert.equal(quote.riskReductionUsd, example.reduction);
  assert.deepEqual(quote.scenarios.map(state => state.netLossUsd), example.netLosses);
  console.log(`${example.fixture.name}: 3,000 proposed shares, $${quote.totalCostUsd} estimated all-in cost.`);
  console.table(quote.scenarios);
  console.log(`Worst modeled loss: $${quote.worstOriginalLossUsd} → $${quote.worstNetLossUsd}`);
}
console.log('Same evaluator, different exposures. No real settlement/freshness checks, optimality claim or trade recommendation.');

const generated = buildScenarios(rain.template, {
  schemaVersion: 'settlement-v1', kind: 'binary', conditionId: rain.template.conditionId,
  marketId: 'synthetic:rain', yesLegId: 'synthetic:rain:yes', noLegId: 'synthetic:rain:no',
});
const rainProblem = createValuationProblem({
  schemaVersion: 'valuation-v1', currency: 'USD', dataMode: 'synthetic',
  snapshotId: 'synthetic:rain-book', rulesHash: 'b'.repeat(64), budgetUsd: '1000',
  states: generated.states.map(({ stateId, originalLossUsd }) => ({ stateId, originalLossUsd })),
  legs: generated.legs.map(leg => ({ ...leg, minShares: '5', fee: { kind: 'none' },
    asks: [{ price: leg.legId === 'synthetic:rain:yes' ? '0.3' : '0.7', size: '5000' }],
  })),
});
const rainQuote = evaluatePositions(rainProblem, {
  schemaVersion: 'positions-v1', valuationHash: rainProblem.contentHash,
  positions: generated.legs.map(leg => ({ legId: leg.legId,
    shares: leg.legId === 'synthetic:rain:yes' ? '3000' : '0' })),
});
assert.equal(rainQuote.totalCostUsd, '900');
assert.equal(rainQuote.worstNetLossUsd, '2900');
assert.deepEqual(rainQuote.scenarios.map(state => state.netLossUsd), ['900', '2900']);
console.log('\nSynthetic rain: normalized condition → generated states/payouts → independent position valuation.');
console.table(rainQuote.scenarios);
console.log('Normal resolution only; the synthetic rule is stipulated, not fetched or semantically verified.');
