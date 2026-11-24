import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { transportJobs } from '@/db/schema';
import type { ApiBody, ApiResult } from './types';

/**
 * ตารางขนส่ง (อ่านอย่างเดียว) — ข้อมูลชุดเดียวกับชีตงานขนส่งที่ Apps Script sync เข้ามา (transport_jobs)
 * ทุกคนที่ล็อกอินเห็นทุกงานทุกคอลัมน์ ยกเว้นบัญชีพาร์ทเนอร์คนขับ (ttn-admin-driver)
 * หน้า admin แท็บ "ตารางขนส่ง" และหน้า /transport (ลิงก์จากหน้าพนักงาน) ใช้ตัวนี้
 */
export const TRANSPORT_VIEW_ROLES = [
  'admin', 'manager', 'manager-account', 'employee-account', 'employee-shipping', 'employee-office'
];
const SOURCE_ORDER = ['MAESOT FREEZONE', 'TRANSIT'];
const MAX_TAB_ROWS = 3000;
const MAX_SEARCH_ROWS = 500;

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
  source: transportJobs.sourceName, sheet: transportJobs.sourceSheet
};

/** รายชื่อแท็บ (ไฟล์ + เดือน) — ใหม่สุดก่อน */
async function listTabs() {
  const rows = await db.select({
    source: transportJobs.sourceName, sheet: transportJobs.sourceSheet,
    rows: sql<number>`count(*)::int`,
    from: sql<string>`min(nullif(${transportJobs.transportDate}, ''))`,
    to: sql<string>`max(nullif(${transportJobs.transportDate}, ''))`,
    syncedAt: sql<string>`max(${transportJobs.importedAt})`
  }).from(transportJobs).groupBy(transportJobs.sourceName, transportJobs.sourceSheet);
  const rank = (source: string) => {
    const i = SOURCE_ORDER.indexOf(source);
    return i < 0 ? SOURCE_ORDER.length : i;
  };
  return rows.sort((a, b) => rank(a.source) - rank(b.source) || String(b.to || '').localeCompare(String(a.to || '')));
}

/**
 * body.source + body.sheet = ทั้งแท็บ (เรียงตามแถวในชีต)
 * body.q (≥ 3 ตัวอักษร) = ค้นทุกแท็บ: BL / เลขตู้ / ชิปเปอร์ / ชิปปิ้ง / คนรถ / หมายเหตุ / เลขที่ใบแจ้งหนี้
 * ไม่ส่งอะไร = แท็บล่าสุดของ MAESOT FREEZONE
 */
export async function transportTable(body: ApiBody): Promise<ApiResult> {
  const tabs = await listTabs();
  const q = String(body.q ?? '').trim().slice(0, 60);
  if (q) {
    if (q.length < 3) return { ok: false, error: 'search_too_short' };
    const like = `%${q.replace(/[%_\\]/g, '')}%`;
    const rows = await db.select(columns).from(transportJobs)
      .where(or(
        ilike(transportJobs.bl, like), ilike(transportJobs.containerNo, like), ilike(transportJobs.customer, like),
        ilike(transportJobs.shipping, like), ilike(transportJobs.driver, like), ilike(transportJobs.note, like),
        ilike(transportJobs.invoiceNo, like)
      ))
      .orderBy(desc(transportJobs.transportDate), asc(transportJobs.id))
      .limit(MAX_SEARCH_ROWS + 1);
    return { ok: true, tabs, q, rows: rows.slice(0, MAX_SEARCH_ROWS), truncated: rows.length > MAX_SEARCH_ROWS };
  }

  let source = String(body.source ?? '').trim();
  let sheet = String(body.sheet ?? '').trim();
  if (!tabs.some((tab) => tab.source === source && tab.sheet === sheet)) {
    const pick = tabs.find((tab) => tab.source === source) || tabs[0];
    source = pick?.source || '';
    sheet = pick?.sheet || '';
  }
  const rows = source ? await db.select(columns).from(transportJobs)
    .where(and(eq(transportJobs.sourceName, source), eq(transportJobs.sourceSheet, sheet)))
    .orderBy(asc(transportJobs.id))
    .limit(MAX_TAB_ROWS) : [];
  return { ok: true, tabs, source, sheet, rows };
}
