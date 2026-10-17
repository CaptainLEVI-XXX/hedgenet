import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const runner = resolve('tools/lab.mjs');
const roots: string[] = [];
const packet = {
  schemaVersion: 'lab-packet-v1',
  id: 'runner-controls',
  mode: 'evaluate',
  question: 'Does the runner preserve actual check outcomes?',
  prediction: 'Only a complete, unchanged, successful suite passes.',
  disconfirmingEvidence: 'A failed or skipped command is reported as passed.',
  requirements: ['Record failure honestly; no release or promotion.'],
  assumptions: ['These fake tools test orchestration, not product correctness.'],
  baseline: 'Direct execution of the same three commands.',
  evidence: ['Synthetic temporary repository.'],
  suite: 'foundation',
  budgetSeconds: 10,
};

function fixture(first = 'console.log("fixture tests passed")') {
  mkdirSync('.amp/in', { recursive: true });
  const root = mkdtempSync(resolve('.amp/in/lab-test-'));
  roots.push(root);
  spawnSync('git', ['init', '-q', root]);
  for (const dir of ['node_modules/vitest', 'node_modules/typescript/bin', 'examples', 'packages']) {
    mkdirSync(resolve(root, dir), { recursive: true });
  }
  writeFileSync(resolve(root, '.gitignore'), '.amp/\nnode_modules/\n.env\npacket.json\n');
  writeFileSync(resolve(root, 'package.json'), '{"type":"module"}');
  writeFileSync(resolve(root, 'packages/input.ts'), 'export const input = 7;\n');
  writeFileSync(resolve(root, 'node_modules/vitest/vitest.mjs'), first);
  writeFileSync(resolve(root, 'node_modules/typescript/bin/tsc'), 'console.log("fixture types passed")');
  writeFileSync(resolve(root, 'examples/financial-foundation.ts'), 'console.log("fixture demo passed")');
  writeFileSync(resolve(root, '.env'), 'TEST_SECRET=private-test-value');
  writeFileSync(resolve(root, 'packet.json'), JSON.stringify(packet));
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [runner, 'packet.json'], {
    cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, TEST_SECRET: 'private-test-value' },
  });
}

function artifacts(root: string) {
  const parent = resolve(root, '.amp/in/artifacts/lab');
  const runs = readdirSync(parent);
  expect(runs).toHaveLength(1);
  const dir = resolve(parent, runs[0]!);
  return { dir, report: JSON.parse(readFileSync(resolve(dir, 'result.json'), 'utf8')) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('captures uncommitted source, packet, commands and outputs without forwarding secrets', () => {
  const root = fixture('console.log(process.env.TEST_SECRET ?? "no inherited secret")');
  writeFileSync(resolve(root, 'packages/.envrc'), 'local-only-marker');
  mkdirSync(resolve(root, 'packages/.projects'));
  writeFileSync(resolve(root, 'packages/.projects/state.json'), '{"local":true}');
  const result = run(root);
  expect(result.status, result.stderr).toBe(0);
  const { dir, report } = artifacts(root);
  expect(report.status).toBe('checks_passed');
  expect(report.checks.map((c: { status: string }) => c.status)).toEqual(['passed', 'passed', 'passed']);
  expect(report.sourceBefore['packages/input.ts']).toMatch(/^[a-f0-9]{64}$/);
  expect(report.sourceBefore['.env']).toBeUndefined();
  expect(report.sourceBefore['packages/.envrc']).toBeUndefined();
  expect(report.sourceBefore['packages/.projects/state.json']).toBeUndefined();
  expect(readFileSync(resolve(dir, 'source/packages/input.ts'), 'utf8')).toBe('export const input = 7;\n');
  expect(readFileSync(resolve(dir, 'test.stdout.log'), 'utf8')).toBe('no inherited secret\n');
  expect(report.packetSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(report.runtime.node).toBe(process.version);
  expect(report.checks[0].exitCode).toBe(0);
  expect(report.acceptance).toBe('not_evaluated');
  expect(report.checks[0].command).toContain('node_modules/vitest/vitest.mjs');
});

it('retains failure output and marks remaining checks skipped', () => {
  const root = fixture('console.error("counterexample"); process.exit(7)');
  expect(run(root).status).toBe(1);
  const { dir, report } = artifacts(root);
  expect(report.status).toBe('failed');
  expect(report.checks.map((c: { status: string }) => c.status)).toEqual(['failed', 'skipped', 'skipped']);
  expect(report.checks[0].exitCode).toBe(7);
  expect(readFileSync(resolve(dir, 'test.stderr.log'), 'utf8')).toContain('counterexample');
});

it('stops at the wall-clock budget even if the child ignores SIGTERM', () => {
  const root = fixture('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)');
  writeFileSync(resolve(root, 'packet.json'), JSON.stringify({ ...packet, budgetSeconds: 1 }));
  expect(run(root).status).toBe(1);
  const { report } = artifacts(root);
  expect(report.status).toBe('timed_out');
  expect(report.checks[0].status).toBe('timed_out');
  expect(report.checks[1].status).toBe('skipped');
  expect(report.elapsedMs).toBeLessThan(5000);
});

it('invalidates a green suite when source changes, preserving the original input', () => {
  const root = fixture('import { writeFileSync } from "node:fs"; writeFileSync("packages/input.ts", "changed")');
  expect(run(root).status).toBe(1);
  const { dir, report } = artifacts(root);
  expect(report.status).toBe('invalidated');
  expect(report.sourceAfter['packages/input.ts']).not.toBe(report.sourceBefore['packages/input.ts']);
  expect(readFileSync(resolve(dir, 'source/packages/input.ts'), 'utf8')).toBe('export const input = 7;\n');
});

it('rejects command injection, incomplete packets and out-of-range budgets before running', () => {
  for (const invalid of [
    { ...packet, command: 'echo unsafe' },
    { ...packet, prediction: '' },
    { ...packet, budgetSeconds: 0 },
    { ...packet, budgetSeconds: 181 },
    { ...packet, suite: 'train' },
  ]) {
    const root = fixture();
    writeFileSync(resolve(root, 'packet.json'), JSON.stringify(invalid));
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid packet');
  }
});

it('bounds retained output and does not grade a truncated check as successful', () => {
  const root = fixture('process.stdout.write("x".repeat(2 * 1024 * 1024))');
  expect(run(root).status).toBe(1);
  const { dir, report } = artifacts(root);
  expect(report.status).toBe('output_limit');
  expect(readFileSync(resolve(dir, 'test.stdout.log')).length).toBeLessThanOrEqual(1024 * 1024);
});

it('records cancellation and stops the active process without claiming later checks ran', async () => {
  const root = fixture('console.log("ready"); setInterval(() => {}, 1000)');
  const child = spawn(process.execPath, [runner, 'packet.json'], { cwd: root, stdio: 'pipe' });
  const closed = new Promise<number | null>(resolve => child.on('close', resolve));
  // Wait for the runner to announce the persisted run before cancellation.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Runner did not start')); }, 5000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', reject);
  });
  child.kill('SIGTERM');
  expect(await closed).toBe(1);
  const { report } = artifacts(root);
  expect(report.status).toBe('interrupted');
  expect(report.checks.some((c: { status: string }) => c.status === 'skipped')).toBe(true);
});
