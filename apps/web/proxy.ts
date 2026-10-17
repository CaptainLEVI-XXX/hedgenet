import { NextResponse } from 'next/server';
import { assertDemoAccess, errorResponse, RequestRejected } from './lib/http.ts';

/** Covers pages, assets and APIs. Only the non-sensitive health probe is public. */
export function proxy(request: Request) {
  if (new URL(request.url).pathname === '/api/health') return NextResponse.next();
  try {
    assertDemoAccess(request);
    return NextResponse.next();
  } catch (error) {
    if (!(error instanceof RequestRejected)) throw error;
    const response = errorResponse(error.status, error.code, error.message);
    if (error.status === 401) response.headers.set('WWW-Authenticate', 'Basic realm="HedgeNet demo", charset="UTF-8"');
    return response;
  }
}
