import { useSyncExternalStore } from 'react';
import { db, getPages, getSetting, setSetting, uid } from './db';
import { post } from './erp';
import type { BlobKind, CloudRefs, DocRecord, Folder, PageRecord, StorageMode } from './types';

/**
 * โหมด "ให้ระบบเก็บ" — สำหรับมือถือที่พื้นที่เต็ม
 *
 * เอกสารที่ storage = 'cloud': ภาพทุกหน้าถูกอัปขึ้นระบบ ERP (Supabase Storage ใต้ docscan/<ผู้ใช้>/) เบื้องหลัง
 * อัปครบแล้วค่อยอัป doc.json (ข้อมูลเอกสาร) แล้วลบรูปใหญ่ (ต้นฉบับ / ครอบ / ภาพสุดท้าย) ออกจากเครื่อง เหลือภาพย่อ + ข้อมูล
 * เปิดเอกสาร = ดึงภาพสุดท้ายกลับมาชั่วคราว (ภาพต้นฉบับ/ครอบดึงตอนกดครอบ/ฟิลเตอร์) ปิดแล้วลบออกอีกรอบหลังซิงก์
 *
 * กติกา: ภาพในเครื่องเป็น null (หรือ Blob ว่างจากเวอร์ชันแรก) ได้เฉพาะเมื่อมีไฟล์บนระบบในตาราง cloudRefs แล้ว
 *        ภาพเปลี่ยน = ลบไฟล์นั้นออกจาก cloudRefs + เพิ่ม page.rev (repo.updatePage) → รอบซิงก์ถัดไปอัปเป็นไฟล์ชื่อใหม่
 *
 * เครื่องเต็ม: Safari คัดลอกทุกรูปในแถวทุกครั้งที่เขียนแถว จึงห้ามเขียนแถวหน้าที่มีรูปใหญ่โดยไม่จำเป็น
 *   - จดไฟล์บนระบบลงตาราง cloudRefs (ไม่มีรูป) • ลบรูปออก = ตั้งเป็น null (แถวเหลือแค่ภาพย่อ)
 *   - ดึงภาพลงเครื่องไม่ได้ (เต็ม) = เก็บไว้ในหน่วยความจำระหว่างเปิดเอกสารแทน (mem)
 *   - เพิ่มหน้าใหม่ไม่ได้ (เต็ม) = อัปขึ้นระบบเลย เก็บในเครื่องแค่ข้อมูล (storeRemotely)
 * กุญแจที่เก็บเอกสารได้จากการใส่รหัส ERP ครั้งเดียว (อายุ 180 วัน) ใช้ได้เฉพาะเอกสารของตัวเอง ไม่ใช่ล็อกอิน ERP
 */

export const FIELD = { o: 'originalImage', c: 'croppedImage', p: 'processedImage', t: 'thumbnail' } as const satisfies Record<BlobKind, keyof PageRecord>;
export const KINDS: BlobKind[] = ['o', 'c', 'p', 't'];
/** ภาพที่ลบออกจากเครื่องได้ — ภาพย่อเก็บไว้เสมอ (เล็ก และใช้แสดงรายการ) */
const HEAVY: BlobKind[] = ['o', 'c', 'p'];

export const hasBlob = (b: Blob | null | undefined): b is Blob => !!b && b.size > 0;
const stored = (p: PageRecord, k: BlobKind) => p[FIELD[k]];
const full = (r: CloudRefs | undefined) => KINDS.every((k) => r?.[k]);

/** พื้นที่ในเครื่องเต็ม (Chrome: QuotaExceeded • Safari: เขียน Blob ไม่ได้) */
export const isStorageFull = (e: unknown) =>
  /QuotaExceeded|quota|preparing Blob/i.test(`${(e as Error)?.name} ${(e as Error)?.message ?? e}`);
