'use client';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Archive, Camera, Database, Download, FileText, Folder as FolderIcon, Moon, RotateCcw, ScanLine, ScanText, Search as SearchIcon,
  ShieldCheck, Sun, Trash2, Upload, Laptop, FileDown
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createBackup, restoreBackup } from '@/lib/backup';
import { useCloudStatus } from '@/lib/cloud';
import { db, getSetting, setSetting } from '@/lib/db';
import { downloadBlob, formatBytes } from '@/lib/image';
import { TRASH_DAYS, deleteForever, emptyTrash, restoreDocument, storageStats } from '@/lib/repo';
import type { DocRecord } from '@/lib/types';
import StorageSettings from './StorageSettings';
import { Button, Spinner, friendlyError, inputCls, useBlobUrl, useUi } from './ui';

// ---------- ค้นหา ----------
/** ค้นทั้งชื่อเอกสาร ชื่อโฟลเดอร์ และข้อความจาก OCR — ผลขึ้นทันทีที่พิมพ์ */
export function SearchPage({ onOpenDoc, onOpenFolder }: { onOpenDoc: (id: string) => void; onOpenFolder: (id: string) => void }) {
  const [q, setQ] = useState('');
  const docs = useLiveQuery(() => db.documents.filter((d) => !d.deletedAt).toArray(), []) || [];
  const folders = useLiveQuery(() => db.folders.toArray(), []) || [];
  const needle = q.trim().toLowerCase();
  const res = useMemo(() => {
    if (!needle) return { docs: [] as { d: DocRecord; snippet: string; where: string }[], folders: [] as typeof folders };
    const out: { d: DocRecord; snippet: string; where: string }[] = [];
    for (const d of docs) {
      if (d.name.toLowerCase().includes(needle)) { out.push({ d, snippet: '', where: 'ชื่อเอกสาร' }); continue; }
      const i = d.ocrText.toLowerCase().indexOf(needle);
      if (i >= 0) out.push({ d, where: 'ข้อความในเอกสาร', snippet: d.ocrText.slice(Math.max(0, i - 40), i + needle.length + 60).replace(/\s+/g, ' ') });
    }
    return { docs: out, folders: folders.filter((f) => f.name.toLowerCase().includes(needle)) };
  }, [needle, docs, folders]);

  const mark = (s: string) => {
    const i = s.toLowerCase().indexOf(needle);
    if (i < 0) return s;
    return <>{s.slice(0, i)}<mark className="rounded bg-yellow-200 px-0.5 dark:bg-yellow-600/60">{s.slice(i, i + needle.length)}</mark>{s.slice(i + needle.length)}</>;
  };

  return (
    <div className="mx-auto max-w-3xl px-4 pb-28 pt-[calc(1rem+env(safe-area-inset-top))]">
      <h1 className="mb-3 text-2xl font-bold">ค้นหา</h1>
      <div className="relative">
        <SearchIcon className="absolute left-3 top-3.5 h-4 w-4 text-muted" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="ชื่อเอกสาร โฟลเดอร์ หรือข้อความในเอกสาร" className={`${inputCls} pl-9`} />
      </div>
      <p className="mt-2 text-xs text-muted">ค้นข้อความในเอกสารได้หลังกด OCR ในเอกสารนั้นแล้ว</p>
      <div className="mt-4 grid gap-2">
        {res.folders.map((f) => (
          <button key={f.id} onClick={() => onOpenFolder(f.id)} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left">
            <FolderIcon className="h-5 w-5 text-primary" /><span>{mark(f.name)}</span>
          </button>
        ))}
        {res.docs.map(({ d, snippet, where }) => (
          <button key={d.id} onClick={() => onOpenDoc(d.id)} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3 text-left">
            <Thumb blob={d.thumbnail} />
            <div className="min-w-0">
              <p className="font-medium">{mark(d.name)}</p>
              <p className="text-xs text-muted">{where} • {d.pageCount} หน้า</p>
              {snippet && <p className="mt-1 line-clamp-2 text-sm text-muted">…{mark(snippet)}…</p>}
            </div>
          </button>
        ))}
        {needle && !res.docs.length && !res.folders.length && <p className="py-8 text-center text-muted">ไม่พบ "{q}"</p>}
      </div>
    </div>
  );
}
function Thumb({ blob }: { blob: Blob | null }) {
  const url = useBlobUrl(blob);
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="" className="h-14 w-11 shrink-0 rounded border border-line object-cover" /> : <FileText className="h-10 w-10 shrink-0 text-muted" />;
}

