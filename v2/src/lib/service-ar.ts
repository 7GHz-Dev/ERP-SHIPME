import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '@/db';
import { serviceInvoices } from '@/db/schema';
import {
  INVOICE_COMPANY, INVOICE_CUSTOMER, SERVICE_BANK_ACCOUNT_NO, SERVICE_WITHHOLDING_RATE, VAT_RATE
} from './constants';
import type { ApiBody, ApiResult } from './types';
import { nowIso, safeJson, validYmd, ymd } from './utils';

/**
 * ใบแจ้งหนี้ค่าบริการ (IN) → ลูกหนี้คงค้างค่าบริการ → ใบเสร็จรับเงิน / ใบกำกับภาษี (RE)
 *
 * หน้าออกใบยังคำนวณเอกสารจากชีตงานขนส่งเหมือนเดิม (service-invoice.js) แค่กด "บันทึก" แล้วส่งเอกสารมาเก็บ
 * ฝั่งนี้คิดยอดซ้ำจากรายการเองทุกครั้ง ไม่เชื่อยอดรวมที่หน้าเว็บส่งมา
 *
 * ยอดลูกหนี้ = netTotal (รวม VAT แล้วหัก ณ ที่จ่าย 3%) เพราะลูกค้าโอนยอดหลังหักภาษี
 * ใบเสร็จใช้เลข RE + yyyymm + เลขรัน แยกจากเลขใบแจ้งหนี้ ออกได้เมื่อรับชำระครบแล้วเท่านั้น
 */

const money = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const text = (value: unknown, max = 300) => String(value ?? '').trim().slice(0, max);
const periodOf = (date: string) => date.slice(0, 7).replace('-', '');

/** หัวกระดาษของใบค่าบริการ — เหมือนใบ ADV ต่างแค่เลขบัญชีรับเงิน */
export const SERVICE_COMPANY = { ...INVOICE_COMPANY, bankAccountNo: SERVICE_BANK_ACCOUNT_NO };

function parseNumber(prefix: string, number: string) {
  const m = new RegExp(`^${prefix}(\\d{6})(\\d{2,4})$`).exec(number);
  return m ? { period: m[1], seq: Number(m[2]) } : null;
}

/** เลขใบแจ้งหนี้ค่าบริการถัดไปของเดือน (ช่องว่างจากใบที่ยกเลิกไม่ถอยกลับไปใช้ — ใบ IN เคยพิมพ์ออกนอกระบบมาก่อน) */
export async function serviceInvoiceNext(body: ApiBody): Promise<ApiResult> {
  const issueDate = validYmd(body.issueDate) ? String(body.issueDate) : ymd();
  const period = periodOf(issueDate);
  const [top] = await db.select({ seq: sql<number | null>`max(${serviceInvoices.seq})` })
    .from(serviceInvoices).where(eq(serviceInvoices.period, period));
  const seq = Number(top?.seq || 0) + 1;
  return { ok: true, period, seq, number: `IN${period}${String(seq).padStart(2, '0')}` };
}

type IncomingItem = { no: number; label: string; qty: number; unitPrice: number; amount: number; note: string; fit?: boolean };

/**
 * บันทึกใบแจ้งหนี้ค่าบริการทั้งชุดที่ทำบนหน้าจอ — ทุกใบต้องเป็นเดือนเดียวกับวันออกใบและเลขห้ามซ้ำ
 * ช่วงวันที่ตรวจปล่อยซ้อนกับใบที่ออกไปแล้ว (ไฟล์เดียวกัน) = อาจออกซ้ำ ต้องยืนยัน force ก่อน
 */
