import { createCatalogueIndex, loadCatalogue, refreshCatalogue } from '@hedgenet/venue';

const [command, ...args] = process.argv.slice(2);
const directory = '.amp/in/catalogue';
try {
  if (command === 'refresh' && args.length === 0) {
    const start = performance.now();
    const catalogue = await refreshCatalogue(directory, { dataMode: 'live' });
    console.log(JSON.stringify({ generationId: catalogue.generationId, events: catalogue.events.length,
      pages: catalogue.pages, elapsedMs: Math.round(performance.now() - start), startedAt: catalogue.startedAt,
      completedAt: catalogue.completedAt, dataMode: catalogue.dataMode }, null, 2));
  } else if (command === 'search' && args[0]) {
    const catalogue = await loadCatalogue(directory);
    console.log(JSON.stringify(createCatalogueIndex(catalogue).search(args.join(' ')), null, 2));
  } else {
    throw new Error('Usage: pnpm catalogue refresh | pnpm catalogue search <query>');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Catalogue operation failed');
  process.exitCode = 1;
}
