'use client';
import { FlipHorizontal, RotateCcw, RotateCw, Undo2, Check, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { pageBlob } from '@/lib/cloud';
import { blobToCanvas } from '@/lib/image';
import { renderPage } from '@/lib/process';
import { updatePage } from '@/lib/repo';
import type { Adjustments, FilterName, PageRecord } from '@/lib/types';
import { DEFAULT_ADJUST } from '@/lib/types';
import { Button, Slider, Spinner, friendlyError, useUi } from './ui';

export const FILTERS: { value: FilterName; label: string; hint: string }[] = [
  { value: 'original', label: 'ต้นฉบับ', hint: 'ไม่ปรับ' },
  { value: 'photo', label: 'ภาพถ่าย', hint: 'สีสดขึ้นเล็กน้อย' },
  { value: 'document', label: 'เอกสาร', hint: 'ลบเงา พื้นขาว ตัวหนังสือคม' },
  { value: 'clear', label: 'ชัดพิเศษ', hint: 'ขาวสะอาด ลดสัญญาณรบกวน' },
  { value: 'bw', label: 'ขาวดำ', hint: 'เหมาะกับเอกสารตัวหนังสือล้วน' },
  { value: 'gray', label: 'โทนเทา', hint: 'ไม่มีสี' }
];
const PREVIEW_MAX = 1100;

/** แก้ภาพของหน้า: ฟิลเตอร์ / ปรับแสง / หมุน / พลิก — บันทึกแล้วสร้างภาพความละเอียดเต็มใหม่ */
export default function ImageEditor({ page, onClose }: { page: PageRecord; onClose: () => void }) {
  const ui = useUi();
  const [filter, setFilter] = useState<FilterName>(page.filter);
  const [adj, setAdj] = useState<Adjustments>(page.adjustments || DEFAULT_ADJUST);
  const [rotation, setRotation] = useState(page.rotation);
  const [flip, setFlip] = useState(page.flip);
  const [base, setBase] = useState<HTMLCanvasElement | null>(null);
  const [rendering, setRendering] = useState(false);
  const [saving, setSaving] = useState(false);
  const view = useRef<HTMLCanvasElement>(null);
  const job = useRef(0);

  // ภาพครอบอาจอยู่บนระบบ (โหมดให้ระบบเก็บ) — pageBlob ดึงมาให้ก่อน
  useEffect(() => { pageBlob(page, 'c').then((b) => blobToCanvas(b, PREVIEW_MAX)).then(setBase).catch((e) => ui.toast(friendlyError(e), 'error')); }, [page.croppedImage, ui]); // eslint-disable-line react-hooks/exhaustive-deps

  // สร้าง preview ใหม่เมื่อค่าเปลี่ยน (หน่วงนิดหน่อยตอนลาก slider)
  useEffect(() => {
    if (!base) return;
    const id = ++job.current;
    const t = setTimeout(async () => {
      setRendering(true);
      try {
        const c = await renderPage(base, { filter, adjustments: adj, rotation, flip, markup: page.markup }, PREVIEW_MAX);
        if (id !== job.current || !view.current) return;
        view.current.width = c.width; view.current.height = c.height;
        view.current.getContext('2d')?.drawImage(c, 0, 0);
      } catch (e) { ui.toast(friendlyError(e), 'error'); }
      finally { if (id === job.current) setRendering(false); }
    }, 120);
    return () => clearTimeout(t);
  }, [base, filter, adj, rotation, flip, page.markup, ui]);

  const save = async () => {
    setSaving(true);
    try {
      await updatePage(page.id, { filter, adjustments: adj, rotation, flip }, true);
      onClose();
    } catch (e) { ui.toast(friendlyError(e), 'error'); setSaving(false); }
  };

  const set = (k: keyof Adjustments) => (v: number) => setAdj((a) => ({ ...a, [k]: v }));

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg">
      <div className="flex items-center justify-between border-b border-line bg-surface px-2 pt-[env(safe-area-inset-top)]">
        <Button variant="ghost" onClick={onClose}><X className="h-5 w-5" />ยกเลิก</Button>
        <span className="font-medium">ปรับภาพ</span>
        <Button variant="ghost" className="text-primary" loading={saving} onClick={save}><Check className="h-5 w-5" />บันทึก</Button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-3">
        <canvas ref={view} className="max-h-full max-w-full rounded-lg bg-white object-contain shadow" />
        {(rendering || !base) && <Spinner className="absolute right-4 top-4 h-5 w-5 text-primary" />}
      </div>
      <div className="max-h-[48dvh] overflow-y-auto border-t border-line bg-surface p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
          {FILTERS.map((f) => (
            <button key={f.value} onClick={() => setFilter(f.value)} title={f.hint}
              className={`shrink-0 rounded-xl border px-3 py-2 text-sm ${filter === f.value ? 'border-primary bg-primary/10 text-primary' : 'border-line'}`}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Slider label="ความสว่าง" value={adj.brightness} min={-100} max={100} onChange={set('brightness')} />
          <Slider label="คอนทราสต์" value={adj.contrast} min={-100} max={100} onChange={set('contrast')} />
          <Slider label="ความอิ่มสี" value={adj.saturation} min={-100} max={100} onChange={set('saturation')} />
          <Slider label="ความคม" value={adj.sharpness} min={0} max={100} onChange={set('sharpness')} />
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button onClick={() => setRotation((r) => (r + 270) % 360)}><RotateCcw className="h-4 w-4" />หมุนซ้าย</Button>
          <Button onClick={() => setRotation((r) => (r + 90) % 360)}><RotateCw className="h-4 w-4" />หมุนขวา</Button>
          <Button onClick={() => setFlip((f) => !f)}><FlipHorizontal className="h-4 w-4" />พลิก</Button>
          <Button variant="ghost" onClick={() => { setFilter('document'); setAdj({ ...DEFAULT_ADJUST }); setRotation(0); setFlip(false); }}>
            <Undo2 className="h-4 w-4" />รีเซ็ต
          </Button>
        </div>
      </div>
    </div>
  );
}
