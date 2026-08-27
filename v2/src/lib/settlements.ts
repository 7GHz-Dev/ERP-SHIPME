import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import { claims, settlements } from '@/db/schema';
import { listClaims } from './claims';
import { AUTO_MIN_CONTAINERS, SETTLE_COST_COLUMNS, TRANSPORT_SOURCE_STYLE } from './constants';
import { env } from './env';
import { appOptionsPayload } from './options';
import { settleRates } from '@/db/schema';
import { checkStoredSlip, getSlip } from './slip';
import { replaceDataImage } from './storage';
import type { ApiResult } from './types';
import { fmtBaht, fmtDateStr, id, nowIso, round2, safeJson, validYmd } from './utils';

const SPECIAL_LABEL = 'ค่าบริการเพิ่มเติมพิเศษ';
const SPECIAL_PRESETS = ['ยางเกิน', 'สำแดงเท็จ', 'ค่าน็อคตู้'];

export async function readSettleRates() {
  const rows = await db.select({ key: settleRates.key, rate: settleRates.rate }).from(settleRates);
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.rate) || 0]));
}

export async function saveSettleRates(rates: any) {
  await db.transaction(async (tx) => {
    for (const column of SETTLE_COST_COLUMNS) {
      if (rates?.[column.key] === undefined) continue;
      await tx.update(settleRates)
        .set({ rate: Math.max(0, round2(rates[column.key])), updatedAt: nowIso() })
        .where(eq(settleRates.key, column.key));
    }
  });
  return readSettleRates();
}

async function claimedTotal(username: string, inspectDate: string) {
  const [row] = await db.select({
    total: sql<number>`coalesce(sum(${claims.total}), 0)`,
    count: sql<number>`count(*)::int`
  }).from(claims).where(and(eq(claims.username, username), eq(claims.inspectDate, inspectDate)));
  return { total: round2(row?.total), count: Number(row?.count) || 0 };
}

export async function settleConfig(user: { username: string; role: string }) {
  const claimList = await listClaims(user.username, 200);
  const byDate = new Map<string, { date: string; claimTotal: number; claims: number; keys: string[]; _seen: Set<string> }>();

  for (const claim of claimList) {
    if (!claim.inspectDate) continue;
    if (!byDate.has(claim.inspectDate)) {
      byDate.set(claim.inspectDate, { date: claim.inspectDate, claimTotal: 0, claims: 0, keys: [], _seen: new Set() });
    }
    const group = byDate.get(claim.inspectDate)!;
    group.claimTotal = round2(group.claimTotal + claim.total);
    group.claims++;
    // หัวข้อที่เบิกไว้ของวันนั้น — หน้าปิดบัญชีเอาไปเลือกว่าจะโชว์ช่องไหนให้กรอก
    for (const item of claim.items) {
      if (item.key && !group._seen.has(item.key)) { group._seen.add(item.key); group.keys.push(item.key); }
    }
  }

  const dates = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  const keysByDate: Record<string, string[]> = {};
  for (const item of dates) {
    keysByDate[item.date] = item.keys;
    delete (item as any)._seen;
  }

  const settledRows = await db.select({ inspectDate: settlements.inspectDate }).from(settlements)
    .where(eq(settlements.username, user.username));
  const settledDates = new Set(settledRows.map((row) => row.inspectDate));

  const options = await appOptionsPayload();
  return {
    ok: true,
    columns: SETTLE_COST_COLUMNS,
    specialLabel: SPECIAL_LABEL,
    specialPresets: SPECIAL_PRESETS,
    options,
    sourceStyles: TRANSPORT_SOURCE_STYLE,
    slipStrict: env.slipStrict,
    autoRates: await readSettleRates(),
    autoMin: AUTO_MIN_CONTAINERS,
    // ช่องที่คิดให้เฉพาะบางท่า — ท่าอื่นปล่อยว่างให้กรอกเอง
    autoPorts: { extra_movement: options.emPorts || [] },
    dates: dates.filter((item) => !settledDates.has(item.date)),
    keysByDate,
    claimDates: dates.length,
    canSetCompanyReturn: ['admin', 'manager'].includes(user.role)
  };
}

