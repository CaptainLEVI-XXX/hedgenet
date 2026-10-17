import { errorResponse, guardedJson, RequestRejected } from '../../../lib/http.ts';
import { parseLiveInput, runLiveIntake } from '../../../lib/live-intake.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const MAX_BODY_BYTES = 16 * 1024;

/** Live intake for explicit user submissions: sanitized draft + discovery; model unavailable. */
export async function POST(request: Request) {
  try {
    const input = parseLiveInput(await guardedJson(request, MAX_BODY_BYTES));
    return Response.json(await runLiveIntake(input), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof RequestRejected) return errorResponse(error.status, error.code, error.message);
    return errorResponse(500, 'intake_failed', 'Live intake failed unexpectedly. Your text is kept; try again.');
  }
}
