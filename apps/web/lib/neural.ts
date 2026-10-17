// Node-only: credentials and sandbox transport must never enter a client bundle.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { buildScenarios, createValuationProblem, encodeFeatures, decodeNeuralProposal } from '@hedgenet/core';
import { buildSyntheticDataset } from '../../../packages/training/src/dataset.ts';
import type { NeuralInput, NeuralPreview } from './neural-contract.ts';

const D = Decimal.clone({ precision: 80 });
export const WEIGHTS_HASH = '3c02cebca2e29a3b66083ac7494a89aa71173bdcc47709a47a3793add1a867a0';
export const RUNTIME_HASH = '75da2a13f39720e34b1e440533460435ead0af9a88fccad8c94e94a816dafa21';
export const MODEL_HASH = '3a48c05121540bb4b2f6df45ad6fe55ff3032d14afbd112819a556153263c325';
export const MODEL_VERSION = 'crypto-attempt-3-epoch-5-advisory-v1';
export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export class NeuralInputError extends Error {}
export class NeuralUnavailableError extends Error {}
export class NeuralBusyError extends Error {}

export function parseNeuralInput(body: unknown): NeuralInput {
  if (!body || typeof body !== 'object') throw new NeuralInputError('Synthetic exposure is required.');
  const b = body as Record<string, unknown>;
  if (b.confirmedSynthetic !== true) throw new NeuralInputError('Confirm synthetic data before inference.');
  if (!Number.isSafeInteger(b.revision) || (b.revision as number) < 0) throw new NeuralInputError('Invalid revision.');
  const decimal = (name: string, min: string, max: string) => {
    const v = b[name];
    if (typeof v !== 'string' || v.length > 26 || !/^(?:0|[1-9]\d*)(?:\.\d{1,11})?$/.test(v)) throw new NeuralInputError(`${name} must be a decimal string.`);
    const d = new D(v);
    if (d.lt(min) || d.gt(max)) throw new NeuralInputError(`${name} must be between ${min} and ${max}.`);
    return d.toFixed();
  };
  return { units: decimal('units', '0.1', '5'), referencePriceUsd: decimal('referencePriceUsd', '35000', '105000'),
    budgetUsd: decimal('budgetUsd', '0', '5000'), revision: b.revision as number, confirmedSynthetic: true };
}

let frozen: ReturnType<typeof buildSyntheticDataset> | undefined;
export function assembleNeuralProblem(raw: unknown) {
  const input = parseNeuralInput(raw);
  const dataset = frozen ??= buildSyntheticDataset('crypto');
  const first = dataset.examples[0]!;
  if (first.split !== 'train' || first.bookSeed !== 17001) throw new Error('Frozen training group mismatch');
  const scenarios = buildScenarios({ schemaVersion: 'loss-v1', currency: 'USD', templateId: 'terminal_downside',
    units: input.units, referencePriceUsd: input.referencePriceUsd }, dataset.rules.settlement);
  const problem = createValuationProblem({ schemaVersion: 'valuation-v1', currency: 'USD', dataMode: 'synthetic',
    snapshotId: 'synthetic-crypto-17001-serving-v1', rulesHash: dataset.contract.rulesHash, budgetUsd: input.budgetUsd,
    states: scenarios.states.map(({ stateId, originalLossUsd }) => ({ stateId, originalLossUsd })),
    legs: scenarios.legs.map((leg, j) => ({ ...leg, minShares: first.problem.legs[j]!.minShares,
      fee: first.problem.legs[j]!.fee, asks: first.problem.legs[j]!.asks })),
  });
  return { input, scenarios, problem, features: encodeFeatures(problem, dataset.contract), contract: dataset.contract };
}

export function repositoryRoot() {
  if (process.env.HEDGENET_APP_ROOT) {
    if (!isAbsolute(process.env.HEDGENET_APP_ROOT)) throw new NeuralUnavailableError('Application root must be absolute.');
    return process.env.HEDGENET_APP_ROOT;
  }
  // Local Next commands run from either the workspace or apps/web. No scanning.
  // Full-app deployments explicitly copy the two serving assets and trusted
  // infer wrapper; this local fallback must not trace the whole repository.
  return process.cwd().endsWith('/apps/web') ? resolve(/* turbopackIgnore: true */ process.cwd(), '../..')
    : resolve(/* turbopackIgnore: true */ process.cwd());
}
function servingDirectory(root: string) {
  const configured = process.env.HEDGENET_SERVING_DIR;
  if (configured && !isAbsolute(configured)) throw new NeuralUnavailableError('Serving directory must be absolute.');
  return configured || join(root, '.amp/in/serving');
}
const exec = promisify(execFile);
/** No retries: an ambiguous remote operation must not be started twice. */
export async function servingCli(root: string, args: string[], json = true, timeout = 45_000) {
  try {
    const result = await exec('createos', [...(json ? ['--output', 'json'] : []), ...args], {
      cwd: root, timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
    });
    return result.stdout;
  } catch { throw new NeuralUnavailableError('CreateOS serving operation failed.'); }
}

