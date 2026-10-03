import { and, asc, gte, lte } from 'drizzle-orm';
import { db } from '@/db';
import { transportJobs } from '@/db/schema';
import { WHT_DEFAULT, WHT_DO_VESSELS } from './constants';
import type { ApiBody, ApiResult } from './types';
import { round2, validYmd } from './utils';

type JobRow = {
  id: number; transportDate: string; bl: string; vessel: string; sourceFile: string;
  doFee: number; extraMovement: number; storage: number; liftOn: number; liftOff: number;
};
export type WhtLine = {
  category: 'DO' | 'EM' | 'PORT'; date: string; bl: string; vessel: string; source: string;
  amount: number; detail: string;
};

/** สายเรือที่ต้องออกใบหักค่า DO — คืนชื่อมาตรฐาน หรือ '' ถ้าไม่ใช่ */
export function whtDoVessel(vessel: unknown) {
  const value = String(vessel ?? '');
  return WHT_DO_VESSELS.find((v) => v.pattern.test(value))?.label || '';
}

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * แตกแถวชีตเป็นรายการใบหัก ณ ที่จ่าย — 1 รายการ = 1 ใบ
 * ค่าใช้จ่ายของ BL อยู่ที่แถวแรกของ BL (ตู้อื่นเป็น 0) จึงรวมตาม ไฟล์ + BL + วันที่
 *   DO          : เฉพาะ VESSEL = KNOT GLOBAL / SEAL / M+R
 *   EXTRA MOVEMENT : ทุก BL ที่มียอด
 *   STORAGE + LIFT ON + LIFT OFF : รวมเป็น 1 ใบต่อ BL (ได้ใบเสร็จมาใบเดียว แล้วแยกรายการกรอกเอง)
 */
export function buildWithholding(rows: JobRow[]): WhtLine[] {
  const groups = new Map<string, { row: JobRow; doFee: number; em: number; storage: number; liftOn: number; liftOff: number }>();
  for (const row of rows) {
    const key = `${row.sourceFile}|${String(row.bl).toUpperCase()}|${row.transportDate}`;
    const g = groups.get(key) || { row, doFee: 0, em: 0, storage: 0, liftOn: 0, liftOff: 0 };
    g.doFee += Number(row.doFee) || 0;
    g.em += Number(row.extraMovement) || 0;
    g.storage += Number(row.storage) || 0;
    g.liftOn += Number(row.liftOn) || 0;
    g.liftOff += Number(row.liftOff) || 0;
    // VESSEL ว่างในแถวตู้ถัดไปได้ — ใช้ค่าแรกที่เจอ
    if (!g.row.vessel && row.vessel) g.row = { ...g.row, vessel: row.vessel };
    groups.set(key, g);
  }
  const out: WhtLine[] = [];
  for (const g of groups.values()) {
    const base = { date: g.row.transportDate, bl: g.row.bl, vessel: g.row.vessel, source: g.row.sourceFile };
    const doVessel = whtDoVessel(g.row.vessel);
    if (doVessel && g.doFee > 0) {
      out.push({ ...base, category: 'DO', amount: round2(g.doFee), detail: `DO ${doVessel}` });
    }
    if (g.em > 0) out.push({ ...base, category: 'EM', amount: round2(g.em), detail: 'EXTRA MOVEMENT' });
    const port = [['STORAGE', g.storage], ['LIFT ON', g.liftOn], ['LIFT OFF', g.liftOff]] as const;
    const parts = port.filter(([, v]) => v > 0);
    if (parts.length) {
      out.push({
        ...base, category: 'PORT', amount: round2(parts.reduce((s, [, v]) => s + v, 0)),
        detail: parts.map(([k, v]) => `${k} ${fmt(round2(v))}`).join(' + ')
      });
    }
  }
  const order = { DO: 0, EM: 1, PORT: 2 };
  return out.sort((a, b) => order[a.category] - order[b.category] || a.date.localeCompare(b.date) || a.bl.localeCompare(b.bl));
}

/** ข้อมูลใบหัก ณ ที่จ่ายตามช่วงวันที่ตรวจปล่อย (อ่านอย่างเดียว) */
export async function withholdingData(body: ApiBody): Promise<ApiResult> {
  const from = String(body.from || ''), to = String(body.to || '');
  if (!validYmd(from) || !validYmd(to) || from > to) return { ok: false, error: 'bad_date' };
  const rows = await db.select({
    id: transportJobs.id, transportDate: transportJobs.transportDate, bl: transportJobs.bl,
    vessel: transportJobs.vessel, sourceFile: transportJobs.sourceFile, doFee: transportJobs.doFee,
    extraMovement: transportJobs.extraMovement, storage: transportJobs.storage,
    liftOn: transportJobs.liftOn, liftOff: transportJobs.liftOff
  }).from(transportJobs)
    .where(and(gte(transportJobs.transportDate, from), lte(transportJobs.transportDate, to)))
    .orderBy(asc(transportJobs.transportDate), asc(transportJobs.id));
  return {
    ok: true, from, to, lines: buildWithholding(rows), defaults: WHT_DEFAULT,
    vessels: WHT_DO_VESSELS.map((v) => v.label)
  };
}
