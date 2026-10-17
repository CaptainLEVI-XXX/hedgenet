'use client';
import { memo, useMemo, useRef } from 'react';
import type { KeyboardEvent } from 'react';

// Authored design values for the explanatory illustration. Never trained weights or measured activations.
const SCRIPTED_SIGNAL = [0.31, 0.77, 0.54, 0.42, 0.89, 0.38, 0.63, 0.81, 0.47];
export const unitSignal = (i: number, variant: number) =>
  Math.max(0, Math.min(1, SCRIPTED_SIGNAL[i % 9]! + variant * (i % 2 ? 0.3 : -0.22)));

const clamp = (v: number) => Math.max(0, Math.min(1, v));
type Node = { x: number; y: number; id: string };
const layers: Node[][] = [
  [80, 145, 210, 275, 340].map((y, i) => ({ x: 162, y, id: `I${i}` })),
  [80, 145, 210, 275, 340].map((y, i) => ({ x: 292, y, id: `H${i + 1}` })),
  [105, 175, 245, 315].map((y, i) => ({ x: 435, y, id: `H${i + 6}` })),
  [165, 275].map((y, i) => ({ x: 572, y, id: `O${i}` })),
];
const hidden = [...layers[1]!, ...layers[2]!];

export type CircuitProps = {
  mode: 'illustration' | 'unavailable';
  inputs: Array<[string, string]>;
  outputs: Array<{ label: string; shares: string | null }>;
  progress: number;
  variant: number;
  reducedMotion: boolean;
  selectedUnit: number;
  onSelectUnit: (index: number) => void;
};

