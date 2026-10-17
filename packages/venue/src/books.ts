import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const endpoint = 'https://clob.polymarket.com/books';
// Normalize wire spelling, never round: the evaluator's scalar range is 12+12 digits.
const decimal = z.string().max(25).regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/)
  .transform(value => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);
const price = decimal.refine(value => value.startsWith('0.') && value !== '0', 'Price must be between zero and one');
const level = z.strictObject({ price, size: decimal });
const condition = z.string().regex(/^0x[a-f0-9]{64}$/);
const asset = z.string().regex(/^[1-9]\d{0,77}$/);
const leg = z.strictObject({ legId: z.string().min(1).max(200), protocol: z.literal('ctf'), assetId: asset, conditionId: condition });
const selection = z.array(leg).min(1).max(16).refine(legs =>
  new Set(legs.map(leg => leg.legId)).size === legs.length && new Set(legs.map(leg => leg.assetId)).size === legs.length,
  'Leg and asset identities must be unique');
const rawBook = z.object({
  market: condition, asset_id: asset, timestamp: z.string().regex(/^\d{1,16}$/).nullish(),
  hash: z.string().min(1), bids: z.array(level).max(1000), asks: z.array(level).max(1000),
  min_order_size: decimal, tick_size: price, neg_risk: z.boolean(),
});
const normalizedBook = leg.extend({
  venueTimestamp: z.string().nullable(), bookHash: z.string().min(1),
  asks: z.array(level).max(1000), bids: z.array(level).max(1000), minShares: decimal, tickSize: price, negRisk: z.boolean(),
});
const bodySchema = z.strictObject({
  schemaVersion: z.literal('books-v1'), snapshotId: z.uuid(), dataMode: z.enum(['live', 'recorded', 'synthetic']),
  source: z.literal(endpoint), fetchStartedAtMs: z.int().nonnegative(), fetchedAtMs: z.int().nonnegative(),
  books: z.array(normalizedBook).min(1).max(16), raw: z.array(z.json()).min(1).max(16),
});
const snapshotSchema = bodySchema.extend({ contentHash: z.string().regex(/^[a-f0-9]{64}$/) });
export type BookSnapshot = z.infer<typeof snapshotSchema>;

function units(value: string): bigint {
  const [integer, fraction = ''] = value.split('.');
  return BigInt(`${integer}${fraction.padEnd(12, '0')}`);
}
function ascending(a: { price: string }, b: { price: string }) {
  const left = units(a.price), right = units(b.price);
  return left < right ? -1 : left > right ? 1 : 0;
}
function hash(body: z.infer<typeof bodySchema>) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/** Recheck at result completion. The host must own the snapshot; hashes are not authentication. */
export function assertBooksFresh(input: unknown, now = Date.now()): BookSnapshot {
  const { contentHash, ...body } = snapshotSchema.parse(input);
  if (hash(body) !== contentHash) throw new Error('Book snapshot hash mismatch');
  if (body.fetchedAtMs < body.fetchStartedAtMs || body.fetchedAtMs - body.fetchStartedAtMs > 5000) {
    throw new Error('Book fetch span exceeds policy');
  }
  if (!Number.isSafeInteger(now) || now < body.fetchedAtMs) throw new Error('Book snapshot time is in the future');
  if (now - body.fetchStartedAtMs > 30_000) throw new Error('Book snapshot is stale');
  return { ...body, contentHash };
}

/** Only reads books. Rules, explicit fees, protocol support and semantic compatibility are separate gates. */
export async function fetchBookSnapshot(input: unknown, options: {
  dataMode: BookSnapshot['dataMode']; fetchImpl?: typeof fetch;
}): Promise<BookSnapshot> {
  const legs = selection.parse(input);
  if (options.dataMode !== 'live' && !options.fetchImpl) throw new Error('Recorded/synthetic books require an explicit data source');
  const fetchStartedAtMs = Date.now();
  const response = await (options.fetchImpl ?? fetch)(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
    body: JSON.stringify(legs.map(leg => ({ token_id: leg.assetId }))),
  });
  if (!response.ok) throw new Error(`CLOB books HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Book response exceeds size limit');
  const raw: unknown = JSON.parse(text);
  const parsed = z.array(rawBook).min(1).max(16).parse(raw);
  const byAsset = new Map(parsed.map(book => [book.asset_id, book]));
  if (parsed.length !== legs.length || byAsset.size !== legs.length) throw new Error('Missing or duplicate book identities');
  const books = legs.map(leg => {
    const book = byAsset.get(leg.assetId);
    if (!book || book.market !== leg.conditionId) throw new Error('Unexpected asset or condition identity');
    if ([...book.asks, ...book.bids].some(level => units(level.price) % units(book.tick_size) !== 0n)) {
      throw new Error('Book price violates tick size');
    }
    return { ...leg, venueTimestamp: book.timestamp ?? null, bookHash: book.hash,
      asks: book.asks.sort(ascending), bids: book.bids.sort((a, b) => ascending(b, a)),
      minShares: book.min_order_size, tickSize: book.tick_size, negRisk: book.neg_risk };
  });
  const body = bodySchema.parse({ schemaVersion: 'books-v1', snapshotId: randomUUID(), dataMode: options.dataMode,
    source: endpoint, fetchStartedAtMs, fetchedAtMs: Date.now(), books, raw });
  return assertBooksFresh({ ...body, contentHash: hash(body) });
}
