import { useSyncExternalStore } from 'react';
import { db, getPages, getSetting, setSetting, uid } from './db';
import { post } from './erp';
import type { BlobKind, DocRecord, Folder, PageRecord, StorageMode } from './types';

/**
 * โหมด "ให้ระบบเก็บ" — สำหรับมือถือที่พื้นที่เต็ม
 *
 * เอกสารที่ storage = 'cloud': ภาพทุกหน้าถูกอัปขึ้นระบบ ERP (Supabase Storage ใต้ docscan/<ผู้ใช้>/) เบื้องหลัง
 * อัปครบแล้วค่อยอัป doc.json (ข้อมูลเอกสาร) แล้วลบรูปใหญ่ (ต้นฉบับ / ครอบ / ภาพสุดท้าย) ออกจากเครื่อง เหลือภาพย่อ + ข้อมูล
 * เปิดเอกสาร = ดึงภาพสุดท้ายกลับมาชั่วคราว (ภาพต้นฉบับ/ครอบดึงตอนกดครอบ/ฟิลเตอร์) ปิดแล้วลบออกอีกรอบหลังซิงก์
 *
 * กติกา: ภาพในเครื่องเป็น Blob ว่าง (size 0) ได้เฉพาะเมื่อมีไฟล์บนระบบ (page.cloud[kind]) อยู่แล้ว
 *        ภาพเปลี่ยน = ลบ page.cloud[kind] ทิ้ง + เพิ่ม rev (repo.updatePage) → รอบซิงก์ถัดไปอัปเป็นไฟล์ชื่อใหม่
 * กุญแจที่เก็บเอกสารได้จากการใส่รหัส ERP ครั้งเดียว (อายุ 180 วัน) ใช้ได้เฉพาะเอกสารของตัวเอง ไม่ใช่ล็อกอิน ERP
 */

export const FIELD = { o: 'originalImage', c: 'croppedImage', p: 'processedImage', t: 'thumbnail' } as const satisfies Record<BlobKind, keyof PageRecord>;
export const KINDS: BlobKind[] = ['o', 'c', 'p', 't'];
/** ภาพที่ลบออกจากเครื่องได้ — ภาพย่อเก็บไว้เสมอ (เล็ก และใช้แสดงรายการ) */
const HEAVY: BlobKind[] = ['o', 'c', 'p'];

export const emptyBlob = () => new Blob([], { type: 'image/jpeg' });
export const hasBlob = (b: Blob | null | undefined): b is Blob => !!b && b.size > 0;
const blobOf = (p: PageRecord, k: BlobKind): Blob => p[FIELD[k]];
const complete = (p: PageRecord) => KINDS.every((k) => p.cloud?.[k]);

// ---------- สถานะ (ให้หน้าจอแสดง) ----------
export interface CloudSession { token: string; name: string; username: string; expiresAt: string }
export interface CloudStatus {
  session: CloudSession | null;
  mode: StorageMode;
  syncing: boolean;
  /** หน้าที่ยังอัปขึ้นระบบไม่ครบ */
  pending: number;
  error: string;
  /** กุญแจหมดอายุ/ยังไม่เข้าสู่ระบบ แต่มีเอกสารที่ต้องใช้ระบบ */
  needLogin: boolean;
  lastSync: number;
}
let status: CloudStatus = { session: null, mode: 'local', syncing: false, pending: 0, error: '', needLogin: false, lastSync: 0 };
const subs = new Set<() => void>();
function setStatus(patch: Partial<CloudStatus>) {
  status = { ...status, ...patch };
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useCloudStatus = () => useSyncExternalStore(subscribe, () => status, () => status);

// ---------- กุญแจที่เก็บเอกสาร ----------
const SESSION_KEY = 'docscan.cloud';
const OWNER = 'cloudOwner';
const REMOVALS = 'cloudRemovals';
const FOLDERS_SIG = 'cloudFoldersSig';
/** ค่าตั้งของตัวซิงก์ — ไม่ใส่ในไฟล์แบ็กอัป */
export const CLOUD_SETTINGS = [OWNER, REMOVALS, FOLDERS_SIG];

export function getSession(): CloudSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') as CloudSession | null;
    return s && new Date(s.expiresAt).getTime() > Date.now() ? s : null;
  } catch { return null; }
}
function saveSession(s: CloudSession | null) {
  try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); } catch { /* โหมดส่วนตัว */ }
  setStatus({ session: s, needLogin: false, error: '' });
}

