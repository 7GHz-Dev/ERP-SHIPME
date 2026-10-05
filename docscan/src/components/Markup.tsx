'use client';
import {
  Check, Eraser, Highlighter, ImagePlus, MousePointer2, Pen, PenLine, Redo2, RotateCw, Square, Trash2, Type, Undo2, X, Minus, Plus
} from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as RPE } from 'react';
import { db, uid } from '@/lib/db';
import { blobToCanvas, canvasToBlob, ctx2d, makeCanvas } from '@/lib/image';
import { drawMarkup, sampleBackground } from '@/lib/markup';
import { renderPage } from '@/lib/process';
import { updatePage } from '@/lib/repo';
import type { MarkupObject, PageRecord, Point } from '@/lib/types';
import { Button, IconButton, Sheet, Slider, Spinner, friendlyError, inputCls, useUi } from './ui';

type Tool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'rect' | 'text';
const COLORS = ['#111827', '#2563eb', '#dc2626', '#16a34a', '#f59e0b'];
const PREVIEW_MAX = 1400;

/** Blob → data URL (เก็บรูปลายเซ็น/รูปแทรกไว้ในวัตถุ markup ได้ ไม่ผูกกับ object URL ที่หมดอายุ) */
const toDataUrl = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(b); });

/** ตัดขอบโปร่งใสรอบลายเซ็นออก จะได้วางพอดีไม่มีพื้นที่ว่าง */
function trimCanvas(c: HTMLCanvasElement) {
  const ctx = ctx2d(c), d = ctx.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const out = makeCanvas(x1 - x0 + 9, y1 - y0 + 9);
  ctx2d(out).drawImage(c, x0 - 4, y0 - 4, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function bbox(o: MarkupObject, aspect: number) {
  if (o.kind === 'stroke' || o.kind === 'erase') {
    const xs = o.points.map((p) => p.x), ys = o.points.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  if (o.kind === 'text') {
    const lines = o.text.split('\n');
    const w = Math.max(...lines.map((l) => l.length)) * o.size * 0.55 / 1000;
    const h = lines.length * o.size * 1.3 / 1000 * aspect;
    const x = o.align === 'center' ? o.x - w / 2 : o.align === 'right' ? o.x - w : o.x;
    return { x, y: o.y, w, h };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}
function moveObj(o: MarkupObject, dx: number, dy: number): MarkupObject {
  if (o.kind === 'stroke' || o.kind === 'erase') return { ...o, points: o.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  return { ...o, x: o.x + dx, y: o.y + dy } as MarkupObject;
}

export default function Markup({ page, onClose }: { page: PageRecord; onClose: () => void }) {
  const ui = useUi();
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const view = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [objs, setObjs] = useState<MarkupObject[]>(page.markup || []);
  const [undo, setUndo] = useState<MarkupObject[][]>([]);
  const [redo, setRedo] = useState<MarkupObject[][]>([]);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(4);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<MarkupObject | null>(null);
  const [saving, setSaving] = useState(false);
  const [sigOpen, setSigOpen] = useState(false);
  const [textEdit, setTextEdit] = useState<{ id: string | null; at: Point } | null>(null);
  const drag = useRef<{ start: Point; last: Point } | null>(null);
  const imgInput = useRef<HTMLInputElement>(null);

  // ภาพพื้น = หน้าหลังฟิลเตอร์/หมุน แต่ยังไม่มี markup
  useEffect(() => {
    (async () => {
      try {
        const cropped = await blobToCanvas(page.croppedImage, PREVIEW_MAX);
        baseRef.current = await renderPage(cropped, { filter: page.filter, adjustments: page.adjustments, rotation: page.rotation, flip: page.flip, markup: [] }, PREVIEW_MAX);
        setReady(true);
      } catch (e) { ui.toast(friendlyError(e), 'error'); }
    })();
  }, [page, ui]);

  // วาดหน้าจอใหม่ทุกครั้งที่วัตถุเปลี่ยน
  useEffect(() => {
    const base = baseRef.current, c = view.current;
    if (!ready || !base || !c) return;
    c.width = base.width; c.height = base.height;
    const ctx = ctx2d(c);
    ctx.drawImage(base, 0, 0);
    const all = draft ? [...objs, draft] : objs;
    drawMarkup(ctx, all, c.width, c.height).then(() => {
      const o = objs.find((x) => x.id === sel);
      if (!o) return;
      const b = bbox(o, c.width / c.height);
      ctx.save(); ctx.setLineDash([8, 6]); ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2;
      ctx.strokeRect(b.x * c.width - 6, b.y * c.height - 6, b.w * c.width + 12, b.h * c.height + 12);
      ctx.restore();
    });
  }, [objs, draft, sel, ready]);

  const commit = (next: MarkupObject[]) => { setUndo((u) => [...u.slice(-49), objs]); setRedo([]); setObjs(next); };
  const pos = (e: RPE<HTMLCanvasElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const hit = (p: Point) => {
    const c = view.current; if (!c) return null;
    for (let i = objs.length - 1; i >= 0; i--) {
      const b = bbox(objs[i], c.width / c.height), pad = 0.015;
      if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) return objs[i];
    }
    return null;
  };

  const down = (e: RPE<HTMLCanvasElement>) => {
    if (!ready) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pos(e);
    if (tool === 'select') {
      const o = hit(p);
      setSel(o?.id || null);
      if (o) { drag.current = { start: p, last: p }; setUndo((u) => [...u.slice(-49), objs]); setRedo([]); }
      return;
    }
    if (tool === 'text') { setTextEdit({ id: null, at: p }); return; }
    const id = uid();
    if (tool === 'rect') setDraft({ id, kind: 'rect', color, width, x: p.x, y: p.y, w: 0, h: 0 });
    else if (tool === 'eraser') {
      const c = view.current!, base = baseRef.current!;
      const bg = sampleBackground(ctx2d(base), p.x * c.width, p.y * c.height, (width * 3 * Math.max(c.width, c.height)) / 1000);
      setDraft({ id, kind: 'erase', color: bg, width: width * 3, points: [p] });
    } else setDraft({ id, kind: 'stroke', tool: tool === 'highlighter' ? 'highlighter' : 'pen', color: tool === 'highlighter' ? '#facc15' : color, width: tool === 'highlighter' ? width * 4 : width, points: [p] });
  };
  const move = (e: RPE<HTMLCanvasElement>) => {
    const p = pos(e);
    if (tool === 'select' && drag.current && sel) {
      const dx = p.x - drag.current.last.x, dy = p.y - drag.current.last.y;
      drag.current.last = p;
      setObjs((all) => all.map((o) => (o.id === sel ? moveObj(o, dx, dy) : o)));
      return;
    }
    if (!draft) return;
    if (draft.kind === 'rect') setDraft({ ...draft, w: p.x - draft.x, h: p.y - draft.y });
    else if (draft.kind === 'stroke' || draft.kind === 'erase') setDraft({ ...draft, points: [...draft.points, p] });
  };
  const up = () => {
    drag.current = null;
    if (!draft) return;
    let d = draft;
    if (d.kind === 'rect') d = { ...d, x: Math.min(d.x, d.x + d.w), y: Math.min(d.y, d.y + d.h), w: Math.abs(d.w), h: Math.abs(d.h) };
    setDraft(null);
    if (d.kind === 'rect' && (d.w < 0.01 || d.h < 0.01)) return;
    commit([...objs, d]);
  };

  const selected = objs.find((o) => o.id === sel) || null;
  const patchSel = (f: (o: MarkupObject) => MarkupObject) => { if (!sel) return; commit(objs.map((o) => (o.id === sel ? f(o) : o))); };
  const resize = (k: number) => patchSel((o) => {
    if (o.kind === 'image' || o.kind === 'rect') {
      const cx = o.x + o.w / 2, cy = o.y + o.h / 2, w = o.w * k, h = o.h * k;
      return { ...o, x: cx - w / 2, y: cy - h / 2, w, h };
    }
    if (o.kind === 'text') return { ...o, size: Math.max(8, o.size * k) };
    return { ...o, width: Math.max(1, o.width * k) };
  });

  const addImage = async (blob: Blob, isSignature: boolean) => {
    const c = view.current; if (!c) return;
    const src = await toDataUrl(blob);
    const img = await blobToCanvas(blob);
    const w = isSignature ? 0.3 : 0.5;
    const h = w * (img.height / img.width) * (c.width / c.height);
    const o: MarkupObject = { id: uid(), kind: 'image', src, x: 0.5 - w / 2, y: 0.5 - h / 2, w, h, rotation: 0 };
    commit([...objs, o]);
    setTool('select'); setSel(o.id);
  };

  const save = async () => {
    setSaving(true);
    try { await updatePage(page.id, { markup: objs }, true); onClose(); }
    catch (e) { ui.toast(friendlyError(e), 'error'); setSaving(false); }
  };

  const TOOLS: { t: Tool; icon: React.ReactNode; label: string }[] = [
    { t: 'select', icon: <MousePointer2 className="h-5 w-5" />, label: 'เลือก/ย้าย' },
    { t: 'pen', icon: <Pen className="h-5 w-5" />, label: 'ปากกา' },
    { t: 'highlighter', icon: <Highlighter className="h-5 w-5" />, label: 'ไฮไลต์' },
    { t: 'eraser', icon: <Eraser className="h-5 w-5" />, label: 'ลบรอย' },
    { t: 'rect', icon: <Square className="h-5 w-5" />, label: 'สี่เหลี่ยม' },
    { t: 'text', icon: <Type className="h-5 w-5" />, label: 'ข้อความ' }
  ];

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg">
      <div className="flex items-center justify-between border-b border-line bg-surface px-2 pt-[env(safe-area-inset-top)]">
        <Button variant="ghost" onClick={onClose}><X className="h-5 w-5" />ยกเลิก</Button>
        <div className="flex">
          <IconButton label="ย้อนกลับ" disabled={!undo.length} onClick={() => { setRedo((r) => [...r, objs]); setObjs(undo[undo.length - 1]); setUndo((u) => u.slice(0, -1)); }}><Undo2 className="h-5 w-5" /></IconButton>
          <IconButton label="ทำซ้ำ" disabled={!redo.length} onClick={() => { setUndo((u) => [...u, objs]); setObjs(redo[redo.length - 1]); setRedo((r) => r.slice(0, -1)); }}><Redo2 className="h-5 w-5" /></IconButton>
        </div>
        <Button variant="ghost" className="text-primary" loading={saving} onClick={save}><Check className="h-5 w-5" />บันทึก</Button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        {!ready && <Spinner className="h-6 w-6 text-primary" />}
        <canvas ref={view} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          className={`max-h-full max-w-full touch-none rounded-lg bg-white shadow ${ready ? '' : 'hidden'}`} />
      </div>
      <div className="border-t border-line bg-surface p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        {selected && tool === 'select' ? (
          <div className="mb-2 flex flex-wrap items-center justify-center gap-1">
            <Button onClick={() => resize(0.85)}><Minus className="h-4 w-4" />เล็กลง</Button>
            <Button onClick={() => resize(1.18)}><Plus className="h-4 w-4" />ใหญ่ขึ้น</Button>
            {selected.kind === 'image' && <Button onClick={() => patchSel((o) => (o.kind === 'image' ? { ...o, rotation: (o.rotation + 15) % 360 } : o))}><RotateCw className="h-4 w-4" />หมุน</Button>}
            {selected.kind === 'text' && <Button onClick={() => setTextEdit({ id: selected.id, at: { x: selected.x, y: selected.y } })}><Type className="h-4 w-4" />แก้ข้อความ</Button>}
            <Button variant="danger" onClick={() => { commit(objs.filter((o) => o.id !== sel)); setSel(null); }}><Trash2 className="h-4 w-4" />ลบ</Button>
          </div>
        ) : (
          <div className="mb-2 flex items-center gap-3 px-2">
            <div className="flex gap-1.5">
              {COLORS.map((c) => (
                <button key={c} aria-label={`สี ${c}`} onClick={() => setColor(c)}
                  className={`h-8 w-8 rounded-full border-2 ${color === c ? 'border-primary ring-2 ring-primary/30' : 'border-line'}`} style={{ background: c }} />
              ))}
            </div>
            <div className="flex-1"><Slider label="ความหนา" value={width} min={1} max={20} onChange={setWidth} /></div>
          </div>
        )}
        <div className="no-scrollbar flex justify-between gap-1 overflow-x-auto">
          {TOOLS.map((x) => (
            <button key={x.t} onClick={() => { setTool(x.t); if (x.t !== 'select') setSel(null); }}
              className={`flex min-w-14 shrink-0 flex-col items-center gap-0.5 rounded-xl px-2 py-1.5 text-[11px] ${tool === x.t ? 'bg-primary/10 text-primary' : 'text-muted'}`}>
              {x.icon}{x.label}
            </button>
          ))}
          <button onClick={() => setSigOpen(true)} className="flex min-w-14 shrink-0 flex-col items-center gap-0.5 rounded-xl px-2 py-1.5 text-[11px] text-muted">
            <PenLine className="h-5 w-5" />ลายเซ็น
          </button>
          <button onClick={() => imgInput.current?.click()} className="flex min-w-14 shrink-0 flex-col items-center gap-0.5 rounded-xl px-2 py-1.5 text-[11px] text-muted">
            <ImagePlus className="h-5 w-5" />รูปภาพ
          </button>
        </div>
      </div>
      <input ref={imgInput} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) addImage(f, false).catch((er) => ui.toast(friendlyError(er), 'error')); e.target.value = ''; }} />
      <SignatureSheet open={sigOpen} onClose={() => setSigOpen(false)} onPick={(b) => { setSigOpen(false); addImage(b, true).catch((er) => ui.toast(friendlyError(er), 'error')); }} />
      {textEdit && (
        <TextSheet
          initial={textEdit.id ? (objs.find((o) => o.id === textEdit.id) as Extract<MarkupObject, { kind: 'text' }>) : null}
          color={color}
          onClose={() => setTextEdit(null)}
          onSave={(t) => {
            if (textEdit.id) commit(objs.map((o) => (o.id === textEdit.id && o.kind === 'text' ? { ...o, ...t } : o)));
            else commit([...objs, { id: uid(), kind: 'text', x: textEdit.at.x, y: textEdit.at.y, ...t }]);
            setTextEdit(null);
          }}
        />
      )}
    </div>
  );
}

