'use client';
import { useEffect, useRef, useState } from 'react';
import { requestNeural } from '../lib/client-api.ts';
import type { NeuralPreview } from '../lib/neural-contract.ts';
import { budgetProblem, DEFAULT_BUDGET_USD } from '../lib/presets.ts';
import { money, shares } from '../lib/format.ts';
import { useReducedMotion, useReplay } from '../lib/use-replay.ts';
import { LossPlot } from './LossPlot.tsx';
import { NeuralCircuit } from './NeuralCircuit.tsx';
import { BudgetControl } from './BudgetControl.tsx';
import type { BudgetIntent } from './BudgetControl.tsx';
import { MarketLinks } from './MarketLinks.tsx';
import type { MarketLink } from './MarketLinks.tsx';

export type NeuralDraft = { units?: string | undefined; referencePriceUsd?: string | undefined; budgetUsd?: string | undefined };
export function NeuralWorkspace({ initial = {}, onEdit, autoRun = false, events }: {
  initial?: NeuralDraft; onEdit?: () => void; autoRun?: boolean; events?: MarketLink[];
}) {
  const [units, setUnits] = useState(initial.units ?? '');
  const [referencePriceUsd, setReference] = useState(initial.referencePriceUsd ?? '');
  const [budgetUsd, setBudget] = useState(initial.budgetUsd ?? DEFAULT_BUDGET_USD);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NeuralPreview | null>(null);
  const revision = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastRequest = useRef<string | null>(null);
  const reducedMotion = useReducedMotion();
  const replay = useReplay(reducedMotion, true);
  useEffect(() => () => { clearTimeout(debounce.current); ++revision.current; controller.current?.abort(); }, []);
  // Keep the previous result visible but marked stale when confirmed inputs change.
  const invalidate = () => { clearTimeout(debounce.current); ++revision.current; controller.current?.abort(); lastRequest.current = null; setPending(false); setError(null); };
  const decimal = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
  const problem = !decimal.test(units) || Number(units) < 0.1 || Number(units) > 5 ? 'Enter BTC holdings from 0.1 to 5.'
    : !decimal.test(referencePriceUsd) || Number(referencePriceUsd) < 35000 || Number(referencePriceUsd) > 105000 ? 'Enter a reference price from $35,000 to $105,000.'
    : budgetProblem(budgetUsd);
  const run = async (nextBudget = budgetUsd) => {
    clearTimeout(debounce.current);
    const inputProblem = !decimal.test(units) || Number(units) < 0.1 || Number(units) > 5 ? 'Enter BTC holdings from 0.1 to 5.'
      : !decimal.test(referencePriceUsd) || Number(referencePriceUsd) < 35000 || Number(referencePriceUsd) > 105000 ? 'Enter a reference price from $35,000 to $105,000.' : budgetProblem(nextBudget);
    if (inputProblem) { setError(inputProblem); return; }
    const key = JSON.stringify([units, referencePriceUsd, nextBudget]);
    if (lastRequest.current === key) return;
    lastRequest.current = key;
    const current = ++revision.current;
    controller.current?.abort(); controller.current = new AbortController();
    setPending(true); setError(null);
    try {
      const response = await requestNeural({ units, referencePriceUsd, budgetUsd: nextBudget, revision: current, confirmedSynthetic: true }, controller.current.signal);
      if (current !== revision.current) return;
      setPending(false);
      if (!response.ok) { lastRequest.current = null; setError(`${response.error.code}: ${response.error.message}`); return; }
      if (response.data.revision !== current) { lastRequest.current = null; setError('The server returned a stale revision. Retry the simulation.'); return; }
      setResult(response.data); replay.play(0, 4000);
    } catch (e) { if (current === revision.current) { lastRequest.current = null; setPending(false); setError((e as Error).name === 'AbortError' ? 'Request cancelled. Retry when ready.' : 'Simulation failed. Retry when ready.'); } }
  };
  // The composer action explicitly requests a demo simulation. Defer one tick so
  // React's development remount cancels the first schedule instead of double-running.
  useEffect(() => {
    if (!autoRun || problem) return;
    const timer = setTimeout(() => void run(), 0);
    return () => clearTimeout(timer);
  }, []);
  const changeBudget = (value: string, intent: BudgetIntent) => {
    setBudget(value);
    clearTimeout(debounce.current);
    if (intent === 'drag' || !result || pending) return;
    if (intent === 'now') void run(value);
    else debounce.current = setTimeout(() => void run(value), 600);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'hedgenet-neural-result.json'; a.click(); URL.revokeObjectURL(url);
  };
  const improved = result?.outcome === 'improvement';
  const stale = Boolean(result && (problem || pending || Number(units) !== Number(result.exposure.units)
    || Number(referencePriceUsd) !== Number(result.exposure.referencePriceUsd) || Number(budgetUsd) !== Number(result.valuation.budgetUsd)));
  return <section className="neural-workspace" aria-label="Experimental BTC simulation">
    <div className="hedge-heading"><h1>Your downside, mapped.</h1><div className="workspace-heading-actions"><span className="tag">Synthetic demo</span>{onEdit && <button className="text-btn" onClick={onEdit}>Edit exposure</button>}</div></div>
    <div className="hedge-sheet">
      <form className="neural-form" onSubmit={e => { e.preventDefault(); void run(); }}>
        <div className="neural-exposure">
          <span className="small muted">Bitcoin downside · 30 Oct 2026</span>
          <div className="neural-fields">
            <label>BTC holdings<input aria-label="BTC holdings (0.1–5)" required inputMode="decimal" value={units} onChange={e => { invalidate(); setUnits(e.target.value); }} /></label>
            <label>Reference price (USD)<input required inputMode="decimal" value={referencePriceUsd} onChange={e => { invalidate(); setReference(e.target.value); }} /></label>
          </div>
          {(!result || error || stale && !pending) && <button className="btn quiet" disabled={pending} type="submit">{pending ? 'Running…' : error ? 'Retry simulation' : result ? 'Update simulation' : 'Run simulation'}</button>}
          {!autoRun && !result && <p className="small muted">Run with fictional BTC markets, not live positions.</p>}
        </div>
        <div className="neural-budget">
          <BudgetControl value={budgetUsd} problem={budgetProblem(budgetUsd)} onChange={changeBudget} />
        </div>
        {error && <p role="alert" className="error">{error}</p>}
      </form>
      {stale && <div className="stale-banner" role="status">{pending ? 'Updating…' : 'Inputs changed. Update to refresh.'} Showing the previous {money(result!.valuation.budgetUsd)} result.</div>}
        <div className="lab-stage"><div className="lab-network">
          <div className="lab-network-head"><h2>{result ? 'Measured inference' : 'Your neural hedge'}</h2>{result && <button className="text-btn" onClick={replay.toggle} disabled={reducedMotion} aria-label={replay.playing ? 'Pause animation' : 'Play animation'}>{replay.playing ? 'Ⅱ Pause' : '▷ Play'}</button>}</div>
          {result ? <>
            <div className="lab-svg-scroll" tabIndex={0} aria-label="Neural trace; scroll horizontally"><NeuralCircuit preview={result} progress={replay.progress} reducedMotion={reducedMotion} /></div>
            <div className="neural-caption"><span>{reducedMotion ? 'Static trace' : 'Looping replay'} · not live training</span><span>{result.execution.inferenceMs.toFixed(0)} ms inference</span></div>
          </> : <div className="neural-awaiting" role="status">{pending ? <><span className="spinner" aria-hidden="true" />Running model &amp; financial checks…</> : error ? 'No verified result yet.' : 'Enter your BTC exposure to begin.'}</div>}
        </div><aside className="lab-output">
          <h2>{!result ? 'Your result' : improved ? 'Simulated hedge' : 'No improving hedge'}</h2>
          {result && improved ? <>
            <div className="neural-metrics"><div><span>Simulated cost</span><strong>{money(result.valuation.totalCostUsd)}</strong></div><div><span>Worst remaining loss</span><strong>{money(result.valuation.worstNetLossUsd)}</strong></div></div>
            <LossPlot preview={result} reveal={1} />
            <p className="small muted">Without a hedge: {money(result.valuation.worstOriginalLossUsd)} worst loss.</p>
            {result.valuation.positions.filter(p => Number(p.shares) > 0).map(p => { const leg = result.legs.find(l => l.legId === p.legId); return <div className="position-row" key={p.legId}><span>{leg?.side} · {leg?.label}</span><strong>{shares(p.shares)} shares</strong></div>; })}
            <p className="small muted">Partial protection. Fictional positions, not orders.</p></>
            : <p className="empty-result">{result ? 'This candidate does not reduce worst-case loss. No basket is recommended.' : 'Positions and remaining risk appear after verification.'}</p>}
          <MarketLinks {...(events ? { events } : {})} />
        </aside></div>
      {result && <>
        <details className="hedge-details"><summary>Details &amp; assumptions</summary>
          <p>Confirmed synthetic simulation: BTC downside at 30 October 2026, 16:00 UTC. The animation replays measured activations; the model is not being trained here.</p>
          <p>Experimental trained model; quality policy is advisory, not an acceptance threshold. No live books, liquidity or market compatibility checked.</p>
          {result.model.qualityWarnings.map((warning, i) => <p key={i}>{warning}</p>)}
          <dl className="provenance"><div><dt>Model</dt><dd>{result.model.version}</dd></div><div><dt>Weights hash</dt><dd className="mono">{result.model.weightsHash}</dd></div><div><dt>Execution</dt><dd>{result.execution.provider} · inference {result.execution.inferenceMs} ms · total {result.execution.totalMs} ms</dd></div><div><dt>Budget repair</dt><dd>{result.repair.budgetScaled ? 'Scaled' : 'Not scaled'} · multiplier {result.repair.multiplier} · dropped {result.repair.droppedLegIds.join(', ') || 'none'}</dd></div><div><dt>Evaluator</dt><dd>{result.valuation.schemaVersion} · {result.valuation.valuationHash}</dd></div></dl>
          <p>Loss = BTC units × max(reference price − settlement BTC price, 0). Synthetic buckets: below $60,000; $60,000 to under $80,000; $80,000 and above. Each YES/NO share pays $1 when its condition holds. Net loss = original loss + cost − payout.</p>
          <div className="table-wrap"><table><caption>All six candidate outputs (rejected when no improvement)</caption><thead><tr><th>Leg</th><th>Raw output</th><th>Repaired shares</th><th>Fictional price</th></tr></thead><tbody>{result.legs.map((l, i) => <tr key={l.legId}><th>{l.side} · {l.label}</th><td>{result.trace.outputs[i]}</td><td>{result.valuation.positions.find(p => p.legId === l.legId)?.shares}</td><td>{money(l.price)}</td></tr>)}</tbody></table></div>
          <div className="table-wrap"><table><caption>Exact evaluator scenarios · {result.outcome}</caption><thead><tr><th>Scenario</th><th>Original loss</th><th>Payout</th><th>Net loss including cost</th></tr></thead><tbody>{result.valuation.scenarios.map(s => <tr key={s.stateId}><th>{result.scenarioLabels[s.stateId]}</th><td>{money(s.originalLossUsd)}</td><td>{money(s.payoutUsd)}</td><td>{money(s.netLossUsd)}</td></tr>)}</tbody></table></div>
          <details><summary>Full measured trace · 32 activations and learned weights</summary><pre className="neural-raw">{JSON.stringify(result.trace, null, 2)}</pre></details>
          <button className="btn quiet" onClick={download}>Download result JSON</button>
        </details>
      </>}
    </div>
  </section>;
}
