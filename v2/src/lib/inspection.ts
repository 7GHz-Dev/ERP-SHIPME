import crypto from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { inspectionFiles, users } from '@/db/schema';
import { env } from './env';
import { createSignedUpload, fileExists } from './storage';
import type { ApiBody, ApiResult } from './types';
import { id, nowIso, validYmd } from './utils';
import { supabaseAdmin } from './supabase';

/**
 * หลักฐานการตรวจปล่อยของใบปิดบัญชี — PDF ที่ถ่ายจาก DocScan หรือไฟล์ที่แนบเอง
 *
 * DocScan อยู่คนละโดเมนและไม่มีระบบล็อกอินของ ERP จึงใช้ "ticket":
 *   ข้อความ username|inspectDate|หมดอายุ|returnUrl ลงลายเซ็น HMAC ด้วยกุญแจฝั่งเซิร์ฟเวอร์
 *   ใช้ได้อย่างเดียวคือแนบไฟล์หลักฐานของพนักงานคนนั้นวันนั้น อายุ 2 ชั่วโมง
 *   ไม่ใช่ token ล็อกอิน — ต่อให้หลุดก็เอาไปดู/แก้ข้อมูลอื่นไม่ได้
 */
const TICKET_HOURS = 2;
const MAX_BYTES = 25 * 1024 * 1024;
const FOLDER = 'inspections';

const secret = () => env.scanTicketSecret || crypto.createHash('sha256').update('scan-ticket:' + (process.env.DATABASE_URL || 'dev')).digest('hex');
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const sign = (payload: string) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

type Ticket = { username: string; inspectDate: string; exp: number; returnUrl: string };

export function makeTicket(t: Ticket) {
  const payload = b64(JSON.stringify(t));
  return `${payload}.${sign(payload)}`;
}
export function readTicket(raw: unknown): { ok: true; t: Ticket } | { ok: false; error: string } {
  const [payload, sig] = String(raw || '').split('.');
  if (!payload || !sig) return { ok: false, error: 'invalid_ticket' };
  const expect = sign(payload);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return { ok: false, error: 'invalid_ticket' };
  let t: Ticket;
  try { t = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { ok: false, error: 'invalid_ticket' }; }
  if (!t.username || !validYmd(t.inspectDate)) return { ok: false, error: 'invalid_ticket' };
  if (Date.now() > t.exp) return { ok: false, error: 'ticket_expired' };
  return { ok: true, t };
}

const fileRow = (r: typeof inspectionFiles.$inferSelect) => ({
  id: r.id, username: r.username, inspectDate: r.inspectDate, fileName: r.fileName, url: r.url,
  pages: r.pages, size: r.size, source: r.source, createdAt: r.createdAt
});

/** หน้าปิดบัญชีขอ ticket แล้วเปิด DocScan ด้วยลิงก์ที่ได้ */
export async function createScanTicket(body: ApiBody, user: { username: string }): Promise<ApiResult> {
  const inspectDate = String(body.inspectDate || '');
  if (!validYmd(inspectDate)) return { ok: false, error: 'missing_inspect_date' };
  // กลับมาหน้าเดิมหลังส่งไฟล์ — รับเฉพาะ http(s) กันการฝังลิงก์แปลก ๆ
  const returnUrl = /^https?:\/\//i.test(String(body.returnUrl || '')) ? String(body.returnUrl).slice(0, 500) : '';
  const exp = Date.now() + TICKET_HOURS * 3600_000;
  const ticket = makeTicket({ username: user.username, inspectDate, exp, returnUrl });
  return { ok: true, ticket, url: `${env.docscanUrl}/?erp=${encodeURIComponent(ticket)}`, expiresAt: new Date(exp).toISOString() };
}

/** DocScan ถามว่า ticket นี้ของใคร วันไหน (แสดงบนหน้าจอให้พนักงานเห็นว่ากำลังแนบให้ใบไหน) */
export async function scanTicketInfo(body: ApiBody): Promise<ApiResult> {
  const r = readTicket(body.ticket);
  if (!r.ok) return { ok: false, error: r.error };
  const [u] = await db.select({ name: users.name, active: users.active }).from(users).where(eq(users.username, r.t.username)).limit(1);
  if (!u || !u.active) return { ok: false, error: 'invalid_ticket' };
  return { ok: true, name: u.name, inspectDate: r.t.inspectDate, returnUrl: r.t.returnUrl, expiresAt: new Date(r.t.exp).toISOString() };
}

/** ลิงก์อัปโหลดตรงขึ้น Storage (ไฟล์ไม่ผ่าน Vercel ซึ่งจำกัดขนาด body) */
async function signFor(username: string, inspectDate: string, ext: 'pdf' | 'jpg' | 'png') {
  const file = await createSignedUpload(FOLDER, `${inspectDate}_${username}_${id('IF')}`, ext);
  return { uploadUrl: file.uploadUrl, key: file.key };
}

/** key ต้องเป็นไฟล์ของพนักงาน + วันที่นี้เท่านั้น (กันเอา key ของคนอื่นมาผูก) */
function keyBelongs(key: string, username: string, inspectDate: string) {
  const m = /^inspections\/(\d{4}-\d{2}-\d{2})_(.+)_IF[A-Za-z0-9]+\.(pdf|jpg|png)$/.exec(key);
  // ชื่อไฟล์ผ่าน safeBase ของ storage (อักขระแปลกกลายเป็น _) จึงเทียบกับชื่อที่แปลงแบบเดียวกัน
  const userPart = username.replace(/[^a-z0-9ก-๙._-]/gi, '_').toLowerCase();
  return !!m && m[1] === inspectDate && m[2].toLowerCase() === userPart;
}

