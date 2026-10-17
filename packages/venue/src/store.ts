import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { z } from 'zod';
import { catalogueEventSchema, catalogueMaxAgeMs, catalogueSchema, createCatalogueIndex, gammaEndpoint, gammaPageSchema } from './catalogue.ts';
import type { Catalogue, CatalogueEvent } from './catalogue.ts';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const checkpointSchema = z.strictObject({
  parserVersion: z.literal('gamma-discovery-v2'),
  generationId: z.uuid(), startedAt: z.iso.datetime(), dataMode: z.enum(['live', 'recorded', 'synthetic']),
  pages: z.int().nonnegative(), nextCursor: z.string().min(1).nullable(), cursors: z.array(z.string().min(1)),
});

async function atomicWrite(path: string, data: string | Uint8Array) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
async function readGzip(path: string): Promise<unknown> {
  return JSON.parse((await decompress(await readFile(path), { maxOutputLength: 128 * 1024 * 1024 })).toString('utf8'));
}
export async function loadCatalogue(directory: string): Promise<Catalogue> {
  return catalogueSchema.parse(await readGzip(join(directory, 'catalogue.json.gz')));
}

/** A bounded independent refresh; requests should only load/search the published generation. */
export async function refreshCatalogue(directory: string, options: {
  dataMode: Catalogue['dataMode']; fetchImpl?: typeof fetch; maxPages?: number;
}): Promise<Catalogue> {
  const maxPages = options.maxPages ?? 500;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 500) throw new Error('Page limit must be 1–500');
  if (options.dataMode !== 'live' && !options.fetchImpl) throw new Error('Recorded/synthetic refresh requires an explicit data source');
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, 'refresh.lock');
  const lock = await open(lockPath, 'wx');
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const checkpointPath = join(directory, 'checkpoint.json');
    let checkpoint: z.infer<typeof checkpointSchema> | undefined;
    try { checkpoint = checkpointSchema.parse(JSON.parse(await readFile(checkpointPath, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (checkpoint && checkpoint.dataMode !== options.dataMode) throw new Error('Checkpoint data mode differs from requested source');
    if (checkpoint && Date.now() - Date.parse(checkpoint.startedAt) > catalogueMaxAgeMs) {
      await rm(join(directory, checkpoint.generationId), { recursive: true, force: true });
      await rm(checkpointPath);
      checkpoint = undefined;
    }
    checkpoint ??= { parserVersion: 'gamma-discovery-v2', generationId: randomUUID(), startedAt: new Date().toISOString(),
      dataMode: options.dataMode, pages: 0, nextCursor: null, cursors: [] };
    const pagesDirectory = join(directory, checkpoint.generationId);
    await mkdir(pagesDirectory, { recursive: true });
    const deadline = AbortSignal.timeout(120_000);
    let fetched = 0;
    while (checkpoint.pages === 0 || checkpoint.nextCursor !== null) {
      if (fetched++ >= maxPages) throw new Error('Catalogue page limit reached; rerun to resume');
      deadline.throwIfAborted();
      const url = new URL(gammaEndpoint);
      url.search = new URLSearchParams({ closed: 'false', limit: '100', order: 'id', ascending: 'true',
        ...(checkpoint.nextCursor ? { after_cursor: checkpoint.nextCursor } : {}) }).toString();
      const response = await (options.fetchImpl ?? fetch)(url, { signal: AbortSignal.any([deadline, AbortSignal.timeout(30_000)]) });
      if (!response.ok) throw new Error(`Gamma catalogue HTTP ${response.status}`);
      const page = gammaPageSchema.parse(await response.json());
      if (page.nextCursor !== null && checkpoint.cursors.includes(page.nextCursor)) throw new Error('Repeated catalogue cursor');
      await atomicWrite(join(pagesDirectory, `${checkpoint.pages}.json.gz`), await compress(JSON.stringify(page.events)));
      checkpoint = { ...checkpoint, pages: checkpoint.pages + 1, nextCursor: page.nextCursor,
        cursors: page.nextCursor ? [...checkpoint.cursors, page.nextCursor] : checkpoint.cursors };
      await atomicWrite(checkpointPath, JSON.stringify(checkpoint));
    }
    const events = new Map<string, CatalogueEvent>();
    for (let page = 0; page < checkpoint.pages; page++) {
      for (const event of z.array(catalogueEventSchema).parse(await readGzip(join(pagesDirectory, `${page}.json.gz`)))) {
        events.set(event.eventId, event);
      }
    }
    const snapshot = catalogueSchema.parse({ schemaVersion: 'catalogue-v1', parserVersion: checkpoint.parserVersion,
      generationId: checkpoint.generationId, dataMode: checkpoint.dataMode, source: gammaEndpoint,
      coverage: 'completed-open-event-walk', startedAt: checkpoint.startedAt, completedAt: new Date().toISOString(),
      pages: checkpoint.pages, events: [...events.values()] });
    createCatalogueIndex(snapshot); // Validate the whole searchable generation before replacing last-good data.
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized) > 128 * 1024 * 1024) throw new Error('Catalogue exceeds read size limit');
    await atomicWrite(join(directory, 'catalogue.json.gz'), await compress(serialized));
    await rm(checkpointPath);
    await rm(pagesDirectory, { recursive: true, force: true });
    return snapshot;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
