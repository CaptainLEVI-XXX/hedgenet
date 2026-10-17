// Trusted host controller for the bounded Codex-in-CreateOS training experiment.
// It never executes candidate code locally: candidate files and checkpoints are
// downloaded only as data, schema-checked, and scored with the trusted evaluator.
// Usage: node tools/run-training.ts <crypto|weather> <mainDatasetDir> <developmentDatasetDir>
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { LabeledExample } from '../packages/training/src/dataset.ts';
import { candidateStatus, CheckpointSelector, compareFinancial, EXPERIMENT_LIMITS as L, evaluateFinancially, parseAttemptConfig,
  parseCheckpoint, parsePredictionRows, sanitizeLog, sha256, managedProcessId } from '../packages/training/src/controller.ts';
import type { AttemptConfig, FinancialMetrics, RemoteChecks } from '../packages/training/src/controller.ts';

const SANDBOX = process.env.HEDGENET_SANDBOX_ID ?? '';
if (!/^sb-[A-Za-z0-9_-]+$/.test(SANDBOX)) throw new Error('Set HEDGENET_SANDBOX_ID to your existing builder sandbox ID');
const ORIGINAL_EGRESS = ['registry.npmjs.org:443', 'auth.openai.com:443'];
const CODEX_EGRESS = [...ORIGINAL_EGRESS, 'chatgpt.com:443'];
const HANDWIRED = { revision: '257856e3b221140acb4cc4460626b850c0bd4ff1', dir: '.amp/in/references/handwired',
  runtimeSha: '75da2a13f39720e34b1e440533460435ead0af9a88fccad8c94e94a816dafa21' };
const BASELINE: AttemptConfig = { hidden: 32, learningRate: 0.001, maxEpochs: 120 };

const [universe, mainDir, devDir, resumeFlag, resumeId] = process.argv.slice(2);
if (resumeFlag !== undefined && (resumeFlag !== '--resume' || !/^training-(crypto|weather)-\d+$/.test(resumeId ?? ''))) throw new Error('bad --resume');
if (!['crypto', 'weather'].includes(universe ?? '') || !mainDir || !devDir) {
  throw new Error('Usage: node tools/run-training.ts crypto|weather <mainDatasetDir> <developmentDatasetDir>');
}
const root = process.cwd();
execFileSync('git', ['check-ignore', '-q', '.amp/in/artifacts/training-probe'], { cwd: root });
const runId = `training-${universe}-${Date.now()}`;
const runDir = resolve('.amp/in/artifacts', runId);
mkdirSync(runDir, { recursive: true, mode: 0o700 });
const t0 = Date.now();
const iso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const save = (name: string, value: unknown) => {
  mkdirSync(join(runDir, name, '..'), { recursive: true });
  writeFileSync(join(runDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 1) + '\n', { mode: 0o600 });
};
const event = (name: string, data: Record<string, unknown> = {}) => {
  const line = { at: iso(), elapsedMs: Date.now() - t0, event: name, ...data };
  appendFileSync(join(runDir, 'events.jsonl'), JSON.stringify(line) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(line).slice(0, 400));
};
class Blocker extends Error {}

