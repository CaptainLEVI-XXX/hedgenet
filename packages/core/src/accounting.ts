import { z } from 'zod';
import { FinancialDecimal, IdentitySchema, MoneySchema } from './decimal.ts';

const AccountingInputSchema = z.strictObject({
  schemaVersion: z.literal('accounting-v1'),
  currency: z.literal('USD'),
  totalCostUsd: MoneySchema,
  scenarios: z.array(z.strictObject({
    stateId: IdentitySchema,
    originalLossUsd: MoneySchema,
    payoutUsd: MoneySchema,
  })).min(1).max(32).refine(
    states => new Set(states.map(state => state.stateId)).size === states.length,
    'Scenario identities must be unique',
  ),
});

/** Scenario arithmetic only. This does not validate a trade or a neural proposal. */
export function summarizeScenarioLosses(input: unknown) {
  const parsed = AccountingInputSchema.parse(input);
  const scenarios = parsed.scenarios.map(state => ({
    ...state,
    netLossUsd: new FinancialDecimal(state.originalLossUsd)
      .plus(parsed.totalCostUsd).minus(state.payoutUsd).toFixed(),
  }));
  const worstOriginalLoss = FinancialDecimal.max(...scenarios.map(state => state.originalLossUsd));
  const worstNetLoss = FinancialDecimal.max(0, ...scenarios.map(state => state.netLossUsd));
  return {
    schemaVersion: parsed.schemaVersion,
    currency: parsed.currency,
    totalCostUsd: parsed.totalCostUsd,
    scenarios,
    worstOriginalLossUsd: worstOriginalLoss.toFixed(),
    worstNetLossUsd: worstNetLoss.toFixed(),
    riskReductionUsd: worstOriginalLoss.minus(worstNetLoss).toFixed(),
  };
}
