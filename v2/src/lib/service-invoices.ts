import { and, asc, gte, lte } from 'drizzle-orm';
import { db } from '@/db';
import { transportJobs } from '@/db/schema';
import {
  INVOICE_COMPANY, INVOICE_CUSTOMER, SERVICE_EXTRA_RULES, SERVICE_RATES,
  SERVICE_BANK_ACCOUNT_NO, SERVICE_BRIDGE_INSPECTOR_FEE, SERVICE_BRIDGE_INSPECTOR_LABEL,
  SERVICE_NO_CAR_PATTERN, SERVICE_RORO_INSPECTOR_LABEL, SERVICE_WITHHOLDING_RATE, VAT_RATE
} from './constants';
import type { ApiBody, ApiResult } from './types';
import { round2, validYmd } from './utils';

/** ชื่อที่พิมพ์บนใบสรุปจำนวนตู้ เช่น "(แม่สอดฟรีโซน)" */
const SOURCE_LABEL: Record<string, string> = {
  'MAESOT FREEZONE': 'แม่สอดฟรีโซน',
  TRANSIT: 'TRANSIT'
};
const SOURCE_ORDER = ['MAESOT FREEZONE', 'TRANSIT'];

export const isRoro = (containerNo: unknown) => /^\s*RORO\s*$/i.test(String(containerNo ?? ''));
/** งาน TRANSIT ที่หมายเหตุเขียน NO CAR — ไม่คิดค่าบริการตรวจปล่อย คิดค่านายตรวจข้ามสะพานแทน */
export const isNoCar = (row: { sourceFile: string; note: string }) =>
  row.sourceFile === 'TRANSIT' && SERVICE_NO_CAR_PATTERN.test(String(row.note || ''));

/** ยอดท้ายรายการ เช่น "ยางเกิน 2000" / "ค่าบริการ พรบ. 98.75" — ไม่มียอด = null */
function trailingAmount(segment: string) {
  const match = segment.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(?:บาท|บ\.)?\s*$/);
  return match ? Number(match[1]) : null;
}

export type JobRow = {
  id: number; transportDate: string; bl: string; containerNo: string;
  inspectorFee: number; otherFee: number; note: string; sourceFile: string;
};

export type ExtraLine = { label: string; amount: number; bl: string; date: string; source: string; segment: string };

/**
 * รายการค่าบริการจากช่องหมายเหตุของแถวเดียว (คั่นด้วย //) ตาม SERVICE_EXTRA_RULES
 * รายการที่ไม่มียอดในหมายเหตุ ใช้ คชจ. อื่นๆ หักยอดที่เขียนไว้ในหมายเหตุออก
 * (หมายเหตุ "ยางเกิน" + คชจ.อื่นๆ 1000 → ยางเกิน 1000)
 * ใช้ร่วมกันทั้งใบแจ้งหนี้ค่าบริการเพิ่มเติม และรายงานรายได้ชิปปิ้ง
 */
export function noteExtras(row: JobRow): ExtraLine[] {
  const out: ExtraLine[] = [];
  const base = { bl: row.bl, date: row.transportDate, source: row.sourceFile };
  // * ในหมายเหตุเป็นเครื่องหมายนับใบหัก ณ ที่จ่าย (ดู withholding.ts) ไม่ใช่ส่วนของยอด — "98.75**" ต้องอ่านได้ 98.75
  const segments = String(row.note || '').replace(/\*/g, '').split('//').map((s) => s.trim()).filter(Boolean);
  const written = segments.reduce((sum, s) => sum + (trailingAmount(s) || 0), 0);
  for (const segment of segments) {
    const rule = SERVICE_EXTRA_RULES.find((r) => r.pattern.test(segment));
    if (!rule) continue;
    const amount = trailingAmount(segment) ?? round2(Number(row.otherFee) - written);
    if (amount > 0) out.push({ ...base, label: rule.label, amount: round2(amount), segment });
  }
  return out;
}

/** ค่าบริการเพิ่มเติมของแถวเดียว (ใบแจ้งหนี้) = ค่านายตรวจของงาน RORO + รายการในหมายเหตุ */
export function extrasFromRow(row: JobRow): ExtraLine[] {
  const out: ExtraLine[] = [];
  if (isRoro(row.containerNo) && Number(row.inspectorFee) > 0) {
    out.push({ bl: row.bl, date: row.transportDate, source: row.sourceFile,
      label: SERVICE_RORO_INSPECTOR_LABEL, amount: round2(row.inspectorFee), segment: 'ค่านายตรวจ (RORO)' });
  }
  return out.concat(noteExtras(row));
}

