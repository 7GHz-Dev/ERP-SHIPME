import { and, eq, notInArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { transportJobs, transportSyncLogs } from '@/db/schema';
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
  vessel: string; doFee: number; dem: number; extraMovement: number; storage: number;
  liftOn: number; liftOff: number; orderForm: number; inspectorFee: number;
  overtime: number; sealFee: number; otherFee: number; detention: number; repairFee: number;
  note: string; driver: string; settled: boolean; docSentDate: string; invoiceNo: string;
};

const text = (value: unknown, max = 300) => String(value ?? '').trim().slice(0, max);

/**
 * ชื่อคอลัมน์ในตารางกับชื่อที่คนอ่านรู้เรื่อง — ใช้ตอนบอกว่า sync รอบนั้นแก้ช่องไหน
 * ตรงกับหัวคอลัมน์ในชีตเพื่อให้เทียบกลับไปหาต้นทางได้ทันที
 */
/** camelCase ใน schema → ชื่อคอลัมน์จริงใน Supabase (doFee → do_fee) */
const dbColumn = (name: string) => name.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

const COLUMN_LABELS: Record<string, string> = {
  transportDate: 'TRANSPORT (วันที่ตรวจปล่อย)',
  shipping: 'ชิปปิ้ง',
  customer: 'ชิปเปอร์',
  vessel: 'VESSEL',
  containerNo: 'CONTAINER NO.',
  port: 'ท่าส่งออก',
  quantity: 'จำนวนตู้',
  doFee: 'แลก DO',
  dem: 'DEM',
  extraMovement: 'EXTRA MOVEMENT',
  storage: 'STORAGE',
  liftOn: 'LIFT ON',
  liftOff: 'LIFT OFF',
  orderForm: 'ORDER FORM',
  inspectorFee: 'ค่านายตรวจ',
  overtime: 'ค่าล่วงเวลา',
  sealFee: 'ค่าตะกั่ว',
  otherFee: 'คชจ. อื่นๆ',
  detention: 'ค่า Detention',
  repairFee: 'ค่าซ่อมตู้',
  note: 'หมายเหตุ',
  driver: 'รายชื่อคนรถ',
  settled: 'ปิดบัญชีแล้ว',
  docSentDate: 'ส่งแม่สอด',
  invoiceNo: 'เลขที่ใบแจ้งหนี้'
};

/**
 * ตัวเลขจากชีต — ตัดลูกน้ำออกและกัน #REF! / #VALUE! ที่สูตรในชีตพังแล้วส่งมาเป็นข้อความ
 * ถ้าไม่กัน ค่าพวกนี้จะกลายเป็น NaN แล้ว insert ลง double ไม่ผ่านทั้งก้อน
 */
const money = (value: unknown) => {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
};

