'use client';
import { useRef } from 'react';
import { money } from '../lib/format.ts';
import { PREVIEW_BUDGET_MAX_USD } from '../lib/presets.ts';

export type BudgetIntent = 'drag' | 'debounce' | 'now';

/** Slider and precise number input share one budget value. Commits on release or after a pause. */
export function BudgetControl({ value, problem, onChange }: {
  value: string; problem: string | null; onChange: (value: string, intent: BudgetIntent) => void;
}) {
  const dragging = useRef(false);
  const numeric = Number(value);
  const sliderValue = Number.isFinite(numeric) ? Math.min(PREVIEW_BUDGET_MAX_USD, Math.max(0, numeric)) : 0;
  const release = () => { if (dragging.current) { dragging.current = false; onChange(value, 'now'); } };
  return (
    <div className="lab-budget">
      <label htmlFor="budget-slider">Hedge budget <output htmlFor="budget-slider budget-number" aria-live="off">{problem ? '—' : money(value)}</output></label>
      <input id="budget-slider" type="range" min={0} max={PREVIEW_BUDGET_MAX_USD} step={50} value={sliderValue}
        aria-valuetext={money(String(sliderValue))}
        onPointerDown={() => { dragging.current = true; }} onPointerUp={release} onPointerCancel={release}
        onChange={event => onChange(event.target.value, dragging.current ? 'drag' : 'debounce')} />
      <div className="budget-scale"><span>$0</span><span>Slide or type an amount</span><span>$5,000</span></div>
      <div className="budget-precise">
        <label htmlFor="budget-number">Exact amount (USD)</label>
        <input id="budget-number" type="text" inputMode="decimal" autoComplete="off" value={value}
          aria-invalid={problem ? true : undefined} aria-describedby={problem ? 'budget-problem' : undefined}
          onChange={event => onChange(event.target.value.trim(), 'debounce')}
          onBlur={() => onChange(value, 'now')}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onChange(value, 'now'); } }} />
      </div>
      {problem && <p id="budget-problem" className="budget-problem" role="alert">Outside validated range: {problem} Nothing was clamped or recalculated.</p>}
    </div>
  );
}