export async function saveServiceInvoices(body: ApiBody, actor: { username: string; name: string }): Promise<ApiResult> {
  if (!validYmd(body.issueDate)) return { ok: false, error: 'bad_date' };
  const issueDate = String(body.issueDate);
  const period = periodOf(issueDate);
  const docs = Array.isArray(body.docs) ? body.docs.slice(0, 20) : [];
  if (!docs.length) return { ok: false, error: 'no_documents' };

  const at = nowIso();
  const rows: (typeof serviceInvoices.$inferInsert)[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    const number = text(doc?.number, 20).toUpperCase();
    const parsed = parseNumber('IN', number);
    if (!parsed || parsed.period !== period) return { ok: false, error: 'bad_number', number };
    if (seen.has(number)) return { ok: false, error: 'duplicate_number', number };
    seen.add(number);
    const items: IncomingItem[] = (Array.isArray(doc?.items) ? doc.items : []).slice(0, 30).map((it: any, i: number) => ({
      no: i + 1, label: text(it?.label, 400), qty: Number(it?.qty) || 0, unitPrice: money(it?.unitPrice),
      amount: money(it?.amount), note: text(it?.note, 200), fit: Boolean(it?.fit)
    })).filter((it: IncomingItem) => it.label && it.amount > 0);
    if (!items.length) return { ok: false, error: 'no_items', number };
    const subtotal = money(items.reduce((s, it) => s + it.amount, 0));
    const vat = money(subtotal * VAT_RATE);
    const total = money(subtotal + vat);
    const withholding = money(subtotal * SERVICE_WITHHOLDING_RATE);
    const category = doc?.category === 'extra' ? 'extra' : 'inspect';
    rows.push({
      number, period, seq: parsed.seq, issueDate,
      title: text(doc?.title, 200) || 'ใบแจ้งหนี้ค่าบริการ', category, source: text(doc?.source, 60),
      rangeFrom: validYmd(doc?.rangeFrom) ? String(doc.rangeFrom) : '', rangeTo: validYmd(doc?.rangeTo) ? String(doc.rangeTo) : '',
      customerName: text(doc?.customerName, 200) || INVOICE_CUSTOMER.name,
      customerAddress: text(doc?.customerAddress, 300) || INVOICE_CUSTOMER.address,
      customerTaxId: text(doc?.customerTaxId, 30) || INVOICE_CUSTOMER.taxId,
      itemsJson: JSON.stringify(items),
      // ใบสรุปที่แนบคู่ (ใบสรุปจำนวนตู้ / ค่าบริการเพิ่มเติม) — เก็บไว้พิมพ์ซ้ำ จำกัดขนาดกันข้อมูลบวม
      summaryJson: doc?.summary ? JSON.stringify(doc.summary).slice(0, 200000) : '',
      subtotal, vat, total, withholding, netTotal: money(total - withholding),
      preparedBy: actor.name, createdBy: actor.username, createdAt: at, updatedAt: at
    });
  }

  const existing = await db.select({ number: serviceInvoices.number }).from(serviceInvoices)
    .where(inArray(serviceInvoices.number, [...seen]));
  if (existing.length) return { ok: false, error: 'number_used', numbers: existing.map((r) => r.number) };

  if (!body.force) {
    // ใบตรวจปล่อยไฟล์เดียวกันที่ช่วงวันที่ซ้อนกัน / ค่าบริการเพิ่มเติมช่วงซ้อนกัน = น่าจะออกซ้ำ
    const overlaps: { number: string; title: string; rangeFrom: string; rangeTo: string }[] = [];
    for (const row of rows) {
      if (!row.rangeFrom || !row.rangeTo) continue;
      const hits = await db.select({
        number: serviceInvoices.number, title: serviceInvoices.title,
        rangeFrom: serviceInvoices.rangeFrom, rangeTo: serviceInvoices.rangeTo
      }).from(serviceInvoices).where(and(
        eq(serviceInvoices.category, row.category!), eq(serviceInvoices.source, row.source || ''),
        lte(serviceInvoices.rangeFrom, row.rangeTo), gte(serviceInvoices.rangeTo, row.rangeFrom)
      ));
      overlaps.push(...hits);
    }
    if (overlaps.length) return { ok: false, error: 'range_overlap', overlaps };
  }

  try {
    await db.insert(serviceInvoices).values(rows);
  } catch (error) {
    if (String(error).includes('service_invoices_pkey')) return { ok: false, error: 'number_used' };
    throw error;
  }
  return { ok: true, count: rows.length, numbers: rows.map((r) => r.number) };
}

function view(row: typeof serviceInvoices.$inferSelect) {
  return {
    number: row.number, issueDate: row.issueDate, title: row.title, category: row.category, source: row.source,
    rangeFrom: row.rangeFrom, rangeTo: row.rangeTo,
    subtotal: row.subtotal, vat: row.vat, total: row.total, withholding: row.withholding, netTotal: row.netTotal,
    paidAmount: row.paidAmount, paidAt: row.paidAt, receiptNo: row.receiptNo, receiptDate: row.receiptDate,
    outstanding: money(row.netTotal - row.paidAmount), preparedBy: row.preparedBy, createdAt: row.createdAt
  };
}

