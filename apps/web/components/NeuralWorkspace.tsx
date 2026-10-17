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

export type NeuralDraft = { units?: string | undefined; referencePriceUsd?: string | undefined; budgetUsd?: string | undefined };
export function NeuralWorkspace({ initial = {}, onEdit, inline = false }: { initial?: NeuralDraft; onEdit?: () => void; inline?: boolean }) {
  const [units, setUnits] = useState(initial.units ?? '');
  const [referencePriceUsd, setReference] = useState(initial.referencePriceUsd ?? '');
  const [budgetUsd, setBudget] = useState(initial.budgetUsd ?? DEFAULT_BUDGET_USD);
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NeuralPreview | null>(null);
  const revision = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastRequest = useRef<string | null>(null);
  const reducedMotion = useReducedMotion();
  const replay = useReplay(reducedMotion);
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
    if (inputProblem || !consent) { setError(inputProblem ?? 'Confirm the synthetic simulation to continue.'); return; }
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
  const changeBudget = (value: string, intent: BudgetIntent) => {
    setBudget(value);
    clearTimeout(debounce.current);
    if (intent === 'drag' || !result || !consent || pending) return;
    if (intent === 'now') void run(value);
    else debounce.current = setTimeout(() => void run(value), 600);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'hedgenet-neural-result.json'; a.click(); URL.revokeObjectURL(url);
  };
  const improved = result?.outcome === 'improvement';
  const stale = Boolean(result && (!consent || problem || pending || Number(units) !== Number(result.exposure.units)
    || Number(referencePriceUsd) !== Number(result.exposure.referencePriceUsd) || Number(budgetUsd) !== Number(result.valuation.budgetUsd)));
  return <section aria-label="Experimental BTC simulation">
    <style>{`
      .neural-form { padding: 28px; border-bottom: 1px solid #e4e7ed; display: grid; gap: 20px; }
      .neural-form p { margin: 10px 0 0; line-height: 1.6; }
      .neural-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
      .neural-fields > label { display: grid; align-content: start; gap: 9px; font-size: 13px; color: #68738a; }
      .neural-fields input:not([type=range]) { width: 100%; min-width: 0; padding: 12px; border: 1px solid #cdd5e4; border-radius: 7px; font: inherit; font-size: 16px; color: #243b6a; background: #fff; }
      .neural-fields .lab-budget { width: auto; min-width: 0; }
      .neural-consent { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; line-height: 1.6; }
      .neural-consent input { flex-shrink: 0; margin-top: 4px; width: 17px; height: 17px; accent-color: #2f5cf5; }
      .neural-form .btn { justify-self: start; }
      .neural-raw { max-height: 420px; max-width: 100%; overflow: auto; font-size: 12px; }
      .provenance dd { overflow-wrap: anywhere; }
      @media (max-width: 640px) { .neural-fields { grid-template-columns: 1fr; } .neural-form { padding: 20px; } }
    `}</style>
    <div className="hedge-heading"><h1>{inline ? 'Try a separate BTC simulation' : 'Your BTC simulation.'}</h1>{onEdit && <button className="text-btn" onClick={onEdit}>Edit exposure</button>}</div>
    <div className="hedge-sheet">
      <form className="neural-form" onSubmit={e => { e.preventDefault(); void run(); }}>
        <div><span className="tag amber">Experimental · synthetic markets</span><p>BTC downside at 30 October 2026, 16:00 UTC. This does not confirm a real market match or create tradable positions.</p></div>
        <div className="neural-fields">
          <label>BTC holdings (0.1–5)<input required inputMode="decimal" value={units} onChange={e => { invalidate(); setUnits(e.target.value); }} /></label>
          <label>Reference price (USD)<input required inputMode="decimal" value={referencePriceUsd} onChange={e => { invalidate(); setReference(e.target.value); }} /></label>
          <BudgetControl value={budgetUsd} problem={budgetProblem(budgetUsd)} onChange={changeBudget} />
        </div>
        <label className="neural-consent"><input type="checkbox" checked={consent} onChange={e => { invalidate(); setConsent(e.target.checked); }} />I confirm these BTC inputs and opt into fictional synthetic markets settling at 2026-10-30 16:00 UTC, not my live exposure or catalogue matches.</label>
        <button className="btn primary" disabled={pending} type="submit">{pending ? 'Running inference…' : error ? 'Retry simulation' : 'Run experimental model'}</button>
        <p className="small muted">After your first run, release the slider to recalculate. No training or code generation happens here.</p>
        {error && <p role="alert" className="error">{error}</p>}
        {pending && <p role="status">Waiting for inference and exact financial checks. No progress estimate is available.</p>}
      </form>
      {result && <>
        {stale && <div className="stale-banner" role="status">Previous result · {result.exposure.units} BTC at {money(result.exposure.referencePriceUsd)}, budget {money(result.valuation.budgetUsd)}. {pending ? 'Recalculating…' : 'Confirm and run to update.'}</div>}
        <div className="lab-stage"><div className="lab-network">
          <div className="lab-network-head"><h2>Inside the finished inference</h2><span>Measured trace</span></div>
          <div className="lab-svg-scroll" tabIndex={0} aria-label="Neural trace; scroll horizontally"><NeuralCircuit preview={result} progress={replay.progress} reducedMotion={reducedMotion} /></div>
          <p className="mobile-pan">Swipe to inspect the finished trace.</p>
          <button className="btn quiet" onClick={() => replay.play(0, 4000)}>Replay finished trace</button> <button className="text-btn" onClick={replay.toggle}>{replay.playing ? 'Pause' : 'Play'}</button>
          <p className="small muted">Presentation only, not training or inference progress. Blue = positive weight; amber = negative. Activation values are actual ReLU outputs.</p>
        </div><aside className="lab-output">
          <h2>{improved ? 'Synthetic candidate' : 'No improvement. Candidate rejected.'}</h2>
          {improved ? <><LossPlot preview={result} reveal={1} /><p>Worst modeled loss {money(result.valuation.worstNetLossUsd)}, versus {money(result.valuation.worstOriginalLossUsd)} without a hedge.</p>
            {result.valuation.positions.filter(p => Number(p.shares) > 0).map(p => { const leg = result.legs.find(l => l.legId === p.legId); return <div className="position-row" key={p.legId}><span>{leg?.side} · {leg?.label}</span><strong>{shares(p.shares)} shares</strong></div>; })}
            <p>Simulated cost {money(result.valuation.totalCostUsd)} · not an order or recommendation.</p></>
            : <p>The exact evaluator found no worst-loss improvement. No basket is recommended. The rejected candidate and its trace remain available for inspection below.</p>}
          <p className="small muted">Partial protection only. Below the lowest synthetic bucket, payouts stop growing while BTC losses continue.</p>
        </aside></div>
        <details className="hedge-details"><summary>Experimental quality, provenance &amp; {improved ? 'candidate' : 'rejected candidate'} details</summary>
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
