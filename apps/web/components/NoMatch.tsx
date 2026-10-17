'use client';
import { useEffect, useRef } from 'react';

/** Illustrative no-compatible-market outcome for the fictional vineyard preset. No network run. */
export function NoMatch({ text, onEdit, onTryBitcoin }: { text: string; onEdit: () => void; onTryBitcoin: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <section className="no-match">
      <div className="empty-mark" aria-hidden="true">≠</div>
      <div className="page-head"><div>
        <h1 ref={heading} tabIndex={-1}>No match. No forced hedge.</h1>
        <p>The illustrative shortlist has no market that covers this exposure. <span className="tag amber">Illustrative preview · fictional markets</span></p>
      </div></div>
      <p className="brief-quote">“{text}”</p>
      <div className="compare">
        <div><span className="tag blue">Your exposure</span><h3>Overnight frost in Bordeaux</h3><p>Vine damage · 12 April 2027<br />$8,000 conditional loss</p></div>
        <div><span className="tag amber">Rejected candidate</span><h3>Average temperature in Paris</h3><p>Wrong location. Wrong measurement.<br />A related category isn’t enough.</p></div>
      </div>
      <p style={{ marginBottom: 24 }}>No network proposal was run.</p>
      <button className="btn primary" onClick={onEdit}>Edit exposure</button>{' '}
      <button className="btn quiet" onClick={onTryBitcoin}>Try Bitcoin instead</button>
    </section>
  );
}