// ---------- ถังขยะ ----------
export function TrashPage({ onBack }: { onBack: () => void }) {
  const ui = useUi();
  const docs = useLiveQuery(() => db.documents.where('deletedAt').above(0).reverse().sortBy('deletedAt'), []) || [];
  const daysLeft = (t: number) => Math.max(0, TRASH_DAYS - Math.floor((Date.now() - t) / 86400_000));
  return (
    <div className="mx-auto max-w-3xl px-4 pb-28 pt-[calc(1rem+env(safe-area-inset-top))]">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-2xl font-bold">ถังขยะ</h1>
        <Button variant="ghost" onClick={onBack}>กลับ</Button>
      </div>
      <p className="mb-3 text-sm text-muted">เอกสารที่ลบจะอยู่ที่นี่ {TRASH_DAYS} วัน แล้วถูกลบถาวรอัตโนมัติ</p>
      {docs.length > 0 && (
        <Button variant="danger" className="mb-3" onClick={async () => {
          if (await ui.confirm('ล้างถังขยะ?', `ลบถาวร ${docs.length} เอกสาร กู้คืนไม่ได้`, { ok: 'ลบถาวรทั้งหมด', danger: true })) ui.toast(`ลบถาวรแล้ว ${await emptyTrash()} เอกสาร`);
        }}><Trash2 className="h-4 w-4" />ล้างถังขยะ</Button>
      )}
      <div className="grid gap-2">
        {docs.map((d) => (
          <div key={d.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3">
            <Thumb blob={d.thumbnail} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{d.name}</p>
              <p className="text-xs text-muted">{d.pageCount} หน้า • ลบถาวรในอีก {daysLeft(d.deletedAt)} วัน</p>
            </div>
            <Button onClick={() => restoreDocument(d.id).then(() => ui.toast('กู้คืนแล้ว'))}><RotateCcw className="h-4 w-4" />กู้คืน</Button>
            <Button variant="ghost" className="text-red-600" onClick={async () => {
              if (await ui.confirm(`ลบ "${d.name}" ถาวร?`, 'กู้คืนไม่ได้', { ok: 'ลบถาวร', danger: true })) await deleteForever(d.id);
            }}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
        {!docs.length && <p className="py-10 text-center text-muted">ถังขยะว่าง</p>}
      </div>
    </div>
  );
}

// ---------- ตั้งค่า ----------
export type Theme = 'system' | 'light' | 'dark';
export function SettingsPage({ theme, setTheme, onTrash }: { theme: Theme; setTheme: (t: Theme) => void; onTrash: () => void }) {
  const ui = useUi();
  const cloud = useCloudStatus();
  const [stats, setStats] = useState<Awaited<ReturnType<typeof storageStats>> | null>(null);
  const [busy, setBusy] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const reload = () => storageStats().then(setStats);
  // ซิงก์เสร็จ (รูปใหญ่ถูกลบออกจากเครื่อง) = พื้นที่ที่ใช้เปลี่ยน
  useEffect(() => { reload(); }, [cloud.lastSync]);
  const [scanAuto, setScanAuto] = useState(true), [scanConfirm, setScanConfirm] = useState(false);
  useEffect(() => {
    getSetting<boolean>('scanAuto', true).then(setScanAuto);
    getSetting<boolean>('scanConfirm', false).then(setScanConfirm);
  }, []);

  const clearOcr = async () => {
    if (!await ui.confirm('ลบข้อความ OCR ทั้งหมด?', 'รูปเอกสารไม่ถูกลบ แต่จะค้นหาข้อความในเอกสารไม่ได้จนกว่าจะกด OCR ใหม่', { ok: 'ลบข้อความ OCR', danger: true })) return;
    await db.transaction('rw', db.pages, db.documents, async () => {
      await db.pages.toCollection().modify({ ocrText: '' });
      await db.documents.toCollection().modify({ ocrText: '' });
    });
    ui.toast('ลบข้อความ OCR แล้ว');
  };
  const clearCache = async () => {
    // แคชของ service worker (ไฟล์แอป / ไฟล์ภาษา OCR) — ไม่แตะเอกสารใน IndexedDB
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    ui.toast(`ล้างแคชแล้ว (${keys.length} ชุด) — เอกสารยังอยู่ครบ`);
    reload();
  };
  const backup = async () => {
    setBusy('backup');
    try {
      const b = await createBackup();
      downloadBlob(b, `DocScan-backup-${new Date().toISOString().slice(0, 10)}.docscan`);
    } catch (e) { ui.toast(friendlyError(e), 'error'); }
    finally { setBusy(''); }
  };
  const restore = async (f: File) => {
    setBusy('restore');
    try { const r = await restoreBackup(f); ui.toast(`นำเข้าแล้ว ${r.documents} เอกสาร ${r.pages} หน้า`); reload(); }
    catch (e) { ui.toast(friendlyError(e), 'error'); }
    finally { setBusy(''); }
  };

  const Row = ({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) => (
    <section className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <h2 className="mb-3 flex items-center gap-2 font-semibold">{icon}{title}</h2>{children}
    </section>
  );

  return (
    <div className="mx-auto grid max-w-3xl gap-3 px-4 pb-28 pt-[calc(1rem+env(safe-area-inset-top))]">
      <h1 className="text-2xl font-bold">ตั้งค่า</h1>
      <div className="flex items-center gap-2 rounded-2xl bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
        <ShieldCheck className="h-5 w-5 shrink-0" />
        {cloud.mode === 'cloud' || cloud.session
          ? 'เอกสารที่ให้ระบบเก็บอยู่บนระบบ ERP SHIPME เห็นได้เฉพาะบัญชีของคุณ — เอกสารที่เก็บในเครื่องไม่ถูกอัปโหลด ยกเว้นตอนกดส่งเข้าใบปิดบัญชีเอง'
          : 'เอกสารของคุณอยู่ในเครื่องนี้ — ไม่มีการอัปโหลดขึ้นเซิร์ฟเวอร์ ยกเว้นตอนคุณกดส่งเข้าใบปิดบัญชีเอง'}
      </div>
      <StorageSettings />
      <Row icon={<Camera className="h-5 w-5 text-primary" />} title="การสแกน">
        <div className="grid gap-3">
          <Toggle label="ถ่ายอัตโนมัติเมื่อเจอเอกสาร" hint="จับขอบได้และถือนิ่งครู่หนึ่ง = ถ่ายให้เอง แล้วรอหน้าถัดไป"
            value={scanAuto} onChange={(v) => { setScanAuto(v); setSetting('scanAuto', v); }} />
          <Toggle label="ยืนยันกรอบก่อนบันทึกทุกหน้า" hint="ปิด = ครอบตามกรอบที่จับได้แล้วบันทึกเลย (เร็วที่สุด แก้กรอบทีหลังได้ด้วยปุ่ม &quot;ครอบ&quot;)"
            value={scanConfirm} onChange={(v) => { setScanConfirm(v); setSetting('scanConfirm', v); }} />
        </div>
      </Row>
      <Row icon={<Database className="h-5 w-5 text-primary" />} title="พื้นที่เก็บในเครื่อง">
        {stats ? (
          <div className="grid grid-cols-3 gap-2 text-center">
            <div><p className="text-2xl font-bold">{stats.documents}</p><p className="text-xs text-muted">เอกสาร</p></div>
            <div><p className="text-2xl font-bold">{stats.pages}</p><p className="text-xs text-muted">หน้า</p></div>
            <div><p className="text-2xl font-bold">{formatBytes(stats.usage || stats.bytes)}</p><p className="text-xs text-muted">ใช้ไป{stats.quota ? ` จาก ${formatBytes(stats.quota)}` : ''}</p></div>
          </div>
        ) : <Spinner className="h-5 w-5" />}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={clearCache}>ล้างแคชแอป</Button>
          <Button onClick={clearOcr}><ScanText className="h-4 w-4" />ลบข้อความ OCR</Button>
          <Button onClick={onTrash}><Trash2 className="h-4 w-4" />ถังขยะ{stats?.trashed ? ` (${stats.trashed})` : ''}</Button>
        </div>
      </Row>
      <Row icon={<Archive className="h-5 w-5 text-primary" />} title="สำรองข้อมูล">
        <p className="mb-3 text-sm text-muted">ไฟล์เดียวรวมเอกสาร หน้า โฟลเดอร์ ข้อความ OCR ลายเซ็น และการตั้งค่า — เก็บไว้หรือย้ายไปเครื่องอื่นได้
          {cloud.session ? ' (เอกสารที่ให้ระบบเก็บ: แบ็กอัปเก็บเฉพาะข้อมูล รูปอยู่บนระบบอยู่แล้ว)' : ''}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy === 'backup'} onClick={backup}><Download className="h-4 w-4" />ส่งออกแบ็กอัป</Button>
          <Button loading={busy === 'restore'} onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" />นำเข้าแบ็กอัป</Button>
        </div>
        <input ref={fileRef} type="file" accept=".docscan,.zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) restore(f); }} />
      </Row>
      <Row icon={<Sun className="h-5 w-5 text-primary" />} title="การแสดงผล">
        <div className="grid grid-cols-3 gap-2">
          {([['system', 'ตามเครื่อง', <Laptop key="a" className="h-4 w-4" />], ['light', 'สว่าง', <Sun key="b" className="h-4 w-4" />], ['dark', 'มืด', <Moon key="c" className="h-4 w-4" />]] as const).map(([v, l, icon]) => (
            <Button key={v} variant={theme === v ? 'primary' : 'secondary'} onClick={() => setTheme(v)}>{icon}{l}</Button>
          ))}
        </div>
      </Row>
      <Row icon={<FileDown className="h-5 w-5 text-primary" />} title="เกี่ยวกับ">
        <p className="text-sm text-muted">DocScan by ERP SHIPME • หาขอบเอกสารและประมวลผลภาพ (OpenCV) และอ่านข้อความ (Tesseract) ในเครื่อง • ติดตั้งเป็นแอปได้จากเมนูเบราว์เซอร์ ("เพิ่มไปยังหน้าจอโฮม")</p>
      </Row>
    </div>
  );
}

/** สวิตช์เปิด/ปิด (ปุ่มใหญ่ กดง่ายบนมือถือ) */
function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={value} onClick={() => onChange(!value)} className="flex min-h-11 items-center gap-3 text-left">
      <span className="flex-1">
        <span className="block font-medium">{label}</span>
        {hint && <span className="block text-sm text-muted">{hint}</span>}
      </span>
      <span className={`relative h-7 w-12 shrink-0 rounded-full transition ${value ? 'bg-primary' : 'bg-surface-3'}`}>
        <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${value ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  );
}

// ---------- แนะนำการใช้ครั้งแรก ----------
export function Onboarding({ onDone }: { onDone: () => void }) {
  const items = [
    { icon: <Camera className="h-6 w-6" />, t: 'สแกนเอกสารด้วยกล้องมือถือ' },
    { icon: <ScanLine className="h-6 w-6" />, t: 'หาขอบเอกสารและปรับให้แบนอัตโนมัติ' },
    { icon: <ScanText className="h-6 w-6" />, t: 'อ่านข้อความภาษาไทยและอังกฤษ' },
    { icon: <FileDown className="h-6 w-6" />, t: 'ส่งออกเป็น PDF ได้ทันที' },
    { icon: <ShieldCheck className="h-6 w-6" />, t: 'เอกสารอยู่ในเครื่องคุณ เป็นส่วนตัว' }
  ];
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg px-6 pb-[env(safe-area-inset-bottom)]">
      <div className="w-full max-w-sm">
        <div className="mb-6 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-black/5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo.webp" alt="ERP SHIPME" width={640} height={270} className="mx-auto h-auto w-56" />
        </div>
        <h1 className="text-3xl font-bold text-navy">DocScan</h1>
        <p className="mt-1 text-muted">สแกนเอกสารให้ชัดเหมือนเครื่องสแกน</p>
        <ul className="mt-8 grid gap-4">
          {items.map((x, i) => (
            <li key={i} className="flex items-center gap-3"><span className="text-primary">{x.icon}</span><span>{x.t}</span></li>
          ))}
        </ul>
        <Button variant="primary" className="mt-10 w-full py-3 text-base" onClick={onDone}>เริ่มสแกน</Button>
        <p className="mt-3 text-center text-xs text-muted">ไม่ต้องสมัครสมาชิก</p>
      </div>
    </div>
  );
}

export async function onboardingSeen() { return getSetting<boolean>('onboarded', false); }
export async function markOnboarded() { await setSetting('onboarded', true); }
