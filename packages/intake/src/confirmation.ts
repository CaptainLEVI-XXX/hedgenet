import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildScenarios, createValuationProblem, LossTemplateSchema, SettlementSchema } from '@hedgenet/core';
import { assertMarketSnapshotFresh } from '@hedgenet/venue';
import type { EventRules, MarketSnapshot } from '@hedgenet/venue';
import type { ExposureDraft } from './draft.ts';

const identity = z.string().min(1).max(256).refine(value => value === value.trim());
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const timezone = identity.refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } });
const observation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('point'), at: instant, timezone, statistic: z.literal('spot') }),
  z.strictObject({ kind: z.literal('window'), start: instant, end: instant, timezone,
    statistic: z.enum(['sum', 'maximum', 'minimum', 'mean', 'condition']) }),
]).refine(value => value.kind !== 'window' || value.start < value.end, 'Observation window must increase');
export const ExposureSemanticsSchema = z.strictObject({ observable: identity, unit: identity,
  location: identity.nullable(), resolutionSource: identity, observation });
export type ExposureSemantics = z.infer<typeof ExposureSemanticsSchema>;
const budget = z.string().max(25).regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{0,11}[1-9])?$/);
const reviewInput = z.strictObject({ semantics: ExposureSemanticsSchema, settlement: SettlementSchema,
  evidence: z.array(z.strictObject({ marketId: identity, quote: z.string().min(1).max(16000).refine(value => value.trim().length > 0) })).min(1).max(8) });
const reviewSchema = reviewInput.extend({ schemaVersion: z.literal('rule-review-v1'), eventId: identity,
  rulesHash: hashSchema, dataMode: z.enum(['synthetic', 'recorded', 'live']), contentHash: hashSchema });
export type RuleReview = z.infer<typeof reviewSchema>;
const acknowledgments = ['loss', 'budget', 'semantics', 'market_rules', 'normal_resolution_only', 'collateral_usd_parity'] as const;
const acknowledgmentSchema = z.array(z.enum(acknowledgments)).length(acknowledgments.length)
  .refine(values => new Set(values).size === acknowledgments.length, 'Every confirmation is required')
  .transform(values => values.sort());
const brief = { loss: LossTemplateSchema, semantics: ExposureSemanticsSchema, budgetUsd: budget };
const confirmationSchema = z.strictObject({ draftId: identity, expectedRevision: z.int().positive(), ...brief,
  eventId: identity, rulesHash: hashSchema, reviewHash: hashSchema, acknowledged: acknowledgmentSchema });
const confirmedSchema = z.strictObject({ schemaVersion: z.literal('confirmed-exposure-v1'), exposureId: z.uuid(),
  draftId: identity, revision: z.int().positive(), ...brief, eventId: identity, rulesHash: hashSchema, reviewHash: hashSchema,
  acknowledged: acknowledgmentSchema, confirmedAt: instant, contentHash: hashSchema });
export type ConfirmedExposure = z.infer<typeof confirmedSchema>;
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function verifyHash<T extends { contentHash: string }>(value: T): T {
  const { contentHash, ...body } = value;
  if (hash(body) !== contentHash) throw new Error('Content hash mismatch');
  return value;
}
function sameSemantics(left: ExposureSemantics, right: ExposureSemantics) {
  for (const key of Object.keys(left) as Array<keyof ExposureSemantics>) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) throw new Error(`Settlement ${key} mismatch`);
  }
}
function assertFuture(semantics: ExposureSemantics, now: number) {
  const end = semantics.observation.kind === 'point' ? semantics.observation.at : semantics.observation.end;
  if (!Number.isSafeInteger(now) || Date.parse(end) <= now) throw new Error('Observation has already ended');
}

/** Trusted operator boundary, never a raw browser/model payload. Excerpts prove provenance,
 * not semantic correctness. The operator must review all rules, including rounding/void behavior.
 */
export function createRuleReview(event: EventRules, input: unknown): RuleReview {
  const parsed = reviewInput.parse(input);
  const markets = parsed.settlement.kind === 'binary' ? [parsed.settlement] : parsed.settlement.buckets;
  if (parsed.settlement.kind === 'numeric_partition'
    && (markets.length !== event.markets.length || new Set(markets.map(market => market.marketId)).size !== markets.length)) {
    throw new Error('Numeric review must cover the complete event');
  }
  if (parsed.evidence.length !== markets.length || new Set(parsed.evidence.map(item => item.marketId)).size !== markets.length) {
    throw new Error('Rule evidence must cover each selected market exactly once');
  }
  for (const market of markets) {
    const source = event.markets.find(item => item.id === market.marketId);
    if (!source || source.version !== 'v1' || market.yesLegId !== `polymarket:ctf:${market.marketId}:yes`
      || market.noLegId !== `polymarket:ctf:${market.marketId}:no`
      || (parsed.settlement.kind === 'binary' && source.conditionId !== parsed.settlement.conditionId)) {
      throw new Error('Settlement identity mismatch');
    }
    const evidence = parsed.evidence.find(item => item.marketId === market.marketId);
    if (!evidence || !source.description.includes(evidence.quote)) throw new Error('Rule evidence does not match full market text');
  }
  const body = { ...parsed, schemaVersion: 'rule-review-v1' as const, eventId: event.id, rulesHash: event.rulesHash, dataMode: event.dataMode };
  return { ...body, contentHash: hash(body) };
}

