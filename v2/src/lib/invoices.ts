import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { invoices, settlements, transportJobs } from '@/db/schema';
import {
  INVOICE_COMPANY, INVOICE_CUSTOMER, INVOICE_NO_VAT_ITEMS, INVOICE_VAT_ITEMS, INVOICE_DIVISOR, VAT_RATE
} from './constants';
import { id, nowIso, validYmd, ymd } from './utils';
import type { ApiBody, ApiResult } from './types';

/**
 * ใบแจ้งหนี้ที่ฝ่ายบัญชีออกจากใบปิดบัญชีของพนักงานชิปปิ้ง
 *
 * มี 2 แบบตามชีตต้นฉบับ ซึ่งต่างกันที่ "ที่มาของยอด" ไม่ใช่แค่คิด VAT หรือไม่:
 *   V  (มี VAT)    — หัวข้อ VAT จาก **ใบปิดบัญชี**
 *   NV (ไม่มี VAT) — ค่าแลก DO / ORDER FORM จากใบปิดบัญชี (DO ใช้งานขนส่งเป็นข้อมูลสำรอง)
 *
 * ยอดฝั่ง V หาร 1.04 เพื่อถอดค่าบริการ 4% ที่ใบปิดบัญชีบวกมาแล้ว ก่อนคิด VAT 7%
 * ส่วน NV เป็นเงินที่ออกแทนลูกค้าตรง ๆ จึงไม่ถอดอะไรและไม่มี VAT
 */

export type InvoiceItem = {
  no: number;
  label: string;
  qty: number;
  unitPrice: number;
  amount: number;
  note: string;
};

const money = (value: unknown) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  // ปัดเป็นสตางค์ตั้งแต่ต้นทาง ไม่งั้นเศษทศนิยมลอยจะไปโผล่ตอนรวมยอดแล้วต่างจากใบจริงหลักสตางค์
  return Math.round(n * 100) / 100;
};

const text = (value: unknown, max = 300) => String(value ?? '').trim().slice(0, max);

/** V20260901 — kind + yyyymm + เลขรัน 2 หลัก */
export function invoiceNumber(kind: string, period: string, seq: number) {
  return `${kind}${period}${String(seq).padStart(2, '0')}`;
}

/**
 * เลขรันถัดไปของเดือนนั้น — **นับรวมกันทั้ง V และ NV ไม่ได้แยกกัน**
 *
 * V เป็นตัวเดินเลข ส่วน NV ยืมเลขชุดเดียวกับ V ที่ออกคู่กัน:
 *   V20260905 + NV20260905   (ชุดนี้มีทั้งสองแบบ)
 *   V20260906                (ชุดนี้ไม่มี Non VAT → ข้าม NV20260906 ไปเลย)
 *   V20260907 + NV20260907
 * เลข NV จึงมีเว้นช่วงได้ แต่เลข V ต้องเรียงต่อกันเสมอ
 *
 * ถ้านับแยกกันแบบเดิม NV จะไหลไปคนละจังหวะกับ V แล้วใบคู่กันจะได้คนละเลข
 * (ของจริงเคยเป็นแบบนั้น: NV20260901 คู่กับ BL คนละใบกับ V20260901)
 *
 * รีเซ็ตเป็น 01 เมื่อขึ้นเดือนใหม่ — period เปลี่ยนจึงไม่เจอแถวเดิม max เป็น null แล้วเริ่ม 1
 */
export async function nextSeq(_kind: string, period: string) {
  const [row] = await db.select({ maxSeq: sql<number | null>`max(${invoices.seq})` })
    .from(invoices)
    .where(eq(invoices.period, period));
  return Number(row?.maxSeq ?? 0) + 1;
}

/** ยอดรวมของใบ — คิดที่เดียวทั้งตอน preview และตอนบันทึก จะได้ไม่มีทางเพี้ยนกัน */
export function invoiceTotals(items: InvoiceItem[], kind: string) {
  const subtotal = money(items.reduce((sum, item) => sum + Number(item.amount || 0), 0));
  const vat = kind === 'V' ? money(subtotal * VAT_RATE) : 0;
  const total = money(subtotal + vat);
  // หัก ณ ที่จ่ายในใบตัวอย่างเป็น "-" (ไม่หัก) ให้ตั้งเป็น 0 ไว้ก่อน แก้ได้ตอนกรอก
  return { subtotal, vat, total, withholding: 0, netTotal: total };
}

