'use client';
import { Maximize, ScanLine, Check, X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { fullQuad, suggestQuad } from '@/lib/process';
import type { Point, Quad } from '@/lib/types';
import { Button, Spinner } from './ui';

/**
 * ครอบเอกสาร: มุม 4 จุดลากได้ (บนซ้าย บนขวา ล่างขวา ล่างซ้าย) + แว่นขยายตอนลาก
 * ยืนยันแล้วจะปรับมุมมอง (perspective) ให้แบนเหมือนสแกน
 */
export default function CropEditor({ source, initial, onConfirm, onCancel, title, footer }: {
  source: HTMLCanvasElement;
  initial: Quad | null;
  onConfirm: (quad: Quad | null) => void;
  onCancel: () => void;
  title?: string;
  footer?: React.ReactNode;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLCanvasElement>(null);
  const lens = useRef<HTMLCanvasElement>(null);
  const [quad, setQuad] = useState<Quad>(initial || fullQuad(source.width, source.height));
  const [box, setBox] = useState({ w: 0, h: 0, s: 1 });
  const [drag, setDrag] = useState<number | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [busy, setBusy] = useState(false);

  // วาดภาพลง canvas แสดงผล (ย่อให้พอดีจอ) และคำนวณสเกล
  useEffect(() => {
    const fit = () => {
      const el = wrap.current; const c = imgRef.current;
      if (!el || !c) return;
      const s = Math.min(el.clientWidth / source.width, el.clientHeight / source.height);
      const w = Math.round(source.width * s), h = Math.round(source.height * s);
      c.width = w; c.height = h;
      c.getContext('2d')?.drawImage(source, 0, 0, w, h);
      setBox({ w, h, s });
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [source]);

  const toDisplay = (p: Point) => ({ x: p.x * box.s, y: p.y * box.s });
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));

  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (drag === null || !imgRef.current) return;
    const r = imgRef.current.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / box.s, source.width);
    const y = clamp((e.clientY - r.top) / box.s, source.height);
    setQuad((q) => { const n = [...q] as Quad; n[drag] = { x, y }; return n; });
    // แว่นขยาย: ขยาย 2.5 เท่ารอบจุดที่ลาก
    const l = lens.current?.getContext('2d');
    if (l && lens.current) {
      const size = 120 / (box.s * 2.5);
      l.clearRect(0, 0, 120, 120);
      l.drawImage(source, x - size / 2, y - size / 2, size, size, 0, 0, 120, 120);
      l.strokeStyle = '#2563eb'; l.lineWidth = 2;
      l.beginPath(); l.moveTo(60, 0); l.lineTo(60, 120); l.moveTo(0, 60); l.lineTo(120, 60); l.stroke();
    }
  };

  const autoDetect = async () => {
    setDetecting(true);
    const r = await suggestQuad(source);
    setDetecting(false);
    setQuad(r.quad || fullQuad(source.width, source.height));
  };

  const pts = quad.map(toDisplay);
  const labels = ['บนซ้าย', 'บนขวา', 'ล่างขวา', 'ล่างซ้าย'];
  const isFull = quad.every((p, i) => {
    const f = fullQuad(source.width, source.height)[i];
    return Math.abs(p.x - f.x) < 2 && Math.abs(p.y - f.y) < 2;
  });

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black text-white">
      <div className="flex items-center justify-between px-3 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2">
        <button className="inline-flex h-11 items-center gap-1 rounded-xl px-3 hover:bg-white/10" onClick={onCancel}><X className="h-5 w-5" />ยกเลิก</button>
        <span className="text-sm opacity-80">{title || 'ปรับกรอบเอกสาร'}</span>
        <span className="w-20" />
      </div>
      <div ref={wrap} className="relative flex flex-1 touch-none items-center justify-center overflow-hidden px-4"
        onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}>
        <div className="relative" style={{ width: box.w, height: box.h }}>
          <canvas ref={imgRef} className="block" />
          <svg className="pointer-events-none absolute inset-0" width={box.w} height={box.h}>
            <path d={`M0 0H${box.w}V${box.h}H0Z M${pts.map((p) => `${p.x} ${p.y}`).join(' L')}Z`} fill="rgba(0,0,0,.45)" fillRule="evenodd" />
            <polygon points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill="rgba(37,99,235,.12)" stroke="#3b82f6" strokeWidth={2} />
          </svg>
          {pts.map((p, i) => (
            <button key={i} aria-label={`มุม${labels[i]}`}
              onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); setDrag(i); }}
              className="absolute h-11 w-11 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full"
              style={{ left: p.x, top: p.y }}>
              <span className="absolute inset-2.5 rounded-full border-[3px] border-white bg-blue-500/80 shadow" />
            </button>
          ))}
        </div>
        <canvas ref={lens} width={120} height={120}
          className={`pointer-events-none absolute left-4 top-2 rounded-full border-2 border-white shadow-lg ${drag === null ? 'hidden' : ''}`} />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <Button variant="ghost" className="text-white hover:bg-white/10" onClick={autoDetect} disabled={detecting}>
          {detecting ? <Spinner className="h-4 w-4" /> : <ScanLine className="h-4 w-4" />}ตรวจจับอัตโนมัติ
        </Button>
        <Button variant="ghost" className="text-white hover:bg-white/10" onClick={() => setQuad(fullQuad(source.width, source.height))}>
          <Maximize className="h-4 w-4" />ใช้ภาพเต็ม
        </Button>
        <Button variant="primary" loading={busy} onClick={() => { setBusy(true); onConfirm(isFull ? null : quad); }}>
          <Check className="h-4 w-4" />ยืนยัน
        </Button>
        {footer}
      </div>
    </div>
  );
}
