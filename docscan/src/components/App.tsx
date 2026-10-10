'use client';
import { Camera, FileText, FileUp, Search, Settings as SettingsIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { pinDoc, startCloud } from '@/lib/cloud';
import { warmUp } from '@/lib/cv';
import { db, getSetting, setSetting } from '@/lib/db';
import { warmDetector } from '@/lib/detect';
import { loadTicket, thaiDate, type ErpTicket } from '@/lib/erp';
import { canvasToBlob, ctx2d, validateImageFile } from '@/lib/image';
import { pdfToImages } from '@/lib/pdf';
import { blankCanvas, buildPageImages } from '@/lib/process';
import { addPage, createDocument, purgeExpiredTrash } from '@/lib/repo';
import CaptureFlow from './CaptureFlow';
import DocumentView from './DocumentView';
import Library from './Library';
import { Onboarding, SearchPage, SettingsPage, TrashPage, markOnboarded, onboardingSeen, type Theme } from './Pages';
import Scanner from './Scanner';
import { Spinner, UiProvider, friendlyError, useUi } from './ui';

type Route = { name: 'library'; folder: string | null } | { name: 'doc'; id: string } | { name: 'search' } | { name: 'settings' } | { name: 'trash' };

function parse(hash: string): Route {
  const [, a, b] = hash.replace(/^#/, '').split('/');
  if (a === 'doc' && b) return { name: 'doc', id: b };
  if (a === 'f' && b) return { name: 'library', folder: b };
  if (a === 'search') return { name: 'search' };
  if (a === 'settings') return { name: 'settings' };
  if (a === 'trash') return { name: 'trash' };
  return { name: 'library', folder: null };
}
const go = (path: string) => { location.hash = path; };
// "05-10-2569 16.05" — / กับ : ใช้ในชื่อไฟล์ไม่ได้ (safeName จะแทนเป็นช่องว่าง) จึงใช้ - กับ . แทน
const stamp = () => new Date().toLocaleString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  .replace(/\//g, '-').replace(/:/g, '.').replace(',', '');

export default function App() {
  return <UiProvider><Shell /></UiProvider>;
}

function Shell() {
  const ui = useUi();
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  const [onboard, setOnboard] = useState<boolean | null>(null);
  const [theme, setThemeState] = useState<Theme>('system');
  const [ticket, setTicket] = useState<ErpTicket | null>(null);
  const [scan, setScan] = useState<{ docId: string | null } | null>(null);
  const [importQ, setImportQ] = useState<{ docId: string; items: Blob[]; confirm: boolean } | null>(null);
  const [pdfBusy, setPdfBusy] = useState('');
  const imgInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const importTarget = useRef<string | null>(null);

  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  // เริ่มแอป: ธีม, onboarding, ticket จาก ERP, ล้างถังขยะที่หมดอายุ, service worker
  useEffect(() => {
    getSetting<Theme>('theme', 'system').then(setThemeState);
    // เปิดจากหน้าปิดบัญชี (มี ticket) = ข้ามหน้าแนะนำ — รอทั้งสองอย่างก่อนตัดสินใจ กันลำดับสลับกัน
    const ticketP = loadTicket().catch((e) => { ui.toast(friendlyError(e), 'error'); return null; });
    Promise.all([onboardingSeen(), ticketP]).then(([seen, t]) => { setTicket(t); setOnboard(!seen && !t); });
    purgeExpiredTrash().catch(() => undefined);
    // โหมดให้ระบบเก็บ: อัปที่ค้าง / ลบรูปใหญ่ที่อัปแล้วออกจากเครื่อง (ไม่มีเอกสารบนระบบ = ไม่ทำอะไร)
    startCloud();
    // เตรียมตัวหาขอบ (เล็ก) ทันที และโหลด OpenCV (ใช้ตอนบันทึกหน้า) ระหว่างผู้ใช้ยังดูหน้าแรก
    warmDetector();
    const t = setTimeout(() => { warmUp(); }, 1200);
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
    if (process.env.NODE_ENV === 'development') seedDemo().catch(() => undefined);
    navigator.storage?.persist?.().catch(() => undefined);
    return () => clearTimeout(t);
  }, [ui]);

  // ธีม: ตามเครื่อง / สว่าง / มืด
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.setAttribute('data-theme', theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  const setTheme = (t: Theme) => { setThemeState(t); setSetting('theme', t); };

  const currentFolder = route.name === 'library' ? route.folder : null;
  const newDocName = useCallback(() => (ticket ? `ตรวจปล่อย ${thaiDate(ticket.inspectDate).replace(/\//g, '-')}` : `สแกน ${stamp()}`), [ticket]);

  const startScan = (docId: string | null = null) => setScan({ docId });
  const startImport = (kind: 'image' | 'pdf', docId: string | null = null) => {
    importTarget.current = docId;
    (kind === 'image' ? imgInput : pdfInput).current?.click();
  };

  const onImages = async (files: FileList | null) => {
    const ok: Blob[] = [];
    for (const f of Array.from(files || [])) {
      try { validateImageFile(f); ok.push(f); } catch (e) { ui.toast(friendlyError(e), 'error'); }
    }
    if (!ok.length) return;
    const docId = importTarget.current || (await createDocument(ticket ? newDocName() : `นำเข้า ${stamp()}`, currentFolder)).id;
    setImportQ({ docId, items: ok, confirm: await getSetting<boolean>('scanConfirm', false) });
  };

  const onPdf = async (file: File | undefined) => {
    if (!file) return;
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { ui.toast('ไฟล์นี้ไม่ใช่ PDF', 'error'); return; }
    let unpin = () => {};
    try {
      setPdfBusy('กำลังอ่าน PDF…');
      const images = await pdfToImages(file, (d, t) => setPdfBusy(`กำลังแปลงหน้า ${d}/${t}…`));
      const docId = importTarget.current || (await createDocument(file.name.replace(/\.pdf$/i, ''), currentFolder)).id;
      unpin = pinDoc(docId);
      for (let i = 0; i < images.length; i++) {
        setPdfBusy(`กำลังบันทึกหน้า ${i + 1}/${images.length}…`);
        await addPage(docId, await buildPageImages(images[i], null, 'original'));
      }
      go(`/doc/${docId}`);
    } catch (e) { ui.toast(friendlyError(e), 'error'); }
    finally { setPdfBusy(''); unpin(); }
  };

  if (onboard === null) return <div className="flex min-h-dvh items-center justify-center"><Spinner className="h-6 w-6 text-primary" /></div>;
  if (onboard) return <Onboarding onDone={() => { markOnboarded(); setOnboard(false); }} />;

  const inputs = (
    <>
      <input ref={imgInput} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => { onImages(e.target.files); e.target.value = ''; }} />
      <input ref={pdfInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { onPdf(e.target.files?.[0]); e.target.value = ''; }} />
    </>
  );

  if (scan) {
    return (
      <Scanner
        getDocumentId={async () => scan.docId || (await createDocument(newDocName(), currentFolder)).id}
        onClose={() => setScan(null)}
        onDone={(id) => { setScan(null); if (id) go(`/doc/${id}`); }}
      />
    );
  }
  if (importQ) {
    return <CaptureFlow documentId={importQ.docId} items={importQ.items} confirm={importQ.confirm}
      onDone={() => { const id = importQ.docId; setImportQ(null); go(`/doc/${id}`); }}
      onCancel={() => { const id = importQ.docId; setImportQ(null); go(`/doc/${id}`); }} />;
  }

  return (
    <>
      {inputs}
      {pdfBusy && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/60 text-white">
          <Spinner className="h-8 w-8" /><p>{pdfBusy}</p>
        </div>
      )}
      {route.name === 'doc' ? (
        <DocumentView docId={route.id} ticket={ticket}
          onBack={() => history.length > 1 ? history.back() : go('/')}
          onScanMore={() => startScan(route.id)}
          onImport={(k) => startImport(k, route.id)}
          onTicketUsed={() => setTicket(null)} />
      ) : (
        <>
          {route.name === 'library' && (
            <Library folderId={route.folder} ticket={ticket}
              onOpenFolder={(id) => go(id ? `/f/${id}` : '/')}
              onOpenDoc={(id) => go(`/doc/${id}`)}
              onScan={() => startScan()}
              onImport={(k) => startImport(k)}
              onSearch={() => go('/search')} />
          )}
          {route.name === 'search' && <SearchPage onOpenDoc={(id) => go(`/doc/${id}`)} onOpenFolder={(id) => go(`/f/${id}`)} />}
          {route.name === 'settings' && <SettingsPage theme={theme} setTheme={setTheme} onTrash={() => go('/trash')} />}
          {route.name === 'trash' && <TrashPage onBack={() => go('/settings')} />}
          <BottomNav route={route} onScan={() => startScan()} onImport={() => startImport('image')} />
        </>
      )}
    </>
  );
}

/** แถบเมนูล่าง — ปุ่มสแกนเด่นตรงกลาง เว้นพื้นที่ safe-area ของ iPhone */
function BottomNav({ route, onScan, onImport }: { route: Route; onScan: () => void; onImport: () => void }) {
  const item = (active: boolean, icon: React.ReactNode, label: string, on: () => void) => (
    <button onClick={on} className={`flex flex-col items-center justify-center gap-0.5 text-[11px] ${active ? 'text-primary' : 'text-muted'}`}>{icon}{label}</button>
  );
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <div className="mx-auto grid h-16 max-w-lg grid-cols-5">
        {item(route.name === 'library', <FileText className="h-5 w-5" />, 'เอกสาร', () => go('/'))}
        {item(false, <FileUp className="h-5 w-5" />, 'นำเข้า', onImport)}
        <div className="flex items-start justify-center">
          <button aria-label="สแกน" onClick={onScan}
            className="-mt-5 flex h-16 w-16 flex-col items-center justify-center rounded-full bg-primary text-white shadow-lg ring-4 ring-bg transition active:scale-95">
            <Camera className="h-7 w-7" />
          </button>
        </div>
        {item(route.name === 'search', <Search className="h-5 w-5" />, 'ค้นหา', () => go('/search'))}
        {item(route.name === 'settings' || route.name === 'trash', <SettingsIcon className="h-5 w-5" />, 'ตั้งค่า', () => go('/settings'))}
      </div>
    </nav>
  );
}

/** ข้อมูลตัวอย่าง — เฉพาะตอนพัฒนา (npm run dev) ไม่ขึ้นใน production */
async function seedDemo() {
  if (await getSetting('demoSeeded', false)) return;
  if (await db.documents.count()) { await setSetting('demoSeeded', true); return; }
  for (const name of ['Invoice October', 'Receipt', 'Meeting Notes', 'Shipping Documents']) {
    const doc = await createDocument(name);
    const c = blankCanvas(900, 1270);
    const ctx = ctx2d(c);
    ctx.fillStyle = '#111827'; ctx.font = 'bold 56px sans-serif'; ctx.fillText(name, 70, 140);
    ctx.font = '28px sans-serif';
    for (let i = 0; i < 14; i++) ctx.fillText(`Sample line ${i + 1} — DocScan demo data`, 70, 240 + i * 60);
    await addPage(doc.id, await buildPageImages(await canvasToBlob(c), null, 'original'));
  }
  await setSetting('demoSeeded', true);
}
