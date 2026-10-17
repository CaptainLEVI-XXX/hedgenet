import type { NextConfig } from 'next';
import { resolve } from 'node:path';

// Server-side secrets (e.g. JEV_API_KEY) live in the root .env. `node --env-file*` flags cannot be
// used with `next dev` (Next forwards execArgv via NODE_OPTIONS, which rejects them), so load here.
// Never exposed to the browser: no NEXT_PUBLIC_ variables are read.
if (process.env.NODE_ENV !== 'production') {
  try { process.loadEnvFile(resolve(import.meta.dirname, '../../.env')); } catch { /* optional */ }
}

const config: NextConfig = {
  transpilePackages: ['@hedgenet/core', '@hedgenet/intake', '@hedgenet/venue'],
  serverExternalPackages: ['highs'],
  turbopack: { root: resolve(import.meta.dirname, '../..') },
  // These runtime paths are deliberately supplied by the allowlisted full-app
  // image, not NFT/standalone tracing. Keep normal dependency tracing enabled.
  outputFileTracingExcludes: {
    '/api/neural': ['../../.amp/**/*', '../../data/**/*', '../../packages/training/remote/**/*'],
    '/api/intake': ['../../.amp/**/*', '../../data/**/*'],
  },
  devIndicators: false,
  agentRules: false,
};
export default config;
