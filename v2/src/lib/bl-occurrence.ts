import { inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { settlements, transportJobs } from '@/db/schema';
import { REUSED_BL_VESSELS } from './constants';

/**
 * BL ซ้ำข้ามงาน — บางสายเรือ (SEALS) เอาเลข BL เดิมมาใช้กับงานใหม่ในวันอื่น
 *
 * ระบบใบแจ้งหนี้เดิมถือว่า "1 BL = 1 งาน" จึงพังกับ BL พวกนี้ 3 แบบ:
 *   1) ออกใบให้งานแรกแล้ว งานที่สองหายจากหน้าออกใบใหม่ (ถือว่าออกไปแล้ว) ต้องไปพิมพ์ใบเอง
 *   2) ใบที่ไม่ผูกใบปิดบัญชี หาวันที่ตรวจปล่อยจาก BL แล้วหยิบแถวแรกของชีต = ได้วันที่ของงานเก่า
 *   3) ค่าแลก DO สำรองจากชีต รวมทุกแถวของ BL = ได้ยอดของสองงานบวกกัน
 * ไฟล์นี้รวมกติกาแยกงาน (BL + วันที่ตรวจปล่อย) ไว้ที่เดียว ให้ทุกจุดใช้ตรงกัน
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = any;

export const blKey = (bl: unknown) => String(bl ?? '').trim().toUpperCase();

/**
 * BL ที่ถูกใช้ซ้ำจริง — สายเรือที่ใช้เลข BL ซ้ำ (SEALS) และ BL นั้นมีงานในชีตมากกว่า 1 วันที่ตรวจปล่อย
 * BL ของ SEALS ที่มีงานเดียว ยังใช้กติกาเดิม (BL = งาน) ทุกอย่าง จะได้ไม่กระทบใบที่ออกไปแล้ว
 */
export async function reusedBls(bls: string[], q: Executor = db): Promise<Set<string>> {
  const keys = [...new Set(bls.map(blKey).filter(Boolean))];
  if (!keys.length || !REUSED_BL_VESSELS.length) return new Set();
  const rows: { bl: string }[] = await q.select({ bl: sql<string>`upper(${transportJobs.bl})` }).from(transportJobs)
    .where(sql`upper(${transportJobs.bl}) in ${keys}`)
    .groupBy(sql`upper(${transportJobs.bl})`)
    .having(sql`count(distinct ${transportJobs.transportDate}) > 1
      and bool_or(upper(trim(${transportJobs.vessel})) in ${REUSED_BL_VESSELS})`);
  return new Set(rows.map((row) => blKey(row.bl)));
}

/** กุญแจของ "งาน" — BL ปกติ = BL, BL ซ้ำข้ามงาน = BL|วันที่ตรวจปล่อย */
export function jobKey(bl: unknown, date: string, reused: Set<string>) {
  const key = blKey(bl);
  return reused.has(key) ? `${key}|${date}` : key;
}

/** เลขใบคู่ที่ชีตอาจกรอกไว้แทน — NV20261037 / NV20261037-D ในชีตมักกรอกแค่ V20261037 */
function numberAliases(number: string) {
  const out = new Set([number.toUpperCase()]);
  const m = /^(?:V|NV)(\d{6}\d{2,6})(?:-D)?$/i.exec(number);
  if (m) { out.add(`V${m[1]}`); out.add(`NV${m[1]}`); }
  return [...out];
}

type InvoiceRef = { number: string; bl: string; settlementId: string; issueDate: string };
export type Occurrence = { date: string; source: string };

/**
 * ใบแจ้งหนี้แต่ละใบเป็นของงานวันไหน
 *   1) ผูกใบปิดบัญชีไว้ → วันที่ตรวจปล่อยของใบปิดบัญชีนั้น
 *   2) ชีตงานขนส่งกรอกเลขที่ใบนี้ไว้ในคอลัมน์เลขที่ใบแจ้งหนี้ → วันที่ของแถวนั้น
 *   3) แถวล่าสุดของ BL ที่วันที่ไม่เกินวันออกใบ (ออกใบหลังงานเสมอ)
 *   4) ไม่เข้าเงื่อนไขไหนเลย → แถวแรกของ BL (พฤติกรรมเดิม)
 */
/** q = db หรือ tx — เรียกในทรานแซกชันต้องส่ง tx มา (pool มี connection เดียว ถ้าใช้ db จะค้างรอกันเอง) */
export async function invoiceOccurrences(list: InvoiceRef[], q: Executor = db): Promise<Map<string, Occurrence>> {
  const out = new Map<string, Occurrence>();
  if (!list.length) return out;
  const ids = [...new Set(list.map((inv) => inv.settlementId).filter(Boolean))];
  const settled = ids.length
    ? await q.select({ id: settlements.id, inspectDate: settlements.inspectDate, rowsJson: settlements.rowsJson })
      .from(settlements).where(inArray(settlements.id, ids))
    : [];
  const bls = [...new Set(list.map((inv) => blKey(inv.bl)).filter(Boolean))];
  const jobs = bls.length
    ? await q.select({ bl: transportJobs.bl, transportDate: transportJobs.transportDate, invoiceNo: transportJobs.invoiceNo,
      sourceName: transportJobs.sourceName, id: transportJobs.id })
      .from(transportJobs).where(inArray(sql`upper(${transportJobs.bl})`, bls))
      .orderBy(transportJobs.transportDate, transportJobs.id)
    : [];

  for (const inv of list) {
    const key = blKey(inv.bl);
    const rows = (jobs as { bl: string; transportDate: string; invoiceNo: string; sourceName: string }[]).filter((job) => blKey(job.bl) === key);
    const settlement = (settled as { id: string; inspectDate: string; rowsJson: string }[]).find((row) => row.id === inv.settlementId);
    if (settlement) {
      let source = '';
      try {
        const hit = (JSON.parse(settlement.rowsJson || '[]') as any[]).find((r) => blKey(r?.bl) === key && r?.source);
        source = String(hit?.source || '');
      } catch { /* ใบปิดบัญชีเก่าที่ rows เสีย */ }
      if (!source) source = rows.find((job) => job.transportDate === settlement.inspectDate)?.sourceName || rows[0]?.sourceName || '';
      out.set(inv.number, { date: settlement.inspectDate, source });
      continue;
    }
    const aliases = numberAliases(inv.number);
    const byNumber = rows.find((job) => {
      const cell = String(job.invoiceNo || '').toUpperCase();
      return cell && aliases.some((alias) => cell.split(/[^A-Z0-9-]+/).includes(alias));
    });
    const beforeIssue = inv.issueDate ? rows.filter((job) => job.transportDate <= inv.issueDate).at(-1) : undefined;
    const pick = byNumber || beforeIssue || rows[0];
    if (pick) out.set(inv.number, { date: pick.transportDate, source: pick.sourceName });
  }
  return out;
}