export const getMode = () => getSetting<StorageMode>('storageMode', 'local');
export async function setMode(mode: StorageMode) {
  await setSetting('storageMode', mode);
  setStatus({ mode });
  requestSync(0);
}

const ERR: Record<string, string> = {
  cloud_login_required: 'ต้องเข้าสู่ระบบที่เก็บเอกสารก่อน (ตั้งค่า → ที่เก็บเอกสาร)',
  cloud_expired: 'การเข้าสู่ระบบที่เก็บเอกสารหมดอายุหรือเปลี่ยนรหัสผ่านแล้ว — เข้าสู่ระบบใหม่ที่ ตั้งค่า → ที่เก็บเอกสาร',
  account_disabled: 'บัญชีนี้ถูกปิดใช้งาน — ติดต่อผู้ดูแลระบบ',
  missing_credentials: 'กรอกชื่อผู้ใช้และรหัสผ่านของ ERP',
  invalid_credentials: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  storage_failed: 'ระบบเก็บไฟล์ขัดข้อง ลองใหม่อีกครั้ง'
};
const AUTH_ERRORS = ['cloud_login_required', 'cloud_expired', 'account_disabled'];
const offline = () => (typeof navigator !== 'undefined' && navigator.onLine === false
  ? 'ไม่มีอินเทอร์เน็ต — เอกสารที่ให้ระบบเก็บต้องต่ออินเทอร์เน็ตตอนเปิด'
  : 'เชื่อมต่อระบบไม่ได้ ลองใหม่อีกครั้ง');

async function call<T>(action: string, body: Record<string, unknown> = {}, token = getSession()?.token || ''): Promise<T> {
  if (!token && action !== 'scanCloudLogin') { setStatus({ needLogin: true }); throw new Error(ERR.cloud_login_required); }
  let r: T & { ok: boolean; error?: string };
  try { r = await post<T>({ action, cloudToken: token, ...body }); } catch { throw new Error(offline()); }
  if (!r.ok) {
    if (AUTH_ERRORS.includes(r.error || '')) setStatus({ needLogin: true });
    throw new Error(ERR[r.error || ''] || `ระบบเก็บเอกสารขัดข้อง (${r.error || 'ไม่ทราบสาเหตุ'})`);
  }
  return r;
}

/** ใส่รหัส ERP ครั้งเดียว — เครื่องจำกุญแจไว้ 180 วัน (ไม่จำรหัสผ่าน) */
export async function cloudLogin(username: string, password: string) {
  const r = await call<{ name: string; username: string; expiresAt: string; cloudToken: string }>('scanCloudLogin', { username, password }, '');
  // เอกสารที่ฝากไว้ในเครื่องนี้อยู่ในโฟลเดอร์ของบัญชีเดิม — บัญชีอื่นเปิดไม่ได้
  const owner = await getSetting<string>(OWNER, '');
  if (owner && owner.toLowerCase() !== r.username.toLowerCase() && await db.documents.filter((d) => d.storage === 'cloud').count()) {
    throw new Error(`เครื่องนี้มีเอกสารที่ฝากระบบไว้ด้วยบัญชี "${owner}" — เข้าสู่ระบบด้วยบัญชีเดิม หรือดึงเอกสารกลับมาเก็บในเครื่องก่อน`);
  }
  await setSetting(OWNER, r.username);
  const s: CloudSession = { token: r.cloudToken, name: r.name, username: r.username, expiresAt: r.expiresAt };
  saveSession(s);
  requestSync(0);
  return s;
}
export function cloudLogout() { saveSession(null); }

// ---------- รับส่งไฟล์ ----------
async function put(url: string, body: Blob, type: string) {
  let res: Response;
  try { res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': type }, body }); } catch { throw new Error(offline()); }
  if (!res.ok) throw new Error('อัปโหลดขึ้นระบบไม่สำเร็จ ลองใหม่อีกครั้ง');
}
async function download(url: string) {
  let res: Response;
  try { res = await fetch(url); } catch { throw new Error(offline()); }
  if (!res.ok) throw new Error('ดึงไฟล์จากระบบไม่สำเร็จ ลองใหม่อีกครั้ง');
  return new Blob([await res.blob()], { type: 'image/jpeg' });
}
async function signUploads(files: string[]) {
  const r = await call<{ uploads: { file: string; url: string }[] }>('scanCloudSign', { files });
  return new Map(r.uploads.map((u) => [u.file, u.url]));
}
async function signDownloads(files: string[]) {
  const r = await call<{ urls: { file: string; url: string }[] }>('scanCloudGet', { files });
  return new Map(r.urls.map((u) => [u.file, u.url]));
}
const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}
const fileName = (docId: string) => `${docId}/${uid().replace(/-/g, '')}.jpg`;

