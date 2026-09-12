import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import { invoices } from '@/db/schema';
import { nowIso, validYmd, ymd } from './utils';
import type { ApiBody, ApiResult } from './types';

const text = (value: unknown, max = 300) => String(value ?? '').trim().slice(0, max);
const money = (value: unknown) => Math.round((Number(value) || 0) * 100) / 100;

/** "ชุดที่ 01/09" — เลขชุด 2 หลัก ทับเดือน 2 หลัก */
export function batchLabel(batchNo: number, period: string) {
  return `ชุดที่ ${String(batchNo).padStart(2, '0')}/${period.slice(4, 6)}`;
}

/** ข้อความสรุปชุดสำหรับส่งให้ KOLA */
export function batchMessage(batchNo: number, period: string, count: number, sentDate: string) {
  const [y, m, d] = String(sentDate || '').split('-');
  const thai = y ? `${d}/${m}/${y}` : sentDate;
  return `${batchLabel(batchNo, period)} เอกสาร ${count} ชุด ฝากส่งไปวันที่ ${thai}`;
}

/**
 * จัดใบที่เลือกเข้าชุดเดียวกัน แล้วคืนข้อความสรุป
 * เลขชุดนับใหม่ทุกเดือน (batchPeriod เปลี่ยน = max กลับเป็น null แล้วเริ่ม 1)
 * ใบที่อยู่ในชุดแล้วจะไม่ถูกจัดซ้ำ — ป้องกันเลขชุดเดินโดยไม่ตั้งใจ
 */