// Exclusive directory survives HMR and multiple Node workers. Fail closed after a
// crash: an operator must confirm remote termination/pause before removing it.
const globalLock = globalThis as typeof globalThis & { hedgeNetServingBusy?: boolean };
export async function withServingLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  if (globalLock.hedgeNetServingBusy) throw new NeuralBusyError('Neural inference is busy.');
  const dir = servingDirectory(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'operation.lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new NeuralBusyError('Neural serving is locked; confirm sandbox is paused before clearing a stale lock.'); }
  globalLock.hedgeNetServingBusy = true;
  try { return await fn(); } finally { globalLock.hedgeNetServingBusy = false; rmdirSync(lock); }
}

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const registrySchema = z.object({ schemaVersion: z.literal('neural-serving-v1'), sandboxId: z.string().regex(/^sb-[A-Za-z0-9_-]+$/),
  remoteDir: z.string().regex(/^\/root\/hedgenet-serving\/[a-f0-9]{16}$/), modelVersion: z.literal(MODEL_VERSION),
  weightsHash: z.literal(WEIGHTS_HASH), contractHash: hashSchema, featureVersion: z.literal('features-v1'),
  qualityPolicy: z.literal('advisory'), qualityWarnings: z.array(z.string()).min(1), verified: z.literal(true),
  files: z.record(z.string(), hashSchema), legIds: z.array(z.string()).length(6) });
const vector = (n: number) => z.array(z.number().finite()).length(n);
const traceSchema = z.object({ schemaVersion: z.literal('activation-trace-v1'), hidden: z.array(z.number().finite().nonnegative()).length(32),
  outputs: vector(6), inputGroups: z.array(z.object({ label: z.string(), value: z.number().finite() })).length(5),
  inputWeights: z.array(vector(5)).length(32), outputWeights: z.array(vector(32)).length(6) });
const responseSchema = z.object({ schemaVersion: z.literal('serving-response-v1'), runId: z.string(), valuationHash: hashSchema,
  featuresHash: hashSchema, budgetUsd: z.string(), modelVersion: z.string(), weightsHash: hashSchema, contractHash: hashSchema,
  featureVersion: z.literal('features-v1'), legIds: z.array(z.string()).length(6), values: vector(6),
  inferenceMs: z.number().finite().nonnegative().max(30_000), trace: traceSchema });
const selected = [0, 1, 2, 582, 583];
const labels = ['Budget / loss scale', 'Worst original loss / scale', 'First scenario loss / scale', 'Low YES first ask price', 'Low YES first level depth / scale'];

