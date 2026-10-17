// Copy current working-tree source, never Git snapshots or credential storage.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const output = join(root, '.amp/in/web-deploy');
// Check exclusion before writing; no environment files are ever opened.
const exclude = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root, encoding: 'utf8' }).trim();
if (!readFileSync(resolve(root, exclude), 'utf8').split(/\r?\n/).includes('/.amp/in/')) {
  throw new Error('Add /.amp/in/ to the repository-local info/exclude first.');
}
if (existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error('Bundle output must not be a symlink');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true, mode: 0o700 });
const manifest: { path: string; bytes: number; sha256: string }[] = [];
function copy(source: string, target = source) {
  const path = join(root, source);
  if (!lstatSync(path).isFile()) throw new Error(`Expected regular allowlisted file: ${source}`);
  const dest = join(output, target);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(path, dest);
  manifest.push({ path: target, bytes: statSync(dest).size, sha256: createHash('sha256').update(readFileSync(dest)).digest('hex') });
}
function sourceTree(directory: string, extensions: RegExp) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Symlink rejected: ${path}`);
    if (entry.isDirectory()) sourceTree(path, extensions);
    else if (extensions.test(entry.name)) copy(path);
  }
}
for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json',
  'apps/web/package.json', 'apps/web/tsconfig.json', 'apps/web/next-env.d.ts', 'apps/web/next.config.ts']) copy(file);
for (const dir of ['apps/web/app', 'apps/web/components', 'apps/web/lib']) sourceTree(dir, /\.(tsx?|css)$/);
if (existsSync(join(root, 'apps/web/proxy.ts'))) copy('apps/web/proxy.ts');
for (const pkg of ['core', 'intake', 'venue']) {
  copy(`packages/${pkg}/package.json`);
  sourceTree(`packages/${pkg}/src`, /\.ts$/);
}
// Only the trusted deterministic fixture builder and wrapper, no controller,
// candidate, recorded training examples, sessions, or private deployment state.
copy('packages/training/src/dataset.ts');
copy('packages/training/remote/infer.mjs');
// Explicit private numeric runtime allowlist. Never copy candidate or CLI state.
const modelManifest = JSON.parse(readFileSync(join(root, '.amp/in/model-deploy/manifest.json'), 'utf8'));
if (modelManifest.weightsHash !== '3c02cebca2e29a3b66083ac7494a89aa71173bdcc47709a47a3793add1a867a0'
  || modelManifest.files['runtime/numeric-ui-core.ts'] !== '75da2a13f39720e34b1e440533460435ead0af9a88fccad8c94e94a816dafa21'
  || modelManifest.files['runtime/LICENSE'] !== '55d5c9c20065b2aa66887036f6741ee5ef12c7a72cd4ad96034889867d436824') {
  throw new Error('Unexpected pinned model runtime');
}
const modelFiles: Record<string, string> = {};
for (const name of ['server.mjs', 'infer.mjs', 'runtime/numeric-ui-core.ts', 'runtime/LICENSE', 'weights.json']) {
  const source = ['server.mjs', 'infer.mjs'].includes(name) ? `packages/training/remote/${name}` : `.amp/in/model-deploy/${name}`;
  const hash = createHash('sha256').update(readFileSync(join(root, source))).digest('hex');
  if (name !== 'server.mjs' && hash !== modelManifest.files[name]) throw new Error(`Model integrity mismatch: ${name}`);
  copy(source, `model/${name}`);
  modelFiles[name] = hash;
}
writeFileSync(join(output, 'model/manifest.json'), JSON.stringify({ ...modelManifest, files: modelFiles }) + '\n', { mode: 0o600 });
manifest.push({ path: 'model/manifest.json', bytes: statSync(join(output, 'model/manifest.json')).size,
  sha256: createHash('sha256').update(readFileSync(join(output, 'model/manifest.json'))).digest('hex') });
copy('deploy/web/start-sandbox.mjs', 'deploy/web/start-sandbox.mjs');
for (const name of ['crypto.json', 'weights.json']) copy(`.amp/in/serving/${name}`, `data/serving/${name}`);
copy('.amp/in/catalogue/catalogue.json.gz', 'data/catalogue/catalogue.json.gz');
copy('deploy/web/Dockerfile', 'Dockerfile');
writeFileSync(join(output, '.dockerignore'), 'node_modules\n**/node_modules\n**/.next\n.git\n.env*\n**/.env*\n');
writeFileSync(join(output, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output, files: manifest.length, bytes: manifest.reduce((n, file) => n + file.bytes, 0) }));