type SettleRow = {
  port: string; customer: string; bl: string; containers: number; otherDetail: string; source: string;
  costs: Record<string, number>; specials: { label: string; amount: number }[]; total: number;
};

function normalizeRow(input: any): SettleRow {
  const row: SettleRow = {
    port: String(input?.port || '').trim().slice(0, 80),
    customer: String(input?.customer || '').trim().slice(0, 150),
    bl: String(input?.bl || '').trim().slice(0, 80),
    containers: Math.max(0, Number.parseInt(input?.containers, 10) || 0),
    otherDetail: String(input?.otherDetail || '').trim().slice(0, 300),
    source: String(input?.source || '').trim().slice(0, 40),
    costs: {}, specials: [], total: 0
  };
  let total = 0;
  for (const column of SETTLE_COST_COLUMNS) {
    const amount = Math.max(0, round2(input?.costs?.[column.key]));
    row.costs[column.key] = amount;
    total += amount;
  }
  for (const special of Array.isArray(input?.specials) ? input.specials : []) {
    const label = String(special?.label || '').trim().slice(0, 120);
    const amount = Math.max(0, round2(special?.amount));
    if (!label || !amount) continue;
    row.specials.push({ label, amount });
    total += amount;
  }
  row.total = round2(total);
  return row;
}

type SettleRecord = {
  id: string; username: string; name: string; inspectDate: string;
  claimTotal: number; rows: SettleRow[]; totalExpense: number; balance: number; editCount: number;
  returnedDate: string; companyReturnedDate: string;
  slipUrl: string; slipTxn: string; slipAmount: number; slipDate: string; slipStatus: string; slipBank: string;
  imageUrl: string; detail?: string;
};

/**
 * ข้อความสรุปของใบปิดบัญชี
 * กรณี "บริษัทโอนคืนพนักงาน" (คงเหลือติดลบ) = เอาเฉพาะหัว + ท้าย ไม่ต้องมีรายละเอียดแต่ละ BL
 */
function detail(record: SettleRecord) {
  const companyPays = record.balance < 0;
  const lines = [
    '📕 รายการปิดบัญชี (รายละเอียดการตรวจปล่อย)',
    `วันที่ตรวจปล่อย: ${fmtDateStr(record.inspectDate)}`,
    `ชื่อ SHIPPING: ${record.name}`,
    `ยอดเบิกเงิน: ${fmtBaht(record.claimTotal)} บาท`
  ];
  if (companyPays) lines.push(`จำนวน ${record.rows.length} รายการ BL`);
  lines.push('--------------------------------');

  if (!companyPays) {
    record.rows.forEach((row, index) => {
      let heading = `${index + 1}) BL ${row.bl || '-'}`;
      if (row.port) heading += ` • ท่า ${row.port}`;
      if (row.customer) heading += ` • ${row.customer}`;
      heading += ` • ${row.containers} ตู้`;
      lines.push(heading);
      for (const column of SETTLE_COST_COLUMNS) {
        if (row.costs[column.key] > 0) lines.push(`   ${column.label} = ${fmtBaht(row.costs[column.key])}`);
      }
      if (row.specials.length) {
        lines.push(`   ${SPECIAL_LABEL} = ${fmtBaht(row.specials.reduce((sum, item) => sum + item.amount, 0))}`);
        for (const item of row.specials) lines.push(`      - ${item.label} = ${fmtBaht(item.amount)}`);
      }
      if (row.otherDetail) lines.push(`   รายละเอียดค่าใช้จ่ายอื่นๆ: ${row.otherDetail}`);
      lines.push(`   รวม = ${fmtBaht(row.total)}`);
    });
    lines.push('--------------------------------');
  }

  lines.push(`รวมค่าใช้จ่าย ${fmtBaht(record.totalExpense)} บาท`, `หัก ยอดเบิก ${fmtBaht(record.claimTotal)} บาท`);
  lines.push(record.balance >= 0
    ? `คงเหลือ ${fmtBaht(record.balance)} บาท (โอนคืนบริษัท)`
    : `คงเหลือ ${fmtBaht(-record.balance)} บาท (บริษัทโอนคืนพนักงาน)`);
  if (record.returnedDate) lines.push(`วันที่โอนคืนบริษัท: ${fmtDateStr(record.returnedDate)}`);
  if (record.slipTxn) lines.push(`เลขที่รายการสลิป: ${record.slipTxn}`);
  if (record.companyReturnedDate) lines.push(`วันที่บริษัทโอนคืน: ${fmtDateStr(record.companyReturnedDate)}`);
  if (record.editCount > 0) lines.push(`(แก้ไขครั้งที่ ${record.editCount})`);
  return lines.join('\n');
}

