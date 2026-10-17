import { expect, it } from 'vitest';
import { buildSyntheticDataset, labelExample, scorePredictions } from '../../packages/training/src/dataset.ts';

it('keeps every book group in one split and reproduces the frozen synthetic universe', () => {
  const a = buildSyntheticDataset('crypto');
  expect(a).toEqual(buildSyntheticDataset('crypto'));
  expect(a.examples).toHaveLength(192);
  expect(new Set(a.examples.map(x => x.problem.contentHash)).size).toBe(192);
  for (const [split, count] of [['train', 96], ['validation', 48], ['test', 48]] as const) {
    expect(a.examples.filter(x => x.split === split)).toHaveLength(count);
  }
  const groups = new Map<string, Set<string>>();
  for (const row of a.examples) groups.set(row.groupId, new Set([...(groups.get(row.groupId) ?? []), row.split]));
  expect(groups.size).toBe(24);
  expect([...groups.values()].every(s => s.size === 1)).toBe(true);
  expect(a.examples.every(x => x.features.values.length === 738 && x.problem.dataMode === 'synthetic')).toBe(true);
  expect(a.examples.some(x => x.problem.budgetUsd === '0')).toBe(true);
  expect(a.examples.some(x => x.features.capacities.some(c => c === '0'))).toBe(true);
  const weather = buildSyntheticDataset('weather');
  expect(weather.contract.rulesHash).not.toBe(a.contract.rulesHash);
  expect(weather.examples[0]?.problem.legs).toHaveLength(2);
});

it('uses independently valued teacher quantities for targets, with fixed 16-output masks', async () => {
  const data = buildSyntheticDataset('weather');
  const row = await labelExample(data.examples[4]!);
  expect(row.teacher.status).toBe('optimal_reference');
  expect(row.teacher.valuation.improvesModeledRisk).toBe(true);
  expect(row.targets).toHaveLength(16);
  expect(row.mask.slice(2)).toEqual(Array(14).fill(0));
  row.teacher.proposal.positions.forEach((p, j) => {
    expect(row.targets[j]).toBeCloseTo(Number(p.shares) / Number(row.features.capacities[j]), 6);
  });
  const empty = await labelExample(data.examples[0]!);
  expect(empty.targets).toEqual(Array(16).fill(0));
});

it('labels a large-loss problem without accepting an objective tick discrepancy', async () => {
  const source = buildSyntheticDataset('crypto').examples.find(x => x.id === 'synthetic-crypto-88272-5')!;
  const row = await labelExample(source);
  // Independent arithmetic: 2010 + 2079 + 111 shares pay in the worst state;
  // 165616 + 1999.82 − 4200 = 163415.82. Other states remain below this loss.
  expect(row.teacher.valuation.totalCostUsd).toBe('1999.82');
  expect(row.teacher.valuation.worstNetLossUsd).toBe('163415.82');
  expect(row.teacher.referenceRiskUsd).toBe('163415.82');
});

it('counts zero, harmful and invalid predictions instead of hiding them with abstentions', async () => {
  const data = buildSyntheticDataset('weather');
  const rows = await Promise.all(data.examples.filter(x => x.split === 'validation').map(labelExample));
  const zeros = rows.map(() => [0, 0]);
  const zero = scorePredictions(rows, zeros);
  expect(zero.nontrivialCount).toBeGreaterThanOrEqual(12);
  expect(zero.retainedImprovement.median).toBe(0);
  expect(zero.passed).toBe(false);
  expect(zero.feasibleCount).toBe(48);
  const invalid = scorePredictions(rows, rows.map(() => [NaN, 0]));
  expect(invalid.feasibleCount).toBe(0);
  expect(invalid.sampleCount).toBe(48);
  expect(invalid.passed).toBe(false);
  expect(() => scorePredictions(rows, [])).toThrow(/count/i);
  const teacher = scorePredictions(rows, rows.map(row => row.targets.slice(0, row.problem.legs.length)));
  expect(teacher.passed).toBe(true);
  expect(teacher.retainedImprovement.p10).toBeGreaterThan(0.98);
  expect(teacher.acceptance).toBe('not_evaluated'); // Numerical checks cannot promote weights.
  const harmful = scorePredictions(rows, rows.map(() => [0, 1]));
  expect(harmful.regressionCount).toBeGreaterThan(0);
  expect(harmful.retainedImprovement.median).toBeLessThanOrEqual(0);
});