/**
 * ข้อมูลทำใบแจ้งหนี้ค่าบริการตามช่วงวันที่ตรวจปล่อย
 * - ใบสรุปจำนวนตู้ + ใบแจ้งหนี้ค่าบริการตรวจปล่อย แยกตามไฟล์ชีต (แม่สอดฟรีโซน / TRANSIT)
 * - ค่าบริการเพิ่มเติม รวมทุกไฟล์เป็นชุดเดียว
 * 1 แถวในชีต = 1 ตู้ (ช่องจำนวนในชีตไม่ได้กรอก)
 */
export async function serviceInvoiceData(body: ApiBody): Promise<ApiResult> {
  const from = String(body.from || ''), to = String(body.to || '');
  if (!validYmd(from) || !validYmd(to) || from > to) return { ok: false, error: 'bad_date' };

  const rows = await db.select({
    id: transportJobs.id, transportDate: transportJobs.transportDate, bl: transportJobs.bl,
    containerNo: transportJobs.containerNo, inspectorFee: transportJobs.inspectorFee,
    otherFee: transportJobs.otherFee, note: transportJobs.note, sourceFile: transportJobs.sourceFile
  }).from(transportJobs)
    .where(and(gte(transportJobs.transportDate, from), lte(transportJobs.transportDate, to)))
    .orderBy(asc(transportJobs.transportDate), asc(transportJobs.id));

  return {
    ok: true, from, to, ...buildServiceData(rows),
    rates: SERVICE_RATES, vatRate: VAT_RATE, withholdingRate: SERVICE_WITHHOLDING_RATE,
    // หัวใบ โลโก้ ตราประทับ เหมือนใบ ADV ต่างกันแค่เลขบัญชีรับเงิน
    company: { ...INVOICE_COMPANY, bankAccountNo: SERVICE_BANK_ACCOUNT_NO }, customer: INVOICE_CUSTOMER
  };
}

/** จัดกลุ่มแถวชีตเป็นใบสรุปจำนวนตู้ต่อไฟล์ + ค่าบริการเพิ่มเติม (แยกออกมาให้ทดสอบได้โดยไม่ต้องต่อฐานข้อมูล) */
export function buildServiceData(rows: JobRow[]) {
  const bySource = new Map<string, Map<string, { bl: string; containers: number; roro: boolean; date: string }>>();
  const extras: ReturnType<typeof extrasFromRow> = [];
  const bridgeDone = new Set<string>();
  for (const row of rows) {
    const source = row.sourceFile || 'อื่นๆ';
    if (isNoCar(row)) {
      // ค่านายตรวจข้ามสะพาน BL ละครั้ง (BL หลายแถวก็คิดครั้งเดียว) แล้วไม่นับตู้ของแถวนี้
      const blKey = String(row.bl).toUpperCase();
      if (!bridgeDone.has(blKey)) {
        bridgeDone.add(blKey);
        extras.push({ label: SERVICE_BRIDGE_INSPECTOR_LABEL, amount: SERVICE_BRIDGE_INSPECTOR_FEE,
          bl: row.bl, date: row.transportDate, source: row.sourceFile, segment: 'NO CAR' });
      }
      // รายการอื่นในหมายเหตุของแถวเดียวกัน (เช่น ค่าน๊อคประตู) ยังคิดตามปกติ
      extras.push(...extrasFromRow(row));
      continue;
    }
    const roro = isRoro(row.containerNo);
    // BL เดียวกันแต่มีทั้งตู้ปกติและ RORO แยกบรรทัด เพราะคิดคนละราคา
    const key = `${String(row.bl).toUpperCase()}|${roro ? 'R' : 'C'}`;
    const group = bySource.get(source) || new Map();
    const entry = group.get(key) || { bl: row.bl, containers: 0, roro, date: row.transportDate };
    entry.containers += 1;
    group.set(key, entry);
    bySource.set(source, group);
    extras.push(...extrasFromRow(row));
  }

  const sources = [...bySource.keys()]
    .sort((a, b) => (SOURCE_ORDER.indexOf(a) + 1 || 99) - (SOURCE_ORDER.indexOf(b) + 1 || 99))
    .map((file) => {
      const list = [...bySource.get(file)!.values()];
      return {
        file, label: SOURCE_LABEL[file] || file, rows: list,
        containers: list.filter((r) => !r.roro).reduce((s, r) => s + r.containers, 0),
        roro: list.filter((r) => r.roro).reduce((s, r) => s + r.containers, 0)
      };
    });

  return { sources, extras };
}
