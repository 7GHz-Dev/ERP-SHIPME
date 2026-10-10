'use client';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowDownAZ, ArrowUpAZ, Camera, ChevronRight, Cloud, CloudAlert, CloudUpload, Copy, FileUp, Folder as FolderIcon, FolderPlus, FolderInput, Grid2x2,
  ImagePlus, List, MoreVertical, Pencil, Search, Share2, Smartphone, Trash2, Send
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getSession, hydrate, moveToCloud, moveToLocal, useCloudStatus } from '@/lib/cloud';
import { db, getSetting, setSetting } from '@/lib/db';
import { thaiDate, type ErpTicket } from '@/lib/erp';
import { formatBytes, safeName, shareOrDownload } from '@/lib/image';
import { DEFAULT_PDF, exportPdf } from '@/lib/pdf';
import {
  createFolder, deleteFolder, duplicateDocument, folderPath, getPages, moveDocument, moveFolder, renameDocument,
  renameFolder, trashDocument
} from '@/lib/repo';
import type { DocRecord, Folder, SortKey } from '@/lib/types';
import { Button, IconButton, Sheet, Spinner, friendlyError, selectCls, useBlobUrl, useUi } from './ui';

const SORTS: { k: SortKey; label: string }[] = [
  { k: 'updatedAt', label: 'แก้ไขล่าสุด' }, { k: 'createdAt', label: 'วันที่สร้าง' }, { k: 'name', label: 'ชื่อ' }, { k: 'size', label: 'ขนาดไฟล์' }
];
const fmtDate = (t: number) => new Date(t).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });

