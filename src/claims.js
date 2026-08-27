import { db, transaction } from './db.js';
import { appOptionsPayload, readAppOptions } from './options.js';
import { AUTO_MIN_CONTAINERS, CLAIM_ITEM_DEFAULTS, CLAIM_MAX_EDITS } from './constants.js';
import { fmtBaht, fmtDateStr, id, nowIso, round2, safeJson, validYmd } from './utils.js';

const defaultOf = (key) => CLAIM_ITEM_DEFAULTS.find((item) => item.key === key);

export function readClaimItems() {
  const saved = Object.fromEntries(db.prepare('SELECT * FROM claim_rates').all().map((row) => [row.key, row]));
  return CLAIM_ITEM_DEFAULTS.map((item) => ({
    key: item.key,
    label: item.label,
    perContainer: item.perContainer,
    rate: Number(saved[item.key]?.rate) || Number(item.rate) || 0,
    primary: Boolean(item.primary),
    ownQty: Boolean(item.ownQty),
    minContainers: Number(AUTO_MIN_CONTAINERS[item.key]) || 0,
    input: item.input || (item.perContainer ? 'auto' : 'money'),
    optionKey: item.optionKey || '',
    reasons: item.key === 'special' ? safeJson(saved[item.key]?.reasons_json, item.reasons || []) : []
  }));
}

export function saveClaimRates(items) {
  const statement = db.prepare('UPDATE claim_rates SET rate = ?, reasons_json = ?, updated_at = ? WHERE key = ?');
  transaction(() => {
    for (const incoming of Array.isArray(items) ? items : []) {
      const item = defaultOf(String(incoming?.key || ''));
      if (!item) continue;
      const rate = Math.max(0, round2(incoming.rate));
      const reasons = item.key === 'special'
        ? (Array.isArray(incoming.reasons) ? incoming.reasons : []).map((reason) => ({
            label: String(reason?.label || '').trim().slice(0, 120), rate: Math.max(0, round2(reason?.rate))
          })).filter((reason) => reason.label)
        : [];
      statement.run(rate, JSON.stringify(reasons), nowIso(), item.key);
    }
  });
  return readClaimItems();
}

function autoQty(key, containers) {
  const min = Number(AUTO_MIN_CONTAINERS[key]) || 0;
  return min && containers < min ? 0 : containers;
}

export function computeClaim(lines, containers) {
  const config = Object.fromEntries(readClaimItems().map((item) => [item.key, item]));
  const options = readAppOptions();
  const items = [];
  let total = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const itemConfig = config[String(line?.key || '')];
    if (!itemConfig) continue;
    const item = {
      key: itemConfig.key, label: itemConfig.label, perContainer: itemConfig.perContainer,
      rate: 0, qty: 0, unit: '', amount: 0,
      note: String(line?.note || '').trim().slice(0, 300), reasons: []
    };
    if (itemConfig.perContainer) {
      let quantity = autoQty(itemConfig.key, containers);
      const own = Number.parseInt(line?.qty, 10);
      if (itemConfig.ownQty && own > 0) quantity = Math.min(own, 999);
      if (!(quantity > 0)) continue;
      item.rate = itemConfig.rate;
      item.qty = quantity;
      item.unit = 'ตู้';
      item.amount = round2(item.rate * quantity);
    } else if (itemConfig.input === 'sets') {
      item.qty = Math.max(0, Math.min(Number.parseInt(line?.qty, 10) || 0, options.overtime.maxSets));
      item.rate = options.overtime.perSet;
      item.unit = 'ชุด';
      item.amount = round2(item.qty * item.rate);
    } else if (itemConfig.key === 'special') {
      for (const reason of Array.isArray(line?.reasons) ? line.reasons : []) {
        const label = String(reason?.label || '').trim().slice(0, 120);
        const amount = Math.max(0, round2(reason?.amount));
        if (label) item.reasons.push({ label, amount });
      }
      if (!item.reasons.length) continue;
      item.amount = round2(item.reasons.reduce((sum, reason) => sum + reason.amount, 0));
    } else {
      item.amount = Math.max(0, round2(line?.amount));
    }
    items.push(item);
    total += item.amount;
  }
  return { items, total: round2(total) };
}

