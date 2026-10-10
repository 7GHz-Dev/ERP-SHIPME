'use client';
import { FileDown, Share2 } from 'lucide-react';
import { useState } from 'react';
import { pageBlob } from '@/lib/cloud';
import { downloadBlob, safeName, shareOrDownload } from '@/lib/image';
import { DEFAULT_PDF, exportPdf, jpgName, zipFiles, type PdfOptions } from '@/lib/pdf';
import type { DocRecord, PageRecord } from '@/lib/types';
import { Button, Sheet, friendlyError, selectCls, useUi } from './ui';

/** ส่งออก PDF / JPG และแชร์ (Web Share API ถ้ามี ไม่มีก็ดาวน์โหลด) */
export default function ExportSheet({ doc, pages, current, open, onClose }: {
  doc: DocRecord; pages: PageRecord[]; current: number; open: boolean; onClose: () => void;
}) {
  const ui = useUi();
  const [tab, setTab] = useState<'pdf' | 'jpg'>('pdf');
  const [o, setO] = useState<PdfOptions>(DEFAULT_PDF);
  const [which, setWhich] = useState<'current' | 'selected' | 'all'>('all');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const sel = <K extends keyof PdfOptions>(k: K, label: string, opts: [PdfOptions[K], string][]) => (
    <label className="block text-sm">
      <span className="mb-1 block text-muted">{label}</span>
      <select className={`${selectCls} w-full`} value={String(o[k])}
        onChange={(e) => setO({ ...o, [k]: (typeof o[k] === 'number' ? Number(e.target.value) : e.target.value) as PdfOptions[K] })}>
        {opts.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
      </select>
    </label>
  );

  const go = async (share: boolean) => {
    setBusy(true);
    try {
      let files: File[];
      if (tab === 'pdf') {
        const blob = await exportPdf(pages, o, doc.name);
        files = [new File([blob], `${safeName(doc.name)}.pdf`, { type: 'application/pdf' })];
      } else {
        const idx = which === 'current' ? [current] : which === 'all' ? pages.map((_, i) => i) : [...picked].sort((a, b) => a - b);
        if (!idx.length) { ui.toast('ยังไม่ได้เลือกหน้า'); return; }
        const jpgs = await Promise.all(idx.map(async (i) => ({ name: jpgName(doc.name, i), blob: await pageBlob(pages[i], 'p') })));
        // แชร์ได้หลายไฟล์บนมือถือ — ดาวน์โหลดหลายหน้ารวมเป็น ZIP เดียว
        files = share || jpgs.length === 1
          ? jpgs.map((j) => new File([j.blob], j.name, { type: 'image/jpeg' }))
          : [new File([await zipFiles(jpgs)], `${safeName(doc.name)}_JPG.zip`, { type: 'application/zip' })];
      }
      if (share) {
        const r = await shareOrDownload(files);
        if (r !== 'cancelled') ui.toast(r === 'shared' ? 'แชร์แล้ว' : 'ดาวน์โหลดแล้ว');
      } else {
        files.forEach((f) => downloadBlob(f, f.name));
        ui.toast('ดาวน์โหลดแล้ว');
      }
    } catch (e) {
      ui.toast(`ส่งออกไม่สำเร็จ: ${friendlyError(e)}`, 'error');
    } finally { setBusy(false); }
  };

  return (
    <Sheet open={open} onClose={onClose} title="ส่งออก / แชร์">
      <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1">
        {(['pdf', 'jpg'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`min-h-10 rounded-lg text-sm font-medium ${tab === t ? 'bg-surface shadow' : 'text-muted'}`}>{t.toUpperCase()}</button>
        ))}
      </div>
      {tab === 'pdf' ? (
        <div className="grid grid-cols-2 gap-3">
          {sel('pageSize', 'ขนาดหน้า', [['auto', 'อัตโนมัติ'], ['a4', 'A4'], ['letter', 'Letter']])}
          {sel('orientation', 'แนวกระดาษ', [['auto', 'อัตโนมัติ'], ['portrait', 'แนวตั้ง'], ['landscape', 'แนวนอน']])}
          {sel('quality', 'คุณภาพรูป', [['low', 'ต่ำ'], ['medium', 'กลาง'], ['high', 'สูง'], ['original', 'ต้นฉบับ']])}
          {sel('compression', 'การบีบอัด', [['small', 'ไฟล์เล็ก'], ['balanced', 'สมดุล'], ['best', 'คุณภาพดีสุด']])}
          {sel('dpi', 'ความละเอียด (DPI)', [[72, '72'], [150, '150'], [200, '200'], [300, '300']])}
          <p className="self-end text-xs text-muted">{pages.length} หน้า รวมเป็นไฟล์เดียว</p>
        </div>
      ) : (
        <div>
          <div className="flex flex-wrap gap-2">
            {([['current', `หน้านี้ (${current + 1})`], ['selected', 'เลือกหน้า'], ['all', `ทุกหน้า (${pages.length})`]] as const).map(([v, l]) => (
              <Button key={v} variant={which === v ? 'primary' : 'secondary'} onClick={() => setWhich(v)}>{l}</Button>
            ))}
          </div>
          {which === 'selected' && (
            <div className="mt-3 flex flex-wrap gap-2">
              {pages.map((_, i) => (
                <button key={i} onClick={() => setPicked((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                  className={`h-10 min-w-10 rounded-lg border px-2 text-sm ${picked.has(i) ? 'border-primary bg-primary text-white' : 'border-line'}`}>{i + 1}</button>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-muted">ชื่อไฟล์: {jpgName(doc.name, 0)} … (หลายหน้าดาวน์โหลดเป็น ZIP)</p>
        </div>
      )}
      <div className="mt-5 grid grid-cols-2 gap-2">
        <Button onClick={() => go(false)} loading={busy}><FileDown className="h-4 w-4" />ดาวน์โหลด</Button>
        <Button variant="primary" onClick={() => go(true)} loading={busy}><Share2 className="h-4 w-4" />แชร์</Button>
      </div>
    </Sheet>
  );
}
