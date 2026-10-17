// Host cleanup deadline for tools/run-training.ts. Runs detached; at the deadline,
// unless `finished` exists, force-stops every recorded managed process and pauses the
// sandbox. Never destroys the sandbox. Usage: node tools/training-watchdog.ts <runDir> <deadlineMs> <sandbox>
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const [runDir, deadline, sandbox] = process.argv.slice(2);
if (!runDir || !deadline || !sandbox) throw new Error('usage: training-watchdog <runDir> <deadlineMs> <sandbox>');
const log = (event: Record<string, unknown>) =>
  appendFileSync(join(runDir, 'watchdog.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
log({ event: 'armed', deadline: new Date(Number(deadline)).toISOString(), pid: process.pid });
while (Date.now() < Number(deadline)) {
  if (existsSync(join(runDir, 'finished'))) { log({ event: 'disarmed' }); process.exit(0); }
  await new Promise(resolve => setTimeout(resolve, 5_000));
}
if (existsSync(join(runDir, 'finished'))) { log({ event: 'disarmed' }); process.exit(0); }
const run = (args: string[]) => {
  const r = spawnSync('createos', ['--output', 'json', ...args], { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, out: (r.stdout ?? '').slice(0, 2000) };
};
const ids = existsSync(join(runDir, 'processes.jsonl'))
  ? [...new Set(readFileSync(join(runDir, 'processes.jsonl'), 'utf8').match(/proc_[A-Za-z0-9_-]+/g) ?? [])] : [];
for (const id of ids) log({ event: 'stop', id, ...run(['sandbox', 'process', 'stop', '--force', '--grace', '2s', sandbox, id]) });
log({ event: 'pause', ...run(['sandbox', 'pause', sandbox]) });
log({ event: 'readback', ...run(['sandbox', 'get', sandbox]) });
