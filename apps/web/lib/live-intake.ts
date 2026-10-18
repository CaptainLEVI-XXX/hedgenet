// Server-only live intake: Jev draft + cached-catalogue discovery. No proposal, no model, no solver.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createJevClient, intakeExposure } from '@hedgenet/intake';
import type { JevClient } from '@hedgenet/intake';
import { createCatalogueIndex, loadCatalogue } from '@hedgenet/venue';
import { RequestRejected } from './http.ts';

type CatalogueIndex = ReturnType<typeof createCatalogueIndex>;
export type LiveIntakeDeps = { client: () => JevClient | null; catalogue: () => Promise<CatalogueIndex>; now?: () => Date };

export const LIVE_INTAKE_MAX_CONCURRENCY = 2;
export const LIVE_TEXT_MAX_CHARS = 4000;
let inFlight = 0;

let cataloguePromise: Promise<CatalogueIndex> | null = null;
function catalogueDirectory() {
  const configured = process.env.HEDGENET_CATALOGUE_DIR;
  if (configured) return resolve(configured);
  const candidates = [resolve(process.cwd(), '.amp/in/catalogue'), resolve(process.cwd(), '../../.amp/in/catalogue')];
  return candidates.find(directory => existsSync(resolve(directory, 'catalogue.json.gz'))) ?? candidates[0]!;
}
async function defaultCatalogue() {
  // Load once per server process; a failed load is retried on the next explicit submission.
  cataloguePromise ??= loadCatalogue(catalogueDirectory()).then(createCatalogueIndex)
    .catch(error => { cataloguePromise = null; throw error; });
  return cataloguePromise;
}
function defaultClient(): JevClient | null {
  const apiKey = process.env.JEV_API_KEY;
  return apiKey && apiKey.trim() ? createJevClient({ apiKey }) : null;
}
export const defaultDeps: LiveIntakeDeps = { client: defaultClient, catalogue: defaultCatalogue };

const fieldLabels: Record<string, string> = {
  templateId: 'Loss formula', observable: 'Asset or measurement', observationDate: 'Observation date',
  observationKind: 'Observation type', direction: 'Loss direction', currency: 'Currency', units: 'Units held',
  referencePriceUsd: 'Reference price (USD)', threshold: 'Threshold', lossRateUsd: 'Loss per unit (USD)',
  maxLossUsd: 'Maximum loss (USD)', fixedLossUsd: 'Loss if it happens (USD)', budgetUsd: 'Hedge budget (USD)',
  conditionId: 'Condition', lossParameters: 'Loss amounts', observation: 'Observation time/window',
  resolutionSource: 'Resolution source', location: 'Location or station',
};
const label = (name: string) => fieldLabels[name] ?? name;

export function parseLiveInput(body: unknown) {
  if (!body || typeof body !== 'object') throw new RequestRejected(400, 'invalid_input', 'Send { text, timezone }.');
  const { text, timezone } = body as Record<string, unknown>;
  if (typeof text !== 'string' || !text.trim()) throw new RequestRejected(400, 'invalid_input', 'Describe your exposure first.');
  if (text.length > LIVE_TEXT_MAX_CHARS) throw new RequestRejected(400, 'text_too_long', `Keep the description under ${LIVE_TEXT_MAX_CHARS} characters.`);
  let zone = 'UTC';
  if (typeof timezone === 'string' && timezone.length <= 64) {
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); zone = timezone; } catch { zone = 'UTC'; }
  }
  return { text, timezone: zone };
}

/** Sanitized result: draft fields, missing info and discovery suggestions only. No provider bodies. */
export async function runLiveIntake(input: { text: string; timezone: string }, deps: LiveIntakeDeps = defaultDeps) {
  if (inFlight >= LIVE_INTAKE_MAX_CONCURRENCY) {
    throw new RequestRejected(429, 'intake_busy', 'Live intake is busy with other requests. Your text is kept; try again shortly.');
  }
  inFlight += 1;
  try {
    const client = deps.client();
    if (!client) throw new RequestRejected(503, 'jev_not_configured', 'Live intake is not configured on this server: the Jev key is missing. No interpretation ran.');
    let catalogue: CatalogueIndex;
    try { catalogue = await deps.catalogue(); }
    catch { throw new RequestRejected(503, 'catalogue_unavailable', 'The cached market catalogue could not be loaded. No interpretation ran.'); }
    let result: Awaited<ReturnType<typeof intakeExposure>>;
    try {
      result = await intakeExposure({ ...input, interpretedAt: (deps.now?.() ?? new Date()).toISOString() }, { catalogue, client });
    } catch (error) {
      if (error instanceof Error && /more than 30 candidate spans/.test(error.message)) {
        throw new RequestRejected(422, 'too_many_numbers', 'The description contains too many numbers and dates to interpret. Shorten it.');
      }
      throw new RequestRejected(502, 'intake_failed', 'Live intake failed unexpectedly. Your text is kept; try again.');
    }
    const { draft, discovery } = result;
    return {
      ok: true as const,
      mode: 'live' as const,
      interpretation: {
        status: draft.status,
        failure: draft.failure,
        fields: Object.entries(draft.fields).map(([name, field]) => ({
          name, label: label(name), value: field.value,
          source: field.provenance.kind === 'user_span' ? 'your-text' as const : 'suggested' as const,
          quoted: field.provenance.kind === 'user_span' ? field.provenance.raw : null,
        })),
        missing: draft.missingFields.map(name => ({ name, label: label(name) })),
        confirmed: false as const,
      },
      discovery: {
        status: discovery.status,
        failure: discovery.failure,
        catalogue: discovery.catalogue && { generationId: discovery.catalogue.generationId, dataMode: discovery.catalogue.dataMode,
          status: discovery.catalogue.status, ageMinutes: Math.round(discovery.catalogue.ageMs / 60_000) },
        consideredCount: discovery.consideredEventIds.length,
        suggestions: discovery.suggestions.map(item => ({ eventId: item.eventId, title: item.title,
          url: item.url, relevance: Math.round(item.relevance * 100) / 100, reviewStatus: item.reviewStatus })),
      },
      model: { status: 'unavailable' as const, message: 'No neural model is available for this exposure and real-market rules. The BTC demo uses a separate synthetic fixture; your request has not been changed to fit it.' },
      proposal: null,
      durationMs: Math.round(result.durationMs),
    };
  } finally { inFlight -= 1; }
}

export type LiveIntakeResult = Awaited<ReturnType<typeof runLiveIntake>>;
