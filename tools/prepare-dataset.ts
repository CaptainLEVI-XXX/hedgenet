import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { buildSyntheticDataset, labelExample } from '../packages/training/src/dataset.ts';
import type { LabeledExample, Universe } from '../packages/training/src/dataset.ts';

if (!isMainThread) {
  const { universe, development } = workerData as { universe: Universe; development: boolean };
  const plan = buildSyntheticDataset(universe, development);
  for (const example of plan.examples) {
    try { parentPort!.postMessage({ status: 'labeled', row: await labelExample(example) }); }
    catch (error) { parentPort!.postMessage({ status: 'rejected', id: example.id,
      reason: error instanceof Error ? error.message : 'Unknown teacher error' }); }
  }
} else {
  const universe = process.argv[2];
  if (!['crypto', 'weather'].includes(universe ?? '') || process.argv.length > 4
    || (process.argv[3] !== undefined && process.argv[3] !== '--development')) {
    throw new Error('Usage: node tools/prepare-dataset.ts crypto|weather [--development]');
  }
  const development = process.argv[3] === '--development';
  const root = process.cwd();
  execFileSync('git', ['check-ignore', '-q', '.amp/in/artifacts/datasets/probe'], { cwd: root });
  const plan = buildSyntheticDataset(universe as Universe, development);
  const { examples: _, ...manifest } = plan;
  const directory = resolve('.amp/in/artifacts/datasets', `${universe}-${development ? 'dev-' : ''}${Date.now()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  save('manifest.json', { ...manifest, sources: Object.fromEntries([
    'tools/prepare-dataset.ts', 'packages/training/src/dataset.ts', 'packages/core/src/teacher.ts',
    'packages/core/src/valuation.ts', 'packages/core/src/scenarios.ts', 'packages/core/src/features.ts', 'pnpm-lock.yaml',
  ].map(path => [path, sha(readFileSync(path))])), node: process.version });
  const rows: LabeledExample[] = [];
  let rejected = 0, timedOut = false;
  const started = performance.now();
  const worker = new Worker(new URL(import.meta.url), { workerData: { universe, development },
    resourceLimits: { maxOldGenerationSizeMb: 256 } });
  const deadline = setTimeout(() => { timedOut = true; void worker.terminate(); }, 15 * 60_000);
  worker.on('message', (message: { status: string; row?: LabeledExample; id?: string; reason?: string }) => {
    appendFileSync(join(directory, 'attempts.jsonl'), JSON.stringify(message) + '\n', { mode: 0o600 });
    if (message.status === 'labeled') rows.push(message.row!); else rejected++;
  });
  let failure: string | null = null;
  const exit = await new Promise<number>(resolveExit => {
    worker.once('error', error => { failure = error.message; });
    worker.once('exit', resolveExit);
  });
  clearTimeout(deadline);
  const complete = exit === 0 && !timedOut && !failure && rejected === 0 && rows.length === plan.examples.length;
  if (complete) {
    // Only these explicit files are eligible for builder upload. Test labels and
    // complete valuation problems stay in the host-only directory, never this bundle.
    mkdirSync(join(directory, 'builder'), { mode: 0o700 });
    for (const split of development ? ['development'] as const : ['train', 'validation'] as const) {
      save(`builder/${split}.json`, rows.filter(row => row.split === split).map(row => ({
        id: row.id, features: row.features.values, targets: row.targets, mask: row.mask,
      })));
    }
    save('host-only.json', rows);
  }
  save('result.json', { status: complete ? 'prepared' : 'incomplete', acceptance: 'not_evaluated',
    attempted: rows.length + rejected, labeled: rows.length, rejected, timedOut, failure, exit,
    elapsedMs: performance.now() - started, datasetHash: plan.contentHash,
    labelsHash: sha(JSON.stringify(rows)), dataMode: 'synthetic' });
  console.log(JSON.stringify({ directory, status: complete ? 'prepared' : 'incomplete', labeled: rows.length, rejected }));
  if (!complete) process.exitCode = 1;
}
