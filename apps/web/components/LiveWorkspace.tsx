'use client';
import { useEffect, useRef, useState } from 'react';
import { Circuit } from './Circuit.tsx';
import { NeuralWorkspace } from './NeuralWorkspace.tsx';
import type { ApiFailure, LiveIntakeResult } from '../lib/client-api.ts';
import { money } from '../lib/format.ts';

export type LiveState =
  | { status: 'running'; startedAt: number }
  | { status: 'done'; result: LiveIntakeResult }
  | { status: 'error'; error: ApiFailure };

const interpretationCopy: Record<string, [string, string]> = {
  needs_clarification: ['Needs clarification', 'Jev drafted an interpretation. Nothing is confirmed; the missing details below must be supplied before any market or model step.'],
  unsupported: ['Unsupported exposure', 'This loss shape (or currency/observation) is outside the supported templates. No hedge is forced.'],
  dependency_unavailable: ['Jev unavailable', 'The interpretation service did not answer usably. Your text is kept; retry later.'],
};
const discoveryCopy: Record<string, [string, string]> = {
  skipped: ['Not searched', 'Discovery runs only after a supported loss formula is identified.'],
  suggestions: ['Candidate events found', 'Jev suggested these cached-catalogue events as possibly relevant. Their full resolution rules have not been reviewed, so none is a compatible market yet.'],
  no_discovery_match: ['No match. No forced hedge.', 'The cached catalogue has no event matching this observable.'],
  no_semantic_suggestion: ['No relevant candidate', 'Catalogue search found events, but none looked like the same observable and loss meaning.'],
  unsupported_structure: ['Unsupported market structure', 'Matching events have more markets than the supported structure.'],
  catalogue_expired: ['Catalogue too old', 'The cached catalogue is older than 24 hours, so it was not searched. A refresh is needed.'],
  dependency_unavailable: ['Relevance check unavailable', 'Jev could not assess candidates. Your text is kept; retry later.'],
};

const valueLabels: Record<string, string> = {
  terminal_downside: 'Asset falls below a reference price', threshold_loss: 'Per-unit loss beyond a threshold (capped)',
  conditional_loss: 'Fixed loss if a condition happens', other: 'Other (unsupported)', point: 'Value at a point in time',
  window: 'Aggregate over a window', binary: 'Yes/no condition', unsupported_path: 'Path-dependent (unsupported)',
  above: 'Above threshold', below: 'Below threshold',
};

function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(id); }, []);
  return <>{((now - startedAt) / 1000).toFixed(1)} s</>;
}