async function register(username: string, inspectDate: string, body: ApiBody, source: string, by: string): Promise<ApiResult> {
  const key = String(body.key || '');
  if (!keyBelongs(key, username, inspectDate)) return { ok: false, error: 'forbidden' };
  if (!(await fileExists(key))) return { ok: false, error: 'upload_missing' };
  const size = Math.max(0, Math.round(Number(body.size) || 0));
  if (size > MAX_BYTES) return { ok: false, error: 'too_large' };
  const ext = key.split('.').pop() || 'pdf';
  const fileName = String(body.name || `ตรวจปล่อย ${inspectDate}.${ext}`).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim().slice(0, 120);
  const row = {
    id: id('IF'), username, inspectDate, fileName, storageKey: key,
    url: `/files/${key.split('/').map(encodeURIComponent).join('/')}`,
    pages: Math.max(0, Math.round(Number(body.pages) || 0)), size, source,
    createdAt: nowIso(), createdBy: by
  };
  await db.insert(inspectionFiles).values(row);
  return { ok: true, file: fileRow(row as typeof inspectionFiles.$inferSelect) };
}

export async function scanUploadSign(body: ApiBody): Promise<ApiResult> {
  const r = readTicket(body.ticket);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, ...(await signFor(r.t.username, r.t.inspectDate, 'pdf')) };
}
export async function scanUploadDone(body: ApiBody): Promise<ApiResult> {
  const r = readTicket(body.ticket);
  if (!r.ok) return { ok: false, error: r.error };
  return register(r.t.username, r.t.inspectDate, body, 'docscan', r.t.username);
}

// ---------- ฝั่ง ERP (ล็อกอินแล้ว) ----------
const BOSS = ['admin', 'manager', 'manager-account', 'employee-account'];

/** แนบไฟล์เอง (PDF / รูป) จากหน้าปิดบัญชี — ทางสำรองเมื่อไม่ได้ใช้ DocScan */
export async function signInspectionUpload(body: ApiBody, user: { username: string }): Promise<ApiResult> {
  const inspectDate = String(body.inspectDate || '');
  if (!validYmd(inspectDate)) return { ok: false, error: 'missing_inspect_date' };
  const ext = body.ext === 'jpg' || body.ext === 'png' ? body.ext : 'pdf';
  return { ok: true, ...(await signFor(user.username, inspectDate, ext)) };
}
export async function registerInspectionFile(body: ApiBody, user: { username: string }): Promise<ApiResult> {
  const inspectDate = String(body.inspectDate || '');
  if (!validYmd(inspectDate)) return { ok: false, error: 'missing_inspect_date' };
  return register(user.username, inspectDate, body, 'upload', user.username);
}

export async function listInspectionFiles(body: ApiBody, user: { username: string; role: string }): Promise<ApiResult> {
  const inspectDate = String(body.inspectDate || '');
  if (!validYmd(inspectDate)) return { ok: false, error: 'missing_inspect_date' };
  // ดูของคนอื่นได้เฉพาะผู้ดูแล/ฝ่ายบัญชี
  const who = body.username && BOSS.includes(user.role) ? String(body.username) : user.username;
  const rows = await db.select().from(inspectionFiles)
    .where(and(eq(inspectionFiles.username, who), eq(inspectionFiles.inspectDate, inspectDate)));
  return { ok: true, files: rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(fileRow) };
}

export async function deleteInspectionFile(body: ApiBody, user: { username: string; role: string }): Promise<ApiResult> {
  const [row] = await db.select().from(inspectionFiles).where(eq(inspectionFiles.id, String(body.id || ''))).limit(1);
  if (!row) return { ok: false, error: 'file_not_found' };
  if (row.username.toLowerCase() !== user.username.toLowerCase() && !['admin', 'manager'].includes(user.role)) {
    return { ok: false, error: 'forbidden' };
  }
  await db.delete(inspectionFiles).where(eq(inspectionFiles.id, row.id));
  await supabaseAdmin.storage.from(env.bucket).remove([row.storageKey]).catch(() => undefined);
  return { ok: true };
}

/** จำนวนไฟล์หลักฐานของพนักงาน + วันที่ (ใช้บังคับก่อนบันทึกใบปิดบัญชีใหม่) */
export async function inspectionFileCount(username: string, inspectDate: string) {
  const rows = await db.select({ id: inspectionFiles.id }).from(inspectionFiles)
    .where(and(eq(inspectionFiles.username, username), eq(inspectionFiles.inspectDate, inspectDate)));
  return rows.length;
}

/** ไฟล์หลักฐานของหลายใบปิดบัญชีพร้อมกัน — key = username|date */
export async function inspectionFilesFor(pairs: { username: string; inspectDate: string }[]) {
  const dates = [...new Set(pairs.map((p) => p.inspectDate))];
  if (!dates.length) return new Map<string, ReturnType<typeof fileRow>[]>();
  const rows = await db.select().from(inspectionFiles).where(inArray(inspectionFiles.inspectDate, dates));
  const map = new Map<string, ReturnType<typeof fileRow>[]>();
  for (const r of rows) {
    const k = `${r.username.toLowerCase()}|${r.inspectDate}`;
    const list = map.get(k) || [];
    list.push(fileRow(r));
    map.set(k, list);
  }
  return map;
}