export default function Library({ folderId, ticket, onOpenFolder, onOpenDoc, onScan, onImport, onSearch }: {
  folderId: string | null;
  ticket: ErpTicket | null;
  onOpenFolder: (id: string | null) => void;
  onOpenDoc: (id: string) => void;
  onScan: () => void;
  onImport: (kind: 'image' | 'pdf') => void;
  onSearch: () => void;
}) {
  const ui = useUi();
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState<SortKey>('updatedAt');
  const [asc, setAsc] = useState(false);
  const [menu, setMenu] = useState<{ type: 'doc'; item: DocRecord } | { type: 'folder'; item: Folder } | null>(null);
  const [moving, setMoving] = useState<{ type: 'doc' | 'folder'; id: string } | null>(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    getSetting<{ view: 'grid' | 'list'; sort: SortKey; asc: boolean }>('library', { view: 'grid', sort: 'updatedAt', asc: false })
      .then((s) => { setView(s.view); setSort(s.sort); setAsc(s.asc); });
  }, []);
  const remember = (patch: Partial<{ view: 'grid' | 'list'; sort: SortKey; asc: boolean }>) =>
    setSetting('library', { view, sort, asc, ...patch });

  const folders = useLiveQuery(() => db.folders.filter((f) => (f.parentFolderId ?? null) === folderId).toArray(), [folderId]) || [];
  const docs = useLiveQuery(() => db.documents.filter((d) => !d.deletedAt && (d.folderId ?? null) === folderId).toArray(), [folderId]) || [];
  const path = useLiveQuery(() => folderPath(folderId), [folderId]) || [];

  const sortedDocs = useMemo(() => {
    const out = [...docs].sort((a, b) => {
      const v = sort === 'name' ? a.name.localeCompare(b.name, 'th') : (a[sort] as number) - (b[sort] as number);
      return asc ? v : -v;
    });
    return out;
  }, [docs, sort, asc]);
  const sortedFolders = useMemo(() => [...folders].sort((a, b) => a.name.localeCompare(b.name, 'th')), [folders]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setMenu(null);
    try { await fn(); if (ok) ui.toast(ok); } catch (e) { ui.toast(friendlyError(e), 'error'); }
  };

  const shareDoc = async (d: DocRecord) => {
    if (!d.pageCount) { ui.toast('เอกสารนี้ยังไม่มีหน้า'); return; }
    // ให้ระบบเก็บ: ดึงภาพสุดท้ายลงมาก่อน (ลบออกเองหลังซิงก์รอบถัดไป)
    if (d.storage === 'cloud') {
      setBusy('กำลังโหลดเอกสารจากระบบ…');
      try { await hydrate(d.id, ['p'], { onProgress: (n, t) => setBusy(`กำลังโหลดเอกสารจากระบบ ${n}/${t}…`) }); }
      finally { setBusy(''); }
    }
    const pdf = await exportPdf(await getPages(d.id), DEFAULT_PDF, d.name);
    await shareOrDownload([new File([pdf], `${safeName(d.name)}.pdf`, { type: 'application/pdf' })]);
  };

  const toCloud = async (d: DocRecord) => {
    setMenu(null);
    if (!getSession()) { ui.toast('เข้าสู่ระบบที่เก็บเอกสารก่อน: ตั้งค่า → ที่เก็บเอกสาร', 'error'); return; }
    await act(() => moveToCloud([d.id]), 'กำลังย้ายขึ้นระบบ — อัปเสร็จแล้วรูปในเครื่องจะถูกลบให้เอง');
  };
  const toLocal = async (d: DocRecord) => {
    setMenu(null);
    if (!await ui.confirm('ดึงกลับมาเก็บในเครื่อง?', `ใช้พื้นที่ในเครื่องประมาณ ${formatBytes(d.size)} แล้วลบออกจากระบบ`, { ok: 'ดึงกลับมา' })) return;
    setBusy('กำลังดึงเอกสารจากระบบ…');
    try {
      await moveToLocal(d.id, (n, t) => setBusy(`กำลังดึงเอกสารจากระบบ ${n}/${t}…`));
      ui.toast('เก็บในเครื่องแล้ว');
    } catch (e) { ui.toast(friendlyError(e), 'error'); }
    finally { setBusy(''); }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 pb-28 pt-[calc(1rem+env(safe-area-inset-top))]">
      <header className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/mark.webp" alt="" width={40} height={40} className="h-10 w-10" />
          <div className="leading-tight">
            <h1 className="text-2xl font-bold tracking-tight text-navy">DocScan</h1>
            <p className="text-xs font-semibold text-muted">by ERP <span className="text-primary">SHIP</span><span className="text-accent">ME</span></p>
          </div>
        </div>
        <div className="flex">
          <IconButton label={view === 'grid' ? 'มุมมองรายการ' : 'มุมมองตาราง'} onClick={() => { const v = view === 'grid' ? 'list' : 'grid'; setView(v); remember({ view: v }); }}>
            {view === 'grid' ? <List className="h-5 w-5" /> : <Grid2x2 className="h-5 w-5" />}
          </IconButton>
        </div>
      </header>

      <button onClick={onSearch} className="mb-4 flex min-h-11 w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 text-left text-muted">
        <Search className="h-4 w-4" />ค้นหาเอกสาร
      </button>

      <CloudBar />
      {busy && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/60 text-white">
          <Spinner className="h-8 w-8" /><p>{busy}</p>
        </div>
      )}

      {ticket && (
        <div className="mb-4 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
          <p className="font-semibold">แนบหลักฐานการตรวจปล่อยเข้าใบปิดบัญชี</p>
          <p className="mt-1 text-sm">{ticket.name} • วันที่ตรวจปล่อย {thaiDate(ticket.inspectDate)}</p>
          <p className="mt-1 text-sm opacity-80">ถ่ายทุกหน้าของเอกสารตรวจปล่อย แล้วกด "ส่งเข้าใบปิดบัญชี"</p>
          <Button variant="primary" className="mt-3" onClick={onScan}><Send className="h-4 w-4" />เริ่มสแกนเอกสารตรวจปล่อย</Button>
        </div>
      )}

      <div className="mb-4 grid grid-cols-3 gap-2">
        <Button variant="primary" onClick={onScan} className="flex-col py-3"><Camera className="h-5 w-5" />สแกนเอกสาร</Button>
        <Button onClick={() => onImport('image')} className="flex-col py-3"><ImagePlus className="h-5 w-5" />นำเข้ารูป</Button>
        <Button onClick={() => onImport('pdf')} className="flex-col py-3"><FileUp className="h-5 w-5" />นำเข้า PDF</Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm no-scrollbar">
          <button onClick={() => onOpenFolder(null)} className={`shrink-0 rounded-lg px-2 py-1 ${folderId ? 'text-primary' : 'font-semibold'}`}>เอกสาร</button>
          {path.map((f, i) => (
            <span key={f.id} className="flex shrink-0 items-center gap-1">
              <ChevronRight className="h-4 w-4 text-muted" />
              <button onClick={() => onOpenFolder(f.id)} className={`rounded-lg px-2 py-1 ${i === path.length - 1 ? 'font-semibold' : 'text-primary'}`}>{f.name}</button>
            </span>
          ))}
        </nav>
        <select value={sort} onChange={(e) => { const v = e.target.value as SortKey; setSort(v); remember({ sort: v }); }} className={`${selectCls} text-sm`}>
          {SORTS.map((s) => <option key={s.k} value={s.k}>{s.label}</option>)}
        </select>
        <IconButton label={asc ? 'น้อยไปมาก' : 'มากไปน้อย'} onClick={() => { setAsc(!asc); remember({ asc: !asc }); }}>
          {asc ? <ArrowUpAZ className="h-5 w-5" /> : <ArrowDownAZ className="h-5 w-5" />}
        </IconButton>
        <IconButton label="โฟลเดอร์ใหม่" onClick={async () => { const n = await ui.prompt('ชื่อโฟลเดอร์ใหม่', ''); if (n?.trim()) await act(() => createFolder(n, folderId)); }}>
          <FolderPlus className="h-5 w-5" />
        </IconButton>
      </div>

      {!sortedFolders.length && !sortedDocs.length && (
        <div className="rounded-2xl border border-dashed border-line p-10 text-center text-muted">
          <p>ยังไม่มีเอกสาร{folderId ? 'ในโฟลเดอร์นี้' : ''}</p>
          <p className="mt-1 text-sm">กด "สแกนเอกสาร" เพื่อเริ่ม</p>
        </div>
      )}

      {sortedFolders.length > 0 && (
        <div className={view === 'grid' ? 'mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4' : 'mb-2 divide-y divide-line rounded-2xl border border-line bg-surface'}>
          {sortedFolders.map((f) => (
            <div key={f.id} className={`flex items-center gap-2 ${view === 'grid' ? 'rounded-2xl border border-line bg-surface p-3 shadow-sm' : 'p-2'}`}>
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onOpenFolder(f.id)}>
                <FolderIcon className="h-6 w-6 shrink-0 text-primary" /><span className="truncate font-medium">{f.name}</span>
              </button>
              <IconButton label="ตัวเลือกโฟลเดอร์" onClick={() => setMenu({ type: 'folder', item: f })}><MoreVertical className="h-4 w-4" /></IconButton>
            </div>
          ))}
        </div>
      )}

      <div className={view === 'grid' ? 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4' : 'divide-y divide-line rounded-2xl border border-line bg-surface'}>
        {sortedDocs.map((d) => <DocCard key={d.id} doc={d} view={view} onOpen={() => onOpenDoc(d.id)} onMenu={() => setMenu({ type: 'doc', item: d })} />)}
      </div>

      <Sheet open={!!menu} onClose={() => setMenu(null)} title={menu?.item.name}>
        {menu?.type === 'doc' && (
          <div className="grid gap-2">
            <Button variant="primary" onClick={() => { setMenu(null); onOpenDoc(menu.item.id); }}>เปิด</Button>
            <Button onClick={async () => { const n = await ui.prompt('เปลี่ยนชื่อ', menu.item.name); if (n?.trim()) await act(() => renameDocument(menu.item.id, n)); }}><Pencil className="h-4 w-4" />เปลี่ยนชื่อ</Button>
            <Button onClick={() => { setMoving({ type: 'doc', id: menu.item.id }); setMenu(null); }}><FolderInput className="h-4 w-4" />ย้ายไปโฟลเดอร์</Button>
            <Button onClick={() => act(() => duplicateDocument(menu.item.id), 'ทำสำเนาแล้ว')}><Copy className="h-4 w-4" />ทำสำเนา</Button>
            <Button onClick={() => act(() => shareDoc(menu.item))}><Share2 className="h-4 w-4" />แชร์ / ส่งออก PDF</Button>
            {menu.item.storage === 'cloud'
              ? <Button onClick={() => toLocal(menu.item)}><Smartphone className="h-4 w-4" />ดึงกลับมาเก็บในเครื่อง</Button>
              : <Button onClick={() => toCloud(menu.item)}><CloudUpload className="h-4 w-4" />ย้ายไปให้ระบบเก็บ (คืนพื้นที่เครื่อง)</Button>}
            <Button variant="danger" onClick={() => act(() => trashDocument(menu.item.id), 'ย้ายลงถังขยะแล้ว (กู้คืนได้ 30 วัน)')}><Trash2 className="h-4 w-4" />ลบ</Button>
          </div>
        )}
        {menu?.type === 'folder' && (
          <div className="grid gap-2">
            <Button onClick={async () => { const n = await ui.prompt('เปลี่ยนชื่อโฟลเดอร์', menu.item.name); if (n?.trim()) await act(() => renameFolder(menu.item.id, n)); }}><Pencil className="h-4 w-4" />เปลี่ยนชื่อ</Button>
            <Button onClick={() => { setMoving({ type: 'folder', id: menu.item.id }); setMenu(null); }}><FolderInput className="h-4 w-4" />ย้ายโฟลเดอร์</Button>
            <Button variant="danger" onClick={async () => {
              const item = menu.item;
              if (await ui.confirm(`ลบโฟลเดอร์ "${item.name}"?`, 'เอกสารข้างในจะถูกย้ายลงถังขยะ (กู้คืนได้ 30 วัน) และโฟลเดอร์ย่อยจะถูกลบ', { ok: 'ลบโฟลเดอร์', danger: true })) await act(() => deleteFolder(item.id));
            }}><Trash2 className="h-4 w-4" />ลบโฟลเดอร์</Button>
          </div>
        )}
      </Sheet>

      <MoveSheet moving={moving} onClose={() => setMoving(null)} onPick={(target) => {
        const m = moving; setMoving(null);
        if (!m) return;
        act(() => (m.type === 'doc' ? moveDocument(m.id, target) : moveFolder(m.id, target)), 'ย้ายแล้ว');
      }} />
    </div>
  );
}