async function digest(s: string) {
  try {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(h).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return `f${s.length}-${(h >>> 0).toString(16)}`;
  }
}

// ---------- เอกสารที่เปิดอยู่ (ห้ามลบรูปออกจากเครื่อง) ----------
const pinned = new Map<string, number>();
/** เปิดเอกสาร/กำลังสแกนอยู่ — คืนฟังก์ชันปล่อย (ปล่อยแล้วรอบซิงก์ถัดไปค่อยลบรูปใหญ่ออก) */
export function pinDoc(id: string) {
  pinned.set(id, (pinned.get(id) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (pinned.get(id) || 1) - 1;
    if (n > 0) pinned.set(id, n); else pinned.delete(id);
    requestSync();
  };
}
/** งานดึงภาพกลับ / ลบภาพออกของเอกสารเดียวกันต้องทำทีละงาน */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(id) || Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => undefined);
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return next;
}

/**
 * ดึงภาพที่อยู่บนระบบกลับมาเก็บในเครื่อง — pageIds = เฉพาะบางหน้า
 * เอกสารที่ไม่ได้เปิดอยู่จะถูกลบภาพใหญ่ออกอีกรอบเมื่อซิงก์
 */
export function hydrate(docId: string, kinds: BlobKind[], opts: { pageIds?: string[]; onProgress?: (done: number, total: number) => void } = {}) {
  return withLock(docId, async () => {
    const need = (await getPages(docId))
      .filter((p) => !opts.pageIds || opts.pageIds.includes(p.id))
      .flatMap((p) => kinds.filter((k) => !hasBlob(blobOf(p, k)) && p.cloud?.[k]).map((k) => ({ id: p.id, k, f: p.cloud![k]!.f })));
    if (!need.length) return 0;
    let done = 0;
    opts.onProgress?.(0, need.length);
    for (const part of chunks(need, 40)) {
      const urls = await signDownloads(part.map((x) => x.f));
      await pool(part, 4, async (x) => {
        const url = urls.get(x.f);
        if (!url) throw new Error('ไม่พบไฟล์ของเอกสารนี้บนระบบ');
        const blob = await download(url);
        await db.transaction('rw', db.pages, async () => {
          const cur = await db.pages.get(x.id);
          if (cur && cur.cloud?.[x.k]?.f === x.f && !hasBlob(blobOf(cur, x.k))) {
            const patch: Partial<PageRecord> = {};
            patch[FIELD[x.k]] = blob;
            await db.pages.update(x.id, patch);
          }
        });
        done++;
        opts.onProgress?.(done, need.length);
      });
    }
    return need.length;
  });
}

/** ภาพของหน้าที่พร้อมใช้ — อยู่บนระบบก็ดึงมาให้ก่อน */
export async function pageBlob(page: PageRecord, k: BlobKind): Promise<Blob> {
  if (hasBlob(blobOf(page, k))) return blobOf(page, k);
  let cur = await db.pages.get(page.id);
  if (cur && !hasBlob(blobOf(cur, k))) {
    await hydrate(cur.documentId, [k], { pageIds: [cur.id] });
    cur = await db.pages.get(page.id);
  }
  if (!cur || !hasBlob(blobOf(cur, k))) throw new Error('ภาพของหน้านี้ไม่อยู่ในเครื่องและไม่พบบนระบบ');
  return blobOf(cur, k);
}

/** ลบรูปใหญ่ที่อยู่บนระบบแล้วออกจากเครื่อง (ข้ามเอกสารที่เปิดอยู่) */
function evict(docId: string) {
  return withLock(docId, async () => {
    for (const p of await getPages(docId)) {
      if (pinned.has(docId)) return;
      if (!HEAVY.some((k) => p.cloud?.[k] && hasBlob(blobOf(p, k)))) continue;
      await db.transaction('rw', db.pages, async () => {
        const cur = await db.pages.get(p.id);
        if (!cur || pinned.has(docId)) return;
        const patch: Partial<PageRecord> = {};
        for (const k of HEAVY) if (cur.cloud?.[k] && hasBlob(blobOf(cur, k))) patch[FIELD[k]] = emptyBlob();
        await db.pages.update(cur.id, patch);
      });
    }
  });
}

