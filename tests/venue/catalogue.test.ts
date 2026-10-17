import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createCatalogueIndex, loadCatalogue, refreshCatalogue } from '@hedgenet/venue';

const directories: string[] = [];
async function store() { const path = await mkdtemp(join(tmpdir(), 'hedgenet-catalogue-')); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function event(id: string, title: string, category = 'crypto') {
  return { id, title, slug: id, active: true, closed: false, endDate: '2028-01-01T00:00:00Z',
    tags: [{ slug: category, label: category }], markets: [{ id: `${id}-m`, question: title,
      active: true, closed: false, acceptingOrders: true, description: 'Synthetic resolution rule',
      version: 'v1', clobTokenIds: '["101","102"]', outcomes: '["Yes","No"]' }] };
}
const page = (events: unknown[], next_cursor: string | null = null) => Response.json({ events, next_cursor });
const btc = event('btc', 'Bitcoin below $50,000?');
const rain = event('rain', 'Rain in London?', 'weather');

it('preserves last-good data on failure and resumes the persisted cursor without duplicate parents', async () => {
  const path = await store();
  const baseline = await refreshCatalogue(path, { dataMode: 'synthetic', fetchImpl: async () => page([rain]) });
  let calls = 0;
  await expect(refreshCatalogue(path, { dataMode: 'synthetic', fetchImpl: async () => {
    if (++calls === 1) return page([btc], 'cursor-1');
    throw new Error('temporary failure');
  } })).rejects.toThrow('temporary failure');
  expect(await loadCatalogue(path)).toEqual(baseline);
  const resumed = await refreshCatalogue(path, { dataMode: 'synthetic', fetchImpl: async url => {
    expect(new URL(String(url)).searchParams.get('after_cursor')).toBe('cursor-1');
    return page([btc, rain]);
  } });
  expect(resumed.events.map(row => row.eventId)).toEqual(['btc', 'rain']);
  expect(resumed.pages).toBe(2);
  expect(await loadCatalogue(path)).toEqual(resumed);
  expect((await readFile(join(path, 'catalogue.json.gz'))).subarray(0, 2)).toEqual(Buffer.from([31, 139]));
});

it('searches aliases and categories locally without mistaking discovery for verified rules', async () => {
  const path = await store();
  const snapshot = await refreshCatalogue(path, { dataMode: 'synthetic', fetchImpl: async () => page([btc, rain,
    event('temp', 'London temperature above 30?', 'weather')]) });
  const index = createCatalogueIndex(snapshot);
  const result = index.search('I hold BTC and need protection');
  expect(result.items.map(row => row.eventId)).toEqual(['btc']);
  expect(result.items[0]?.reviewStatus).toBe('needs_rule_review');
  expect(result.items[0]?.observation).toBeNull();
  expect(result.items[0]?.endDate).toBe('2028-01-01T00:00:00Z');
  expect(index.search('rain', 'weather').items.map(row => row.eventId)).toEqual(['rain']);
  expect(index.search('rain', 'crypto').items).toEqual([]);
  expect(index.search('unmatched').status).toBe('ready');
  expect(index.search('unmatched').items).toEqual([]);
  result.items[0]!.title = 'changed';
  snapshot.events[0]!.title = 'changed too';
  expect(index.search('bitcoin').items[0]?.title).toBe(btc.title);
  const started = Date.parse(snapshot.startedAt);
  expect(index.search('bitcoin', undefined, started + 30 * 60_000).status).toBe('ready');
  expect(index.search('bitcoin', undefined, started + 30 * 60_000 + 1).status).toBe('degraded');
  expect(index.search('bitcoin', undefined, started + 24 * 60 * 60_000 + 1)).toMatchObject({ status: 'expired', items: [] });
});

it('retains closed child status and raw identities without inventing protocol or observation metadata', async () => {
  const path = await store();
  const raw = event('mixed', 'Bitcoin deadlines');
  raw.markets[0]!.closed = true;
  const unknown = { id: 'unknown', title: 'Rain today?', markets: [{ id: 'unknown-m', question: 'Rain today?' }] };
  const snapshot = await refreshCatalogue(path, { dataMode: 'synthetic', fetchImpl: async () => page([raw, unknown]) });
  expect(snapshot.events[0]?.markets[0]).toMatchObject({ closed: true, protocolVersion: 'v1', clobTokenIds: ['101', '102'] });
  expect(createCatalogueIndex(snapshot).search('Bitcoin').items).toEqual([]);
  expect(createCatalogueIndex(snapshot).search('rain').items[0]).toMatchObject({
    reviewStatus: 'needs_rule_review', observation: null,
    markets: [{ protocolVersion: null, clobTokenIds: null, outcomes: null, acceptingOrders: null }],
  });
});

it('refuses repeated cursors and page limits without publishing partial generations', async () => {
  const path = await store();
  await expect(refreshCatalogue(path, { dataMode: 'synthetic', fetchImpl: async () => page([btc], 'same') })).rejects.toThrow(/cursor/i);
  await expect(loadCatalogue(path)).rejects.toThrow();
  const limited = await store();
  await expect(refreshCatalogue(limited, { dataMode: 'synthetic', maxPages: 1, fetchImpl: async () => page([btc], 'next') })).rejects.toThrow(/page limit/i);
  await expect(loadCatalogue(limited)).rejects.toThrow();
  await expect(refreshCatalogue(limited, { dataMode: 'synthetic', fetchImpl: async () => Response.json({ events: null }) })).rejects.toThrow();
});

it('keeps large events discoverable without slicing them into an apparently supported partition', async () => {
  const path = await store();
  const large = event('large', 'Bitcoin daily ranges');
  large.markets = Array.from({ length: 9 }, (_, i) => ({ ...btc.markets[0]!, id: `market-${i}` }));
  const snapshot = await refreshCatalogue(path, { dataMode: 'synthetic', fetchImpl: async () => Response.json({ events: [large] }) });
  expect(createCatalogueIndex(snapshot).search('btc').items[0]).toMatchObject({
    eventId: 'large', marketCount: 9, availableMarketCount: 9,
    structureStatus: 'too_many_markets', markets: [], reviewStatus: 'needs_rule_review',
  });
});

it('allows only one writer and leaves an existing in-memory index usable after corrupt disk data', async () => {
  const path = await store();
  const snapshot = await refreshCatalogue(path, { dataMode: 'synthetic', fetchImpl: async () => page([btc]) });
  const index = createCatalogueIndex(snapshot);
  await writeFile(join(path, 'refresh.lock'), 'another writer');
  await expect(refreshCatalogue(path, { dataMode: 'synthetic', fetchImpl: async () => { throw new Error('should not fetch'); } })).rejects.toThrow(/lock|EEXIST/i);
  await writeFile(join(path, 'catalogue.json.gz'), 'corrupt');
  await expect(loadCatalogue(path)).rejects.toThrow();
  expect(index.search('btc').items[0]?.eventId).toBe('btc');
});
