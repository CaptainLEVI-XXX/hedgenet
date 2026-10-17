import { expect, it } from 'vitest';
import { JevError } from '../../packages/intake/src/index.ts';
import type { JevClient } from '../../packages/intake/src/index.ts';
import { POST as previewPost } from '../../apps/web/app/api/preview/route.ts';
import { runLiveIntake } from '../../apps/web/lib/live-intake.ts';
import type { LiveIntakeDeps } from '../../apps/web/lib/live-intake.ts';

const post = (body: string, headers: Record<string, string> = {}) => new Request('http://127.0.0.1:3000/api/preview', {
  method: 'POST', body,
  headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json', ...headers },
});

it('serves evaluator-priced previews only to same-origin, bounded, in-range requests', async () => {
  const ok = await previewPost(post(JSON.stringify({ example: 'crypto', budgetUsd: '1000', revision: 7 })));
  expect(ok.status).toBe(200);
  const { preview } = await ok.json();
  expect([preview.valuation.totalCostUsd, preview.revision, preview.unspentBudgetUsd]).toEqual(['999.95', 7, '0.05']);

  expect((await previewPost(post('{}', { origin: 'https://evil.example' }))).status).toBe(403);
  expect((await previewPost(post('{}', { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
  expect((await previewPost(post(JSON.stringify({ example: 'crypto', budgetUsd: '1000', revision: 1, pad: 'x'.repeat(2000) })))).status).toBe(413);
  const refused = await previewPost(post(JSON.stringify({ example: 'weather', budgetUsd: '5000.01', revision: 2 })));
  expect(refused.status).toBe(400);
  expect((await refused.json()).error.code).toBe('outside_preview_range');
});

const unusedCatalogue = async () => ({ search() { throw new Error('not reached'); } }) as never;

it('reports live intake honestly: sanitized draft, model unavailable, bounded concurrency', async () => {
  const failing = { ask: async () => { throw new JevError('network_error'); } } as unknown as JevClient;
  const result = await runLiveIntake({ text: 'My shop loses $900 if it snows on Friday.', timezone: 'UTC' },
    { client: () => failing, catalogue: unusedCatalogue });
  expect(result.interpretation.status).toBe('dependency_unavailable');
  expect(result.interpretation.failure).toBe('network_error');
  expect(result.model.status).toBe('unavailable');
  expect(result.proposal).toBeNull();
  expect(JSON.stringify(result)).not.toMatch(/provider|probabilities/);

  await expect(runLiveIntake({ text: 'x', timezone: 'UTC' }, { client: () => null, catalogue: unusedCatalogue }))
    .rejects.toMatchObject({ status: 503, code: 'jev_not_configured' });

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const hanging = { ask: async () => { await gate; throw new JevError('timeout'); } } as unknown as JevClient;
  const deps: LiveIntakeDeps = { client: () => hanging, catalogue: unusedCatalogue };
  const running = [runLiveIntake({ text: 'a', timezone: 'UTC' }, deps), runLiveIntake({ text: 'b', timezone: 'UTC' }, deps)];
  await expect(runLiveIntake({ text: 'c', timezone: 'UTC' }, deps)).rejects.toMatchObject({ status: 429, code: 'intake_busy' });
  release();
  await Promise.all(running);
});
