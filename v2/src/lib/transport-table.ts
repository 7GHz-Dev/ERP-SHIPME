import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { transportJobs, transportRecords } from '@/db/schema';
import { noteExtras } from './service-invoices';
import { monthTabName, systemRows, systemTabs } from './transport-records';
import { prbAmount } from './shipping-reconcile';
import type { ApiBody, ApiResult } from './types';
import { round2 } from './utils';

/**
 * ตารางขนส่ง (อ่านอย่างเดียว) — ข้อมูลชุดเดียวกับชีตงานขนส่งที่ Apps Script sync เข้ามา (transport_jobs)
 * ทุกคนที่ล็อกอินเห็นทุกงานทุกคอลัมน์ ยกเว้นบัญชีพาร์ทเนอร์คนขับ (ttn-admin-driver)
 * หน้า admin แท็บ "ตารางขนส่ง" และหน้า /transport (ลิงก์จากหน้าพนักงาน) ใช้ตัวนี้
 *
 * รูปแบบตามแท็บ "สำเนาของ พฤศจิกายน69" ในชีต: 1 แถว = 1 BL (เลขตู้เรียงในช่องเดียว จำนวนตู้ = จำนวนเลขตู้)
 * คอลัมน์ พรบ. / ค่าบริการ พรบ. / ค่าแลก ER / น็อคตู้ / ยางเกิน / สำแดงเท็จ อ่านจากหมายเหตุ
 * (ตัวอ่านเดียวกับใบแจ้งหนี้ค่าบริการและรายได้ชิปปิ้ง) แล้วหักออกจาก คชจ. อื่นๆ ที่เป็นยอดรวมของรายการพวกนี้
 */
export const TRANSPORT_VIEW_ROLES = [
  'admin', 'manager', 'manager-account', 'employee-account', 'employee-shipping', 'employee-office'
];
const SOURCE_ORDER = ['MAESOT FREEZONE', 'TRANSIT'];
const MAX_TAB_ROWS = 5000;
const MAX_SEARCH_BLS = 300;
// แท็บสำเนาในชีต (ลองรูปแบบ/สูตร) ไม่ใช่งานจริง — ไม่แสดงในตาราง
const COPY_SHEET = /^\s*(สำเนา|copy\s+of\b)/i;
/**
 * งานตั้งแต่วันนี้ใช้ตารางของระบบ (transport_records) แทนชีต — แท็บเดือนในชีตที่เริ่มตั้งแต่วันนี้ไม่แสดง
 * เดือนก่อนหน้านี้ที่มีข้อมูลในระบบด้วย (นำเข้าทดลอง) แสดงเป็นแท็บแยก "<เดือน> (ระบบ)" เทียบกับชีตได้
 */
export const SYSTEM_FROM = '2026-12-01';

const columns = {
  id: transportJobs.id, transportDate: transportJobs.transportDate, shipping: transportJobs.shipping,
  customer: transportJobs.customer, vessel: transportJobs.vessel, bl: transportJobs.bl,
  containerNo: transportJobs.containerNo, port: transportJobs.port, quantity: transportJobs.quantity,
  doFee: transportJobs.doFee, dem: transportJobs.dem, extraMovement: transportJobs.extraMovement,
  storage: transportJobs.storage, liftOn: transportJobs.liftOn, liftOff: transportJobs.liftOff,
  orderForm: transportJobs.orderForm, inspectorFee: transportJobs.inspectorFee, overtime: transportJobs.overtime,
  sealFee: transportJobs.sealFee, otherFee: transportJobs.otherFee, detention: transportJobs.detention,
  repairFee: transportJobs.repairFee, note: transportJobs.note, driver: transportJobs.driver,
  settled: transportJobs.settled, docSentDate: transportJobs.docSentDate, invoiceNo: transportJobs.invoiceNo,
  source: transportJobs.sourceName, sheet: transportJobs.sourceSheet, sourceFile: transportJobs.sourceFile
};
type Raw = Awaited<ReturnType<typeof selectRows>>[number];
const selectRows = (where: any) => db.select(columns).from(transportJobs).where(where);

const MONEY = ['doFee', 'dem', 'extraMovement', 'storage', 'liftOn', 'liftOff', 'orderForm', 'inspectorFee',
  'overtime', 'sealFee', 'otherFee', 'detention', 'repairFee'] as const;
const FIRST = ['transportDate', 'shipping', 'customer', 'vessel', 'bl', 'port', 'docSentDate', 'invoiceNo', 'driver',
  'source', 'sheet'] as const;
/** หัวข้อในหมายเหตุ → คอลัมน์ (ป้ายจาก SERVICE_EXTRA_RULES) */
const EXTRA_COLUMN: Record<string, string> = {
  'ค่าบริการ พรบ.': 'prbService', 'ค่าแลก ER': 'er', 'ค่าน๊อคประตูออกจากท่า': 'knock', 'ยางเกิน': 'tire', 'สำแดงเท็จ': 'falseDecl'
};

