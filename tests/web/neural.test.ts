import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleNeuralProblem, buildNeuralPreview, finishNeuralPreview, parseNeuralInput, repositoryRoot, sha } from '../../apps/web/lib/neural.ts';

const input = { units: '0.2', referencePriceUsd: '70000', budgetUsd: '5000', revision: 3, confirmedSynthetic: true };
// Transport fixture only: not a claim of trained-model output or activation evidence.
function fixture(index: number) {
  const assembled = assembleNeuralProblem(input);
  const { features, problem } = assembled;
  const expected = { runId: 'test-run', modelVersion: 'test-model', weightsHash: 'a'.repeat(64), contractHash: features.contractHash };
  const values = [0, 0, 0, 0, 0, 0];
  values[index] = 1;
  const selected = [0, 1, 2, 582, 583];
  const labels = ['Budget / loss scale', 'Worst original loss / scale', 'First scenario loss / scale', 'Low YES first ask price', 'Low YES first level depth / scale'];
  const response = { ...expected, schemaVersion: 'serving-response-v1', featureVersion: 'features-v1',
    valuationHash: problem.contentHash, budgetUsd: problem.budgetUsd, featuresHash: sha(JSON.stringify(features.values)),
    legIds: features.legIds, values, inferenceMs: 1, trace: { schemaVersion: 'activation-trace-v1', hidden: Array(32).fill(0), outputs: [...values],
      inputGroups: selected.map((f, i) => ({ label: labels[i]!, value: features.values[f]! })),
      inputWeights: Array.from({ length: 32 }, () => Array(5).fill(0)), outputWeights: Array.from({ length: 6 }, () => Array(32).fill(0)) } };
  const parameters = Array<number>(24176).fill(0);
  const finish = () => finishNeuralPreview(assembled, response, expected, parameters, ['Test fixture'], 10);
  return { assembled, response, finish };
}