function itemLine(item) {
  if (item.perContainer || item.unit) return `${item.label} = ${fmtBaht(item.rate)} x ${item.qty} ${item.unit || 'ตู้'} = ${fmtBaht(item.amount)}`;
  return `${item.label}${item.note ? ` (${item.note})` : ''} = ${fmtBaht(item.amount)}`;
}

function claimDetail(record) {
  const lines = [
    '📋 สรุปยอดเบิก',
    `วันที่ตรวจปล่อย: ${fmtDateStr(record.inspectDate)}`,
    `จำนวนตู้: ${record.containers} ตู้`,
    '--------------------------------'
  ];
  for (const item of record.items) {
    if (item.key === 'special') {
      lines.push(`${item.label} = ${fmtBaht(item.amount)}`);
      for (const reason of item.reasons) lines.push(`   - ${reason.label} = ${fmtBaht(reason.amount)}`);
    } else lines.push(itemLine(item));
  }
  lines.push('--------------------------------', `รวมทั้งสิ้น ${fmtBaht(record.total)} บาท`, `ผู้เบิก: ${record.name}`);
  if (record.editCount > 0) lines.push(`(แก้ไขครั้งที่ ${record.editCount})`);
  return lines.join('\n');
}

function itemMap(items) {
  const map = {};
  for (const item of Array.isArray(items) ? items : []) {
    map[item.key] = { amount: Number(item.amount) || 0, reasons: Object.fromEntries((item.reasons || []).map((reason) => [reason.label, Number(reason.amount) || 0])) };
  }
  return map;
}

function addedDetail(record, previousItems) {
  const previous = itemMap(previousItems);
  const lines = [];
  let added = 0;
  for (const item of record.items) {
    const old = previous[item.key];
    if (item.key === 'special') {
      const nested = [];
      let difference = 0;
      for (const reason of item.reasons) {
        const was = Number(old?.reasons?.[reason.label]) || 0;
        if (reason.amount <= was) continue;
        difference += reason.amount - was;
        nested.push(`   - ${reason.label} = ${fmtBaht(reason.amount)}${was ? ` (เพิ่มจาก ${fmtBaht(was)})` : ''}`);
      }
      if (nested.length) {
        added += difference;
        lines.push(`${item.label} + ${fmtBaht(difference)}`, ...nested);
      }
    } else if (!old) {
      added += item.amount;
      lines.push(`${itemLine(item)}  ← เพิ่มใหม่`);
    } else if (item.amount > old.amount) {
      added += item.amount - old.amount;
      lines.push(`${itemLine(item)} (เพิ่มจาก ${fmtBaht(old.amount)} = +${fmtBaht(item.amount - old.amount)})`);
    }
  }
  if (!lines.length) return claimDetail(record);
  return [
    `📋 รายการเบิกที่เพิ่ม (แก้ไขครั้งที่ ${record.editCount})`,
    `วันที่ตรวจปล่อย: ${fmtDateStr(record.inspectDate)}`,
    `จำนวนตู้: ${record.containers} ตู้`,
    '--------------------------------', ...lines, '--------------------------------',
    `ยอดที่เพิ่ม ${fmtBaht(round2(added))} บาท`, `ผู้เบิก: ${record.name}`
  ].join('\n');
}

export function claimRow(row) {
  const editCount = Number(row.edit_count) || 0;
  const detail = String(row.detail || '');
  const editDetails = safeJson(row.edit_details_json, Array(CLAIM_MAX_EDITS).fill(''));
  while (editDetails.length < CLAIM_MAX_EDITS) editDetails.push('');
  return {
    id: row.id, created: row.created_at, updated: row.updated_at,
    username: row.username, name: row.name, inspectDate: row.inspect_date,
    containers: Number(row.containers) || 0, total: Number(row.total) || 0,
    editCount, items: safeJson(row.items_json, []), detail,
    detailAll: row.detail_all || detail,
    detailFirst: row.detail_first || (editCount ? '' : detail),
    editDetails: editDetails.slice(0, CLAIM_MAX_EDITS), maxEdits: CLAIM_MAX_EDITS,
    editsLeft: Math.max(0, CLAIM_MAX_EDITS - editCount)
  };
}