/** ชีตติ๊ก TRUE/ใช่/1 — รับได้หมด */
const flag = (value: unknown) => /^(true|yes|1|ใช่|y)$/i.test(String(value ?? '').trim());

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
      customer: text(row.customer),
      vessel: text(row.vessel, 120),
      // ค่าแลก DO — ใบแจ้งหนี้แบบ No VAT ใช้ยอดนี้ ชีตเก่าที่ยังไม่ส่งมาจะเป็น 0
      doFee: money(row.doFee ?? row.do_fee),
      dem: money(row.dem),
      extraMovement: money(row.extraMovement),
      storage: money(row.storage),
      liftOn: money(row.liftOn),
      liftOff: money(row.liftOff),
      orderForm: money(row.orderForm),
      inspectorFee: money(row.inspectorFee),
      overtime: money(row.overtime),
      sealFee: money(row.sealFee),
      otherFee: money(row.otherFee),
      detention: money(row.detention),
      repairFee: money(row.repairFee),
      note: text(row.note, 500),
      driver: text(row.driver, 200),
      settled: flag(row.settled),
      docSentDate: toYmd(row.docSentDate),
      invoiceNo: text(row.invoiceNo, 40)
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

  // เก็บของเดิมทั้งแถวไว้เทียบว่ารอบนี้เปลี่ยนอะไรบ้าง — ตัว transport_jobs เองเก็บ
  // ได้แค่สถานะปัจจุบัน เพราะทุกรอบลบทั้งแท็บแล้วใส่ใหม่ ประวัติจึงต้องบันทึกแยก
  const previous = await db.select().from(transportJobs).where(scope);

  const keyOf = (bl: string, cntr: string) => `${bl.toUpperCase()}|${cntr.toUpperCase()}`;
  const beforeMap = new Map(previous.map(r => [keyOf(r.bl, r.containerNo), r]));
  const afterMap = new Map(rows.map(r => [keyOf(r.bl, r.containerNo), r]));

  const addedKeys = [...afterMap.keys()].filter(k => !beforeMap.has(k));
  const removedKeys = [...beforeMap.keys()].filter(k => !afterMap.has(k));
  // เก็บแค่เลข BL ไม่เอาเบอร์ตู้ เพราะหน้า dashboard อ่านเป็นรายการงาน
  const blOf = (keys: string[]) => [...new Set(keys.map(k => k.split('|')[0]).filter(Boolean))].slice(0, 20);

  /**
   * เทียบทีละคอลัมน์ว่าค่าไหนเปลี่ยน — แถวที่ BL+ตู้ เดิมแต่แก้ค่าข้างใน
   * เดิมตรวจแค่ BL กับเบอร์ตู้ การแก้ยอดเงินหรือวันที่จึงไม่ถูกจับเลย
   */
  const norm = (v: unknown) => typeof v === 'number' ? v : String(v ?? '');
  const diffFields = (before: any, after: any) => {
    const out: { column: string; label: string; from: any; to: any }[] = [];
    for (const [column, label] of Object.entries(COLUMN_LABELS)) {
      const a = norm(before?.[column]);
      const b = norm(after?.[column]);
      if (a !== b) out.push({ column: dbColumn(column), label, from: a, to: b });
    }
    return out;
  };

  const details: any[] = [];
  // แถวใหม่ — แสดงเฉพาะช่องที่มีค่า ไม่ต้องโชว์ช่องว่างทั้งหมด
  for (const key of addedKeys) {
    if (details.length >= 30) break;
    const row: any = afterMap.get(key);
    const fields = Object.entries(COLUMN_LABELS)
      // ข้ามช่องที่ไม่มีค่าจริง — 0, ว่าง และ false ("ยังไม่ปิดบัญชี") ไม่ใช่ข้อมูลที่คนอยากเห็น
      .filter(([column]) => {
        const v = norm(row?.[column]);
        return v !== '' && v !== 0 && v !== 'false';
      })
      .map(([column, label]) => ({ column: dbColumn(column), label, from: '', to: norm(row?.[column]) }))
      .slice(0, 8);
    details.push({ bl: row?.bl || '', container: row?.containerNo || '', kind: 'added', fields });
  }
  // แถวที่แก้ค่าเดิม
  let changed = 0;
  for (const [key, after] of afterMap) {
    const before = beforeMap.get(key);
    if (!before) continue;
    const fields = diffFields(before, after);
    if (!fields.length) continue;
    changed++;
    if (details.length < 30) {
      details.push({ bl: (after as any).bl, container: (after as any).containerNo, kind: 'changed', fields: fields.slice(0, 8) });
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(transportJobs).where(scope);
    for (let index = 0; index < rows.length; index += 500) {
      await tx.insert(transportJobs).values(rows.slice(index, index + 500).map((row) => ({
        ...row, sourceFile, sourceSheet, sourceName, importedAt
      })));
    }
    // บันทึกเฉพาะรอบที่มีอะไรเปลี่ยนจริง ไม่งั้นตารางจะโตด้วยรอบที่ไม่มีอะไรเกิดขึ้น
    // (trigger กวาดทุกชั่วโมงยิงเข้ามาเรื่อย ๆ แม้ไม่มีคนแก้ชีต)
    if (addedKeys.length || removedKeys.length || changed) {
      await tx.insert(transportSyncLogs).values({
        syncedAt: importedAt, sourceFile, sourceSheet,
        rowsBefore: previous.length, rowsAfter: rows.length,
        added: addedKeys.length, removed: removedKeys.length, changed,
        addedBls: JSON.stringify(blOf(addedKeys)),
        removedBls: JSON.stringify(blOf(removedKeys)),
        details: JSON.stringify(details)
      });
    }
  });

  return {
    ok: true,
    file: sourceFile,
    sheet: sourceSheet,
    received: Array.isArray(body.rows) ? body.rows.length : 0,
    saved: rows.length,
    replaced: previous.length,
    added: addedKeys.length,
    removed: removedKeys.length,
    changed,
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
