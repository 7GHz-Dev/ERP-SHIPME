import { db, transaction } from './db.js';
import { config } from './config.js';
import {
  AUTO_MIN_CONTAINERS,
  SETTLE_COST_COLUMNS,
  TRANSPORT_SOURCE_STYLE
} from './constants.js';
import { appOptionsPayload } from './options.js';
import { checkStoredSlip, getSlip } from './slip.js';
import { replaceDataImage } from './storage.js';
import { fmtBaht, fmtDateStr, id, nowIso, round2, safeJson, validYmd } from './utils.js';
import { listClaims } from './claims.js';

const SPECIAL_LABEL = 'ค่าบริการเพิ่มเติมพิเศษ';
const SPECIAL_PRESETS = ['ยางเกิน', 'สำแดงเท็จ', 'ค่าน็อคตู้'];

export function readSettleRates() {
  return Object.fromEntries(db.prepare('SELECT key, rate FROM settle_rates').all().map((row) => [row.key, Number(row.rate) || 0]));
}

export function saveSettleRates(rates) {
  const update = db.prepare('UPDATE settle_rates SET rate = ?, updated_at = ? WHERE key = ?');
  transaction(() => {
    for (const column of SETTLE_COST_COLUMNS) {
      if (rates?.[column.key] === undefined) continue;
      update.run(Math.max(0, round2(rates[column.key])), nowIso(), column.key);
    }
  });
  return readSettleRates();
}

function claimedTotal(username, inspectDate) {
  const row = db.prepare('SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS count FROM claims WHERE username = ? COLLATE NOCASE AND inspect_date = ?')
    .get(username, inspectDate);
  return { total: round2(row.total), count: Number(row.count) || 0 };
}

export function settleConfig(user) {
  const claims = listClaims(user.username, 200);
  const byDate = new Map();
  for (const claim of claims) {
    if (!claim.inspectDate) continue;
    if (!byDate.has(claim.inspectDate)) byDate.set(claim.inspectDate, { date: claim.inspectDate, claimTotal: 0, claims: 0, keys: [], _seen: new Set() });
    const group = byDate.get(claim.inspectDate);
    group.claimTotal = round2(group.claimTotal + claim.total);
    group.claims++;
    for (const item of claim.items) {
      if (item.key && !group._seen.has(item.key)) { group._seen.add(item.key); group.keys.push(item.key); }
    }
  }
  const dates = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  const keysByDate = {};
  for (const item of dates) { keysByDate[item.date] = item.keys; delete item._seen; }
  const settledDates = new Set(db.prepare('SELECT inspect_date FROM settlements WHERE username = ? COLLATE NOCASE').all(user.username).map((row) => row.inspect_date));
  const options = appOptionsPayload();
  return {
    ok: true,
    columns: SETTLE_COST_COLUMNS,
    specialLabel: SPECIAL_LABEL,
    specialPresets: SPECIAL_PRESETS,
    options,
    sourceStyles: TRANSPORT_SOURCE_STYLE,
    slipStrict: config.slipStrict,
    autoRates: readSettleRates(),
    autoMin: AUTO_MIN_CONTAINERS,
    autoPorts: { extra_movement: options.emPorts || [] },
    dates: dates.filter((item) => !settledDates.has(item.date)),
    keysByDate,
    claimDates: dates.length,
    canSetCompanyReturn: ['admin', 'manager'].includes(user.role)
  };
}

