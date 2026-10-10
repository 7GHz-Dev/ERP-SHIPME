'use client';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft, Camera, ChevronLeft, ChevronRight, Copy, Crop, FileUp, ImagePlus, MoreHorizontal, PenTool, RotateCw,
  ScanText, Send, Share2, SlidersHorizontal, Trash2, Pencil, CheckCircle2
} from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as RPE } from 'react';
import { hasBlob, hydrate, pageBlob, pinDoc } from '@/lib/cloud';
import { db } from '@/lib/db';
import { clearTicket, sendToErp, thaiDate, type ErpTicket } from '@/lib/erp';
import { MAX_ORIGINAL, blobToCanvas, canvasToBlob } from '@/lib/image';
import { DEFAULT_PDF, exportPdf } from '@/lib/pdf';
import { cropToCanvas } from '@/lib/process';
import { deletePage, duplicatePage, getPages, renameDocument, reorderPages, trashDocument, updatePage } from '@/lib/repo';
import type { PageRecord, Quad } from '@/lib/types';
import CropEditor from './CropEditor';
import ExportSheet from './ExportSheet';
import ImageEditor from './ImageEditor';
import Markup from './Markup';
import OcrPanel from './OcrPanel';
import SendSheet from './SendSheet';
import { Button, IconButton, Sheet, Spinner, friendlyError, useBlobUrl, useUi } from './ui';

