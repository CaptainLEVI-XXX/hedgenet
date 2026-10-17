'use client';
import type { Preview } from '../lib/client-api.ts';
import { money, shares } from '../lib/format.ts';
import { exampleCopy } from '../lib/presets.ts';
import type { ExampleId } from '../lib/presets.ts';

/** One collapsed disclosure: loss rule, rules, scenario table and provenance. */
export function PreviewDetails({ preview, example, selectedUnit, unitValue }: {
  preview: Preview; example: ExampleId; selectedUnit: number; unitValue: number;
}) {
  const copy = exampleCopy[example];
  const v = preview.valuation;
  const unitId = `H${selectedUnit + 1}`;
  return (
    <details className="hedge-details">
      <summary>Assumptions, settlement rules, scenario table &amp; provenance</summary>
      <p>{copy.loss}</p>
      <p>{copy.rules}</p>
      <div className="table-wrap scenario-table">
        <table>
          <caption>Every modeled scenario, from the exact evaluator (USD, budget {money(v.budgetUsd)})</caption>
          <thead><tr><th scope="col">Scenario</th><th scope="col">Loss without hedge</th><th scope="col">Payout</th><th scope="col">Cost</th><th scope="col">Net loss</th></tr></thead>
          <tbody>
            {v.scenarios.map(s => (
              <tr key={s.stateId}>
                <th scope="row">{preview.scenarioLabels[s.stateId]}</th>
                <td className="num">{money(s.originalLossUsd)}</td><td className="num">{money(s.payoutUsd)}</td>
                <td className="num">{money(v.totalCostUsd)}</td><td className="num">{money(s.netLossUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">Net loss = loss without hedge + total cost − payout. Worst modeled loss is the largest net loss above, not the maximum possible loss. Prices are not probabilities.</p>
      <div className="lab-inspectors">
        <section className="panel">
          <h2>Provenance</h2>
          <dl className="provenance">
            <div><dt>Proposal source</dt><dd>Illustrative fixed allocation ({example === 'crypto' ? '70% of budget to YES below $55k, 30% to YES $55k–$65k' : 'budget to rain YES, capped at 5,000 shares'}; whole shares, minimum 5). Not a neural model and not a solver.</dd></div>
            <div><dt>Neural model</dt><dd>None accepted yet. Nothing substituted.</dd></div>
            <div><dt>Activation trace</dt><dd>{preview.trace === null ? 'None. The circuit is an explanatory illustration with scripted values.' : 'Present'}</dd></div>
            <div><dt>Data mode</dt><dd>Synthetic · fictional prices and depth · no fees · no live books</dd></div>
            <div><dt>Evaluator</dt><dd>{v.schemaVersion} · {v.depthPolicy} · {v.feePolicy}</dd></div>
            <div><dt>Snapshot / valuation</dt><dd className="mono">{v.snapshotId} · {v.valuationHash.slice(0, 12)}…</dd></div>
            <div><dt>Revision</dt><dd>{preview.revision}</dd></div>
          </dl>
        </section>
        <section className="panel">
          <h2>Independent accounting</h2>
          <div className="gate-row"><span>Within budget</span><span>{money(v.totalCostUsd)} ≤ {money(v.budgetUsd)}</span></div>
          <div className="gate-row"><span>Loss + cost − payout</span><span>Recomputed for {v.scenarios.length} scenarios</span></div>
          <div className="gate-row"><span>Positions</span><span>{v.positions.map(p => shares(p.shares)).join(' / ')}</span></div>
          <div className="gate-row"><span>Live liquidity &amp; rules</span><span className="tag amber">Not checked · fictional</span></div>
          <div className="unit-reading"><strong>{unitValue.toFixed(2)}</strong>
            <p className="small">Selected hidden unit {unitId}: scripted illustrative value, not an activation, confidence or protection level.</p></div>
        </section>
      </div>
    </details>
  );
}