export function LiveWorkspace({ text, state, onEdit, onRetry, onTryExample }: {
  text: string; state: LiveState; onEdit: () => void; onRetry: () => void; onTryExample: () => void;
}) {
  const statusRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (state.status !== 'running') statusRef.current?.focus(); }, [state.status]);
  const result = state.status === 'done' ? state.result : null;
  const budgetField = result?.interpretation.fields.find(field => field.name === 'budgetUsd');
  const field = (name: string) => result?.interpretation.fields.find(item => item.name === name)?.value;
  // Only a Jev BTC observable may carry holdings/reference into a BTC simulation.
  // Never reinterpret ETH, weather or an unknown observable as BTC.
  const btc = /^(?:BTC|Bitcoin|BTC\/USD|BTCUSD|Bitcoin price)$/i.test(field('observable') ?? '');
  const [interpTitle, interpBody] = result ? interpretationCopy[result.interpretation.status] ?? ['Unknown', ''] : ['', ''];
  const [discTitle, discBody] = result ? discoveryCopy[result.discovery.status] ?? ['Unknown', ''] : ['', ''];
  const quote = text.length > 280 ? `${text.slice(0, 277)}…` : text;

  return (
    <>
      <div className="hedge-heading">
        <h1>Your hedge, taking shape.</h1>
        <button className="text-btn" onClick={onEdit}>Edit exposure</button>
      </div>
      <section className="hedge-sheet" aria-label="Live intake workspace">
        <div className="lab-controls">
          <div>
            <div className="exposure-context"><span className="dot" />Live intake · your description<span className="tag blue">Live · Jev + cached catalogue</span></div>
            <p className="lab-exposure">“{quote}”</p>
          </div>
          <div className="lab-budget">
            <label>Hedge budget <output>{budgetField ? money(budgetField.value) : '—'}</output></label>
            <p>{budgetField ? 'Draft from Jev · unconfirmed. Confirm or edit it in the separate simulation below.'
              : result ? 'No budget identified. The separate simulation offers a $1,000 starting budget for you to confirm.' : 'Not interpreted yet. No budget has been confirmed.'}</p>
          </div>
        </div>
        <div className="lab-stage">
          <div className="lab-network">
            <div className="lab-network-head"><h2>Inside your hedge</h2><span>Trace unavailable</span></div>
            <p className="illustration-label">Static schematic. No model has run, so there is no trace to show.</p>
            <div className="lab-svg-scroll" tabIndex={0} aria-label="Static network schematic; scroll horizontally on small screens">
              <Circuit mode="unavailable" inputs={[['Exposure', 'Unconfirmed'], ['Observation', '—'], ['Hedge budget', '—'], ['Market', '—'], ['Rules', 'Not reviewed']]}
                outputs={[{ label: 'No proposal', shares: null }]} progress={0} variant={0} reducedMotion selectedUnit={-1} onSelectUnit={() => undefined} />
            </div>
            <p className="mobile-pan">Swipe to follow the network.</p>
          </div>
          <aside className="lab-output live-output" aria-busy={state.status === 'running'}>
            <div className="section-row"><h2>Where this stands</h2><span className="tag">{state.status === 'running' ? 'Running' : state.status === 'error' ? 'Stopped' : 'No proposal'}</span></div>
            <div ref={statusRef} tabIndex={-1} role="status" className="live-status">
              {state.status === 'running' && (
                <div className="live-step"><span className="spinner" aria-hidden="true" />
                  <div><strong>Live intake running · <Elapsed startedAt={state.startedAt} /></strong>
                    <p>One server request: Jev interpretation, then cached-catalogue discovery. No progress percentage is known.</p></div></div>
              )}
              {state.status === 'error' && (
                <div className="live-step error-step"><div><strong>{state.error.code === 'jev_not_configured' ? 'Live intake unavailable' : state.error.code === 'intake_busy' ? 'Live intake busy' : 'Live intake failed'}</strong>
                  <p>{state.error.message}</p>
                  <div className="live-actions"><button className="btn quiet" onClick={onRetry}>Retry</button><button className="text-btn" onClick={onEdit}>Edit exposure</button></div></div></div>
              )}
              {result && (
                <>
                  <div className="live-step"><div><small>1 · Interpretation</small><strong>{interpTitle}</strong><p>{interpBody}{result.interpretation.failure ? ` (${result.interpretation.failure.replace('_', ' ')})` : ''}</p></div></div>
                  <div className="live-step"><div><small>2 · Market discovery</small><strong>{discTitle}</strong><p>{discBody}</p></div></div>
                  <div className="live-step model-step"><div><small>3 · Experimental simulation</small><strong>Separate BTC opt-in below</strong><p>Discovery suggestions are not confirmed market matches. The BTC model uses fictional markets, not these events.</p></div></div>
                </>
              )}
            </div>
          </aside>
        </div>
      </section>
      {result && (
        <div className="hedge-bottom">
          <section>
            <h2>What we understood <span className="tag">Unconfirmed draft</span></h2>
            {result.interpretation.fields.length === 0 ? <p>No fields could be drafted.</p> : (
              <div className="table-wrap"><table>
                <caption className="visually-hidden">Draft fields from live intake</caption>
                <thead><tr><th scope="col">Field</th><th scope="col">Draft value</th><th scope="col">Source</th></tr></thead>
                <tbody>{result.interpretation.fields.map(field => (
                  <tr key={field.name}><th scope="row">{field.label}</th><td>{field.source === 'suggested' ? valueLabels[field.value] ?? field.value : field.value}</td>
                    <td>{field.source === 'your-text' ? <>Your text: “{field.quoted}”</> : 'Suggested by Jev'}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
          <section className="risk-summary">
            <h2>Still needed before a hedge</h2>
            {result.interpretation.missing.length ? (
              <ul className="missing-list">{result.interpretation.missing.map(item => <li key={item.name}>{item.label}</li>)}</ul>
            ) : <p>No missing draft fields reported. Confirmation and rule review are still required.</p>}
            <p style={{ marginTop: 12 }}>Add the missing details to your description with <button className="text-btn inline" onClick={onEdit}>Edit exposure</button>, or <button className="text-btn inline" onClick={onTryExample}>try an illustrative example</button>.</p>
            {result.discovery.suggestions.length > 0 && (
              <>
                <h3 style={{ marginTop: 18 }}>Events to review</h3>
                <ul className="suggestion-list">{result.discovery.suggestions.map(item => (
                  <li key={item.eventId}><span>{item.title}</span><small>Needs rule review · discovery relevance {item.relevance.toFixed(2)} (not a probability or fit guarantee)</small></li>
                ))}</ul>
              </>
            )}
          </section>
        </div>
      )}
      {state.status !== 'running' && <NeuralWorkspace key={result ? JSON.stringify(result.interpretation.fields) : 'manual'} inline initial={{ units: btc ? field('units') : undefined, referencePriceUsd: btc ? field('referencePriceUsd') : undefined, budgetUsd: field('budgetUsd') }} />}
      {result && (
        <details className="hedge-details">
          <summary>Intake provenance</summary>
          <dl className="provenance">
            <div><dt>Interpretation</dt><dd>Jev, one pinned model call; uncalibrated suggestions, never confirmations</dd></div>
            <div><dt>Catalogue</dt><dd>{result.discovery.catalogue ? `${result.discovery.catalogue.dataMode} · ${result.discovery.catalogue.status} · ${result.discovery.catalogue.ageMinutes} min old · ${result.discovery.consideredCount} events assessed` : 'Not searched'}</dd></div>
            <div><dt>Duration</dt><dd>{(result.durationMs / 1000).toFixed(1)} s</dd></div>
            <div><dt>Proposal</dt><dd>None from live intake. The separate synthetic BTC simulation requires your confirmation; no solver fallback.</dd></div>
          </dl>
        </details>
      )}
    </>
  );
}