/** ใบค่าบริการที่ออกแล้ว / ลูกหนี้คงค้างค่าบริการ — กรองวันที่ออกใบได้ */
export async function listServiceInvoices(body: ApiBody): Promise<ApiResult> {
  const clauses = [];
  if (validYmd(body.from)) clauses.push(gte(serviceInvoices.issueDate, String(body.from)));
  if (validYmd(body.to)) clauses.push(lte(serviceInvoices.issueDate, String(body.to)));
  if (body.outstandingOnly === true) clauses.push(sql`${serviceInvoices.paidAmount} < ${serviceInvoices.netTotal}`);
  const rows = await db.select().from(serviceInvoices)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(asc(serviceInvoices.issueDate), asc(serviceInvoices.number)).limit(1000);
  return { ok: true, rows: rows.map(view), company: SERVICE_COMPANY, customer: INVOICE_CUSTOMER, today: ymd() };
}

/** เอกสารเต็มสำหรับพิมพ์ซ้ำ — ใบสรุปที่แนบ + ใบแจ้งหนี้ */
export async function getServiceInvoice(body: ApiBody): Promise<ApiResult> {
  const [row] = await db.select().from(serviceInvoices).where(eq(serviceInvoices.number, text(body.number, 20))).limit(1);
  if (!row) return { ok: false, error: 'invoice_not_found' };
  return {
    ok: true, company: SERVICE_COMPANY,
    invoice: { ...view(row), customerName: row.customerName, customerAddress: row.customerAddress, customerTaxId: row.customerTaxId,
      items: safeJson(row.itemsJson, []), summary: row.summaryJson ? safeJson(row.summaryJson, null) : null }
  };
}

/** ยกเลิก = ลบใบทิ้ง (เหมือนใบ ADV) — ใบที่รับชำระหรือออกใบเสร็จแล้วยกเลิกไม่ได้ */
export async function cancelServiceInvoices(body: ApiBody): Promise<ApiResult> {
  const numbers = Array.isArray(body.numbers) ? [...new Set(body.numbers.map((n: unknown) => text(n, 20)).filter(Boolean))] as string[] : [];
  if (!numbers.length) return { ok: false, error: 'no_invoices' };
  const rows = await db.select().from(serviceInvoices).where(inArray(serviceInvoices.number, numbers));
  const locked = rows.filter((r) => r.paidAmount > 0 || r.receiptNo);
  if (locked.length) return { ok: false, error: 'already_paid', numbers: locked.map((r) => r.number) };
  await db.delete(serviceInvoices).where(inArray(serviceInvoices.number, numbers));
  return { ok: true, count: rows.length };
}

/** ตรวจไฟล์ Excel — คอลัมน์ A = เลขใบแจ้งหนี้ค่าบริการ, B = ยอดเงิน (ยังไม่บันทึก) */
export async function matchServiceReceivables(body: ApiBody): Promise<ApiResult> {
  const input = Array.isArray(body.rows) ? body.rows.slice(0, 1000) : [];
  if (!input.length) return { ok: false, error: 'no_rows' };
  const wanted = [...new Set(input.map((r: any) => text(r?.number, 20).toUpperCase()).filter(Boolean))] as string[];
  if (!wanted.length) return { ok: false, error: 'no_invoice_numbers' };
  const found = await db.select().from(serviceInvoices).where(inArray(serviceInvoices.number, wanted));
  const byNumber = new Map(found.map((r) => [r.number, r]));
  const matched: any[] = [], problems: any[] = [];
  for (const raw of input) {
    const number = text(raw?.number, 20).toUpperCase();
    const amount = money(raw?.amount);
    const inv = byNumber.get(number);
    if (!inv) { problems.push({ number, reason: 'ไม่พบใบนี้ในระบบ' }); continue; }
    if (!(amount > 0)) { problems.push({ number, reason: 'ยอดเงินไม่ถูกต้อง' }); continue; }
    const outstanding = money(inv.netTotal - inv.paidAmount);
    if (outstanding <= 0) { problems.push({ number, reason: 'ใบนี้รับชำระครบแล้ว' }); continue; }
    matched.push({ number, title: inv.title, amount, netTotal: inv.netTotal, total: inv.total, outstanding, diff: money(amount - outstanding) });
  }
  return { ok: true, matched, problems, count: matched.length };
}

