import { and, gte, lte } from 'drizzle-orm';
import { db } from '@/db';
import { claims, settlements, transportJobs } from '@/db/schema';
import { SHIPPING_FULL_NAMES } from './constants';
import type { ApiBody, ApiResult } from './types';
import { round2, safeJson, validYmd, ymd } from './utils';

/**
 * กระทบยอดชิปปิ้ง — ค่าใช้จ่ายตามชีตงานขนส่ง เทียบกับใบเบิก/ใบปิดบัญชีของพนักงาน ต่อวันที่ตรวจปล่อย
 *
 * ค่าใช้จ่ายตามชีต = ทุกช่องค่าใช้จ่าย รวมค่านายตรวจ ยกเว้น DO, DEM และหักค่า พรบ. / ค่าบริการ พรบ.
 *   (พรบ. อยู่ในช่อง คชจ. อื่นๆ — ยอดอ่านจากหมายเหตุ เช่น "ค่าพรบ 401.25 // ค่าบริการ พรบ. 98.75")
 * ค่านายตรวจในชีต = ค่าบริการเพิ่มเติม(ฟรีโซน) ในใบปิดบัญชี (เงินก้อนเดียวกัน เรียกคนละชื่อ —
 *   ก.ย. 2569 ยอดรวมตรงกันทุกคน)
 * ส่วนต่าง = ค่าใช้จ่ายจริง (ใบปิดบัญชี) − ค่าใช้จ่ายตามชีต → 0 = ตรงกัน
 *   ไม่บวกฟรีโซนเพิ่ม เพราะชีตรวมค่านายตรวจซึ่งคือเงินก้อนเดียวกับฟรีโซนอยู่แล้ว
 * freezone ยังส่งไปให้หน้าเว็บแสดงว่าค่าใช้จ่ายจริงมีฟรีโซนเท่าไร
 * overtime ส่งแยกไว้ให้ดูว่าส่วนต่างมาจาก OT หรือไม่ — ข้อมูลจริงบางวันเบิก OT ในใบปิดบัญชี บางวันไม่เบิก
 */
export const RECONCILE_SHEET_COLUMNS = [
  ['extraMovement', 'EXTRA MOVEMENT'], ['storage', 'STORAGE'], ['liftOn', 'LIFT ON'], ['liftOff', 'LIFT OFF'],
  ['orderForm', 'ORDER FORM'], ['overtime', 'ค่าล่วงเวลา'], ['sealFee', 'ค่าตะกั่ว'], ['otherFee', 'คชจ. อื่นๆ'],
  ['detention', 'DETENTION'], ['repairFee', 'ค่าซ่อมตู้'], ['inspectorFee', 'ค่านายตรวจ']
] as const;
const FREEZONE_KEYS = ['extra_service', 'extra_service_transit'];

/** ยอด ค่าพรบ + ค่าบริการ พรบ. ที่เขียนไว้ในหมายเหตุ (ไม่นับเป็นค่าใช้จ่ายของชิปปิ้ง) */
export function prbAmount(note: unknown) {
  let total = 0;
  for (const seg of String(note || '').replace(/\*/g, '').split('//')) {
    if (!/พ\.?\s*ร\.?\s*บ/.test(seg)) continue;
    const m = seg.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(?:บาท)?\s*$/);
    if (m) total += Number(m[1]);
  }
  return round2(total);
}

type SheetRow = { transportDate: string; bl: string; shipping: string; note: string } & Record<typeof RECONCILE_SHEET_COLUMNS[number][0], number>;

/** ค่าใช้จ่ายตามชีตของแถวเดียว + รายละเอียดว่ามาจากช่องไหน */
export function sheetExpense(row: SheetRow) {
  const parts: { label: string; amount: number }[] = [];
  for (const [key, label] of RECONCILE_SHEET_COLUMNS) {
    const v = Number(row[key]) || 0;
    if (v) parts.push({ label, amount: round2(v) });
  }
  const prb = prbAmount(row.note);
  if (prb) parts.push({ label: 'หัก พรบ.', amount: -prb });
  return { amount: round2(parts.reduce((s, p) => s + p.amount, 0)), parts };
}

const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const blKey = (v: unknown) => up(v).replace(/\s+/g, '');