// ---------- createos CLI wrappers (credentials come from the local .env via the CLI; never printed) ----------
function cos(args: string[], { json = true, timeoutMs = 90_000, input }: { json?: boolean; timeoutMs?: number; input?: string } = {}) {
  const r = spawnSync('createos', [...(json ? ['--output', 'json'] : []), ...args], { cwd: root, encoding: 'utf8',
    timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, input: input ?? '', stdio: ['pipe', 'pipe', 'pipe'] });
  appendFileSync(join(runDir, 'calls.jsonl'), JSON.stringify({ at: iso(), args: args.slice(0, 6), code: r.status,
    signal: r.signal, stderr: sanitizeLog(r.stderr ?? '', 600) }) + '\n');
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const jsonOf = (text: string) => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; } };
function field(obj: unknown, name: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  if (name in (obj as object)) return (obj as Record<string, unknown>)[name];
  for (const v of Object.values(obj as object)) { const f = field(v, name); if (f !== undefined) return f; }
  return undefined;
}
function sandboxGet() {
  const r = cos(['sandbox', 'get', SANDBOX]);
  const j = jsonOf(r.stdout);
  if (r.code !== 0 || !j) throw new Blocker(`sandbox get failed: ${sanitizeLog(r.stderr, 300)}`);
  return { status: j.status as string, egress: (j.egress as string[]) ?? [], ingress: j.ingress_enabled as boolean };
}
function exec(command: string, timeoutMs = 90_000) {
  return cos(['sandbox', 'exec', SANDBOX, '--', 'bash', '-c', command], { json: false, timeoutMs });
}
function mustExec(command: string, timeoutMs = 90_000) {
  const r = exec(command, timeoutMs);
  if (r.code !== 0) throw new Error(`remote command failed (${r.code}): ${sanitizeLog(r.stderr + r.stdout, 500)}`);
  return r.stdout;
}
function push(local: string, remote: string) {
  const r = cos(['sandbox', 'push', SANDBOX, local, remote], { json: false, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`push failed for ${remote}: ${sanitizeLog(r.stderr, 300)}`);
}
function pullText(remote: string, limit = 8 * 1024 * 1024) {
  const r = cos(['sandbox', 'pull', SANDBOX, remote, '-'], { json: false, timeoutMs: 120_000 });
  if (r.code !== 0) return null;
  return r.stdout.length > limit ? r.stdout.slice(0, limit) : r.stdout;
}

const running = new Set<string>();
function startProcess(tag: string, command: string, cwd: string) {
  // The unique tag is part of the command so a lost start response can be found by listing.
  const full = `: ${tag}; ${command}`;
  const r = cos(['sandbox', 'process', 'start', '--cwd', cwd, SANDBOX, '--', 'bash', '-c', full]);
  // IDs may contain '-' or '_' (observed: proc_…-5Fg). Prefer the JSON field over pattern matching.
  const parsedId = managedProcessId(jsonOf(r.stdout));
  const id = parsedId
    ?? (r.stdout.match(/proc_[A-Za-z0-9_-]+/) ?? [])[0];
  appendFileSync(join(runDir, 'processes.jsonl'), JSON.stringify({ at: iso(), tag, id: id ?? null, code: r.code,
    raw: sanitizeLog(r.stdout, 800) }) + '\n');
  if (id) { running.add(id); return id; }
  const list = cos(['sandbox', 'process', 'list', SANDBOX]);
  const lines = list.stdout.split('\n').filter(x => x.includes(tag));
  const found = (lines.join(' ').match(/proc_[A-Za-z0-9_-]+/) ?? [])[0];
  appendFileSync(join(runDir, 'processes.jsonl'), JSON.stringify({ at: iso(), tag, recoveredId: found ?? null }) + '\n');
  if (found) { running.add(found); return found; }
  throw new Blocker(`process start for ${tag} returned no ID and none was found by listing; quarantined`);
}
function processInfo(id: string) {
  const r = cos(['sandbox', 'process', 'get', SANDBOX, id]);
  const j = jsonOf(r.stdout);
  return { ok: r.code === 0 && j !== null, tree: field(j, 'tree_exited') === true, leader: field(j, 'leader_exited') === true,
    exitCode: field(j, 'exit_code') as number | null | undefined, status: field(j, 'status') as string | undefined };
}
async function waitTree(id: string, deadline: number, onTick?: () => Promise<boolean | void>) {
  let timedOut = false;
  while (true) {
    const info = processInfo(id);
    if (info.tree) { running.delete(id); return { ...info, timedOut }; }
    if (Date.now() > deadline) { timedOut = true; break; }
    if (onTick && (await onTick()) === true) break;
    await sleep(2_000);
  }
  return { ...(await stopTree(id)), timedOut };
}
async function stopTree(id: string) {
  cos(['sandbox', 'process', 'stop', '--force', '--grace', '2s', SANDBOX, id]);
  for (let i = 0; i < 20; i++) {
    const info = processInfo(id);
    if (info.tree) { running.delete(id); event('process_stopped', { id, ...info }); return info; }
    await sleep(1_500);
  }
  throw new Blocker(`could not confirm process-tree termination for ${id}; quarantine sandbox`);
}

// ---------- trusted local inputs ----------
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const fileSha = (path: string) => sha256(readFileSync(path));
for (const dir of [mainDir, devDir]) if (readJson(join(dir, 'result.json')).status !== 'prepared') throw new Error(`${dir} not prepared`);
const host: LabeledExample[] = readJson(join(mainDir, 'host-only.json'));
const validationRows = host.filter(r => r.split === 'validation');
const testRows = host.filter(r => r.split === 'test');
const builderFiles = { train: join(mainDir, 'builder/train.json'), validation: join(mainDir, 'builder/validation.json'),
  development: join(devDir, 'builder/development.json') };
const builderValidationIds = (readJson(builderFiles.validation) as { id: string }[]).map(r => r.id);
if (JSON.stringify(builderValidationIds) !== JSON.stringify(validationRows.map(r => r.id))) throw new Error('Validation order mismatch');
const runtimePath = join(HANDWIRED.dir, 'src/runtime/numeric-ui-core.ts');
const revision = execFileSync('git', ['-C', HANDWIRED.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (revision !== HANDWIRED.revision || fileSha(runtimePath) !== HANDWIRED.runtimeSha) throw new Error('Handwired pin mismatch');
const inputs = { universe, mainDir, devDir, handwired: { ...HANDWIRED, licenseSha: fileSha(join(HANDWIRED.dir, 'LICENSE')) },
  hashes: Object.fromEntries(Object.entries(builderFiles).map(([k, p]) => [k, fileSha(p)])),
  hostOnlySha: fileSha(join(mainDir, 'host-only.json')), datasetResult: readJson(join(mainDir, 'result.json')),
  controllerSha: fileSha('tools/run-training.ts'), controllerLibSha: fileSha('packages/training/src/controller.ts'),
  harnessSha: fileSha('packages/training/remote/harness-check.mjs'), datasetLibSha: fileSha('packages/training/src/dataset.ts'),
  limits: L, baseline: BASELINE, node: process.version, sandbox: SANDBOX };
save('inputs.json', inputs);

// ---------- run ----------
type Attempt = { n: number; config: AttemptConfig | null; codex: Record<string, unknown>; codeHashes: string | null;
  mechanics: Record<string, unknown> | null; selector: CheckpointSelector | null; best: { epoch: number; metrics: FinancialMetrics;
  remotePath: string; sha: string } | null; trainingMs: number; withinBudget: boolean; failure: string | null; candidate: string };
const attempts: Attempt[] = [];
const summary: Record<string, unknown> = { runId, startedAt: iso(), acceptance: 'not_evaluated', promoted: false,
  costs: { computeCreditsUsd: 'unknown', subscriptionUsage: 'unknown (token counts below are Codex-reported)' } };
let WORK = '', NODE = 'node', experimentStart = 0, loggedOut = false;
const pad = (e: number) => String(e).padStart(4, '0');

async function runCodex(tag: string, promptLocal: string, cwd: string, dir: string, timeoutSec: number) {
  const promptRemote = `${dir}/prompt.md`;
  push(promptLocal, promptRemote);
  const command = `mkdir -p ${cwd} ${dir} && cd ${cwd} && timeout --signal=TERM --kill-after=10s ${timeoutSec}s codex exec --json`
    + ` --color never --skip-git-repo-check --ephemeral --dangerously-bypass-approvals-and-sandbox -C ${cwd}`
    + ` -o ${dir}/last-message.txt - < ${promptRemote} > ${dir}/codex-events.jsonl 2> ${dir}/codex-stderr.log; echo $? > ${dir}/codex-exit`;
  const started = Date.now();
  const id = startProcess(tag, command, cwd);
  event('codex_started', { tag, id, timeoutSec });
  const done = await waitTree(id, started + (timeoutSec + 25) * 1000);
  const elapsedMs = Date.now() - started;
  const events = sanitizeLog(pullText(`${dir}/codex-events.jsonl`) ?? '', 2 * 1024 * 1024);
  const stderr = sanitizeLog(pullText(`${dir}/codex-stderr.log`) ?? '', 64 * 1024);
  const last = sanitizeLog(pullText(`${dir}/last-message.txt`) ?? '', 16 * 1024);
  const exit = (pullText(`${dir}/codex-exit`) ?? '').trim();
  const local = tag.replace(/[^a-z0-9-]/gi, '_');
  save(`${local}/codex-events.jsonl`, events); save(`${local}/codex-stderr.log`, stderr); save(`${local}/last-message.txt`, last);
  const usage = events.split('\n').map(jsonOf).filter(e => e && String(e.type).includes('turn.completed')).map(e => e!.usage);
  const commands = events.split('\n').map(jsonOf).filter(e => e && JSON.stringify(e).includes('command_execution')).length;
  const blocked = /usage limit|rate limit|quota|unauthorized|401|403|not logged in|login required|insufficient/i.test(stderr + last)
    && !/turn\.completed/.test(events);
  const result = { tag, processId: id, exit, treeExited: done.tree, timedOut: done.timedOut, codexMs: elapsedMs, usage,
    commandEvents: commands, eventsBytes: events.length, blocked };
  event('codex_finished', result);
  return result;
}

async function remoteHashes(cand: string) {
  return mustExec(`cd ${cand} && find . -path ./scratch -prune -o -type f -print | sort | xargs -r sha256sum`);
}
function pullCandidate(cand: string, local: string, manifest: string) {
  for (const line of manifest.split('\n').filter(Boolean).slice(0, 30)) {
    const name = line.replace(/^[a-f0-9]{64}\s+\.\//, '');
    if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.includes('..')) continue;
    const text = pullText(`${cand}/${name}`, 512 * 1024);
    if (text !== null) save(`${local}/candidate/${name}`, sanitizeLog(text, 512 * 1024));
  }
}

function attemptPrompt(n: number, cand: string, previous: string) {
  const template = readFileSync('packages/training/remote/task-candidate.md', 'utf8');
  const configRule = n === 1
    ? `This is the baseline: write exactly {"hidden": ${BASELINE.hidden}, "learningRate": ${BASELINE.learningRate}, "maxEpochs": ${BASELINE.maxEpochs}}.`
    : 'Choose one predeclared combination and record why BEFORE training. You may change training/model code to fix'
      + ' problems shown in feedback, but not the loss, the parameter layout, features, targets or output contract.';
  const text = template.replaceAll('{{ATTEMPT}}', String(n)).replaceAll('{{CANDIDATE}}', cand).replaceAll('{{WORK}}', WORK)
    .replaceAll('{{CONFIG_RULE}}', configRule).replaceAll('{{PREVIOUS}}', previous);
  const local = join(runDir, `attempt-${n}`, 'prompt.md');
  save(`attempt-${n}/prompt.md`, text);
  return local;
}

function feedback(a: Attempt) {
  const lines = [`\n## Feedback from attempt ${a.n} (validation split only; files already copied into your directory)`,
    `Config: ${JSON.stringify(a.config)}. Failure: ${a.failure ?? 'none'}.`];
  if (a.mechanics) {
    const m = { ...a.mechanics }; delete m.gradientChecks;
    lines.push(`Builder harness mechanics result: ${JSON.stringify(m).slice(0, 1500)}`);
  }
  if (a.selector) {
    lines.push('Host checkpoint validation (decoded financial quality; selection is by p95 normalized risk gap, then mean gap, then cost):');
    for (const h of a.selector.history) lines.push(`- epoch ${h.epoch}: trainLoss ${h.trainLoss.toFixed(5)}, p95Gap ${h.p95Gap.toFixed(4)}, meanGap ${h.meanGap.toFixed(4)}, feasible ${h.feasible}/${validationRows.length}`);
  }
  if (a.best) {
    const m = a.best.metrics;
    lines.push(`Best epoch ${a.best.epoch}: median retained improvement ${m.retainedImprovement.median}, p10 ${m.retainedImprovement.p10},`
      + ` nontrivial ${m.nontrivialCount}, noImprovement ${m.noImprovementCount}. Gates: median>=0.8, p10>=0.5, p95 gap<=0.05, 100% feasible.`);
    const worst = [...m.cases].sort((x, y) => y.normalizedRiskGap - x.normalizedRiskGap).slice(0, 8);
    lines.push(`Worst validation cases: ${JSON.stringify(worst.map(c => ({ id: c.id, gap: +c.normalizedRiskGap.toFixed(4), retained: c.retainedImprovement })))}`);
  }
  return lines.join('\n') + '\n';
}

async function runAttempt(n: number, previous: Attempt | null): Promise<Attempt> {
  const cand = `${WORK}/attempt-${n}/candidate`, dir = `${WORK}/attempt-${n}`;
  const a: Attempt = { n, config: null, codex: {}, codeHashes: null, mechanics: null, selector: null, best: null,
    trainingMs: 0, withinBudget: true, failure: null, candidate: cand };
  attempts.push(a);
  // ../runtime from the candidate resolves to the shared read-only pinned runtime.
  mustExec(`mkdir -p ${cand} && ln -sfn ${WORK}/runtime ${dir}/runtime && ${previous ? `cp -r ${previous.candidate}/. ${cand}/ && rm -rf ${cand}/scratch` : 'true'}`);
  const prompt = attemptPrompt(n, cand, previous ? feedback(previous) : '');
  const codingBudgetSec = Math.floor(Math.min(L.codingMs, experimentStart + L.overallMs - Date.now() - 60_000) / 1000);
  if (codingBudgetSec < 60) { a.failure = 'insufficient overall budget for coding'; return a; }
  a.codex = await runCodex(`hn-${runId}-attempt-${n}-codex`, prompt, cand, dir, codingBudgetSec);
  if (a.codex.blocked) throw new Blocker('Codex reported an access/quota failure');
  const manifest = await remoteHashes(cand);
  a.codeHashes = manifest; save(`attempt-${n}/code-sha256.txt`, manifest);
  pullCandidate(cand, `attempt-${n}`, manifest);
  if (a.codex.exit !== '0' || a.codex.treeExited !== true || a.codex.timedOut) {
    a.failure = 'coding process did not complete successfully'; return a;
  }
  if (previous) {
    const diff = spawnSync('diff', ['-ruN', join(runDir, `attempt-${previous.n}`, 'candidate'), join(runDir, `attempt-${n}`, 'candidate')], { encoding: 'utf8' });
    save(`attempt-${n}/candidate.diff`, diff.stdout.slice(0, 1024 * 1024));
  }
  try { a.config = parseAttemptConfig(jsonOf(pullText(`${cand}/attempt-config.json`) ?? '') ?? null); }
  catch (error) { a.failure = `invalid attempt-config: ${(error as Error).message}`; return a; }
  if (n === 1 && JSON.stringify(a.config) !== JSON.stringify(BASELINE)) { a.failure = 'baseline config differs from declaration'; return a; }
  event('attempt_config', { n, config: a.config });
  return trainAttempt(a, Date.now());
}

async function trainAttempt(a: Attempt, trainStart: number): Promise<Attempt> {
  const { n, candidate: cand } = a, dir = `${WORK}/attempt-${n}`, manifest = a.codeHashes!;
  if (!a.config) throw new Error('attempt has no config');
  // Training phase: one 10-minute budget covering development run, harness and main training.
  const trainDeadline = Math.min(trainStart + L.trainingMs, experimentStart + L.overallMs);
  const secsLeft = () => Math.max(5, Math.floor((trainDeadline - Date.now()) / 1000));
  const devCfg = { seed: L.seed, hidden: 8, learningRate: a.config.learningRate, maxEpochs: 30, batchSize: L.batchSize,
    trainPath: `${WORK}/data/development.json`, validationPath: `${WORK}/data/development.json`, outDir: `${dir}/dev-run`,
    controlDir: `${dir}/dev-control`, checkpointEvery: L.checkpointEvery, waitForControl: false };
  save(`attempt-${n}/dev-config.json`, devCfg); push(join(runDir, `attempt-${n}/dev-config.json`), `${dir}/dev-config.json`);
  const devId = startProcess(`hn-${runId}-attempt-${n}-dev`, `mkdir -p ${dir}/dev-run ${dir}/dev-control && timeout --signal=TERM --kill-after=5s ${Math.min(150, secsLeft())}s ${NODE} ${cand}/train.ts ${dir}/dev-config.json > ${dir}/dev-run.log 2>&1`, cand);
  const dev = await waitTree(devId, Math.min(Date.now() + 160_000, trainDeadline));
  save(`attempt-${n}/dev-run.log`, sanitizeLog(pullText(`${dir}/dev-run.log`) ?? '', 64 * 1024));
  event('dev_run', { n, id: devId, ...dev });
  const harnessId = startProcess(`hn-${runId}-attempt-${n}-harness`, `timeout --signal=TERM --kill-after=5s ${Math.min(150, secsLeft())}s ${NODE} ${WORK}/harness/harness-check.mjs mechanics ${cand} ${WORK}/data/development.json ${dir}/dev-run ${dir}/mechanics.json > ${dir}/harness.log 2>&1`, cand);
  const harness = await waitTree(harnessId, Math.min(Date.now() + 160_000, trainDeadline));
  a.mechanics = jsonOf(pullText(`${dir}/mechanics.json`) ?? '');
  save(`attempt-${n}/mechanics.json`, a.mechanics ?? { missing: true });
  save(`attempt-${n}/harness.log`, sanitizeLog(pullText(`${dir}/harness.log`) ?? '', 64 * 1024));
  event('mechanics', { n, id: harnessId, exit: harness.exitCode, passed: a.mechanics?.passed ?? false });
  if (a.mechanics?.passed !== true) { a.failure = 'mechanics checks failed; financial training skipped'; a.trainingMs = Date.now() - trainStart; return a; }

  const mainCfg = { ...devCfg, hidden: a.config.hidden, maxEpochs: a.config.maxEpochs, trainPath: `${WORK}/data/train.json`,
    validationPath: `${WORK}/data/validation.json`, outDir: `${dir}/main-run`, controlDir: `${dir}/main-control`, waitForControl: true };
  save(`attempt-${n}/main-config.json`, mainCfg); push(join(runDir, `attempt-${n}/main-config.json`), `${dir}/main-config.json`);
  const selector = a.selector = new CheckpointSelector(a.config.maxEpochs);
  const mainId = startProcess(`hn-${runId}-attempt-${n}-main`, `mkdir -p ${dir}/main-run ${dir}/main-control && timeout --signal=TERM --kill-after=5s ${secsLeft()}s ${NODE} ${cand}/train.ts ${dir}/main-config.json > ${dir}/main-run.log 2>&1`, cand);
  event('main_started', { n, id: mainId, config: a.config });
  let nextEpoch = L.checkpointEvery, stopSent = false;
  const main = await waitTree(mainId, trainDeadline, async () => {
    if (stopSent) return;
    const remote = `${dir}/main-run/checkpoint-${pad(nextEpoch)}.json`;
    if (exec(`test -f ${remote}`).code !== 0) return;
    const text = pullText(remote, L.maxCheckpointBytes + 1) ?? '';
    let action: 'continue' | 'stop' = 'stop';
    try {
      const cp = parseCheckpoint(text, { epoch: nextEpoch, hidden: a.config!.hidden, ids: builderValidationIds });
      const metrics = evaluateFinancially(validationRows, cp.predictions);
      action = selector.observe(cp, metrics);
      if (selector.best?.epoch === nextEpoch) a.best = { epoch: nextEpoch, metrics, remotePath: remote, sha: sha256(text) };
      save(`attempt-${n}/checkpoints/checkpoint-${pad(nextEpoch)}.json`, text);
      event('checkpoint', { n, epoch: nextEpoch, action, trainLoss: cp.trainLoss, p95Gap: metrics.normalizedRiskGapP95,
        meanGap: metrics.meanNormalizedRiskGap, feasible: metrics.feasibleCount, median: metrics.retainedImprovement.median,
        p10: metrics.retainedImprovement.p10, passed: metrics.passed, stale: selector.stale });
    } catch (error) {
      a.failure = `invalid checkpoint ${nextEpoch}: ${(error as Error).message}`;
      event('checkpoint_rejected', { n, epoch: nextEpoch, reason: a.failure });
    }
    const control = join(runDir, `attempt-${n}/control/control-${pad(nextEpoch)}.json`);
    save(`attempt-${n}/control/control-${pad(nextEpoch)}.json`, { action });
    push(control, `${dir}/main-control/control-${pad(nextEpoch)}.json`);
    if (action === 'stop') stopSent = true;
    nextEpoch += L.checkpointEvery;
  });
  a.trainingMs = Date.now() - trainStart;
  a.withinBudget = !main.timedOut && a.trainingMs <= L.trainingMs;
  save(`attempt-${n}/main-run.log`, sanitizeLog(pullText(`${dir}/main-run.log`) ?? '', 256 * 1024));
  save(`attempt-${n}/selection-history.json`, selector.history);
  event('main_finished', { n, id: mainId, ...main, trainingMs: a.trainingMs, bestEpoch: a.best?.epoch ?? null });
  if (main.timedOut) a.failure = a.failure ?? 'training deadline reached';
  else if (main.exitCode !== 0) a.failure = a.failure ?? `trainer exit ${main.exitCode}`;
  const after = await remoteHashes(cand);
  if (after !== manifest) { a.failure = 'candidate code changed during training'; save(`attempt-${n}/code-sha256-after.txt`, after); }
  return a;
}

async function cleanup(reason: string) {
  event('cleanup', { reason, running: [...running] });
  for (const id of [...running]) { try { await stopTree(id); } catch (error) { event('cleanup_stop_failed', { id, error: String(error) }); } }
  try {
    if (sandboxGet().status === 'running') { cos(['sandbox', 'firewall', 'set', SANDBOX, ...ORIGINAL_EGRESS]); event('egress_restored', { egress: sandboxGet().egress }); }
  } catch (error) { event('egress_restore_failed', { error: String(error) }); }
  const p = cos(['sandbox', 'pause', SANDBOX]);
  let state = null;
  for (let i = 0; i < 10; i++) { try { state = sandboxGet(); if (state.status === 'paused') break; } catch { /* retry */ } await sleep(3_000); }
  event('paused', { pauseExit: p.code, state });
  summary.finalSandbox = state;
  const cleanupVerified = state?.status === 'paused' && running.size === 0;
  summary.cleanupVerified = cleanupVerified;
  if (!cleanupVerified) { summary.outcome = 'quarantined'; process.exitCode = 1; }
  summary.finishedAt = iso(); summary.elapsedMs = Date.now() - t0;
  save('summary.json', summary);
  if (cleanupVerified) writeFileSync(join(runDir, 'finished'), iso());
}

async function resumeRun(resumeId: string) {
  // Continue an interrupted run on its ORIGINAL clocks (no budget reset). Only attempt 1
  // after its completed coding phase is supported, which is the recorded incident.
  const old = resolve('.amp/in/artifacts', resumeId);
  const events = readFileSync(join(old, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const at = (name: string) => Date.parse(events.find(e => e.event === name)!.at);
  WORK = `/root/hedgenet-training/${resumeId}`;
  experimentStart = at('uploaded');
  const smokeEvent = events.find(e => e.event === 'smoke');
  if (smokeEvent?.passed !== true) throw new Error('cannot resume: smoke did not pass');
  summary.smoke = { passed: true, codex: events.find(e => e.event === 'codex_finished' && String(e.tag).endsWith('-smoke')) };
  summary.experimentStartedAt = new Date(experimentStart).toISOString();
  summary.resumedFrom = { runId: resumeId, reason: 'controller bug: managed process ID regex truncated an ID containing "-";'
    + ' controller killed while no remote process was running; budgets continue from original timestamps' };
  const codex = events.find(e => e.event === 'codex_finished' && String(e.tag).endsWith('-attempt-1-codex'));
  const configEvent = events.find(e => e.event === 'attempt_config' && e.n === 1);
  const manifest = readFileSync(join(old, 'attempt-1/code-sha256.txt'), 'utf8');
  const cand = `${WORK}/attempt-1/candidate`;
  if (await remoteHashes(cand) !== manifest) throw new Error('attempt-1 candidate changed since coding phase');
  const remoteSums = mustExec(`cd ${WORK} && sha256sum data/* harness/* runtime/numeric-ui-core.ts`);
  for (const [k, p] of Object.entries(builderFiles)) if (!remoteSums.includes(fileSha(p))) throw new Error(`remote ${k} hash mismatch`);
  if (!remoteSums.includes(HANDWIRED.runtimeSha)) throw new Error('remote runtime hash mismatch');
  const a: Attempt = { n: 1, config: parseAttemptConfig(configEvent.config), codex, codeHashes: manifest, mechanics: null,
    selector: null, best: null, trainingMs: 0, withinBudget: true, failure: null, candidate: cand };
  attempts.push(a);
  for (const f of ['attempt-1/code-sha256.txt', 'attempt-1/prompt.md']) save(f, readFileSync(join(old, f), 'utf8'));
  cpSync(join(old, 'attempt-1/candidate'), join(runDir, 'attempt-1/candidate'), { recursive: true });
  event('resumed', { from: resumeId, experimentStart: summary.experimentStartedAt, trainStart: configEvent.at });
  return trainAttempt(a, at('attempt_config'));
}

async function main() {
  // Preflight: existing sandbox only.
  const before = sandboxGet();
  event('preflight', before);
  if (before.ingress) throw new Blocker('ingress unexpectedly enabled');
  spawn(process.execPath, ['tools/training-watchdog.ts', runDir, String(Date.now() + 60 * 60_000), SANDBOX],
    { cwd: root, detached: true, stdio: 'ignore' }).unref();
  if (before.status !== 'running') {
    const r = cos(['sandbox', 'resume', SANDBOX], { timeoutMs: 180_000 });
    event('resume', { code: r.code });
  }
  for (let i = 0; i < 40 && sandboxGet().status !== 'running'; i++) await sleep(3_000);
  const fw = cos(['sandbox', 'firewall', 'set', SANDBOX, ...CODEX_EGRESS]);
  const afterFw = sandboxGet();
  event('firewall', { code: fw.code, egress: afterFw.egress, ingress: afterFw.ingress });
  if (JSON.stringify([...afterFw.egress].sort()) !== JSON.stringify([...CODEX_EGRESS].sort()) || afterFw.ingress) throw new Blocker('firewall read-back mismatch');
  const info = mustExec('echo "home=$HOME"; echo "node=$(command -v node)"; node --version; codex --version; command -v timeout; nproc; free -m | head -2; codex login status 2>&1 || true');
  save('remote-preflight.txt', sanitizeLog(info, 4000));
  event('remote_preflight', { info: sanitizeLog(info, 600) });
  if (!/Logged in using ChatGPT/.test(info)) throw new Blocker('remote Codex is not logged in with ChatGPT');
  NODE = (info.match(/node=(\S+)/) ?? [])[1] ?? 'node';
  let previous: Attempt | null = null, firstAttempt = 1;
  if (resumeId) {
    previous = await resumeRun(resumeId);
    save(`attempt-1/result.json`, { ...previous, selector: previous.selector?.history ?? null, best: previous.best ? { epoch: previous.best.epoch, sha: previous.best.sha } : null });
    firstAttempt = 2;
  } else {
  WORK = `${(info.match(/home=(\S+)/) ?? [])[1]}/hedgenet-training/${runId}`;
  summary.remoteWork = WORK;

  // Upload: runtime, upstream example, builder-only data, fixed harness. No host-only files.
  const uploads: [string, string][] = [
    [runtimePath, `${WORK}/runtime/numeric-ui-core.ts`], [join(HANDWIRED.dir, 'LICENSE'), `${WORK}/runtime/LICENSE`],
    [join(HANDWIRED.dir, 'lab/reusable-layout/model.ts'), `${WORK}/runtime/reference-model-example.ts`],
    [builderFiles.development, `${WORK}/data/development.json`], [builderFiles.train, `${WORK}/data/train.json`],
    [builderFiles.validation, `${WORK}/data/validation.json`], ['packages/training/remote/harness-check.mjs', `${WORK}/harness/harness-check.mjs`]];
  for (const [l, r] of uploads) push(l, r);
  const remoteSums = mustExec(`cd ${WORK} && sha256sum runtime/* data/* harness/*`);
  for (const [l, r] of uploads) if (!remoteSums.includes(`${fileSha(l)}  ${r.slice(WORK.length + 1)}`)) throw new Error(`upload hash mismatch ${r}`);
  mustExec(`chmod -R a-w ${WORK}/runtime ${WORK}/data ${WORK}/harness`);
  event('uploaded', { files: uploads.map(([, r]) => r) });

  // Bounded code-write/run smoke test.
  experimentStart = Date.now();
  summary.experimentStartedAt = iso();
  const smokeDir = `${WORK}/smoke`;
  const smokePrompt = readFileSync('packages/training/remote/task-smoke.md', 'utf8').replaceAll('{{DIR}}', smokeDir).replaceAll('{{WORK}}', WORK);
  save('smoke/prompt.md', smokePrompt);
  const smoke = await runCodex(`hn-${runId}-smoke`, join(runDir, 'smoke/prompt.md'), smokeDir, `${smokeDir}/codex`, 180);
  const dev = readJson(builderFiles.development) as { id: string; features: number[]; targets: number[]; mask: number[] }[];
  const expected = { rows: dev.length, featureLength: dev[0]!.features.length, firstId: dev[0]!.id,
    maskedTargetSum: dev.reduce((s, r) => s + r.targets.reduce((t, v, j) => t + v * r.mask[j]!, 0), 0) };
  const got = jsonOf(pullText(`${smokeDir}/smoke-output.json`) ?? '');
  const code = pullText(`${smokeDir}/smoke.ts`, 64 * 1024);
  if (code) save('smoke/smoke.ts', sanitizeLog(code));
  const smokePassed = smoke.exit === '0' && smoke.treeExited && !smoke.timedOut && !!code
    && !!got && got.rows === expected.rows && got.featureLength === expected.featureLength && got.firstId === expected.firstId
    && typeof got.maskedTargetSum === 'number' && Math.abs(got.maskedTargetSum - expected.maskedTargetSum) <= 1e-9 * Math.max(1, expected.maskedTargetSum);
  summary.smoke = { ...smoke, passed: smokePassed, expected, got, codeSha: code ? sha256(code) : null };
  event('smoke', { passed: smokePassed });
  if (smoke.blocked || !smokePassed) throw new Blocker(`smoke test failed${smoke.blocked ? ' (access/quota)' : ''}`);
  }
  summary.remoteWork = WORK;

  // Baseline plus at most two improvements, with no budget resets.
  for (let n = firstAttempt; n <= L.maxCandidates; n++) {
    if (previous?.best?.metrics.passed && previous.failure === null) break;
    if (Date.now() > experimentStart + L.overallMs - 8 * 60_000) { event('budget_exhausted', { beforeAttempt: n }); break; }
    previous = await runAttempt(n, previous);
    save(`attempt-${n}/result.json`, { ...previous, selector: previous.selector?.history ?? null,
      best: previous.best ? { epoch: previous.best.epoch, sha: previous.best.sha, metrics: { ...previous.best.metrics, cases: undefined } } : null });
    if (previous.best?.metrics.passed && previous.failure === null) break; // passing validation candidate: do not search further
  }
  summary.attempts = attempts.map(a => ({ n: a.n, config: a.config, codex: a.codex, failure: a.failure, mechanicsPassed: a.mechanics?.passed ?? false,
    trainingMs: a.trainingMs, withinBudget: a.withinBudget, bestEpoch: a.best?.epoch ?? null, bestCheckpointSha: a.best?.sha ?? null,
    validation: a.best ? { ...a.best.metrics, cases: undefined } : null }));
  summary.experimentElapsedMs = Date.now() - experimentStart;

  // Select across attempts by validation finance only.
  const eligible = attempts.filter(a => a.best && a.mechanics?.passed === true && a.failure === null && a.withinBudget);
  eligible.sort((x, y) => Number(y.best!.metrics.passed) - Number(x.best!.metrics.passed)
    || compareFinancial(x.best!.metrics, y.best!.metrics));
  const selected = eligible[0] ?? null;
  if (!selected) { summary.candidate = { status: 'rejected', promoted: false, reasons: ['no mechanically valid checkpoint'] }; return; }
  summary.selected = { attempt: selected.n, epoch: selected.best!.epoch, checkpointSha: selected.best!.sha };
  if (!selected.best!.metrics.passed) {
    summary.heldout = 'not run: selected checkpoint failed validation numerical gates; test split preserved';
    summary.candidate = candidateStatus({ validation: selected.best!.metrics, test: null, integrity: true,
      checks: mechanicsChecks(selected), latencyP95Ms: null, trainingWithinBudget: selected.withinBudget });
    return;
  }

  // Freeze, terminate builder agent, remove the subscription session, then held-out once.
  const frozen = `${WORK}/frozen`;
  mustExec(`mkdir -p ${frozen}/candidate ${frozen}/runtime && cp -r ${selected.candidate}/. ${frozen}/candidate/ && rm -rf ${frozen}/candidate/scratch && cp ${WORK}/runtime/numeric-ui-core.ts ${WORK}/runtime/LICENSE ${frozen}/runtime/ && cp ${selected.best!.remotePath} ${frozen}/weights.json && chmod -R a-w ${frozen}`);
  const frozenCode = await remoteHashes(`${frozen}/candidate`);
  if (frozenCode !== selected.codeHashes) throw new Error('frozen candidate code differs from the validated attempt code');
  const frozenSums = mustExec(`cd ${frozen} && sha256sum runtime/numeric-ui-core.ts runtime/LICENSE weights.json`);
  if (!frozenSums.includes(`${selected.best!.sha}  weights.json`) || !frozenSums.includes(`${HANDWIRED.runtimeSha}  runtime/numeric-ui-core.ts`)) {
    throw new Error('frozen weights/runtime hash differs from validated artifact');
  }
  summary.frozen = { code: frozenCode.trim().split('\n'), files: frozenSums.trim().split('\n'), codeManifestSha: sha256(frozenCode) };
  const procs = mustExec('pgrep -af "[c]odex" || true; pgrep -af "[t]rain\\.ts" || true');
  if (procs.trim()) throw new Blocker(`builder processes still alive: ${sanitizeLog(procs, 300)}`);
  for (const id of [...running]) await stopTree(id);
  const logout = exec('codex logout 2>&1; codex login status 2>&1; test ! -e "$HOME/.codex/auth.json" && echo no-auth-file');
  loggedOut = /no-auth-file/.test(logout.stdout) && !/Logged in using/.test(logout.stdout);
  summary.sessionRemoved = { loggedOut, output: sanitizeLog(logout.stdout, 400) };
  event('codex_logout', summary.sessionRemoved as Record<string, unknown>);
  if (!loggedOut) throw new Blocker('could not verify Codex session removal before held-out evaluation');
  cos(['sandbox', 'firewall', 'set', SANDBOX, ...ORIGINAL_EGRESS]);
  summary.egressAfterHeldout = sandboxGet().egress;

  const testInputs = join(runDir, 'heldout/inputs.json');
  save('heldout/inputs.json', JSON.stringify(testRows.map(r => ({ id: r.id, features: r.features.values }))));
  push(testInputs, `${WORK}/heldout/inputs.json`);
  const isolated = `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=${WORK}/heldout/home`;
  const hStart = Date.now();
  const predId = startProcess(`hn-${runId}-heldout-predict`, `mkdir -p ${WORK}/heldout/home && cd ${frozen} && ${isolated} timeout --signal=TERM --kill-after=5s 120s ${NODE} candidate/predict.ts weights.json ${WORK}/heldout/inputs.json ${WORK}/heldout/predictions.json > ${WORK}/heldout/predict.log 2>&1`, frozen);
  const pred = await waitTree(predId, Date.now() + 135_000);
  const processWallMs = Date.now() - hStart;
  const predText = pullText(`${WORK}/heldout/predictions.json`, 4 * 1024 * 1024) ?? '';
  save('heldout/predictions.json', predText);
  const latId = startProcess(`hn-${runId}-heldout-latency`, `cd ${frozen} && ${isolated} timeout --signal=TERM --kill-after=5s 120s ${NODE} ${WORK}/harness/harness-check.mjs latency ${frozen}/candidate ${frozen}/weights.json ${WORK}/heldout/inputs.json ${WORK}/heldout/latency.json > ${WORK}/heldout/latency.log 2>&1`, frozen);
  const lat = await waitTree(latId, Date.now() + 135_000);
  const latency = jsonOf(pullText(`${WORK}/heldout/latency.json`) ?? '');
  save('heldout/latency.json', latency ?? { missing: true });
  let test: FinancialMetrics | null = null, integrity = pred.exitCode === 0 && !pred.timedOut;
  try {
    const parsed = jsonOf(predText);
    if (parsed?.schemaVersion !== 'hedgenet-predictions-v1') throw new Error('prediction schema');
    test = evaluateFinancially(testRows, parsePredictionRows(parsed.predictions, testRows.map(r => r.id)));
  } catch (error) { integrity = false; summary.heldoutError = (error as Error).message; }
  summary.heldout = { predictProcess: predId, latencyProcess: latId, predictExit: pred.exitCode, latencyExit: lat.exitCode,
    processWallMs, latency, metrics: test };
  summary.candidate = candidateStatus({ validation: selected.best!.metrics, test, integrity, checks: mechanicsChecks(selected),
    latencyP95Ms: typeof latency?.warmP95Ms === 'number' ? latency.warmP95Ms : null, trainingWithinBudget: selected.withinBudget });
}

function mechanicsChecks(a: Attempt): RemoteChecks {
  const m = a.mechanics ?? {};
  return { gradient: m.gradient === true, referenceAgreement: m.referenceAgreement === true, serialization: m.serialization === true,
    parameterSensitivity: m.parameterSensitivity === true, developmentLossDecreased: m.developmentLossDecreased === true };
}

let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (interrupted) return; interrupted = true; summary.interrupted = signal;
  void cleanup(`signal ${signal}`).finally(() => process.exit(130));
});
try { await main(); summary.outcome = 'completed'; }
catch (error) {
  summary.outcome = error instanceof Blocker ? 'blocked' : 'failed';
  summary.error = sanitizeLog(String((error as Error).stack ?? error), 3000);
  event('error', { outcome: summary.outcome, error: summary.error });
}
finally {
  if (!interrupted) await cleanup(String(summary.outcome));
  console.log(JSON.stringify({ runDir, outcome: summary.outcome, candidate: summary.candidate ?? null }));
}
