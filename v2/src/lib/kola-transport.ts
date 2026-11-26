import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { transportDocs } from '@/db/schema';
import { env } from './env';
import { supabaseAdmin } from './supabase';
import { docKey, validDocInput } from './transport-docs-rules';
import { id, nowIso } from './utils';
import { runTransportImport } from './transport-records';
import { text } from './transport-clean';
import type { ApiBody, ApiResult } from './types';

/**
 * ERP-KOLA (MAY) → ตารางขนส่ง + ไฟล์ใบขน / E-Office — เมนูชั่วคราวฝั่ง KOLA ระหว่างที่ KOLA ยังส่งเองไม่ได้
 * สเปก: ERP-KOLA docs/SHIPME-TRANSPORT-REQUEST.md
 *
 * ยืนยันตัวด้วย KOLA_SYNC_TOKEN (ฝั่ง KOLA ชื่อ SHIPME_SYNC_TOKEN ค่าเดียวกัน) ไม่ใช้ session ผู้ใช้ · เว้นว่าง = ปิดรับ
 */

export function kolaDenied(body: ApiBody): ApiResult | null {
  const token = (process.env.KOLA_SYNC_TOKEN || '').trim();
  if (!token) return { ok: false, error: 'sync_not_configured' };
  const given = Buffer.from(text(body.token, 300));
  const want = Buffer.from(token);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return { ok: false, error: 'invalid_token' };
  return null;
}

/**
 * Transport Request จาก KOLA — ตรรกะเดียวกับปุ่ม "📥 รับ Transport Request" (BL + วันที่ TRANSPORT เดิม = อัปเดตแถวเดิม)
 * commit = false: ตรวจ/ดูตัวอย่าง · true: บันทึก
 */
export async function kolaTransportPush(body: ApiBody): Promise<ApiResult> {
  const no = kolaDenied(body);
  if (no) return no;
  return runTransportImport(body.rows, {
    source: text(body.source), commit: body.commit === true,
    actor: `kola:${text(body.sentBy, 60) || 'MAY'}`, importedFrom: 'kola'
  });
}

// ---------------- ไฟล์ใบขน / E-Office ----------------

const DOC_URL_SECONDS = 60 * 60;
const docDir = (key: string) => `kola-docs/${key}`;

/** ลิงก์เปิดไฟล์ชั่วคราว 1 ชม. ของหลายไฟล์ในครั้งเดียว — storageKey → url ('' = สร้างไม่ได้) */
export async function signedDocUrls(keys: string[]) {
  const out = new Map<string, string>();
  if (!keys.length) return out;
  const { data } = await supabaseAdmin.storage.from(env.bucket).createSignedUrls(keys, DOC_URL_SECONDS);
  for (const d of data || []) if (d.path) out.set(d.path, d.error ? '' : d.signedUrl);
  return out;
}

/** ขอลิงก์อัปโหลดตรง — เบราว์เซอร์ของ MAY PUT ไฟล์เข้า Storage เอง (ไฟล์สแกนใหญ่เกินเพดาน body ของ Vercel) */
export async function kolaDocUploadUrl(body: ApiBody): Promise<ApiResult> {
  const no = kolaDenied(body);
  if (no) return no;
  const bad = validDocInput(body);
  if (bad) return { ok: false, error: bad };
  const storageKey = `${docDir(docKey(body.bl))}/${text(body.kind)}-${id('D')}.pdf`;
  const { data, error } = await supabaseAdmin.storage.from(env.bucket).createSignedUploadUrl(storageKey);
  if (error || !data) return { ok: false, error: 'storage_failed', detail: error?.message || '' };
  return { ok: true, storageKey, signedUrl: data.signedUrl };
}

/** ลงทะเบียนไฟล์หลังเบราว์เซอร์อัปเสร็จ — ไฟล์เดิมของ BL + ประเภทเดียวกันเลิกเป็นไฟล์ปัจจุบัน */
export async function kolaDocRegister(body: ApiBody): Promise<ApiResult> {
  const no = kolaDenied(body);
  if (no) return no;
  const bad = validDocInput(body);
  if (bad) return { ok: false, error: bad };
  const key = docKey(body.bl);
  const storageKey = text(body.storageKey, 300);
  const dir = docDir(key);
  if (!storageKey.startsWith(`${dir}/`)) return { ok: false, error: 'bad_storage_key' };
  const name = storageKey.slice(dir.length + 1);
  const { data: found } = await supabaseAdmin.storage.from(env.bucket).list(dir, { search: name, limit: 5 });
  if (!(found || []).some((f) => f.name === name)) return { ok: false, error: 'file_missing' };
  const kind = text(body.kind);
  const row = {
    id: id('TD'), bl: text(body.bl, 120), blKey: key, kind, fileName: text(body.fileName, 200), storageKey,
    size: Math.round(Number(body.size)), mime: 'application/pdf', current: true,
    kolaJobId: text(body.kolaJobId, 60), declarationNo: text(body.declarationNo, 40),
    uploadedBy: text(body.sentBy, 60), uploadedAt: nowIso()
  };
  await db.transaction(async (tx) => {
    await tx.update(transportDocs).set({ current: false })
      .where(and(eq(transportDocs.blKey, key), eq(transportDocs.kind, kind), eq(transportDocs.current, true)));
    await tx.insert(transportDocs).values(row);
  });
  return { ok: true, id: row.id };
}

/** ไฟล์ที่ส่งมาล่าสุด (หน้าอัปของ KOLA) */
export async function kolaDocList(body: ApiBody): Promise<ApiResult> {
  const no = kolaDenied(body);
  if (no) return no;
  const limit = Math.min(50, Math.max(1, Math.round(Number(body.limit) || 50)));
  const rows = await db.select().from(transportDocs).orderBy(desc(transportDocs.uploadedAt)).limit(limit);
  const urls = await signedDocUrls(rows.map((r) => r.storageKey));
  return {
    ok: true,
    rows: rows.map((r) => ({
      id: r.id, bl: r.bl, kind: r.kind, fileName: r.fileName, size: r.size, current: r.current,
      uploadedBy: r.uploadedBy, uploadedAt: r.uploadedAt, url: urls.get(r.storageKey) || ''
    }))
  };
}

/** ลบไฟล์ — ถ้าเป็นไฟล์ปัจจุบัน ไฟล์ล่าสุดที่เหลือของ BL + ประเภทเดียวกันกลับมาเป็นไฟล์ปัจจุบัน */
export async function kolaDocDelete(body: ApiBody): Promise<ApiResult> {
  const no = kolaDenied(body);
  if (no) return no;
  const docId = text(body.id, 60);
  const [doc] = await db.select().from(transportDocs).where(eq(transportDocs.id, docId)).limit(1);
  if (!doc) return { ok: false, error: 'not_found' };
  await db.transaction(async (tx) => {
    await tx.delete(transportDocs).where(eq(transportDocs.id, docId));
    if (!doc.current) return;
    const [prev] = await tx.select({ id: transportDocs.id }).from(transportDocs)
      .where(and(eq(transportDocs.blKey, doc.blKey), eq(transportDocs.kind, doc.kind)))
      .orderBy(desc(transportDocs.uploadedAt)).limit(1);
    if (prev) await tx.update(transportDocs).set({ current: true }).where(eq(transportDocs.id, prev.id));
  });
  await supabaseAdmin.storage.from(env.bucket).remove([doc.storageKey]).catch(() => undefined);
  return { ok: true };
}