/**
 * ทำรายการใบแจ้งหนี้จากใบปิดบัญชี 1 ใบ เลือกเฉพาะ BL ที่ต้องการ
 * รวม costs ตามหัวข้อของประเภทใบ และใช้ค่าแลก DO จากงานขนส่งเป็นข้อมูลสำรอง
 */
type BuildResult =
  | { ok: false; error: ApiResult }
  | { ok: true; items: InvoiceItem[]; settlement: typeof settlements.$inferSelect; bl: string; customer: string };

export async function buildItems(kind: string, settlementId: string, bl: string): Promise<BuildResult> {
  const [settlement] = await db.select().from(settlements).where(eq(settlements.id, settlementId)).limit(1);
  if (!settlement) return { ok: false, error: { ok: false, error: 'settlement_not_found' } };

  let rows: any[] = [];
  try { rows = JSON.parse(settlement.rowsJson || '[]'); } catch { rows = []; }
  const wanted = text(bl).toUpperCase();
  const picked = wanted ? rows.filter((row) => String(row?.bl || '').toUpperCase() === wanted) : rows;
  if (!picked.length) return { ok: false, error: { ok: false, error: 'bl_not_found' } };

  const items: InvoiceItem[] = [];

  const catalog = kind === 'V' ? INVOICE_VAT_ITEMS : INVOICE_NO_VAT_ITEMS;
  for (const item of catalog) {
    let raw = picked.reduce((sum, row) => sum + (Number(row?.costs?.[item.key]) || 0), 0);
    // Prefer settlement amounts; retain transport DO fallback for older settlements.
    if (kind === 'NV' && item.key === 'do_fee' && raw <= 0) {
      const jobs = await db.select({ doFee: transportJobs.doFee }).from(transportJobs)
        .where(eq(sql`upper(${transportJobs.bl})`, wanted));
      raw = jobs.reduce((sum, job) => sum + (Number(job.doFee) || 0), 0);
    }
    if (raw <= 0) continue;
    const amount = money(kind === 'V' ? raw / INVOICE_DIVISOR : raw);
    items.push({ no: items.length + 1, label: item.label, qty: 0, unitPrice: 0, amount, note: '' });
  }

  const first = picked[0] || {};
  return {
    ok: true,
    items,
    settlement,
    bl: wanted || String(first.bl || ''),
    customer: String(first.customer || '')
  };
}

/** หน้าออกใบแจ้งหนี้เปิดมา — ส่งค่าตั้งต้นทั้งหมดที่ฟอร์มต้องใช้ */
export async function invoiceConfig(): Promise<ApiResult> {
  const period = ymd().slice(0, 7).replace('-', '');
  // เลขเดียวกันทั้งคู่ — NV ใช้เลขชุดเดียวกับ V ที่ออกพร้อมกัน
  const seq = await nextSeq('V', period);
  return {
    ok: true,
    company: INVOICE_COMPANY,
    customer: INVOICE_CUSTOMER,
    vatRate: VAT_RATE,
    divisor: INVOICE_DIVISOR,
    vatItems: INVOICE_VAT_ITEMS,
    noVatItems: INVOICE_NO_VAT_ITEMS,
    period,
    next: {
      V: invoiceNumber('V', period, seq),
      NV: invoiceNumber('NV', period, seq)
    }
  };
}

/**
 * รายการ BL ที่ยังไม่ได้ออกใบแจ้งหนี้ — ฝ่ายบัญชีเลือกจากตรงนี้
 * ดึงจากใบปิดบัญชีที่ปิดแล้ว แล้วตัด BL ที่เคยออกใบไปแล้วออก (กันออกซ้ำ)
 */
