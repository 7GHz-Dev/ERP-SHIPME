'use client';
import { Check, Image as ImageIcon, X, Zap, ZapOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { warmUp } from '@/lib/cv';
import { getSetting, setSetting } from '@/lib/db';
import { detectDoc, sigCorrelation, warmDetector, type DetectResult, type Signature } from '@/lib/detect';
import { ctx2d, makeCanvas, validateImageFile } from '@/lib/image';
import { buildPageFromCanvas, insetQuad, refineOnCanvas } from '@/lib/process';
import { addPage } from '@/lib/repo';
import type { Point, Quad } from '@/lib/types';
import CaptureFlow from './CaptureFlow';
import CropEditor from './CropEditor';
import { Button, Spinner, friendlyError, useBlobUrl, useUi } from './ui';

const LIVE_MAX = 400;       // ความละเอียดที่ใช้หาขอบแบบสด (ตัวหาขอบใช้ ~5ms/เฟรม — จับได้หลายสิบครั้งต่อวินาที)
const STABLE_MS = 450;      // กรอบต้องนิ่งนานเท่านี้ก่อนถ่ายอัตโนมัติ
const STABLE_TOL = 0.015;   // มุมขยับไม่เกิน 1.5% ของเส้นทแยงมุม = นับว่านิ่ง
const MIN_GAP_MS = 900;     // เว้นระยะระหว่างการถ่ายอัตโนมัติ 2 ครั้ง
const LOST_MS = 350;        // เอกสารหายจากจอนานเท่านี้ = เปลี่ยนหน้าแล้ว
const CHANGED = 0.8;        // เนื้อหาเหมือนหน้าที่เพิ่งถ่ายต่ำกว่านี้ = พลิก/วางหน้าใหม่แล้ว
const SAME_PAGE = 0.93;     // เหมือนหน้าที่เพิ่งถ่ายตั้งแต่นี้ = หน้าเดิม ไม่ถ่ายซ้ำอัตโนมัติ
const TIP_MS = 5000;        // หาไม่เจอนานเท่านี้ ขึ้นคำแนะนำ
const FRAME_MS = 60;        // หาขอบไม่ถี่กว่า ~16 ครั้ง/วินาที (พอสำหรับจับนิ่ง 0.45 วินาที และไม่กินแบตเกินจำเป็น)

type Status = 'starting' | 'search' | 'tip' | 'hold' | 'wait' | 'same';
interface Job { canvas: HTMLCanvasElement; quad: Quad | null; errPx: number; exact: boolean }

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const meanDist = (a: Point[], b: Point[]) => a.reduce((s, p, i) => s + dist(p, b[i]), 0) / a.length;
const maxDist = (a: Point[], b: Point[]) => Math.max(...a.map((p, i) => dist(p, b[i])));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

/**
 * กล้องสแกนเต็มจอ — หาขอบเอกสารแบบสดหลายสิบครั้งต่อวินาที แล้ววาดกรอบทับ
 * - ถ่ายอัตโนมัติ: เจอเอกสาร + กล้องนิ่ง ~0.5 วินาที = ถ่ายเลย
 * - ไม่ต้องยืนยันกรอบ (ค่าเริ่มต้น): ครอบตามกรอบที่จับได้ บันทึกเบื้องหลัง แล้วรอหน้าถัดไปทันที
 *   (จับได้เองว่าเปลี่ยนหน้าแล้วจากเนื้อหาที่เปลี่ยน/เอกสารหายจากจอ — ไม่ถ่ายหน้าเดิมซ้ำ)
 * - ยืนยันกรอบ: ถ่ายแล้วขึ้นหน้าปรับกรอบก่อนทุกครั้ง
 */
export default function Scanner({ getDocumentId, onDone, onClose }: {
  getDocumentId: () => Promise<string>;
  onDone: (documentId: string | null) => void;
  onClose: () => void;
}) {
  const ui = useUi();
  const video = useRef<HTMLVideoElement>(null);
  const poly = useRef<SVGPolygonElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [auto, setAuto] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [torch, setTorch] = useState<boolean | null>(null);   // null = กล้องไม่รองรับไฟฉาย
  const [status, setStatus] = useState<Status>('starting');
  const [count, setCount] = useState(0);          // หน้าที่บันทึกแล้วในรอบนี้
  const [captured, setCaptured] = useState(0);    // หน้าที่ถ่ายแล้ว (รวมที่ยังบันทึกไม่เสร็จ)
  const [pending, setPending] = useState(0);
  const [lastThumb, setLastThumb] = useState<Blob | null>(null);
  const [flash, setFlash] = useState(false);
  const [edit, setEdit] = useState<{ canvas: HTMLCanvasElement; quad: Quad | null } | null>(null);
  const [imports, setImports] = useState<Blob[] | null>(null);
  const [finishing, setFinishing] = useState(false);
  const thumbUrl = useBlobUrl(lastThumb);

  // ค่าที่ลูปหาขอบใช้ — เก็บใน ref จะได้ไม่ต้องเริ่มลูปใหม่ทุกครั้งที่ค่าเปลี่ยน
  const autoRef = useRef(true), confirmRef = useRef(false), busy = useRef(false);
  const live = useRef<{ quad: Quad | null; scale: number; sig: Signature | null }>({ quad: null, scale: 1, sig: null });
  const phase = useRef<'search' | 'wait'>('search');
  const stab = useRef<{ anchor: Quad | null; since: number; lostSince: number; seenAt: number }>({ anchor: null, since: 0, lostSince: 0, seenAt: 0 });
  const lastCap = useRef<{ quad: Quad | null; sig: Signature | null; at: number }>({ quad: null, sig: null, at: 0 });
  const disp = useRef<Point[] | null>(null);
  const jobs = useRef<Job[]>([]);
  const running = useRef(false);
  const docPromise = useRef<Promise<string> | null>(null);
  const docIdRef = useRef<string | null>(null);
  const statusRef = useRef<Status>('starting');
  const getDocRef = useRef(getDocumentId);
  getDocRef.current = getDocumentId;

  const say = (s: Status) => { if (statusRef.current !== s) { statusRef.current = s; setStatus(s); } };

  useEffect(() => {
    getSetting<boolean>('scanAuto', true).then((v) => { autoRef.current = v; setAuto(v); });
    getSetting<boolean>('scanConfirm', false).then((v) => { confirmRef.current = v; setConfirm(v); });
  }, []);
  const toggleAuto = () => { const v = !auto; autoRef.current = v; setAuto(v); setSetting('scanAuto', v); };
  const toggleConfirm = () => { const v = !confirm; confirmRef.current = v; setConfirm(v); setSetting('scanConfirm', v); };

  const stop = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  /** ผูกกล้องเข้ากับ <video> ทุกครั้งที่ element ถูกสร้าง (กันจอดำถ้า React สร้าง element ใหม่) */
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    video.current = el;
    if (el && stream.current && el.srcObject !== stream.current) {
      el.srcObject = stream.current;
      el.play().catch(() => undefined);
    }
  }, []);

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
      const caps = (track.getCapabilities?.() || {}) as MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] };
      setTorch(caps.torch ? false : null);
      // โฟกัสต่อเนื่อง (ถ้ากล้องรองรับ) — ภาพคมตั้งแต่เฟรมแรกที่ถ่ายอัตโนมัติ
      if (caps.focusMode?.includes('continuous')) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => undefined);
      }
    } catch (e) {
      setError(friendlyError(e instanceof Error ? e : new Error(String(e))));
    }
  }, []);

  useEffect(() => {
    warmDetector();
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

  const ensureDoc = useCallback(() => {
    if (!docPromise.current) {
      docPromise.current = getDocRef.current().then((id) => { docIdRef.current = id; return id; });
      docPromise.current.catch(() => { docPromise.current = null; });
    }
    return docPromise.current;
  }, []);

  /** คิวบันทึกเบื้องหลัง: เกลามุม → ครอบ → ฟิลเตอร์เอกสาร → บันทึก (กล้องยังจับหน้าถัดไปได้ระหว่างนี้) */
  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    while (jobs.current.length) {
      setPending(jobs.current.length);
      const job = jobs.current[0];
      try {
        const id = await ensureDoc();
        let q = job.quad;
        if (q && !job.exact) q = insetQuad(await refineOnCanvas(job.canvas, q, job.errPx));
        const page = await buildPageFromCanvas(job.canvas, q);
        await addPage(id, page);
        setCount((n) => n + 1);
        setLastThumb(page.thumbnail);
      } catch (e) {
        ui.toast(`บันทึกหน้าไม่สำเร็จ: ${friendlyError(e)}`, 'error');
      }
      jobs.current.shift();
    }
    running.current = false;
    setPending(0);
  }, [ensureDoc, ui]);

  const enqueue = useCallback((job: Job) => {
    jobs.current.push(job);
    setPending(jobs.current.length);
    pump();
  }, [pump]);

  /** ถ่ายภาพความละเอียดเต็มจากเฟรมวิดีโอ — qSmall = กรอบในพิกัดภาพสด (null = ใช้ภาพเต็ม) */
  const capture = useCallback(async (qSmall: Quad | null, scale: number, sig: Signature | null) => {
    const v = video.current;
    if (!v || !v.videoWidth || busy.current) return;
    busy.current = true;
    try {
      const c = makeCanvas(v.videoWidth, v.videoHeight);
      ctx2d(c).drawImage(v, 0, 0);
      setFlash(true); setTimeout(() => setFlash(false), 140);
      navigator.vibrate?.(20);
      const quad = qSmall ? qSmall.map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad : null;
      lastCap.current = { quad: qSmall, sig, at: performance.now() };
      // ถ่ายอัตโนมัติ: รอเปลี่ยนหน้าก่อนถ่ายหน้าถัดไป • ถ่ายเอง: ไม่ต้องรอ
      phase.current = autoRef.current ? 'wait' : 'search';
      stab.current = { anchor: null, since: 0, lostSince: 0, seenAt: performance.now() };
      setCaptured((n) => n + 1);
      if (confirmRef.current) {
        // เกลามุมก่อน หน้าปรับกรอบจะขึ้นกรอบที่แม่นแล้ว
        const rq = quad ? insetQuad(await refineOnCanvas(c, quad, 2.5 / scale)) : null;
        setEdit({ canvas: c, quad: rq });
      } else {
        enqueue({ canvas: c, quad, errPx: 2.5 / scale, exact: false });
        if (!quad) ui.toast('ไม่เจอขอบเอกสาร — บันทึกเป็นภาพเต็ม (กด "ครอบ" แก้ทีหลังได้)');
      }
    } finally {
      busy.current = false;
    }
  }, [enqueue, ui]);

  /** วาดกรอบทับวิดีโอ (ตั้งค่า SVG ตรง ๆ ไม่ผ่าน React — ลื่นกว่าเมื่ออัปเดตหลายสิบครั้งต่อวินาที) */
  const drawOverlay = (q: Quad | null, scale: number, held: number) => {
    const el = poly.current, v = video.current;
    if (!el || !v) return;
    if (!q || !v.videoWidth) { el.style.opacity = '0'; disp.current = null; return; }
    const dw = v.clientWidth, dh = v.clientHeight, vw = v.videoWidth, vh = v.videoHeight;
    const sc = Math.min(dw / vw, dh / vh), ox = (dw - vw * sc) / 2, oy = (dh - vh * sc) / 2;
    const pts = q.map((p) => ({ x: ox + (p.x / scale) * sc, y: oy + (p.y / scale) * sc }));
    const prev = disp.current;
    const sm = prev && meanDist(pts, prev) < 40 ? pts.map((p, i) => ({ x: prev[i].x * 0.35 + p.x * 0.65, y: prev[i].y * 0.35 + p.y * 0.65 })) : pts;
    disp.current = sm;
    el.setAttribute('points', sm.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
    const k = Math.min(1, held / STABLE_MS);
    el.style.opacity = '1';
    el.style.fill = phase.current === 'wait' ? 'rgba(34,197,94,.16)' : `rgba(37,99,235,${0.1 + 0.25 * k})`;
    el.style.stroke = phase.current === 'wait' ? '#4ade80' : '#60a5fa';
  };

  const onResult = useCallback((r: DetectResult, scale: number, w: number, h: number) => {
    const now = performance.now();
    const q = r.quad && r.area >= 0.1 ? r.quad : null;
    live.current = { quad: q, scale, sig: r.sig || null };
    const diag = Math.hypot(w, h), st = stab.current;
    if (q) st.seenAt = now;

    if (phase.current === 'wait') {
      // เพิ่งถ่าย: รอจนเปลี่ยนหน้า (เอกสารหายจากจอ หรือเนื้อหาในกรอบเปลี่ยน)
      const last = lastCap.current;
      if (!q) {
        if (!st.lostSince) st.lostSince = now;
        if (now - st.lostSince >= LOST_MS) phase.current = 'search';
      } else {
        st.lostSince = 0;
        const corr = sigCorrelation(r.sig, last.sig);
        const moved = last.quad ? meanDist(q, last.quad) / diag : 1;
        if (corr < CHANGED || (moved > 0.12 && corr < 0.9)) phase.current = 'search';
      }
      if (phase.current === 'search') st.anchor = null;
      drawOverlay(q, scale, 0);
      if (phase.current === 'wait') { say(statusRef.current === 'same' ? 'same' : 'wait'); return; }
    }

    if (!q) {
      st.anchor = null;
      drawOverlay(null, scale, 0);
      say(now - st.seenAt > TIP_MS ? 'tip' : 'search');
      return;
    }
    if (!st.anchor || maxDist(q, st.anchor) > STABLE_TOL * diag) { st.anchor = q; st.since = now; }
    const held = now - st.since;
    drawOverlay(q, scale, autoRef.current ? held : 0);
    say('hold');
    if (!autoRef.current || busy.current || held < STABLE_MS || now - lastCap.current.at < MIN_GAP_MS) return;
    // กันถ่ายหน้าเดิมซ้ำ (เช่นเงามือผ่านแล้วกลับมาที่หน้าเดิม)
    if (lastCap.current.sig && sigCorrelation(r.sig, lastCap.current.sig) >= SAME_PAGE) {
      phase.current = 'wait';
      say('same');
      return;
    }
    capture(q, scale, r.sig || null);
  }, [capture]);

  // ลูปหาขอบแบบสด: ส่งเฟรมถัดไปทันทีที่ผลของเฟรมก่อนกลับมา (ไม่ตั้งเวลาตายตัว)
  const paused = !!error || !!edit || !!imports || finishing;
  useEffect(() => {
    if (paused) return;
    let alive = true;
    stab.current.seenAt = performance.now();   // นับเวลาขึ้นคำแนะนำจากตอนเริ่มหาขอบ
    const small = makeCanvas(1, 1);
    const sctx = small.getContext('2d', { willReadFrequently: true });
    (async () => {
      while (alive && sctx) {
        const t0 = performance.now();
        const v = video.current;
        if (!v || !v.videoWidth || v.readyState < 2) { await sleep(80); continue; }
        const s = Math.min(1, LIVE_MAX / Math.max(v.videoWidth, v.videoHeight));
        const w = Math.round(v.videoWidth * s), h = Math.round(v.videoHeight * s);
        if (small.width !== w || small.height !== h) { small.width = w; small.height = h; }
        sctx.imageSmoothingQuality = 'medium';
        sctx.drawImage(v, 0, 0, w, h);
        let r: DetectResult;
        try {
          r = await detectDoc(sctx.getImageData(0, 0, w, h), 'live', live.current.quad && live.current.scale === s ? live.current.quad : null);
        } catch {
          await sleep(300);
          continue;
        }
        if (!alive) break;
        onResult(r, s, w, h);
        await nextFrame();
        const spent = performance.now() - t0;
        if (spent < FRAME_MS) await sleep(FRAME_MS - spent);
      }
    })();
    return () => { alive = false; };
  }, [paused, onResult]);

  // กด "เสร็จ": รอคิวบันทึกให้หมดก่อน แล้วเปิดเอกสาร
  useEffect(() => {
    if (finishing && pending === 0 && !running.current) { stop(); onDone(docIdRef.current); }
  }, [finishing, pending, onDone]);

  const finish = () => setFinishing(true);
  const close = () => { if (captured > 0) finish(); else { stop(); onClose(); } };

  const pickFiles = (files: FileList | null) => {
    const ok: Blob[] = [];
    for (const f of Array.from(files || [])) {
      try { validateImageFile(f); ok.push(f); } catch (e) { ui.toast(friendlyError(e), 'error'); }
    }
    if (ok.length) setImports(ok);
  };

  // ต้องมีเอกสารก่อนเปิดคิวนำเข้ารูป
  const [importDoc, setImportDoc] = useState<string | null>(null);
  useEffect(() => {
    if (!imports) { setImportDoc(null); return; }
    ensureDoc().then(setImportDoc).catch((e) => { ui.toast(friendlyError(e), 'error'); setImports(null); });
  }, [imports, ensureDoc, ui]);

  // หน้าปรับกรอบ/คิวนำเข้า ซ้อนทับกล้อง (ไม่ถอดวิดีโอออก — ถอดแล้วต้องผูกกล้องใหม่ จอดำ)
  const overlay = imports && importDoc ? (
      <CaptureFlow documentId={importDoc} items={imports} confirm={confirm}
        onDone={(n) => { setImports(null); if (n) { setCount((c) => c + n); setCaptured((c) => c + n); } }}
        onCancel={() => setImports(null)} />
  ) : edit ? (
      <CropEditor source={edit.canvas} initial={edit.quad} title={`ปรับกรอบหน้า ${captured}`}
        onCancel={() => {
          // ไม่เอาภาพนี้ = ถ่ายใหม่ได้ทันที (ไม่ติดกันถ่ายซ้ำ)
          setEdit(null); setCaptured((n) => Math.max(0, n - 1));
          lastCap.current = { quad: null, sig: null, at: 0 }; phase.current = 'search';
        }}
        onConfirm={(q) => { enqueue({ canvas: edit.canvas, quad: q, errPx: 0, exact: true }); setEdit(null); }} />
  ) : null;


  const text: Record<Status, string> = {
    starting: 'กำลังเปิดกล้อง…',
    search: 'วางเอกสารให้เห็นครบทั้ง 4 มุม',
    tip: 'ยังหาขอบไม่เจอ — ให้เห็นขอบกระดาษชัดทั้ง 4 ด้าน หรือวางบนพื้นที่สีต่างจากกระดาษ',
    hold: auto ? 'เจอเอกสารแล้ว ถือนิ่ง ๆ…' : 'เจอเอกสารแล้ว กดถ่ายได้เลย',
    wait: auto ? `ถ่ายหน้า ${captured} แล้ว — วางหน้าถัดไปได้เลย` : `ถ่ายหน้า ${captured} แล้ว`,
    same: 'หน้านี้ถ่ายไปแล้ว — เปลี่ยนหน้า หรือกดถ่ายเองถ้าต้องการซ้ำ'
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black text-white">
      <div className="flex items-center gap-2 px-2 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2">
        <button aria-label="ปิด" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl hover:bg-white/10" onClick={close}>
          <X className="h-6 w-6" />
        </button>
        <div className="flex flex-1 justify-center gap-2">
          <button onClick={toggleAuto} className={`h-9 rounded-full px-3 text-sm ${auto ? 'bg-blue-600' : 'bg-white/15'}`}>
            ถ่ายอัตโนมัติ {auto ? 'เปิด' : 'ปิด'}
          </button>
          <button onClick={toggleConfirm} className={`h-9 rounded-full px-3 text-sm ${confirm ? 'bg-blue-600' : 'bg-white/15'}`}>
            ยืนยันกรอบ {confirm ? 'เปิด' : 'ปิด'}
          </button>
        </div>
        <button aria-label="ไฟฉาย" disabled={torch === null} onClick={toggleTorch}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl hover:bg-white/10 disabled:opacity-30">
          {torch ? <Zap className="h-6 w-6 text-yellow-300" /> : <ZapOff className="h-6 w-6" />}
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <video ref={attachVideo} playsInline muted autoPlay className="h-full w-full object-contain" />
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <polygon ref={poly} points="" strokeWidth={3} strokeLinejoin="round" style={{ opacity: 0, transition: 'fill .15s' }} />
        </svg>
        {flash && <div className="absolute inset-0 bg-white/70" />}
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="max-w-sm">{error}</p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={start}>ลองเปิดกล้องอีกครั้ง</Button>
              <Button onClick={() => fileRef.current?.click()}>เลือกรูปแทน</Button>
            </div>
          </div>
        ) : (
          <p className="absolute inset-x-4 top-3 text-center text-sm drop-shadow-[0_1px_2px_rgba(0,0,0,.9)]">{text[status]}</p>
        )}
        {finishing && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70">
            <Spinner className="h-8 w-8" /><p>กำลังบันทึก {pending} หน้าที่เหลือ…</p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 items-center px-6 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-3">
          <button aria-label="เลือกรูปจากเครื่อง" onClick={() => fileRef.current?.click()}
            className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-white/15">
            <ImageIcon className="h-6 w-6" />
          </button>
          {(thumbUrl || pending > 0) && (
            <div className="relative">
              {thumbUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={thumbUrl} alt="" className="h-12 w-10 rounded object-cover ring-2 ring-white" />
                : <div className="h-12 w-10 rounded bg-white/10 ring-2 ring-white" />}
              {pending > 0 && <Spinner className="absolute inset-0 m-auto h-5 w-5" />}
              <span className="absolute -right-2 -top-2 rounded-full bg-blue-600 px-1.5 text-xs">{captured}</span>
            </div>
          )}
        </div>
        <div className="flex justify-center">
          <button aria-label="ถ่ายภาพ" disabled={!!error}
            onClick={() => capture(live.current.quad, live.current.scale, live.current.sig)}
            className="h-[72px] w-[72px] rounded-full border-4 border-white bg-white/20 transition active:scale-95 disabled:opacity-40" />
        </div>
        <div className="flex justify-end">
          {captured > 0 && (
            <Button variant="primary" onClick={finish}><Check className="h-5 w-5" />เสร็จ ({captured})</Button>
          )}
        </div>
      </div>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { pickFiles(e.target.files); e.target.value = ''; }} />
      {overlay && <div className="fixed inset-0 z-50">{overlay}</div>}
    </div>
  );
}
