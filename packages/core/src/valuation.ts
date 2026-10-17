import { createHash } from 'node:crypto';
import { z } from 'zod';
import { summarizeScenarioLosses } from './accounting.ts';
import { FinancialDecimal, IdentitySchema, MoneySchema, ScalarDecimalSchema } from './decimal.ts';

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const NonnegativeScalarSchema = ScalarDecimalSchema.refine(value => !value.startsWith('-'));
const PriceSchema = NonnegativeScalarSchema.refine(value => new FinancialDecimal(value).gt(0)
  && new FinancialDecimal(value).lt(1), 'Price must be strictly between zero and one');
const FeeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('curve'), rate: NonnegativeScalarSchema, exponent: z.literal(1) }),
]);

const ValuationInputSchema = z.strictObject({
  schemaVersion: z.literal('valuation-v1'),
  currency: z.literal('USD'),
  dataMode: z.enum(['synthetic', 'recorded', 'live']),
  snapshotId: IdentitySchema,
  rulesHash: HashSchema,
  budgetUsd: MoneySchema,
  states: z.array(z.strictObject({ stateId: IdentitySchema, originalLossUsd: MoneySchema })).min(1).max(32),
  legs: z.array(z.strictObject({
    legId: IdentitySchema,
    minShares: NonnegativeScalarSchema,
    fee: FeeSchema,
    asks: z.array(z.strictObject({ price: PriceSchema, size: NonnegativeScalarSchema })).max(1000),
    payouts: z.array(z.strictObject({
      stateId: IdentitySchema, payoutPerShare: z.enum(['0', '1']),
    })).min(1).max(32),
  })).min(1).max(16),
}).superRefine((input, ctx) => {
  const states = new Set(input.states.map(state => state.stateId));
  if (states.size !== input.states.length) {
    ctx.addIssue({ code: 'custom', path: ['states'], message: 'Scenario identities must be unique' });
  }
  if (new Set(input.legs.map(leg => leg.legId)).size !== input.legs.length) {
    ctx.addIssue({ code: 'custom', path: ['legs'], message: 'Leg identities must be unique' });
  }
  input.legs.forEach((leg, index) => {
    if (leg.payouts.length !== states.size
      || new Set(leg.payouts.map(payout => payout.stateId)).size !== states.size
      || leg.payouts.some(payout => !states.has(payout.stateId))) {
      ctx.addIssue({ code: 'custom', path: ['legs', index, 'payouts'],
        message: 'Payouts must identify every scenario exactly once' });
    }
  });
});

const ValuationProblemSchema = ValuationInputSchema.safeExtend({ contentHash: HashSchema });
const ProposalSchema = z.strictObject({
  schemaVersion: z.literal('positions-v1'),
  valuationHash: HashSchema,
  positions: z.array(z.strictObject({
    legId: IdentitySchema,
    shares: z.string().max(12).regex(/^(?:0|[1-9]\d{0,11})$/),
  })).min(1).max(16),
});

export type ValuationProblem = z.infer<typeof ValuationProblemSchema>;
export type PositionProposal = z.infer<typeof ProposalSchema>;