describe('server neural financial boundary', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the explicit application root without repository discovery', () => {
    vi.stubEnv('HEDGENET_APP_ROOT', '/portable-app');
    expect(repositoryRoot()).toBe('/portable-app');
    vi.stubEnv('HEDGENET_APP_ROOT', 'relative');
    expect(repositoryRoot).toThrow('must be absolute');
  });

  it('fails closed for incomplete or insecure hosted settings', async () => {
    vi.stubEnv('HEDGENET_MODEL_TOKEN', 'test-only-token'.repeat(4));
    for (const url of ['', 'http://model.invalid']) {
      vi.stubEnv('HEDGENET_MODEL_URL', url);
      await expect(buildNeuralPreview(input)).rejects.toThrow('Invalid hosted model configuration');
    }
    vi.stubEnv('HEDGENET_MODEL_URL', 'https://model.invalid');
    vi.stubEnv('HEDGENET_MODEL_TOKEN', '');
    await expect(buildNeuralPreview(input)).rejects.toThrow('Invalid hosted model configuration');
  });

  it('requires explicit hosted configuration in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HEDGENET_MODEL_URL', undefined);
    vi.stubEnv('HEDGENET_MODEL_TOKEN', undefined);
    await expect(buildNeuralPreview(input)).rejects.toThrow('Production requires hosted model configuration');
  });

  it('permits only the exact internal HTTP endpoint in sandbox mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hedgenet-loopback-test-'));
    try {
      vi.stubEnv('HEDGENET_APP_ROOT', dir);
      vi.stubEnv('HEDGENET_SERVING_DIR', join(dir, 'serving'));
      vi.stubEnv('HEDGENET_MODEL_TOKEN', 'test-only-token'.repeat(4));
      vi.stubEnv('HEDGENET_RUNTIME', 'sandbox');
      vi.stubEnv('HEDGENET_MODEL_URL', 'http://127.0.0.1:8080');
      await expect(buildNeuralPreview(input)).rejects.toThrow('Prepare the neural serving model first');
      for (const url of ['http://model.invalid:8080', 'http://127.0.0.1:8081', 'http://localhost:8080', 'http://127.0.0.1:8080/other']) {
        vi.stubEnv('HEDGENET_MODEL_URL', url);
        await expect(buildNeuralPreview(input)).rejects.toThrow('Invalid hosted model configuration');
      }
      vi.stubEnv('HEDGENET_RUNTIME', 'application');
      vi.stubEnv('HEDGENET_MODEL_URL', 'http://127.0.0.1:8080');
      await expect(buildNeuralPreview(input)).rejects.toThrow('Invalid hosted model configuration');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('uses portable serving storage without Git or sandbox fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hedgenet-serving-test-'));
    try {
      vi.stubEnv('PATH', '');
      vi.stubEnv('HEDGENET_APP_ROOT', dir);
      vi.stubEnv('HEDGENET_SERVING_DIR', join(dir, 'serving'));
      vi.stubEnv('HEDGENET_MODEL_URL', 'https://model.invalid');
      vi.stubEnv('HEDGENET_MODEL_TOKEN', 'test-only-token'.repeat(4));
      await expect(buildNeuralPreview(input)).rejects.toThrow('Prepare the neural serving model first');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects unconfirmed, invalid, and out-of-envelope inputs without inference', () => {
    for (const patch of [{ confirmedSynthetic: false }, { units: '0.09' }, { units: '5.1' }, { referencePriceUsd: '105001' },
      { budgetUsd: '5000.01' }, { budgetUsd: '-1' }, { budgetUsd: '1e3' }, { revision: -1 }]) {
      expect(() => parseNeuralInput({ ...input, ...patch })).toThrow();
    }
    expect(parseNeuralInput({ ...input, budgetUsd: '0.00' }).budgetUsd).toBe('0');
  });

  it('uses first training books and independently accounts exact depth purchase cost', () => {
    const f = fixture(0);
    const p = f.finish();
    const asks = f.assembled.problem.legs[0]!.asks;
    // Frozen asks are integer cents and integer shares: sum in cents independently.
    const cents = asks.reduce((sum, level) => sum + Math.floor(Number(level.size) * 9 / 10) * Math.round(Number(level.price) * 100), 0);
    expect(p.valuation.totalCostUsd).toBe(String(cents / 100));
    expect(p.dataMode).toBe('synthetic');
    expect(f.assembled.problem.snapshotId).toContain('17001');
    expect(f.assembled.contract.legIds).toEqual(f.assembled.features.legIds);
    expect(p.exposure.units).toBe('0.2');
  });

  it('retains a real non-improving candidate, rather than replacing it with a baseline', () => {
    const p = fixture(4).finish();
    expect(p.outcome).toBe('no_improvement');
    expect(Number(p.valuation.totalCostUsd)).toBeGreaterThan(0);
  });

  it('rejects stale identity, feature/weight trace substitution, and dimension mismatches', () => {
    const changes = [
      (f: ReturnType<typeof fixture>) => { f.response.runId = 'stale'; },
      (f: ReturnType<typeof fixture>) => { f.response.budgetUsd = '1000'; },
      (f: ReturnType<typeof fixture>) => { f.response.weightsHash = 'b'.repeat(64); },
      (f: ReturnType<typeof fixture>) => { f.response.trace.inputGroups[0]!.value = 99; },
      (f: ReturnType<typeof fixture>) => { f.response.trace.inputWeights[0]![0] = 99; },
      (f: ReturnType<typeof fixture>) => { f.response.trace.outputWeights[0]![0] = 99; },
      (f: ReturnType<typeof fixture>) => { f.response.trace.hidden.pop(); },
      (f: ReturnType<typeof fixture>) => { f.response.values.pop(); },
    ];
    for (const change of changes) { const f = fixture(0); change(f); expect(f.finish).toThrow(); }
  });
});