function TextSheet({ initial, color, onClose, onSave }: {
  initial: Extract<MarkupObject, { kind: 'text' }> | null; color: string; onClose: () => void;
  onSave: (t: { text: string; size: number; font: string; align: CanvasTextAlign; color: string }) => void;
}) {
  const [text, setText] = useState(initial?.text || '');
  const [size, setSize] = useState(initial?.size || 28);
  const [bold, setBold] = useState(initial?.font.includes('bold') || false);
  const [italic, setItalic] = useState(initial?.font.includes('italic') || false);
  const [align, setAlign] = useState<CanvasTextAlign>(initial?.align || 'left');
  return (
    <Sheet open onClose={onClose} title="ข้อความ">
      <textarea autoFocus value={text} onChange={(e) => setText(e.target.value.slice(0, 500))} rows={3} className={`${inputCls} py-2`} />
      <div className="mt-3"><Slider label="ขนาดตัวอักษร" value={size} min={10} max={80} onChange={setSize} /></div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant={bold ? 'primary' : 'secondary'} onClick={() => setBold(!bold)}>ตัวหนา</Button>
        <Button variant={italic ? 'primary' : 'secondary'} onClick={() => setItalic(!italic)}>ตัวเอียง</Button>
        {(['left', 'center', 'right'] as CanvasTextAlign[]).map((a) => (
          <Button key={a} variant={align === a ? 'primary' : 'secondary'} onClick={() => setAlign(a)}>{a === 'left' ? 'ชิดซ้าย' : a === 'center' ? 'กึ่งกลาง' : 'ชิดขวา'}</Button>
        ))}
      </div>
      <Button variant="primary" className="mt-4 w-full" disabled={!text.trim()}
        onClick={() => onSave({ text: text.trim(), size, align, color: initial?.color || color, font: [bold && 'bold', italic && 'italic'].filter(Boolean).join(' ') })}>
        ใส่ข้อความ
      </Button>
    </Sheet>
  );
}