export async function invoiceSources(body: ApiBody): Promise<ApiResult> {
  const from = validYmd(body.from) ? String(body.from) : '';
  const to = validYmd(body.to) ? String(body.to) : '';

  let query = db.select({
    id: settlements.id, username: settlements.username, name: settlements.name,
    inspectDate: settlements.inspectDate, rowsJson: settlements.rowsJson
  }).from(settlements).$dynamic();

  const clauses = [];
  if (from) clauses.push(sql`${settlements.inspectDate} >= ${from}`);
  if (to) clauses.push(sql`${settlements.inspectDate} <= ${to}`);
  if (clauses.length) query = query.where(and(...clauses));

  const rows = await query.orderBy(asc(settlements.inspectDate), asc(settlements.id)).limit(300);

  const issued = await db.select({ bl: invoices.bl, kind: invoices.kind, number: invoices.number })
    .from(invoices).where(sql`${invoices.status} <> 'cancelled'`);
  const issuedMap = new Map<string, { V?: string; NV?: string }>();
  for (const row of issued) {
    const key = String(row.bl || '').toUpperCase();
    const entry = issuedMap.get(key) || {};
    entry[row.kind as 'V' | 'NV'] = row.number;
    issuedMap.set(key, entry);
  }

  const out: any[] = [];
  for (const settlement of rows) {
    let parsed: any[] = [];
    try { parsed = JSON.parse(settlement.rowsJson || '[]'); } catch { parsed = []; }
    // 1 BL อาจกระจายหลายแถว (หลายตู้) — ยุบให้เหลือรายการเดียวต่อ BL
    const byBl = new Map<string, any>();
    for (const row of parsed) {
      const key = String(row?.bl || '').toUpperCase();
      if (!key) continue;
      const group = byBl.get(key) || {
        bl: String(row.bl), customer: String(row.customer || ''), port: String(row.port || ''),
        containers: 0, vatBase: 0, costs: {}
      };
      group.containers += Number(row?.containers) || 0;
      for (const item of [...INVOICE_VAT_ITEMS, ...INVOICE_NO_VAT_ITEMS]) {
        group.costs[item.key] = (group.costs[item.key] || 0) + (Number(row?.costs?.[item.key]) || 0);
      }
      for (const item of INVOICE_VAT_ITEMS) group.vatBase += Number(row?.costs?.[item.key]) || 0;
      if (!group.customer && row?.customer) group.customer = String(row.customer);
      byBl.set(key, group);
    }
    for (const [key, group] of byBl) {
      out.push({
        settlementId: settlement.id,
        username: settlement.username,
        name: settlement.name,
        inspectDate: settlement.inspectDate,
        bl: group.bl,
        customer: group.customer,
        port: group.port,
        containers: group.containers,
        costs: group.costs,
        vatBase: money(group.vatBase),
        vatAmount: money(group.vatBase / INVOICE_DIVISOR),
        issued: issuedMap.get(key) || {}
      });
    }
  }

  const bls = [...new Set(out.map(row => String(row.bl).toUpperCase()))];
  const jobs = bls.length ? await db.select({ bl: transportJobs.bl, doFee: transportJobs.doFee })
    .from(transportJobs).where(inArray(sql`upper(${transportJobs.bl})`, bls)) : [];
  const doFees = new Map<string, number>();
  for (const job of jobs) {
    const key = String(job.bl).toUpperCase();
    doFees.set(key, (doFees.get(key) || 0) + (Number(job.doFee) || 0));
  }
  for (const row of out) {
    row.invoiceItems = {};
    for (const kind of ['V', 'NV']) {
      const catalog = kind === 'V' ? INVOICE_VAT_ITEMS : INVOICE_NO_VAT_ITEMS;
      row.invoiceItems[kind] = catalog.map(item => {
        let raw = row.costs[item.key] || 0;
        if (kind === 'NV' && item.key === 'do_fee' && raw <= 0) raw = doFees.get(String(row.bl).toUpperCase()) || 0;
        return { label: item.label, code: item.code, selected: raw > 0,
          amount: money(kind === 'V' ? raw / INVOICE_DIVISOR : raw) };
      });
    }
    delete row.costs;
  }
  return { ok: true, rows: out };
}

/** ดูรายการที่จะขึ้นใบก่อนบันทึกจริง — ให้ฝ่ายบัญชีตรวจยอดก่อนกินเลขรัน */
export async function invoicePreview(body: ApiBody): Promise<ApiResult> {
  const kind = text(body.kind) === 'NV' ? 'NV' : 'V';
  const built = await buildItems(kind, text(body.settlementId, 60), text(body.bl, 120));
  if (!built.ok) return built.error;
  const totals = invoiceTotals(built.items, kind);
  return { ok: true, kind, bl: built.bl, customer: built.customer, items: built.items, catalog: kind === 'V' ? INVOICE_VAT_ITEMS : INVOICE_NO_VAT_ITEMS, ...totals };
}