/** แถบสถานะที่เก็บบนระบบ — ขึ้นเฉพาะตอนมีเรื่องให้รู้ (กำลังอัป / ต้องเข้าสู่ระบบ / มีปัญหา) */
function CloudBar() {
  const s = useCloudStatus();
  const toSettings = () => { location.hash = '/settings'; };
  if (s.needLogin && (s.pending || s.mode === 'cloud')) {
    return (
      <button onClick={toSettings} className="mb-4 flex w-full items-center gap-2 rounded-xl bg-amber-50 p-3 text-left text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
        <CloudAlert className="h-5 w-5 shrink-0" />เข้าสู่ระบบที่เก็บเอกสารอีกครั้ง เพื่ออัปเอกสารที่ค้างอยู่ — แตะเพื่อไปตั้งค่า
      </button>
    );
  }
  if (!s.pending && !s.error) return null;
  return (
    <button onClick={toSettings} className="mb-4 flex w-full items-center gap-2 rounded-xl border border-line bg-surface p-3 text-left text-sm">
      {s.error ? <CloudAlert className="h-5 w-5 shrink-0 text-amber-600" /> : <CloudUpload className="h-5 w-5 shrink-0 text-primary" />}
      <span className="flex-1">
        {s.pending ? `รออัปขึ้นระบบ ${s.pending} หน้า` : 'ซิงก์กับระบบไม่สำเร็จ'}
        {s.error && <span className="block text-xs text-muted">{s.error}</span>}
      </span>
      {s.syncing && <Spinner className="h-4 w-4 text-primary" />}
    </button>
  );
}