/** ลายเซ็น: วาดเอง หรืออัปโหลดรูป — เก็บในเครื่องไว้ใช้ซ้ำ ไม่ส่งขึ้นคลาวด์ */
function SignatureSheet({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (b: Blob) => void }) {
  const ui = useUi();
  const pad = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [saved, setSaved] = useState<{ id: string; url: string; blob: Blob }[]>([]);
  const upload = useRef<HTMLInputElement>(null);

  const load = async () => {
    const rows = await db.signatures.orderBy('createdAt').reverse().toArray();
    setSaved((old) => { old.forEach((s) => URL.revokeObjectURL(s.url)); return rows.map((r) => ({ id: r.id, blob: r.image, url: URL.createObjectURL(r.image) })); });
  };
  useEffect(() => { if (open) load(); }, [open]);

  const p = (e: RPE<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(); return { x: (e.clientX - r.left) * (e.currentTarget.width / r.width), y: (e.clientY - r.top) * (e.currentTarget.height / r.height) }; };
  const ctx = () => { const c = ctx2d(pad.current!); c.lineWidth = 4; c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = '#111827'; return c; };
  const store = async (b: Blob) => { await db.signatures.add({ id: uid(), image: b, createdAt: Date.now() }); await load(); };

  const useDrawn = async () => {
    const t = trimCanvas(pad.current!);
    if (!t) { ui.toast('ยังไม่ได้เซ็น'); return; }
    const b = await canvasToBlob(t, 'image/png');
    await store(b);
    ctx2d(pad.current!).clearRect(0, 0, pad.current!.width, pad.current!.height);
    onPick(b);
  };

  return (
    <Sheet open={open} onClose={onClose} title="ลายเซ็น">
      <canvas ref={pad} width={900} height={360} className="w-full touch-none rounded-xl border border-dashed border-line bg-white"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true; const q = p(e); const c = ctx(); c.beginPath(); c.moveTo(q.x, q.y); }}
        onPointerMove={(e) => { if (!drawing.current) return; const q = p(e); const c = ctx(); c.lineTo(q.x, q.y); c.stroke(); }}
        onPointerUp={() => { drawing.current = false; }} />
      <div className="mt-2 flex gap-2">
        <Button variant="ghost" onClick={() => ctx2d(pad.current!).clearRect(0, 0, 900, 360)}>ล้าง</Button>
        <Button onClick={() => upload.current?.click()}>อัปโหลดรูปลายเซ็น</Button>
        <Button variant="primary" className="ml-auto" onClick={useDrawn}>ใช้ลายเซ็นนี้</Button>
      </div>
      {saved.length > 0 && (
        <>
          <p className="mt-4 mb-2 text-sm text-muted">ลายเซ็นที่บันทึกไว้ (เก็บในเครื่องนี้เท่านั้น)</p>
          <div className="grid grid-cols-3 gap-2">
            {saved.map((s) => (
              <div key={s.id} className="relative rounded-lg border border-line bg-white p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url} alt="ลายเซ็น" className="h-14 w-full cursor-pointer object-contain" onClick={() => onPick(s.blob)} />
                <button aria-label="ลบลายเซ็น" className="absolute right-1 top-1 rounded bg-white/90 p-1 text-red-600"
                  onClick={async () => { await db.signatures.delete(s.id); await load(); }}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
          </div>
        </>
      )}
      <input ref={upload} type="file" accept="image/*" hidden onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        try { const c = await blobToCanvas(f, 1200); const b = await canvasToBlob(c, 'image/png'); await store(b); onPick(b); }
        catch (er) { ui.toast(friendlyError(er), 'error'); }
      }} />
    </Sheet>
  );
}