const blKey = (bl: unknown) => String(bl ?? '').toUpperCase().replace(/\s+/g, '');

/**
 * ยุบแถวรายตู้ให้เหลือ BL ละแถว (ตามลำดับในชีต) — ยอดเงินรวมทุกแถวของ BL (ปกติลงไว้ที่แถวแรก)
 * BL เดียวกันคนละวันตรวจปล่อย (สายเรือใช้เลข BL ซ้ำ) = คนละแถว
 */
export function groupByBl(rows: Raw[]) {
  const out: any[] = [];
  const map = new Map<string, any>();
  for (const row of rows) {
    const key = row.bl ? `${row.source}|${row.sheet}|${row.transportDate}|${blKey(row.bl)}` : `#${row.id}`;
    let g = map.get(key);
    if (!g) {
      g = { key, id: row.id, containers: [] as string[], quantitySum: 0, notes: [] as string[], settled: false,
        prb: 0, prbService: 0, er: 0, knock: 0, tire: 0, falseDecl: 0, extrasInOther: 0 };
      for (const k of FIRST) g[k] = '';
      for (const k of MONEY) g[k] = 0;
      map.set(key, g);
      out.push(g);
    }
    for (const k of FIRST) if (!g[k] && row[k]) g[k] = String(row[k]).trim();
    for (const k of MONEY) g[k] = round2(g[k] + (Number(row[k]) || 0));
    for (const c of String(row.containerNo || '').split(/[\n,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean)) {
      if (!g.containers.includes(c)) g.containers.push(c);
    }
    g.quantitySum += Number(row.quantity) || 0;
    const note = String(row.note || '').trim();
    if (note && !g.notes.includes(note)) g.notes.push(note);
    if (row.settled) g.settled = true;

    // แยกรายการจากหมายเหตุของแถวนี้
    const prbAll = prbAmount(note);          // ค่าพรบ + ค่าบริการ พรบ.
    let extras = 0, service = 0;
    for (const line of noteExtras({ id: row.id, transportDate: row.transportDate, bl: row.bl, containerNo: row.containerNo,
      inspectorFee: row.inspectorFee, otherFee: row.otherFee, note, sourceFile: row.sourceFile })) {
      const col = EXTRA_COLUMN[line.label];
      if (!col) continue;
      g[col] = round2(g[col] + line.amount);
      if (col === 'prbService') service += line.amount;   // รวมอยู่ใน prbAll แล้ว
      else extras += line.amount;
    }
    g.prb = round2(g.prb + Math.max(0, prbAll - service));
    // รายการพวกนี้ปกติรวมอยู่ใน คชจ. อื่นๆ — หักออกเฉพาะเมื่อยอดไม่เกิน คชจ. อื่นๆ ของแถวนั้น
    const inOther = round2(prbAll + extras);
    if (inOther > 0 && inOther <= (Number(row.otherFee) || 0) + 0.01) g.extrasInOther = round2(g.extrasInOther + inOther);
  }
  return out.map((g) => ({
    id: g.id, transportDate: g.transportDate, customer: g.customer, vessel: g.vessel, bl: g.bl,
    containerNo: g.containers.join('\n'), quantity: g.containers.length || g.quantitySum,
    doFee: g.doFee, dem: g.dem, extraMovement: g.extraMovement, storage: g.storage, liftOn: g.liftOn, liftOff: g.liftOff,
    orderForm: g.orderForm, overtime: g.overtime, sealFee: g.sealFee, prb: g.prb, prbService: g.prbService,
    inspectorFee: g.inspectorFee, er: g.er, knock: g.knock, tire: g.tire, falseDecl: g.falseDecl,
    detention: g.detention, repairFee: g.repairFee, otherFee: round2(Math.max(0, g.otherFee - g.extrasInOther)),
    note: g.notes.join(' // '), port: g.port, docSentDate: g.docSentDate, shipping: g.shipping, invoiceNo: g.invoiceNo,
    driver: g.driver, settled: g.settled, source: g.source, sheet: g.sheet
  }));
}

/** รายชื่อแท็บ (ไฟล์ + เดือน) — ใหม่สุดก่อน ไม่รวมแท็บสำเนา */
async function listTabs() {
  const rows = await db.select({
    source: transportJobs.sourceName, sheet: transportJobs.sourceSheet,
    rows: sql<number>`count(*)::int`,
    bls: sql<number>`count(distinct upper(nullif(${transportJobs.bl}, '')))::int`,
    from: sql<string>`min(nullif(${transportJobs.transportDate}, ''))`,
    to: sql<string>`max(nullif(${transportJobs.transportDate}, ''))`,
    syncedAt: sql<string>`max(${transportJobs.importedAt})`
  }).from(transportJobs).groupBy(transportJobs.sourceName, transportJobs.sourceSheet);
  const rank = (source: string) => {
    const i = SOURCE_ORDER.indexOf(source);
    return i < 0 ? SOURCE_ORDER.length : i;
  };
  const sheetTabs = rows
    .filter((tab) => !COPY_SHEET.test(tab.sheet) && !(String(tab.from || '') >= SYSTEM_FROM))
    .map((tab) => ({ ...tab, system: false, month: '' }));
  const sys = (await systemTabs()).map((tab) => ({
    source: tab.source, rows: tab.rows, bls: tab.rows, from: tab.from, to: tab.to, syncedAt: tab.syncedAt,
    sheet: monthTabName(tab.month) + (`${tab.month}-01` < SYSTEM_FROM ? ' (ระบบ)' : ''), system: true, month: tab.month
  }));
  return [...sheetTabs, ...sys]
    .sort((a, b) => rank(a.source) - rank(b.source) || String(b.to || '').localeCompare(String(a.to || '')));
}

/**
 * body.source + body.sheet = ทั้งแท็บ (เรียงตามแถวในชีต)
 * body.q (≥ 3 ตัวอักษร) = ค้นทุกแท็บ: BL / เลขตู้ / ชิปเปอร์ / ชิปปิ้ง / คนรถ / หมายเหตุ / เลขที่ใบแจ้งหนี้ — คืนทั้ง BL ที่เจอ
 * ไม่ส่งอะไร = แท็บล่าสุดของ MAESOT FREEZONE
 */
export async function transportTable(body: ApiBody): Promise<ApiResult> {
  const tabs = await listTabs();
  const realSheets = [...new Set(tabs.filter((tab) => !tab.system).map((tab) => tab.sheet))];
  const q = String(body.q ?? '').trim().slice(0, 60);
  if (q) {
    if (q.length < 3) return { ok: false, error: 'search_too_short' };
    const like = `%${q.replace(/[%_\\]/g, '')}%`;
    const hits = await db.select({ bl: transportJobs.bl }).from(transportJobs)
      .where(and(
        realSheets.length ? inArray(transportJobs.sourceSheet, realSheets) : sql`false`,
        or(
          ilike(transportJobs.bl, like), ilike(transportJobs.containerNo, like), ilike(transportJobs.customer, like),
          ilike(transportJobs.shipping, like), ilike(transportJobs.driver, like), ilike(transportJobs.note, like),
          ilike(transportJobs.invoiceNo, like)
        )))
      .orderBy(desc(transportJobs.transportDate)).limit(2000);
    const bls = [...new Set(hits.map((h) => blKey(h.bl)).filter(Boolean))];
    const truncated = bls.length > MAX_SEARCH_BLS;
    const pick = bls.slice(0, MAX_SEARCH_BLS);
    const raw = pick.length ? await selectRows(and(
      inArray(transportJobs.sourceSheet, realSheets),
      inArray(sql`upper(regexp_replace(${transportJobs.bl}, '\\s+', '', 'g'))`, pick)
    )).orderBy(asc(transportJobs.id)) : [];
    // ตารางของระบบ: BL / ชิปเปอร์ / สายเรือ / เลขตู้
    const sys = await systemRows(or(
      ilike(transportRecords.bl, like), ilike(transportRecords.customer, like), ilike(transportRecords.vessel, like),
      ilike(transportRecords.containersJson, like)
    ));
    const rows = [...groupByBl(raw), ...sys].sort((a, b) => String(b.transportDate).localeCompare(String(a.transportDate)));
    return { ok: true, tabs, q, rows, truncated };
  }

  let source = String(body.source ?? '').trim();
  let sheet = String(body.sheet ?? '').trim();
  if (!tabs.some((tab) => tab.source === source && tab.sheet === sheet)) {
    const pick = tabs.find((tab) => tab.source === source) || tabs[0];
    source = pick?.source || '';
    sheet = pick?.sheet || '';
  }
  const tab = tabs.find((t) => t.source === source && t.sheet === sheet);
  if (tab?.system) {
    const rows = await systemRows(and(eq(transportRecords.source, source), sql`${transportRecords.transportDate} like ${tab.month + '-%'}`));
    return { ok: true, tabs, source, sheet, system: true, rows };
  }
  const raw = source ? await selectRows(and(eq(transportJobs.sourceName, source), eq(transportJobs.sourceSheet, sheet)))
    .orderBy(asc(transportJobs.id)).limit(MAX_TAB_ROWS) : [];
  return { ok: true, tabs, source, sheet, rows: groupByBl(raw) };
}