/**
 * บันทึกใบแจ้งหนี้ — เลขรันถูกจองในทรานแซกชันเดียวกับการ insert
 * ถ้าแยกกันแล้วมีคนกดพร้อมกัน 2 คน จะได้เลขเดียวกันทั้งคู่ (primary key จะกันไว้อีกชั้น)
 */
export async function saveInvoice(body: ApiBody, actor: { username: string; name: string }): Promise<ApiResult> {
  const kind = text(body.kind) === 'NV' ? 'NV' : 'V';
  const issueDate = validYmd(body.issueDate) ? String(body.issueDate) : ymd();
  const period = issueDate.slice(0, 7).replace('-', '');

  let items: InvoiceItem[] = Array.isArray(body.items) ? body.items.map((item: any, index: number) => ({
    no: index + 1,
    label: text(item?.label, 200),
    qty: Number(item?.qty) || 0,
    unitPrice: money(item?.unitPrice),
    amount: money(item?.amount),
    note: text(item?.note, 200)
  })).filter((item: InvoiceItem) => item.label || item.amount) : [];

  // ไม่ได้ส่งรายการมา = ให้ระบบสร้างจากใบปิดบัญชีให้ (ทางลัดของหน้าเว็บ)
  if (!Array.isArray(body.items)) {
    const built = await buildItems(kind, text(body.settlementId, 60), text(body.bl, 120));
    if (!built.ok) return built.error;
    items = built.items;
  }
  if (!items.length) return { ok: false, error: 'no_items' };

  const totals = invoiceTotals(items, kind);
  const now = nowIso();

  const saved = await db.transaction(async (tx) => {
    // นับรวมทั้ง V และ NV — ดู nextSeq ว่าทำไมถึงไม่แยก kind
    const [row] = await tx.select({ maxSeq: sql<number | null>`max(${invoices.seq})` })
      .from(invoices).where(eq(invoices.period, period));
    const seq = Number(row?.maxSeq ?? 0) + 1;
    if (seq > 99) throw new Error('seq_overflow');
    const number = invoiceNumber(kind, period, seq);

    await tx.insert(invoices).values({
      number, kind, period, seq, issueDate,
      customerName: text(body.customerName, 300) || INVOICE_CUSTOMER.name,
      customerAddress: text(body.customerAddress, 500) || INVOICE_CUSTOMER.address,
      customerTaxId: text(body.customerTaxId, 40) || INVOICE_CUSTOMER.taxId,
      bl: text(body.bl, 120),
      itemsJson: JSON.stringify(items),
      subtotal: totals.subtotal, vat: totals.vat, total: totals.total,
      withholding: totals.withholding, netTotal: totals.netTotal,
      note: text(body.note, 500),
      preparedBy: text(body.preparedBy, 120) || actor.name,
      settlementId: text(body.settlementId, 60),
      createdBy: actor.username, createdAt: now, updatedAt: now
    });
    return number;
  });

  return { ok: true, number: saved, ...totals };
}

/** รายการใบแจ้งหนี้ — employee-account เห็นเฉพาะของตัวเอง, manager-account เห็นทั้งหมด */
export async function listInvoices(body: ApiBody, actor: { username: string; role: string }): Promise<ApiResult> {
  const all = actor.role === 'manager-account' || actor.role === 'admin' || actor.role === 'manager';
  const clauses = [];
  if (!all) clauses.push(eq(invoices.createdBy, actor.username));
  if (validYmd(body.from)) clauses.push(sql`${invoices.issueDate} >= ${String(body.from)}`);
  if (validYmd(body.to)) clauses.push(sql`${invoices.issueDate} <= ${String(body.to)}`);

  const rows = await db.select().from(invoices)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(invoices.issueDate), desc(invoices.number))
    .limit(500);

  return {
    ok: true,
    canApprove: all,
    rows: rows.map((row) => ({
      ...row,
      items: (() => { try { return JSON.parse(row.itemsJson); } catch { return []; } })()
    }))
  };
}

/** อนุมัติ/ยกเลิกใบ — เฉพาะ manager-account (employee-account ออกใบได้แต่อนุมัติเองไม่ได้) */
export async function decideInvoice(body: ApiBody, actor: { username: string }): Promise<ApiResult> {
  const number = text(body.number, 40);
  const decision = text(body.decision, 20);
  if (!number) return { ok: false, error: 'bad_request' };
  if (decision !== 'approved' && decision !== 'cancelled' && decision !== 'draft') {
    return { ok: false, error: 'bad_decision' };
  }

  const [existing] = await db.select().from(invoices).where(eq(invoices.number, number)).limit(1);
  if (!existing) return { ok: false, error: 'invoice_not_found' };

  const now = nowIso();
  await db.update(invoices).set({
    status: decision,
    approvedBy: decision === 'draft' ? '' : actor.username,
    approvedAt: decision === 'draft' ? '' : now,
    updatedAt: now
  }).where(eq(invoices.number, number));

  return { ok: true, number, status: decision };
}

