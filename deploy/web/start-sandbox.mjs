// Build first. Invoke with node --env-file=/external/private.env this-file.mjs.
// No credentials are read from the bundle, printed, or passed on command lines.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const token = process.env.HEDGENET_MODEL_TOKEN;
if (!token || token.length < 32) throw new Error('HEDGENET_MODEL_TOKEN is required');
const origin = new URL(process.env.HEDGENET_PUBLIC_ORIGIN ?? '');
if (origin.protocol !== 'https:' || origin.origin !== process.env.HEDGENET_PUBLIC_ORIGIN) {
  throw new Error('HEDGENET_PUBLIC_ORIGIN must be a stable HTTPS origin');
}
const manifest = JSON.parse(readFileSync(join(root, 'model/manifest.json'), 'utf8'));
const pinnedHash = '3c02cebca2e29a3b66083ac7494a89aa71173bdcc47709a47a3793add1a867a0';
if (manifest.weightsHash !== pinnedHash) throw new Error('Unexpected model weights');
for (const name of ['server.mjs', 'infer.mjs', 'runtime/numeric-ui-core.ts', 'runtime/LICENSE', 'weights.json']) {
  if (createHash('sha256').update(readFileSync(join(root, 'model', name))).digest('hex') !== manifest.files[name]) {
    throw new Error('Model artifact integrity mismatch');
  }
}
const children = new Set();
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  const timer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 5000);
  timer.unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
function start(args, env) {
  // Child output is deliberately suppressed: never echo runtime environment.
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'ignore' });
  children.add(child);
  child.on('error', () => stop(1));
  child.on('exit', () => { children.delete(child); if (!stopping) stop(1); });
  return child;
}
// Model gets no application/venue credentials, only its internal bearer token.
start([join(root, 'model/server.mjs')], { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: '8080', MODEL_API_TOKEN: token });
try {
  let ready = false;
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(1000), redirect: 'error' });
      const health = await response.json();
      if (response.ok && health.status === 'ready' && health.weightsHash === pinnedHash && health.modelVersion === manifest.modelVersion) {
        ready = true; break;
      }
    } catch { /* Read-only readiness polling; never restart children. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready || stopping) throw new Error('Model not ready');
  start([join(root, 'apps/web/node_modules/next/dist/bin/next'), 'start', 'apps/web', '--hostname', '0.0.0.0', '--port', '3000'], {
    ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    HEDGENET_RUNTIME: 'sandbox', HEDGENET_MODEL_URL: 'http://127.0.0.1:8080',
    HEDGENET_APP_ROOT: root, HEDGENET_SERVING_DIR: join(root, 'data/serving'), HEDGENET_CATALOGUE_DIR: join(root, 'data/catalogue'),
  });
  console.log('HedgeNet model ready; web process started');
} catch {
  console.error('HedgeNet sandbox startup failed');
  stop(1);
}
