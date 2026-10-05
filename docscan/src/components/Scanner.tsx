'use client';
import { Check, Image as ImageIcon, X, Zap, ZapOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { warmUp } from '@/lib/cv';
import { canvasToBlob, ctx2d, getImageData, makeCanvas, validateImageFile } from '@/lib/image';
import { detectQuad } from '@/lib/cv';
import { db } from '@/lib/db';
import type { Point, Quad } from '@/lib/types';
import CaptureFlow from './CaptureFlow';
import { Button, friendlyError, useBlobUrl, useUi } from './ui';

const LIVE_MAX = 480;          // ความละเอียดที่ใช้หาขอบแบบสด (เล็กพอให้ลื่น)
const STABLE_FRAMES = 3;       // ต้องนิ่งกี่เฟรมติดกันก่อนถ่ายอัตโนมัติ
const MIN_CONF = 0.2;          // เอกสารต้องกินพื้นที่อย่างน้อย 20% ของภาพ

/**
 * กล้องสแกนเต็มจอ — ใช้กล้องหลัง หาขอบเอกสารแบบสดแล้ววาดกรอบทับ
 * ถ้าเจอเอกสารชัดและกล้องนิ่ง 3 เฟรมติด = ถ่ายให้เอง (ปิดได้)
 * ถ่ายแล้วไปหน้าครอบ → บันทึกเป็นหน้า → กลับมาถ่ายหน้าต่อไปได้ทันที
 */
export default function Scanner({ getDocumentId, onDone, onClose }: {
  getDocumentId: () => Promise<string>;
  onDone: (documentId: string | null) => void;
  onClose: () => void;
}) {
  const ui = useUi();
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [error, setError] = useState('');
  const [auto, setAuto] = useState(true);
  const [torch, setTorch] = useState<boolean | null>(null);   // null = กล้องไม่รองรับไฟฉาย
  const [live, setLive] = useState<Quad | null>(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [queue, setQueue] = useState<Blob[] | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [lastThumb, setLastThumb] = useState<Blob | null>(null);
  const [flash, setFlash] = useState(false);
  const stableRef = useRef<{ quad: Quad | null; n: number }>({ quad: null, n: 0 });
  const busy = useRef(false);
  const thumbUrl = useBlobUrl(lastThumb);
  const fileRef = useRef<HTMLInputElement>(null);

  const stop = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };

  const start = useCallback(async () => {
    setError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('NotFoundError');
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }
      });
      stream.current = s;
      const v = video.current;
      if (v) { v.srcObject = s; await v.play().catch(() => undefined); }
      const track = s.getVideoTracks()[0];
      const caps = (track.getCapabilities?.() || {}) as MediaTrackCapabilities & { torch?: boolean };
      setTorch(caps.torch ? false : null);
    } catch (e) {
      setError(friendlyError(e instanceof Error ? e : new Error(String(e))));
    }
  }, []);

  useEffect(() => {
    warmUp();
    start();
    return stop;
  }, [start]);

  // ไฟฉาย (ถ้ากล้องรองรับ — ส่วนใหญ่เป็น Android Chrome; iPhone Safari ยังไม่เปิดให้เว็บใช้)
  const toggleTorch = async () => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch { setTorch(null); }
  };

  /** ถ่ายภาพความละเอียดเต็มจากเฟรมวิดีโอ */
  const capture = useCallback(async () => {
    const v = video.current;
    if (!v || !v.videoWidth || busy.current) return;
    busy.current = true;
    setFlash(true); setTimeout(() => setFlash(false), 150);
    const c = makeCanvas(v.videoWidth, v.videoHeight);
    ctx2d(c).drawImage(v, 0, 0);
    const blob = await canvasToBlob(c, 'image/jpeg', 0.92);
    stableRef.current = { quad: null, n: 0 };
    setQueue([blob]);
  }, []);

  // หาขอบเอกสารแบบสดทุก ~300ms
  useEffect(() => {
    if (queue || error) return;
    let alive = true;
    const small = makeCanvas(1, 1);
    const tick = async () => {
      const v = video.current;
      if (!alive) return;
      if (v && v.videoWidth && !busy.current) {
        const s = Math.min(1, LIVE_MAX / Math.max(v.videoWidth, v.videoHeight));
        small.width = Math.round(v.videoWidth * s); small.height = Math.round(v.videoHeight * s);
        ctx2d(small).drawImage(v, 0, 0, small.width, small.height);
        try {
          const r = await detectQuad(getImageData(small));
          if (!alive) return;
          const q = r.quad && r.confidence >= MIN_CONF ? r.quad.map((p) => ({ x: p.x / s, y: p.y / s })) as Quad : null;
          setLive(q);
          setFrame({ w: v.videoWidth, h: v.videoHeight });
          // นิ่งพอไหม: มุมขยับเฉลี่ยไม่เกิน 1.5% ของด้านกว้าง
          const prev = stableRef.current.quad;
          const moved = q && prev ? q.reduce((m, p, i) => m + Math.hypot(p.x - prev[i].x, p.y - prev[i].y), 0) / 4 : Infinity;
          stableRef.current = { quad: q, n: q && moved < v.videoWidth * 0.015 ? stableRef.current.n + 1 : 0 };
          if (auto && q && stableRef.current.n >= STABLE_FRAMES) { await capture(); return; }
        } catch { /* worker ยังโหลดไม่เสร็จ — รอบหน้าลองใหม่ */ }
      }
      if (alive) setTimeout(tick, 300);
    };
    const t = setTimeout(tick, 600);
    return () => { alive = false; clearTimeout(t); };
  }, [queue, error, auto, capture]);

  const ensureDoc = async () => {
    if (docId) return docId;
    const id = await getDocumentId();
    setDocId(id);
    return id;
  };

  const afterQueue = async (added: number, id: string | null) => {
    setQueue(null);
    busy.current = false;
    if (added && id) {
      // id มาจากคิวที่เพิ่งทำเสร็จ — ไม่ใช้ state docId ที่อาจยังไม่อัปเดตใน closure นี้
      setCount(await db.pages.where('documentId').equals(id).count());
      const last = await db.pages.where('documentId').equals(id).reverse().sortBy('order');
      setLastThumb(last[0]?.thumbnail || null);
    }
  };

  const pickFiles = (files: FileList | null) => {
    const list = Array.from(files || []);
    const ok: Blob[] = [];
    for (const f of list) {
      try { validateImageFile(f); ok.push(f); } catch (e) { ui.toast(friendlyError(e), 'error'); }
    }
    if (ok.length) setQueue(ok);
  };

  // ต้องมีเอกสารก่อนเปิดคิว (สร้างตอนถ่ายรูปแรก)
  const [queueDoc, setQueueDoc] = useState<string | null>(null);
  useEffect(() => {
    if (!queue) { setQueueDoc(null); return; }
    ensureDoc().then(setQueueDoc).catch((e) => { ui.toast(friendlyError(e), 'error'); setQueue(null); busy.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  if (queue && queueDoc) {
    return <CaptureFlow documentId={queueDoc} items={queue} onDone={(n) => afterQueue(n, queueDoc)} onCancel={() => afterQueue(0, queueDoc)} />;
  }

  // แปลงพิกัดเฟรมวิดีโอเป็นพิกัดบนจอ (วิดีโอแสดงแบบ object-contain)
  const vEl = video.current;
  const dispW = vEl?.clientWidth || 0, dispH = vEl?.clientHeight || 0;
  const sc = frame.w ? Math.min(dispW / frame.w, dispH / frame.h) : 0;
  const ox = (dispW - frame.w * sc) / 2, oy = (dispH - frame.h * sc) / 2;
  const toScreen = (p: Point) => `${ox + p.x * sc},${oy + p.y * sc}`;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black text-white">
      <div className="flex items-center justify-between px-2 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2">
        <button aria-label="ปิด" className="inline-flex h-11 w-11 items-center justify-center rounded-xl hover:bg-white/10" onClick={() => { stop(); onClose(); }}>
          <X className="h-6 w-6" />
        </button>
        <button onClick={() => setAuto((a) => !a)} className={`h-9 rounded-full px-4 text-sm ${auto ? 'bg-blue-600' : 'bg-white/15'}`}>
          ถ่ายอัตโนมัติ {auto ? 'เปิด' : 'ปิด'}
        </button>
        <button aria-label="ไฟฉาย" disabled={torch === null} onClick={toggleTorch}
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl hover:bg-white/10 disabled:opacity-30">
          {torch ? <Zap className="h-6 w-6 text-yellow-300" /> : <ZapOff className="h-6 w-6" />}
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <video ref={video} playsInline muted autoPlay className="h-full w-full object-contain" />
        {live && sc > 0 && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full">
            <polygon points={live.map(toScreen).join(' ')} fill="rgba(37,99,235,.18)" stroke="#60a5fa" strokeWidth={3} />
          </svg>
        )}
        {flash && <div className="absolute inset-0 bg-white/70" />}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="max-w-sm">{error}</p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={start}>ลองเปิดกล้องอีกครั้ง</Button>
              <Button onClick={() => fileRef.current?.click()}>เลือกรูปแทน</Button>
            </div>
          </div>
        )}
        {!error && (
          <p className="absolute inset-x-0 top-3 text-center text-sm drop-shadow">
            {live ? (auto ? 'เจอเอกสารแล้ว ถือนิ่ง ๆ…' : 'เจอเอกสารแล้ว กดถ่ายได้') : 'วางเอกสารให้อยู่ในกรอบ'}
          </p>
        )}
      </div>

      <div className="grid grid-cols-3 items-center px-6 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-3">
          <button aria-label="เลือกรูปจากเครื่อง" onClick={() => fileRef.current?.click()}
            className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-white/15">
            <ImageIcon className="h-6 w-6" />
          </button>
          {thumbUrl && (
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumbUrl} alt="" className="h-12 w-10 rounded object-cover ring-2 ring-white" />
              <span className="absolute -right-2 -top-2 rounded-full bg-blue-600 px-1.5 text-xs">{count}</span>
            </div>
          )}
        </div>
        <div className="flex justify-center">
          <button aria-label="ถ่ายภาพ" onClick={capture} disabled={!!error}
            className="h-[72px] w-[72px] rounded-full border-4 border-white bg-white/20 transition active:scale-95 disabled:opacity-40" />
        </div>
        <div className="flex justify-end">
          {count > 0 && (
            <Button variant="primary" onClick={() => { stop(); onDone(docId); }}><Check className="h-5 w-5" />เสร็จ ({count})</Button>
          )}
        </div>
      </div>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { pickFiles(e.target.files); e.target.value = ''; }} />
    </div>
  );
}
