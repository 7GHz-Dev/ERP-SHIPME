import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '@/db';
import { appOptions, ledgerEntries, ledgerVouchers } from '@/db/schema';
import { INVOICE_COMPANY } from './constants';
import type { ApiBody, ApiResult } from './types';
import { id, nowIso, round2, safeJson, ymd } from './utils';

/**
 * บัญชีรับจ่ายบริษัท: กรอกรายการในสมุดประจำเดือน (เลือกจากรายการตั้งค่าได้) → สิ้นเดือนเลือกหลายรายการ ออกใบสำคัญจ่าย (PV) / รับ (RV) ทีเดียว
 *
 * ยอดสุทธิคิดซ้ำที่ฝั่งนี้ทุกครั้ง (ก่อนภาษี + VAT − หัก ณ ที่จ่าย) ไม่เชื่อยอดที่หน้าเว็บส่งมา
 * รายการที่อยู่ในใบสำคัญแล้วแก้/ลบไม่ได้ — ต้องยกเลิกใบสำคัญก่อน ยอดในใบที่พิมพ์ไปแล้วจึงตรงกับสมุดเสมอ
 * เลขใบสำคัญ = PV|RV + yyyymm ของวันที่ในใบ + เลขรัน (2–3 หลัก) — เลขถัดไป = ต่อจากเลขสูงสุดในระบบ
 * แก้เลขเองได้ เพราะเดือนที่เริ่มใช้ระบบเคยออกใบสำคัญจาก Excel ไปแล้ว
 */

const DIRECTIONS = ['in', 'out'];
const WHT_TYPES = ['', 'pnd3', 'pnd53'];
const PAY_METHODS = ['', 'cash', 'transfer', 'cheque'];
const KIND_DIRECTION: Record<string, string> = { PV: 'out', RV: 'in' };
const MAX_VOUCHER_SEQ = 999;
const MAX_BATCH = 300;

const text = (value: unknown, max = 300) => String(value ?? '').trim().slice(0, max);
const money = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? round2(n) : NaN;
};
/** yyyy-MM-dd เต็มรูปแบบเท่านั้น — วันที่เก็บเป็นข้อความ เทียบช่วงด้วยการเรียงตัวอักษร */
const validYmd = (value: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''));
const periodOf = (date: string) => date.slice(0, 7).replace('-', '');
const voucherNumber = (kind: string, period: string, seq: number) => `${kind}${period}${String(seq).padStart(2, '0')}`;

function monthRange(body: ApiBody) {
  const today = ymd();
  const from = validYmd(body.from) ? String(body.from) : `${today.slice(0, 7)}-01`;
  const to = validYmd(body.to) ? String(body.to) : `${today.slice(0, 7)}-31`;
  return { from, to };
}

function entryView(row: typeof ledgerEntries.$inferSelect) {
  return {
    id: row.id, entryDate: row.entryDate, direction: row.direction, description: row.description, qty: row.qty,
    amount: row.amount, vat: row.vat, whtType: row.whtType, whtRate: row.whtRate, wht: row.wht, net: row.net,
    payMethod: row.payMethod, payRef: row.payRef, party: row.party, note: row.note, voucherNo: row.voucherNo,
    createdBy: row.createdBy, createdAt: row.createdAt, updatedBy: row.updatedBy, updatedAt: row.updatedAt
  };
}

/** หัวกระดาษใบสำคัญ / สมุดรายรับ-รายจ่าย */
const COMPANY = {
  name: INVOICE_COMPANY.name, address: INVOICE_COMPANY.address, taxId: INVOICE_COMPANY.taxId, logoUrl: INVOICE_COMPANY.logoUrl
};

