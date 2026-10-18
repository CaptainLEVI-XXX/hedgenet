'use client';
import { useEffect, useRef, useState } from 'react';
import { MarketLinks } from './MarketLinks.tsx';
import { requestLiveMarket } from '../lib/client-api.ts';
import type { ApiFailure, LiveIntakeResult } from '../lib/client-api.ts';

type MarketRead = Awaited<ReturnType<typeof requestLiveMarket>>;
type BookState =
  | { status: 'loading'; eventId: string }
  | { status: 'error'; eventId: string; message: string }
  | { status: 'done'; eventId: string; result: Extract<MarketRead, { ok: true }>['data'] };

function PublishedLink({ url, children }: { url: string | null; children: React.ReactNode }) {
  if (!url?.startsWith('https://polymarket.com/')) return <>{children}</>;
  return <a href={url} target="_blank" rel="noopener noreferrer">{children} <span aria-hidden="true">↗</span></a>;
}

function LiveMarketSelection({ result, selectionToken }: { result: LiveIntakeResult; selectionToken: string }) {
  const [books, setBooks] = useState<BookState | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function readMarket(eventId: string) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBooks({ status: 'loading', eventId });
    try {
      const response = await requestLiveMarket({ selectionToken, eventId }, controller.signal);
      if (controller.signal.aborted || active.current !== controller) return;
      setBooks(response.ok ? { status: 'done', eventId, result: response.data }
        : { status: 'error', eventId, message: response.error.message });
    } catch {
      if (controller.signal.aborted || active.current !== controller) return;
      setBooks({ status: 'error', eventId, message: 'Rules and live books could not be read. Try this event again.' });
    }
  }

  return <section className="market-links live-market-review" aria-label="Live market review">
    <h3>Review discovery candidates</h3>
    <p>Discovery candidates, not confirmed hedge positions. Read an event’s rules and live quotes without running Jev again.</p>
    {result.discovery.suggestions.map(event => <div key={event.eventId}>
      <PublishedLink url={event.url}>{event.title}</PublishedLink>
      <div className="live-actions"><button className="text-btn" onClick={() => readMarket(event.eventId)}
        disabled={books?.status === 'loading' && books.eventId === event.eventId}>
        Read rules &amp; live books
      </button></div>
    </div>)}
    {books?.status === 'loading' && <p role="status"><span className="spinner" aria-hidden="true" /> Reading rules and live books…</p>}
    {books?.status === 'error' && <p role="alert">Market read unavailable: {books.message}</p>}
    {books?.status === 'done' && <section aria-label="Selected event rules and quotes" aria-live="polite">
      <h3><PublishedLink url={books.result.event.url}>{books.result.event.title}</PublishedLink></h3>
      <p><strong>Live quotes for review only — not neural share recommendations.</strong> No positions or quantities have been proposed. Quotes may change and do not guarantee fills or a compatible hedge.</p>
      <p>Fetched at {books.result.fetchedAt}. {books.result.status === 'books_ready' ? 'Live books read.' : 'Review only; books are not ready for use.'}</p>
      {books.result.reason && <p>{books.result.reason}</p>}
      {books.result.markets.length === 0 && <p>No market rules or quotes were returned for this event.</p>}
      {books.result.markets.map(market => <div key={market.marketId}>
        <h4><PublishedLink url={market.url}>{market.question}</PublishedLink></h4>
        <dl className="provenance">
          <div><dt>YES best ask</dt><dd>{market.yesAsk === null ? 'Unavailable' : `$${market.yesAsk} per share`}</dd></div>
          <div><dt>NO best ask</dt><dd>{market.noAsk === null ? 'Unavailable' : `$${market.noAsk} per share`}</dd></div>
          <div><dt>Fee</dt><dd>{market.fee ?? 'Unavailable'}</dd></div>
        </dl>
        <details className="hedge-details intake-details">
          <summary>Full published rules</summary>
          <p style={{ whiteSpace: 'pre-wrap' }}>{market.description || 'No published rules were returned. Compatibility has not been confirmed.'}</p>
        </details>
      </div>)}
    </section>}
  </section>;
}

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
          {result.selectionToken && result.discovery.suggestions.length > 0
            ? <LiveMarketSelection key={result.selectionToken} result={result} selectionToken={result.selectionToken} />
            : <MarketLinks events={result.discovery.suggestions} description="Discovery candidates, not confirmed hedge positions." />}
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
