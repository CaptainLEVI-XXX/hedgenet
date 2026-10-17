// Server-only module (node:crypto, trusted evaluator); never import from client components.
import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { buildScenarios, createValuationProblem, evaluatePositions } from '@hedgenet/core';
import type { ScenarioLocation } from '@hedgenet/core';
import { budgetProblem, exampleCopy } from './presets.ts';
import type { ExampleId } from './presets.ts';

const D = Decimal.clone({ precision: 80 });
const FICTIONAL_DEPTH = '1000000'; // Explicitly fictional, ample depth; never a live book.
const MIN_SHARES = '5';

export class PreviewInputError extends Error {
  constructor(message: string) { super(message); this.name = 'PreviewInputError'; }
}

type Leg = { legId: string; label: string; side: 'YES' | 'NO'; price: string; weight: string; maxShares?: string };
type Fixture = { loss: unknown; settlement: unknown; legs: Leg[]; describe: (location: ScenarioLocation) => string };

const usd = (value: string) => `$${Number(value).toLocaleString('en-US')}`;
function numericLabel(location: ScenarioLocation): string {
  if (location.kind === 'tail') return location.direction === 'positive' ? 'BTC far above $70,000 (upper tail)' : 'Lower tail';
  if (location.kind !== 'numeric') return 'Scenario';
  const side = location.side === 'at' ? 'BTC at' : location.side === 'below' ? 'BTC just below' : 'BTC just above';
  return `${side} ${usd(location.value)}`;
}

const fixtures: Record<ExampleId, Fixture> = {
  crypto: {
    loss: { schemaVersion: 'loss-v1', currency: 'USD', templateId: 'terminal_downside', units: '0.2', referencePriceUsd: '70000' },
    settlement: {
      schemaVersion: 'settlement-v1', kind: 'numeric_partition', domain: 'continuous', buckets: [
        { marketId: 'demo-btc-low', yesLegId: 'low-yes', noLegId: 'low-no', lower: { value: '0', inclusive: true }, upper: { value: '55000', inclusive: false } },
        { marketId: 'demo-btc-mid', yesLegId: 'mid-yes', noLegId: 'mid-no', lower: { value: '55000', inclusive: true }, upper: { value: '65000', inclusive: false } },
        { marketId: 'demo-btc-high', yesLegId: 'high-yes', noLegId: 'high-no', lower: { value: '65000', inclusive: true }, upper: null },
      ],
    },
    legs: [
      { legId: 'low-yes', label: 'BTC below $55,000', side: 'YES', price: '0.2', weight: '0.7' },
      { legId: 'low-no', label: 'BTC below $55,000', side: 'NO', price: '0.8', weight: '0' },
      { legId: 'mid-yes', label: 'BTC $55,000 to under $65,000', side: 'YES', price: '0.35', weight: '0.3' },
      { legId: 'mid-no', label: 'BTC $55,000 to under $65,000', side: 'NO', price: '0.65', weight: '0' },
      { legId: 'high-yes', label: 'BTC $65,000 or above', side: 'YES', price: '0.45', weight: '0' },
      { legId: 'high-no', label: 'BTC $65,000 or above', side: 'NO', price: '0.55', weight: '0' },
    ],
    describe: numericLabel,
  },
  weather: {
    loss: { schemaVersion: 'loss-v1', currency: 'USD', templateId: 'conditional_loss', conditionId: 'demo-heathrow-rain-1mm-2026-10-24', fixedLossUsd: '5000' },
    settlement: { schemaVersion: 'settlement-v1', kind: 'binary', conditionId: 'demo-heathrow-rain-1mm-2026-10-24',
      marketId: 'demo-heathrow-rain', yesLegId: 'rain-yes', noLegId: 'rain-no' },
    legs: [
      // Shares beyond the $5,000 loss would only add premium, so the illustration caps them.
      { legId: 'rain-yes', label: 'Heathrow rain ≥ 1 mm', side: 'YES', price: '0.3', weight: '1', maxShares: '5000' },
      { legId: 'rain-no', label: 'Heathrow rain ≥ 1 mm', side: 'NO', price: '0.7', weight: '0' },
    ],
    describe: location => location.kind === 'condition' ? (location.occurs ? 'Rain ≥ 1 mm' : 'Rain < 1 mm') : 'Scenario',
  },
};

