import { createHash } from 'node:crypto';
import loadHighs from 'highs';
import { FinancialDecimal as D } from './decimal.ts';
import { evaluatePositions, ValuationProblemSchema } from './valuation.ts';
import type { PositionProposal } from './valuation.ts';

const SCALE = 100_000;
const LIMIT = 1_000_000_000_000;
const OPTIONS = Object.freeze({ time_limit: 2, mip_rel_gap: 0, mip_abs_gap: 0,
  threads: 1, parallel: 'off' as const, random_seed: 17, output_flag: false });
let runtime: ReturnType<typeof loadHighs> | undefined;

export class TeacherError extends Error {
  readonly code: 'out_of_range' | 'not_optimal' | 'invalid_solution' | 'solver_failure';
  constructor(code: TeacherError['code'], message: string) {
    super(message); this.name = 'TeacherError'; this.code = code;
  }
}

function bounded(value: InstanceType<typeof D>): number {
  if (!value.isInteger() || value.lt(0) || value.gt(LIMIT)) {
    throw new TeacherError('out_of_range', 'Teacher integer range exceeded');
  }
  return value.toNumber();
}
function integer(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || Math.abs(value - Math.round(value)) > 1e-6
    || value < -1e-6 || value > LIMIT) {
    throw new TeacherError('invalid_solution', 'Solver returned an invalid integer');
  }
  return Math.round(value);
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Offline conservative reference only. Synchronous WASM solves block the calling thread. */
export async function solveTeacher(input: unknown) {
  const started = performance.now();
  const problem = ValuationProblemSchema.parse(input);
  const proposal: PositionProposal = { schemaVersion: 'positions-v1', valuationHash: problem.contentHash,
    positions: problem.legs.map(leg => ({ legId: leg.legId, shares: '0' })) };
  const baseline = evaluatePositions(problem, proposal); // Includes input-hash verification.
  const budget = bounded(new D(problem.budgetUsd).times(SCALE).floor());
  const losses = problem.states.map(state => bounded(new D(state.originalLossUsd).times(SCALE).ceil()));
  const legs = problem.legs.map((leg, j) => {
    // Deliberately independent from the evaluator's fill/fee implementation.
    const merged = new Map<string, InstanceType<typeof D>>();
    for (const ask of leg.asks) merged.set(ask.price, (merged.get(ask.price) ?? new D(0)).plus(ask.size));
    const levels = [...merged].sort(([a], [b]) => new D(a).comparedTo(b)).slice(0, 3)
      .map(([price, size], k) => {
        const fee = leg.fee.kind === 'none' ? new D(0)
          : new D(price).times(new D(1).minus(price)).times(leg.fee.rate);
        // Round premium and fee separately. Ceil(premium + fee) would not bound
        // exact premium + ceil(level fee), even for a single filled share.
        const cost = bounded(new D(price).times(SCALE).ceil().plus(fee.times(SCALE).ceil()));
        return { name: `x${j}_${k}`, capacity: bounded(size.times('0.9').floor()), cost };
      }).filter(level => level.capacity > 0);
    const capacity = levels.reduce((sum, level) => sum + level.capacity, 0);
    if (capacity > 1_000_000) throw new TeacherError('out_of_range', 'Teacher share range exceeded');
    // A minimum larger than capacity simply makes this leg unavailable.
    const minimum = D.min(new D(leg.minShares).ceil(), capacity + 1).toNumber();
    return { levels, capacity, minimum, payouts: problem.states.map(state =>
      Number(leg.payouts.find(payout => payout.stateId === state.stateId)!.payoutPerShare)) };
  });
  bounded(D.sum(...legs.flatMap(leg => leg.levels.map(level => new D(level.cost).times(level.capacity))), 0));
  const rows = ['cost: c' + legs.flatMap(leg => leg.levels.map(level => ` - ${level.cost} ${level.name}`)).join('') + ' = 0'];
  const bounds = [`0 <= c <= ${budget}`, `0 <= m <= ${Math.max(...losses)}`];
  // c is an integer sum of integer fills; the optimum m is their integer
  // maximum. Neither needs an extra integer variable/rounding decision.
  const generals: string[] = [];
  const binaries: string[] = [];
  legs.forEach((leg, j) => {
    generals.push(`q${j}`); binaries.push(`a${j}`);
    bounds.push(`0 <= q${j} <= ${leg.capacity}`);
    rows.push(`quantity${j}: q${j}${leg.levels.map(level => ` - ${level.name}`).join('')} = 0`,
      `active${j}: q${j} - ${leg.capacity} a${j} <= 0`, `minimum${j}: q${j} - ${leg.minimum} a${j} >= 0`);
    leg.levels.forEach((level, k) => {
      generals.push(level.name); bounds.push(`0 <= ${level.name} <= ${level.capacity}`);
      if (k > 0) {
        const previous = leg.levels[k - 1]!;
        const flag = `b${j}_${k}`; binaries.push(flag);
        rows.push(`open${j}_${k}: ${level.name} - ${level.capacity} ${flag} <= 0`,
          `prefix${j}_${k}: ${previous.name} - ${previous.capacity} ${flag} >= 0`);
      }
    });
  });
  losses.forEach((loss, s) => rows.push(`risk${s}: m - c${legs.map((leg, j) =>
    leg.payouts[s] ? ` + ${SCALE} q${j}` : '').join('')} >= ${loss}`));
  const model = (objective: 'm' | 'c', cap?: number) => [
    'Minimize', `obj: ${objective}`, 'Subject To', ...rows, ...(cap === undefined ? [] : [`riskcap: m <= ${cap}`]),
    'Bounds', ...bounds, 'Generals', ...generals, 'Binaries', ...binaries, 'End',
  ].join('\n');
  const phases: Array<{ objective: 'risk' | 'cost'; modelHash: string; status: 'Optimal'; objectiveTicks: number }> = [];
  async function solve(text: string, objective: 'risk' | 'cost') {
    let solution;
    try {
      runtime ??= loadHighs();
      solution = (await runtime).solve(text, OPTIONS);
    } catch {
      runtime = undefined;
      throw new TeacherError('solver_failure', `HiGHS ${objective} phase failed`);
    }
    if (solution.Status !== 'Optimal') throw new TeacherError('not_optimal', `HiGHS ${objective}: ${solution.Status}`);
    const objectiveTicks = integer(solution.ObjectiveValue);
    const quantities = legs.map((leg, j) => {
      const quantity = integer(solution.Columns[`q${j}`]?.Primal);
      const fills = leg.levels.map(level => integer(solution.Columns[level.name]?.Primal));
      if (quantity > leg.capacity || (quantity !== 0 && quantity < leg.minimum)
        || quantity !== fills.reduce((sum, fill) => sum + fill, 0)
        || fills.some((fill, k) => fill > leg.levels[k]!.capacity
          || (fill > 0 && fills.slice(0, k).some((prev, p) => prev !== leg.levels[p]!.capacity)))) {
        throw new TeacherError('invalid_solution', 'Solver violated quantity/depth constraints');
      }
      return { quantity, cost: fills.reduce((sum, fill, k) => sum + fill * leg.levels[k]!.cost, 0) };
    });
    const cost = quantities.reduce((sum, item) => sum + item.cost, 0);
    const risk = Math.max(0, ...losses.map((loss, s) => loss + cost - quantities.reduce((sum, item, j) =>
      sum + item.quantity * legs[j]!.payouts[s]! * SCALE, 0)));
    if (cost > budget || (objective === 'risk' ? risk : cost) !== objectiveTicks) {
      throw new TeacherError('invalid_solution', `Solver ${objective} mismatch: cost=${cost}, risk=${risk}, objective=${objectiveTicks}, budget=${budget}`);
    }
    phases.push({ objective, modelHash: hash(text), status: 'Optimal', objectiveTicks });
    return { quantities, cost, risk };
  }
  const first = await solve(model('m'), 'risk');
  const second = await solve(model('c', first.risk), 'cost');
  if (second.risk !== first.risk) throw new TeacherError('invalid_solution', 'Risk changed during cost minimization');
  proposal.positions.forEach((position, j) => { position.shares = String(second.quantities[j]!.quantity); });
  let valuation: ReturnType<typeof evaluatePositions>;
  try { valuation = evaluatePositions(problem, proposal); }
  catch { throw new TeacherError('invalid_solution', 'Independent financial evaluation rejected solver positions'); }
  if (new D(valuation.totalCostUsd).gt(new D(second.cost).div(SCALE))
    || new D(valuation.worstNetLossUsd).gt(new D(second.risk).div(SCALE))
    || new D(valuation.worstNetLossUsd).gt(baseline.worstNetLossUsd)) {
    throw new TeacherError('invalid_solution', 'Reference bound or no-hedge safety violated');
  }
  return { schemaVersion: 'teacher-v1' as const, status: 'optimal_reference' as const,
    referencePolicy: 'ceil-unit-premium-fee-loss-floor-budget-1e5-v1' as const,
    solver: { package: 'highs', version: '1.15.3', options: OPTIONS, phases },
    referenceRiskUsd: new D(second.risk).div(SCALE).toFixed(),
    referenceCostUsd: new D(second.cost).div(SCALE).toFixed(),
    proposal, valuation, baseline, durationMs: performance.now() - started };
}