export async function createInvoiceBatch(body: ApiBody): Promise<ApiResult> {
  const numbers = Array.isArray(body.numbers)
    ? [...new Set(body.numbers.map((n: unknown) => text(n, 40)).filter(Boolean))] : [];
  if (!numbers.length) return { ok: false, error: 'no_invoices' };
  if (numbers.length > 200) return { ok: false, error: 'too_many' };

  const sentDate = validYmd(body.sentDate) ? String(body.sentDate) : ymd();
  // เลขชุดกับเดือนมาจากหน้าเว็บ — ผู้ใช้เลือกเองว่าจะใส่ชุดไหน
  // ไม่ส่งมาก็ใช้เดือนของวันที่ฝากส่งและเลขถัดไปตามเดิม
  const monthInput = text(body.month, 2);
  const period = /^(0[1-9]|1[0-2])$/.test(monthInput)
    ? sentDate.slice(0, 4) + monthInput
    : sentDate.slice(0, 7).replace('-', '');
  const wantedNo = Number(body.batchNo);
  const hasWanted = Number.isInteger(wantedNo);
  if (hasWanted && (wantedNo < 1 || wantedNo > 99)) return { ok: false, error: 'bad_batch_no' };

  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(71942027)`);
    const rows = await tx.select({ number: invoices.number, batchNo: invoices.batchNo, status: invoices.status })
      .from(invoices).where(inArray(invoices.number, numbers));
    if (rows.length !== numbers.length) {
      const found = new Set(rows.map(r => r.number));
      return { ok: false, error: 'invoice_not_found', missing: numbers.filter(n => !found.has(n)) };
    }
    const already = rows.filter(r => r.batchNo != null);
    if (already.length) return { ok: false, error: 'already_batched', numbers: already.map(r => r.number) };
    const cancelled = rows.filter(r => r.status === 'cancelled');
    if (cancelled.length) return { ok: false, error: 'invoice_cancelled', numbers: cancelled.map(r => r.number) };

    let batchNo: number;
    if (hasWanted) {
      // เลขชุดที่เลือกต้องยังไม่มีใครใช้ในเดือนนั้น ไม่งั้นจะไปปนกับชุดเดิม
      const [taken] = await tx.select({ number: invoices.number }).from(invoices)
        .where(and(eq(invoices.batchPeriod, period), eq(invoices.batchNo, wantedNo))).limit(1);
      if (taken) return { ok: false, error: 'batch_no_used', batchNo: wantedNo, period };
      batchNo = wantedNo;
    } else {
      const [top] = await tx.select({ maxNo: sql<number | null>`max(${invoices.batchNo})` })
        .from(invoices).where(eq(invoices.batchPeriod, period));
      batchNo = Number(top?.maxNo ?? 0) + 1;
    }

    const name = batchLabel(batchNo, period);
    await tx.update(invoices)
      .set({ batchNo, batchPeriod: period, batchSentDate: sentDate, batchName: name, updatedAt: nowIso() })
      .where(inArray(invoices.number, numbers));

    return {
      ok: true, batchNo, period, sentDate, count: numbers.length,
      label: name,
      message: batchMessage(batchNo, period, numbers.length, sentDate)
    };
  });
}

/**
 * ถอนใบออกจากชุด — ยกเลิกการจัดชุดที่เพิ่งทำไป
 * ทำได้เฉพาะชุดที่ยังไม่ส่ง KOLA เพราะส่งไปแล้วถือว่าเอกสารออกจากมือเราแล้ว
 * เลขชุดที่ว่างลงไม่ถูกนำกลับมาใช้ซ้ำ (batchNo เดินจาก max เสมอ) กันชนกับชุดเดิม
 */
export async function unbatchInvoices(body: ApiBody): Promise<ApiResult> {
  const numbers = Array.isArray(body.numbers)
    ? [...new Set(body.numbers.map((n: unknown) => text(n, 40)).filter(Boolean))] : [];
  if (!numbers.length) return { ok: false, error: 'no_invoices' };
  if (numbers.length > 200) return { ok: false, error: 'too_many' };

  const rows = await db.select({ number: invoices.number, batchNo: invoices.batchNo, sentToKola: invoices.sentToKola })
    .from(invoices).where(inArray(invoices.number, numbers));
  if (rows.length !== numbers.length) {
    const found = new Set(rows.map(r => r.number));
    return { ok: false, error: 'invoice_not_found', missing: numbers.filter(n => !found.has(n)) };
  }
  const sent = rows.filter(r => r.sentToKola);
  if (sent.length) return { ok: false, error: 'already_sent_to_kola', numbers: sent.map(r => r.number) };
  const loose = rows.filter(r => r.batchNo == null);
  if (loose.length) return { ok: false, error: 'not_batched', numbers: loose.map(r => r.number) };

  await db.update(invoices)
    .set({ batchNo: null, batchPeriod: '', batchSentDate: '', batchName: '', updatedAt: nowIso() })
    .where(inArray(invoices.number, numbers));
  return { ok: true, count: numbers.length, numbers };
}

/** เปลี่ยนชื่อชุด — เลขชุดยังเป็นตัวเดิม แค่ชื่อที่แสดงเปลี่ยน */
export async function renameInvoiceBatch(body: ApiBody): Promise<ApiResult> {
  const batchNo = Number(body.batchNo);
  const period = text(body.period, 6);
  const name = text(body.name, 80);
  if (!Number.isInteger(batchNo) || !period) return { ok: false, error: 'bad_request' };
  if (!name) return { ok: false, error: 'bad_name' };

  const scope = and(eq(invoices.batchNo, batchNo), eq(invoices.batchPeriod, period));
  const rows = await db.select({ number: invoices.number }).from(invoices).where(scope);
  if (!rows.length) return { ok: false, error: 'batch_not_found' };

  await db.update(invoices).set({ batchName: name, updatedAt: nowIso() }).where(scope);
  return { ok: true, batchNo, period, name, count: rows.length };
}

/**
 * กดส่ง KOLA — ชุดย้ายไปแถบ รอลูกค้ารับเอกสาร
 * ใบยังอยู่ที่เดิม แค่ติดสถานะ ยังไม่เข้าลูกหนี้จนกว่าลูกค้าจะรับว่าเอกสารถูกต้อง
 */
export async function sendBatchToKola(body: ApiBody): Promise<ApiResult> {
  const batchNo = Number(body.batchNo);
  const period = text(body.period, 6);
  if (!Number.isInteger(batchNo) || !period) return { ok: false, error: 'bad_request' };

  const scope = and(eq(invoices.batchNo, batchNo), eq(invoices.batchPeriod, period));
  const rows = await db.select({ number: invoices.number }).from(invoices).where(scope);
  if (!rows.length) return { ok: false, error: 'batch_not_found' };

  await db.update(invoices)
    .set({ sentToKola: true, docStatus: 'waiting', updatedAt: nowIso() }).where(scope);
  return { ok: true, batchNo, period, count: rows.length };
}

/**
 * ชุดที่มีอยู่แล้ว — หน้าเว็บเอาไปกันเลขชน และทำรายการชุดให้เลือกพิมพ์หน้าปก
 */
export async function listInvoiceBatches(): Promise<ApiResult> {
  const rows = await db.select({
    batchNo: invoices.batchNo, period: invoices.batchPeriod,
    sentDate: invoices.batchSentDate, name: invoices.batchName,
    sentToKola: invoices.sentToKola, total: invoices.total
  }).from(invoices)
    .where(and(isNotNull(invoices.batchNo), ne(invoices.status, 'cancelled')))
    .limit(2000);

  const map = new Map<string, any>();
  for (const row of rows) {
    const key = `${row.period}/${row.batchNo}`;
    let batch = map.get(key);
    if (!batch) {
      batch = {
        key, batchNo: Number(row.batchNo), period: row.period, sentDate: row.sentDate,
        name: row.name || batchLabel(Number(row.batchNo), row.period),
        count: 0, total: 0, sentToKola: true
      };
      map.set(key, batch);
    }
    batch.count += 1;
    batch.total = money(batch.total + Number(row.total));
    // ชุดถือว่าส่งแล้วก็ต่อเมื่อทุกใบส่งแล้ว
    if (!row.sentToKola) batch.sentToKola = false;
  }
  const batches = [...map.values()]
    .sort((a, b) => a.period.localeCompare(b.period) || a.batchNo - b.batchNo);
  return { ok: true, batches };
}

/** ชุดที่ส่ง KOLA แล้วและยังรอลูกค้ารับเอกสาร — จัดกลุ่มเป็นรายชุด */
export async function listPendingDocs(): Promise<ApiResult> {
  const rows = await db.select({
    number: invoices.number, kind: invoices.kind, issueDate: invoices.issueDate,
    bl: invoices.bl, total: invoices.total,
    batchNo: invoices.batchNo, batchPeriod: invoices.batchPeriod,
    batchSentDate: invoices.batchSentDate, batchName: invoices.batchName,
    needsFix: invoices.needsFix, fixNote: invoices.fixNote, fixedAt: invoices.fixedAt
  })
    .from(invoices)
    .where(and(eq(invoices.docStatus, 'waiting'), ne(invoices.status, 'cancelled')))
    .orderBy(asc(invoices.batchPeriod), asc(invoices.batchNo), asc(invoices.number))
    .limit(1000);

  const batches = new Map<string, any>();
  for (const row of rows) {
    const key = `${row.batchPeriod}/${row.batchNo}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = {
        key, batchNo: row.batchNo, period: row.batchPeriod, sentDate: row.batchSentDate,
        name: row.batchName || batchLabel(Number(row.batchNo), row.batchPeriod),
        rows: [], total: 0, needsFixCount: 0
      };
      batches.set(key, batch);
    }
    batch.rows.push(row);
    batch.total = money(batch.total + Number(row.total));
    if (row.needsFix) batch.needsFixCount += 1;
  }
  return { ok: true, batches: [...batches.values()], count: rows.length };
}

