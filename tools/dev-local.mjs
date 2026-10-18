// Explicit local inference, never an automatic fallback from hosted serving.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { WEIGHTS_HASH, RUNTIME_HASH, MODEL_VERSION, sha } from '../apps/web/lib/neural.ts';

const root = resolve(import.meta.dirname, '..');
const model = join(root, '.amp/in/web-deploy/model');
// Only run the previously prepared numeric bundle. Never import candidate code.
let manifest;
try { manifest = JSON.parse(readFileSync(join(model, 'manifest.json'), 'utf8')); }
catch { throw new Error('Prepared private model missing. Prepare the verified web bundle with tools/prepare-web-deploy.ts first.'); }
if (manifest.weightsHash !== WEIGHTS_HASH || manifest.modelVersion !== MODEL_VERSION) throw new Error('Unexpected model');
const expected = {
  'weights.json': WEIGHTS_HASH,
  'runtime/numeric-ui-core.ts': RUNTIME_HASH,
  'runtime/LICENSE': '55d5c9c20065b2aa66887036f6741ee5ef12c7a72cd4ad96034889867d436824',
  'server.mjs': sha(readFileSync(join(root, 'packages/training/remote/server.mjs'))),
  'infer.mjs': sha(readFileSync(join(root, 'packages/training/remote/infer.mjs'))),
};
if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(Object.keys(expected).sort())) {
  throw new Error('Unexpected model bundle files');
}
for (const [name, hash] of Object.entries(expected)) {
  if (manifest.files[name] !== hash || sha(readFileSync(join(model, name))) !== hash) {
    throw new Error(`Model integrity mismatch: ${name}. Rebuild the verified web bundle.`);
  }
}

const token = randomBytes(32).toString('hex');
const children = new Set();
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 5000).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
function start(args, env, stdio) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio });
  children.add(child);
  child.on('error', () => stop(1));
  child.on('exit', () => { children.delete(child); if (!stopping) stop(1); });
}
start([join(model, 'server.mjs')], { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: '8080', MODEL_API_TOKEN: token }, 'ignore');
try {
  let ready = false;
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(1000), redirect: 'error' });
      const health = await response.json();
      if (response.ok && health.status === 'ready' && health.weightsHash === WEIGHTS_HASH && health.modelVersion === MODEL_VERSION) {
        ready = true; break;
      }
    } catch { /* Only poll readiness, never retry execution. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready || stopping) throw new Error('Local model failed to start; check prepared artifacts and port 8080.');
  start([join(root, 'node_modules/next/dist/bin/next'), 'dev', 'apps/web', '--hostname', '127.0.0.1', '--port', '3000'], {
    ...process.env, NODE_ENV: 'development', HEDGENET_RUNTIME: 'local',
    HEDGENET_MODEL_URL: 'http://127.0.0.1:8080', HEDGENET_MODEL_TOKEN: token,
    HEDGENET_APP_ROOT: root, HEDGENET_SERVING_DIR: join(root, '.amp/in/serving'),
    HEDGENET_PUBLIC_ORIGIN: '', HEDGENET_PUBLIC_DEMO: 'false', HEDGENET_DEMO_PASSWORD: '',
  }, 'inherit');
  console.log('Verified local model ready. Frontend: http://127.0.0.1:3000 (no CreateOS inference).');
} catch (error) {
  console.error(error.message);
  stop(1);
}