function normalizeRow(input) {
  const row = {
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

function detail(record) {
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
      for (const column of SETTLE_COST_COLUMNS) if (row.costs[column.key] > 0) lines.push(`   ${column.label} = ${fmtBaht(row.costs[column.key])}`);
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

function emptySlip() {
  return { url: '', txn: '', amount: 0, date: '', status: '', bank: '' };
}

function transferGate(balance, returnedDate, slipInput, owner, selfId, previous) {
  if (!(balance > 0)) return { returnedDate: '', slip: emptySlip() };
  if (!returnedDate) return { error: { ok: false, error: 'returned_date_required' } };
  const fileId = String(slipInput?.fileId || '').trim();
  if (!fileId) {
    if (!previous?.url) return { error: { ok: false, error: 'slip_required' } };
    if ((previous.amount || previous.date)
      && (Math.abs((Number(previous.amount) || 0) - balance) > config.slipAmountTolerance || String(previous.date || '') !== returnedDate)) {
      return { error: { ok: false, error: 'slip_recheck_required' } };
    }
    return { returnedDate, slip: previous };
  }
  const stored = getSlip(fileId, owner);
  if (!stored.ok) return { error: stored };
  const checked = checkStoredSlip(stored.info, returnedDate, balance);
  if (checked.status === 'mismatch') return { error: { ok: false, error: 'slip_mismatch', detail: checked.label } };
  if (checked.status === 'unreadable' && config.slipStrict) return { error: { ok: false, error: 'slip_unreadable', detail: checked.label } };
  const values = checked.manual ? (stored.info.manual || {}) : stored.info;
  const txn = String(values.txn || '').trim();
  if (txn) {
    const duplicate = db.prepare('SELECT id, inspect_date FROM settlements WHERE UPPER(slip_txn) = UPPER(?) AND id <> ?').get(txn, selfId || '');
    if (duplicate) return { error: { ok: false, error: 'slip_txn_duplicate', detail: `ใช้กับใบปิดบัญชีวันที่ ${fmtDateStr(duplicate.inspect_date)} ไปแล้ว` } };
  }
  return {
    returnedDate,
    slip: {
      url: stored.row.url, txn, amount: round2(values.amount), date: String(values.date || ''),
      status: checked.label, bank: String(stored.info.bank || '')
    }
  };
}

export function settlementRow(row) {
  return {
    id: row.id, created: row.created_at, updated: row.updated_at,
    username: row.username, name: row.name, inspectDate: row.inspect_date,
    claimTotal: Number(row.claim_total) || 0, totalExpense: Number(row.total_expense) || 0,
    balance: Number(row.balance) || 0, editCount: Number(row.edit_count) || 0,
    returnedDate: row.returned_date || '', companyReturnedDate: row.company_returned_date || '',
    rows: safeJson(row.rows_json, []), detail: row.detail || '', imageUrl: row.image_url || '',
    slipUrl: row.slip_url || '', slipTxn: row.slip_txn || '', slipAmount: Number(row.slip_amount) || 0,
    slipDate: row.slip_date || '', slipStatus: row.slip_status || '', slipBank: row.slip_bank || ''
  };
}

export function listSettlements(username = null, limit = 500) {
  const rows = username
    ? db.prepare('SELECT * FROM settlements WHERE username = ? COLLATE NOCASE ORDER BY updated_at DESC LIMIT ?').all(username, limit)
    : db.prepare('SELECT * FROM settlements ORDER BY updated_at DESC LIMIT ?').all(limit);
  return rows.map(settlementRow);
}

export function saveSettlement(input, user) {
  const inspectDate = String(input?.inspectDate || '').trim();
  if (!validYmd(inspectDate)) return { ok: false, error: 'missing_inspect_date' };
  const rows = (Array.isArray(input?.rows) ? input.rows : []).map(normalizeRow)
    .filter((row) => row.bl || row.total || row.otherDetail || row.containers);
  if (!rows.length) return { ok: false, error: 'no_settle_rows' };
  const totalExpense = round2(rows.reduce((sum, row) => sum + row.total, 0));
  const now = nowIso();
  const settlementId = String(input?.id || '').trim();
  const returnedDate = validYmd(input?.returnedDate) ? String(input.returnedDate) : '';
  const companyDate = validYmd(input?.companyReturnedDate) ? String(input.companyReturnedDate) : '';
  const isBoss = ['admin', 'manager'].includes(user.role);
  if (settlementId) {
    const old = db.prepare('SELECT * FROM settlements WHERE id = ?').get(settlementId);
    if (!old) return { ok: false, error: 'settlement_not_found' };
    if (old.username.toLowerCase() !== user.username.toLowerCase() && !isBoss) return { ok: false, error: 'forbidden' };
    const claim = claimedTotal(old.username, inspectDate);
    const balance = round2(claim.total - totalExpense);
    const gate = transferGate(balance, returnedDate, input?.slip, old.username, settlementId, {
      url: old.slip_url, txn: old.slip_txn, amount: old.slip_amount, date: old.slip_date,
      status: old.slip_status, bank: old.slip_bank
    });
    if (gate.error) return gate.error;
    const record = {
      id: settlementId, username: old.username, name: old.name, inspectDate,
      claimTotal: claim.total, rows, totalExpense, balance, editCount: Number(old.edit_count) + 1,
      returnedDate: gate.returnedDate, companyReturnedDate: isBoss ? companyDate : old.company_returned_date,
      slipUrl: gate.slip.url, slipTxn: gate.slip.txn, slipAmount: gate.slip.amount,
      slipDate: gate.slip.date, slipStatus: gate.slip.status, slipBank: gate.slip.bank,
      imageUrl: old.image_url || ''
    };
    record.detail = detail(record);
    try {
      db.prepare(`UPDATE settlements SET updated_at=?, inspect_date=?, claim_total=?, total_expense=?, balance=?, edit_count=?,
        returned_date=?, company_returned_date=?, rows_json=?, detail=?, slip_url=?, slip_txn=?, slip_amount=?, slip_date=?, slip_status=?, slip_bank=? WHERE id=?`)
        .run(now, inspectDate, record.claimTotal, totalExpense, balance, record.editCount, record.returnedDate,
          record.companyReturnedDate, JSON.stringify(rows), record.detail, record.slipUrl, record.slipTxn,
          record.slipAmount, record.slipDate, record.slipStatus, record.slipBank, settlementId);
    } catch (error) {
      if (String(error).includes('UNIQUE')) return { ok: false, error: 'settlement_date_exists' };
      throw error;
    }
    return { ok: true, mode: 'updated', record: { ...record, updated: now } };
  }
  const duplicate = db.prepare('SELECT * FROM settlements WHERE username = ? COLLATE NOCASE AND inspect_date = ?').get(user.username, inspectDate);
  if (duplicate) return { ok: false, error: 'settlement_date_exists', record: settlementRow(duplicate) };
  const claim = claimedTotal(user.username, inspectDate);
  const balance = round2(claim.total - totalExpense);
  const gate = transferGate(balance, returnedDate, input?.slip, user.username, '', null);
  if (gate.error) return gate.error;
  const record = {
    id: id('ST'), username: user.username, name: user.name, inspectDate,
    claimTotal: claim.total, rows, totalExpense, balance, editCount: 0,
    returnedDate: gate.returnedDate, companyReturnedDate: isBoss ? companyDate : '',
    slipUrl: gate.slip.url, slipTxn: gate.slip.txn, slipAmount: gate.slip.amount,
    slipDate: gate.slip.date, slipStatus: gate.slip.status, slipBank: gate.slip.bank, imageUrl: ''
  };
  record.detail = detail(record);
  db.prepare(`INSERT INTO settlements (id,created_at,updated_at,username,name,inspect_date,claim_total,total_expense,balance,
    edit_count,returned_date,company_returned_date,rows_json,detail,image_url,slip_url,slip_txn,slip_amount,slip_date,slip_status,slip_bank)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(record.id, now, now, record.username, record.name, inspectDate, record.claimTotal, totalExpense, balance, 0,
      record.returnedDate, record.companyReturnedDate, JSON.stringify(rows), record.detail, '', record.slipUrl,
      record.slipTxn, record.slipAmount, record.slipDate, record.slipStatus, record.slipBank);
  return { ok: true, mode: 'created', record: { ...record, created: now, updated: now } };
}

export function saveSettlementImage(settlementId, image, user) {
  const row = db.prepare('SELECT * FROM settlements WHERE id = ?').get(settlementId);
  if (!row) return { ok: false, error: 'settlement_not_found' };
  const isBoss = ['admin', 'manager'].includes(user.role);
  if (row.username.toLowerCase() !== user.username.toLowerCase() && !isBoss) return { ok: false, error: 'forbidden' };
  const file = replaceDataImage(image, 'settlements', `${row.inspect_date}_${row.username}`);
  db.prepare('UPDATE settlements SET image_url = ?, updated_at = ? WHERE id = ?').run(file.url, nowIso(), settlementId);
  return { ok: true, url: file.url, name: file.fileName, folder: 'settlements' };
}
