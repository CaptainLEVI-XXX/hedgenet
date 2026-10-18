import { guardedJson, errorResponse, RequestRejected } from '../../../lib/http.ts';
import { inspectLiveMarket } from '../../../lib/live-market.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    return Response.json(await inspectLiveMarket(await guardedJson(request, 1024)), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof RequestRejected) return errorResponse(error.status, error.code, error.message);
    return errorResponse(503, 'market_data_unavailable', 'Market data is unavailable. No hedge was generated.');
  }
}
