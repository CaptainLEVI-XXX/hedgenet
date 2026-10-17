import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FinancialDecimal as D, IdentitySchema, MoneySchema, PositiveScalarSchema } from './decimal.ts';
import { evaluatePositions, ValuationProblemSchema } from './valuation.ts';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const range = z.strictObject({ min: MoneySchema, max: MoneySchema })
  .refine(value => new D(value.min).lte(value.max), 'Reversed feature range');
const specification = z.strictObject({ schemaVersion: z.literal('feature-contract-v1'),
  featureVersion: z.literal('features-v1'), rulesHash: hashSchema,
  legIds: z.array(IdentitySchema).min(1).max(16).refine(ids => new Set(ids).size === ids.length),
  lossScaleUsd: PositiveScalarSchema.refine(value => new D(value).gte(1)),
  ranges: z.array(range).length(738) });
const contractSchema = specification.extend({ contentHash: hashSchema });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Freeze explicit normalized bounds, scale, rules and leg ordering; not model approval. */
export function createFeatureContract(input: unknown) {
  const body = specification.parse(input);
  return { ...body, contentHash: hash(body) };
}

/** Encode trusted canonical scenario-builder output. Check exact ranges before FP32. */
export function encodeFeatures(problemInput: unknown, contractInput: unknown) {
  const problem = ValuationProblemSchema.parse(problemInput);
  const { contentHash, ...contract } = contractSchema.parse(contractInput);
  if (hash(contract) !== contentHash) throw new Error('Feature contract hash mismatch');
  evaluatePositions(problem, { schemaVersion: 'positions-v1', valuationHash: problem.contentHash,
    positions: problem.legs.map(leg => ({ legId: leg.legId, shares: '0' })) });
  if (problem.rulesHash !== contract.rulesHash) throw new Error('Feature contract rules mismatch');
  if (problem.legs.length !== contract.legIds.length
    || problem.legs.some((leg, j) => leg.legId !== contract.legIds[j])
    || problem.states.some((state, s) => state.stateId !== `state-${s}`)) {
    throw new Error('Feature contract canonical order mismatch');
  }
  const numerators = Array.from({ length: 738 }, () => new D(0));
  const denominators = Array.from({ length: 738 }, () => new D(1));
  const put = (index: number, value: string | number | InstanceType<typeof D>, scaled = false) => {
    numerators[index] = new D(value);
    if (scaled) denominators[index] = new D(contract.lossScaleUsd);
  };
  put(0, problem.budgetUsd, true);
  put(1, D.max(...problem.states.map(state => state.originalLossUsd)), true);
  problem.states.forEach((state, s) => { put(2 + s, state.originalLossUsd, true); put(34 + s, 1); });
  const capacities = problem.legs.map((leg, j) => {
    const payouts = new Map(leg.payouts.map(payout => [payout.stateId, payout.payoutPerShare]));
    problem.states.forEach((state, s) => put(66 + j * 32 + s, payouts.get(state.stateId)!));
    const merged = new Map<string, InstanceType<typeof D>>();
    for (const ask of leg.asks) merged.set(ask.price, (merged.get(ask.price) ?? new D(0)).plus(ask.size));
    const levels = [...merged].sort(([a], [b]) => new D(a).comparedTo(b)).slice(0, 3)
      .map(([price, size]) => ({ price, size: size.times('0.9').floor() }));
    const capacity = D.sum(0, ...levels.map(level => level.size));
    if (capacity.gt('999999999999')) throw new Error('Neural capacity exceeds position representation');
    const offset = 578 + j * 10;
    put(offset, capacity.gt(0) ? 1 : 0);
    put(offset + 1, leg.fee.kind === 'none' ? '0' : leg.fee.rate);
    put(offset + 2, leg.minShares, true);
    put(offset + 3, '1', true); // Whole-share quantity step.
    levels.forEach((level, k) => { put(offset + 4 + k * 2, level.price); put(offset + 5 + k * 2, level.size, true); });
    return capacity.toFixed();
  });
  const values = numerators.map((numerator, i) => {
    const divisor = denominators[i]!, bounds = contract.ranges[i]!;
    // Cross multiplication avoids rounding a recurring normalized decimal at the boundary.
    if (numerator.lt(new D(bounds.min).times(divisor)) || numerator.gt(new D(bounds.max).times(divisor))) {
      throw new Error(`Feature ${i} outside declared range`);
    }
    const value = Math.fround(numerator.div(divisor).toNumber());
    if (!Number.isFinite(value)) throw new Error('Nonfinite neural feature');
    return value;
  });
  return { schemaVersion: 'encoded-features-v1' as const, featureVersion: contract.featureVersion,
    contractHash: contentHash, valuationHash: problem.contentHash,
    orderingHash: hash({ legIds: contract.legIds, stateIds: problem.states.map(state => state.stateId) }),
    legIds: contract.legIds, capacities, values };
}
