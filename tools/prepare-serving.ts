// Explicit operator action only. Does not create a sandbox, install packages,
// open ingress, or run downloaded candidate code on this host.
// node tools/prepare-serving.ts <checkpoint.json> [existing-sandbox-id]
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assembleNeuralProblem, MODEL_HASH, MODEL_VERSION, repositoryRoot, RUNTIME_HASH,
  servingCli, sha, WEIGHTS_HASH, withServingLock } from '../apps/web/lib/neural.ts';

const root = repositoryRoot();
const checkpoint = resolve(process.argv[2] ?? '');
const sandbox = process.argv[3] ?? process.env.HEDGENET_SANDBOX_ID ?? '';
if (!process.argv[2] || !/^sb-[A-Za-z0-9_-]+$/.test(sandbox)) {
  throw new Error('Usage: node tools/prepare-serving.ts <checkpoint.json> [existing-sandbox-id]; or set HEDGENET_SANDBOX_ID');
}
// Require repository-local exclusion, not merely a global gitignore rule.
const exclude = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root, encoding: 'utf8' }).trim();
if (!readFileSync(resolve(root, exclude), 'utf8').split(/\r?\n/).includes('/.amp/in/')) throw new Error('Add /.amp/in/ to the repository-local git info/exclude before preparation.');
const dir = join(root, '.amp/in/serving');
const attempt = dirname(dirname(checkpoint));
const model = join(attempt, 'candidate/model.ts');
const runtime = join(root, '.amp/in/references/handwired/src/runtime/numeric-ui-core.ts');
const license = join(root, '.amp/in/references/handwired/LICENSE');
const infer = join(root, 'packages/training/remote/infer.mjs');
const weightsBytes = readFileSync(checkpoint);
const cp = JSON.parse(weightsBytes.toString());
if (sha(weightsBytes) !== WEIGHTS_HASH || cp.schemaVersion !== 'hedgenet-checkpoint-v1' || cp.hidden !== 32
  || cp.parameterCount !== 24176 || cp.parameters?.length !== 24176
  || cp.parameters.some((x: unknown) => typeof x !== 'number' || !Number.isFinite(x))) throw new Error('Checkpoint differs from approved training artifact.');
if (sha(readFileSync(model)) !== MODEL_HASH || sha(readFileSync(runtime)) !== RUNTIME_HASH) throw new Error('Original model or pinned runtime hash mismatch.');
const mechanics = JSON.parse(readFileSync(join(attempt, 'mechanics.json'), 'utf8'));
if (mechanics.passed !== true) throw new Error('Training mechanics did not pass.');
const codeManifest = readFileSync(join(attempt, 'code-sha256.txt'), 'utf8');
if (!codeManifest.includes(`${MODEL_HASH}  ./model.ts`)) throw new Error('Candidate source provenance mismatch.');
const specimen = assembleNeuralProblem({ units: '0.2', referencePriceUsd: '70000', budgetUsd: '1000', revision: 0, confirmedSynthetic: true });
const warnings = ['Statistical quality gates are temporarily advisory by user approval.',
  'This checkpoint missed validation quality thresholds; held-out quality is not established.',
  'Fictional synthetic $60k/$80k markets and first training-group books; not live trading advice.'];
const files: Record<string, string> = {
  'weights.json': WEIGHTS_HASH, 'infer.mjs': sha(readFileSync(infer)),
  'runtime/LICENSE': sha(readFileSync(license)),
  'runtime/numeric-ui-core.ts': RUNTIME_HASH, 'candidate/model.ts': MODEL_HASH,
};
const remoteDir = `/root/hedgenet-serving/${sha(JSON.stringify(files)).slice(0, 16)}`;
const manifest = { schemaVersion: 'neural-serving-v1', sandboxId: sandbox, remoteDir, modelVersion: MODEL_VERSION,
  weightsHash: WEIGHTS_HASH, featureVersion: 'features-v1', contractHash: specimen.features.contractHash,
  legIds: specimen.features.legIds, qualityPolicy: 'advisory', qualityWarnings: warnings, files };
let operation = 'preflight';
const cli = (args: string[], json = true, ms = 45_000) => {
  operation = args.slice(0, 2).join(' ');
  console.log(`Serving setup: ${operation}`);
  return servingCli(root, args, json, ms);
};
const remote = (command: string, ms = 45_000) => cli(['sandbox', 'exec', sandbox, '--', 'bash', '-c', command], false, ms);
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (interrupted) return;
  interrupted = true;
  // The same cleanup is also in finally. No remote start is retried.
  void cli(['sandbox', 'pause', sandbox]).finally(() => process.exit(130));
});