/** Host owns draft/review and authenticates the user's explicit confirmation at the API boundary. */
export function confirmExposure(draft: ExposureDraft, input: unknown, reviewInput: unknown, now = Date.now()): ConfirmedExposure {
  const request = confirmationSchema.parse(input);
  const review = verifyHash(reviewSchema.parse(reviewInput));
  if (draft.draftId !== request.draftId || draft.revision !== request.expectedRevision) throw new Error('Draft revision mismatch');
  if (draft.status === 'unsupported') throw new Error('Revise unsupported exposure before confirming');
  if (request.eventId !== review.eventId || request.rulesHash !== review.rulesHash || request.reviewHash !== review.contentHash) {
    throw new Error('Confirmed market rules/review mismatch');
  }
  sameSemantics(request.semantics, review.semantics);
  if (request.loss.templateId === 'terminal_downside'
    && (request.semantics.unit !== 'USD' || request.semantics.observation.kind !== 'point' || request.semantics.location !== null)) {
    throw new Error('Asset downside requires a point USD price observation without a station');
  }
  if (['temperature', 'rainfall', 'precipitation'].includes(request.semantics.observable) && !request.semantics.location) {
    throw new Error('Weather observation requires a location/station');
  }
  assertFuture(request.semantics, now);
  buildScenarios(request.loss, review.settlement); // Reject mismatched conditions, gaps, overlaps and wrong domains before confirmation.
  const body = { schemaVersion: 'confirmed-exposure-v1' as const, exposureId: randomUUID(), draftId: draft.draftId,
    revision: draft.revision, loss: request.loss, semantics: request.semantics, budgetUsd: request.budgetUsd,
    eventId: request.eventId, rulesHash: request.rulesHash, reviewHash: request.reviewHash,
    acknowledged: request.acknowledged, confirmedAt: new Date(now).toISOString() };
  return { ...body, contentHash: hash(body) };
}

/** Explicit budget-only user action; no Jev call or change to approved semantics. */
export function reviseBudget(confirmedInput: unknown, input: unknown, now = Date.now()): ConfirmedExposure {
  const confirmed = verifyHash(confirmedSchema.parse(confirmedInput));
  const request = z.strictObject({ expectedRevision: z.int().positive(), budgetUsd: budget }).parse(input);
  if (confirmed.revision !== request.expectedRevision) throw new Error('Exposure revision mismatch');
  assertFuture(confirmed.semantics, now);
  const { contentHash: _, ...body } = confirmed;
  const next = { ...body, revision: body.revision + 1, budgetUsd: request.budgetUsd, confirmedAt: new Date(now).toISOString() };
  return { ...next, contentHash: hash(next) };
}

/** Trusted server assembly, not a proposer API. Still requires accepted-model coverage later. */
export function assembleConfirmedValuation(confirmedInput: unknown, reviewInput: unknown, snapshot: MarketSnapshot, now = Date.now()) {
  const confirmed = verifyHash(confirmedSchema.parse(confirmedInput));
  const review = verifyHash(reviewSchema.parse(reviewInput));
  assertMarketSnapshotFresh(snapshot, now);
  assertFuture(confirmed.semantics, now);
  if (confirmed.eventId !== snapshot.event.id || confirmed.rulesHash !== snapshot.event.rulesHash
    || confirmed.reviewHash !== review.contentHash || review.rulesHash !== snapshot.event.rulesHash
    || review.eventId !== snapshot.event.id || review.dataMode !== snapshot.event.dataMode) throw new Error('Snapshot rules/review mismatch');
  sameSemantics(confirmed.semantics, review.semantics);
  const scenarios = buildScenarios(confirmed.loss, review.settlement);
  if (scenarios.legs.length !== snapshot.legs.length) throw new Error('Snapshot leg identity mismatch');
  const valuation = createValuationProblem({ schemaVersion: 'valuation-v1', currency: 'USD', dataMode: snapshot.event.dataMode,
    snapshotId: snapshot.snapshotId, rulesHash: review.rulesHash, budgetUsd: confirmed.budgetUsd,
    states: scenarios.states.map(({ stateId, originalLossUsd }) => ({ stateId, originalLossUsd })),
    legs: scenarios.legs.map(leg => {
      const selected = snapshot.legs.find(item => item.legId === leg.legId);
      const book = snapshot.books.books.find(item => item.legId === leg.legId);
      if (!selected || !book) throw new Error('Snapshot leg identity mismatch');
      return { ...leg, minShares: book.minShares, asks: book.asks, fee: selected.fee };
    }),
  });
  return { schemaVersion: 'confirmed-valuation-v1' as const, exposureId: confirmed.exposureId, revision: confirmed.revision,
    exposureHash: confirmed.contentHash, reviewHash: review.contentHash, snapshotHash: snapshot.contentHash, scenarios, valuation };
}
