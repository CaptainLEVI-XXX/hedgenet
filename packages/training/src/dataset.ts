import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { buildScenarios, createFeatureContract, createValuationProblem, decodeNeuralProposal,
  encodeFeatures, evaluatePositions, solveTeacher } from '@hedgenet/core';

const D = Decimal.clone({ precision: 80 });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type Universe = 'crypto' | 'weather';

/** Fixed synthetic research universes, not claims about listings or live books. */
export function buildSyntheticDataset(universe: Universe, development = false) {
  if (universe !== 'crypto' && universe !== 'weather') throw new Error('Unknown synthetic universe');
  const settlement = universe === 'crypto'
    ? { schemaVersion: 'settlement-v1', kind: 'numeric_partition', domain: 'continuous', buckets: [
      { marketId: 'btc-low', yesLegId: 'low-yes', noLegId: 'low-no', lower: { value: '0', inclusive: true }, upper: { value: '60000', inclusive: false } },
      { marketId: 'btc-mid', yesLegId: 'mid-yes', noLegId: 'mid-no', lower: { value: '60000', inclusive: true }, upper: { value: '80000', inclusive: false } },
      { marketId: 'btc-high', yesLegId: 'high-yes', noLegId: 'high-no', lower: { value: '80000', inclusive: true }, upper: null },
    ] }
    : { schemaVersion: 'settlement-v1', kind: 'binary', conditionId: 'synthetic-heathrow-rain',
      marketId: 'rain', yesLegId: 'rain-yes', noLegId: 'rain-no' };
  const rules = { universe: `synthetic-${universe}-v1`, source: 'fictional-reference',
    observation: '2026-10-30T16:00:00Z', resolution: 'normal-only', settlement };
  const rulesHash = hash(rules);
  const legIds = universe === 'crypto'
    ? ['low-yes', 'low-no', 'mid-yes', 'mid-no', 'high-yes', 'high-no'] : ['rain-yes', 'rain-no'];
  // Maximum exposure in the frozen envelope, not an observed training maximum.
  const scale = universe === 'crypto' ? '525000' : '10000';
  const ranges = Array.from({ length: 738 }, () => ({ min: '0', max: '1' }));
  // Bounds for dollar-scaled budget/depth are declared before generating examples.
  ranges[0] = { min: '0', max: new D(5000).div(scale).toDecimalPlaces(12, D.ROUND_UP).toFixed() };
  const contract = createFeatureContract({ schemaVersion: 'feature-contract-v1', featureVersion: 'features-v1',
    rulesHash, legIds, lossScaleUsd: scale, ranges });
  const examples = [];
  for (let group = 0; group < (development ? 2 : 24); group++) {
    const bookSeed = (development ? 900001 : 17001) + group * 7919 + (universe === 'weather' ? 104729 : 0);
    let state = bookSeed;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    const integer = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    const bases = universe === 'crypto' ? [integer(16, 38), integer(26, 40)] : [integer(20, 65)];
    if (universe === 'crypto') bases.push(100 - bases[0]! - bases[1]!);
    const groupId = `synthetic-${universe}-${bookSeed}`;
    const split = development ? 'development' as const : group < 12 ? 'train' as const : group < 18 ? 'validation' as const : 'test' as const;
    const books = legIds.map((_id, j) => {
      const base = j % 2 === 0 ? bases[Math.floor(j / 2)]! : 100 - bases[Math.floor(j / 2)]!;
      return Array.from({ length: 3 }, (_, level) => ({
        price: new D(base + 1 + level * 2).div(100).toFixed(), size: String(integer(200, 1500)),
      }));
    });
    const budgets = ['0', '0.01', '100', '300', '1000', '2000', '3500', '5000'];
    for (let variant = 0; variant < 8; variant++) {
      const loss = universe === 'crypto'
        ? { schemaVersion: 'loss-v1', currency: 'USD', templateId: 'terminal_downside',
          units: new D(integer(1, 50)).div(10).toFixed(), referencePriceUsd: String(integer(35000, 105000)) }
        : { schemaVersion: 'loss-v1', currency: 'USD', templateId: 'conditional_loss',
          conditionId: 'synthetic-heathrow-rain', fixedLossUsd: String(integer(100, 10000)) };
      const scenarios = buildScenarios(loss, settlement);
      const problem = createValuationProblem({ schemaVersion: 'valuation-v1', currency: 'USD', dataMode: 'synthetic',
        snapshotId: `${groupId}-${variant}`, rulesHash, budgetUsd: budgets[variant],
        states: scenarios.states.map(({ stateId, originalLossUsd }) => ({ stateId, originalLossUsd })),
        legs: scenarios.legs.map((leg, j) => ({ ...leg, minShares: '5', fee: { kind: 'none' },
          // Empty-book cases remain actual examples, never silently padded labels.
          asks: variant === 7 && group % 4 === 0 ? [] : books[j] })),
      });
      examples.push({ id: problem.snapshotId, groupId, bookSeed, split, loss: scenarios.loss,
        problem, features: encodeFeatures(problem, contract) });
    }
  }
  const manifest = { schemaVersion: 'synthetic-dataset-v1', generatorVersion: 'grouped-books-v1',
    universe: rules.universe, dataMode: 'synthetic', development, rules, contract,
    envelope: { budgetUsd: ['0', '5000'], loss: universe === 'crypto'
      ? { units: ['0.1', '5'], referencePriceUsd: ['35000', '105000'] } : { fixedLossUsd: ['100', '10000'] },
    depthPerLevel: ['200', '1500'], emptyBooks: true, minShares: '5', fee: 'none' },
    membership: examples.map(({ id, groupId, bookSeed, split, problem }) => ({ id, groupId, bookSeed, split, problemHash: problem.contentHash })) };
  return { ...manifest, contentHash: hash(manifest), examples };
}

