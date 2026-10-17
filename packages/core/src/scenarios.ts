import { z } from 'zod';
import { FinancialDecimal, IdentitySchema, ScalarDecimalSchema } from './decimal.ts';
import { lossAt, LossTemplateSchema } from './shapes.ts';

const BoundSchema = z.strictObject({ value: ScalarDecimalSchema, inclusive: z.boolean() });
const marketFields = { marketId: IdentitySchema, yesLegId: IdentitySchema, noLegId: IdentitySchema };
export const SettlementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ schemaVersion: z.literal('settlement-v1'), kind: z.literal('binary'),
    conditionId: IdentitySchema, ...marketFields }),
  z.strictObject({ schemaVersion: z.literal('settlement-v1'), kind: z.literal('numeric_partition'),
    domain: z.literal('continuous'), buckets: z.array(z.strictObject({ ...marketFields,
      lower: BoundSchema.nullable(), upper: BoundSchema.nullable(),
    })).min(3).max(8) }),
]);

export type Settlement = z.infer<typeof SettlementSchema>;
export type ScenarioLocation =
  | { kind: 'numeric'; value: string; side: 'at' | 'below' | 'above' }
  | { kind: 'tail'; direction: 'negative' | 'positive' }
  // Exact threshold ± maxLossUsd/lossRateUsd from the returned loss template.
  | { kind: 'loss_cap' }
  | { kind: 'condition'; conditionId: string; occurs: boolean };

type Bound = z.infer<typeof BoundSchema> | null;

function compareBounds(a: Bound, b: Bound, infinity: -1 | 1) {
  if (a === null) return b === null ? 0 : infinity;
  if (b === null) return -infinity;
  return new FinancialDecimal(a.value).comparedTo(b.value);
}

/**
 * Exact normal-resolution states for trusted, semantically matched settlement rules.
 * Limits represent suprema, not observations at an arbitrary epsilon or at infinity.
 * This does not parse venue prose or verify source, time, location, freshness or void rules.
 */
export function buildScenarios(lossInput: unknown, settlementInput: unknown) {
  const loss = LossTemplateSchema.parse(lossInput);
  const settlement = SettlementSchema.parse(settlementInput);
  const markets = settlement.kind === 'binary' ? [settlement] : settlement.buckets;
  const ids = markets.flatMap(market => [market.yesLegId, market.noLegId]);
  if (new Set(ids).size !== ids.length || new Set(markets.map(market => market.marketId)).size !== markets.length) {
    throw new Error('Market and leg identities must be unique');
  }
  const states: Array<{ stateId: string; location: ScenarioLocation; originalLossUsd: string; winningMarketId: string | null }> = [];
  const append = (location: ScenarioLocation, originalLossUsd: string, winningMarketId: string | null) => {
    states.push({ stateId: `state-${states.length}`, location, originalLossUsd, winningMarketId });
  };

  if (settlement.kind === 'binary') {
    if (loss.templateId !== 'conditional_loss' || loss.conditionId !== settlement.conditionId) {
      throw new Error('Binary settlement must match the confirmed loss condition');
    }
    for (const occurs of [false, true]) {
      const location = { kind: 'condition' as const, conditionId: settlement.conditionId, occurs };
      append(location, lossAt(loss, location), occurs ? settlement.marketId : null);
    }
  } else {
    if (loss.templateId === 'conditional_loss') throw new Error('Numeric settlement requires a numeric loss');
    // Parsing copied the input, so canonicalization never mutates caller-owned arrays.
    settlement.buckets.sort((a, b) => compareBounds(a.lower, b.lower, -1) || compareBounds(a.upper, b.upper, 1));
    const first = settlement.buckets[0]!;
    const last = settlement.buckets.at(-1)!;
    if (last.upper !== null || (loss.templateId === 'terminal_downside'
      ? first.lower?.value !== '0' || !first.lower.inclusive
      : first.lower !== null)) {
      throw new Error('Partition must cover the entire loss domain, including tails');
    }
    settlement.buckets.forEach((bucket, index) => {
      if (bucket.lower && bucket.upper) {
        const order = new FinancialDecimal(bucket.lower.value).comparedTo(bucket.upper.value);
        if (order > 0 || (order === 0 && !(bucket.lower.inclusive && bucket.upper.inclusive))) {
          throw new Error('Partition contains an empty or reversed bucket');
        }
      }
      if (index > 0) {
        const previous = settlement.buckets[index - 1]!;
        if (!previous.upper || !bucket.lower || previous.upper.value !== bucket.lower.value
          || previous.upper.inclusive === bucket.lower.inclusive) {
          throw new Error('Partition contains a gap or overlap');
        }
      }
    });

    const reference = loss.templateId === 'terminal_downside' ? loss.referencePriceUsd : loss.threshold;
    const breakpoints: Array<{ location: ScenarioLocation; lossUsd: string; compareTo: (value: string) => number }> = [{
      location: { kind: 'numeric', value: reference, side: 'at' }, lossUsd: '0',
      compareTo: value => new FinancialDecimal(reference).comparedTo(value),
    }];
    if (loss.templateId === 'threshold_loss') {
      breakpoints.push({
        location: { kind: 'loss_cap' }, lossUsd: loss.maxLossUsd,
        // Sign of (threshold ± cap/rate − value), with positive rate.
        // Cross multiplication remains exact even when cap/rate is recurring.
        compareTo: value => new FinancialDecimal(loss.threshold).minus(value).times(loss.lossRateUsd)
          .plus(new FinancialDecimal(loss.maxLossUsd).times(loss.direction === 'above' ? 1 : -1)).comparedTo(0),
      });
      if (loss.direction === 'below') breakpoints.reverse();
    }
    for (const bucket of settlement.buckets) {
      const endpoint = (bound: Bound, side: 'lower' | 'upper') => {
        if (bound) {
          append({ kind: 'numeric', value: bound.value,
            side: bound.inclusive ? 'at' : side === 'lower' ? 'above' : 'below' },
          lossAt(loss, { kind: 'numeric', value: bound.value }), bucket.marketId);
        } else {
          const cappedTail = loss.templateId === 'threshold_loss'
            && ((loss.direction === 'above') === (side === 'upper'));
          append({ kind: 'tail', direction: side === 'lower' ? 'negative' : 'positive' },
            cappedTail ? loss.maxLossUsd : '0', bucket.marketId);
        }
      };
      endpoint(bucket.lower, 'lower');
      for (const point of breakpoints) {
        if ((!bucket.lower || point.compareTo(bucket.lower.value) > 0)
          && (!bucket.upper || point.compareTo(bucket.upper.value) < 0)) {
          append(point.location, point.lossUsd, bucket.marketId);
        }
      }
      // A singleton has one actual outcome, not two duplicate endpoints.
      if (!bucket.lower || !bucket.upper || bucket.lower.value !== bucket.upper.value) endpoint(bucket.upper, 'upper');
    }
  }
  return {
    schemaVersion: 'scenarios-v1' as const,
    loss,
    settlement,
    states: states.map(({ winningMarketId: _, ...state }) => state),
    legs: markets.flatMap(market => [true, false].map(yes => ({
      legId: yes ? market.yesLegId : market.noLegId,
      payouts: states.map(state => ({ stateId: state.stateId,
        payoutPerShare: ((state.winningMarketId === market.marketId) === yes ? '1' : '0') as '0' | '1' })),
    }))),
  };
}
