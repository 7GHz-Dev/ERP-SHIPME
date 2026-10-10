import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { env } from './env';
import { secret } from './inspection';
import { supabaseAdmin } from './supabase';
import type { ApiBody, ApiResult } from './types';
import { passwordMatches } from './utils';

/**
 * ที่เก็บเอกสารของ DocScan บนระบบ (โหมด "ให้ระบบเก็บ") — สำหรับมือถือที่พื้นที่เต็ม
 *
 * ไฟล์อยู่ใน Supabase Storage ใต้ docscan/<ผู้ใช้>/ — ไม่มีตารางในฐานข้อมูล
 *   <รหัสเอกสาร>/<ชื่อสุ่ม>.jpg   รูปของแต่ละหน้า (แก้หน้า = ชื่อใหม่ทุกครั้ง จึงไม่ติดแคช CDN)
 *   <รหัสเอกสาร>/doc.json        ข้อมูลเอกสาร + ลำดับหน้า (ใช้ดึงกลับมาเครื่องใหม่)
 *   _meta/folders.json            โฟลเดอร์ในแอป
 *
 * DocScan ใส่รหัส ERP ครั้งเดียวแล้วได้ "กุญแจที่เก็บเอกสาร" (ลงลายเซ็น HMAC อายุ 180 วัน)
 * ใช้ได้เฉพาะไฟล์ใต้ docscan/<ผู้ใช้คนนั้น>/ — ไม่ใช่ token ล็อกอิน ERP เปิดดูข้อมูลอื่นไม่ได้
 * เปลี่ยนรหัสผ่าน / ปิดบัญชี = กุญแจเดิมใช้ไม่ได้ทันที
 */
const ROOT = 'docscan';
const META = '_meta';
const TOKEN_DAYS = 180;
const URL_SECONDS = 3600;
const MAX_FILES = 60;        // ไฟล์ต่อหนึ่งคำขอ
const MAX_MANIFESTS = 20;    // doc.json ต่อหนึ่งคำขอ (ข้อความ OCR ทำให้ไฟล์ใหญ่ได้ — body ของ Vercel จำกัด 4.5MB)

const bucket = () => supabaseAdmin.storage.from(env.bucket);
const hmac = (s: string) => crypto.createHmac('sha256', secret()).update('docscan-cloud:' + s).digest('base64url');
/** ลายนิ้วมือของรหัสผ่านปัจจุบัน — เปลี่ยนรหัสแล้วกุญแจเก่าไม่ตรง */
const pwPrint = (passwordHash: string) => hmac('pw:' + passwordHash).slice(0, 16);

type Token = { u: string; exp: number; pv: string };

function makeToken(t: Token) {
  const payload = Buffer.from(JSON.stringify(t), 'utf8').toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

/** โฟลเดอร์ของผู้ใช้ — username ที่เป็นอักษรอังกฤษใช้ตรง ๆ นอกนั้นแปลงเป็น hash (คีย์ของ Storage รับแค่ ASCII) */
function userDir(username: string) {
  const u = username.toLowerCase();
  return `${ROOT}/${/^[a-z0-9._-]{1,60}$/.test(u) ? u : 'u_' + crypto.createHash('sha256').update(u).digest('hex').slice(0, 24)}`;
}

type Who = { ok: true; username: string; name: string; dir: string } | { ok: false; error: string };

async function auth(body: ApiBody): Promise<Who> {
  const [payload, sig] = String(body.cloudToken || '').split('.');
  if (!payload || !sig) return { ok: false, error: 'cloud_login_required' };
  const expect = hmac(payload);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return { ok: false, error: 'cloud_login_required' };
  let t: Token;
  try { t = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { ok: false, error: 'cloud_login_required' }; }
  if (!t.u || Date.now() > t.exp) return { ok: false, error: 'cloud_expired' };
  const [u] = await db.select({ username: users.username, name: users.name, active: users.active, passwordHash: users.passwordHash })
    .from(users).where(eq(users.username, t.u)).limit(1);
  if (!u || !u.active) return { ok: false, error: 'account_disabled' };
  if (pwPrint(u.passwordHash) !== t.pv) return { ok: false, error: 'cloud_expired' };
  return { ok: true, username: u.username, name: u.name, dir: userDir(u.username) };
}

/** ชื่อไฟล์ที่ DocScan ขอ: <รหัสเอกสาร>/<ชื่อ>.jpg|png|json หรือ _meta/folders.json */
const FILE_RE = /^(?:[A-Za-z0-9_-]{6,64}|_meta)\/[A-Za-z0-9_-]{1,80}\.(?:jpg|png|json)$/;
const DOC_RE = /^[A-Za-z0-9_-]{6,64}$/;

function fileList(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_FILES) return null;
  const files = raw.map(String);
  return files.every((f) => FILE_RE.test(f)) ? files : null;
}

/** ทำทีละไม่กี่งานพร้อมกัน — ไม่ยิง Supabase รัว ๆ ทีเดียว 60 คำขอ */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** รายการทั้งหมดในโฟลเดอร์ (list ของ Supabase คืนครั้งละไม่เกิน 1000) */
async function listAll(prefix: string) {
  const rows: { name: string; id: string | null }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await bucket().list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`storage_list_failed: ${error.message}`);
    rows.push(...(data || []).map((r) => ({ name: r.name, id: r.id ?? null })));
    if (!data || data.length < 1000) return rows;
  }
}