export default function DocumentView({ docId, ticket, onBack, onScanMore, onImport, onTicketUsed }: {
  docId: string;
  ticket: ErpTicket | null;
  onBack: () => void;
  onScanMore: () => void;
  onImport: (kind: 'image' | 'pdf') => void;
  onTicketUsed: () => void;
}) {
  const ui = useUi();
  const doc = useLiveQuery(() => db.documents.get(docId), [docId]);
  const pages = useLiveQuery(() => getPages(docId), [docId]) as PageRecord[] | undefined;
  const [cur, setCur] = useState(0);
  const [panel, setPanel] = useState<'' | 'edit' | 'markup' | 'ocr' | 'export' | 'more' | 'add' | 'send'>('');
  const [crop, setCrop] = useState<{ canvas: HTMLCanvasElement; quad: Quad | null } | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState('');
  const [load, setLoad] = useState({ state: 'loading' as 'loading' | 'done' | 'error', done: 0, total: 0, error: '' });
  const [retry, setRetry] = useState(0);

  // เอกสารที่ให้ระบบเก็บ: เปิดอยู่ = ไม่ถูกลบรูปออกจากเครื่อง • ดึงภาพสุดท้าย + ภาพย่อกลับมาก่อน
  // (ภาพต้นฉบับ/ภาพครอบดึงตอนกดครอบ/ฟิลเตอร์/เขียน) — เอกสารในเครื่องไม่มีอะไรต้องดึง จบทันที
  useEffect(() => pinDoc(docId), [docId]);
  useEffect(() => {
    let alive = true;
    setLoad({ state: 'loading', done: 0, total: 0, error: '' });
    hydrate(docId, ['p', 't'], { onProgress: (done, total) => { if (alive) setLoad({ state: 'loading', done, total, error: '' }); } })
      .then(() => { if (alive) setLoad((l) => ({ ...l, state: 'done' })); })
      .catch((e) => { if (alive) setLoad((l) => ({ ...l, state: 'error', error: friendlyError(e) })); });
    return () => { alive = false; };
  }, [docId, retry]);

  useEffect(() => { if (pages && cur >= pages.length) setCur(Math.max(0, pages.length - 1)); }, [pages, cur]);
  if (doc === undefined || !pages) return <div className="flex min-h-dvh items-center justify-center"><Spinner className="h-6 w-6 text-primary" /></div>;
  if (!doc) return <div className="p-6 text-center">ไม่พบเอกสาร <Button onClick={onBack}>กลับ</Button></div>;
  const page = pages[cur];
  /** ภาพสุดท้ายครบทุกหน้า — ส่งออก / OCR / ส่งเข้าใบปิดบัญชีได้ */
  const ready = pages.every((p) => hasBlob(p.processedImage));

  const rename = async () => { const n = await ui.prompt('เปลี่ยนชื่อเอกสาร', doc.name); if (n?.trim()) await renameDocument(doc.id, n); };

  /** งานที่ต้องใช้ภาพต้นฉบับ/ภาพครอบ — ถ้าอยู่บนระบบ ขึ้นหน้ารอระหว่างดึง */
  const withImage = async (local: boolean, fn: () => Promise<unknown>) => {
    if (!local) setBusy('กำลังโหลดภาพจากระบบ…');
    try { await fn(); } catch (e) { ui.toast(friendlyError(e), 'error'); } finally { setBusy(''); }
  };
  const openCrop = async () => {
    if (!page) return;
    await withImage(hasBlob(page.originalImage), async () => {
      setCrop({ canvas: await blobToCanvas(await pageBlob(page, 'o'), MAX_ORIGINAL), quad: page.cropCoordinates });
    });
  };
  const confirmCrop = async (quad: Quad | null) => {
    if (!crop || !page) return;
    try {
      const c = await cropToCanvas(crop.canvas, quad);
      await updatePage(page.id, { croppedImage: await canvasToBlob(c, 'image/jpeg', 0.92), cropCoordinates: quad }, true);
    } catch (e) { ui.toast(friendlyError(e), 'error'); }
    setCrop(null);
  };

  /** ส่ง PDF เข้าใบปิดบัญชีใน ERP — ไฟล์ออกจากเครื่องตอนนี้เท่านั้น */
  const send = async () => {
    if (!ticket || !pages.length) return;
    setSending(true);
    try {
      const pdf = await exportPdf(pages, { ...DEFAULT_PDF, quality: 'medium', compression: 'balanced', dpi: 150 }, doc.name);
      await sendToErp(ticket, pdf, { name: `${doc.name}.pdf`, pages: pages.length });
      setSent(true);
      ui.toast('ส่งเข้าใบปิดบัญชีแล้ว');
    } catch (e) { ui.toast(friendlyError(e), 'error'); }
    finally { setSending(false); }
  };

  if (crop) return <CropEditor source={crop.canvas} initial={crop.quad} onConfirm={confirmCrop} onCancel={() => setCrop(null)} />;
  if (panel === 'edit' && page) return <ImageEditor page={page} onClose={() => setPanel('')} />;
  if (panel === 'markup' && page) return <Markup page={page} onClose={() => setPanel('')} />;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-1 border-b border-line bg-surface px-1 pt-[env(safe-area-inset-top)]">
        <IconButton label="กลับ" onClick={onBack}><ArrowLeft className="h-5 w-5" /></IconButton>
        <button onClick={rename} className="min-w-0 flex-1 truncate px-1 text-left font-semibold">{doc.name}</button>
        <IconButton label="แชร์" onClick={() => setPanel('export')} disabled={!pages.length || !ready}><Share2 className="h-5 w-5" /></IconButton>
        <IconButton label="เพิ่มเติม" onClick={() => setPanel('more')}><MoreHorizontal className="h-5 w-5" /></IconButton>
      </header>

      {ticket && (
        <div className="flex items-center gap-2 border-b border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
          <span className="flex-1">หลักฐานการตรวจปล่อย • {ticket.name} • {thaiDate(ticket.inspectDate)}</span>
          {sent ? (
            <Button variant="primary" onClick={() => {
              clearTicket(); onTicketUsed();
              // หน้าปิดบัญชีเปิด DocScan เป็นแท็บใหม่ — ปิดแท็บนี้แล้วกลับไปแท็บเดิม (ฟอร์มที่กรอกค้างไว้ยังอยู่)
              // ปิดไม่ได้ (เปิดลิงก์เอง) ค่อยพาไปหน้าปิดบัญชีแทน
              const back = ticket.returnUrl;
              window.close();
              setTimeout(() => { if (back) location.href = back; }, 300);
            }}>
              <CheckCircle2 className="h-4 w-4" />กลับไปหน้าปิดบัญชี
            </Button>
          ) : (
            <Button variant="primary" loading={sending} disabled={!pages.length || !ready} onClick={send}><Send className="h-4 w-4" />ส่งเข้าใบปิดบัญชี</Button>
          )}
        </div>
      )}
      {!ticket && pages.length > 0 && (
        // ไม่ได้เปิดมาจากหน้าปิดบัญชี: ส่งเองได้ด้วยรหัส ERP แล้วเลือกใบเบิก
        <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2 text-sm">
          <span className="flex-1 text-muted">แนบไฟล์นี้เป็นหลักฐานการตรวจปล่อยในใบปิดบัญชี</span>
          <Button variant="primary" disabled={!ready} onClick={() => setPanel('send')}><Send className="h-4 w-4" />ส่งไปปิดบัญชี</Button>
        </div>
      )}
      {!ready && (
        <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-2 text-sm">
          {load.state === 'loading' ? (
            <><Spinner className="h-4 w-4 text-primary" /><span className="flex-1 text-muted">กำลังโหลดเอกสารจากระบบ{load.total ? ` ${load.done}/${load.total}` : '…'}</span></>
          ) : (
            <>
              <span className="flex-1 text-red-600">{load.error || 'บางหน้ายังไม่มีภาพในเครื่อง'}</span>
              <Button onClick={() => setRetry((n) => n + 1)}>ลองใหม่</Button>
            </>
          )}
        </div>
      )}
      {busy && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/60 text-white">
          <Spinner className="h-8 w-8" /><p>{busy}</p>
        </div>
      )}

      <main className="relative min-h-0 flex-1 bg-surface-2">
        {page ? <Viewer key={page.id} page={page} /> : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted">
            <p>ยังไม่มีหน้า</p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={onScanMore}><Camera className="h-4 w-4" />สแกน</Button>
              <Button onClick={() => onImport('image')}><ImagePlus className="h-4 w-4" />นำเข้ารูป</Button>
            </div>
          </div>
        )}
        {pages.length > 1 && (
          <>
            <IconButton label="หน้าก่อน" disabled={cur === 0} onClick={() => setCur(cur - 1)} className="absolute left-1 top-1/2 -translate-y-1/2 bg-surface/80 shadow"><ChevronLeft className="h-5 w-5" /></IconButton>
            <IconButton label="หน้าถัดไป" disabled={cur === pages.length - 1} onClick={() => setCur(cur + 1)} className="absolute right-1 top-1/2 -translate-y-1/2 bg-surface/80 shadow"><ChevronRight className="h-5 w-5" /></IconButton>
          </>
        )}
      </main>

      <PageStrip pages={pages} current={cur} onSelect={setCur}
        onReorder={async (ids, newIndex) => { await reorderPages(doc.id, ids); setCur(newIndex); }} />

      <nav className="grid grid-cols-6 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
        {[
          { icon: <ImagePlus className="h-5 w-5" />, label: 'เพิ่มหน้า', on: () => setPanel('add') },
          { icon: <Crop className="h-5 w-5" />, label: 'ครอบ', on: openCrop, dis: !page },
          { icon: <SlidersHorizontal className="h-5 w-5" />, label: 'ฟิลเตอร์', on: () => setPanel('edit'), dis: !page },
          { icon: <PenTool className="h-5 w-5" />, label: 'เขียน', on: () => setPanel('markup'), dis: !page },
          { icon: <ScanText className="h-5 w-5" />, label: 'OCR', on: () => setPanel('ocr'), dis: !page || !ready },
          { icon: <MoreHorizontal className="h-5 w-5" />, label: 'เพิ่มเติม', on: () => setPanel('more') }
        ].map((b) => (
          <button key={b.label} onClick={b.on} disabled={b.dis} className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] text-muted disabled:opacity-40">
            {b.icon}{b.label}
          </button>
        ))}
      </nav>

      <Sheet open={panel === 'add'} onClose={() => setPanel('')} title="เพิ่มหน้า">
        <div className="grid gap-2">
          <Button variant="primary" onClick={() => { setPanel(''); onScanMore(); }}><Camera className="h-4 w-4" />สแกนด้วยกล้อง</Button>
          <Button onClick={() => { setPanel(''); onImport('image'); }}><ImagePlus className="h-4 w-4" />นำเข้ารูป</Button>
          <Button onClick={() => { setPanel(''); onImport('pdf'); }}><FileUp className="h-4 w-4" />นำเข้า PDF</Button>
        </div>
      </Sheet>

      <Sheet open={panel === 'more'} onClose={() => setPanel('')} title={page ? `หน้า ${cur + 1} จาก ${pages.length}` : 'เอกสาร'}>
        <div className="grid gap-2">
          {page && (
            <>
              <Button onClick={async () => { setPanel(''); await withImage(hasBlob(page.croppedImage), () => updatePage(page.id, { rotation: (page.rotation + 90) % 360 }, true)); }}><RotateCw className="h-4 w-4" />หมุนหน้านี้ 90°</Button>
              <Button onClick={async () => { setPanel(''); await duplicatePage(page.id); setCur(cur + 1); }}><Copy className="h-4 w-4" />ทำสำเนาหน้านี้</Button>
              <div className="grid grid-cols-2 gap-2">
                <Button disabled={cur === 0} onClick={async () => { const ids = pages.map((p) => p.id); [ids[cur - 1], ids[cur]] = [ids[cur], ids[cur - 1]]; await reorderPages(doc.id, ids); setCur(cur - 1); }}><ChevronLeft className="h-4 w-4" />ย้ายไปก่อน</Button>
                <Button disabled={cur === pages.length - 1} onClick={async () => { const ids = pages.map((p) => p.id); [ids[cur + 1], ids[cur]] = [ids[cur], ids[cur + 1]]; await reorderPages(doc.id, ids); setCur(cur + 1); }}>ย้ายไปหลัง<ChevronRight className="h-4 w-4" /></Button>
              </div>
              <Button variant="danger" onClick={async () => { if (await ui.confirm(`ลบหน้า ${cur + 1}?`, undefined, { ok: 'ลบ', danger: true })) { setPanel(''); await deletePage(page.id); } }}><Trash2 className="h-4 w-4" />ลบหน้านี้</Button>
            </>
          )}
          <hr className="my-1 border-line" />
          <Button onClick={() => { setPanel(''); rename(); }}><Pencil className="h-4 w-4" />เปลี่ยนชื่อเอกสาร</Button>
          <Button onClick={() => setPanel('export')} disabled={!pages.length || !ready}><Share2 className="h-4 w-4" />ส่งออก PDF / JPG</Button>
          <Button variant="danger" onClick={async () => { if (await ui.confirm('ย้ายเอกสารลงถังขยะ?', 'กู้คืนได้ภายใน 30 วัน', { ok: 'ย้ายลงถังขยะ', danger: true })) { await trashDocument(doc.id); onBack(); } }}><Trash2 className="h-4 w-4" />ลบเอกสาร</Button>
        </div>
      </Sheet>

      {pages.length > 0 && <OcrPanel doc={doc} pages={pages} current={cur} open={panel === 'ocr'} onClose={() => setPanel('')} />}
      {pages.length > 0 && <SendSheet doc={doc} pages={pages} open={panel === 'send'} onClose={() => setPanel('')} />}
      {pages.length > 0 && <ExportSheet doc={doc} pages={pages} current={cur} open={panel === 'export'} onClose={() => setPanel('')} />}
    </div>
  );
}

