import { afterEach, expect, it, vi } from 'vitest';
import { createCatalogueIndex } from '@hedgenet/venue';
import { gammaPageSchema } from '../../packages/venue/src/catalogue.ts';
import { defaultDeps } from '../../apps/web/lib/live-intake.ts';
import { GET } from '../../apps/web/app/api/events/route.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function catalogue(mode: 'live' | 'recorded' | 'synthetic' = 'recorded', age = 0) {
  const startedAt = new Date(Date.now() - age).toISOString();
  return createCatalogueIndex({ schemaVersion: 'catalogue-v1', parserVersion: 'gamma-discovery-v2',
    generationId: '00000000-0000-4000-8000-000000000000', dataMode: mode,
    source: 'https://gamma-api.polymarket.com/events/keyset', coverage: 'completed-open-event-walk',
    startedAt, completedAt: startedAt, pages: 1,
    events: gammaPageSchema.parse({ events: ['', '../bad', 'bitcoin-one', 'bitcoin-two', 'bitcoin-three', 'bitcoin-four'].map((slug, i) => ({
      id: String(i), title: 'Bitcoin price?', slug, active: true, closed: false,
      markets: [{ id: `m${i}`, question: 'Bitcoin price?', active: true, closed: false, acceptingOrders: true }],
    })).concat([{ id: 'eth', title: 'Ethereum price?', slug: 'ethereum', active: true, closed: false,
      markets: [{ id: 'eth-m', question: 'Ethereum price?', active: true, closed: false, acceptingOrders: true }] }]) }).events });
}
const request = () => new Request('http://localhost/api/events?query=ethereum');

it('returns at most three authoritative BTC links from the cached catalogue without Jev or fetch', async () => {
  vi.spyOn(defaultDeps, 'catalogue').mockResolvedValue(catalogue());
  const client = vi.spyOn(defaultDeps, 'client').mockImplementation(() => { throw new Error('no Jev'); });
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'));
  const result = await (await GET(request())).json();
  expect(result).toMatchObject({ ok: true, status: 'ready', catalogue: { dataMode: 'recorded' }, events: [
    { eventId: '2', title: 'Bitcoin price?', url: 'https://polymarket.com/event/bitcoin-one' },
    { eventId: '3', title: 'Bitcoin price?', url: 'https://polymarket.com/event/bitcoin-two' },
    { eventId: '4', title: 'Bitcoin price?', url: 'https://polymarket.com/event/bitcoin-three' },
  ] });
  expect(client).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
});

it('preserves degraded and expired status and withholds synthetic/missing links', async () => {
  const load = vi.spyOn(defaultDeps, 'catalogue');
  for (const [mode, age, status] of [['live', 31 * 60_000, 'degraded'], ['recorded', 24 * 60 * 60_000 + 1, 'expired'],
    ['synthetic', 0, 'unavailable']] as const) {
    load.mockResolvedValue(catalogue(mode, age));
    const body = await (await GET(request())).json();
    expect(body.status).toBe(status);
    expect(body.events).toHaveLength(status === 'degraded' ? 3 : 0);
  }
  load.mockRejectedValue(new Error('missing'));
  expect(await (await GET(request())).json()).toMatchObject({ ok: true, status: 'unavailable', events: [] });
});

it('explicitly authenticates before reading the catalogue', async () => {
  vi.stubEnv('HEDGENET_DEMO_PASSWORD', 'test-password');
  const load = vi.spyOn(defaultDeps, 'catalogue');
  expect((await GET(request())).status).toBe(401);
  expect(load).not.toHaveBeenCalled();
});