function DocCard({ doc, view, onOpen, onMenu }: { doc: DocRecord; view: 'grid' | 'list'; onOpen: () => void; onMenu: () => void }) {
  const url = useBlobUrl(doc.thumbnail);
  const meta = `${doc.pageCount} หน้า • ${formatBytes(doc.size)}`;
  // ให้ระบบเก็บ: อัปครบแล้ว = เมฆ • ยังไม่เคยอัปครบ = เมฆมีลูกศร
  const where = doc.storage === 'cloud'
    ? (doc.cloudSig ? <Cloud className="mr-1 inline h-3.5 w-3.5 text-primary" aria-label="ให้ระบบเก็บ" /> : <CloudUpload className="mr-1 inline h-3.5 w-3.5 text-muted" aria-label="รออัปขึ้นระบบ" />)
    : null;
  if (view === 'list') {
    return (
      <div className="flex items-center gap-3 p-2">
        <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {url ? <img src={url} alt="" className="h-14 w-11 shrink-0 rounded border border-line object-cover" /> : <div className="h-14 w-11 shrink-0 rounded bg-surface-2" />}
          <div className="min-w-0">
            <p className="truncate font-medium">{doc.name}</p>
            <p className="text-xs text-muted">{where}{meta}</p>
            <p className="text-xs text-muted">สร้าง {fmtDate(doc.createdAt)} • แก้ไข {fmtDate(doc.updatedAt)}</p>
          </div>
        </button>
        <IconButton label="ตัวเลือก" onClick={onMenu}><MoreVertical className="h-4 w-4" /></IconButton>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
      <button onClick={onOpen} className="block aspect-[3/4] w-full bg-surface-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <span className="text-sm text-muted">ไม่มีหน้า</span>}
      </button>
      <div className="flex items-start gap-1 p-2">
        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-medium">{doc.name}</p>
          <p className="text-[11px] text-muted">{where}{meta}</p>
          <p className="text-[11px] text-muted">แก้ไข {fmtDate(doc.updatedAt)}</p>
        </button>
        <IconButton label="ตัวเลือก" className="-mr-1 h-9 min-w-9" onClick={onMenu}><MoreVertical className="h-4 w-4" /></IconButton>
      </div>
    </div>
  );
}

/** เลือกโฟลเดอร์ปลายทาง (แสดงเป็นต้นไม้) */
function MoveSheet({ moving, onClose, onPick }: { moving: { type: 'doc' | 'folder'; id: string } | null; onClose: () => void; onPick: (id: string | null) => void }) {
  const all = useLiveQuery(() => db.folders.toArray(), []) || [];
  const rows: { f: Folder; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    all.filter((f) => (f.parentFolderId ?? null) === parent).sort((a, b) => a.name.localeCompare(b.name, 'th')).forEach((f) => {
      // ย้ายโฟลเดอร์: ไม่แสดงตัวเองและโฟลเดอร์ย่อยของตัวเองเป็นปลายทาง
      if (moving?.type === 'folder' && f.id === moving.id) return;
      rows.push({ f, depth }); walk(f.id, depth + 1);
    });
  };
  walk(null, 0);
  return (
    <Sheet open={!!moving} onClose={onClose} title="ย้ายไปที่">
      <div className="grid gap-1">
        <Button variant="ghost" className="justify-start" onClick={() => onPick(null)}><FolderIcon className="h-4 w-4" />เอกสาร (หน้าแรก)</Button>
        {rows.map(({ f, depth }) => (
          <Button key={f.id} variant="ghost" className="justify-start" style={{ paddingLeft: 16 + depth * 20 }} onClick={() => onPick(f.id)}>
            <FolderIcon className="h-4 w-4 text-primary" />{f.name}
          </Button>
        ))}
      </div>
    </Sheet>
  );
}
