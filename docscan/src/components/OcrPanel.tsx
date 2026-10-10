'use client';
import { Copy, Download, ScanText, Search as SearchIcon, Share2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { pageBlob } from '@/lib/cloud';
import { getSetting, setSetting } from '@/lib/db';
import { downloadBlob, safeName, shareOrDownload } from '@/lib/image';
import { OCR_LANGS, getOcrEngine, type OcrLang } from '@/lib/ocr';
import { updatePage } from '@/lib/repo';
import type { DocRecord, PageRecord } from '@/lib/types';
import { Button, Sheet, friendlyError, inputCls, selectCls, useUi } from './ui';

/** อ่านข้อความจากหน้าเอกสาร (ทำในเครื่อง) แล้วเก็บไว้ในเอกสารเพื่อให้ค้นหาได้ */
export default function OcrPanel({ doc, pages, current, open, onClose }: {
  doc: DocRecord; pages: PageRecord[]; current: number; open: boolean; onClose: () => void;
}) {
  const ui = useUi();
  const [lang, setLang] = useState<OcrLang>('tha+eng');
  const [scope, setScope] = useState<'page' | 'all'>('page');
  const [progress, setProgress] = useState<{ status: string; pct: number; page: string } | null>(null);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => { getSetting<OcrLang>('ocrLang', 'tha+eng').then(setLang); }, []);
  useEffect(() => {
    if (!open) return;
    setText(scope === 'page' ? (pages[current]?.ocrText || '') : pages.map((p, i) => (p.ocrText ? `— หน้า ${i + 1} —\n${p.ocrText}` : '')).filter(Boolean).join('\n\n'));
  }, [open, scope, current, pages]);

  const run = async () => {
    const targets = scope === 'page' ? [pages[current]] : pages;
    const engine = getOcrEngine();
    const out: string[] = [];
    try {
      for (let i = 0; i < targets.length; i++) {
        const p = targets[i];
        const label = targets.length > 1 ? `หน้า ${i + 1}/${targets.length}` : '';
        const t = await engine.recognize(await pageBlob(p, 'p'), lang, (pr) => setProgress({ status: pr.status, pct: Math.round(pr.progress * 100), page: label }));
        await updatePage(p.id, { ocrText: t });
        out.push(targets.length > 1 ? `— หน้า ${pages.indexOf(p) + 1} —\n${t}` : t);
      }
      setText(out.join('\n\n'));
      ui.toast('อ่านข้อความเสร็จแล้ว');
    } catch (e) {
      ui.toast(`อ่านข้อความไม่สำเร็จ: ${friendlyError(e)}`, 'error');
    } finally { setProgress(null); }
  };

  const saveEdit = async () => {
    if (scope !== 'page') return;
    await updatePage(pages[current].id, { ocrText: text });
    ui.toast('บันทึกข้อความแล้ว');
  };

  // ไฮไลต์คำค้นในข้อความ — แสดงเป็น text node ล้วน ไม่ inject HTML
  const parts = useMemo(() => {
    if (!q.trim()) return null;
    const idx: { s: string; hit: boolean }[] = [];
    const lower = text.toLowerCase(), needle = q.toLowerCase();
    let i = 0;
    while (i < text.length) {
      const j = lower.indexOf(needle, i);
      if (j < 0) { idx.push({ s: text.slice(i), hit: false }); break; }
      if (j > i) idx.push({ s: text.slice(i, j), hit: false });
      idx.push({ s: text.slice(j, j + needle.length), hit: true });
      i = j + needle.length;
    }
    return idx;
  }, [q, text]);
  const hits = parts ? parts.filter((p) => p.hit).length : 0;

  return (
    <Sheet open={open} onClose={onClose} title="อ่านข้อความ (OCR)" wide>
      <div className="flex flex-wrap gap-2">
        <select value={lang} onChange={(e) => { const v = e.target.value as OcrLang; setLang(v); setSetting('ocrLang', v); }} className={selectCls}>
          {OCR_LANGS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
        <select value={scope} onChange={(e) => setScope(e.target.value as 'page' | 'all')} className={selectCls}>
          <option value="page">หน้านี้ (หน้า {current + 1})</option>
          <option value="all">ทุกหน้า ({pages.length})</option>
        </select>
        <Button variant="primary" onClick={run} loading={!!progress}><ScanText className="h-4 w-4" />อ่านข้อความ</Button>
      </div>
      {progress && (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-sm text-muted"><span>{progress.status} {progress.page}</span><span>{progress.pct}%</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2"><div className="h-full bg-primary transition-all" style={{ width: `${progress.pct}%` }} /></div>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">อ่านในเครื่องนี้ด้วย {getOcrEngine().name} — ครั้งแรกจะดาวน์โหลดไฟล์ภาษา (รูปเอกสารไม่ถูกส่งออก)</p>
      <div className="relative mt-3">
        <SearchIcon className="absolute left-3 top-3.5 h-4 w-4 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหาในข้อความ" className={`${inputCls} pl-9`} />
        {q && <span className="absolute right-3 top-3 text-sm text-muted">{hits} ที่</span>}
      </div>
      {parts ? (
        <div className="mt-2 max-h-[40dvh] overflow-y-auto whitespace-pre-wrap rounded-xl border border-line p-3 text-[15px]">
          {parts.map((p, i) => (p.hit ? <mark key={i} className="rounded bg-yellow-200 px-0.5 dark:bg-yellow-600/60">{p.s}</mark> : <span key={i}>{p.s}</span>))}
        </div>
      ) : (
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} readOnly={scope !== 'page'}
          placeholder="ยังไม่มีข้อความ — กด 'อ่านข้อความ'" className={`${inputCls} mt-2 py-2`} />
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={async () => { await navigator.clipboard.writeText(text); ui.toast('คัดลอกแล้ว'); }} disabled={!text}><Copy className="h-4 w-4" />คัดลอก</Button>
        <Button onClick={() => downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${safeName(doc.name)}.txt`)} disabled={!text}><Download className="h-4 w-4" />บันทึก TXT</Button>
        <Button onClick={() => shareOrDownload([], text)} disabled={!text}><Share2 className="h-4 w-4" />แชร์ข้อความ</Button>
        {scope === 'page' && <Button variant="primary" className="ml-auto" onClick={saveEdit} disabled={!text}>บันทึกการแก้ไข</Button>}
      </div>
    </Sheet>
  );
}