export async function shippingReconcileData(body: ApiBody): Promise<ApiResult> {
  const from = String(body.from || ''), to = String(body.to || '');
  if (!validYmd(from) || !validYmd(to) || from > to) return { ok: false, error: 'bad_date' };

  const sheet = await db.select({
    transportDate: transportJobs.transportDate, bl: transportJobs.bl, shipping: transportJobs.shipping, note: transportJobs.note,
    extraMovement: transportJobs.extraMovement, storage: transportJobs.storage, liftOn: transportJobs.liftOn,
    liftOff: transportJobs.liftOff, orderForm: transportJobs.orderForm, overtime: transportJobs.overtime,
    sealFee: transportJobs.sealFee, otherFee: transportJobs.otherFee, detention: transportJobs.detention,
    repairFee: transportJobs.repairFee, inspectorFee: transportJobs.inspectorFee
  }).from(transportJobs).where(and(gte(transportJobs.transportDate, from), lte(transportJobs.transportDate, to)));
  const setts = await db.select().from(settlements)
    .where(and(gte(settlements.inspectDate, from), lte(settlements.inspectDate, to)));
  const claimRows = await db.select({ username: claims.username, inspectDate: claims.inspectDate, total: claims.total, createdAt: claims.createdAt })
    .from(claims).where(and(gte(claims.inspectDate, from), lte(claims.inspectDate, to)));

  type Day = {
    date: string; claimDate: string; claim: number; sheet: number; overtime: number; freezone: number; used: number | null;
    refund: number | null; returnedDate: string; slipStatus: string; hasSettlement: boolean;
    bls: Map<string, { bl: string; sheet: number; overtime: number; sheetParts: { label: string; amount: number }[]; settlement: number | null; freezone: number }>;
  };
  const people = new Map<string, Map<string, Day>>();
  const day = (who: string, date: string): Day => {
    const p = people.get(who) || new Map<string, Day>();
    people.set(who, p);
    let d = p.get(date);
    if (!d) {
      d = { date, claimDate: '', claim: 0, sheet: 0, overtime: 0, freezone: 0, used: null, refund: null, returnedDate: '', slipStatus: '', hasSettlement: false, bls: new Map() };
      p.set(date, d);
    }
    return d;
  };
  const blEntry = (d: Day, bl: string) => {
    const k = blKey(bl);
    let e = d.bls.get(k);
    if (!e) { e = { bl, sheet: 0, overtime: 0, sheetParts: [], settlement: null, freezone: 0 }; d.bls.set(k, e); }
    return e;
  };

  for (const row of sheet) {
    const who = up(row.shipping);
    const exp = sheetExpense(row);
    if (!who || !exp.parts.length) continue;
    const d = day(who, row.transportDate);
    d.sheet = round2(d.sheet + exp.amount);
    d.overtime = round2(d.overtime + (Number(row.overtime) || 0));
    const e = blEntry(d, row.bl);
    e.sheet = round2(e.sheet + exp.amount);
    e.overtime = round2(e.overtime + (Number(row.overtime) || 0));
    e.sheetParts.push(...exp.parts);
  }
  for (const s of setts) {
    const d = day(up(s.username), s.inspectDate);
    d.hasSettlement = true;
    d.used = round2(s.totalExpense);
    d.refund = round2(s.balance);
    d.returnedDate = s.returnedDate || '';
    d.slipStatus = s.slipStatus || '';
    if (!d.claim) d.claim = round2(s.claimTotal);
    for (const row of safeJson<any[]>(s.rowsJson, [])) {
      const fz = FREEZONE_KEYS.reduce((sum, k) => sum + (Number(row?.costs?.[k]) || 0), 0);
      d.freezone = round2(d.freezone + fz);
      const e = blEntry(d, row?.bl || '(ไม่ระบุ BL)');
      e.settlement = round2((e.settlement || 0) + (Number(row?.total) || 0));
      e.freezone = round2(e.freezone + fz);
    }
  }
  for (const c of claimRows) {
    const d = day(up(c.username), c.inspectDate);
    d.claim = round2(c.total);
    d.claimDate = ymd(new Date(c.createdAt));
  }

  const groups = [...people.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([shipping, map]) => {
    const days = [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
      const diff = d.used == null ? null : round2(d.used - d.sheet);
      const bls = [...d.bls.values()].map((b) => ({
        bl: b.bl, sheet: b.sheet, overtime: b.overtime, sheetParts: b.sheetParts, settlement: b.settlement, freezone: b.freezone,
        diff: b.settlement == null ? null : round2(b.settlement - b.sheet)
      }));
      return { ...d, bls, diff };
    });
    const sum = (k: 'claim' | 'sheet' | 'freezone' | 'overtime') => round2(days.reduce((s, d) => s + d[k], 0));
    const sumN = (k: 'used' | 'refund' | 'diff') => round2(days.reduce((s, d) => s + (d[k] || 0), 0));
    return {
      shipping, fullName: SHIPPING_FULL_NAMES[shipping] || '', days,
      totals: { claim: sum('claim'), sheet: sum('sheet'), overtime: sum('overtime'), freezone: sum('freezone'), used: sumN('used'), refund: sumN('refund'), diff: sumN('diff') },
      mismatches: days.filter((d) => d.diff == null || Math.abs(d.diff) > 0.009).length
    };
  });
  return { ok: true, from, to, groups };
}
