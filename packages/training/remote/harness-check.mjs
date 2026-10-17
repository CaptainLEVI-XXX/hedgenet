// HedgeNet fixed remote harness check. Written by the builder (not Codex) and run
// ONLY inside the CreateOS sandbox, because it imports candidate code. Its output is
// numeric evidence the trusted host schema-checks; it is not a financial evaluator.
//
// Usage:
//   node harness-check.mjs mechanics <candidateDir> <development.json> <devRunDir> <out.json>
//   node harness-check.mjs latency <candidateDir> <weights.json> <inputs.json> <out.json>
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, candidateDir, a, b, out] = process.argv.slice(2);
const OUTPUTS = 16, FEATURES = 738;
const { createNetwork, initializeParameters } = await import(pathToFileURL(join(candidateDir, 'model.ts')).href);
const count = h => FEATURES * h + h + h * OUTPUTS + OUTPUTS;
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const finite16 = v => v != null && v.length === OUTPUTS && Array.from(v).every(Number.isFinite);
function maskedMse(y, t, m) {
  let s = 0, n = 0;
  for (let j = 0; j < OUTPUTS; j++) if (m[j]) { s += (y[j] - t[j]) ** 2; n++; }
  return n ? s / n : 0;
}
const result = { schemaVersion: 'hedgenet-harness-v1', mode, startedAt: new Date().toISOString() };
try {
  if (mode === 'mechanics') {
    const rows = read(a);
    const hidden = 8;
    const initial = Float32Array.from(initializeParameters(hidden, 17));
    const net = createNetwork({ hidden, parameters: initial });
    result.parameterCount = net.parameterCount;
    result.parameterCountOk = net.parameterCount === count(hidden) && initial.length === count(hidden);
    // Parameter sensitivity: changing an output bias and a first-layer weight moves outputs.
    const x = rows.find(r => r.features.some(v => v > 0)).features;
    const base = net.predictReference(x);
    const p = net.getParameters();
    const outBias = count(hidden) - OUTPUTS;
    p[outBias] += 0.25; net.setParameters(p);
    const movedBias = Math.abs(net.predictReference(x)[0] - base[0]) > 0.1;
    p[outBias] -= 0.25;
    const feature = x.findIndex(v => v > 0.05);
    let movedWeight = false;
    for (let h = 0; h < hidden && !movedWeight; h++) {
      const q = Float32Array.from(p); q[h * FEATURES + feature] += 1; net.setParameters(q);
      movedWeight = net.predictReference(x).some((v, j) => Math.abs(v - base[j]) > 1e-6);
    }
    net.setParameters(p);
    result.parameterSensitivity = movedBias && movedWeight;
    // Tensor (compiled) vs reference agreement on all development inputs.
    let maxDiff = 0, allFinite = true;
    for (const r of rows) {
      const t = net.predict(r.features), ref = net.predictReference(r.features);
      allFinite &&= finite16(t) && finite16(ref);
      for (let j = 0; j < OUTPUTS; j++) maxDiff = Math.max(maxDiff, Math.abs(t[j] - ref[j]));
    }
    result.referenceMaxAbsDiff = maxDiff;
    result.referenceAgreement = allFinite && maxDiff <= 1e-4;
    // Central-difference check of candidate gradient against a harness-computed masked MSE.
    const checks = [];
    const indices = [outBias, outBias + 3, count(hidden) - OUTPUTS - 1, FEATURES * hidden, FEATURES * hidden + 1,
      feature, FEATURES + feature, 2 * FEATURES + feature];
    for (const r of rows.filter(r => r.mask.some(Boolean)).slice(0, 3)) {
      const g = net.lossAndGradient(r.features, r.targets, r.mask);
      const lossHarness = maskedMse(net.predictReference(r.features), r.targets, r.mask);
      const lossAgrees = Math.abs(g.loss - lossHarness) <= 1e-5 + 1e-3 * Math.abs(lossHarness);
      for (const i of indices) {
        let agree = false, numeric = null;
        for (const eps of [1e-3, 1e-4]) {
          const q = Float32Array.from(p);
          q[i] = p[i] + eps; net.setParameters(q); const up = maskedMse(net.predictReference(r.features), r.targets, r.mask);
          q[i] = p[i] - eps; net.setParameters(q); const down = maskedMse(net.predictReference(r.features), r.targets, r.mask);
          numeric = (up - down) / (2 * eps);
          if (Math.abs(numeric - g.gradient[i]) <= 2e-4 + 0.02 * Math.max(Math.abs(numeric), Math.abs(g.gradient[i]))) { agree = true; break; }
        }
        net.setParameters(p);
        checks.push({ example: r.id, parameter: i, analytic: g.gradient[i], numeric, agree, lossAgrees });
      }
      if (g.gradient.length !== count(hidden)) checks.push({ example: r.id, agree: false, reason: 'gradient length' });
    }
    result.gradientChecks = checks;
    result.gradient = checks.length > 0 && checks.every(c => c.agree && c.lossAgrees !== false);
    // Serialization: fixed weights format round-trips through JSON and the candidate predict CLI.
    const weightsPath = join(b, 'harness-roundtrip-weights.json');
    writeFileSync(weightsPath, JSON.stringify({ schemaVersion: 'hedgenet-weights-v1', hidden, parameterCount: count(hidden),
      parameters: Array.from(p) }));
    const reloaded = createNetwork({ hidden, parameters: Float32Array.from(read(weightsPath).parameters) });
    const inputsPath = join(b, 'harness-roundtrip-inputs.json');
    writeFileSync(inputsPath, JSON.stringify(rows.map(r => ({ id: r.id, features: r.features }))));
    const cliOut = join(b, 'harness-roundtrip-predictions.json');
    execFileSync(process.execPath, [join(candidateDir, 'predict.ts'), weightsPath, inputsPath, cliOut], { timeout: 60_000, stdio: 'ignore' });
    const cli = read(cliOut).predictions;
    let serialDiff = 0, ok = Array.isArray(cli) && cli.length === rows.length;
    rows.forEach((r, i) => {
      const before = net.predict(r.features), after = reloaded.predict(r.features);
      if (!(cli?.[i]?.id === r.id && finite16(cli[i].values))) { ok = false; return; }
      for (let j = 0; j < OUTPUTS; j++) {
        serialDiff = Math.max(serialDiff, Math.abs(before[j] - after[j]), Math.abs(before[j] - cli[i].values[j]));
      }
    });
    result.serializationMaxAbsDiff = serialDiff;
    result.serialization = ok && serialDiff <= 1e-6;
    // Development learning: harness-computed loss at initial vs last checkpoint of the dev run.
    const last = readdirSync(b).filter(f => /^checkpoint-\d{4}\.json$/.test(f)).sort().at(-1);
    const init = read(join(b, 'initial.json'));
    const meanLoss = params => {
      const n = createNetwork({ hidden: init.hidden, parameters: Float32Array.from(params) });
      return rows.reduce((s, r) => s + maskedMse(n.predictReference(r.features), r.targets, r.mask), 0) / rows.length;
    };
    result.developmentCheckpoint = last ?? null;
    result.developmentInitialLoss = meanLoss(init.parameters);
    result.developmentFinalLoss = last ? meanLoss(read(join(b, last)).parameters) : null;
    result.developmentLossDecreased = last !== undefined && result.developmentFinalLoss < result.developmentInitialLoss;
    result.passed = result.parameterCountOk && result.parameterSensitivity && result.referenceAgreement
      && result.gradient && result.serialization && result.developmentLossDecreased;
  } else if (mode === 'latency') {
    const weights = read(a), inputs = read(b);
    const net = createNetwork({ hidden: weights.hidden, parameters: Float32Array.from(weights.parameters) });
    for (const r of inputs.slice(0, 3)) net.predict(r.features);
    const times = inputs.map(r => { const t = performance.now(); net.predict(r.features); return performance.now() - t; }).sort((x, y) => x - y);
    const q = p => times[Math.max(0, Math.ceil(p * times.length) - 1)];
    result.samples = times.length; result.warmP50Ms = q(0.5); result.warmP95Ms = q(0.95);
    result.passed = result.warmP95Ms < 500;
  } else throw new Error('unknown mode');
} catch (error) {
  result.passed = false;
  result.error = String(error?.stack ?? error).slice(0, 4000);
}
result.finishedAt = new Date().toISOString();
writeFileSync(out, JSON.stringify(result, null, 1));
process.exitCode = result.passed ? 0 : 1;
