import { buildPreview, PreviewInputError } from '../../../lib/preview.ts';
import { errorResponse, guardedJson, RequestRejected } from '../../../lib/http.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const MAX_BODY_BYTES = 1024;

/** Illustrative preview: fixed fictional allocation priced by the trusted evaluator. */
export async function POST(request: Request) {
  try {
    const body = await guardedJson(request, MAX_BODY_BYTES) as Record<string, unknown> | null;
    const example = body?.example;
    const revision = body?.revision;
    if (example !== 'crypto' && example !== 'weather') throw new PreviewInputError('Unknown illustrative example.');
    if (typeof revision !== 'number') throw new PreviewInputError('Invalid revision.');
    const preview = buildPreview({ example, budgetUsd: body?.budgetUsd as string, revision });
    return Response.json({ ok: true, preview }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof RequestRejected) return errorResponse(error.status, error.code, error.message);
    if (error instanceof PreviewInputError) return errorResponse(400, 'outside_preview_range', error.message);
    return errorResponse(500, 'evaluation_failed', 'The financial evaluator rejected this preview.');
  }
}
