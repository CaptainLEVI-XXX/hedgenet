'use client';
import type { Preview } from '../lib/client-api.ts';

const k = (v: number) => `${v < 0 ? '−' : ''}$${Math.round(Math.abs(v) / 100) / 10}k`;

/**
 * Original vs remaining net loss from the server's scenario values. `reveal` < 1 interpolates for
 * the explanatory transition only; at 1 the drawn values equal the evaluator's result exactly.
 */
export function LossPlot({ preview, reveal }: { preview: Pick<Preview, 'valuation' | 'example' | 'scenarioLocations' | 'scenarioLabels'>; reveal: number }) {
  const scenarios = preview.valuation.scenarios;
  const nets = scenarios.map(s => Number(s.netLossUsd));
  const originals = scenarios.map(s => Number(s.originalLossUsd));
  const min = Math.floor(Math.min(0, ...nets) / 1000) * 1000;
  const max = Math.ceil(Math.max(1000, ...originals, ...nets) / 1000) * 1000;
  const y = (v: number) => 174 - (v - min) / (max - min) * 146;
  const shown = (i: number) => originals[i]! + (nets[i]! - originals[i]!) * reveal;
  const gridValues = [min, (min + max) / 2, max];
  const grid = gridValues.map(v => (
    <g key={v}><line x1="38" x2="278" y1={y(v)} y2={y(v)} stroke="#e4e7ed" />
      <text x="31" y={y(v) + 3} textAnchor="end" fill="#686c75">{k(v)}</text></g>
  ));

  if (preview.example === 'weather') {
    return (
      <svg className="lab-out-chart" viewBox="0 0 300 215" role="img"
        aria-label="Loss by rainfall outcome, without and with the illustrative hedge. Exact values are in the scenario table.">
        <text x="38" y="12" fill="#686c75">Loss (USD)</text>{grid}
        {scenarios.map((s, i) => {
          const x = 90 + i * 115;
          return (
            <g key={s.stateId}>
              <path d={`M${x - 22} 174V${y(originals[i]!)}h24V174Z`} fill="#c6c9d1" />
              <path d={`M${x + 10} 174V${y(shown(i))}h24V174Z`} fill="#2f5cf5" />
              <text x={x + 6} y="192" textAnchor="middle" fill="#686c75">{preview.scenarioLabels[s.stateId]}</text>
            </g>
          );
        })}
        <text x="155" y="212" textAnchor="middle" fill="#686c75">Daily station rainfall</text>
      </svg>
    );
  }

  // Numeric partition: loss and payouts are linear within each bucket, so joining same-bucket
  // points is exact; vertical jumps at thresholds are real payout discontinuities.
  const numeric = Object.values(preview.scenarioLocations).filter(location => location.kind === 'numeric');
  const xMax = Math.ceil(Math.max(70000, ...numeric.map(location => Number(location.value))) * 1.1 / 10000) * 10000;
  const boundaries = [...new Set(numeric.filter(location => location.side === 'below').map(location => Number(location.value)))];
  const points = scenarios.map((s, i) => {
    const location = preview.scenarioLocations[s.stateId]!;
    const value = location.kind === 'numeric' ? Number(location.value) : location.kind === 'tail' ? xMax : 0;
    return { i, value, side: location.kind === 'numeric' ? location.side : 'tail' };
  });
  const x = (v: number) => 38 + v / xMax * 240;
  const path = (key: 'original' | 'net') => points.map((pt, j) =>
    `${j ? 'L' : 'M'}${x(pt.value).toFixed(1)},${y(key === 'original' ? originals[pt.i]! : shown(pt.i)).toFixed(1)}`).join(' ');
  return (
    <svg className="lab-out-chart" viewBox="0 0 300 215" role="img"
      aria-label="Modeled loss by Bitcoin settlement price, without and with the candidate after cost. Jumps are payout thresholds. Exact values are in the scenario table.">
      <text x="38" y="12" fill="#686c75">Loss (USD)</text>{grid}
      {boundaries.map(v => <line key={v} x1={x(v)} x2={x(v)} y1="28" y2="174" stroke="#d9e0f5" strokeDasharray="3 5" />)}
      <path d={path('original')} fill="none" stroke="#989da9" strokeWidth="1.8" strokeDasharray="4 4" />
      <path d={path('net')} fill="none" stroke="#2f5cf5" strokeWidth="2.5" />
      {[[0, '$0'], [xMax / 2, k(xMax / 2)], [xMax, k(xMax)]].map(([v, l]) => (
        <text key={l} x={x(v as number)} y="192" textAnchor="middle" fill="#686c75">{l}</text>
      ))}
      <text x="155" y="212" textAnchor="middle" fill="#686c75">BTC price · upper tail shown at {k(xMax)}</text>
    </svg>
  );
}
