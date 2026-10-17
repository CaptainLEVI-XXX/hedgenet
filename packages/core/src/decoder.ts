import { z } from 'zod';
import { FinancialDecimal as D, IdentitySchema } from './decimal.ts';
import { BudgetExceededError, evaluatePositions, ValuationProblemSchema } from './valuation.ts';
import type { PositionProposal } from './valuation.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const modelSchema = z.strictObject({ modelVersion: IdentitySchema, weightsHash: hash,
  featureVersion: z.literal('features-v1'), contractHash: hash });
const responseSchema = modelSchema.extend({ schemaVersion: z.literal('neural-proposal-v1'),
  runId: IdentitySchema, valuationHash: hash, legIds: z.array(IdentitySchema).min(1).max(16),
  values: z.array(z.number().finite()).min(1).max(16), inferenceMs: z.number().finite().nonnegative() });

/** Trusted-host quantity repair, not model acceptance, freshness checking or optimization.
 * The host owns expectedModel; never let the candidate supply its own expected identity.
 */
export function decodeNeuralProposal(problemInput: unknown, expectedModel: unknown, responseInput: unknown) {
  const problem = ValuationProblemSchema.parse(problemInput);
  const model = modelSchema.parse(expectedModel);
  const response = responseSchema.parse(responseInput);
  const baseline = evaluatePositions(problem, { schemaVersion: 'positions-v1', valuationHash: problem.contentHash,
    positions: problem.legs.map(leg => ({ legId: leg.legId, shares: '0' })) });
  if (response.valuationHash !== problem.contentHash || response.modelVersion !== model.modelVersion
    || response.weightsHash !== model.weightsHash || response.contractHash !== model.contractHash
    || response.featureVersion !== model.featureVersion || response.values.length !== problem.legs.length
    || response.legIds.length !== problem.legs.length
    || problem.legs.some((leg, j) => leg.legId !== response.legIds[j])) {
    throw new Error('Neural proposal binding or ordered leg identity mismatch');
  }
  const capacities = problem.legs.map(leg => {
    const merged = new Map<string, InstanceType<typeof D>>();
    for (const ask of leg.asks) merged.set(ask.price, (merged.get(ask.price) ?? new D(0)).plus(ask.size));
    const capacity = D.sum(0, ...[...merged].sort(([a], [b]) => new D(a).comparedTo(b)).slice(0, 3)
      .map(([, size]) => size.times('0.9').floor()));
    if (capacity.gt('999999999999')) throw new Error('Neural capacity exceeds position representation');
    return capacity;
  });
  const clamped = response.values.map(value => Math.max(0, Math.min(1, value)));
  const rawShares = clamped.map((value, j) => new D(value).times(capacities[j]!));
  function attempt(multiplier: InstanceType<typeof D>) {
    const droppedLegIds: string[] = [];
    const proposal: PositionProposal = { schemaVersion: 'positions-v1', valuationHash: problem.contentHash,
      positions: problem.legs.map((leg, j) => {
        const scaled = rawShares[j]!.times(multiplier);
        let shares = scaled.floor();
        if (shares.lt(leg.minShares)) {
          if (scaled.gt(0)) droppedLegIds.push(leg.legId);
          shares = new D(0);
        }
        return { legId: leg.legId, shares: shares.toFixed() };
      }) };
    try { return { proposal, valuation: evaluatePositions(problem, proposal), multiplier, droppedLegIds }; }
    catch (error) { if (error instanceof BudgetExceededError) return null; throw error; }
  }
  const full = attempt(new D(1));
  // Zero is always feasible; baseline was checked above.
  let best = full ?? attempt(new D(0))!;
  const budgetScaled = full === null;
  if (budgetScaled) {
    let low = new D(0), high = new D(1);
    for (let iteration = 0; iteration < 32; iteration++) {
      const middle = low.plus(high).div(2);
      const candidate = attempt(middle);
      if (candidate) { low = middle; best = candidate; } else { high = middle; }
    }
  }
  return { schemaVersion: 'decoded-neural-v1' as const, decoderVersion: 'scale-floor-drop-32-v1' as const,
    outcome: best.valuation.improvesModeledRisk ? 'improvement' as const : 'no_improvement' as const,
    response, proposal: best.proposal, valuation: best.valuation, baseline,
    repair: { budgetScaled, multiplier: best.multiplier.toFixed(),
      clampedLegIds: problem.legs.filter((_, j) => clamped[j] !== response.values[j]).map(leg => leg.legId),
      maskedLegIds: problem.legs.filter((_, j) => capacities[j]!.isZero()).map(leg => leg.legId),
      droppedLegIds: best.droppedLegIds,
      quantities: problem.legs.map((leg, j) => ({ legId: leg.legId, rawShares: rawShares[j]!.toFixed(),
        decodedShares: best.proposal.positions[j]!.shares })) } };
}
