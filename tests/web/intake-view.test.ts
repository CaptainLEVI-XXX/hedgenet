import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { LiveWorkspace } from '../../apps/web/components/LiveWorkspace.tsx';
import type { LiveIntakeResult } from '../../apps/web/lib/client-api.ts';

// Render with the web application's React installation, without adding a second runtime.
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

it.each([
  ['bitcoin', 'terminal_downside', 'I hold 0.35 BTC at $65,000 until January 15, 2027. My budget is $400.'],
  ['rainfall', 'conditional_loss', 'I lose $5,000 if Heathrow records rain on January 15, 2027. My budget is $400.'],
])('preserves a custom %s exposure instead of substituting the BTC fixture', (observable, template, text) => {
  const result: LiveIntakeResult = {
    ok: true, mode: 'live', durationMs: 12,
    interpretation: { status: 'needs_clarification', failure: null, confirmed: false,
      fields: Object.entries({ observable, templateId: template,
        ...(template === 'terminal_downside' ? { units: '0.35', referencePriceUsd: '65000' } : { fixedLossUsd: '5000' }),
        observationDate: 'January 15, 2027', budgetUsd: '400' }).map(([name, value]) => ({
        name, label: name, value, source: 'your-text', quoted: value,
      })), missing: [{ name: 'resolutionSource', label: 'Resolution source' }] },
    discovery: { status: 'no_discovery_match', failure: null, catalogue: null, consideredCount: 0, suggestions: [] },
    model: { status: 'unavailable', message: 'No model is available for this exposure and market universe.' },
    proposal: null,
  };
  const html = renderToStaticMarkup(createElement(LiveWorkspace, {
    text, state: { status: 'done', result }, onEdit() {}, onRetry() {}, onTryExample() {},
  }));
  expect(html).toContain(text);
  expect(html).toContain('January 15, 2027');
  expect(html).toContain(result.model.message);
  expect(html).not.toContain('30 Oct 2026');
  expect(html).not.toContain('neural-form');
});
