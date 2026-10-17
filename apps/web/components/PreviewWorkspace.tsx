'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BudgetControl } from './BudgetControl.tsx';
import type { BudgetIntent } from './BudgetControl.tsx';
import { Circuit, unitSignal } from './Circuit.tsx';
import { LossPlot } from './LossPlot.tsx';
import { PreviewDetails } from './PreviewDetails.tsx';
import { requestPreview } from '../lib/client-api.ts';
import type { ApiFailure, Preview } from '../lib/client-api.ts';
import { money, shares } from '../lib/format.ts';
import { budgetProblem, exampleCopy } from '../lib/presets.ts';
import type { ExampleId } from '../lib/presets.ts';
import { useReducedMotion, useReplay } from '../lib/use-replay.ts';

const phases = ['Exposure', 'Markets', 'Network', 'Basket', 'Checks'];
const canonical = (value: string) => value.includes('.') ? value.replace(/\.?0+$/, '') : value;
const clamp = (v: number) => Math.max(0, Math.min(1, v));

export function PreviewWorkspace({ example, initialBudget, onEdit }: { example: ExampleId; initialBudget: string; onEdit: () => void }) {
  const copy = exampleCopy[example];
  const reducedMotion = useReducedMotion();
  const replay = useReplay(reducedMotion);
  const [input, setInput] = useState(initialBudget);
  const [result, setResult] = useState<Preview | null>(null);
  const [pendingBudget, setPendingBudget] = useState<string | null>(null);
  const [failure, setFailure] = useState<(ApiFailure & { budget: string }) | null>(null);
  const [unit, setUnit] = useState(2);
  const latestRevision = useRef(0);
  const lastCommitted = useRef<string | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resultRef = useRef<Preview | null>(null);

  const commit = useCallback(async (value: string, force = false) => {
    clearTimeout(debounce.current);
    if (budgetProblem(value)) return;
    const budget = canonical(value);
    if (!force && budget === lastCommitted.current) return; // Deduplicate unchanged commits.
    lastCommitted.current = budget;
    const revision = ++latestRevision.current;
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    setPendingBudget(budget);
    let response;
    try { response = await requestPreview({ example, budgetUsd: budget, revision }, controller.signal); }
    catch { return; } // Aborted by a newer commit.
    // Out-of-order protection: only the latest revision may replace what is shown.
    if (revision !== latestRevision.current) return;
    setPendingBudget(null);
    if (response.ok && response.data.revision === revision) {
      const first = !resultRef.current;
      resultRef.current = response.data;
      setResult(response.data);
      setFailure(null);
      replay.play(first ? 0 : 0.32, first ? 8000 : 2400);
    } else if (!response.ok) {
      setFailure({ ...response.error, budget });
      lastCommitted.current = resultRef.current?.valuation.budgetUsd ?? null;
    }
  }, [example, replay]);

  useEffect(() => {
    void commit(initialBudget);
    // Unmount (or StrictMode's dev remount) abandons the request so a remount can recommit.
    return () => { clearTimeout(debounce.current); inflight.current?.abort(); lastCommitted.current = null; latestRevision.current += 1; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onBudget = (value: string, intent: BudgetIntent) => {
    setInput(value);
    if (intent === 'drag') return; // Never request per slider tick; commit on release.
    if (intent === 'now') { void commit(value); return; }
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { void commit(value); }, 450);
  };

  const problem = budgetProblem(input);
  const shownBudget = result?.valuation.budgetUsd ?? null;
  const stale = Boolean(result && (pendingBudget !== null || problem || (shownBudget !== null && canonical(input) !== shownBudget)));
  const p = replay.progress;
  const reveal = clamp((p - 0.6) / 0.22);
  const eased = reveal * reveal * (3 - 2 * reveal);
  const phase = Math.min(4, Math.floor(p * 5));
  const variant = result ? Number(result.valuation.budgetUsd) / 5000 - 0.2 : 0;
  const v = result?.valuation;
  const bought = v ? v.positions.filter(position => position.shares !== '0') : [];
  const legMeta = (legId: string) => result?.legs.find(leg => leg.legId === legId);
  const outputs = (example === 'crypto' ? [['low-yes', 'YES below $55k'], ['mid-yes', 'YES $55k–$65k']] : [['rain-yes', 'YES: rain ≥ 1 mm']]).map(([id, label]) => ({
    label: label!,
    shares: v?.positions.find(position => position.legId === id!)?.shares ?? null,
  }));
  const inputs = copy.inputs.map(([label, value]) => [label, label === 'Hedge budget' ? money(shownBudget ?? canonical(input)) : value] as [string, string]);
  const networkState = !result ? (failure ? 'Evaluator refused' : 'Waiting for the evaluator')
    : replay.playing ? `${phases[phase]} · illustration` : p >= 1 ? 'Illustration complete' : 'Paused';
  const maxShares = Math.max(1, ...bought.map(position => Number(position.shares)));

  return (
    <>
      <div className="hedge-heading">
        <h1>Your hedge, taking shape.</h1>
        <button className="text-btn" onClick={onEdit}>Edit exposure</button>
      </div>
      <section className="hedge-sheet" aria-label="Interactive hedge">
        <div className="lab-controls">
          <div>
            <div className="exposure-context"><span className="dot" />{copy.context}<span className="tag amber">Illustrative preview · fictional markets</span></div>
            <p className="lab-exposure">{copy.quote}</p>
          </div>
          <BudgetControl value={input} problem={problem} onChange={onBudget} />
        </div>
        {(stale || failure) && (
          <div className="stale-banner" role="status">
            {failure ? <>Could not price {money(failure.budget)}: {failure.message} {result && <>Showing the previous result for {money(shownBudget)}. </>}
              <button className="text-btn" onClick={() => void commit(failure.budget, true)}>Retry</button></>
              : problem ? <>Showing the result for {money(shownBudget)}. Fix the amount to update.</>
              : <>Updating — results below are for the previous budget, {money(shownBudget)}.</>}
          </div>
        )}
        <div className="lab-stage">
          <div className="lab-network">
            <div className="lab-network-head"><h2>Inside your hedge</h2><span role="status">{networkState}</span></div>
            <p className="illustration-label">Explanatory illustration — scripted values, not model telemetry. No accepted neural model exists yet.</p>
            <div className="lab-svg-scroll" tabIndex={0} aria-label="Network diagram; scroll horizontally on small screens">
              <Circuit mode="illustration" inputs={inputs} outputs={outputs} progress={p} variant={variant}
                reducedMotion={reducedMotion} selectedUnit={unit} onSelectUnit={setUnit} />
            </div>
            <p className="mobile-pan">Swipe to follow the network.</p>
            <div className="network-caption">
              <div className="network-key"><span><i />Your inputs</span><span><i className="learned" />Scripted activations</span></div>
              <span>Line weight = illustrative connection strength</span>
            </div>
          </div>
          <aside className="lab-output" aria-busy={pendingBudget !== null}>
            <div className="section-row"><h2>Your remaining risk</h2>
              <span className={`tag${stale ? ' amber' : ''}`}>{!result ? 'Pricing…' : stale ? 'Updating — previous budget' : 'Illustrative result'}</span></div>
            <p>Loss after premiums and payouts{result ? ` · budget ${money(result.valuation.budgetUsd)}` : ''}.</p>
            {result ? (
              <>
                <div className="lab-output-plot">
                  <LossPlot preview={result} reveal={eased} />
                  <div className="lab-legend"><span><i className="swatch" />Without hedge</span><span><i className="swatch hedged" />With hedge, after cost</span></div>
                </div>
                {outputs.map((out, i) => (
                  <div className="lab-position" key={out.label}>
                    <div className="lab-position-head"><span>{out.label}</span><strong>{out.shares ? `${shares(out.shares)} shares` : '—'}</strong></div>
                    <div className={`allocation-track${i ? ' secondary' : ''}`}><span style={{ width: `${Number(out.shares ?? 0) / maxShares * 100}%` }} /></div>
                  </div>
                ))}
                <div className="lab-totals">
                  <div><small>Cost (no fees in fixture)</small><strong>{money(v!.totalCostUsd)}</strong></div>
                  <div><small>Worst modeled loss</small><strong>{money(v!.worstNetLossUsd)}</strong></div>
                </div>
                <div className="lab-domain">{copy.domain} Partial protection.</div>
              </>
            ) : (
              <p className="stage-line" role="status">{failure ? 'No result: see the message above.' : 'Pricing the fixed illustrative basket with the exact financial evaluator…'}</p>
            )}
          </aside>
        </div>
        <div className="lab-player">
          <div className="player-row">
            <button className="btn quiet" onClick={replay.toggle} disabled={!result}
              aria-label={replay.playing ? 'Pause illustration' : p >= 1 ? 'Replay illustration from start' : 'Play illustration'}>
              {replay.playing ? 'Ⅱ Pause' : p >= 1 ? '↺ Replay' : '▶ Play'}
            </button>
            <label className="replay-position">
              <span className="visually-hidden">Illustration position</span>
              <input type="range" min={0} max={100} step={0.1} value={p * 100} disabled={!result}
                aria-valuetext={`${Math.round(p * 100)}%, ${phases[phase]}`} onChange={event => replay.scrub(Number(event.target.value) / 100)} />
              <output>{Math.round(p * 100)}%</output>
            </label>
            <span className="small muted">Explanatory replay{reducedMotion ? ' · reduced motion: shown complete' : ''}</span>
          </div>
          <div className="phase-track">
            {phases.map((name, i) => (
              <button key={name} className={i === phase ? 'active' : i < phase ? 'done' : ''} aria-current={i === phase ? 'step' : undefined}
                disabled={!result} onClick={() => replay.scrub(i === 4 ? 1 : i * 0.2 + 0.1)}><b>0{i + 1}</b>{name}</button>
            ))}
          </div>
        </div>
      </section>
      <section className="outcome-strip" aria-label="Hedge summary">
        <div className="outcome-stat"><span>Worst-loss reduction</span>
          <strong>{result ? (result.worstLossReductionPct === null ? 'n/a' : `${result.worstLossReductionPct}%`) : '—'}</strong>
          <small>Versus no hedge, same modeled scenarios</small></div>
        <div className="outcome-stat"><span>Budget remaining</span><strong>{result ? money(result.unspentBudgetUsd) : '—'}</strong><small>After premiums</small></div>
        <div className="outcome-stat"><span>Maximum payout</span><strong>{result ? money(result.maximumPayoutUsd) : '—'}</strong>
          <small>In the best single scenario; conditional, not guaranteed</small></div>
      </section>
      <div className="hedge-bottom">
        <section>
          <h2>Your proposed positions</h2>
          {result && bought.length === 0 && <p>No shares at this budget: every leg would fall below the 5-share minimum.</p>}
          {bought.map(position => (
            <div className="position-row" key={position.legId}>
              <div><span className="yes">{legMeta(position.legId)?.side}</span> {legMeta(position.legId)?.label}
                <small>{copy.context} · fictional price {money(legMeta(position.legId)?.price ?? '')}</small></div>
              <strong>{shares(position.shares)} shares<small>{money(position.totalCostUsd)} all-in</small></strong>
            </div>
          ))}
          {result && <p className="small muted" style={{ marginTop: 10 }}>{v!.positions.length - bought.length} other {v!.positions.length - bought.length === 1 ? 'leg' : 'legs'}: 0 shares. Illustrative fixed allocation, not a recommendation.</p>}
        </section>
        <section className="risk-summary">
          <h2>What stays exposed</h2>
          <p>{result ? `${money(v!.worstNetLossUsd)} worst modeled loss remains, versus ${money(v!.worstOriginalLossUsd)} without a hedge.` : '—'}</p>
          <p style={{ marginTop: 12 }}>{copy.gap}</p>
        </section>
      </div>
      {result && <PreviewDetails preview={result} example={example} selectedUnit={unit} unitValue={unitSignal(unit, variant)} />}
    </>
  );
}
