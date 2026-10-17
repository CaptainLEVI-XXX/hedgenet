'use client';
import { useEffect, useState } from 'react';

export type MarketLink = { eventId: string; title: string; url: string | null };

/** Discovery links are separate from the fictional positions above them. */
export function MarketLinks({ events }: { events?: MarketLink[] }) {
  const [found, setFound] = useState<MarketLink[]>([]);
  useEffect(() => {
    if (events) return;
    const controller = new AbortController();
    fetch('/api/events', { signal: controller.signal }).then(async response => {
      if (response.ok) setFound((await response.json()).events ?? []);
    }).catch(() => { /* Links are optional; never interrupt a financial result. */ });
    return () => controller.abort();
  }, [events]);
  const links = (events ?? found).filter(item => item.url?.startsWith('https://polymarket.com/event/'));
  if (!links.length) return null;
  return <section className="market-links" aria-label="Polymarket event links">
    <h3>Explore on Polymarket <span aria-hidden="true">↗</span></h3>
    <p>Related events. Not used in this simulation.</p>
    {links.map(item => <a key={item.eventId} href={item.url!} target="_blank" rel="noopener noreferrer">{item.title}<span aria-hidden="true">↗</span></a>)}
  </section>;
}