// ---------- ซิงก์ ----------
/** doc.json — ข้อมูลที่ต้องใช้สร้างเอกสารกลับคืนบนเครื่องใหม่ (ไม่มีรูป) */
function manifest(d: DocRecord, pages: PageRecord[]) {
  return {
    v: 1,
    doc: {
      id: d.id, name: d.name, folderId: d.folderId, createdAt: d.createdAt, updatedAt: d.updatedAt, ocrText: d.ocrText,
      pageCount: d.pageCount, size: d.size, tags: d.tags, deletedAt: d.deletedAt
    },
    pages: pages.map((p) => ({
      id: p.id, order: p.order, cloud: p.cloud, cropCoordinates: p.cropCoordinates, rotation: p.rotation, flip: p.flip,
      filter: p.filter, adjustments: p.adjustments, markup: p.markup, ocrText: p.ocrText, width: p.width, height: p.height
    }))
  };
}
type Manifest = ReturnType<typeof manifest>;

/** ชื่อไฟล์ในโฟลเดอร์เอกสารนี้ที่ยังมีหน้าอ้างถึง (รวมเอกสารที่ทำสำเนามา ซึ่งอ้างไฟล์ชุดเดียวกัน) */
async function refsIn(docId: string) {
  const out = new Set<string>();
  await db.pages.each((p) => {
    for (const k of KINDS) {
      const f = p.cloud?.[k]?.f;
      if (f?.startsWith(`${docId}/`)) out.add(f.slice(docId.length + 1));
    }
  });
  return [...out];
}

async function syncDoc(docId: string) {
  if ((await db.documents.get(docId))?.storage !== 'cloud') return;
  // 1) อัปภาพที่ยังไม่มีบนระบบ (ชื่อไฟล์ใหม่ทุกครั้ง ไม่ทับของเดิม)
  const jobs = (await getPages(docId)).flatMap((p) => KINDS.filter((k) => !p.cloud?.[k] && hasBlob(blobOf(p, k)))
    .map((k) => ({ id: p.id, rev: p.rev ?? 0, k, blob: blobOf(p, k), f: fileName(docId) })));
  for (const part of chunks(jobs, 30)) {
    const urls = await signUploads(part.map((j) => j.f));
    await pool(part, 3, async (j) => {
      await put(urls.get(j.f)!, j.blob, 'image/jpeg');
      await db.transaction('rw', db.pages, async () => {
        const cur = await db.pages.get(j.id);
        // ถูกแก้ระหว่างอัป = ไฟล์นี้เป็นภาพเก่าแล้ว ไม่จด (ถูกลบทิ้งตอน prune)
        if (cur && (cur.rev ?? 0) === j.rev && !cur.cloud?.[j.k]) await db.pages.update(j.id, { cloud: { ...cur.cloud, [j.k]: { f: j.f, n: j.blob.size } } });
      });
    });
  }
  // 2) ครบทุกหน้าแล้วค่อยอัป doc.json แล้วลบไฟล์เก่าที่ไม่ใช้แล้วบนระบบ
  const doc = await db.documents.get(docId);
  const pages = await getPages(docId);
  if (!doc || doc.storage !== 'cloud' || !pages.every(complete)) return;
  const json = JSON.stringify(manifest(doc, pages));
  const sig = await digest(json);
  if (sig !== doc.cloudSig) {
    const f = `${docId}/doc.json`;
    await put((await signUploads([f])).get(f)!, new Blob([json], { type: 'application/json' }), 'application/json');
    await call('scanCloudPrune', { docId, keep: [...(await refsIn(docId)), 'doc.json'] });
    await db.documents.update(docId, { cloudSig: sig });
  }
  // 3) ไม่ได้เปิดอยู่ = ลบรูปใหญ่ออกจากเครื่อง
  await evict(docId);
}

async function syncFolders() {
  const folders = (await db.folders.toArray()).sort((a, b) => a.id.localeCompare(b.id));
  const json = JSON.stringify(folders);
  const sig = await digest(json);
  if (sig === await getSetting<string>(FOLDERS_SIG, '')) return;
  const f = '_meta/folders.json';
  await put((await signUploads([f])).get(f)!, new Blob([json], { type: 'application/json' }), 'application/json');
  await setSetting(FOLDERS_SIG, sig);
}

/** ลบเอกสารที่ลบถาวร/ย้ายกลับเครื่องแล้ว ออกจากระบบ (ทำตอนออนไลน์) */
export async function queueRemoval(docIds: string[]) {
  const list = await getSetting<string[]>(REMOVALS, []);
  const add = docIds.filter((id) => !list.includes(id));
  if (add.length) await setSetting(REMOVALS, [...list, ...add]);
  requestSync();
}