/** รายการตามช่วงวันที่ (ค่าเริ่มต้น = เดือนนี้) + รายการตั้งค่า + คำที่เคยใช้ (รายการ / ผู้รับ-ผู้จ่าย) ไว้เติมอัตโนมัติ */
export async function ledgerList(body: ApiBody): Promise<ApiResult> {
  const { from, to } = monthRange(body);
  const rows = await db.select().from(ledgerEntries)
    .where(and(gte(ledgerEntries.entryDate, from), lte(ledgerEntries.entryDate, to)))
    .orderBy(asc(ledgerEntries.entryDate), asc(ledgerEntries.createdAt)).limit(3000);
  const recent = await db.select({ description: ledgerEntries.description, party: ledgerEntries.party })
    .from(ledgerEntries).orderBy(desc(ledgerEntries.createdAt)).limit(1000);
  const uniq = (list: string[]) => [...new Set(list.filter(Boolean))].slice(0, 300);
  return {
    ok: true, from, to, today: ymd(), company: COMPANY, rows: rows.map(entryView), presets: await readPresets(),
    suggest: { descriptions: uniq(recent.map((r) => r.description)), parties: uniq(recent.map((r) => r.party)) }
  };
}

/** ตรวจ + คิดยอดของรายการ 1 แถว */
function cleanEntry(input: any) {
  const entryDate = String(input?.entryDate || '');
  if (!validYmd(entryDate)) return { error: 'bad_date' };
  const direction = String(input?.direction || '');
  if (!DIRECTIONS.includes(direction)) return { error: 'bad_direction' };
  const description = text(input?.description);
  if (!description) return { error: 'missing_description' };
  const qty = input?.qty === '' || input?.qty == null ? 1 : Number(input.qty);
  const amount = money(input?.amount), vat = money(input?.vat || 0);
  const whtType = String(input?.whtType || '');
  if (!WHT_TYPES.includes(whtType)) return { error: 'bad_wht_type' };
  const whtRate = whtType ? Number(input?.whtRate) || 0 : 0;
  const wht = whtType ? money(input?.wht || 0) : 0;
  if (!(qty > 0) || qty > 1e6) return { error: 'bad_qty' };
  if (!(amount >= 0) || !(vat >= 0) || !(wht >= 0) || !(whtRate >= 0 && whtRate <= 15) || amount > 1e10) return { error: 'bad_amount' };
  if (!(amount > 0 || vat > 0)) return { error: 'bad_amount' };
  const net = round2(amount + vat - wht);
  if (net < 0) return { error: 'wht_over_amount' };
  const payMethod = String(input?.payMethod || '');
  if (!PAY_METHODS.includes(payMethod)) return { error: 'bad_pay_method' };
  return {
    value: {
      entryDate, direction, description, qty: round2(qty), amount, vat, whtType, whtRate, wht, net, payMethod,
      payRef: payMethod === 'cheque' || payMethod === 'transfer' ? text(input?.payRef, 120) : '',
      party: text(input?.party, 200), note: text(input?.note, 300)
    }
  };
}

/** เพิ่ม / แก้รายการ (มี id = แก้) — รายการที่ออกใบสำคัญแล้วแก้ไม่ได้ */
export async function ledgerSave(body: ApiBody, actor: { username: string }): Promise<ApiResult> {
  const cleaned = cleanEntry(body.entry);
  if (!cleaned.value) return { ok: false, error: cleaned.error };
  const now = nowIso(), entryId = text(body.entry?.id, 40);
  if (entryId) {
    const [row] = await db.update(ledgerEntries)
      .set({ ...cleaned.value, updatedBy: actor.username, updatedAt: now })
      .where(and(eq(ledgerEntries.id, entryId), eq(ledgerEntries.voucherNo, ''))).returning();
    if (row) return { ok: true, entry: entryView(row) };
    const [exists] = await db.select({ voucherNo: ledgerEntries.voucherNo }).from(ledgerEntries).where(eq(ledgerEntries.id, entryId)).limit(1);
    return exists ? { ok: false, error: 'entry_locked', voucherNo: exists.voucherNo } : { ok: false, error: 'entry_not_found' };
  }
  const [row] = await db.insert(ledgerEntries).values({
    id: id('LG'), ...cleaned.value, createdBy: actor.username, createdAt: now, updatedBy: actor.username, updatedAt: now
  }).returning();
  return { ok: true, entry: entryView(row) };
}

