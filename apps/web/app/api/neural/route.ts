import { buildNeuralPreview, NeuralBusyError, NeuralInputError, NeuralUnavailableError } from '../../../lib/neural.ts';
import { errorResponse, guardedJson, RequestRejected } from '../../../lib/http.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 240;

export async function POST(request: Request) {
  try {
    const preview = await buildNeuralPreview(await guardedJson(request, 2048));
    return Response.json({ ok: true, preview }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof RequestRejected) return errorResponse(error.status, error.code, error.message);
    if (error instanceof NeuralInputError) return errorResponse(400, 'outside_neural_range', error.message);
    if (error instanceof NeuralBusyError) return errorResponse(409, 'neural_busy', 'Another neural operation is running. Try again after it finishes.');
    if (error instanceof NeuralUnavailableError) return errorResponse(503, 'model_unavailable', 'Neural serving is unavailable. Check the local serving setup.');
    return errorResponse(502, 'inference_failed', 'The neural result failed trusted verification. No fallback was used.');
  }
}
