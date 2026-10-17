'use client';
import { NeuralWorkspace } from './NeuralWorkspace.tsx';
import { MarketLinks } from './MarketLinks.tsx';
import type { ApiFailure, LiveIntakeResult } from '../lib/client-api.ts';

export type LiveState =
  | { status: 'running'; startedAt: number }
  | { status: 'done'; result: LiveIntakeResult }
  | { status: 'error'; error: ApiFailure };

export function LiveWorkspace({ text, state, onEdit, onRetry, onTryExample }: {
  text: string; state: LiveState; onEdit: () => void; onRetry: () => void; onTryExample: () => void;
}) {
  const result = state.status === 'done' ? state.result : null;
  const field = (name: string) => result?.interpretation.fields.find(item => item.name === name)?.value;
  const btc = /^(?:BTC|Bitcoin|BTC\/USD|BTCUSD|Bitcoin price)$/i.test(field('observable') ?? '');
  const supported = result?.interpretation.status === 'needs_clarification';
  const ready = supported && btc && Boolean(field('units') && field('referencePriceUsd'));
  return <>
    {state.status === 'running' ? <section className="intake-pending" aria-live="polite">
      <span className="spinner" aria-hidden="true" /><h1>Reading your exposure…</h1><p>{text}</p>
    </section> : supported && btc ? <NeuralWorkspace key={JSON.stringify(result?.interpretation.fields)}
      initial={{ units: field('units'), referencePriceUsd: field('referencePriceUsd'), budgetUsd: field('budgetUsd') }}
      autoRun={ready} onEdit={onEdit} events={result!.discovery.suggestions} />
      : <section className="intake-empty">
        <h1>{state.status === 'error' ? 'Couldn’t read this exposure.' : result?.interpretation.status === 'dependency_unavailable' ? 'Interpretation unavailable.' : 'No supported simulation for this exposure.'}</h1>
        <p>{state.status === 'error' ? state.error.message : 'The trained demo currently supports Bitcoin downside. We won’t substitute a different exposure.'}</p>
        <div className="live-actions"><button className="btn quiet" onClick={onEdit}>Edit exposure</button>
          {state.status === 'error' ? <button className="text-btn" onClick={onRetry}>Retry</button> : <button className="text-btn" onClick={onTryExample}>Try the Bitcoin demo</button>}</div>
        {result && <MarketLinks events={result.discovery.suggestions} />}
      </section>}
    {result && <details className="hedge-details intake-details">
      <summary>What Jev understood</summary>
      <p>This is an unconfirmed interpretation. The demo uses fictional BTC markets; discovery links are not verified hedges.</p>
      <dl className="provenance">{result.interpretation.fields.map(item => <div key={item.name}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
      {result.interpretation.missing.length > 0 && <p>Needed for a real hedge: {result.interpretation.missing.map(item => item.label).join(', ')}.</p>}
      <p>Discovery: {result.discovery.status.replaceAll('_', ' ')}. {result.discovery.catalogue ? `Catalogue ${result.discovery.catalogue.ageMinutes} minutes old.` : ''}</p>
    </details>}
  </>;
}