const FULL_MSG = 'พื้นที่ในเครื่องเต็ม — เอกสารที่ให้ระบบเก็บจะลบรูปออกจากเครื่องเมื่ออัปเสร็จ';

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
  /** เพิ่มเมื่อภาพในหน่วยความจำเปลี่ยน (ให้หน้าเอกสารวาดใหม่) */
  memVersion: number;
}
let status: CloudStatus = { session: null, mode: 'local', syncing: false, pending: 0, error: '', needLogin: false, lastSync: 0, memVersion: 0 };
const subs = new Set<() => void>();
function setStatus(patch: Partial<CloudStatus>) {
  status = { ...status, ...patch };
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useCloudStatus = () => useSyncExternalStore(subscribe, () => status, () => status);

// ---------- ภาพในหน่วยความจำ (เครื่องเต็ม เก็บลง IndexedDB ไม่ได้) ----------
const mem = new Map<string, Blob>();
const memKey = (pageId: string, k: BlobKind) => `${pageId}:${k}`;
function memSet(pageId: string, k: BlobKind, b: Blob) { mem.set(memKey(pageId, k), b); setStatus({ memVersion: status.memVersion + 1 }); }
function memDropPages(ids: string[]) {
  let n = 0;
  for (const id of ids) for (const k of KINDS) if (mem.delete(memKey(id, k))) n++;
  if (n) setStatus({ memVersion: status.memVersion + 1 });
}
/** ภาพที่ใช้ได้ทันที — ในเครื่องก่อน ไม่มีค่อยดูในหน่วยความจำ */
export function localBlob(p: PageRecord, k: BlobKind): Blob | null {
  const b = stored(p, k);
  return hasBlob(b) ? b : mem.get(memKey(p.id, k)) ?? null;
}
/** หน้าเอกสารพร้อมภาพจากหน่วยความจำ (ใช้กับหน้าที่เปิดอยู่) — useCloudStatus().memVersion บอกว่าต้องเรียกใหม่ */
export const withMemory = (pages: PageRecord[]) => pages.map((p) =>
  KINDS.some((k) => !hasBlob(stored(p, k)) && mem.has(memKey(p.id, k)))
    ? { ...p, originalImage: localBlob(p, 'o'), croppedImage: localBlob(p, 'c'), processedImage: localBlob(p, 'p'), thumbnail: localBlob(p, 't') }
    : p);

// ---------- ไฟล์บนระบบของแต่ละหน้า (ตาราง cloudRefs) ----------
export async function refsOf(pageIds: string[]) {
  const rows = await db.cloudRefs.bulkGet(pageIds);
  return new Map(pageIds.map((id, i) => [id, rows[i]?.refs ?? {}] as const));
}
async function docRefs(docId: string) {
  return new Map((await db.cloudRefs.where('docId').equals(docId).toArray()).map((r) => [r.pageId, r.refs] as const));
}
/** ไฟล์บนระบบที่หน้าเหล่านี้อ้างถึง */
export async function filesOf(pageIds: string[]) {
  return [...(await refsOf(pageIds)).values()].flatMap((r) => KINDS.map((k) => r[k]?.f));
}

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
  // อ่านเป็นข้อมูลในหน่วยความจำ — Blob จาก fetch บางเบราว์เซอร์อ้างไฟล์ชั่วคราว เก็บลง IndexedDB แล้วพังได้
  return new Blob([await res.arrayBuffer()], { type: 'image/jpeg' });
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
 * ดึงภาพที่อยู่บนระบบกลับมา — pageIds = เฉพาะบางหน้า
 * เก็บลงเครื่องก่อน เครื่องเต็มเก็บไม่ได้ = ถือไว้ในหน่วยความจำ (ใช้ได้จนปิดเอกสาร)
 * เอกสารที่ไม่ได้เปิดอยู่จะถูกลบภาพใหญ่ออกอีกรอบเมื่อซิงก์
 */
export function hydrate(docId: string, kinds: BlobKind[], opts: { pageIds?: string[]; onProgress?: (done: number, total: number) => void } = {}) {
  return withLock(docId, async () => {
    const pages = (await getPages(docId)).filter((p) => !opts.pageIds || opts.pageIds.includes(p.id));
    const refs = await refsOf(pages.map((p) => p.id));
    const need = pages.flatMap((p) => kinds.filter((k) => !localBlob(p, k) && refs.get(p.id)?.[k])
      .map((k) => ({ id: p.id, k, f: refs.get(p.id)![k]!.f })));
    if (!need.length) return 0;
    let done = 0;
    let full = false;   // เขียนลงเครื่องไม่ได้แล้วรอบนี้ = ไม่ต้องลองซ้ำทุกภาพ
    opts.onProgress?.(0, need.length);
    for (const part of chunks(need, 40)) {
      const urls = await signDownloads(part.map((x) => x.f));
      await pool(part, 4, async (x) => {
        const url = urls.get(x.f);
        if (!url) throw new Error('ไม่พบไฟล์ของเอกสารนี้บนระบบ');
        const blob = await download(url);
        if (!full) {
          try {
            await db.transaction('rw', db.pages, db.cloudRefs, async () => {
              const [cur, ref] = await Promise.all([db.pages.get(x.id), db.cloudRefs.get(x.id)]);
              if (!cur || ref?.refs[x.k]?.f !== x.f || hasBlob(stored(cur, x.k))) return;
              const patch: Partial<PageRecord> = {};
              patch[FIELD[x.k]] = blob;
              await db.pages.update(x.id, patch);
            });
          } catch (e) {
            if (!isStorageFull(e)) throw e;
            full = true;
          }
        }
        if (full) memSet(x.id, x.k, blob);
        done++;
        opts.onProgress?.(done, need.length);
      });
    }
    return need.length;
  });
}

/** ภาพของหน้าที่พร้อมใช้ — อยู่บนระบบก็ดึงมาให้ก่อน */
export async function pageBlob(page: PageRecord, k: BlobKind): Promise<Blob> {
  const now = localBlob(page, k);
  if (now) return now;
  let cur = await db.pages.get(page.id);
  if (cur && !localBlob(cur, k)) {
    await hydrate(cur.documentId, [k], { pageIds: [cur.id] });
    cur = await db.pages.get(page.id);
  }
  const b = cur && localBlob(cur, k);
  if (!b) throw new Error('ภาพของหน้านี้ไม่อยู่ในเครื่องและไม่พบบนระบบ');
  return b;
}

/** ลบรูปใหญ่ที่อยู่บนระบบแล้วออกจากเครื่อง (ข้ามเอกสารที่เปิดอยู่) — แถวที่เขียนกลับเหลือแค่ภาพย่อ */
function evict(docId: string) {
  return withLock(docId, async () => {
    if (pinned.has(docId)) return;
    const pages = await getPages(docId);
    memDropPages(pages.map((p) => p.id));
    const refs = await docRefs(docId);
    for (const p of pages) {
      if (pinned.has(docId)) return;
      const r = refs.get(p.id);
      // null = ไม่มีรูป (Blob ว่างจากเวอร์ชันแรกก็เปลี่ยนเป็น null — Safari เก็บ Blob ว่างไม่ได้บางรุ่น)
      const drop = HEAVY.filter((k) => r?.[k] && stored(p, k) !== null);
      if (!drop.length) continue;
      const patch: Partial<PageRecord> = {};
      for (const k of drop) patch[FIELD[k]] = null;
      await db.transaction('rw', db.pages, db.cloudRefs, async () => {
        const cur = await db.pages.get(p.id);
        const ref = await db.cloudRefs.get(p.id);
        // ถูกแก้ระหว่างนี้ (ไฟล์บนระบบไม่ตรงภาพแล้ว) = ไม่ลบ
        if (!cur || pinned.has(docId) || drop.some((k) => !ref?.refs[k])) return;
        await db.pages.update(p.id, patch);
      });
    }
  });
}

// ---------- ซิงก์ ----------
/** doc.json — ข้อมูลที่ต้องใช้สร้างเอกสารกลับคืนบนเครื่องใหม่ (ไม่มีรูป) */
function manifest(d: DocRecord, pages: PageRecord[], refs: Map<string, CloudRefs>) {
  return {
    v: 1,
    doc: {
      id: d.id, name: d.name, folderId: d.folderId, createdAt: d.createdAt, updatedAt: d.updatedAt, ocrText: d.ocrText,
      pageCount: d.pageCount, size: d.size, tags: d.tags, deletedAt: d.deletedAt
    },
    pages: pages.map((p) => ({
      id: p.id, order: p.order, cloud: refs.get(p.id), cropCoordinates: p.cropCoordinates, rotation: p.rotation, flip: p.flip,
      filter: p.filter, adjustments: p.adjustments, markup: p.markup, ocrText: p.ocrText, width: p.width, height: p.height
    }))
  };
}
type Manifest = ReturnType<typeof manifest>;

/** ชื่อไฟล์ในโฟลเดอร์เอกสารนี้ที่ยังมีหน้าอ้างถึง (รวมเอกสารที่ทำสำเนามา ซึ่งอ้างไฟล์ชุดเดียวกัน) */
async function refsIn(docId: string) {
  const out = new Set<string>();
  await db.cloudRefs.each((r) => {
    for (const k of KINDS) {
      const f = r.refs[k]?.f;
      if (f?.startsWith(`${docId}/`)) out.add(f.slice(docId.length + 1));
    }
  });
  return [...out];
}

/** อัปภาพที่ยังไม่มีบนระบบ แล้วจดลง cloudRefs (ไม่เขียนแถวหน้า) */
async function uploadPages(docId: string, pages: PageRecord[]) {
  const refs = await refsOf(pages.map((p) => p.id));
  const jobs = pages.flatMap((p) => KINDS.filter((k) => !refs.get(p.id)?.[k] && localBlob(p, k))
    .map((k) => ({ id: p.id, rev: p.rev ?? 0, k, blob: localBlob(p, k)!, f: fileName(docId) })));
  for (const part of chunks(jobs, 30)) {
    const urls = await signUploads(part.map((j) => j.f));
    await pool(part, 3, async (j) => {
      await put(urls.get(j.f)!, j.blob, 'image/jpeg');
      await db.transaction('rw', db.pages, db.cloudRefs, async () => {
        const cur = await db.pages.get(j.id);
        const row = await db.cloudRefs.get(j.id);
        // ถูกแก้ระหว่างอัป = ไฟล์นี้เป็นภาพเก่าแล้ว ไม่จด (ถูกลบทิ้งตอน prune)
        if (!cur || (cur.rev ?? 0) !== j.rev || row?.refs[j.k]) return;
        await db.cloudRefs.put({ pageId: j.id, docId, refs: { ...row?.refs, [j.k]: { f: j.f, n: j.blob.size } } });
      });
    });
  }
}

async function syncDoc(docId: string) {
  if ((await db.documents.get(docId))?.storage !== 'cloud') return;
  // 1) อัปภาพที่ยังไม่มีบนระบบ (ชื่อไฟล์ใหม่ทุกครั้ง ไม่ทับของเดิม)
  await uploadPages(docId, await getPages(docId));
  // 2) ครบทุกหน้าแล้วค่อยอัป doc.json แล้วลบไฟล์เก่าที่ไม่ใช้แล้วบนระบบ
  const doc = await db.documents.get(docId);
  const pages = await getPages(docId);
  const refs = await refsOf(pages.map((p) => p.id));
  if (!doc || doc.storage !== 'cloud' || !pages.every((p) => full(refs.get(p.id)))) return;
  const json = JSON.stringify(manifest(doc, pages, refs));
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

/**
 * เครื่องเต็ม บันทึกหน้าใหม่ลงเครื่องไม่ได้ (เอกสารที่ให้ระบบเก็บ) — อัปขึ้นระบบเลย แล้วเก็บในเครื่องแค่ข้อมูล
 * ภาพที่ต้องใช้ระหว่างเปิดเอกสารอยู่ถือไว้ในหน่วยความจำ
 */
export async function storeRemotely(page: PageRecord) {
  if (!getSession()) throw new Error(FULL_MSG + ' (ต้องเข้าสู่ระบบที่เก็บเอกสารก่อน)');
  for (const k of KINDS) { const b = stored(page, k); if (hasBlob(b)) memSet(page.id, k, b); }
  const meta: PageRecord = { ...page, originalImage: null, croppedImage: null, processedImage: null, thumbnail: null };
  await db.pages.add(meta);
  try {
    await uploadPages(page.documentId, [meta]);
  } catch (e) {
    // อัปไม่ได้ (ไม่มีเน็ต) ภาพจะหายเมื่อปิดแอป — ถอยหน้านี้ออก ให้ผู้ใช้รู้
    await db.pages.delete(page.id);
    memDropPages([page.id]);
    throw new Error(`${FULL_MSG} และอัปขึ้นระบบไม่ได้ (${(e as Error).message})`);
  }
  // ภาพย่อเล็กมาก ลองเก็บลงเครื่อง (ใช้แสดงรายการ) — ไม่ได้ก็ไม่เป็นไร ดึงจากระบบตอนเปิด
  const t = mem.get(memKey(page.id, 't'));
  if (t) await db.pages.update(page.id, { thumbnail: t }).catch(() => undefined);
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

/** ตรวจลบไฟล์ในโฟลเดอร์เอกสารเหล่านี้บนระบบ (ทำตอนออนไลน์) */
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
  const pageIds = (await db.pages.where('documentId').anyOf(ids).primaryKeys()) as string[];
  const refs = await refsOf(pageIds);
  return pageIds.filter((id) => !full(refs.get(id))).length;
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

const message = (e: unknown) => (isStorageFull(e) ? FULL_MSG : e instanceof Error ? e.message : String(e));

async function syncOnce() {
  const ids = (await db.documents.filter((d) => d.storage === 'cloud').primaryKeys()) as string[];
  const removals = await getSetting<string[]>(REMOVALS, []);
  setStatus({ pending: await countPending() });
  if (!ids.length && !removals.length) { setStatus({ error: '' }); return; }
  if (!getSession()) { setStatus({ needLogin: true }); return; }
  if (navigator.onLine === false) { setStatus({ error: offline() }); return; }
  setStatus({ syncing: true, error: '' });
  // เอกสารหนึ่งพัง (เช่นเครื่องเต็มตอนเปิดอยู่) ไม่ให้ขวางเอกสารอื่น — ทำต่อให้ครบแล้วค่อยรายงาน
  let firstError: unknown = null;
  const attempt = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { firstError ??= e; }
  };
  await attempt(processRemovals);
  for (const id of ids) {
    await attempt(() => syncDoc(id));
    setStatus({ pending: await countPending() });
  }
  if (ids.length) await attempt(syncFolders);
  if (firstError) {
    failures++;
    setStatus({ error: message(firstError) });
    // ลองใหม่เอง: 30 วิ → 1 นาที → … สูงสุด 5 นาที (เน็ตกลับมามี event online อีกทาง)
    requestSync(Math.min(300_000, 15_000 * 2 ** failures));
  } else {
    failures = 0;
    setStatus({ lastSync: Date.now(), error: '' });
  }
  setStatus({ syncing: false, pending: await countPending() });
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
    // ต้องอยู่ในเครื่องจริง ไม่ใช่แค่ในหน่วยความจำ
    if (!pages.every((p) => KINDS.every((k) => hasBlob(stored(p, k))))) {
      throw new Error('พื้นที่ในเครื่องไม่พอสำหรับดึงเอกสารนี้กลับมา — ลบเอกสารอื่นหรือล้างถังขยะก่อน');
    }
    const files = await filesOf(pages.map((p) => p.id));
    await db.transaction('rw', db.documents, db.cloudRefs, async () => {
      await db.documents.update(docId, { storage: 'local', cloudSig: undefined });
      await db.cloudRefs.where('docId').equals(docId).delete();
    });
    memDropPages(pages.map((p) => p.id));
    await forgetFiles(files, [docId]);
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
      if (!m.pages.every((p) => full(p.cloud))) continue;
      const refs = new Map(m.pages.map((p) => [p.id, p.cloud!] as const));
      const pages = m.pages.map(({ cloud: _c, ...p }) => ({
        ...p, documentId: m.doc.id, rev: 0,
        originalImage: null, croppedImage: null, processedImage: null, thumbnail: null
      }) as PageRecord).sort((a, b) => a.order - b.order);
      const doc: DocRecord = { ...m.doc, thumbnail: null, storage: 'cloud' };
      doc.cloudSig = await digest(JSON.stringify(manifest(doc, pages, refs)));
      await db.transaction('rw', db.documents, db.pages, db.cloudRefs, async () => {
        await db.documents.add(doc);
        await db.pages.bulkPut(pages);
        await db.cloudRefs.bulkPut(pages.map((p) => ({ pageId: p.id, docId: doc.id, refs: refs.get(p.id)! })));
      });
      if (pages[0]) covers.push({ docId: doc.id, pageId: pages[0].id, f: refs.get(pages[0].id)!.t!.f });
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