/** ลบรายการ — ข้ามไม่ได้ถ้ามีรายการไหนอยู่ในใบสำคัญ (ไม่ลบเลยสักแถว) */
export async function ledgerDelete(body: ApiBody): Promise<ApiResult> {
  const ids = (Array.isArray(body.ids) ? body.ids : []).map((v: unknown) => text(v, 40)).filter(Boolean).slice(0, 500);
  if (!ids.length) return { ok: false, error: 'no_rows' };
  const locked = await db.select({ id: ledgerEntries.id, voucherNo: ledgerEntries.voucherNo }).from(ledgerEntries)
    .where(and(inArray(ledgerEntries.id, ids), sql`${ledgerEntries.voucherNo} <> ''`));
  if (locked.length) return { ok: false, error: 'entry_locked', numbers: [...new Set(locked.map((r) => r.voucherNo))] };
  const gone = await db.delete(ledgerEntries).where(inArray(ledgerEntries.id, ids)).returning({ id: ledgerEntries.id });
  return { ok: true, count: gone.length };
}

async function nextSeq(kind: string, period: string) {
  const [row] = await db.select({ max: sql<number>`coalesce(max(${ledgerVouchers.seq}), 0)` }).from(ledgerVouchers)
    .where(and(eq(ledgerVouchers.kind, kind), eq(ledgerVouchers.period, period)));
  return Number(row?.max || 0) + 1;
}

/** เลขใบสำคัญถัดไปของเดือน (ต่อจากเลขสูงสุดในระบบ) */
export async function voucherNext(body: ApiBody): Promise<ApiResult> {
  const kind = String(body.kind || '');
  if (!KIND_DIRECTION[kind]) return { ok: false, error: 'bad_kind' };
  const date = validYmd(body.voucherDate) ? String(body.voucherDate) : ymd();
  const period = periodOf(date), seq = await nextSeq(kind, period);
  return { ok: true, number: voucherNumber(kind, period, seq), seq };
}

/**
 * ออกใบสำคัญทีละหลายรายการ (สิ้นเดือนเลือกทั้งหมดแล้วกดทีเดียว) — 1 รายการ = 1 ใบ วันที่ในใบ = วันที่ของรายการ
 * รายจ่าย → PV / รายรับ → RV เลขรันเรียงตามวันที่ ต่อจากเลขสูงสุดของเดือนนั้น (ข้ามเลขที่มีอยู่แล้ว)
 * starts.PV / starts.RV = เลขเริ่มต้นที่แก้เอง (เช่นเดือนแรกที่ต่อจากใบที่ออกใน Excel) ใช้กับเดือนของเลขนั้นเท่านั้น
 * ผูกรายการกับใบในทรานแซกชันเดียว: มีรายการที่ถูกผูกกับใบอื่นไปก่อน (กดพร้อมกัน 2 คน) = ยกเลิกทั้งชุด
 */
