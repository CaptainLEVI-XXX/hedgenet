'use client';
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
  const unavailable = result?.interpretation.status === 'dependency_unavailable';
  const unsupported = result?.interpretation.status === 'unsupported';
  const retryable = state.status === 'error' || unavailable || result?.discovery.status === 'dependency_unavailable';
  const discoveryMessage = result && {
    skipped: 'Market discovery has not run for this draft.',
    suggestions: 'Related events need full rule and date review before they can be used in a hedge.',
    no_discovery_match: 'No related events were found in this catalogue search. This is not an exhaustive market search.',
    no_semantic_suggestion: 'The shortlisted events did not establish a relevant match.',
    unsupported_structure: 'The related events exceed the supported market structure.',
    catalogue_expired: 'The market catalogue is out of date. No fresh match has been checked.',
    dependency_unavailable: 'Market matching is unavailable. Your exposure draft is preserved.',
  }[result.discovery.status];
  return <>
    {state.status === 'running' ? <section className="intake-pending" aria-live="polite">
      <span className="spinner" aria-hidden="true" /><h1>Reading your exposure…</h1><p>{text}</p>
    </section> : <section className="intake-empty" aria-label="Your exposure draft">
        <span className="tag">{state.status === 'error' || unavailable ? 'Interpretation unavailable' : 'Draft · no hedge priced'}</span>
        <h1>Your exposure</h1>
        <blockquote className="intake-request">{text}</blockquote>
        {result && <dl className="intake-facts provenance">
          {result.interpretation.fields.filter(item => ['observable', 'observationDate', 'budgetUsd'].includes(item.name))
            .map(item => <div key={item.name}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
        </dl>}
        <p>{state.status === 'error' ? state.error.message : unavailable
          ? 'Jev could not interpret this request. Your original description is kept; this is not a no-market result.'
          : unsupported ? 'This loss formula or observation is not supported. It has not been replaced with a different exposure.'
          : result?.model.message}</p>
        {result && <p className="intake-discovery">{discoveryMessage}</p>}
        <div className="live-actions"><button className="btn quiet" onClick={onEdit}>Edit exposure</button>
          {retryable && <button className="text-btn" onClick={onRetry}>Retry</button>}
          <button className="text-btn" onClick={onTryExample}>Explore the separate BTC demo</button></div>
        {result && <>
          <MarketLinks events={result.discovery.suggestions} description="Discovery candidates, not confirmed hedge positions." />
          <details className="hedge-details intake-details">
            <summary>What Jev understood</summary>
            <p>This interpretation is unconfirmed. Dates retain your wording; a market’s end date is not automatically its observation time.</p>
            <dl className="provenance">{result.interpretation.fields.map(item => <div key={item.name}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
            {result.interpretation.missing.length > 0 && <p>Needed for a real hedge: {result.interpretation.missing.map(item => item.label).join(', ')}.</p>}
            {result.discovery.catalogue && <p>Catalogue: {result.discovery.catalogue.ageMinutes} minutes old.</p>}
          </details>
        </>}
      </section>}
  </>;
}
