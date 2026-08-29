import { and, eq, notInArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { transportJobs } from '@/db/schema';
import { env } from './env';
import { nowIso } from './utils';
import type { ApiBody, ApiResult } from './types';

/**
 * รับข้อมูลงานขนส่งที่ Apps Script ใน "ชีตงานขนส่ง" ยิงเข้ามาเมื่อมีคนแก้เซลล์
 * (ทางเดียวที่ได้ข้อมูลทันทีจริง ๆ — ถ้าให้ v2 ไปดึงเองต้องรอรอบ cron หรือรอคนเปิดหน้าปิดบัญชี)
 *
 * ฝั่งชีตเป็นคนแยกหัวคอลัมน์และเติมค่า BL ที่เว้นว่างให้เรียบร้อยแล้ว
 * (ตรรกะเดียวกับ scanTransport ใน Code.gs) ฝั่งนี้จึงรับเป็นแถวสำเร็จรูป
 * แล้ว "แทนที่ทั้งแท็บ" ไม่ใช่ค่อย ๆ เติม — เพราะการแก้ในชีตมีทั้งลบแถวและแก้ค่าเดิม
 * ถ้าเติมอย่างเดียวแถวที่ถูกลบไปแล้วจะค้างอยู่ใน Supabase ตลอดไป
 */

export type IncomingJob = {
  transportDate: string; shipping: string; bl: string; containerNo: string;
  quantity: number; port: string; customer: string;
};

const text = (value: unknown, max = 300) => String(value ?? '').trim().slice(0, max);

/**
 * ชื่อไฟล์ที่ชีตส่งมาคือชื่อจริงบน Drive ("สำเนาของ MAESOT FREEZONE 2026")
 * แต่ข้อมูลที่ import มารอบแรกเก็บไว้เป็นชื่อที่มาสั้น ๆ ("MAESOT FREEZONE")
 * ถ้าไม่ยุบให้ตรงกัน การ sync ครั้งแรกจะกลายเป็นเพิ่มชุดใหม่ทับของเดิม = งานซ้ำทั้งตาราง
 * จึงยุบเหลือชื่อที่มาเมื่อจับคู่ได้ (เทียบแบบเดียวกับ transportSourceIndex ใน Code.gs)
 */
const SOURCE_ORDER = ['MAESOT FREEZONE', 'TRANSIT'];

const normSource = (value: unknown) => String(value ?? '').toLowerCase()
  .replace(/[\s​.\-_()[\]:/]+/g, '')
  .replace(/สำเนาของ/g, '')
  .replace(/copyof/g, '');

export function canonicalSourceFile(fileName: string, sheetName = ''): string {
  const file = normSource(fileName);
  const sheet = normSource(sheetName);
  for (const source of SOURCE_ORDER) {
    if (file.includes(normSource(source))) return source;
  }
  for (const source of SOURCE_ORDER) {
    if (sheet.includes(normSource(source))) return source;
  }
  return text(fileName, 200);
}

/** yyyy-MM-dd เท่านั้น รองรับ พ.ศ. และ dd/mm/yyyy เผื่อชีตส่งมาเป็นข้อความ (ตรงกับ cellToYMD ใน Code.gs) */
export function toYmd(value: unknown): string {
  const raw = text(value, 40);
  if (!raw) return '';
  const pad = (part: string) => part.padStart(2, '0');
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(raw);
  if (match) {
    const year = Number(match[1]);
    return `${year > 2400 ? year - 543 : year}-${pad(match[2])}-${pad(match[3])}`;
  }
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(raw);
  if (match) {
    const year = Number(match[3]);
    return `${year > 2400 ? year - 543 : year}-${pad(match[2])}-${pad(match[1])}`;
  }
  return '';
}

function normalizeRows(input: unknown): IncomingJob[] {
  if (!Array.isArray(input)) return [];
  const rows: IncomingJob[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const transportDate = toYmd(row.transportDate ?? row.transport_date ?? row.date);
    // ไม่มีวันที่ = ใช้ในหน้าปิดบัญชีไม่ได้อยู่แล้ว (ค้นด้วยวันที่ตรวจปล่อยเสมอ) ทิ้งตั้งแต่ตรงนี้
    if (!transportDate) continue;
    rows.push({
      transportDate,
      shipping: text(row.shipping),
      bl: text(row.bl),
      containerNo: text(row.containerNo ?? row.container_no),
      quantity: Number(row.quantity) || 0,
      port: text(row.port),
      customer: text(row.customer)
    });
  }
  return rows;
}

/**
 * แทนที่ข้อมูลของ "ไฟล์ + แท็บ" นั้นทั้งชุดในทรานแซกชันเดียว
 * ระหว่างลบกับใส่ใหม่ห้ามมีจังหวะที่ตารางว่าง ไม่งั้นคนที่เปิดหน้าปิดบัญชีพอดีจะไม่เห็นงานของตัวเอง
 */
export async function syncTransportSheet(body: ApiBody): Promise<ApiResult> {
  const token = text(body.token, 200);
  if (!env.transportSyncToken) return { ok: false, error: 'sync_not_configured' };
  if (token !== env.transportSyncToken) return { ok: false, error: 'invalid_token' };

  const rawFile = text(body.sourceFile ?? body.file, 200);
  const sourceSheet = text(body.sourceSheet ?? body.sheet, 200);
  if (!rawFile || !sourceSheet) return { ok: false, error: 'bad_request', detail: 'ต้องส่ง sourceFile และ sourceSheet' };
  const sourceFile = canonicalSourceFile(rawFile, sourceSheet);

  const rows = normalizeRows(body.rows);
  const importedAt = nowIso();
  // ชื่อที่มา (MAESOT FREEZONE / TRANSIT) ฝั่งชีตคิดมาแล้วด้วยตรรกะเดียวกับ Code.gs
  const sourceName = text(body.sourceName, 100);

  const scope = and(eq(transportJobs.sourceFile, sourceFile), eq(transportJobs.sourceSheet, sourceSheet));

  const before = await db.select({ count: sql<number>`count(*)::int` }).from(transportJobs).where(scope);

  await db.transaction(async (tx) => {
    await tx.delete(transportJobs).where(scope);
    for (let index = 0; index < rows.length; index += 500) {
      await tx.insert(transportJobs).values(rows.slice(index, index + 500).map((row) => ({
        ...row, sourceFile, sourceSheet, sourceName, importedAt
      })));
    }
  });

  return {
    ok: true,
    file: sourceFile,
    sheet: sourceSheet,
    received: Array.isArray(body.rows) ? body.rows.length : 0,
    saved: rows.length,
    replaced: before[0]?.count ?? 0,
    importedAt
  };
}

/**
 * ลบข้อมูลของแท็บที่ถูกลบทิ้งไปแล้วในชีต — Apps Script ส่งรายชื่อแท็บที่ยังอยู่มาให้
 * ถ้าไม่มีขั้นนี้ แท็บที่ถูกลบจะยังโผล่ในหน้าปิดบัญชีตลอดไป
 */
export async function pruneTransportSheets(body: ApiBody): Promise<ApiResult> {
  if (!env.transportSyncToken) return { ok: false, error: 'sync_not_configured' };
  if (text(body.token, 200) !== env.transportSyncToken) return { ok: false, error: 'invalid_token' };

  const sourceFile = canonicalSourceFile(text(body.sourceFile ?? body.file, 200));
  const keep = Array.isArray(body.sheets) ? body.sheets.map((name: unknown) => text(name, 200)).filter(Boolean) : [];
  if (!sourceFile || !keep.length) return { ok: false, error: 'bad_request', detail: 'ต้องส่ง sourceFile และรายชื่อ sheets ที่ยังอยู่' };

  const removed = await db.delete(transportJobs)
    .where(and(eq(transportJobs.sourceFile, sourceFile), notInArray(transportJobs.sourceSheet, keep)))
    .returning({ sheet: transportJobs.sourceSheet });

  return { ok: true, file: sourceFile, kept: keep, removedRows: removed.length };
}

/** ให้หน้า admin เห็นว่าแต่ละแท็บ sync ล่าสุดเมื่อไหร่ — "ตั้งค่าแล้ว" ไม่พอ ต้องรู้ว่ายังวิ่งอยู่จริง */
export async function transportSyncStatus(): Promise<ApiResult> {
  const rows = await db.select({
    file: transportJobs.sourceFile,
    sheet: transportJobs.sourceSheet,
    rows: sql<number>`count(*)::int`,
    lastSync: sql<string>`max(${transportJobs.importedAt})`
  })
    .from(transportJobs)
    .groupBy(transportJobs.sourceFile, transportJobs.sourceSheet)
    .orderBy(transportJobs.sourceFile, transportJobs.sourceSheet);

  return { ok: true, configured: Boolean(env.transportSyncToken), sheets: rows };
}
