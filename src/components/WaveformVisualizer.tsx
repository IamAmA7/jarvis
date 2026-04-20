import { useEffect, useRef } from 'react';
import type { RecorderState } from '../types';

interface WaveformProps {
  level: number;
  state: RecorderState;
}

const BARS = 28;

/**
 * Lightweight bar-style visualizer driven by the smoothed RMS level from
 * the recorder hook. We keep our own short history so the bars scroll.
 */
export function WaveformVisualizer({ level, state }: WaveformProps) {
  const historyRef = useRef<number[]>(new Array<number>(BARS).fill(0));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const active = state === 'recording';
    // Shift the history and push the latest level (decay on idle).
    const next = historyRef.current.slice(1);
    next.push(active ? Math.min(level * 2.6, 1) : 0);
    historyRef.current = next;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const gap = 3;
    const barW = Math.max(2, (w - gap * (BARS - 1)) / BARS);
    const cy = h / 2;

    for (let i = 0; i < BARS; i++) {
      const v = next[i];
      const bh = Math.max(2, v * (h - 4));
      const x = i * (barW + gap);
      const alpha = 0.35 + 0.65 * (i / BARS);
      ctx.fillStyle = active
        ? `rgba(124, 92, 255, ${alpha})`
        : `rgba(122, 134, 153, ${alpha * 0.5})`;
      ctx.fillRect(x, cy - bh / 2, barW, bh);
    }
  }, [level, state]);

  return (
    <div className="h-10 w-40">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