/** แสดงหน้าเอกสาร + ซูมด้วยสองนิ้ว / เลื่อนด้วยนิ้วเดียวตอนซูม / แตะสองครั้งเพื่อรีเซ็ต */
function Viewer({ page }: { page: PageRecord }) {
  const url = useBlobUrl(page.processedImage);
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ d: number; s: number; x: number; y: number; cx: number; cy: number } | null>(null);
  const lastTap = useRef(0);

  const down = (e: RPE<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = Date.now();
    if (pts.current.size === 1 && now - lastTap.current < 300) setT({ s: 1, x: 0, y: 0 });
    lastTap.current = now;
    const p = [...pts.current.values()];
    const d = p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0;
    start.current = { d, s: t.s, x: t.x, y: t.y, cx: p[0].x, cy: p[0].y };
  };
  const move = (e: RPE<HTMLDivElement>) => {
    if (!pts.current.has(e.pointerId) || !start.current) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...pts.current.values()], s0 = start.current;
    if (p.length > 1 && s0.d) {
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      setT((v) => ({ ...v, s: Math.min(5, Math.max(1, (s0.s * d) / s0.d)) }));
    } else if (t.s > 1) {
      setT((v) => ({ ...v, x: s0.x + (p[0].x - s0.cx), y: s0.y + (p[0].y - s0.cy) }));
    }
  };
  const up = (e: RPE<HTMLDivElement>) => {
    pts.current.delete(e.pointerId);
    const p = [...pts.current.values()];
    start.current = p.length ? { d: 0, s: t.s, x: t.x, y: t.y, cx: p[0].x, cy: p[0].y } : null;
    if (t.s <= 1.02) setT({ s: 1, x: 0, y: 0 });
  };

  return (
    <div className="flex h-full touch-none items-center justify-center overflow-hidden p-3"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onWheel={(e) => setT((v) => ({ ...v, s: Math.min(5, Math.max(1, v.s * (e.deltaY < 0 ? 1.1 : 0.9))) }))}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="หน้าเอกสาร" draggable={false}
          className="max-h-full max-w-full select-none rounded bg-white shadow-md"
          style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`, transition: start.current ? 'none' : 'transform .15s' }} />
      ) : <Spinner className="h-6 w-6 text-primary" />}
    </div>
  );
}

/**
 * แถบภาพย่อทุกหน้า — ลากเพื่อเรียงใหม่ (เมาส์ลากได้ทันที / มือถือกดค้างก่อนลาก)
 */
function PageStrip({ pages, current, onSelect, onReorder }: {
  pages: PageRecord[]; current: number; onSelect: (i: number) => void; onReorder: (ids: string[], newIndex: number) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (pages.length < 1) return null;

  const indexAt = (clientX: number) => {
    const items = Array.from(strip.current?.querySelectorAll<HTMLElement>('[data-page]') || []);
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return items.length - 1;
  };
  const down = (i: number) => (e: RPE<HTMLButtonElement>) => {
    const begin = () => { setDragIdx(i); setOverIdx(i); };
    if (e.pointerType === 'mouse') { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); timer.current = setTimeout(begin, 120); }
    else timer.current = setTimeout(() => { navigator.vibrate?.(15); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); begin(); }, 380);
  };
  const move = (e: RPE<HTMLButtonElement>) => { if (dragIdx !== null) setOverIdx(indexAt(e.clientX)); };
  const up = (i: number) => () => {
    if (timer.current) clearTimeout(timer.current);
    if (dragIdx === null) { onSelect(i); return; }
    const to = overIdx ?? dragIdx;
    setDragIdx(null); setOverIdx(null);
    if (to === dragIdx) return;
    const ids = pages.map((p) => p.id);
    const [m] = ids.splice(dragIdx, 1);
    ids.splice(to, 0, m);
    onReorder(ids, to);
  };

  return (
    <div ref={strip} className={`no-scrollbar flex gap-2 overflow-x-auto border-t border-line bg-surface px-3 py-2 ${dragIdx !== null ? 'touch-none' : ''}`}>
      {pages.map((p, i) => (
        <Thumb key={p.id} page={p} index={i} active={i === current} dragging={i === dragIdx} target={overIdx === i && dragIdx !== null && dragIdx !== i}
          onPointerDown={down(i)} onPointerMove={move} onPointerUp={up(i)} onPointerCancel={() => { if (timer.current) clearTimeout(timer.current); setDragIdx(null); }} />
      ))}
    </div>
  );
}

function Thumb({ page, index, active, dragging, target, ...h }: {
  page: PageRecord; index: number; active: boolean; dragging: boolean; target: boolean;
  onPointerDown: (e: RPE<HTMLButtonElement>) => void; onPointerMove: (e: RPE<HTMLButtonElement>) => void;
  onPointerUp: () => void; onPointerCancel: () => void;
}) {
  const url = useBlobUrl(page.thumbnail);
  return (
    <button data-page {...h} onContextMenu={(e) => e.preventDefault()}
      className={`relative shrink-0 select-none rounded-lg border-2 p-0.5 transition ${active ? 'border-primary' : 'border-transparent'} ${dragging ? 'scale-105 opacity-60' : ''} ${target ? 'translate-x-2' : ''}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url ? <img src={url} alt={`หน้า ${index + 1}`} draggable={false} className="h-16 w-12 rounded object-cover" /> : <div className="h-16 w-12" />}
      <span className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-black/60 px-1 text-[10px] text-white">{index + 1}</span>
    </button>
  );
}
