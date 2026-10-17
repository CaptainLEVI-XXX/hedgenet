import assert from 'node:assert/strict';
import { lossAt, summarizeScenarioLosses } from '@hedgenet/core';
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
