import { expect, it } from 'vitest';
import { buildPreview } from '../../apps/web/lib/preview.ts';

it('prices the illustrative basket with real accounting, not client-side animation values', () => {
  const crypto = buildPreview({ example: 'crypto', budgetUsd: '1000', revision: 1 });
  expect(crypto.valuation.totalCostUsd).toBe('999.95');
  expect(crypto.valuation.worstOriginalLossUsd).toBe('14000');
  expect(crypto.valuation.worstNetLossUsd).toBe('11499.95');
  expect(crypto.maximumPayoutUsd).toBe('3500'); // Mutually exclusive, not 3500+857.
  expect(crypto.trace).toBeNull();
  expect(crypto.proposalSource).toBe('illustrative-allocation');
  const weather = buildPreview({ example: 'weather', budgetUsd: '300', revision: 2 });
  expect(weather.valuation.totalCostUsd).toBe('300');
  expect(weather.valuation.worstNetLossUsd).toBe('4300');
  expect(weather.valuation.scenarios.map(x => x.netLossUsd)).toEqual(['300', '4300']);
  expect(weather.valuation.budgetUsd).toBe('300');
  expect(weather.revision).toBe(2);
});

it('honors zero and minimum budgets and refuses out-of-range values without clamping', () => {
  for (const budgetUsd of ['0', '0.01']) {
    expect(buildPreview({ example: 'weather', budgetUsd, revision: 1 }).valuation.totalCostUsd).toBe('0');
  }
  for (const budgetUsd of ['-1', '5000.01', '1e3', '1.001']) {
    expect(() => buildPreview({ example: 'crypto', budgetUsd, revision: 1 })).toThrow();
  }
});