export function listClaims(username = null, limit = 500) {
  const rows = username
    ? db.prepare('SELECT * FROM claims WHERE username = ? COLLATE NOCASE ORDER BY updated_at DESC LIMIT ?').all(username, limit)
    : db.prepare('SELECT * FROM claims ORDER BY updated_at DESC LIMIT ?').all(limit);
  return rows.map(claimRow);
}

export function saveClaim(claim, user) {
  const inspectDate = String(claim?.inspectDate || '').trim();
  const containers = Number.parseInt(claim?.containers, 10);
  if (!validYmd(inspectDate)) return { ok: false, error: 'missing_inspect_date' };
  if (!(containers > 0) || containers > 999) return { ok: false, error: 'invalid_containers' };
  const calculated = computeClaim(claim?.items, containers);
  if (!calculated.items.length) return { ok: false, error: 'no_claim_items' };
  const now = nowIso();
  const claimId = String(claim?.id || '').trim();
  if (claimId) {
    const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
    if (!row) return { ok: false, error: 'claim_not_found' };
    const isBoss = ['admin', 'manager'].includes(user.role);
    if (row.username.toLowerCase() !== user.username.toLowerCase() && !isBoss) return { ok: false, error: 'forbidden' };
    const editCount = Number(row.edit_count) || 0;
    if (editCount >= CLAIM_MAX_EDITS) return { ok: false, error: 'claim_edit_limit', maxEdits: CLAIM_MAX_EDITS };
    const record = {
      id: claimId, username: row.username, name: row.name, inspectDate, containers,
      total: calculated.total, editCount: editCount + 1, items: calculated.items
    };
    record.detail = claimDetail(record);
    record.detailAll = record.detail;
    record.detailFirst = row.detail_first || row.detail_all || row.detail;
    record.editDetails = safeJson(row.edit_details_json, Array(CLAIM_MAX_EDITS).fill(''));
    while (record.editDetails.length < CLAIM_MAX_EDITS) record.editDetails.push('');
    record.editDetails[record.editCount - 1] = addedDetail(record, safeJson(row.items_json, []));
    try {
      db.prepare(`UPDATE claims SET updated_at=?, inspect_date=?, containers=?, total=?, edit_count=?, items_json=?,
        detail=?, detail_all=?, detail_first=?, edit_details_json=? WHERE id=?`)
        .run(now, inspectDate, containers, record.total, record.editCount, JSON.stringify(record.items),
          record.detail, record.detailAll, record.detailFirst, JSON.stringify(record.editDetails), claimId);
    } catch (error) {
      if (String(error).includes('UNIQUE')) return { ok: false, error: 'claim_date_exists' };
      throw error;
    }
    return { ok: true, mode: 'updated', record: { ...record, updated: now, maxEdits: CLAIM_MAX_EDITS } };
  }
  const existing = db.prepare('SELECT * FROM claims WHERE username = ? COLLATE NOCASE AND inspect_date = ?').get(user.username, inspectDate);
  if (existing) return { ok: false, error: 'claim_date_exists', record: claimRow(existing) };
  const record = {
    id: id('CL'), username: user.username, name: user.name, inspectDate, containers,
    total: calculated.total, editCount: 0, items: calculated.items
  };
  record.detail = claimDetail(record);
  record.detailAll = record.detail;
  record.detailFirst = record.detail;
  record.editDetails = Array(CLAIM_MAX_EDITS).fill('');
  db.prepare(`INSERT INTO claims (id,created_at,updated_at,username,name,inspect_date,containers,total,edit_count,items_json,
    detail,detail_all,detail_first,edit_details_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(record.id, now, now, record.username, record.name, inspectDate, containers, record.total, 0,
      JSON.stringify(record.items), record.detail, record.detailAll, record.detailFirst, JSON.stringify(record.editDetails));
  return { ok: true, mode: 'created', record: { ...record, created: now, updated: now, maxEdits: CLAIM_MAX_EDITS } };
}

export function claimConfig(user) {
  return { ok: true, items: readClaimItems(), options: appOptionsPayload(), canEditRates: ['admin', 'manager'].includes(user.role) };
}
