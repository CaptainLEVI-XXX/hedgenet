'use client';
import { useEffect, useRef } from 'react';
import type { FormEvent } from 'react';
import { presets } from '../lib/presets.ts';
import type { PresetId } from '../lib/presets.ts';

export function Composer({ draft, notice, busy, onDraft, onChoose, onSubmit }: {
  draft: string; notice: string | null; busy: boolean;
  onDraft: (text: string) => void; onChoose: (id: PresetId) => void; onSubmit: () => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (notice) textarea.current?.focus(); }, [notice]);
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit(); };
  const selected = (Object.keys(presets) as PresetId[]).find(id => presets[id].text === draft.trim());
  return (
    <section className="intro">
      <div className="intro-head">
        <h1>What’s your downside?</h1>
        <p>Describe your exposure. See a hedge take shape.</p>
      </div>
      <form className="composer" onSubmit={submit}>
        <label htmlFor="exposure">Your exposure</label>
        <textarea id="exposure" ref={textarea} value={draft} maxLength={4000}
          aria-describedby={notice ? 'input-notice composer-hint' : 'composer-hint'}
          placeholder="I’m worried about… Tell us what could happen, when, and how much you could lose."
          onChange={event => onDraft(event.target.value)} />
        <div className="composer-bottom">
          <p id="composer-hint">{selected ? 'This example uses fictional markets and a fixed observation date.' : 'Your description and date stay yours. Jev interprets the risk and looks for related markets; it does not price a live hedge yet.'}</p>
          <button className="btn primary" type="submit" disabled={busy}>{selected ? 'Build my demo hedge' : 'Find related markets'} <span className="arrow" aria-hidden="true">↗</span></button>
        </div>
        <p id="input-notice" className="error" role="status">{notice}</p>
      </form>
      <div className="example-label">Try an example <span className="tag">Synthetic data</span></div>
      <div className="examples">
        {(Object.keys(presets) as PresetId[]).map(id => (
          <button key={id} type="button" className={`example${selected === id ? ' selected' : ''}`} aria-pressed={selected === id}
            onClick={() => { onChoose(id); textarea.current?.focus(); }}>
            <span className="example-top"><span className="glyph" aria-hidden="true">{presets[id].glyph}</span>{presets[id].title}</span>
            <p>{presets[id].blurb}</p>
          </button>
        ))}
      </div>
      <div className="intro-foot">Experimental model. Synthetic prices. No trades or wallet required.</div>
    </section>
  );
}