/**
 * หน้าเหล่านี้กำลังเลิกใช้ไฟล์บนระบบ (ลบหน้า / ลบเอกสาร / แก้ภาพ / ย้ายกลับเครื่อง)
 * → คิวตรวจโฟลเดอร์ที่ไฟล์อยู่ (สำเนาเอกสารอ้างไฟล์ในโฟลเดอร์ของต้นฉบับได้) + docIds ที่ระบุ
 */
export async function forgetFiles(files: (string | undefined)[], docIds: string[] = []) {
  const ids = new Set(docIds);
  for (const f of files) if (f) ids.add(f.split('/')[0]);
  if (ids.size) await queueRemoval([...ids]);
}
export const filesOf = (pages: PageRecord[]) => pages.flatMap((p) => KINDS.map((k) => p.cloud?.[k]?.f));

/** ลบไฟล์ในโฟลเดอร์ที่ไม่มีหน้าไหนในเครื่องอ้างถึงแล้ว (เอกสารยังให้ระบบเก็บอยู่ = เก็บ doc.json ไว้) */
async function processRemovals() {
  for (const id of await getSetting<string[]>(REMOVALS, [])) {
    const keep = await refsIn(id);
    if ((await db.documents.get(id))?.storage === 'cloud') keep.push('doc.json');
    await call('scanCloudPrune', { docId: id, keep });
    await setSetting(REMOVALS, (await getSetting<string[]>(REMOVALS, [])).filter((x) => x !== id));
  }
}

async function countPending() {
  const ids = (await db.documents.filter((d) => d.storage === 'cloud').primaryKeys()) as string[];
  if (!ids.length) return 0;
  return db.pages.where('documentId').anyOf(ids).filter((p) => !complete(p)).count();
}

let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | null = null;
let again = false;
let failures = 0;

/** ขอให้ซิงก์ (รวบหลายการแก้ไขติด ๆ กันเป็นรอบเดียว) */
export function requestSync(delay = 1500) {
  if (typeof window === 'undefined') return;
  clearTimeout(timer);
  timer = setTimeout(() => { void syncNow(); }, delay);
}

export function syncNow(): Promise<void> {
  if (running) { again = true; return running; }
  running = (async () => {
    do { again = false; await syncOnce(); } while (again);
  })().finally(() => { running = null; });
  return running;
}

async function syncOnce() {
  const ids = (await db.documents.filter((d) => d.storage === 'cloud').primaryKeys()) as string[];
  const removals = await getSetting<string[]>(REMOVALS, []);
  setStatus({ pending: await countPending() });
  if (!ids.length && !removals.length) { setStatus({ error: '' }); return; }
  if (!getSession()) { setStatus({ needLogin: true }); return; }
  if (navigator.onLine === false) { setStatus({ error: offline() }); return; }
  setStatus({ syncing: true, error: '' });
  try {
    await processRemovals();
    for (const id of ids) {
      await syncDoc(id);
      setStatus({ pending: await countPending() });
    }
    if (ids.length) await syncFolders();
    failures = 0;
    setStatus({ lastSync: Date.now(), error: '' });
  } catch (e) {
    failures++;
    setStatus({ error: e instanceof Error ? e.message : String(e) });
    // ลองใหม่เอง: 30 วิ → 1 นาที → … สูงสุด 5 นาที (ยังไม่หยุดถ้าเน็ตกลับมา — มี event online อีกทาง)
    requestSync(Math.min(300_000, 15_000 * 2 ** failures));
  } finally {
    setStatus({ syncing: false, pending: await countPending() });
  }
}

let started = false;
/** เรียกครั้งเดียวตอนเปิดแอป */
export function startCloud() {
  if (started || typeof window === 'undefined') return;
  started = true;
  setStatus({ session: getSession() });
  getMode().then((mode) => setStatus({ mode })).catch(() => undefined);
  window.addEventListener('online', () => requestSync(0));
  // ปิด/สลับแอป: รีบอัปที่ค้างไว้
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') requestSync(0); });
  requestSync(800);
}

// ---------- ย้ายเอกสาร / ดึงกลับ ----------
/** ย้ายขึ้นระบบ — อัปเบื้องหลัง อัปครบแล้วรูปใหญ่จะถูกลบออกจากเครื่องเอง */
export async function moveToCloud(ids: string[]) {
  if (!getSession()) throw new Error(ERR.cloud_login_required);
  await db.transaction('rw', db.documents, async () => {
    for (const id of ids) await db.documents.update(id, { storage: 'cloud' });
  });
  requestSync(0);
}

