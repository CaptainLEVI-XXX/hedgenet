import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { decodeNeuralProposal } from '@hedgenet/core';
import { scorePredictions } from './dataset.ts';
import type { LabeledExample } from './dataset.ts';

/**
 * Trusted host-side gates for the remote Codex training experiment. Nothing here
 * executes candidate code: it only size/schema-checks numeric data downloaded
 * from the sandbox and scores it with the existing decoder and evaluator.
 */
export const EXPERIMENT_LIMITS = Object.freeze({
  maxCandidates: 3, codingMs: 5 * 60_000, trainingMs: 10 * 60_000, overallMs: 45 * 60_000,
  seed: 17, batchSize: 16, hiddenWidths: [8, 32] as const, learningRates: [0.0003, 0.001, 0.003] as const,
  maxEpochs: 120, checkpointEvery: 5, staleChecks: 4, outputs: 16, features: 738,
  maxCheckpointBytes: 4 * 1024 * 1024,
});

const D = Decimal.clone({ precision: 80 });
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Managed IDs include URL-safe punctuation; never truncate them at '-' or '_'. */
export function managedProcessId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  for (const key of ['process_id', 'id']) {
    if (typeof object[key] === 'string' && /^proc_[A-Za-z0-9_-]+$/.test(object[key])) return object[key];
  }
  for (const child of Object.values(object)) {
    const id = managedProcessId(child);
    if (id) return id;
  }
  return null;
}

export type AttemptConfig = { hidden: 8 | 32; learningRate: number; maxEpochs: number };

/** Rejects any choice outside the predeclared search space; never widens it. */
export function parseAttemptConfig(value: unknown): AttemptConfig {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') throw new Error('Attempt config must be an object');
  const { hidden, learningRate, maxEpochs } = v;
  if (!EXPERIMENT_LIMITS.hiddenWidths.includes(hidden as 8)) throw new Error('Hidden width must be 8 or 32');
  if (!EXPERIMENT_LIMITS.learningRates.includes(learningRate as 0.001)) throw new Error('Learning rate outside predeclared set');
  if (!Number.isInteger(maxEpochs) || (maxEpochs as number) < 5 || (maxEpochs as number) > EXPERIMENT_LIMITS.maxEpochs
    || (maxEpochs as number) % EXPERIMENT_LIMITS.checkpointEvery !== 0) throw new Error('Epoch bound outside 5..120 in steps of 5');
  return { hidden: hidden as 8 | 32, learningRate: learningRate as number, maxEpochs: maxEpochs as number };
}

export const parameterCount = (hidden: number) =>
  EXPERIMENT_LIMITS.features * hidden + hidden + hidden * EXPERIMENT_LIMITS.outputs + EXPERIMENT_LIMITS.outputs;

function finiteVector(value: unknown, length: number, label: string) {
  if (!Array.isArray(value) || value.length !== length || !value.every(x => typeof x === 'number' && Number.isFinite(x))) {
    throw new Error(`${label} must contain exactly ${length} finite numbers`);
  }
  return value as number[];
}

/** Exact ordered IDs; candidate cannot add, drop, duplicate or reorder cases. */
export function parsePredictionRows(value: unknown, expectedIds: readonly string[]) {
  if (!Array.isArray(value) || value.length !== expectedIds.length) throw new Error('Prediction rows differ from expected IDs');
  return value.map((row, i) => {
    const r = row as { id?: unknown; values?: unknown };
    if (!r || r.id !== expectedIds[i]) throw new Error(`Prediction ${i} has unexpected ID`);
    return finiteVector(r.values, EXPERIMENT_LIMITS.outputs, `Prediction ${expectedIds[i]}`);
  });
}

export type Checkpoint = { epoch: number; hidden: number; parameters: number[]; trainLoss: number; predictions: number[][] };

export function parseCheckpoint(text: string, expected: { epoch: number; hidden: number; ids: readonly string[] }): Checkpoint {
  if (Buffer.byteLength(text) > EXPERIMENT_LIMITS.maxCheckpointBytes) throw new Error('Checkpoint exceeds size limit');
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (raw.schemaVersion !== 'hedgenet-checkpoint-v1' || raw.epoch !== expected.epoch || raw.hidden !== expected.hidden) {
    throw new Error('Checkpoint schema, epoch or hidden width mismatch');
  }
  if (typeof raw.trainLoss !== 'number' || !Number.isFinite(raw.trainLoss)) throw new Error('Checkpoint training loss is not finite');
  return { epoch: expected.epoch, hidden: expected.hidden, trainLoss: raw.trainLoss,
    parameters: finiteVector(raw.parameters, parameterCount(expected.hidden), 'Checkpoint parameters'),
    predictions: parsePredictionRows(raw.validation, expected.ids) };
}

