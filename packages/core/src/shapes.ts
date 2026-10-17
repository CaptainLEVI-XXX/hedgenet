import { z } from 'zod';
import { FinancialDecimal, IdentitySchema, PositiveScalarSchema, ScalarDecimalSchema } from './decimal.ts';

const common = { schemaVersion: z.literal('loss-v1'), currency: z.literal('USD') };

export const LossTemplateSchema = z.discriminatedUnion('templateId', [
  z.strictObject({
    ...common,
    templateId: z.literal('terminal_downside'),
    units: PositiveScalarSchema.describe('Asset units held, strictly positive'),
    referencePriceUsd: PositiveScalarSchema.describe('Confirmed reference price in USD per asset unit'),
  }),
  z.strictObject({
    ...common,
    templateId: z.literal('threshold_loss'),
    direction: z.enum(['above', 'below']),
    threshold: ScalarDecimalSchema.describe('Threshold in the confirmed observable unit'),
    lossRateUsd: PositiveScalarSchema.describe('USD loss per observable unit beyond the threshold'),
    maxLossUsd: PositiveScalarSchema.describe('User-confirmed USD loss cap, not the hedge budget'),
  }),
  z.strictObject({
    ...common,
    templateId: z.literal('conditional_loss'),
    conditionId: IdentitySchema.describe('Exact confirmed condition identity, not a category'),
    fixedLossUsd: PositiveScalarSchema.describe('USD loss if this condition occurs'),
  }),
]);

export type LossTemplate = z.infer<typeof LossTemplateSchema>;

export const ObservationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('numeric'), value: ScalarDecimalSchema }),
  z.strictObject({ kind: z.literal('condition'), conditionId: IdentitySchema, occurs: z.boolean() }),
]);

export type Observation = z.infer<typeof ObservationSchema>;

/** Evaluate the confirmed loss assumption, not a market price or hedge recommendation. */
export function lossAt(template: unknown, observation: unknown): string {
  const loss = LossTemplateSchema.parse(template);
  const state = ObservationSchema.parse(observation);

  if (loss.templateId === 'conditional_loss') {
    if (state.kind !== 'condition' || state.conditionId !== loss.conditionId) {
      throw new Error('Observation must match the confirmed condition');
    }
    return state.occurs ? loss.fixedLossUsd : '0';
  }

  if (state.kind !== 'numeric') {
    throw new Error('This loss template requires a numeric observation');
  }
  const value = new FinancialDecimal(state.value);
  if (loss.templateId === 'terminal_downside') {
    if (value.isNegative()) throw new Error('An asset price cannot be negative');
    return FinancialDecimal.max(0, new FinancialDecimal(loss.referencePriceUsd).minus(value))
      .times(loss.units).toFixed();
  }

  const excess = loss.direction === 'above'
    ? value.minus(loss.threshold)
    : new FinancialDecimal(loss.threshold).minus(value);
  return FinancialDecimal.min(loss.maxLossUsd,
    FinancialDecimal.max(0, excess).times(loss.lossRateUsd)).toFixed();
}
