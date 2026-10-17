// Trusted serving wrapper. No candidate imports on the serving request path.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const selectedFeatures = [0, 1, 2, 582, 583];
export const featureLabels = ['Budget / loss scale', 'Worst original loss / scale', 'First scenario loss / scale', 'Low YES first ask price', 'Low YES first level depth / scale'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function loadWeights(path, expectedHash) {
  const bytes = readFileSync(path);
  if (sha(bytes) !== expectedHash) throw new Error('Weights hash mismatch');
  const cp = JSON.parse(bytes);
  if (cp.schemaVersion !== 'hedgenet-checkpoint-v1' || cp.hidden !== 32 || cp.parameterCount !== 24176
    || !Array.isArray(cp.parameters) || cp.parameters.length !== 24176
    || cp.parameters.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error('Invalid checkpoint');
  return Float32Array.from(cp.parameters);
}

// This is the original 738 -> 32 ReLU -> 16 affine FP32 network, using the
// pinned Handwired Circuit rather than approximating its tensor semantics.
export async function createServingNetwork(parameters) {
  const { Circuit } = await import('./runtime/numeric-ui-core.ts');
  const circuit = new Circuit(24176 + 738);
  const s = i => circuit.source(i);
  for (let f = 0; f < 738; f++) circuit.assumeRange(s(24176 + f), 0, 8);
  const hidden = [];
  for (let h = 0; h < 32; h++) {
    const terms = [[s(738 * 32 + h), 1]];
    for (let f = 0; f < 738; f++) terms.push([circuit.multiply(s(h * 738 + f), s(24176 + f)), 1]);
    const sum = circuit.roundAffine(terms);
    hidden.push(circuit.reglu([], 1, [[sum, 1]], 0));
  }
  const outputs = [];
  for (let o = 0; o < 16; o++) {
    const terms = [[s(755 * 32 + o), 1]];
    for (let h = 0; h < 32; h++) terms.push([circuit.multiply(s(739 * 32 + o * 32 + h), hidden[h]), 1]);
    outputs.push(circuit.roundAffine(terms));
  }
  const source = new Float32Array(circuit.sourceSize);
  source.set(parameters);
  const evaluate = circuit.createTensorEvaluator([...outputs, ...hidden]);
  return features => {
    if (!Array.isArray(features) || features.length !== 738 || features.some(x => typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 8)) throw new Error('Invalid features');
    source.set(features, 24176);
    const values = Array.from(evaluate(source));
    if (values.some(x => !Number.isFinite(x))) throw new Error('Nonfinite activation');
    return { values: values.slice(0, 16), trace: {
      schemaVersion: 'activation-trace-v1', hidden: values.slice(16), outputs: values.slice(0, 6),
      inputGroups: selectedFeatures.map((f, i) => ({ label: featureLabels[i], value: features[f] })),
      inputWeights: Array.from({ length: 32 }, (_, h) => selectedFeatures.map(f => parameters[h * 738 + f])),
      outputWeights: Array.from({ length: 6 }, (_, o) => Array.from(parameters.slice(739 * 32 + o * 32, 739 * 32 + (o + 1) * 32))),
    } };
  };
}

async function main() {
  const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (sha(readFileSync(new URL(name, import.meta.url))) !== expected) throw new Error('Serving file integrity mismatch');
  }
  const parameters = loadWeights(new URL('./weights.json', import.meta.url), manifest.weightsHash);
  const predict = await createServingNetwork(parameters);
  if (process.argv[2] === '--verify') {
    // Executed ONLY inside the sandbox during preparation, never on the host.
    const { createNetwork } = await import('./candidate/model.ts');
    const original = createNetwork({ hidden: 32, parameters });
    const probes = JSON.parse(readFileSync(new URL('./probes.json', import.meta.url), 'utf8'));
    for (const features of probes) {
      const a = original.predict(features), b = predict(features).values;
      if (a.length !== 16 || a.some((x, i) => Math.abs(x - b[i]) > 1e-6 * Math.max(1, Math.abs(x)))) throw new Error('Original model comparison failed');
    }
    console.log(JSON.stringify({ verified: true, probes: probes.length }));
    return;
  }
  const req = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
  if (req.modelVersion !== manifest.modelVersion || req.weightsHash !== manifest.weightsHash
    || req.contractHash !== manifest.contractHash || req.featureVersion !== 'features-v1'
    || !/^[a-f0-9]{64}$/.test(req.valuationHash) || !/^[a-f0-9]{64}$/.test(req.featuresHash)
    || sha(JSON.stringify(req.features)) !== req.featuresHash
    || JSON.stringify(req.legIds) !== JSON.stringify(manifest.legIds)
    || typeof req.budgetUsd !== 'string' || typeof req.runId !== 'string') throw new Error('Request identity mismatch');
  const started = performance.now();
  const result = predict(req.features);
  console.log(JSON.stringify({ schemaVersion: 'serving-response-v1', runId: req.runId,
    valuationHash: req.valuationHash, featuresHash: req.featuresHash, budgetUsd: req.budgetUsd,
    modelVersion: manifest.modelVersion, weightsHash: manifest.weightsHash, contractHash: manifest.contractHash,
    featureVersion: 'features-v1', legIds: manifest.legIds, values: result.values.slice(0, 6),
    inferenceMs: performance.now() - started, trace: result.trace }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
