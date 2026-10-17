// Explicitly authorized deployment of the numeric model service; no Git push.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { repositoryRoot, sha, WEIGHTS_HASH } from '../apps/web/lib/neural.ts';

const root = repositoryRoot();
try { process.loadEnvFile(join(root, '.env')); } catch { /* CLI can also use its own login. */ }
const stateDir = join(root, '.amp/in/serving');
const bundle = join(root, '.amp/in/model-deploy');
const registry = JSON.parse(readFileSync(join(stateDir, 'crypto.json'), 'utf8'));
if (!registry.verified || registry.weightsHash !== WEIGHTS_HASH) throw new Error('Prepare and verify the model in the sandbox first.');
const run = promisify(execFile);
await run('git', ['check-ignore', '-q', '.amp/in/model-deploy/manifest.json'], { cwd: root });
mkdirSync(join(bundle, 'runtime'), { recursive: true, mode: 0o700 });
const files: Record<string, string> = {};
for (const name of ['weights.json', 'infer.mjs', 'runtime/numeric-ui-core.ts', 'runtime/LICENSE']) {
  const source = join(stateDir, name);
  if (sha(readFileSync(source)) !== registry.files[name]) throw new Error(`Source integrity mismatch: ${name}`);
  cpSync(source, join(bundle, name)); files[name] = registry.files[name];
}
for (const name of ['server.mjs', 'Dockerfile']) {
  cpSync(join(root, 'packages/training/remote', name), join(bundle, name));
  files[name] = sha(readFileSync(join(bundle, name)));
}
const manifest = { schemaVersion: 'neural-hosted-v1', modelVersion: registry.modelVersion,
  weightsHash: registry.weightsHash, contractHash: registry.contractHash, legIds: registry.legIds, files };
// Dockerfile is build metadata, not needed at runtime.
delete manifest.files.Dockerfile;
writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'hedgenet-model', private: true, type: 'module' }), { mode: 0o600 });
const tokenPath = join(stateDir, 'model-token.json');
const token = existsSync(tokenPath) ? JSON.parse(readFileSync(tokenPath, 'utf8')).token as string : randomBytes(32).toString('hex');
writeFileSync(tokenPath, JSON.stringify({ token }), { mode: 0o600 });
writeFileSync(join(stateDir, '.env.model'), `MODEL_API_TOKEN=${token}\n`, { mode: 0o600 });
async function cli(label: string, args: string[], timeout = 90_000) {
  console.log(label);
  try {
    const result = await run('createos', ['--output', 'json', ...args], { cwd: bundle, timeout, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout;
  } catch { throw new Error(`${label} failed. Inspect current CreateOS state before retrying; no automatic retry or upgrade.`); }
}
const uniqueName = 'hedgenet-model';
const list = async () => JSON.parse(await cli('Checking projects', ['projects', 'list'])) ?? [];
let project = (await list()).find((p: { uniqueName: string }) => p.uniqueName === uniqueName);
if (!project) {
  const marker = join(stateDir, 'project-creation-attempted');
  if (existsSync(marker)) throw new Error('Previous project-create outcome requires inspection; not creating twice.');
  writeFileSync(marker, new Date().toISOString());
  await cli('Creating HedgeNet Model', ['projects', 'add', '--name', 'HedgeNet Model', '--unique-name', uniqueName,
    '--type', 'upload', '--runtime', 'dockerfile', '--port', '8080', '--directory-path', '.']);
  project = (await list()).find((p: { uniqueName: string }) => p.uniqueName === uniqueName);
}
if (!project?.id || project.type !== 'upload') throw new Error('Expected upload project unavailable.');
const projectId = project.id as string;
writeFileSync(join(stateDir, 'deployment-state.json'), JSON.stringify({ projectId, uniqueName }, null, 2));
let environments = JSON.parse(await cli('Checking environments', ['environments', 'list', '--project', projectId])) ?? [];
if (!environments.length) {
  await cli('Creating production environment', ['environments', 'create', '--project', projectId,
    '--name', 'Production', '--unique-name', 'production', '--auto-promote']);
  environments = JSON.parse(await cli('Checking environments', ['environments', 'list', '--project', projectId]));
}
const environment = environments.find((e: { uniqueName: string }) => e.uniqueName === 'production') ?? (environments.length === 1 ? environments[0] : null);
if (!environment?.id) throw new Error('Ambiguous environment selection.');
// The secret file lives outside the uploaded directory. CLI restricts relative paths,
// so run this one operation from the repository root and suppress its value-bearing output.
if (environment.settings?.runEnvs?.MODEL_API_TOKEN !== token) {
  console.log('Setting private model API token');
  try { await run('createos', ['env', 'push', '--project', projectId, '--environment', environment.id,
    '--file', '.amp/in/serving/.env.model', '--force'], { cwd: root, timeout: 90_000, maxBuffer: 1024 * 1024 }); }
  catch { throw new Error('Could not configure the model API token.'); }
}
if (!process.argv.includes('--verify-existing')) {
  await cli('Uploading and building model service (up to ten minutes)', ['deploy', '--project', projectId, '--dir', bundle], 660_000);
}
const deployments = JSON.parse(await cli('Checking deployment', ['deployments', 'list', '--project', projectId]));
const deployment = deployments.find((d: { status: string }) => ['successful', 'running', 'active', 'deployed'].includes(d.status));
if (!deployment?.id) throw new Error('No successful deployment; inspect build logs.');
// Upload deployment URLs do not inherit environment secrets. Assign this exact
// deployment to the token-bearing environment before checking its stable URL.
if (environment.projectDeploymentId !== deployment.id) {
  await cli('Assigning model to production environment', ['deployments', 'promote', '--project', projectId,
    '--deployment', deployment.id, '--environment', environment.id]);
}
let url = '';
for (let i = 0; i < 15; i++) {
  const currentEnvironments = JSON.parse(await cli('Reading environment endpoint', ['environments', 'list', '--project', projectId]));
  const current = currentEnvironments.find((e: { id: string }) => e.id === environment.id);
  if (current?.projectDeploymentId === deployment.id && current.extra?.endpoint) { url = String(current.extra.endpoint); break; }
  await new Promise(resolve => setTimeout(resolve, 4000));
}
if (!url.startsWith('https://')) throw new Error('No HTTPS endpoint returned.');
let healthy = false;
for (let i = 0; i < 30; i++) {
  try {
    const health = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(10_000) });
    if (health.ok && (await health.json()).weightsHash === WEIGHTS_HASH) { healthy = true; break; }
  } catch { /* Only read-only readiness probes retry; no repeated deploy. */ }
  await new Promise(resolve => setTimeout(resolve, 4000));
}
if (!healthy) throw new Error('Hosted model health/hash check failed.');
const unauthenticated = await fetch(new URL('/infer', url), { method: 'POST', body: '{}', signal: AbortSignal.timeout(20_000) });
if (unauthenticated.status !== 401) throw new Error('Hosted authentication check failed.');
writeFileSync(join(stateDir, 'hosted.json'), JSON.stringify({ url, token, projectId, deploymentId: deployment.id,
  environmentId: environment.id, weightsHash: WEIGHTS_HASH, modelVersion: registry.modelVersion }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ status: 'deployed', projectId, deploymentId: deployment.id, url, authentication: 'verified', weightsHash: WEIGHTS_HASH }));