try {
  await withServingLock(root, async () => {
    let verified = false;
    try {
      const info = JSON.parse(await cli(['sandbox', 'get', sandbox]));
      if (info.ingress_enabled !== false || !['paused', 'running'].includes(info.status)) throw new Error('Existing sandbox must have ingress disabled.');
      if (info.status === 'paused') await cli(['sandbox', 'resume', sandbox], true, 90_000);
      // Termination, not merely an empty managed-process list: also inspect OS processes.
      const processes = await remote('pgrep -af "[c]odex|[t]rain\\.ts" || true');
      if (processes.trim()) throw new Error('Agent or trainer processes remain alive. Stop them before serving preparation.');
      await remote('if command -v codex >/dev/null; then codex logout >/dev/null 2>&1; fi; test ! -e "$HOME/.codex/auth.json"');
      const node = (await remote('node --version')).trim();
      if (!/^v(?:2[4-9]|[3-9]\d)\./.test(node)) throw new Error('Sandbox Node >=24 is required.');
      mkdirSync(join(dir, 'runtime'), { recursive: true, mode: 0o700 });
      mkdirSync(join(dir, 'candidate'), { recursive: true, mode: 0o700 });
      cpSync(checkpoint, join(dir, 'weights.json'));
      cpSync(model, join(dir, 'candidate/model.ts'));
      cpSync(runtime, join(dir, 'runtime/numeric-ui-core.ts'));
      cpSync(license, join(dir, 'runtime/LICENSE'));
      cpSync(infer, join(dir, 'infer.mjs'));
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
      const probes = [specimen.features.values,
        ...[['0.1', '35000', '0'], ['5', '105000', '5000'], ['1', '80000', '300']].map(([units, referencePriceUsd, budgetUsd]) =>
          assembleNeuralProblem({ units, referencePriceUsd, budgetUsd, revision: 0, confirmedSynthetic: true }).features.values)];
      writeFileSync(join(dir, 'probes.json'), JSON.stringify(probes), { mode: 0o600 });
      await remote(`mkdir -p ${remoteDir}/runtime ${remoteDir}/candidate`);
      for (const name of [...Object.keys(files), 'manifest.json', 'probes.json']) {
        await cli(['sandbox', 'push', sandbox, join(dir, name), `${remoteDir}/${name}`], false, 90_000);
      }
      const sums = await remote(`cd ${remoteDir} && sha256sum weights.json infer.mjs runtime/numeric-ui-core.ts runtime/LICENSE candidate/model.ts manifest.json probes.json`);
      for (const name of [...Object.keys(files), 'manifest.json', 'probes.json']) {
        if (!sums.includes(`${sha(readFileSync(join(dir, name)))}  ${name}`)) throw new Error(`Uploaded file hash mismatch: ${name}`);
      }
      const compare = JSON.parse(await remote(`cd ${remoteDir} && timeout --signal=TERM --kill-after=2s 60s node infer.mjs --verify`, 75_000));
      if (compare.verified !== true || compare.probes !== probes.length) throw new Error('Original model comparison was not verified.');
      const after = await remote('pgrep -af "[ /][c]odex( |$)|[ /][t]rain\\.ts( |$)" || true; test ! -e "$HOME/.codex/auth.json"');
      if (after.trim()) throw new Error('Agent/trainer/session isolation failed.');
      await remote(`chmod -R a-w ${remoteDir}`);
      writeFileSync(join(dir, 'verification.json'), JSON.stringify({ ...compare, node, checkedAt: new Date().toISOString(), files, sessionRemoved: true, processesAbsent: true }, null, 2), { mode: 0o600 });
      verified = true;
    } catch {
      console.error(`Preparation stopped during ${operation}.`);
      throw new Error('Preparation failed');
    } finally {
      await cli(['sandbox', 'pause', sandbox]);
      const state = JSON.parse(await cli(['sandbox', 'get', sandbox]));
      if (state.status !== 'paused') throw new Error('Sandbox pause could not be verified. Registry not published.');
    }
    if (!verified || interrupted) throw new Error('Preparation interrupted.');
    writeFileSync(join(dir, 'crypto.pending.json'), JSON.stringify({ ...manifest, verified: true }, null, 2), { mode: 0o600 });
    renameSync(join(dir, 'crypto.pending.json'), join(dir, 'crypto.json'));
  });
  console.log('Neural serving prepared and sandbox paused. Registry: .amp/in/serving/crypto.json');
} catch {
  // Deliberately omit CLI/candidate output: it can contain subscription secrets.
  console.error('Neural serving preparation failed; no new registry published. Check artifact hashes, sandbox state, and absence of agent/trainer processes.');
  process.exitCode = 1;
}