export async function settleServiceReceivables(body: ApiBody): Promise<ApiResult> {
  const input = Array.isArray(body.rows) ? body.rows.slice(0, 500) : [];
  const paidAt = validYmd(body.paidAt) ? String(body.paidAt) : ymd();
  const updated: any[] = [];
  await db.transaction(async (tx) => {
    for (const raw of input) {
      const number = text(raw?.number, 20).toUpperCase();
      const amount = money(raw?.amount);
      if (!number || !(amount > 0)) continue;
      const [inv] = await tx.select().from(serviceInvoices).where(eq(serviceInvoices.number, number)).limit(1);
      if (!inv) continue;
      const paid = money(inv.paidAmount + amount);
      await tx.update(serviceInvoices).set({ paidAmount: paid, paidAt, updatedAt: nowIso() }).where(eq(serviceInvoices.number, number));
      updated.push({ number, paidAmount: paid, outstanding: money(inv.netTotal - paid) });
    }
  });
  if (!updated.length) return { ok: false, error: 'nothing_updated' };
  return { ok: true, updated, count: updated.length, paidAt };
}

/** ยกเลิกการชำระ — ใบที่ออกใบเสร็จแล้วต้องยืนยันล้างเลขใบเสร็จด้วย */
export async function unsettleServiceReceivables(body: ApiBody): Promise<ApiResult> {
  const numbers = Array.isArray(body.numbers) ? [...new Set(body.numbers.map((n: unknown) => text(n, 20)).filter(Boolean))] as string[] : [];
  if (!numbers.length) return { ok: false, error: 'no_invoices' };
  const rows = await db.select().from(serviceInvoices).where(inArray(serviceInvoices.number, numbers));
  const withReceipt = rows.filter((r) => r.receiptNo);
  if (withReceipt.length && !body.alsoClearReceipt) return { ok: false, error: 'has_receipt', numbers: withReceipt.map((r) => r.number) };
  const patch: Partial<typeof serviceInvoices.$inferInsert> = { paidAmount: 0, paidAt: '', updatedAt: nowIso() };
  if (body.alsoClearReceipt) { patch.receiptNo = ''; patch.receiptDate = ''; }
  await db.update(serviceInvoices).set(patch).where(inArray(serviceInvoices.number, numbers));
  return { ok: true, count: rows.length };
}

/**
 * ออกใบเสร็จรับเงิน / ใบกำกับภาษี — RE + yyyymm (ของวันที่ใบเสร็จ) + เลขรัน 2 หลัก รันแยกจากเลขใบแจ้งหนี้
 * ใบที่เคยออกแล้วคืนเลขเดิม (พิมพ์ซ้ำได้) ไม่ออกเลขใหม่
 */
export async function issueServiceReceipts(body: ApiBody): Promise<ApiResult> {
  const numbers = Array.isArray(body.numbers) ? [...new Set(body.numbers.map((n: unknown) => text(n, 20)).filter(Boolean))] as string[] : [];
  if (!numbers.length) return { ok: false, error: 'no_invoices' };
  const receiptDate = validYmd(body.receiptDate) ? String(body.receiptDate) : ymd();
  const period = periodOf(receiptDate);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(71942031)`);
    const rows = await tx.select().from(serviceInvoices).where(inArray(serviceInvoices.number, numbers))
      .orderBy(asc(serviceInvoices.issueDate), asc(serviceInvoices.number));
    const unpaid = rows.filter((r) => r.paidAmount < r.netTotal - 0.009);
    if (unpaid.length) return { ok: false, error: 'not_fully_paid', numbers: unpaid.map((r) => r.number) };
    const [top] = await tx.select({ maxNo: sql<number | null>`max(cast(substring(${serviceInvoices.receiptNo} from 9) as integer))` })
      .from(serviceInvoices).where(sql`${serviceInvoices.receiptNo} ~ ${'^RE' + period + '[0-9]+$'}`);
    let seq = Number(top?.maxNo ?? 0);
    const issued: any[] = [];
    for (const inv of rows) {
      let receiptNo = inv.receiptNo, date = inv.receiptDate;
      const reused = Boolean(receiptNo);
      if (!reused) {
        seq += 1;
        receiptNo = `RE${period}${String(seq).padStart(2, '0')}`;
        date = receiptDate;
        await tx.update(serviceInvoices).set({ receiptNo, receiptDate: date, updatedAt: nowIso() })
          .where(eq(serviceInvoices.number, inv.number));
      }
      issued.push({
        ...view(inv), receiptNo, receiptDate: date, reused,
        customerName: inv.customerName, customerAddress: inv.customerAddress, customerTaxId: inv.customerTaxId,
        items: safeJson(inv.itemsJson, [])
      });
    }
    return { ok: true, issued, company: SERVICE_COMPANY };
  });
}