/** ขอบเขตของคำสั่งในแถบรอลูกค้ารับ — ทั้งชุด หรือเลือกเป็นรายใบ */
function docScope(body: ApiBody): { where: any } | { ok: false; error: string } {
  const numbers = Array.isArray(body.numbers)
    ? [...new Set(body.numbers.map((n: unknown) => text(n, 40)).filter(Boolean))] : [];
  if (numbers.length) {
    if (numbers.length > 500) return { ok: false, error: 'too_many' };
    return { where: and(inArray(invoices.number, numbers), eq(invoices.docStatus, 'waiting')) };
  }
  const batchNo = Number(body.batchNo);
  const period = text(body.period, 6);
  if (!Number.isInteger(batchNo) || !period) return { ok: false, error: 'bad_request' };
  return { where: and(eq(invoices.batchNo, batchNo), eq(invoices.batchPeriod, period), eq(invoices.docStatus, 'waiting')) };
}

/**
 * ลูกค้ารับเอกสารแล้วและตรวจว่าถูกต้อง — ใบเข้าลูกหนี้สำรองจ่ายคงค้าง
 * รับได้ทั้งทั้งชุด (batchNo + period) หรือระบุเป็นรายใบ
 */
export async function acceptDocs(body: ApiBody, actor: { username: string }): Promise<ApiResult> {
  const scope = docScope(body);
  if ('error' in scope) return scope as ApiResult;

  const rows = await db.select({ number: invoices.number }).from(invoices).where(scope.where);
  if (!rows.length) return { ok: false, error: 'nothing_to_accept' };

  // รับว่าถูกต้องแล้วก็เคลียร์ธงต้องแก้ทิ้ง ถือว่าจบเรื่องนั้นไป
  await db.update(invoices).set({
    docStatus: 'accepted', needsFix: false, fixNote: '',
    fixedBy: actor.username, fixedAt: nowIso(), updatedAt: nowIso()
  }).where(scope.where);
  return { ok: true, count: rows.length, numbers: rows.map(r => r.number) };
}

