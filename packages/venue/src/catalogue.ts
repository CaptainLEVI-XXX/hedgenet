import { createHash } from 'node:crypto';
import { z } from 'zod';

export const gammaEndpoint = 'https://gamma-api.polymarket.com/events/keyset';
export const catalogueMaxAgeMs = 24 * 60 * 60_000;
const identity = z.string().min(1);
const text = z.string().nullish().transform(value => value ?? '');
const flag = z.boolean().nullish().transform(value => value ?? null);
const nullableText = z.string().nullish().transform(value => value || null);
const stringArray = z.array(identity);
const encodedArray = z.unknown().optional().transform(value => {
  try {
    const parsed = stringArray.safeParse(typeof value === 'string' ? JSON.parse(value) : value);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
});

const marketSchema = z.strictObject({
  marketId: identity, question: z.string(), description: z.string(),
  descriptionTruncated: z.boolean(),
  descriptionHash: z.string().regex(/^[a-f0-9]{64}$/), resolutionSource: z.string().nullable(),
  active: z.boolean().nullable(), closed: z.boolean().nullable(), acceptingOrders: z.boolean().nullable(),
  endDate: z.string().nullable(), protocolVersion: z.string().nullable(),
  clobTokenIds: stringArray.nullable(), outcomes: stringArray.nullable(),
});
export const catalogueEventSchema = z.strictObject({
  eventId: identity, title: identity, slug: z.string(), description: z.string(),
  descriptionTruncated: z.boolean(), marketCount: z.int().nonnegative(), availableMarketCount: z.int().nonnegative(),
  structureStatus: z.enum(['within_count_limit', 'too_many_markets']),
  categories: z.array(z.string()), active: z.boolean().nullable(), closed: z.boolean().nullable(),
  endDate: z.string().nullable(), reviewStatus: z.literal('needs_rule_review'), observation: z.null(),
  markets: z.array(marketSchema),
});
export const catalogueSchema = z.strictObject({
  schemaVersion: z.literal('catalogue-v1'), parserVersion: z.literal('gamma-discovery-v2'),
  generationId: z.uuid(), dataMode: z.enum(['live', 'recorded', 'synthetic']),
  source: z.literal(gammaEndpoint), coverage: z.literal('completed-open-event-walk'),
  startedAt: z.iso.datetime(), completedAt: z.iso.datetime(), pages: z.int().positive(),
  events: z.array(catalogueEventSchema),
});
export type Catalogue = z.infer<typeof catalogueSchema>;
export type CatalogueEvent = z.infer<typeof catalogueEventSchema>;

const rawMarket = z.object({
  id: identity, question: text, description: text, resolutionSource: nullableText,
  active: flag, closed: flag, acceptingOrders: flag, endDate: nullableText,
  version: nullableText, clobTokenIds: encodedArray, outcomes: encodedArray,
});
const rawEvent = z.object({
  id: identity, title: identity, slug: text, description: text,
  active: flag, closed: flag, endDate: nullableText,
  tags: z.array(z.object({ slug: text, label: text })).nullish(),
  markets: z.array(rawMarket).nullish(),
});
export const gammaPageSchema = z.object({
  events: z.array(rawEvent).max(100), next_cursor: identity.nullish(),
}).transform(page => ({
  nextCursor: page.next_cursor ?? null,
  events: page.events.map(event => ({
    eventId: event.id, title: event.title, slug: event.slug, description: event.description.slice(0, 1024),
    descriptionTruncated: event.description.length > 1024,
    marketCount: (event.markets ?? []).length,
    availableMarketCount: (event.markets ?? []).filter(isAvailable).length,
    structureStatus: (event.markets ?? []).length > 8 ? 'too_many_markets' as const : 'within_count_limit' as const,
    categories: [...new Set((event.tags ?? []).flatMap(tag => [tag.slug, tag.label]).filter(Boolean))],
    active: event.active, closed: event.closed, endDate: event.endDate,
    reviewStatus: 'needs_rule_review' as const, observation: null,
    // Keep oversized parents searchable, but never imply a sliced subset is a complete partition.
    markets: ((event.markets ?? []).length > 8 ? [] : event.markets ?? []).map(market => ({
      marketId: market.id, question: market.question, description: market.description.slice(0, 1024),
      descriptionTruncated: market.description.length > 1024,
      descriptionHash: createHash('sha256').update(market.description).digest('hex'),
      resolutionSource: market.resolutionSource, active: market.active, closed: market.closed,
      acceptingOrders: market.acceptingOrders, endDate: market.endDate,
      protocolVersion: market.version, clobTokenIds: market.clobTokenIds, outcomes: market.outcomes,
    })),
  })),
}));

const aliases: Record<string, string> = { btc: 'bitcoin', eth: 'ethereum', ether: 'ethereum' };
const stopwords = new Set('a an the i my me we our and or in on at of to for is it will be by with need hold hedge protection'.split(' '));
function isAvailable(market: { closed: boolean | null; active: boolean | null; acceptingOrders: boolean | null }) {
  return market.closed !== true && market.active !== false && market.acceptingOrders !== false;
}
function tokens(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(token => !stopwords.has(token)).map(token => aliases[token] ?? token))];
}

/** Discovery only. Unknown rules/identity remain unknown; no price or eligibility inference. */
export function createCatalogueIndex(input: Catalogue) {
  const snapshot = catalogueSchema.parse(input); // Own a copy; callers cannot mutate this generation.
  const postings = new Map<string, Set<number>>();
  snapshot.events.forEach((event, index) => {
    const open = event.markets.filter(isAvailable);
    if (event.closed === true || event.active === false || event.availableMarketCount === 0) return;
    for (const token of tokens([event.title, ...event.categories, ...open.map(market => market.question)].join(' '))) {
      if (!postings.has(token)) postings.set(token, new Set());
      postings.get(token)!.add(index);
    }
  });
  return {
    search(query: string, category?: string, now = Date.now()) {
      const ageMs = Math.max(0, now - Date.parse(snapshot.startedAt));
      const status = ageMs > catalogueMaxAgeMs ? 'expired' : ageMs > 30 * 60_000 ? 'degraded' : 'ready';
      const scores = new Map<number, number>();
      if (status !== 'expired') {
        for (const token of tokens(query)) {
          const matches = postings.get(token);
          if (!matches) continue;
          for (const index of matches) {
            const event = snapshot.events[index]!;
            if (category && !event.categories.some(value => value.toLowerCase() === category.toLowerCase())) continue;
            scores.set(index, (scores.get(index) ?? 0) + Math.log(1 + snapshot.events.length / matches.size));
          }
        }
      }
      const items = [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 20)
        .map(([index]) => structuredClone(snapshot.events[index]!));
      return { generationId: snapshot.generationId, dataMode: snapshot.dataMode, status, ageMs, items };
    },
  };
}
