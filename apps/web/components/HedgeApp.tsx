'use client';
import { useEffect, useRef, useState } from 'react';
import { Composer } from './Composer.tsx';
import { LiveWorkspace } from './LiveWorkspace.tsx';
import type { LiveState } from './LiveWorkspace.tsx';
import { NoMatch } from './NoMatch.tsx';
import { PreviewWorkspace } from './PreviewWorkspace.tsx';
import { NeuralWorkspace } from './NeuralWorkspace.tsx';
import { requestLiveIntake } from '../lib/client-api.ts';
import { DEFAULT_BUDGET_USD, matchPreset, presets } from '../lib/presets.ts';
import type { ExampleId, PresetId } from '../lib/presets.ts';

type View = { kind: 'describe' } | { kind: 'neural'; preset: boolean; session: number } | { kind: 'preview'; example: ExampleId; session: number } | { kind: 'nomatch' } | { kind: 'live'; text: string };

export function HedgeApp() {
  const [view, setView] = useState<View>({ kind: 'describe' });
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const liveRevision = useRef(0);
  const liveAbort = useRef<AbortController | null>(null);
  const session = useRef(0);
  const main = useRef<HTMLElement>(null);

  useEffect(() => { window.scrollTo(0, 0); if (view.kind !== 'nomatch') main.current?.focus({ preventScroll: true }); }, [view]);

  const openPreview = (example: ExampleId) => setView(example === 'crypto'
    ? { kind: 'neural', preset: true, session: ++session.current }
    : { kind: 'preview', example, session: ++session.current });

  // Live intake starts only from an explicit user action (never from an effect), so it cannot double-fire.
  const runLive = async (text: string) => {
    liveAbort.current?.abort();
    const controller = new AbortController();
    liveAbort.current = controller;
    const revision = ++liveRevision.current;
    setLive({ status: 'running', startedAt: Date.now() });
    setView({ kind: 'live', text });
    let response;
    try { response = await requestLiveIntake(text, controller.signal); } catch { return; }
    if (revision !== liveRevision.current) return;
    setLive(response.ok ? { status: 'done', result: response.data } : { status: 'error', error: response.error });
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) { setNotice('Describe your exposure first, or choose an example.'); return; }
    setNotice(null);
    const preset = matchPreset(text);
    if (preset === 'none') setView({ kind: 'nomatch' });
    else if (preset) openPreview(preset);
    else void runLive(text);
  };

  const edit = () => {
    // Abandon the local wait; the description is preserved. (A request already sent may still finish server-side.)
    liveAbort.current?.abort(); liveRevision.current += 1;
    setView({ kind: 'describe' });
  };
  const choose = (id: PresetId) => { setDraft(presets[id].text); setNotice(null); };
  const tryBitcoin = () => { setDraft(presets.crypto.text); openPreview('crypto'); };

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <button className="brand" onClick={edit} aria-label="HedgeNet home">
          <svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><path d="M3 27 12 7 21 27 31 7" stroke="#2f5cf5" strokeWidth="3.4" strokeLinejoin="round" /><path d="m3 32 9-13 9 13 10-13" stroke="#2f5cf5" strokeWidth="2" opacity=".35" /></svg>HedgeNet
        </button>
        <div className="sim"><span className="dot" /> Simulation<span className="desktop-only"> — no trades placed</span></div>
      </header>
      <main id="main" ref={main} tabIndex={-1}>
        {view.kind === 'describe' && <><Composer draft={draft} notice={notice} busy={false} onDraft={setDraft} onChoose={choose} onSubmit={submit} />
          <div className="intro-foot"><button className="text-btn" onClick={() => setView({ kind: 'neural', preset: false, session: ++session.current })}>Adjust amounts in the BTC demo</button></div></>}
        {view.kind === 'neural' && <NeuralWorkspace key={view.session} initial={view.preset ? { units: '0.2', referencePriceUsd: '70000', budgetUsd: DEFAULT_BUDGET_USD } : {}} autoRun={view.preset} onEdit={edit} />}
        {view.kind === 'preview' && <PreviewWorkspace key={view.session} example={view.example} initialBudget={DEFAULT_BUDGET_USD} onEdit={edit} />}
        {view.kind === 'nomatch' && <NoMatch text={draft.trim()} onEdit={edit} onTryBitcoin={tryBitcoin} />}
        {view.kind === 'live' && live && <LiveWorkspace text={view.text} state={live} onEdit={edit}
          onRetry={() => void runLive(view.text)} onTryExample={() => { setDraft(presets.crypto.text); setView({ kind: 'describe' }); }} />}
      </main>
      <footer><span>HedgeNet / Risk, made visible.</span><span>Research demo. Not financial advice. No trades.</span></footer>
    </>
  );
}