type SlipValues = { url: string; txn: string; amount: number; date: string; status: string; bank: string };
const emptySlip = (): SlipValues => ({ url: '', txn: '', amount: 0, date: '', status: '', bank: '' });

/**
 * คงเหลือเป็นบวก = พนักงานต้องโอนคืนบริษัท จึงบังคับวันที่โอนคืน + สลิปที่ตรวจแล้ว
 * ไม่เป็นบวก = ไม่ต้องแนบอะไรเลย และล้างค่าสลิปเดิมทิ้ง
 */
async function transferGate(
  balance: number,
  returnedDate: string,
  slipInput: any,
  owner: string,
  selfId: string,
  previous: SlipValues | null
): Promise<{ error?: ApiResult; returnedDate?: string; slip?: SlipValues }> {
  if (!(balance > 0)) return { returnedDate: '', slip: emptySlip() };
  if (!returnedDate) return { error: { ok: false, error: 'returned_date_required' } };

  const fileId = String(slipInput?.fileId || '').trim();
  if (!fileId) {
    // แก้ใบเดิมโดยไม่แนบสลิปใหม่ = ใช้สลิปเดิม แต่ยอด/วันที่ต้องยังตรงอยู่
    if (!previous?.url) return { error: { ok: false, error: 'slip_required' } };
    if ((previous.amount || previous.date)
      && (Math.abs((Number(previous.amount) || 0) - balance) > env.slipAmountTolerance
        || String(previous.date || '') !== returnedDate)) {
      return { error: { ok: false, error: 'slip_recheck_required' } };
    }
    return { returnedDate, slip: previous };
  }

  const stored = await getSlip(fileId, owner);
  if (!stored.ok) return { error: stored };
  const checked = checkStoredSlip(stored.info, returnedDate, balance);
  if (checked.status === 'mismatch') return { error: { ok: false, error: 'slip_mismatch', detail: checked.label } };
  if (checked.status === 'unreadable' && env.slipStrict) {
    return { error: { ok: false, error: 'slip_unreadable', detail: checked.label } };
  }

  const values = (checked.manual ? (stored.info.manual || {}) : stored.info) as { amount?: number; date?: string; txn?: string };
  const txn = String(values.txn || '').trim();
  if (txn) {
    // สลิปใบเดียวเอาไปปิดหลายวันไม่ได้
    const [duplicate] = await db.select({ id: settlements.id, inspectDate: settlements.inspectDate })
      .from(settlements)
      .where(and(sql`upper(${settlements.slipTxn}) = upper(${txn})`, ne(settlements.id, selfId || '')))
      .limit(1);
    if (duplicate) {
      return { error: { ok: false, error: 'slip_txn_duplicate', detail: `ใช้กับใบปิดบัญชีวันที่ ${fmtDateStr(duplicate.inspectDate)} ไปแล้ว` } };
    }
  }

  return {
    returnedDate,
    slip: {
      url: stored.row.url, txn, amount: round2(values.amount), date: String(values.date || ''),
      status: checked.label, bank: String(stored.info.bank || '')
    }
  };
}