export async function voucherIssue(body: ApiBody, actor: { username: string; name: string }): Promise<ApiResult> {
  const ids = [...new Set((Array.isArray(body.entryIds) ? body.entryIds : []).map((v: unknown) => text(v, 40)).filter(Boolean))] as string[];
  if (!ids.length) return { ok: false, error: 'no_rows' };
  if (ids.length > MAX_BATCH) return { ok: false, error: 'too_many_lines' };
  const entries = await db.select().from(ledgerEntries).where(inArray(ledgerEntries.id, ids))
    .orderBy(asc(ledgerEntries.entryDate), asc(ledgerEntries.createdAt));
  if (entries.length !== ids.length) return { ok: false, error: 'entry_not_found' };
  const taken = entries.filter((e) => e.voucherNo);
  if (taken.length) return { ok: false, error: 'entry_locked', numbers: [...new Set(taken.map((e) => e.voucherNo))] };

  // เลขเริ่มต้นที่แก้เอง
  const starts: Record<string, { period: string; seq: number }> = {};
  for (const kind of Object.keys(KIND_DIRECTION)) {
    const typed = text(body.starts?.[kind], 20).toUpperCase().replace(/\s+/g, '');
    if (!typed) continue;
    const m = new RegExp(`^${kind}(\\d{6})(\\d{1,4})$`).exec(typed);
    if (!m || !Number(m[2]) || Number(m[2]) > MAX_VOUCHER_SEQ) return { ok: false, error: 'bad_number', number: typed };
    starts[kind] = { period: m[1], seq: Number(m[2]) };
  }
  // เลขที่ใช้ไปแล้วของเดือนที่เกี่ยวข้อง
  const periods = [...new Set(entries.map((e) => periodOf(e.entryDate)))];
  const usedRows = await db.select({ kind: ledgerVouchers.kind, period: ledgerVouchers.period, seq: ledgerVouchers.seq })
    .from(ledgerVouchers).where(inArray(ledgerVouchers.period, periods));
  const used = new Map<string, Set<number>>();
  for (const r of usedRows) {
    const key = `${r.kind}${r.period}`;
    if (!used.has(key)) used.set(key, new Set());
    used.get(key)!.add(r.seq);
  }
  const cursor = new Map<string, number>();
  const preparedBy = text(body.preparedBy, 120) || actor.name || actor.username, createdAt = nowIso();
  const vouchers: (typeof ledgerVouchers.$inferInsert)[] = [];
  for (const e of entries) {
    const kind = e.direction === 'in' ? 'RV' : 'PV', period = periodOf(e.entryDate), key = kind + period;
    const set = used.get(key) || new Set<number>();
    used.set(key, set);
    let seq = cursor.get(key) ?? (starts[kind]?.period === period ? starts[kind].seq : Math.max(0, ...set) + 1);
    while (set.has(seq)) seq++;
    if (seq > MAX_VOUCHER_SEQ) return { ok: false, error: 'seq_overflow' };
    set.add(seq); cursor.set(key, seq + 1);
    vouchers.push({
      number: voucherNumber(kind, period, seq), kind, period, seq, voucherDate: e.entryDate, party: e.party,
      payMethod: e.payMethod, payRef: e.payRef, amount: e.amount, vat: e.vat, wht: e.wht, net: e.net,
      preparedBy, createdBy: actor.username, createdAt
    });
  }
  try {
    await db.transaction(async (tx) => {
      await tx.insert(ledgerVouchers).values(vouchers);
      const pairs = sql.join(entries.map((e, i) => sql`(${e.id}, ${vouchers[i].number})`), sql`, `);
      const linked = await tx.execute(sql`update ledger_entries as e set voucher_no = v.no from (values ${pairs}) as v(id, no)
        where e.id = v.id and e.voucher_no = '' returning e.id`);
      if (linked.length !== entries.length) throw new Error('entry_locked');
    });
  } catch (error) {
    const msg = String(error);
    if (msg.includes('entry_locked')) return { ok: false, error: 'entry_locked' };
    if (msg.includes('ledger_vouchers_pkey') || msg.includes('ledger_vouchers_seq_idx')) return { ok: false, error: 'number_used' };
    throw error;
  }
  return { ok: true, numbers: vouchers.map((v) => v.number) };
}

function voucherView(row: typeof ledgerVouchers.$inferSelect) {
  return {
    number: row.number, kind: row.kind, voucherDate: row.voucherDate, party: row.party, payMethod: row.payMethod, payRef: row.payRef,
    amount: row.amount, vat: row.vat, wht: row.wht, net: row.net, preparedBy: row.preparedBy, createdBy: row.createdBy, createdAt: row.createdAt
  };
}

/** ใบสำคัญพร้อมรายการ สำหรับพิมพ์ (ได้หลายใบในครั้งเดียว) */
export async function voucherGet(body: ApiBody): Promise<ApiResult> {
  const numbers = (Array.isArray(body.numbers) ? body.numbers : [body.number]).map((v: unknown) => text(v, 20)).filter(Boolean).slice(0, 100);
  if (!numbers.length) return { ok: false, error: 'no_rows' };
  const vouchers = await db.select().from(ledgerVouchers).where(inArray(ledgerVouchers.number, numbers));
  if (!vouchers.length) return { ok: false, error: 'voucher_not_found' };
  const entries = await db.select().from(ledgerEntries).where(inArray(ledgerEntries.voucherNo, numbers))
    .orderBy(asc(ledgerEntries.entryDate), asc(ledgerEntries.createdAt));
  const order = new Map(numbers.map((n: string, i: number) => [n, i]));
  vouchers.sort((a, b) => (order.get(a.number) ?? 0) - (order.get(b.number) ?? 0));
  return {
    ok: true, company: COMPANY,
    vouchers: vouchers.map((v) => ({ ...voucherView(v), entries: entries.filter((e) => e.voucherNo === v.number).map(entryView) }))
  };
}