/** Financial assembly is separate from transport so binding failures can be tested offline. */
export function finishNeuralPreview(assembled: ReturnType<typeof assembleNeuralProblem>, raw: unknown,
  expected: { runId: string; modelVersion: string; weightsHash: string; contractHash: string }, parameters: number[],
  qualityWarnings: string[], totalMs: number, runtime: 'sandbox' | 'application' = 'sandbox'): NeuralPreview {
  const r = responseSchema.parse(raw);
  const { input, problem, features, scenarios } = assembled;
  if (r.runId !== expected.runId || r.budgetUsd !== problem.budgetUsd || r.featuresHash !== sha(JSON.stringify(features.values))
    || features.contractHash !== expected.contractHash || parameters.length !== 24176 || parameters.some(x => !Number.isFinite(x))) throw new Error('Inference request mismatch');
  for (let i = 0; i < 5; i++) {
    if (r.trace.inputGroups[i]!.label !== labels[i] || r.trace.inputGroups[i]!.value !== features.values[selected[i]!]) throw new Error('Feature trace mismatch');
  }
  for (let h = 0; h < 32; h++) for (let i = 0; i < 5; i++) {
    if (r.trace.inputWeights[h]![i] !== Math.fround(parameters[h * 738 + selected[i]!]!)) throw new Error('Input weight mismatch');
  }
  for (let o = 0; o < 6; o++) {
    if (r.trace.outputs[o] !== r.values[o]) throw new Error('Output trace mismatch');
    for (let h = 0; h < 32; h++) if (r.trace.outputWeights[o]![h] !== Math.fround(parameters[739 * 32 + o * 32 + h]!)) throw new Error('Output weight mismatch');
  }
  const decoded = decodeNeuralProposal(problem, { modelVersion: expected.modelVersion, weightsHash: expected.weightsHash,
    contractHash: expected.contractHash, featureVersion: 'features-v1' }, {
    schemaVersion: 'neural-proposal-v1', modelVersion: r.modelVersion, weightsHash: r.weightsHash,
    contractHash: r.contractHash, featureVersion: r.featureVersion, runId: r.runId, valuationHash: r.valuationHash,
    legIds: r.legIds, values: r.values, inferenceMs: r.inferenceMs,
  });
  const valuation = decoded.valuation;
  const original = new D(valuation.worstOriginalLossUsd);
  const names = ['BTC below $60,000', 'BTC $60,000 to under $80,000', 'BTC $80,000 or above'];
  return { schemaVersion: 'neural-preview-v1', example: 'crypto', revision: input.revision, proposalSource: 'neural-network',
    dataMode: 'synthetic', outcome: decoded.outcome, valuation, trace: r.trace,
    maximumPayoutUsd: D.max(...valuation.scenarios.map(s => s.payoutUsd)).toFixed(),
    unspentBudgetUsd: new D(problem.budgetUsd).minus(valuation.totalCostUsd).toFixed(),
    worstLossReductionPct: original.isZero() ? null : new D(valuation.riskReductionUsd).div(original).times(100).toDecimalPlaces(1, D.ROUND_DOWN).toFixed(1),
    scenarioLabels: Object.fromEntries(scenarios.states.map(s => [s.stateId, s.location.kind === 'numeric'
      ? `BTC ${s.location.side} $${s.location.value}` : s.location.kind === 'tail' ? `BTC ${s.location.direction} tail` : 'Scenario'])),
    scenarioLocations: Object.fromEntries(scenarios.states.map(s => [s.stateId, s.location])),
    legs: problem.legs.map((leg, j) => ({ legId: leg.legId, label: names[Math.floor(j / 2)]!, side: j % 2 === 0 ? 'YES' : 'NO', price: leg.asks[0]!.price })),
    exposure: { units: input.units, referencePriceUsd: input.referencePriceUsd },
    model: { version: expected.modelVersion, weightsHash: expected.weightsHash, qualityPolicy: 'advisory', qualityWarnings },
    execution: { provider: 'createos', runtime, inferenceMs: r.inferenceMs, totalMs },
    repair: { budgetScaled: decoded.repair.budgetScaled, multiplier: decoded.repair.multiplier, droppedLegIds: decoded.repair.droppedLegIds } };
}