/**
 * ลูกค้าแจ้งว่าต้องแก้ไข — ใบยังค้างอยู่ในแถบรอรับเหมือนเดิม แค่ติดธงพร้อมเหตุผล
 * ไม่ย้ายไปไหน เพราะเรื่องยังไม่จบจนกว่าจะแก้แล้วลูกค้ารับ
 */
export async function flagDocsForFix(body: ApiBody, actor: { username: string }): Promise<ApiResult> {
  const note = text(body.note, 500);
  if (!note) return { ok: false, error: 'bad_note' };
  const scope = docScope(body);
  if ('error' in scope) return scope as ApiResult;

  const rows = await db.select({ number: invoices.number }).from(invoices).where(scope.where);
  if (!rows.length) return { ok: false, error: 'nothing_to_flag' };

  await db.update(invoices).set({
    needsFix: true, fixNote: note, fixedBy: actor.username, fixedAt: nowIso(), updatedAt: nowIso()
  }).where(scope.where);
  return { ok: true, count: rows.length, numbers: rows.map(r => r.number), note };
}

/** เคลียร์ธงต้องแก้ไขหลังแก้เอกสารเสร็จ — ใบกลับไปรอลูกค้ารับตามปกติ */
export async function clearDocFix(body: ApiBody, actor: { username: string }): Promise<ApiResult> {
  const scope = docScope(body);
  if ('error' in scope) return scope as ApiResult;

  const rows = await db.select({ number: invoices.number }).from(invoices).where(scope.where);
  if (!rows.length) return { ok: false, error: 'nothing_to_clear' };

  await db.update(invoices).set({
    needsFix: false, fixNote: '', fixedBy: actor.username, fixedAt: nowIso(), updatedAt: nowIso()
  }).where(scope.where);
  return { ok: true, count: rows.length, numbers: rows.map(r => r.number) };
}

/** ลูกหนี้สำรองจ่ายคงค้าง — ใบที่ส่ง KOLA แล้วและยังไม่ปิดยอด */
export async function listReceivables(body: ApiBody): Promise<ApiResult> {
  const showPaid = body.showPaid === true;
  // เข้าลูกหนี้ต่อเมื่อลูกค้ารับเอกสารว่าถูกต้องแล้วเท่านั้น
  // ใบเก่าที่ส่ง KOLA ไปก่อนมีขั้นตอนนี้ (docStatus ว่าง) ยังนับเป็นลูกหนี้เหมือนเดิม
  const clauses = [eq(invoices.sentToKola, true), ne(invoices.status, 'cancelled'),
    ne(invoices.docStatus, 'waiting')];
  if (!showPaid) clauses.push(sql`${invoices.paidAmount} < ${invoices.total}`);

  const rows = await db.select({
    number: invoices.number, kind: invoices.kind, issueDate: invoices.issueDate,
    bl: invoices.bl, total: invoices.total, paidAmount: invoices.paidAmount,
    paidAt: invoices.paidAt, receiptNo: invoices.receiptNo,
    batchNo: invoices.batchNo, batchPeriod: invoices.batchPeriod
  })
    .from(invoices).where(and(...clauses))
    .orderBy(asc(invoices.issueDate), asc(invoices.number)).limit(500);

  return {
    ok: true,
    rows: rows.map(r => ({ ...r, outstanding: money(Number(r.total) - Number(r.paidAmount)) }))
  };
}

/**
 * ตรวจไฟล์ Excel ที่อัปมา — คอลัมน์ A=BL, B=เลขใบแจ้งหนี้, C=ยอดชำระ
 * ฝั่งหน้าเว็บอ่านไฟล์เป็นแถวแล้วส่งมาเป็น JSON เพื่อไม่ต้องอัปไฟล์จริงขึ้นเซิร์ฟเวอร์
 * ตรงนี้แค่จับคู่กับใบในระบบแล้วบอกว่าตรง/ไม่ตรงตรงไหน ยังไม่บันทึกอะไร
 */
