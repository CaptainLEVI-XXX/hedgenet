import { beforeAll, describe, expect, it } from 'vitest';
import { buildSyntheticDataset, labelExample } from '../../packages/training/src/dataset.ts';
import type { LabeledExample } from '../../packages/training/src/dataset.ts';
import { candidateStatus, CheckpointSelector, evaluateFinancially, parameterCount, parseAttemptConfig,
  parseCheckpoint, sanitizeLog, managedProcessId } from '../../packages/training/src/controller.ts';

let rows: LabeledExample[];
beforeAll(async () => {
  rows = [];
  for (const example of buildSyntheticDataset('crypto', true).examples) rows.push(await labelExample(example));
}, 60_000);

const pad = (values: number[]) => [...values, ...Array(16 - values.length).fill(0)];
const teacher = () => rows.map(row => pad(row.targets.slice(0, row.features.legIds.length)));
const zeros = () => rows.map(() => Array(16).fill(0));
const checkpoint = (epoch: number, trainLoss: number, predictions: number[][]) => JSON.stringify({
  schemaVersion: 'hedgenet-checkpoint-v1', epoch, hidden: 8, trainLoss, parameters: Array(parameterCount(8)).fill(0.01),
  validation: rows.map((row, i) => ({ id: row.id, values: predictions[i] })) });

describe('training controller gates', () => {
  it('preserves full managed process IDs including URL-safe punctuation', () => {
    expect(managedProcessId({ process_id: 'proc_oGRtcAQjLYbFUbPOQi-5Fg' })).toBe('proc_oGRtcAQjLYbFUbPOQi-5Fg');
    expect(managedProcessId({ result: { process_id: 'proc_ooz_aPAHn4hSBD0IRQGioQ' } })).toBe('proc_ooz_aPAHn4hSBD0IRQGioQ');
    expect(managedProcessId({ id: 'not-a-process' })).toBeNull();
  });

  it('accepts only the predeclared search space', () => {
    expect(parseAttemptConfig({ hidden: 32, learningRate: 0.001, maxEpochs: 120 })).toEqual({ hidden: 32, learningRate: 0.001, maxEpochs: 120 });
    for (const bad of [{ hidden: 16, learningRate: 0.001, maxEpochs: 120 }, { hidden: 8, learningRate: 0.01, maxEpochs: 120 },
      { hidden: 8, learningRate: 0.001, maxEpochs: 125 }, { hidden: 8, learningRate: 0.001, maxEpochs: 7 }]) {
      expect(() => parseAttemptConfig(bad)).toThrow();
    }
  });

  it('rejects checkpoints with reordered IDs, short outputs or wrong parameter counts', () => {
    const ids = rows.map(row => row.id);
    expect(parseCheckpoint(checkpoint(5, 1, zeros()), { epoch: 5, hidden: 8, ids }).predictions).toHaveLength(rows.length);
    const swapped = JSON.parse(checkpoint(5, 1, zeros()));
    [swapped.validation[0], swapped.validation[1]] = [swapped.validation[1], swapped.validation[0]];
    expect(() => parseCheckpoint(JSON.stringify(swapped), { epoch: 5, hidden: 8, ids })).toThrow(/unexpected ID/);
    const short = JSON.parse(checkpoint(5, 1, zeros()));
    short.validation[0].values = Array(15).fill(0);
    expect(() => parseCheckpoint(JSON.stringify(short), { epoch: 5, hidden: 8, ids })).toThrow(/16 finite/);
    const params = JSON.parse(checkpoint(5, 1, zeros()));
    params.parameters.pop();
    expect(() => parseCheckpoint(JSON.stringify(params), { epoch: 5, hidden: 8, ids })).toThrow(/parameters/);
    expect(() => parseCheckpoint(checkpoint(10, 1, zeros()), { epoch: 5, hidden: 8, ids })).toThrow(/epoch/);
  });

  it('selects by validation finance rather than training loss and stops after four stale checks', () => {
    const ids = rows.map(row => row.id);
    const selector = new CheckpointSelector(120);
    const good = parseCheckpoint(checkpoint(5, 9, teacher()), { epoch: 5, hidden: 8, ids });
    expect(selector.observe(good, evaluateFinancially(rows, good.predictions))).toBe('continue');
    const actions = [10, 15, 20, 25].map(epoch => {
      const lowLossZero = parseCheckpoint(checkpoint(epoch, 0.0001, zeros()), { epoch, hidden: 8, ids });
      return selector.observe(lowLossZero, evaluateFinancially(rows, lowLossZero.predictions));
    });
    expect(selector.best?.epoch).toBe(5);
    expect(actions).toEqual(['continue', 'continue', 'continue', 'stop']);
  });

  it('keeps numerically passing candidates rejected when mechanics fail, and never promotes', () => {
    const metrics = evaluateFinancially(rows, teacher());
    const passing = { ...metrics, passed: true };
    const checks = { gradient: true, referenceAgreement: true, serialization: true, parameterSensitivity: true, developmentLossDecreased: true };
    const ok = candidateStatus({ validation: passing, test: passing, integrity: true, checks, latencyP95Ms: 20, trainingWithinBudget: true });
    expect(ok).toEqual({ status: 'eligible_for_owner_promotion', promoted: false, reasons: [] });
    const bad = candidateStatus({ validation: passing, test: passing, integrity: true, checks: { ...checks, gradient: false },
      latencyP95Ms: 20, trainingWithinBudget: true });
    expect(bad.status).toBe('rejected');
    expect(candidateStatus({ validation: passing, test: null, integrity: true, checks, latencyP95Ms: 20, trainingWithinBudget: true }).status).toBe('rejected');
  });

  it('redacts token-like material from retained logs', () => {
    const text = sanitizeLog('ok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk "refresh_token": "rt_secret" Bearer abc.def');
    expect(text).not.toMatch(/eyJhbGci|rt_secret|abc\.def/);
  });
});
