import { and, asc, gte, lte, ne } from 'drizzle-orm';
import { db } from '@/db';
import { transportJobs } from '@/db/schema';
import { WHT_DEFAULT, WHT_DO_VESSELS, WHT_LIFT_ON_MIN, WHT_LIFT_ON_MIN_UNTIL } from './constants';
import { readDoSheet, type DoEntry } from './do-sheet';
import type { ApiBody, ApiResult } from './types';
import { round2, validYmd } from './utils';

type JobRow = {
  id: number; transportDate: string; bl: string; vessel: string; sourceFile: string;
  doFee: number; extraMovement: number; storage: number; liftOn: number; liftOff: number; note: string;
};
/** count = จำนวนใบของรายการนี้ (ปกติ 1 — เครื่องหมาย * ในหมายเหตุบอกว่าได้ใบเสร็จแยกหลายใบ) */
export type WhtLine = {
  category: 'DO' | 'EM' | 'PORT'; date: string; bl: string; vessel: string; source: string;
  amount: number; detail: string; count: number;
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
 *   (DO ไม่ได้มาจากที่นี่ — นับตามวันที่จ่ายในชีตค่าแลกดีโอ ดู buildDoLines)
 *   EXTRA MOVEMENT : ทุก BL ที่มียอด
 *   STORAGE + LIFT ON + LIFT OFF : รวมเป็น 1 ใบต่อ BL (ได้ใบเสร็จมาใบเดียว แล้วแยกรายการกรอกเอง)
 *     - หมายเหตุมี * = ได้ใบเสร็จแยก นับจำนวนใบตามจำนวน * (เช่น "**" = 2 ใบ ยอดรวมเท่าเดิม)
 *     - LIFT ON ต่ำกว่า 1,000 ของงานถึงสิ้น ก.ย. 2569 ไม่นับ (ถ้า BL นั้นมี STORAGE/LIFT OFF ยังนับส่วนนั้น)
 */
export function buildWithholding(rows: JobRow[]): WhtLine[] {
  const groups = new Map<string, { row: JobRow; doFee: number; em: number; storage: number; liftOn: number; liftOff: number; stars: number }>();
  for (const row of rows) {
    const key = `${row.sourceFile}|${String(row.bl).toUpperCase()}|${row.transportDate}`;
    const g = groups.get(key) || { row, doFee: 0, em: 0, storage: 0, liftOn: 0, liftOff: 0, stars: 0 };
    g.stars += (String(row.note || '').match(/\*/g) || []).length;
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
    if (g.em > 0) out.push({ ...base, category: 'EM', amount: round2(g.em), detail: 'EXTRA MOVEMENT', count: 1 });
    const lowLiftOn = g.liftOn > 0 && g.liftOn < WHT_LIFT_ON_MIN && g.row.transportDate <= WHT_LIFT_ON_MIN_UNTIL;
    const port = [['STORAGE', g.storage], ['LIFT ON', lowLiftOn ? 0 : g.liftOn], ['LIFT OFF', g.liftOff]] as const;
    const parts = port.filter(([, v]) => v > 0);
    if (parts.length) {
      const notes = [lowLiftOn ? `ไม่นับ LIFT ON ${fmt(round2(g.liftOn))} (ต่ำกว่า ${fmt(WHT_LIFT_ON_MIN)})` : '',
        g.stars > 1 ? `ใบเสร็จแยก ${g.stars} ใบ (*)` : ''].filter(Boolean);
      out.push({
        ...base, category: 'PORT', amount: round2(parts.reduce((s, [, v]) => s + v, 0)),
        detail: parts.map(([k, v]) => `${k} ${fmt(round2(v))}`).join(' + ') + (notes.length ? ` • ${notes.join(' • ')}` : ''),
        count: Math.max(1, g.stars)
      });
    }
  }
  const order = { DO: 0, EM: 1, PORT: 2 };
  return out.sort((a, b) => order[a.category] - order[b.category] || a.date.localeCompare(b.date) || a.bl.localeCompare(b.bl));
}

const blKey = (bl: unknown) => String(bl ?? '').toUpperCase().replace(/\s+/g, '');
const blBase = (bl: unknown) => blKey(bl).split('(')[0];

/**
 * ใบหักค่า DO — จากชีตค่าแลกดีโอ ตามวันที่จ่ายจริง (1 แถวในชีต = 1 ใบ)
 * ชีตนี้ไม่มีช่อง VESSEL จึงหาสายเรือจากชีตงานขนส่งด้วยเลข BL
 * เทียบทั้ง BL เต็ม และส่วนหน้าวงเล็บ (ในชีตบางแถวลืมปิดวงเล็บ เช่น "KG…-668571(ONEYTYOGD2073800")
 */
export function buildDoLines(entries: DoEntry[], vessels: Map<string, string>, from: string, to: string) {
  const lines: WhtLine[] = [];
  const unmatched: { date: string; bl: string; amount: number }[] = [];
  for (const e of entries) {
    if (e.date < from || e.date > to || !(e.amount > 0)) continue;
    const vessel = vessels.get(blKey(e.bl)) || vessels.get(blBase(e.bl)) || '';
    if (!vessel) { unmatched.push({ date: e.date, bl: e.bl, amount: e.amount }); continue; }
    const label = whtDoVessel(vessel);
    if (!label) continue;
    const extra = [e.note, /\+/.test(e.raw) ? `ยอดในชีต ${e.raw}` : ''].filter(Boolean).join(' • ');
    lines.push({ category: 'DO', date: e.date, bl: e.bl, vessel, source: `ชีตค่าแลกดีโอ (${e.tab})`,
      amount: e.amount, detail: `DO ${label}${extra ? ` • ${extra}` : ''}`, count: 1 });
  }
  return { lines, unmatched };
}

/** ข้อมูลใบหัก ณ ที่จ่ายตามช่วงวันที่ตรวจปล่อย (อ่านอย่างเดียว) */
export async function withholdingData(body: ApiBody): Promise<ApiResult> {
  const from = String(body.from || ''), to = String(body.to || '');
  if (!validYmd(from) || !validYmd(to) || from > to) return { ok: false, error: 'bad_date' };
  const rows = await db.select({
    id: transportJobs.id, transportDate: transportJobs.transportDate, bl: transportJobs.bl,
    vessel: transportJobs.vessel, sourceFile: transportJobs.sourceFile, doFee: transportJobs.doFee,
    extraMovement: transportJobs.extraMovement, storage: transportJobs.storage,
    liftOn: transportJobs.liftOn, liftOff: transportJobs.liftOff, note: transportJobs.note
  }).from(transportJobs)
    .where(and(gte(transportJobs.transportDate, from), lte(transportJobs.transportDate, to)))
    .orderBy(asc(transportJobs.transportDate), asc(transportJobs.id));
  const lines = buildWithholding(rows);

  // DO: วันที่จ่ายจากชีตค่าแลกดีโอ — อ่านไม่ได้ไม่ล้มทั้งหน้า ยังเห็นหมวดอื่น แต่บอกว่า DO ขาด
  let doLines: WhtLine[] = [], unmatched: { date: string; bl: string; amount: number }[] = [];
  let doError = '', doTabs: string[] = [];
  try {
    const sheet = await readDoSheet();
    doTabs = sheet.tabs;
    const known = await db.selectDistinct({ bl: transportJobs.bl, vessel: transportJobs.vessel })
      .from(transportJobs).where(ne(transportJobs.vessel, ''));
    const vessels = new Map<string, string>();
    for (const k of known) {
      if (!vessels.has(blKey(k.bl))) vessels.set(blKey(k.bl), k.vessel);
      if (!vessels.has(blBase(k.bl))) vessels.set(blBase(k.bl), k.vessel);
    }
    ({ lines: doLines, unmatched } = buildDoLines(sheet.entries, vessels, from, to));
  } catch (error) {
    doError = String((error as Error).message || error);
  }
  doLines.sort((a, b) => a.date.localeCompare(b.date) || a.bl.localeCompare(b.bl));

  return {
    ok: true, from, to, lines: [...doLines, ...lines], defaults: WHT_DEFAULT,
    vessels: WHT_DO_VESSELS.map((v) => v.label), doUnmatched: unmatched, doError, doTabs
  };
}
