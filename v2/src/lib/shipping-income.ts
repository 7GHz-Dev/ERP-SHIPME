import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { db } from '@/db';
import { transportJobs, users } from '@/db/schema';
import {
  INVOICE_COMPANY, SERVICE_BRIDGE_INSPECTOR_FEE, SERVICE_BRIDGE_INSPECTOR_LABEL, SERVICE_RORO_INSPECTOR_LABEL,
  SHIPPING_FULL_NAMES
} from './constants';
import { isNoCar, isRoro, noteExtras, type ExtraLine, type JobRow } from './service-invoices';
import type { ApiBody, ApiResult } from './types';
import { round2, validYmd } from './utils';

/** ค่านายตรวจของงานทั่วไป (ไม่ใช่ RORO / NO CAR) */
export const INCOME_INSPECTOR_LABEL = 'ค่าบริการนายตรวจ';
const EXCLUDED = /พ\.?\s*ร\.?\s*บ/;          // ค่าบริการ พรบ. ไม่นับเป็นรายได้ชิปปิ้ง

/** ลำดับคอลัมน์ในตารางสรุป — หัวข้อที่ไม่อยู่ในนี้ต่อท้ายตามที่เจอ */
export const INCOME_LABEL_ORDER = [
  INCOME_INSPECTOR_LABEL, SERVICE_RORO_INSPECTOR_LABEL, SERVICE_BRIDGE_INSPECTOR_LABEL,
  'ยางเกิน', 'สำแดงเท็จ', 'ค่าน๊อคประตูออกจากท่า', 'ค่าแลก ER'
];

type IncomeRow = JobRow & { shipping: string };

/**
 * รายได้ชิปปิ้งของแถวเดียว — คล้ายค่าบริการเพิ่มเติมในใบแจ้งหนี้ ต่างกันที่:
 *   - ค่านายตรวจนับทุกงานทั้ง 2 ตาราง (ไม่ใช่เฉพาะ RORO)
 *   - ไม่นับค่าบริการ พรบ.
 * งาน TRANSIT ที่ NO CAR ใช้ค่านายตรวจในชีต ถ้าว่างใช้ 100 เหมือนใบแจ้งหนี้
 */
export function incomeFromRow(row: JobRow): ExtraLine[] {
  const out: ExtraLine[] = [];
  const noCar = isNoCar(row);
  const fee = Number(row.inspectorFee) > 0 ? Number(row.inspectorFee) : (noCar ? SERVICE_BRIDGE_INSPECTOR_FEE : 0);
  if (fee > 0) {
    const label = noCar ? SERVICE_BRIDGE_INSPECTOR_LABEL : (isRoro(row.containerNo) ? SERVICE_RORO_INSPECTOR_LABEL : INCOME_INSPECTOR_LABEL);
    out.push({ bl: row.bl, date: row.transportDate, source: row.sourceFile, label, amount: round2(fee), segment: 'ค่านายตรวจ' });
  }
  return out.concat(noteExtras(row).filter((x) => !EXCLUDED.test(x.label)));
}

/** จัดกลุ่มตามชื่อชิปปิ้ง (ช่อง "ชิปปิ้ง" ในชีต) — แยกออกมาให้ทดสอบได้โดยไม่ต้องต่อฐานข้อมูล */
export function buildShippingIncome(rows: IncomeRow[], names: Map<string, string> = new Map()) {
  const groups = new Map<string, { shipping: string; name: string; fullName: string; lines: (ExtraLine & { shipping: string })[] }>();
  for (const row of rows) {
    const lines = incomeFromRow(row);
    if (!lines.length) continue;
    const code = String(row.shipping || '').trim().toUpperCase() || '(ไม่ระบุชิปปิ้ง)';
    const g = groups.get(code) || { shipping: code, name: names.get(code) || '', fullName: SHIPPING_FULL_NAMES[code] || '', lines: [] };
    g.lines.push(...lines.map((l) => ({ ...l, shipping: code })));
    groups.set(code, g);
  }
  const labels: string[] = [...INCOME_LABEL_ORDER];
  const out = [...groups.values()].sort((a, b) => a.shipping.localeCompare(b.shipping)).map((g) => {
    const byLabel: Record<string, number> = {};
    for (const l of g.lines) {
      byLabel[l.label] = round2((byLabel[l.label] || 0) + l.amount);
      if (!labels.includes(l.label)) labels.push(l.label);
    }
    return { ...g, byLabel, total: round2(g.lines.reduce((s, l) => s + l.amount, 0)) };
  });
  // คอลัมน์ที่ไม่มียอดเลยในช่วงนี้ไม่ต้องโชว์
  const used = labels.filter((label) => out.some((g) => g.byLabel[label]));
  return { groups: out, labels: used, total: round2(out.reduce((s, g) => s + g.total, 0)) };
}

/** รายงานรายได้ชิปปิ้งตามช่วงวันที่ตรวจปล่อย (ชีต MAESOT FREEZONE + TRANSIT) อ่านอย่างเดียว */
export async function shippingIncomeData(body: ApiBody): Promise<ApiResult> {
  const from = String(body.from || ''), to = String(body.to || '');
  if (!validYmd(from) || !validYmd(to) || from > to) return { ok: false, error: 'bad_date' };
  const rows = await db.select({
    id: transportJobs.id, transportDate: transportJobs.transportDate, bl: transportJobs.bl,
    containerNo: transportJobs.containerNo, inspectorFee: transportJobs.inspectorFee,
    otherFee: transportJobs.otherFee, note: transportJobs.note, sourceFile: transportJobs.sourceFile,
    shipping: transportJobs.shipping
  }).from(transportJobs)
    .where(and(gte(transportJobs.transportDate, from), lte(transportJobs.transportDate, to)))
    .orderBy(asc(transportJobs.transportDate), asc(transportJobs.id));
  // ชื่อเต็มของพนักงาน — ชื่อในชีต (AUN) ตรงกับชื่อผู้ใช้ หรือรหัสชิปปิ้งที่ตั้งไว้ในหน้าพนักงาน
  const staff = await db.select({ username: users.username, name: users.name, code: users.shippingCode })
    .from(users).where(eq(users.role, 'employee-shipping'));
  // ชื่อ/username ตรงตัวมาก่อนรหัสชิปปิ้ง — เดิมบัญชี "SHIPPING" ที่ตั้งรหัส NON ไว้ แย่งชื่อของ NON ไป
  const names = new Map<string, string>();
  for (const pick of [(u: typeof staff[number]) => [u.name, u.username], (u: typeof staff[number]) => [u.code]]) {
    for (const u of staff) {
      for (const key of pick(u)) {
        const k = String(key || '').trim().toUpperCase();
        if (k && !names.has(k)) names.set(k, u.name);
      }
    }
  }
  // company = หัวกระดาษ/โลโก้ของใบสรุปค่าใช้จ่ายเพิ่มเติมตอนส่งออก PDF
  return { ok: true, from, to, ...buildShippingIncome(rows, names), company: INVOICE_COMPANY };
}