type SettlementDbRow = typeof settlements.$inferSelect;

export function settlementRow(row: SettlementDbRow) {
  return {
    id: row.id, created: row.createdAt, updated: row.updatedAt,
    username: row.username, name: row.name, inspectDate: row.inspectDate,
    claimTotal: Number(row.claimTotal) || 0, totalExpense: Number(row.totalExpense) || 0,
    balance: Number(row.balance) || 0, editCount: Number(row.editCount) || 0,
    returnedDate: row.returnedDate || '', companyReturnedDate: row.companyReturnedDate || '',
    rows: safeJson<SettleRow[]>(row.rowsJson, []), detail: row.detail || '', imageUrl: row.imageUrl || '',
    slipUrl: row.slipUrl || '', slipTxn: row.slipTxn || '', slipAmount: Number(row.slipAmount) || 0,
    slipDate: row.slipDate || '', slipStatus: row.slipStatus || '', slipBank: row.slipBank || ''
  };
}

export async function listSettlements(username: string | null = null, limit = 500) {
  const rows = username
    ? await db.select().from(settlements).where(eq(settlements.username, username))
        .orderBy(desc(settlements.updatedAt)).limit(limit)
    : await db.select().from(settlements).orderBy(desc(settlements.updatedAt)).limit(limit);
  return rows.map(settlementRow);
}