/** ดึงทุกภาพกลับมาเก็บในเครื่อง แล้วลบออกจากระบบ */
export async function moveToLocal(docId: string, onProgress?: (done: number, total: number) => void) {
  const unpin = pinDoc(docId);
  try {
    await hydrate(docId, KINDS, { onProgress });
    const pages = await getPages(docId);
    if (!pages.every((p) => KINDS.every((k) => hasBlob(blobOf(p, k))))) throw new Error('ดึงภาพจากระบบไม่ครบ ลองใหม่อีกครั้ง');
    await db.transaction('rw', db.documents, db.pages, async () => {
      await db.documents.update(docId, { storage: 'local', cloudSig: undefined });
      for (const p of pages) await db.pages.update(p.id, { cloud: {} });
    });
    await forgetFiles(filesOf(pages), [docId]);
  } finally { unpin(); }
}

/**
 * ดึงรายการเอกสารที่ฝากระบบไว้กลับมาเครื่องนี้ (เครื่องใหม่ / ล้างข้อมูลเบราว์เซอร์ไป)
 * ดึงแค่ข้อมูล + ภาพปก — ภาพเต็มดึงตอนเปิดเอกสาร • เอกสารที่มีในเครื่องอยู่แล้วไม่แตะ
 */
export async function pullFromCloud(onProgress?: (done: number, total: number) => void) {
  const r = await call<{ docs: string[]; folders: Folder[] }>('scanCloudList');
  const haveFolders = new Set(await db.folders.toCollection().primaryKeys());
  const folders = (r.folders || []).filter((f) => f && typeof f.id === 'string' && !haveFolders.has(f.id));
  if (folders.length) await db.folders.bulkPut(folders);

  const have = new Set(await db.documents.toCollection().primaryKeys());
  const removing = new Set(await getSetting<string[]>(REMOVALS, []));
  const missing = r.docs.filter((id) => !have.has(id) && !removing.has(id));
  let done = 0;
  onProgress?.(0, missing.length);
  const covers: { docId: string; pageId: string; f: string }[] = [];
  for (const part of chunks(missing, 20)) {
    const { manifests } = await call<{ manifests: Manifest[] }>('scanCloudManifests', { ids: part });
    for (const m of manifests) {
      if (!m?.doc?.id || !Array.isArray(m.pages) || have.has(m.doc.id)) continue;
      const pages = m.pages.map((p) => ({
        ...p, documentId: m.doc.id, rev: 0,
        originalImage: emptyBlob(), croppedImage: emptyBlob(), processedImage: emptyBlob(), thumbnail: emptyBlob()
      }) as PageRecord).sort((a, b) => a.order - b.order);
      if (!pages.every(complete)) continue;
      const doc: DocRecord = { ...m.doc, thumbnail: null, storage: 'cloud' };
      doc.cloudSig = await digest(JSON.stringify(manifest(doc, pages)));
      await db.transaction('rw', db.documents, db.pages, async () => {
        await db.documents.add(doc);
        await db.pages.bulkPut(pages);
      });
      if (pages[0]) covers.push({ docId: doc.id, pageId: pages[0].id, f: pages[0].cloud!.t!.f });
      done++;
      onProgress?.(done, missing.length);
    }
  }
  // ภาพปกของเอกสารที่เพิ่งดึงมา (ภาพย่อหน้าแรก)
  for (const part of chunks(covers, 40)) {
    const urls = await signDownloads(part.map((c) => c.f));
    await pool(part, 4, async (c) => {
      const url = urls.get(c.f);
      if (!url) return;
      const blob = await download(url);
      await db.pages.update(c.pageId, { thumbnail: blob });
      await db.documents.update(c.docId, { thumbnail: blob });
    });
  }
  return { added: done, total: r.docs.length };
}

/** ตัวเลขสำหรับหน้าตั้งค่า */
export async function cloudStats() {
  const docs = await db.documents.filter((d) => !d.deletedAt).toArray();
  const cloud = docs.filter((d) => d.storage === 'cloud');
  return {
    cloudDocs: cloud.length,
    cloudBytes: cloud.reduce((s, d) => s + d.size, 0),
    localDocs: docs.length - cloud.length,
    localBytes: docs.filter((d) => d.storage !== 'cloud').reduce((s, d) => s + d.size, 0)
  };
}