export type DatasetExample = ReturnType<typeof buildSyntheticDataset>['examples'][number];

/** Failure is thrown to the controller; it is never converted to a zero label. */
export async function labelExample(example: DatasetExample) {
  const teacher = await solveTeacher(example.problem);
  const targets = Array<number>(16).fill(0), mask = Array<number>(16).fill(0);
  teacher.proposal.positions.forEach((position, j) => {
    const capacity = new D(example.features.capacities[j]!);
    if (capacity.gt(0)) { targets[j] = new D(position.shares).div(capacity).toNumber(); mask[j] = 1; }
  });
  return { ...example, teacher, targets, mask };
}

export type LabeledExample = Awaited<ReturnType<typeof labelExample>>;

// Nearest-rank quantiles: fixed before measuring candidates, including small sets.
function quantile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

/** Trusted numerical grading only. Does not authenticate artifacts or promote models. */
export function scorePredictions(rows: readonly LabeledExample[], predictions: readonly unknown[]) {
  if (!rows.length || predictions.length !== rows.length) throw new Error('Prediction count differs from frozen sample count');
  if (new Set(rows.map(x => x.problem.contentHash)).size !== rows.length
    || new Set(rows.map(x => x.split)).size !== 1 || new Set(rows.map(x => x.features.contractHash)).size !== 1) {
    throw new Error('Evaluation must use unique examples from one split and universe');
  }
  const retained: number[] = [], gaps: number[] = [], absoluteGaps: number[] = [];
  let feasibleCount = 0, regressionCount = 0, noImprovementCount = 0;
  const cases = rows.map((row, i) => {
    // Revalue the trusted label, rather than accepting any stored reported scores.
    const reference = evaluatePositions(row.problem, row.teacher.proposal);
    const baseline = new D(reference.worstOriginalLossUsd);
    const referenceRisk = new D(reference.worstNetLossUsd);
    let risk = baseline, valid = false;
    try {
      // Transport-only identity: never an assertion that candidate weights are accepted.
      const identity = { modelVersion: 'offline-numerical-score', weightsHash: '0'.repeat(64),
        featureVersion: 'features-v1', contractHash: row.features.contractHash };
      const decoded = decodeNeuralProposal(row.problem, identity, { ...identity,
        schemaVersion: 'neural-proposal-v1', runId: row.id, valuationHash: row.problem.contentHash,
        legIds: row.features.legIds, values: predictions[i], inferenceMs: 0 });
      risk = new D(decoded.valuation.worstNetLossUsd); valid = true; feasibleCount++;
      if (risk.gt(baseline)) regressionCount++;
      if (decoded.outcome === 'no_improvement') noImprovementCount++;
    } catch { noImprovementCount++; }
    const improvement = baseline.minus(referenceRisk);
    const nontrivial = improvement.gte(1);
    const retention = nontrivial ? baseline.minus(risk).div(improvement).toNumber() : null;
    if (retention !== null) retained.push(retention);
    const absoluteGap = risk.minus(referenceRisk);
    const gap = absoluteGap.div(D.max(baseline, 1)).toNumber();
    gaps.push(gap); absoluteGaps.push(absoluteGap.toNumber());
    return { id: row.id, valid, worstLossUsd: risk.toFixed(), retainedImprovement: retention,
      normalizedRiskGap: gap, absoluteRiskGapUsd: absoluteGap.toFixed() };
  });
  const median = quantile(retained, 0.5), p10 = quantile(retained, 0.1), p95 = quantile(gaps, 0.95)!;
  return { schemaVersion: 'numerical-evaluation-v1', acceptance: 'not_evaluated',
    sampleCount: rows.length, nontrivialCount: retained.length, feasibleCount, regressionCount, noImprovementCount,
    retainedImprovement: { median, p10 }, normalizedRiskGapP95: p95,
    absoluteRiskGapUsdP95: quantile(absoluteGaps, 0.95),
    // Owner-approved prototype policy: retain quality measurements without blocking
    // experimentation. Serving still refuses to recommend non-improving baskets.
    qualityPolicy: 'advisory' as const,
    passed: feasibleCount === rows.length,
    qualityThresholdsMet: retained.length >= 12 && median !== null && median >= 0.8
      && p10 !== null && p10 >= 0.5 && p95 <= 0.05,
    cases };
}
