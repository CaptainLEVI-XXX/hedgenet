import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertBooksFresh, fetchBookSnapshot } from './books.ts';
import type { BookSnapshot } from './books.ts';

type Fee = { kind: 'none' } | { kind: 'curve'; rate: string; exponent: 1 };
type ReadOptions = { dataMode: BookSnapshot['dataMode']; fetchImpl?: typeof fetch };
type BlockCode = 'rules_changed' | 'market_unavailable' | 'unsupported_market' | 'fee_unavailable'
  | 'constraints_changed' | 'dependency_unavailable' | 'invalid_data';
export class MarketSnapshotError extends Error {
  readonly code: BlockCode;
  constructor(code: BlockCode, message: string) { super(message); this.name = 'MarketSnapshotError'; this.code = code; }
}
const id = z.string().max(80).regex(/^[1-9]\d*$/);
const flag = z.boolean().nullish().transform(value => value ?? null);
const text = z.string().nullish().transform(value => value ?? '');
const optionalText = z.string().nullish().transform(value => value || null);
const decimal = z.string().max(25).regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/)
  .transform(value => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);
const optionalDecimal = z.unknown().optional().transform(value => {
  const parsed = decimal.safeParse(value);
  return parsed.success ? parsed.data : null;
});
const encodedArray = z.unknown().optional().transform(value => {
  try {
    const parsed = z.array(z.string().min(1)).safeParse(typeof value === 'string' ? JSON.parse(value) : value);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
});
const rawMarket = z.object({
  id, question: text, description: text, resolutionSource: optionalText, endDate: optionalText,
  conditionId: optionalText, questionID: optionalText, groupItemTitle: text, groupItemThreshold: optionalText,
  version: optionalText, outcomes: encodedArray, clobTokenIds: encodedArray, positionIds: encodedArray,
  active: flag, closed: flag, archived: flag, acceptingOrders: flag, enableOrderBook: flag,
  negRisk: flag, negRiskOther: flag, negRiskMarketID: optionalText,
  orderMinSize: optionalDecimal, orderPriceMinTickSize: optionalDecimal,
  feesEnabled: flag, feeSchedule: z.unknown().optional(),
});
const rawEvent = z.object({
  id, title: z.string().min(1), description: text, resolutionSource: optionalText, endDate: optionalText,
  active: flag, closed: flag, archived: flag, negRisk: flag, negRiskAugmented: flag,
  negRiskMarketID: optionalText, markets: z.array(rawMarket).min(1),
});
const schedule = z.object({ rate: decimal, exponent: z.literal('1'), takerOnly: z.literal(true) });

function readFee(enabled: boolean | null, input: unknown): { fee: Fee | null; feeIssue: string | null } {
  if (enabled === false) {
    const zero = z.object({ rate: decimal }).safeParse(input);
    if (input == null || (zero.success && zero.data.rate === '0')) return { fee: { kind: 'none' }, feeIssue: null };
    return { fee: null, feeIssue: 'Disabled fees conflict with the supplied schedule' };
  }
  if (enabled !== true || input == null) return { fee: null, feeIssue: 'Fee configuration is unknown' };
  const parsed = schedule.safeParse(input);
  if (!parsed.success) return { fee: null, feeIssue: 'Unsupported fee schedule or decimal precision' };
  return { fee: { kind: 'curve', rate: parsed.data.rate, exponent: 1 }, feeIssue: null };
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** Full source text for review, not parsed settlement semantics or exposure compatibility. */
export async function fetchEventRules(eventId: string, options: ReadOptions) {
  id.parse(eventId);
  if (options.dataMode !== 'live' && !options.fetchImpl) throw new Error('Recorded/synthetic rules require an explicit data source');
  const source = `https://gamma-api.polymarket.com/events/${eventId}`;
  const fetchStartedAtMs = Date.now();
  const response = await (options.fetchImpl ?? fetch)(source, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new MarketSnapshotError('dependency_unavailable', `Gamma event HTTP ${response.status}`);
  const rawText = await response.text();
  if (Buffer.byteLength(rawText) > 16 * 1024 * 1024) throw new MarketSnapshotError('invalid_data', 'Event response exceeds size limit');
  // Node 24 supplies the original JSON number token: never recover money from a rounded Number.
  const raw: unknown = JSON.parse(rawText, (_key: string, value: unknown, context?: { source: string }) => {
    if (typeof value !== 'number') return value;
    if (!context?.source) throw new Error('Exact numeric JSON decoding requires Node 24');
    return context.source;
  });
  const event = rawEvent.parse(raw);
  if (event.id !== eventId) throw new MarketSnapshotError('invalid_data', 'Event identity mismatch');
  if (new Set(event.markets.map(market => market.id)).size !== event.markets.length) {
    throw new MarketSnapshotError('invalid_data', 'Duplicate market identities');
  }
  event.markets.sort((a, b) => a.id.localeCompare(b.id));
  const markets = event.markets.map(({ feeSchedule, feesEnabled, ...market }) => ({ ...market,
    observation: null, ...readFee(feesEnabled, feeSchedule) }));
  // Only resolution/identity fields participate. Quotes, volumes, status and fees may change independently.
  const rulesHash = hash({ parserVersion: 'gamma-rules-v1', eventId, title: event.title, description: event.description,
    resolutionSource: event.resolutionSource, endDate: event.endDate, negRisk: event.negRisk,
    negRiskAugmented: event.negRiskAugmented, negRiskMarketID: event.negRiskMarketID,
    markets: markets.map(market => ({ id: market.id, question: market.question, description: market.description,
      resolutionSource: market.resolutionSource, endDate: market.endDate, conditionId: market.conditionId,
      questionID: market.questionID, groupItemTitle: market.groupItemTitle, groupItemThreshold: market.groupItemThreshold,
      version: market.version, outcomes: market.outcomes, clobTokenIds: market.clobTokenIds, positionIds: market.positionIds,
      negRisk: market.negRisk, negRiskOther: market.negRiskOther, negRiskMarketID: market.negRiskMarketID })) });
  const fetchedAtMs = Date.now();
  if (fetchedAtMs < fetchStartedAtMs || fetchedAtMs - fetchStartedAtMs > 8000) {
    throw new MarketSnapshotError('dependency_unavailable', 'Event fetch span exceeds policy');
  }
  return { ...event, markets, schemaVersion: 'event-rules-v1' as const, rulesHash,
    dataMode: options.dataMode, source, fetchStartedAtMs, fetchedAtMs, rawText };
}
export type EventRules = Awaited<ReturnType<typeof fetchEventRules>>;
type SelectedLeg = { marketId: string; side: 'YES' | 'NO'; legId: string; protocol: 'ctf';
  assetId: string; conditionId: string; fee: Fee };
export type MarketSnapshot = { schemaVersion: 'market-snapshot-v1'; snapshotId: string;
  reviewStatus: 'needs_semantic_review'; event: EventRules; legs: SelectedLeg[]; books: BookSnapshot; contentHash: string };

/** For host-owned snapshots only; hashes detect drift, not a malicious caller recomputing them. */
export function assertMarketSnapshotFresh(snapshot: MarketSnapshot, now = Date.now()): void {
  const { contentHash, ...body } = snapshot;
  if (hash(body) !== contentHash) throw new MarketSnapshotError('invalid_data', 'Market snapshot hash mismatch');
  assertBooksFresh(snapshot.books, now);
  if (now < snapshot.event.fetchedAtMs || now - snapshot.event.fetchStartedAtMs > 30_000) {
    throw new MarketSnapshotError('market_unavailable', 'Event snapshot is stale or from the future');
  }
}

/** Re-fetch confirmed rules and all selected outcomes. This does not verify a numeric partition. */
export async function fetchMarketSnapshot(input: unknown, options: ReadOptions): Promise<MarketSnapshot> {
  const selection = z.strictObject({ eventId: id, expectedRulesHash: z.string().regex(/^[a-f0-9]{64}$/),
    marketIds: z.array(id).min(1).max(8).refine(ids => new Set(ids).size === ids.length, 'Duplicate selected markets'),
  }).parse(input);
  const event = await fetchEventRules(selection.eventId, options);
  if (event.rulesHash !== selection.expectedRulesHash) throw new MarketSnapshotError('rules_changed', 'Resolution rules changed; confirmation is invalid');
  if (event.active !== true || event.closed !== false || event.archived === true) {
    throw new MarketSnapshotError('market_unavailable', 'Event is unavailable or its status is unknown');
  }
  const legs: SelectedLeg[] = [];
  for (const marketId of [...selection.marketIds].sort()) {
    const market = event.markets.find(market => market.id === marketId);
    if (!market) throw new MarketSnapshotError('invalid_data', 'Selected market does not belong to event');
    if (market.active !== true || market.closed !== false || market.archived === true
      || market.acceptingOrders !== true || market.enableOrderBook !== true) {
      throw new MarketSnapshotError('market_unavailable', 'Selected market is unavailable or its status is unknown');
    }
    if (market.version !== 'v1' || !/^0x[a-f0-9]{64}$/.test(market.conditionId ?? '') || market.negRiskOther === true
      || market.outcomes?.length !== 2 || market.clobTokenIds?.length !== 2
      || new Set(market.clobTokenIds).size !== 2 || market.clobTokenIds.some(token => !/^[1-9]\d{0,77}$/.test(token))
      || new Set(market.outcomes.map(label => label.toLowerCase())).size !== 2
      || !market.outcomes.every(label => /^(yes|no)$/i.test(label)) || !market.description.trim()) {
      throw new MarketSnapshotError('unsupported_market', 'Selected market requires known CTF YES/NO identities and full rules');
    }
    if (!market.fee) throw new MarketSnapshotError('fee_unavailable', market.feeIssue ?? 'Unknown fee');
    if (market.orderMinSize === null || market.orderPriceMinTickSize === null || market.negRisk === null) {
      throw new MarketSnapshotError('constraints_changed', 'Selected trading constraints are unknown');
    }
    for (const side of ['YES', 'NO'] as const) {
      const assetId = market.clobTokenIds[market.outcomes.findIndex(label => label.toUpperCase() === side)]!;
      legs.push({ marketId, side, protocol: 'ctf', conditionId: market.conditionId!, assetId,
        legId: `polymarket:ctf:${marketId}:${side.toLowerCase()}`, fee: market.fee });
    }
  }
  const books = await fetchBookSnapshot(legs.map(({ legId, protocol, assetId, conditionId }) =>
    ({ legId, protocol, assetId, conditionId })), options);
  for (const leg of legs) {
    const market = event.markets.find(market => market.id === leg.marketId)!;
    const book = books.books.find(book => book.legId === leg.legId)!;
    if (book.minShares !== market.orderMinSize || book.tickSize !== market.orderPriceMinTickSize || book.negRisk !== market.negRisk) {
      throw new MarketSnapshotError('constraints_changed', 'Gamma and order-book trading constraints disagree');
    }
  }
  const body = { schemaVersion: 'market-snapshot-v1' as const, snapshotId: randomUUID(),
    reviewStatus: 'needs_semantic_review' as const, event, legs, books };
  const snapshot = { ...body, contentHash: hash(body) };
  assertMarketSnapshotFresh(snapshot);
  return snapshot;
}