/** Canonical, unclamped budget or a refusal. Explicit user budgets are preserved exactly. */
export function parsePreviewBudget(value: unknown): string {
  if (typeof value !== 'string') throw new PreviewInputError('Budget must be a decimal string.');
  const problem = budgetProblem(value);
  if (problem) throw new PreviewInputError(problem);
  return new D(value).toFixed();
}

/**
 * Fixed illustrative allocation (not neural, not a solver), priced by the trusted exact evaluator.
 * Fictional markets and depth; synthetic data mode; no trace.
 */
export function buildPreview(input: { example: ExampleId; budgetUsd: string; revision: number }) {
  const fixture = fixtures[input.example];
  if (!fixture) throw new PreviewInputError('Unknown illustrative example.');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new PreviewInputError('Invalid revision.');
  const budgetUsd = parsePreviewBudget(input.budgetUsd);
  const scenarios = buildScenarios(fixture.loss, fixture.settlement);
  const copy = exampleCopy[input.example];
  const problem = createValuationProblem({
    schemaVersion: 'valuation-v1', currency: 'USD', dataMode: 'synthetic', snapshotId: `illustrative-${input.example}-v1`,
    rulesHash: createHash('sha256').update(copy.rules).digest('hex'), budgetUsd,
    states: scenarios.states.map(({ stateId, originalLossUsd }) => ({ stateId, originalLossUsd })),
    legs: scenarios.legs.map(leg => {
      const meta = fixture.legs.find(item => item.legId === leg.legId)!;
      return { legId: leg.legId, minShares: MIN_SHARES, fee: { kind: 'none' as const },
        asks: [{ price: meta.price, size: FICTIONAL_DEPTH }], payouts: leg.payouts };
    }),
  });
  const positions = scenarios.legs.map(leg => {
    const meta = fixture.legs.find(item => item.legId === leg.legId)!;
    let shares = new D(budgetUsd).times(meta.weight).div(meta.price).floor();
    if (meta.maxShares) shares = D.min(shares, meta.maxShares);
    if (shares.lt(MIN_SHARES)) shares = new D(0);
    return { legId: leg.legId, shares: shares.toFixed() };
  });
  const valuation = evaluatePositions(problem, { schemaVersion: 'positions-v1', valuationHash: problem.contentHash, positions });
  const maximumPayoutUsd = D.max(...valuation.scenarios.map(state => state.payoutUsd)).toFixed();
  const original = new D(valuation.worstOriginalLossUsd);
  return {
    schemaVersion: 'illustrative-preview-v1' as const,
    example: input.example,
    revision: input.revision,
    proposalSource: 'illustrative-allocation' as const,
    trace: null,
    dataMode: 'synthetic' as const,
    valuation,
    maximumPayoutUsd,
    unspentBudgetUsd: new D(budgetUsd).minus(valuation.totalCostUsd).toFixed(),
    // Relative to no hedge over the same stated scenarios; null when the baseline is zero.
    worstLossReductionPct: original.isZero() ? null
      : new D(valuation.riskReductionUsd).div(original).times(100).toDecimalPlaces(1, D.ROUND_DOWN).toFixed(1),
    scenarioLabels: Object.fromEntries(scenarios.states.map(state => [state.stateId, fixture.describe(state.location)])),
    scenarioLocations: Object.fromEntries(scenarios.states.map(state => [state.stateId, state.location])),
    legs: fixture.legs.map(({ legId, label, side, price }) => ({ legId, label, side, price })),
  };
}

export type Preview = ReturnType<typeof buildPreview>;