export const Circuit = memo(function Circuit(props: CircuitProps) {
  const { mode, inputs, outputs, progress: p, variant, reducedMotion, selectedUnit, onSelectUnit } = props;
  const live = mode === 'illustration';
  const nodeRefs = useRef<Array<SVGGElement | null>>([]);
  const wires = useMemo(() => {
    const list: Array<{ layer: number; from: string; to: string; x1: number; y1: number; x2: number; y2: number }> = [];
    layers.slice(0, 3).forEach((group, layer) => group.forEach(a => layers[layer + 1]!.forEach((b, bi) => {
      if (bi >= outputs.length && layer === 2) return;
      list.push({ layer, from: a.id, to: b.id, x1: a.x + (layer ? 21 : 0), y1: a.y, x2: b.x - (layer < 2 ? 21 : 0), y2: b.y });
    })));
    return list;
  }, [outputs.length]);
  const selectedId = hidden[selectedUnit]?.id;
  const reveal = clamp((p - 0.6) / 0.22);

  const onKey = (event: KeyboardEvent<SVGGElement>, index: number) => {
    let next = index;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectUnit(index); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % hidden.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + hidden.length) % hidden.length;
    else return;
    event.preventDefault();
    onSelectUnit(next);
    nodeRefs.current[next]?.focus();
  };

  return (
    <svg className="lab-net-svg" viewBox="0 0 730 410" role="group"
      aria-label={live ? 'Explanatory illustration of a neural circuit with scripted values. Use arrow keys to move between hidden units; Enter selects.'
        : 'Static schematic. Trace unavailable: no model run exists.'}>
      <text x="17" y="23" fontSize="11" fill="#6f7b93">Exposure + market features</text>
      <text x="292" y="23" textAnchor="middle" fontSize="11" fill="#6f7b93">Hidden layer</text>
      <text x="435" y="23" textAnchor="middle" fontSize="11" fill="#6f7b93">Hidden layer</text>
      <text x="580" y="23" fontSize="11" fill="#6f7b93">Share proposal</text>
      {wires.map((w, i) => {
        const t = live ? clamp((p - (0.18 + w.layer * 0.17)) / 0.26) : 0;
        const v = (t * 2.5 + i * 0.137) % 1, u = 1 - v;
        const traced = live && (w.from === selectedId || w.to === selectedId);
        const weight = live ? 0.5 + unitSignal(i % 9, variant) * 1.5 : 1;
        const cx = u * u * u * w.x1 + 3 * u * u * v * (w.x1 + 50) + 3 * u * v * v * (w.x2 - 50) + v * v * v * w.x2;
        const cy = u * u * u * w.y1 + 3 * u * u * v * w.y1 + 3 * u * v * v * w.y2 + v * v * v * w.y2;
        return (
          <g key={`${w.from}-${w.to}`}>
            <path className={`net-wire${traced ? ' traced' : ''}`} style={{ opacity: live ? 0.25 + 0.65 * t : 0.45, ['--weight' as string]: weight }}
              d={`M${w.x1} ${w.y1} C${w.x1 + 50} ${w.y1} ${w.x2 - 50} ${w.y2} ${w.x2} ${w.y2}`} />
            {live && !reducedMotion && t > 0 && t < 1 && <circle className="net-packet" r="2.8" cx={cx} cy={cy} opacity=".85" />}
          </g>
        );
      })}
      {inputs.map(([label, value], i) => (
        <g key={label}>
          <rect className="net-input-box" x="16" y={55 + i * 65} width="146" height="50" rx="7" />
          <text x="29" y={74 + i * 65} fontSize="10" fill="#68738a">{label}</text>
          <text x="29" y={93 + i * 65} fontSize="14" fontWeight="550" fill="#243b6a">{value}</text>
        </g>
      ))}
      {hidden.map((n, i) => {
        const signal = unitSignal(i, variant);
        const intensity = live ? clamp((p - (i < 5 ? 0.34 : 0.49)) / 0.16) * signal : 0;
        const interactive = live;
        return (
          <g key={n.id} ref={el => { nodeRefs.current[i] = el; }} className={`net-node${live && i === selectedUnit ? ' selected' : ''}`}
            {...(interactive ? { role: 'button', tabIndex: i === selectedUnit ? 0 : -1, 'aria-pressed': i === selectedUnit,
              'aria-label': `Hidden unit ${n.id}, scripted illustrative value ${signal.toFixed(2)}`,
              onClick: () => onSelectUnit(i), onKeyDown: (e: KeyboardEvent<SVGGElement>) => onKey(e, i) } : { 'aria-hidden': true })}>
            <circle className="focus-ring" cx={n.x} cy={n.y} r="26" fill="none" stroke="none" />
            <circle className="unit-ring" cx={n.x} cy={n.y} r="21" />
            <circle cx={n.x} cy={n.y} r="16" fill="#2f5cf5" opacity={intensity * 0.82} />
            <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize="11" fill="#223b74">{n.id}</text>
            <text x={n.x} y={n.y + 38} textAnchor="middle" fontSize="10" fill="#61718d">{live && p > 0.34 ? signal.toFixed(2) : '—'}</text>
          </g>
        );
      })}
      {[0, 1].map(i => {
        const out = outputs[i];
        return (
          <g key={i} opacity={out ? 1 : 0.35}>
            <rect className="net-output-box" x="572" y={132 + i * 110} width="142" height="66" rx="8" />
            <text x="585" y={153 + i * 110} fontSize="11" fill="#4e6697">{out?.label ?? 'No second position'}</text>
            <text x="585" y={180 + i * 110} fontSize="19" fill="#294eac">
              {out?.shares && live && reveal >= 1 ? `${Number(out.shares).toLocaleString('en-US')} shares` : '—'}
            </text>
          </g>
        );
      })}
      <text x="292" y="398" textAnchor="middle" fontSize="10" fill="#7a8395">
        {live ? 'Select a unit to follow its connections' : 'Trace unavailable · no model run'}
      </text>
      <text x="642" y="360" textAnchor="middle" fontSize="10" fill="#7a8395">Then: exact financial checks</text>
      <path d="M642 310v22m-4-4 4 4 4-4" stroke="#8e9cba" fill="none" />
    </svg>
  );
});