/**
 * ออกใบแจ้งหนี้หลายใบรวดเดียว — 1 BL ที่เลือก = 1 ใบ
 *
 * จองเลขรันทั้งชุดในทรานแซกชันเดียว ไม่ใช่วนเรียก saveInvoice ทีละใบ
 * เพราะถ้าแยกกันแล้วล้มกลางทาง จะได้ใบครึ่ง ๆ กลาง ๆ และเลขรันขาดช่วง
 * ตรวจครบทุกใบก่อน ถ้ามีใบไหนสร้างรายการไม่ได้จะไม่บันทึกอะไรเลย
 */
export async function saveInvoiceBatch(body: ApiBody, actor: { username: string; name: string }): Promise<ApiResult> {
  const kind = text(body.kind) === 'NV' ? 'NV' : 'V';
  const issueDate = validYmd(body.issueDate) ? String(body.issueDate) : ymd();
  const period = issueDate.slice(0, 7).replace('-', '');

  const targets = Array.isArray(body.targets) ? body.targets.slice(0, 50) : [];
  if (!targets.length) return { ok: false, error: 'no_targets' };

  // เตรียมรายการของทุกใบก่อน — ใบไหนไม่มีรายการให้ข้าม แล้วรายงานกลับไปว่าข้ามเพราะอะไร
  const prepared: { bl: string; customer: string; settlementId: string; items: InvoiceItem[] }[] = [];
  const skipped: { bl: string; reason: string }[] = [];

  for (const target of targets) {
    const settlementId = text(target?.settlementId, 60);
    const bl = text(target?.bl, 120);
    const built = await buildItems(kind, settlementId, bl);
    if (!built.ok) {
      skipped.push({ bl, reason: String(built.error.error || 'error') });
      continue;
    }
    if (Array.isArray(target?.items)) {
      built.items = target.items.map((item: any, index: number) => ({
        no: index + 1, label: text(item?.label, 200), qty: Number(item?.qty) || 0,
        unitPrice: money(item?.unitPrice), amount: money(item?.amount), note: text(item?.note, 200)
      })).filter((item: InvoiceItem) => item.label || item.amount);
    }
    if (!built.items.length) {
      // ฝั่ง NV เจอบ่อย เพราะ BL นั้นยังไม่มีค่าแลก DO ในชีตงานขนส่ง
      skipped.push({ bl, reason: 'no_items' });
      continue;
    }
    prepared.push({ bl: built.bl, customer: built.customer, settlementId, items: built.items });
  }

  if (!prepared.length) return { ok: false, error: 'no_items', skipped };

  const now = nowIso();
  const created = await db.transaction(async (tx) => {
    const [row] = await tx.select({ maxSeq: sql<number | null>`max(${invoices.seq})` })
      .from(invoices).where(eq(invoices.period, period));
    let seq = Number(row?.maxSeq ?? 0);
    const out: ApiResult[] = [];

    for (const entry of prepared) {
      seq += 1;
      if (seq > 99) throw new Error('seq_overflow');
      const number = invoiceNumber(kind, period, seq);
      const totals = invoiceTotals(entry.items, kind);
      await tx.insert(invoices).values({
        number, kind, period, seq, issueDate,
        customerName: INVOICE_CUSTOMER.name,
        customerAddress: INVOICE_CUSTOMER.address,
        customerTaxId: INVOICE_CUSTOMER.taxId,
        bl: entry.bl,
        itemsJson: JSON.stringify(entry.items),
        subtotal: totals.subtotal, vat: totals.vat, total: totals.total,
        withholding: totals.withholding, netTotal: totals.netTotal,
        note: '', preparedBy: actor.name,
        settlementId: entry.settlementId,
        createdBy: actor.username, createdAt: now, updatedAt: now
      });
      out.push({ number, bl: entry.bl, customer: entry.customer, ...totals });
    }
    return out;
  });

  return { ok: true, created, skipped, count: created.length };
}
