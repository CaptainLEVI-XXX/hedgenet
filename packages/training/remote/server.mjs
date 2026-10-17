// Hosted numeric inference only. No coding agent, training or user-supplied code.
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createServingNetwork, loadWeights } from './infer.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
export function createModelServer({ manifest, token, predict }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('MODEL_API_TOKEN is required');
  const expected = Buffer.from(`Bearer ${token}`);
  let windowStart = Date.now(), calls = 0;
  return createServer({ requestTimeout: 20_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && (request.url === '/' || request.url === '/health')) {
      send(200, { service: 'HedgeNet Model', status: 'ready', modelVersion: manifest.modelVersion,
        weightsHash: manifest.weightsHash, architecture: '738 → 32 ReLU → 16',
        qualityPolicy: 'advisory', dataMode: 'synthetic', endpoint: 'POST /infer (Bearer token required)' });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/infer') { send(404, { error: 'not_found' }); return; }
    const actual = Buffer.from(request.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { send(401, { error: 'unauthorized' }); return; }
    if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); calls = 0; }
    if (++calls > 60) { send(429, { error: 'rate_limited' }); return; }
    if (!(request.headers['content-type'] ?? '').startsWith('application/json')) { send(415, { error: 'json_required' }); return; }
    try {
      let body = '', size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) { send(413, { error: 'body_too_large' }); return; }
        body += chunk;
      }
      const req = JSON.parse(body);
      if (req.modelVersion !== manifest.modelVersion || req.weightsHash !== manifest.weightsHash
        || req.contractHash !== manifest.contractHash || req.featureVersion !== 'features-v1'
        || !/^[a-f0-9]{64}$/.test(req.valuationHash) || !/^[a-f0-9]{64}$/.test(req.featuresHash)
        || typeof req.runId !== 'string' || req.runId.length > 128
        || typeof req.budgetUsd !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,11})?$/.test(req.budgetUsd)
        || Number(req.budgetUsd) > 5000 || JSON.stringify(req.legIds) !== JSON.stringify(manifest.legIds)
        || !Array.isArray(req.features) || req.features.length !== 738
        || req.features.some(x => typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 8)
        || sha(JSON.stringify(req.features)) !== req.featuresHash) { send(400, { error: 'invalid_model_input' }); return; }
      const start = performance.now();
      const result = predict(req.features);
      send(200, { schemaVersion: 'serving-response-v1', runId: req.runId, valuationHash: req.valuationHash,
        featuresHash: req.featuresHash, budgetUsd: req.budgetUsd, modelVersion: manifest.modelVersion,
        weightsHash: manifest.weightsHash, contractHash: manifest.contractHash, featureVersion: 'features-v1',
        legIds: manifest.legIds, values: result.values.slice(0, 6), inferenceMs: performance.now() - start, trace: result.trace });
    } catch { send(400, { error: 'invalid_model_input' }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (sha(readFileSync(new URL(name, import.meta.url))) !== hash) throw new Error('Serving artifact integrity mismatch');
  }
  const parameters = loadWeights(new URL('./weights.json', import.meta.url), manifest.weightsHash);
  const predict = await createServingNetwork(parameters);
  const server = createModelServer({ manifest, predict, token: process.env.MODEL_API_TOKEN });
  server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '0.0.0.0', () => console.log('HedgeNet numeric inference ready'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
