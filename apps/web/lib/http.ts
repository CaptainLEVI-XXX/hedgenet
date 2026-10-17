import { createHash, timingSafeEqual } from 'node:crypto';

// Server-only access controls. Never derive public trust from forwarded headers.

export class RequestRejected extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'RequestRejected'; }
}

export function errorResponse(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return Response.json({ ok: false, error: { code, message }, ...extra }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function publicOrigin(): string | null {
  const value = process.env.HEDGENET_PUBLIC_ORIGIN;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.origin === value) return value;
  } catch { /* Invalid configuration must not fall back to local mode. */ }
  throw new RequestRejected(503, 'access_not_configured', 'Public access is not configured.');
}

export function assertDemoAccess(request: Request) {
  const origin = publicOrigin();
  // Explicit opt-in opens the demo, not the separately authenticated model.
  if (process.env.HEDGENET_PUBLIC_DEMO === 'true') {
    if (!origin) throw new RequestRejected(503, 'access_not_configured', 'Public access is not configured.');
    return;
  }
  const password = process.env.HEDGENET_DEMO_PASSWORD;
  if (!origin && !password) return;
  if (!password) throw new RequestRejected(503, 'access_not_configured', 'Public access is not configured.');
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  const supplied = match ? Buffer.from(match[1]!, 'base64') : Buffer.alloc(0);
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(supplied), digest(`demo:${password}`))) {
    throw new RequestRejected(401, 'authentication_required', 'Demo authentication required.');
  }
}

/** Reject cross-site POSTs, retaining strict loopback checks outside public mode. */
export function assertSameOrigin(request: Request) {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new RequestRejected(403, 'cross_origin', 'Cross-origin requests are not accepted.');
  }
  const origin = request.headers.get('origin');
  const configured = publicOrigin();
  if (configured) {
    if (origin === configured) return;
    throw new RequestRejected(403, 'cross_origin', 'Cross-origin requests are not accepted.');
  }
  const host = request.headers.get('host');
  let parsedOrigin: URL | null = null;
  try { parsedOrigin = origin ? new URL(origin) : null; } catch { parsedOrigin = null; }
  // Private loopback demo: don't turn a rebound attacker hostname into an
  // authorized same-origin request to the local credential-bearing backend.
  if (!parsedOrigin || !host || parsedOrigin.host !== host
    || !['localhost', '127.0.0.1', '[::1]'].includes(parsedOrigin.hostname)
    || parsedOrigin.protocol !== new URL(request.url).protocol) {
    throw new RequestRejected(403, 'cross_origin', 'Cross-origin requests are not accepted.');
  }
}

/** Reads at most maxBytes of a JSON body; aborts early instead of buffering an oversized stream. */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    throw new RequestRejected(415, 'unsupported_media_type', 'Send application/json.');
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestRejected(413, 'body_too_large', 'Request body is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new RequestRejected(400, 'invalid_json', 'Request body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestRejected(413, 'body_too_large', 'Request body is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RequestRejected(400, 'invalid_json', 'Request body must be valid JSON.'); }
}

// Two fixed aggregate counters, not a client-keyed map: constant memory, one replica.
// Route bundles may load separate module instances; share state on the Node global.
type DemoCaps = { minute: { start: number; count: number }; day: { start: number; count: number } };
const processGlobal = globalThis as typeof globalThis & { __hedgenetDemoCaps?: DemoCaps };
const caps = processGlobal.__hedgenetDemoCaps ??= { minute: { start: 0, count: 0 }, day: { start: 0, count: 0 } };
function capPaidRequest(request: Request) {
  if (!publicOrigin() || !['/api/intake', '/api/neural'].includes(new URL(request.url).pathname)) return;
  const now = Date.now();
  if (now < caps.minute.start || now - caps.minute.start >= 60_000) caps.minute = { start: now, count: 0 };
  if (now < caps.day.start || now - caps.day.start >= 86_400_000) caps.day = { start: now, count: 0 };
  if (caps.minute.count >= 10 || caps.day.count >= 100) {
    throw new RequestRejected(429, 'demo_request_limit', 'Demo request limit reached. Try again later.');
  }
  caps.minute.count++;
  caps.day.count++;
}

export async function guardedJson(request: Request, maxBytes: number): Promise<unknown> {
  assertDemoAccess(request);
  assertSameOrigin(request);
  capPaidRequest(request);
  return readBoundedJson(request, maxBytes);
}
