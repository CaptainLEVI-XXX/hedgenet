'use client';
import type { NeuralPreview } from '../lib/neural-contract.ts';

/** One actual hidden layer; eight of 32 units, no inter-hidden connections. */
export function NeuralCircuit({ preview, progress, reducedMotion }: { preview: NeuralPreview; progress: number; reducedMotion: boolean }) {
  const t = preview.trace;
  const outputs = preview.valuation.positions.map(p => ({ ...p, i: preview.legs.findIndex(l => l.legId === p.legId) }))
    .sort((a, b) => Number(b.shares) - Number(a.shares)).slice(0, 2);
  const maxWeight = Math.max(0.00001, ...t.inputWeights.flat().map(Math.abs), ...t.outputWeights.flat().map(Math.abs));
  const maxActivation = Math.max(0.00001, ...t.hidden);
  const weightStyle = (w: number) => ({ stroke: w < 0 ? '#b67c51' : '#2f5cf5', strokeWidth: 0.4 + 2.2 * Math.abs(w) / maxWeight, opacity: 0.35 });
  const shortLabels = ['Budget ÷ scale', 'Worst loss ÷ scale', 'First state loss ÷ scale', 'Low YES · ask price', 'Low YES · depth ÷ scale'];
  const packet = (x1: number, y1: number, x2: number, y2: number, offset: number, weight: number) => {
    const phase = (progress * 2 + offset) % 1;
    return !reducedMotion
      ? <circle r="2.6" opacity={Math.sin(phase * Math.PI) * 0.85} fill={weight < 0 ? '#b67c51' : '#2f5cf5'} cx={x1 + (x2 - x1) * phase} cy={y1 + (y2 - y1) * phase} /> : null;
  };
  return <svg viewBox="0 0 740 460" className="lab-net-svg" role="img" aria-label="Measured neural trace: five encoded features, one hidden layer (eight of 32 units), two largest candidate positions. Line thickness is absolute learned weight; blue positive, amber negative.">
    <text x="16" y="22" fill="#6f7b93">5 / 738 features</text><text x="295" y="22" fill="#6f7b93">One hidden layer · 8 / 32</text><text x="550" y="22" fill="#6f7b93">Candidate outputs</text>
    {t.inputGroups.map((g, j) => <g key={j}>
      {t.hidden.slice(0, 8).map((_, i) => <g key={i}><path d={`M174 ${80 + j * 74} L360 ${54 + i * 51}`} style={weightStyle(t.inputWeights[i]![j]!)}><title>{`${g.label} → H${i + 1}: weight ${t.inputWeights[i]?.[j]}`}</title></path>{packet(174, 80 + j * 74, 360, 54 + i * 51, j * 0.19 + i * 0.13, t.inputWeights[i]![j]!)}</g>)}
      <rect x="12" y={55 + j * 74} width="162" height="50" rx="7" fill="#f3f6fc" /><text x="23" y={74 + j * 74} fontSize="11" fill="#68738a"><title>{g.label}</title>{shortLabels[j]}</text><text x="23" y={94 + j * 74} fill="#243b6a">{g.value.toPrecision(4)}</text>
    </g>)}
    {outputs.map((p, j) => <g key={p.legId}>
      {t.hidden.slice(0, 8).map((_, i) => <g key={i}><path d={`M380 ${54 + i * 51} L550 ${160 + j * 160}`} style={weightStyle(t.outputWeights[p.i]![i]!)}><title>{`H${i + 1} → ${p.legId}: weight ${t.outputWeights[p.i]?.[i]}`}</title></path>{packet(380, 54 + i * 51, 550, 160 + j * 160, 0.55 + j * 0.17 + i * 0.11, t.outputWeights[p.i]![i]!)}</g>)}
      <rect x="550" y={125 + j * 160} width="180" height="95" rx="8" fill="#eef3ff" />
      <text x="560" y={146 + j * 160} fontSize="11" fill="#294eac">{preview.legs.find(l => l.legId === p.legId)?.side} · {preview.legs.find(l => l.legId === p.legId)?.label.replace('BTC ', '').replaceAll(',000', 'k').replace('to under', '–')}</text>
      <text x="560" y={172 + j * 160} fontSize="16" fill="#294eac">{p.shares} shares</text><text x="560" y={197 + j * 160} fontSize="11" fill="#68738a">Raw: {t.outputs[p.i]?.toPrecision(5)}</text>
    </g>)}
    {t.hidden.slice(0, 8).map((value, i) => <g key={i}><circle cx="370" cy={54 + i * 51} r="21" fill="#f4f6fa" stroke="#a4b7e6" /><circle cx="370" cy={54 + i * 51} r="18" fill="#2f5cf5" opacity={value / maxActivation * 0.55} /><text x="370" y={58 + i * 51} textAnchor="middle" fontSize="11" fill="#243b6a">H{i + 1}</text><text x="402" y={58 + i * 51} fontSize="11" fill="#68738a">{value.toPrecision(4)}</text></g>)}
    <text x="16" y="449" fontSize="11" fill="#68738a">Learned weights · blue positive / amber negative</text>
  </svg>;
}
