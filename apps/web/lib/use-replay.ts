'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/**
 * Single animation clock for the explanatory illustration. Presentation time only:
 * it never gates financial results. Stops on page hide and unmount. Optional
 * looping repeats a measured trace; it does not run inference or training.
 */
export function useReplay(reducedMotion: boolean, loop = false) {
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const state = useRef({ p: 0, duration: 8000, last: 0, raf: 0 });
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;
  const loopRef = useRef(loop);
  loopRef.current = loop;

  const stop = useCallback(() => {
    cancelAnimationFrame(state.current.raf);
    state.current.raf = 0; state.current.last = 0;
    setPlaying(false);
  }, []);

  const tick = useCallback((time: number) => {
    const s = state.current;
    if (s.last) {
      const next = s.p + (time - s.last) / s.duration;
      s.p = loopRef.current ? next % 1 : Math.min(1, next);
    }
    s.last = time;
    setProgress(s.p);
    if (s.p >= 1) { s.raf = 0; s.last = 0; setPlaying(false); return; }
    s.raf = requestAnimationFrame(tick);
  }, []);

  const play = useCallback((from?: number, duration = 8000) => {
    cancelAnimationFrame(state.current.raf);
    const s = state.current;
    if (reducedRef.current) { s.p = 1; setProgress(1); setPlaying(false); return; }
    s.p = from ?? (s.p >= 1 ? 0 : s.p); s.duration = duration; s.last = 0;
    setProgress(s.p); setPlaying(true);
    s.raf = requestAnimationFrame(tick);
  }, [tick]);

  const scrub = useCallback((p: number) => {
    stop();
    state.current.p = Math.max(0, Math.min(1, p));
    setProgress(state.current.p);
  }, [stop]);

  const toggle = useCallback(() => {
    if (state.current.raf) stop();
    else play(state.current.p >= 1 ? 0 : state.current.p, 8000);
  }, [play, stop]);

  useEffect(() => {
    const onHide = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', onHide);
    return () => { document.removeEventListener('visibilitychange', onHide); cancelAnimationFrame(state.current.raf); };
  }, [stop]);

  useEffect(() => { if (reducedMotion) { stop(); state.current.p = 1; setProgress(1); } }, [reducedMotion, stop]);

  return { progress, playing, play, scrub, toggle, stop };
}
