import { afterEach, expect, it, vi } from 'vitest';
import { assertSameOrigin, guardedJson } from '../../apps/web/lib/http.ts';
import { proxy } from '../../apps/web/proxy.ts';

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
const password = 'server-only-secret';
const request = (path = '/', headers: Record<string, string> = {}) => new Request(`http://internal:3000${path}`, {
  method: path.startsWith('/api/') ? 'POST' : 'GET',
  headers: { host: 'internal:3000', origin: 'https://demo.example', ...headers },
});
const auth = { authorization: `Basic ${Buffer.from(`demo:${password}`).toString('base64')}` };

it('accepts only the exact configured HTTPS origin behind a proxy, never forwarded hosts', () => {
  vi.stubEnv('HEDGENET_PUBLIC_ORIGIN', 'https://demo.example');
  expect(() => assertSameOrigin(request('/api/preview'))).not.toThrow();
  for (const origin of ['https://evil.example', 'https://demo.example:444', 'http://demo.example', 'https://demo.example/']) {
    expect(() => assertSameOrigin(request('/api/preview', { origin, 'x-forwarded-host': 'demo.example' }))).toThrow();
  }
  vi.stubEnv('HEDGENET_PUBLIC_ORIGIN', 'http://demo.example');
  expect(() => assertSameOrigin(request('/api/preview'))).toThrow();
  vi.stubEnv('HEDGENET_PUBLIC_ORIGIN', '');
  expect(() => assertSameOrigin(request('/api/preview', { host: 'demo.example' }))).toThrow();
});

it('protects pages, assets, and APIs; fails closed without a password; health is exempt', () => {
  vi.stubEnv('HEDGENET_PUBLIC_ORIGIN', 'https://demo.example');
  vi.stubEnv('HEDGENET_DEMO_PASSWORD', '');
  expect(proxy(request()).status).toBe(503);
  expect(proxy(request('/api/health')).status).toBe(200);
  vi.stubEnv('HEDGENET_DEMO_PASSWORD', password);
  for (const path of ['/', '/nested', '/_next/static/app.js', '/api/intake']) {
    const denied = proxy(request(path));
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain('Basic');
    expect(proxy(request(path, auth)).status).toBe(200);
    expect(proxy(request(path, { authorization: `Basic ${Buffer.from(`other:${password}`).toString('base64')}` })).status).toBe(401);
  }
});

it('caps aggregate paid calls across endpoints and resets the short window without capping previews', async () => {
  vi.stubEnv('HEDGENET_PUBLIC_ORIGIN', 'https://demo.example');
  vi.stubEnv('HEDGENET_DEMO_PASSWORD', password);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  const paid = (path: string) => new Request(`http://internal:3000${path}`, { method: 'POST', body: '{}', headers: {
    ...auth, origin: 'https://demo.example', 'content-type': 'application/json',
  } });
  for (let i = 0; i < 10; i++) await guardedJson(paid(i % 2 ? '/api/intake' : '/api/neural'), 100);
  await expect(guardedJson(paid('/api/intake'), 100)).rejects.toMatchObject({ status: 429 });
  await expect(guardedJson(paid('/api/preview'), 100)).resolves.toEqual({});
  vi.advanceTimersByTime(60_000);
  await expect(guardedJson(paid('/api/neural'), 100)).resolves.toEqual({});
  for (let i = 11; i < 100; i++) {
    vi.advanceTimersByTime(60_000);
    await guardedJson(paid('/api/intake'), 100);
  }
  vi.advanceTimersByTime(60_000);
  await expect(guardedJson(paid('/api/neural'), 100)).rejects.toMatchObject({ status: 429 });
  vi.advanceTimersByTime(86_400_000);
  await expect(guardedJson(paid('/api/neural'), 100)).resolves.toEqual({});
});