async function downloadJson(path: string): Promise<unknown> {
  const { data, error } = await bucket().download(path);
  if (error || !data) return null;
  try { return JSON.parse(await data.text()); } catch { return null; }
}

/** ใส่รหัส ERP ครั้งเดียว → กุญแจที่เก็บเอกสาร (ไม่สร้าง session ของ ERP) */
export async function scanCloudLogin(body: ApiBody): Promise<ApiResult> {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return { ok: false, error: 'missing_credentials' };
  const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!u || !passwordMatches(password, u.passwordHash)) return { ok: false, error: 'invalid_credentials' };
  if (!u.active) return { ok: false, error: 'account_disabled' };
  const exp = Date.now() + TOKEN_DAYS * 86400_000;
  return {
    ok: true, name: u.name, username: u.username, expiresAt: new Date(exp).toISOString(),
    cloudToken: makeToken({ u: u.username, exp, pv: pwPrint(u.passwordHash) })
  };
}

/** กุญแจยังใช้ได้ไหม (เปิดหน้าตั้งค่า) */
export async function scanCloudInfo(body: ApiBody): Promise<ApiResult> {
  const who = await auth(body);
  if (!who.ok) return who;
  return { ok: true, name: who.name, username: who.username };
}

/** ลิงก์อัปโหลดตรงขึ้น Storage ทีละหลายไฟล์ (รูปไม่ผ่าน Vercel ซึ่งจำกัดขนาด body) */
export async function scanCloudSign(body: ApiBody): Promise<ApiResult> {
  const who = await auth(body);
  if (!who.ok) return who;
  const files = fileList(body.files);
  if (!files) return { ok: false, error: 'bad_request' };
  const uploads = await pool(files, 8, async (file) => {
    const { data, error } = await bucket().createSignedUploadUrl(`${who.dir}/${file}`, { upsert: true });
    if (error || !data) throw new Error(`signed_upload_failed: ${error?.message || 'unknown'}`);
    return { file, url: data.signedUrl };
  });
  return { ok: true, uploads };
}

/** ลิงก์ดาวน์โหลดชั่วคราว (1 ชั่วโมง) — เปิดเอกสารที่ฝากไว้ */
export async function scanCloudGet(body: ApiBody): Promise<ApiResult> {
  const who = await auth(body);
  if (!who.ok) return who;
  const files = fileList(body.files);
  if (!files) return { ok: false, error: 'bad_request' };
  const { data, error } = await bucket().createSignedUrls(files.map((f) => `${who.dir}/${f}`), URL_SECONDS);
  if (error || !data) return { ok: false, error: 'storage_failed' };
  const byPath = new Map(data.map((d) => [d.path, d.error ? '' : d.signedUrl]));
  return { ok: true, urls: files.map((file) => ({ file, url: byPath.get(`${who.dir}/${file}`) || '' })) };
}

/** เอกสารทั้งหมดที่ฝากไว้ (รหัสเอกสาร) + โฟลเดอร์ — ใช้ดึงกลับมาเครื่องใหม่ / หลังล้างข้อมูลเบราว์เซอร์ */
export async function scanCloudList(body: ApiBody): Promise<ApiResult> {
  const who = await auth(body);
  if (!who.ok) return who;
  const rows = await listAll(who.dir);
  const docs = rows.filter((r) => r.id === null && r.name !== META && DOC_RE.test(r.name)).map((r) => r.name);
  const folders = await downloadJson(`${who.dir}/${META}/folders.json`);
  return { ok: true, docs, folders: Array.isArray(folders) ? folders : [] };
}

/** doc.json ของเอกสารที่ขอ (ครั้งละไม่เกิน 20) — อ่านฝั่งเซิร์ฟเวอร์ ไม่ผ่านแคช CDN */
export async function scanCloudManifests(body: ApiBody): Promise<ApiResult> {
  const who = await auth(body);
  if (!who.ok) return who;
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  if (!ids.length || ids.length > MAX_MANIFESTS || !ids.every((x) => DOC_RE.test(x))) return { ok: false, error: 'bad_request' };
  const all = await pool(ids, 6, (x) => downloadJson(`${who.dir}/${x}/doc.json`));
  return { ok: true, manifests: all.filter(Boolean) };
}

/**
 * ลบไฟล์ในโฟลเดอร์เอกสารที่ไม่ได้ใช้แล้ว — keep = ชื่อไฟล์ที่ยังใช้อยู่ (รวม doc.json ถ้ายังเก็บเอกสารไว้)
 * keep ว่าง = ลบเอกสารนี้ออกจากระบบทั้งหมด
 */
export async function scanCloudPrune(body: ApiBody): Promise<ApiResult> {
  const who = await auth(body);
  if (!who.ok) return who;
  const docId = String(body.docId || '');
  if (!DOC_RE.test(docId)) return { ok: false, error: 'bad_request' };
  const keep = new Set(Array.isArray(body.keep) ? body.keep.map(String) : []);
  const drop = (await listAll(`${who.dir}/${docId}`))
    .filter((r) => r.id !== null && !keep.has(r.name)).map((r) => `${who.dir}/${docId}/${r.name}`);
  for (let i = 0; i < drop.length; i += 100) {
    const { error } = await bucket().remove(drop.slice(i, i + 100));
    if (error) return { ok: false, error: 'storage_failed' };
  }
  return { ok: true, removed: drop.length };
}
