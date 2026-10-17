import { catalogueEventUrl } from '@hedgenet/intake';
import { assertDemoAccess, errorResponse, RequestRejected } from '../../../lib/http.ts';
import { defaultDeps } from '../../../lib/live-intake.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cached discovery links only: not compatible hedges or inputs to the simulation. */
export async function GET(request: Request) {
  try {
    assertDemoAccess(request);
  } catch (error) {
    if (error instanceof RequestRejected) return errorResponse(error.status, error.code, error.message);
    return errorResponse(500, 'events_failed', 'Event discovery is unavailable.');
  }
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const catalogue = await defaultDeps.catalogue();
    const result = catalogue.search('bitcoin price', undefined, Date.now(), 'bitcoin');
    const real = result.dataMode === 'live' || result.dataMode === 'recorded';
    const events = real && result.status !== 'expired' ? result.items.flatMap(event => {
      const url = catalogueEventUrl(event.slug, result.dataMode);
      return url ? [{ eventId: event.eventId, title: event.title, url }] : [];
    }).slice(0, 3) : [];
    return Response.json({ ok: true, events, status: real ? result.status : 'unavailable',
      catalogue: { generationId: result.generationId, dataMode: result.dataMode } }, { headers });
  } catch {
    return Response.json({ ok: true, events: [], status: 'unavailable', catalogue: null }, { headers });
  }
}