function hashInput(input: z.infer<typeof ValuationInputSchema>) {
  // Schema parsing fixes object-key order; arrays retain their snapshot order.
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** Copy and bind trusted financial inputs. A hash is not proof of source authenticity. */
export function createValuationProblem(input: unknown): ValuationProblem {
  const parsed = ValuationInputSchema.parse(input);
  return { ...parsed, contentHash: hashInput(parsed) };
}

/**
 * Reprice explicit positions without a solver or proposer-reported metrics.
 * The host must supply the trusted problem, not accept it from the proposer.
 * This checks modeled finances, not settlement compatibility, freshness or execution.
 */
export function evaluatePositions(problemInput: unknown, proposalInput: unknown) {
  const { contentHash, ...problem } = ValuationProblemSchema.parse(problemInput);
  const proposal = ProposalSchema.parse(proposalInput);
  if (hashInput(problem) !== contentHash || proposal.valuationHash !== contentHash) {
    throw new Error('Valuation hash mismatch');
  }
  const quantities = new Map(proposal.positions.map(position => [position.legId, position.shares]));
  if (quantities.size !== proposal.positions.length || quantities.size !== problem.legs.length
    || problem.legs.some(leg => !quantities.has(leg.legId))) {
    throw new Error('Positions must identify every leg exactly once');
  }

  const positions = problem.legs.map(leg => {
    const shares = quantities.get(leg.legId)!;
    const quantity = new FinancialDecimal(shares);
    if (!quantity.isZero() && quantity.lt(leg.minShares)) {
      throw new Error(`Position below minimum size: ${leg.legId}`);
    }
    const levels = new Map<string, InstanceType<typeof FinancialDecimal>>();
    for (const ask of leg.asks) {
      levels.set(ask.price, (levels.get(ask.price) ?? new FinancialDecimal(0)).plus(ask.size));
    }
    const eligible = [...levels.entries()]
      .sort(([a], [b]) => new FinancialDecimal(a).comparedTo(b)).slice(0, 3);
    let remaining = quantity;
    let premium = new FinancialDecimal(0);
    let fees = new FinancialDecimal(0);
    const fills: Array<{ price: string; shares: string; premiumUsd: string; feeUsd: string }> = [];
    for (const [price, size] of eligible) {
      const filled = FinancialDecimal.min(remaining, size.times('0.9').floor());
      if (filled.isZero()) continue;
      const levelPremium = filled.times(price);
      // Declared level-based estimate, not exact venue rounding/match fragmentation.
      const levelFee = leg.fee.kind === 'none' ? new FinancialDecimal(0)
        : filled.times(leg.fee.rate).times(price).times(new FinancialDecimal(1).minus(price))
          .toDecimalPlaces(5, FinancialDecimal.ROUND_CEIL);
      fills.push({ price, shares: filled.toFixed(), premiumUsd: levelPremium.toFixed(), feeUsd: levelFee.toFixed() });
      premium = premium.plus(levelPremium);
      fees = fees.plus(levelFee);
      remaining = remaining.minus(filled);
    }
    if (!remaining.isZero()) throw new Error(`Position exceeds reserved capacity: ${leg.legId}`);
    return { legId: leg.legId, shares, fills, premiumUsd: premium.toFixed(), feeUsd: fees.toFixed(),
      totalCostUsd: premium.plus(fees).toFixed() };
  });

  const totalPremium = FinancialDecimal.sum(...positions.map(position => position.premiumUsd));
  const totalFee = FinancialDecimal.sum(...positions.map(position => position.feeUsd));
  const totalCost = totalPremium.plus(totalFee);
  if (totalCost.gt(problem.budgetUsd)) throw new Error('Position cost exceeds budget');

  const payouts = new Map(problem.states.map(state => [state.stateId, new FinancialDecimal(0)]));
  for (const leg of problem.legs) {
    for (const payout of leg.payouts) {
      payouts.set(payout.stateId, payouts.get(payout.stateId)!
        .plus(new FinancialDecimal(quantities.get(leg.legId)!).times(payout.payoutPerShare)));
    }
  }
  const accounting = summarizeScenarioLosses({
    schemaVersion: 'accounting-v1', currency: problem.currency, totalCostUsd: totalCost.toFixed(),
    scenarios: problem.states.map(state => ({ ...state, payoutUsd: payouts.get(state.stateId)!.toFixed() })),
  });
  return {
    ...accounting,
    schemaVersion: 'valuation-result-v1' as const,
    valuationHash: contentHash,
    snapshotId: problem.snapshotId,
    rulesHash: problem.rulesHash,
    dataMode: problem.dataMode,
    budgetUsd: problem.budgetUsd,
    depthPolicy: 'top-3-reserve-90-whole-v1' as const,
    feePolicy: 'ceil-5dp-per-level-v1' as const,
    positions,
    totalPremiumUsd: totalPremium.toFixed(),
    totalFeeUsd: totalFee.toFixed(),
    improvesModeledRisk: new FinancialDecimal(accounting.riskReductionUsd).gte('0.01'),
  };
}