export async function buildNeuralPreview(raw: unknown): Promise<NeuralPreview> {
  const started = Date.now();
  const assembled = assembleNeuralProblem(raw);
  const root = repositoryRoot();
  const explicitHosted = process.env.HEDGENET_MODEL_URL !== undefined || process.env.HEDGENET_MODEL_TOKEN !== undefined;
  const sandboxRuntime = process.env.HEDGENET_RUNTIME === 'sandbox';
  const hostedUrl = z.url().refine(url => url.startsWith('https://')
    || (sandboxRuntime && url === 'http://127.0.0.1:8080'));
  const hostedEnvironment = explicitHosted ? z.object({ url: hostedUrl, token: z.string().min(32) })
    .safeParse({ url: process.env.HEDGENET_MODEL_URL, token: process.env.HEDGENET_MODEL_TOKEN }) : undefined;
  if (hostedEnvironment && !hostedEnvironment.success) throw new NeuralUnavailableError('Invalid hosted model configuration.');
  if (process.env.NODE_ENV === 'production' && !explicitHosted) throw new NeuralUnavailableError('Production requires hosted model configuration.');
  // Confirm private storage before creating any runtime files.
  try { if (!explicitHosted) await exec('git', ['check-ignore', '-q', '.amp/in/serving/crypto.json'], { cwd: root }); }
  catch { throw new NeuralUnavailableError('Private serving storage is not excluded from git.'); }
  return withServingLock(root, async () => {
    const dir = servingDirectory(root);
    if (!existsSync(join(dir, 'crypto.json'))) throw new NeuralUnavailableError('Prepare the neural serving model first.');
    const registry = registrySchema.parse(JSON.parse(readFileSync(join(dir, 'crypto.json'), 'utf8')));
    const bytes = readFileSync(join(dir, 'weights.json'));
    if (sha(bytes) !== registry.weightsHash || registry.files['runtime/numeric-ui-core.ts'] !== RUNTIME_HASH
      || registry.files['candidate/model.ts'] !== MODEL_HASH
      || registry.files['infer.mjs'] !== sha(readFileSync(join(root, 'packages/training/remote/infer.mjs')))
      || registry.contractHash !== assembled.features.contractHash
      || JSON.stringify(registry.legIds) !== JSON.stringify(assembled.features.legIds)) throw new NeuralUnavailableError('Serving registry integrity mismatch.');
    const parameters = (JSON.parse(bytes.toString()) as { parameters: number[] }).parameters;
    const runId = randomUUID();
    const req = { ...assembled.features, features: assembled.features.values, featuresHash: sha(JSON.stringify(assembled.features.values)),
      runId, budgetUsd: assembled.problem.budgetUsd, modelVersion: registry.modelVersion, weightsHash: registry.weightsHash };
    // Explicit hosted configuration selects the deployed service. A failure here
    // is returned, never silently replaced by a different runtime or a solver.
    if (explicitHosted || existsSync(join(dir, 'hosted.json'))) {
      const hosted = hostedEnvironment?.success ? hostedEnvironment.data : z.object({ url: hostedUrl, token: z.string().min(32),
        weightsHash: z.literal(WEIGHTS_HASH), modelVersion: z.literal(MODEL_VERSION) })
        .parse(JSON.parse(readFileSync(join(dir, 'hosted.json'), 'utf8')));
      let response: Response;
      try {
        response = await fetch(new URL('/infer', hosted.url), { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hosted.token}` },
          body: JSON.stringify(req), signal: AbortSignal.timeout(30_000), redirect: 'error', cache: 'no-store' });
      } catch { throw new NeuralUnavailableError('Hosted model could not be reached.'); }
      if (!response.ok || !response.body) throw new NeuralUnavailableError('Hosted model request failed.');
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 128 * 1024) { await reader.cancel(); throw new NeuralUnavailableError('Model response exceeded its limit.'); }
        chunks.push(Buffer.from(value));
      }
      return finishNeuralPreview(assembled, JSON.parse(Buffer.concat(chunks).toString('utf8')), { ...registry, runId },
        parameters, registry.qualityWarnings, Date.now() - started, sandboxRuntime ? 'sandbox' : 'application');
    }
    const sandbox = registry.sandboxId;
    let response: unknown;
    try {
      const info = JSON.parse(await servingCli(root, ['sandbox', 'get', sandbox]));
      if (info.ingress_enabled !== false || !['paused', 'running'].includes(info.status)) throw new NeuralUnavailableError('Unsafe sandbox state.');
      if (info.status === 'paused') await servingCli(root, ['sandbox', 'resume', sandbox], true, 90_000);
      const checks = ['weights.json', 'infer.mjs', 'runtime/numeric-ui-core.ts', 'candidate/model.ts']
        .map(name => `${registry.files[name]}  ${name}`).join('\n')
        + `\n${sha(readFileSync(join(dir, 'manifest.json')))}  manifest.json\n`;
      const command = `cd ${registry.remoteDir} && test ! -e "$HOME/.codex/auth.json"`
        + ` && ! pgrep -f '[ /][c]odex( |$)|[ /][t]rain\\.ts( |$)' >/dev/null`
        + ` && printf '%s' '${Buffer.from(checks).toString('base64')}' | base64 -d | sha256sum -c - >/dev/null`
        + ` && timeout --signal=TERM --kill-after=2s 30s node infer.mjs ${Buffer.from(JSON.stringify(req)).toString('base64')}`;
      response = JSON.parse(await servingCli(root, ['sandbox', 'exec', sandbox, '--', 'bash', '-c', command], false, 45_000));
    } finally {
      await servingCli(root, ['sandbox', 'pause', sandbox], true, 45_000);
      const paused = JSON.parse(await servingCli(root, ['sandbox', 'get', sandbox]));
      if (paused.status !== 'paused') throw new NeuralUnavailableError('Could not confirm sandbox pause.');
    }
    return finishNeuralPreview(assembled, response, { ...registry, runId }, parameters, registry.qualityWarnings, Date.now() - started);
  });
}
