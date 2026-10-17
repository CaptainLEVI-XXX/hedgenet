// Trusted local verification only. This is not an untrusted-code sandbox.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  realpathSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

const CHECKS = [
  ['test', ['node_modules/vitest/vitest.mjs', 'run']],
  ['typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['demo', ['examples/financial-foundation.ts']],
];
const OUTPUT_LIMIT = 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function parsePacket(bytes) {
  const packet = JSON.parse(bytes);
  const strings = ['id', 'question', 'prediction', 'disconfirmingEvidence', 'baseline'];
  const lists = ['requirements', 'assumptions', 'evidence'];
  const keys = [...strings, ...lists, 'schemaVersion', 'mode', 'suite', 'budgetSeconds'];
  if (!packet || Array.isArray(packet) || typeof packet !== 'object'
    || Object.keys(packet).some(key => !keys.includes(key))
    || strings.some(key => !nonempty(packet[key]))
    || lists.some(key => !Array.isArray(packet[key]) || packet[key].length === 0 || !packet[key].every(nonempty))
    || packet.schemaVersion !== 'lab-packet-v1'
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(packet.id)
    || !['research', 'model', 'implement', 'evaluate'].includes(packet.mode)
    || packet.suite !== 'foundation'
    || !Number.isInteger(packet.budgetSeconds) || packet.budgetSeconds < 1 || packet.budgetSeconds > 180) {
    throw new Error('Invalid packet: use lab-packet-v1, the foundation suite, complete fields and a 1–180 second budget.');
  }
  return packet;
}

// Include uncommitted code: HEAD alone is not a candidate identity. Copy only
// known source/configuration paths, never provider state or environment files.
function sourceManifest(root, destination) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', timeout: 5000,
  }).split('\0').filter(Boolean);
  const manifest = {};
  for (const file of [...new Set(files)].sort()) {
    if (!/^(apps\/|packages\/|tests\/|examples\/|tools\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig\.json$|vitest\.config\.ts$|\.node-version$|\.gitignore$)/.test(file)) continue;
    if (file.split('/').some(part => /^(\.env(rc)?($|\.)|node_modules$|\.git$|\.projects$|\.amp$)/.test(part))
      || /\.(env|pem|key)(\.|$)/.test(file)) continue;
    const path = resolve(root, file);
    if (!existsSync(path)) continue; // A tracked deletion is absent from this candidate.
    if (!lstatSync(path).isFile() || realpathSync(path) !== path) {
      throw new Error(`Source symlinks/non-files are not supported: ${file}`);
    }
    const bytes = readFileSync(path);
    manifest[file] = sha256(bytes);
    if (destination) {
      const target = resolve(destination, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    }
  }
  return manifest;
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: pnpm lab:check <local-packet.json>');
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node 24 LTS for comparable lab runs.');
  if (process.platform === 'win32') throw new Error('The local runner requires POSIX process groups (macOS/Linux).');
  const root = realpathSync(process.cwd());
  if (realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()) !== root) {
    throw new Error('Run from the repository root.');
  }
  const packetBytes = readFileSync(resolve(root, process.argv[2]));
  let packet;
  try { packet = parsePacket(packetBytes); }
  catch (error) { throw new Error(`Invalid packet: ${error.message}`); }

  // Fail closed if evidence could appear in normal Git additions.
  const probe = '.amp/in/artifacts/lab/probe';
  execFileSync('git', ['check-ignore', '-q', probe], { cwd: root });
  const tracked = execFileSync('git', ['ls-files', '-z', '--', '.amp/in'], { encoding: 'utf8' });
  if (tracked) throw new Error('Private evidence is already tracked; stop and resolve before running.');
  for (const part of ['.amp', '.amp/in', '.amp/in/artifacts', '.amp/in/artifacts/lab']) {
    const path = resolve(root, part);
    if (existsSync(path) && realpathSync(path) !== path) throw new Error('Evidence directories must not be symlinks.');
  }
  const runId = `${packet.id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = resolve(root, '.amp/in/artifacts/lab', runId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(directory, 'packet.json'), packetBytes, { flag: 'wx', mode: 0o600 });
  const started = performance.now();
  const report = {
    schemaVersion: 'lab-result-v1', runId, status: 'running', acceptance: 'not_evaluated',
    startedAt: new Date().toISOString(), packetSha256: sha256(packetBytes),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    budgetSeconds: packet.budgetSeconds, outputLimitBytesPerCheck: OUTPUT_LIMIT,
    sourceBefore: {}, sourceAfter: null, sourceChanged: null,
    checks: CHECKS.map(([name, args]) => ({ name, command: [process.execPath, ...args], status: 'skipped' })),
  };
  const save = () => {
    const temp = resolve(directory, 'result.json.tmp');
    writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, resolve(directory, 'result.json'));
  };
  let interrupted = false;
  let cancelActive = null;
  const interrupt = () => { interrupted = true; cancelActive?.('interrupted'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  save();
  try {
    report.sourceBefore = sourceManifest(root, resolve(directory, 'source'));
    report.sourceSha256 = sha256(JSON.stringify(report.sourceBefore));
    save();
    const environment = { CI: '1', NO_COLOR: '1', NODE_ENV: 'test' };
    for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) {
      if (process.env[key]) environment[key] = process.env[key];
    }
    for (const check of report.checks) {
      if (interrupted) { report.status = 'interrupted'; break; }
      const remaining = packet.budgetSeconds * 1000 - (performance.now() - started);
      if (remaining <= 0) { report.status = 'timed_out'; break; }
      check.status = 'running';
      save();
      const checkStarted = performance.now();
      const outcome = await new Promise(resolveCheck => {
        let stopped = null;
        let outputBytes = 0;
        let killTimer;
        let spawnError;
        const child = spawn(check.command[0], check.command.slice(1), {
          cwd: root, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
        });
        const signalGroup = signal => {
          if (!child.pid) return;
          try { process.kill(-child.pid, signal); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        };
        const stop = reason => {
          if (stopped) return;
          stopped = reason;
          signalGroup('SIGTERM');
          killTimer = setTimeout(() => signalGroup('SIGKILL'), 250);
        };
        cancelActive = stop;
        const deadline = setTimeout(() => stop('timed_out'), remaining);
        for (const [stream, suffix] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
          const path = resolve(directory, `${check.name}.${suffix}.log`);
          writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
          stream.on('data', bytes => {
            const allowed = Math.max(0, OUTPUT_LIMIT - outputBytes);
            appendFileSync(path, bytes.subarray(0, allowed));
            outputBytes += bytes.length;
            if (outputBytes > OUTPUT_LIMIT) stop('output_limit');
          });
        }
        child.once('error', error => { spawnError = error.message; });
        child.once('close', (exitCode, signal) => {
          clearTimeout(deadline);
          clearTimeout(killTimer);
          signalGroup('SIGKILL'); // Do not leave descendants after their parent exits.
          cancelActive = null;
          resolveCheck({
            status: stopped ?? (exitCode === 0 && !spawnError ? 'passed' : 'failed'),
            exitCode, signal, elapsedMs: Math.round(performance.now() - checkStarted),
            outputBytes, ...(spawnError ? { error: spawnError } : {}),
          });
        });
        if (interrupted) stop('interrupted');
        console.log(`Lab ${runId}: ${check.name}`);
      });
      Object.assign(check, outcome);
      save();
      if (check.status !== 'passed') { report.status = check.status; break; }
    }
    report.sourceAfter = sourceManifest(root);
    report.sourceChanged = JSON.stringify(report.sourceBefore) !== JSON.stringify(report.sourceAfter);
    if (interrupted) report.status = 'interrupted';
    else if (report.status === 'running') {
      report.status = report.sourceChanged ? 'invalidated' : 'checks_passed';
    }
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
  } finally {
    report.elapsedMs = Math.round(performance.now() - started);
    report.finishedAt = new Date().toISOString();
    save();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
  console.log(`${report.status}: ${directory.slice(root.length + sep.length)}/result.json`);
  process.exitCode = report.status === 'checks_passed' ? 0 : 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