export async function matchReceivables(body: ApiBody): Promise<ApiResult> {
  const input = Array.isArray(body.rows) ? body.rows.slice(0, 1000) : [];
  if (!input.length) return { ok: false, error: 'no_rows' };

  const wanted = [...new Set(input.map((r: any) => text(r?.number, 40)).filter(Boolean))];
  if (!wanted.length) return { ok: false, error: 'no_invoice_numbers' };

  const found = await db.select({
    number: invoices.number, bl: invoices.bl, total: invoices.total,
    paidAmount: invoices.paidAmount, sentToKola: invoices.sentToKola, status: invoices.status
  }).from(invoices).where(inArray(invoices.number, wanted));
  const byNumber = new Map(found.map(r => [r.number, r]));

  const matched: any[] = [], problems: any[] = [];
  for (const raw of input) {
    const number = text(raw?.number, 40);
    const bl = text(raw?.bl, 120);
    const amount = money(raw?.amount);
    if (!number) { problems.push({ bl, number, reason: 'ไม่มีเลขใบแจ้งหนี้' }); continue; }
    const inv = byNumber.get(number);
    if (!inv) { problems.push({ bl, number, reason: 'ไม่พบใบนี้ในระบบ' }); continue; }
    if (inv.status === 'cancelled') { problems.push({ bl, number, reason: 'ใบถูกยกเลิกแล้ว' }); continue; }
    if (bl && inv.bl.toUpperCase() !== bl.toUpperCase()) {
      problems.push({ bl, number, reason: `BL ไม่ตรง (ในระบบคือ ${inv.bl})` }); continue;
    }
    const outstanding = money(Number(inv.total) - Number(inv.paidAmount));
    matched.push({
      number, bl: inv.bl, amount, total: money(inv.total), outstanding,
      // เตือนเมื่อยอดไม่เท่ากับที่ค้าง แต่ยังให้รับชำระได้ (จ่ายบางส่วน/จ่ายเกิน)
      diff: money(amount - outstanding)
    });
  }
  return { ok: true, matched, problems, count: matched.length };
}

/** รับชำระตามที่ตรวจแล้ว — บวกยอดสะสม ไม่ทับของเดิม */
export async function settleReceivables(body: ApiBody, actor: { username: string }): Promise<ApiResult> {
  const input = Array.isArray(body.rows) ? body.rows.slice(0, 500) : [];
  if (!input.length) return { ok: false, error: 'no_rows' };
  const paidAt = validYmd(body.paidAt) ? String(body.paidAt) : ymd();

  const updated: any[] = [];
  await db.transaction(async (tx) => {
    for (const raw of input) {
      const number = text(raw?.number, 40);
      const amount = money(raw?.amount);
      if (!number || !(amount > 0)) continue;
      const [inv] = await tx.select().from(invoices).where(eq(invoices.number, number)).limit(1);
      if (!inv || inv.status === 'cancelled') continue;
      const paid = money(Number(inv.paidAmount) + amount);
      await tx.update(invoices).set({ paidAmount: paid, paidAt, updatedAt: nowIso() })
        .where(eq(invoices.number, number));
      updated.push({ number, paidAmount: paid, total: money(inv.total), outstanding: money(Number(inv.total) - paid) });
    }
  });
  if (!updated.length) return { ok: false, error: 'nothing_updated' };
  return { ok: true, updated, count: updated.length, paidAt, by: actor.username };
}

/** ออกเลขใบเสร็จให้ใบที่ชำระครบแล้ว */
export async function issueReceipts(body: ApiBody): Promise<ApiResult> {
  const numbers = Array.isArray(body.numbers)
    ? [...new Set(body.numbers.map((n: unknown) => text(n, 40)).filter(Boolean))] : [];
  if (!numbers.length) return { ok: false, error: 'no_invoices' };

  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(71942028)`);
    const rows = await tx.select().from(invoices).where(inArray(invoices.number, numbers));
    const unpaid = rows.filter(r => Number(r.paidAmount) < Number(r.total));
    if (unpaid.length) return { ok: false, error: 'not_fully_paid', numbers: unpaid.map(r => r.number) };

    const period = ymd().slice(0, 7).replace('-', '');
    const [top] = await tx.select({ maxNo: sql<number | null>`max(cast(nullif(regexp_replace(${invoices.receiptNo}, '^RC[0-9]{6}', ''), '') as integer))` })
      .from(invoices).where(sql`${invoices.receiptNo} like ${'RC' + period + '%'}`);
    let seq = Number(top?.maxNo ?? 0);

    const issued: any[] = [];
    for (const inv of rows) {
      if (inv.receiptNo) { issued.push({ number: inv.number, receiptNo: inv.receiptNo, reused: true }); continue; }
      seq += 1;
      const receiptNo = `RC${period}${String(seq).padStart(2, '0')}`;
      await tx.update(invoices).set({ receiptNo, updatedAt: nowIso() }).where(eq(invoices.number, inv.number));
      issued.push({ number: inv.number, receiptNo, bl: inv.bl, total: money(inv.total), issueDate: inv.issueDate });
    }
    return { ok: true, issued, count: issued.length };
  });
}