export async function saveSettlement(
  input: any,
  user: { username: string; name: string; role: string }
): Promise<ApiResult> {
  const inspectDate = String(input?.inspectDate || '').trim();
  if (!validYmd(inspectDate)) return { ok: false, error: 'missing_inspect_date' };

  const rows = (Array.isArray(input?.rows) ? input.rows : []).map(normalizeRow)
    .filter((row: SettleRow) => row.bl || row.total || row.otherDetail || row.containers);
  if (!rows.length) return { ok: false, error: 'no_settle_rows' };

  const totalExpense = round2(rows.reduce((sum: number, row: SettleRow) => sum + row.total, 0));
  const now = nowIso();
  const settlementId = String(input?.id || '').trim();
  const returnedDate = validYmd(input?.returnedDate) ? String(input.returnedDate) : '';
  const companyDate = validYmd(input?.companyReturnedDate) ? String(input.companyReturnedDate) : '';
  const isBoss = ['admin', 'manager'].includes(user.role);

  if (settlementId) {
    const [old] = await db.select().from(settlements).where(eq(settlements.id, settlementId)).limit(1);
    if (!old) return { ok: false, error: 'settlement_not_found' };
    if (old.username.toLowerCase() !== user.username.toLowerCase() && !isBoss) {
      return { ok: false, error: 'forbidden' };
    }

    const claim = await claimedTotal(old.username, inspectDate);
    const balance = round2(claim.total - totalExpense);
    const gate = await transferGate(balance, returnedDate, input?.slip, old.username, settlementId, {
      url: old.slipUrl, txn: old.slipTxn, amount: old.slipAmount, date: old.slipDate,
      status: old.slipStatus, bank: old.slipBank
    });
    if (gate.error) return gate.error;

    const record: SettleRecord = {
      id: settlementId, username: old.username, name: old.name, inspectDate,
      claimTotal: claim.total, rows, totalExpense, balance, editCount: Number(old.editCount) + 1,
      returnedDate: gate.returnedDate!, companyReturnedDate: isBoss ? companyDate : old.companyReturnedDate,
      slipUrl: gate.slip!.url, slipTxn: gate.slip!.txn, slipAmount: gate.slip!.amount,
      slipDate: gate.slip!.date, slipStatus: gate.slip!.status, slipBank: gate.slip!.bank,
      imageUrl: old.imageUrl || ''
    };
    record.detail = detail(record);

    try {
      await db.update(settlements).set({
        updatedAt: now, inspectDate, claimTotal: record.claimTotal, totalExpense, balance,
        editCount: record.editCount, returnedDate: record.returnedDate,
        companyReturnedDate: record.companyReturnedDate, rowsJson: JSON.stringify(rows),
        detail: record.detail, slipUrl: record.slipUrl, slipTxn: record.slipTxn,
        slipAmount: record.slipAmount, slipDate: record.slipDate, slipStatus: record.slipStatus,
        slipBank: record.slipBank
      }).where(eq(settlements.id, settlementId));
    } catch (error) {
      const message = String(error);
      if (message.includes('settlements_new_date_idx')) return { ok: false, error: 'settlement_date_exists' };
      if (message.includes('settlements_slip_txn_idx')) return { ok: false, error: 'slip_txn_duplicate' };
      throw error;
    }
    return { ok: true, mode: 'updated', record: { ...record, updated: now } };
  }

  const [duplicate] = await db.select().from(settlements)
    .where(and(eq(settlements.username, user.username), eq(settlements.inspectDate, inspectDate)))
    .limit(1);
  if (duplicate) return { ok: false, error: 'settlement_date_exists', record: settlementRow(duplicate) };

  const claim = await claimedTotal(user.username, inspectDate);
  const balance = round2(claim.total - totalExpense);
  const gate = await transferGate(balance, returnedDate, input?.slip, user.username, '', null);
  if (gate.error) return gate.error;

  const record: SettleRecord = {
    id: id('ST'), username: user.username, name: user.name, inspectDate,
    claimTotal: claim.total, rows, totalExpense, balance, editCount: 0,
    returnedDate: gate.returnedDate!, companyReturnedDate: isBoss ? companyDate : '',
    slipUrl: gate.slip!.url, slipTxn: gate.slip!.txn, slipAmount: gate.slip!.amount,
    slipDate: gate.slip!.date, slipStatus: gate.slip!.status, slipBank: gate.slip!.bank, imageUrl: ''
  };
  record.detail = detail(record);

  try {
    await db.insert(settlements).values({
      id: record.id, createdAt: now, updatedAt: now, username: record.username, name: record.name,
      inspectDate, claimTotal: record.claimTotal, totalExpense, balance, editCount: 0,
      returnedDate: record.returnedDate, companyReturnedDate: record.companyReturnedDate,
      rowsJson: JSON.stringify(rows), detail: record.detail, imageUrl: '',
      slipUrl: record.slipUrl, slipTxn: record.slipTxn, slipAmount: record.slipAmount,
      slipDate: record.slipDate, slipStatus: record.slipStatus, slipBank: record.slipBank
    });
  } catch (error) {
    const message = String(error);
    if (message.includes('settlements_new_date_idx')) return { ok: false, error: 'settlement_date_exists' };
    if (message.includes('settlements_slip_txn_idx')) return { ok: false, error: 'slip_txn_duplicate' };
    throw error;
  }
  return { ok: true, mode: 'created', record: { ...record, created: now, updated: now } };
}

export async function saveSettlementImage(
  settlementId: unknown,
  image: unknown,
  user: { username: string; role: string }
): Promise<ApiResult> {
  const [row] = await db.select().from(settlements).where(eq(settlements.id, String(settlementId || ''))).limit(1);
  if (!row) return { ok: false, error: 'settlement_not_found' };
  const isBoss = ['admin', 'manager'].includes(user.role);
  if (row.username.toLowerCase() !== user.username.toLowerCase() && !isBoss) {
    return { ok: false, error: 'forbidden' };
  }
  const file = await replaceDataImage(image, 'settlements', `${row.inspectDate}_${row.username}`);
  await db.update(settlements).set({ imageUrl: file.url, updatedAt: nowIso() })
    .where(eq(settlements.id, row.id));
  return { ok: true, url: file.url, name: file.fileName, folder: 'settlements' };
}
