// Host-owned, short-lived discovery state. A token permits reads, never confirmation.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { catalogueEventUrl } from '@hedgenet/intake';
import type { ExposureDraft } from '@hedgenet/intake';
import { assertMarketSnapshotFresh, fetchEventRules, fetchMarketSnapshot, MarketSnapshotError } from '@hedgenet/venue';
import type { MarketSnapshot } from '@hedgenet/venue';
import { RequestRejected } from './http.ts';

type Selection = { draft: ExposureDraft; eventIds: string[]; expiresAt: number };
const shared = globalThis as typeof globalThis & { hedgeNetSelections?: Map<string, Selection> };
const selections = shared.hedgeNetSelections ??= new Map<string, Selection>();
export function rememberLiveSelection(draft: ExposureDraft, eventIds: string[]): string {
  const now = Date.now();
  for (const [token, entry] of selections) if (entry.expiresAt <= now) selections.delete(token);
  while (selections.size >= 100) selections.delete(selections.keys().next().value!);
  const token = randomUUID();
  selections.set(token, { draft: structuredClone(draft), eventIds: [...eventIds], expiresAt: now + 10 * 60_000 });
  return token;
}

export type LiveMarketResult = { ok: true; event: { eventId: string; title: string; url: string | null };
  fetchedAt: string; snapshotId: string | null; status: 'books_ready' | 'review_only'; reason: string | null;
  markets: Array<{ marketId: string; question: string; url: string | null; description: string;
    yesAsk: string | null; noAsk: string | null; fee: string | null }> };
const requestSchema = z.strictObject({ selectionToken: z.uuid(), eventId: z.string().max(80).regex(/^[1-9]\d*$/) });
let inFlight = 0;

export async function inspectLiveMarket(input: unknown, fetchImpl: typeof fetch = fetch): Promise<LiveMarketResult> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new RequestRejected(400, 'invalid_selection', 'Choose an event from your exposure results.');
  const { selectionToken, eventId } = parsed.data;
  const selection = selections.get(selectionToken);
  if (!selection || selection.expiresAt <= Date.now()) {
    selections.delete(selectionToken);
    throw new RequestRejected(410, 'selection_expired', 'This selection expired or the server restarted. Submit your exposure again.');
  }
  if (!selection.eventIds.includes(eventId)) throw new RequestRejected(403, 'event_not_selected', 'This event was not suggested for your exposure.');
  if (inFlight >= 2) throw new RequestRejected(429, 'market_read_busy', 'Market reads are busy. Try again shortly.');
  inFlight++;
  try {
    let event = await fetchEventRules(eventId, { dataMode: 'live', fetchImpl });
    let snapshot: MarketSnapshot | null = null;
    let reason: string | null = null;
    if (event.markets.length > 8) reason = 'This event exceeds the current 8-market sizing limit. No markets were silently dropped.';
    else {
      try {
        snapshot = await fetchMarketSnapshot({ eventId, expectedRulesHash: event.rulesHash,
          marketIds: event.markets.map(market => market.id) }, { dataMode: 'live', fetchImpl });
        assertMarketSnapshotFresh(snapshot);
        event = snapshot.event;
      } catch (error) {
        if (error instanceof MarketSnapshotError && ['market_unavailable', 'unsupported_market', 'fee_unavailable', 'constraints_changed'].includes(error.code)) {
          reason = `${error.code}: ${error.message}`;
        } else if (error instanceof MarketSnapshotError && error.code === 'rules_changed') {
          throw new RequestRejected(409, 'rules_changed', 'The published rules changed while reading. Select the event again.');
        } else throw error;
      }
    }
    const url = event.slug === null ? null : catalogueEventUrl(event.slug, 'live');
    return { ok: true, event: { eventId, title: event.title, url }, fetchedAt: new Date(snapshot?.books.fetchedAtMs ?? event.fetchedAtMs).toISOString(),
      snapshotId: snapshot?.snapshotId ?? null, status: snapshot ? 'books_ready' : 'review_only', reason,
      markets: event.markets.map(market => {
        const selected = snapshot?.legs.filter(leg => leg.marketId === market.id);
        const ask = (side: 'YES' | 'NO') => snapshot?.books.books.find(book => book.legId === selected?.find(leg => leg.side === side)?.legId)?.asks[0]?.price ?? null;
        const marketUrl = !url ? null : market.slug === null ? url
          : /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(market.slug) ? `${url}/${market.slug}` : null;
        return { marketId: market.id, question: market.question, description: market.description, url: marketUrl,
          yesAsk: ask('YES'), noAsk: ask('NO'), fee: market.fee?.kind === 'none' ? 'No trading fee'
            : market.fee?.kind === 'curve' ? `Taker fee: shares × ${market.fee.rate} × price × (1 − price)` : null };
      }) };
  } catch (error) {
    if (error instanceof RequestRejected) throw error;
    throw new RequestRejected(503, 'market_data_unavailable', 'Fresh market rules or books could not be verified. No hedge was generated.');
  } finally { inFlight--; }
}