/** ยกเลิกใบสำคัญ (หลายใบได้) = ลบใบ + ปลดล็อกรายการ — รายการยังอยู่ในสมุด แก้ไข/ออกใบใหม่ได้ */
export async function voucherCancel(body: ApiBody): Promise<ApiResult> {
  const numbers = (Array.isArray(body.numbers) ? body.numbers : [body.number]).map((v: unknown) => text(v, 20)).filter(Boolean).slice(0, MAX_BATCH);
  if (!numbers.length) return { ok: false, error: 'no_rows' };
  return db.transaction(async (tx) => {
    const gone = await tx.delete(ledgerVouchers).where(inArray(ledgerVouchers.number, numbers)).returning({ number: ledgerVouchers.number });
    if (!gone.length) return { ok: false, error: 'voucher_not_found' };
    const freed = await tx.update(ledgerEntries).set({ voucherNo: '' })
      .where(inArray(ledgerEntries.voucherNo, gone.map((g) => g.number))).returning({ id: ledgerEntries.id });
    return { ok: true, numbers: gone.map((g) => g.number), count: freed.length };
  });
}

// ---------------- ตั้งค่ารายการ (รายการที่ใช้บ่อย ผูกผู้รับเงิน + ยอด + VAT + หัก ณ ที่จ่าย) ----------------
const PRESET_KEY = 'ledgerPresets';

type Preset = {
  id: string; direction: string; description: string; party: string; amount: number; hasVat: boolean;
  whtType: string; whtRate: number; payMethod: string; payRef: string; note: string;
};

async function readPresets(): Promise<Preset[]> {
  const [row] = await db.select({ valueJson: appOptions.valueJson }).from(appOptions).where(eq(appOptions.key, PRESET_KEY)).limit(1);
  const list = row ? safeJson<unknown>(row.valueJson, []) : [];
  return Array.isArray(list) ? list as Preset[] : [];
}

/** บันทึกรายการตั้งค่าทั้งชุด (แทนที่ของเดิม) — ชื่อรายการซ้ำในประเภทเดียวกันไม่ได้ เพราะเลือกจากชื่อ */
export async function ledgerPresetsSave(body: ApiBody): Promise<ApiResult> {
  const input = Array.isArray(body.presets) ? body.presets.slice(0, 500) : null;
  if (!input) return { ok: false, error: 'bad_request' };
  const seen = new Set<string>(), presets: Preset[] = [];
  for (const p of input) {
    const description = text(p?.description);
    if (!description) continue;
    const direction = p?.direction === 'in' ? 'in' : 'out';
    const key = direction + '|' + description.toLowerCase();
    if (seen.has(key)) return { ok: false, error: 'duplicate_preset', number: description };
    seen.add(key);
    const amount = money(p?.amount || 0), whtType = WHT_TYPES.includes(p?.whtType) ? String(p.whtType) : '';
    const payMethod = PAY_METHODS.includes(p?.payMethod) ? String(p.payMethod) : '';
    presets.push({
      id: text(p?.id, 40) || id('LP'), direction, description, party: text(p?.party, 200), amount: amount >= 0 ? amount : 0,
      hasVat: p?.hasVat === true, whtType, whtRate: whtType ? Math.min(15, Math.max(0, Number(p?.whtRate) || 0)) : 0,
      payMethod, payRef: payMethod === 'cash' ? '' : text(p?.payRef, 120), note: text(p?.note, 300)
    });
  }
  const valueJson = JSON.stringify(presets), updatedAt = nowIso();
  await db.insert(appOptions).values({ key: PRESET_KEY, valueJson, updatedAt })
    .onConflictDoUpdate({ target: appOptions.key, set: { valueJson, updatedAt } });
  return { ok: true, presets };
}