/** Pads are ignored: only the problem's actual ordered legs are decoded. */
export function evaluateFinancially(rows: readonly LabeledExample[], predictions: readonly number[][]) {
  const actual = predictions.map((values, i) => values.slice(0, rows[i]!.features.legIds.length));
  const score = scorePredictions(rows, actual);
  let cost = new D(0);
  rows.forEach((row, i) => {
    const identity = { modelVersion: 'offline-numerical-score', weightsHash: '0'.repeat(64),
      featureVersion: 'features-v1', contractHash: row.features.contractHash };
    try {
      const decoded = decodeNeuralProposal(row.problem, identity, { ...identity, schemaVersion: 'neural-proposal-v1',
        runId: row.id, valuationHash: row.problem.contentHash, legIds: row.features.legIds, values: actual[i], inferenceMs: 0 });
      cost = cost.plus(decoded.valuation.totalPremiumUsd).plus(decoded.valuation.totalFeeUsd);
    } catch { /* Invalid proposals are already counted infeasible by scorePredictions. */ }
  });
  const meanGap = score.cases.reduce((sum, c) => sum + c.normalizedRiskGap, 0) / score.cases.length;
  return { ...score, meanNormalizedRiskGap: meanGap, totalDecodedCostUsd: cost.toFixed() };
}

export type FinancialMetrics = ReturnType<typeof evaluateFinancially>;

/** Lower is better: infeasibility, then p95 gap, mean gap, then decoded cost. MSE never participates. */
export function compareFinancial(a: FinancialMetrics, b: FinancialMetrics) {
  const keys: [number, number][] = [[b.feasibleCount, a.feasibleCount], [a.normalizedRiskGapP95, b.normalizedRiskGapP95],
    [a.meanNormalizedRiskGap, b.meanNormalizedRiskGap]];
  for (const [x, y] of keys) if (Math.abs(x - y) > 1e-12) return x < y ? -1 : 1;
  return new D(a.totalDecodedCostUsd).comparedTo(b.totalDecodedCostUsd);
}

/** Host-controlled checkpoint gate: select by validation finance and stop after four stale checks. */
export class CheckpointSelector {
  best: { epoch: number; metrics: FinancialMetrics; parametersHash: string } | null = null;
  stale = 0;
  readonly history: { epoch: number; trainLoss: number; p95Gap: number; meanGap: number; costUsd: string;
    feasible: number; passed: boolean; improved: boolean }[] = [];
  readonly maxEpochs: number;
  constructor(maxEpochs: number) { this.maxEpochs = maxEpochs; }

  observe(checkpoint: Checkpoint, metrics: FinancialMetrics): 'continue' | 'stop' {
    const improved = this.best === null || compareFinancial(metrics, this.best.metrics) < 0;
    if (improved) {
      this.best = { epoch: checkpoint.epoch, metrics, parametersHash: sha256(JSON.stringify(checkpoint.parameters)) };
      this.stale = 0;
    } else this.stale++;
    this.history.push({ epoch: checkpoint.epoch, trainLoss: checkpoint.trainLoss, p95Gap: metrics.normalizedRiskGapP95,
      meanGap: metrics.meanNormalizedRiskGap, costUsd: metrics.totalDecodedCostUsd, feasible: metrics.feasibleCount,
      passed: metrics.passed, improved });
    return this.stale >= EXPERIMENT_LIMITS.staleChecks || checkpoint.epoch >= this.maxEpochs ? 'stop' : 'continue';
  }
}

export type RemoteChecks = { gradient: boolean; referenceAgreement: boolean; serialization: boolean;
  parameterSensitivity: boolean; developmentLossDecreased: boolean };

/**
 * Candidate status after held-out scoring. Numerical gates alone are insufficient:
 * integrity, remote mechanics and latency must also pass. Passing is only owner-review
 * eligibility; this function never promotes an artifact.
 */
export function candidateStatus(input: { validation: FinancialMetrics; test: FinancialMetrics | null;
  integrity: boolean; checks: RemoteChecks; latencyP95Ms: number | null; trainingWithinBudget: boolean }) {
  const reasons: string[] = [];
  if (!input.integrity) reasons.push('artifact integrity');
  for (const [name, ok] of Object.entries(input.checks)) if (!ok) reasons.push(`remote check ${name}`);
  if (!input.trainingWithinBudget) reasons.push('training budget');
  if (!input.validation.passed) reasons.push('validation numerical gates');
  if (!input.test) reasons.push('held-out evaluation missing');
  else if (!input.test.passed) reasons.push('held-out numerical gates');
  if (input.latencyP95Ms === null || !(input.latencyP95Ms < 500)) reasons.push('latency');
  return { status: reasons.length ? 'rejected' as const : 'eligible_for_owner_promotion' as const,
    promoted: false as const, reasons };
}

/** Bounded log sanitizer. Drops token-like material; it is not a general secret scanner. */
export function sanitizeLog(text: string, limit = 256 * 1024) {
  return text.slice(-limit)
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+)?/g, '[redacted-jwt]')
    .replace(/\b(sk|rt|sess)-[A-Za-z0-9_-]{12,}/g, '[redacted-token]')
    .replace(/("?(?:access_token|refresh_token|id_token|api_key|authorization)"?\s*[:=]\s*)("[^"]*"|\S+)/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]');
}
