import fs from 'node:fs';
import path from 'node:path';
import { db, passwordHash, transaction } from '../src/db.js';
import { normalizeRole, nowIso, parseActive, safeJson } from '../src/utils.js';

const sourcePath = path.resolve(process.argv[2] || 'data/imports/legacy-sheet-export.json');
const validateOnly = process.argv.includes('--validate');
if (!fs.existsSync(sourcePath)) {
  console.error(`Source not found: ${sourcePath}`);
  process.exit(1);
}

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const sheets = source.sheets || {};

function objectsOf(name) {
  const values = Array.isArray(sheets[name]) ? sheets[name] : [];
  if (!values.length) return [];
  const headers = values[0].map((value) => String(value ?? '').trim());
  return values.slice(1)
    .filter((row) => row.some((value) => String(value ?? '').trim()))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
}

function ymd(value) {
  const text = String(value ?? '').trim();
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (match) {
    let year = Number(match[1]); if (year > 2400) year -= 543;
    return `${year}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  }
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(text);
  if (match) {
    let year = Number(match[3]); if (year > 2400) year -= 543;
    return `${year}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
  }
  return '';
}

function isoBangkok(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(text);
  if (match) {
    let year = Number(match[3]); if (year > 2400) year -= 543;
    const local = `${year}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}T${String(match[4]).padStart(2, '0')}:${String(match[5]).padStart(2, '0')}:${String(match[6] || 0).padStart(2, '0')}+07:00`;
    return new Date(local).toISOString();
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

const users = objectsOf('Users');
const checkins = objectsOf('CheckIns');
const leaves = objectsOf('Leaves');
const claimRates = objectsOf('ClaimRates');
const claims = objectsOf('Claims');
const settleRates = objectsOf('SettleRates');
const settlements = objectsOf('Settlements');
const appOptions = objectsOf('AppOptions');
const receipts = objectsOf('Receipts');
const errors = [];
const warnings = [];
const usernames = new Set();

for (const row of users) {
  const username = String(row.username || '').trim().toLowerCase();
  if (!username) errors.push('Users: empty username');
  else if (usernames.has(username)) errors.push(`Users: duplicate username ${username}`);
  else usernames.add(username);
  if (!String(row.password || '')) errors.push(`Users: missing password for ${username}`);
}

function validateOwned(rows, name, dateField = '', allowLegacyDuplicates = false) {
  const ids = new Set();
  const unique = new Set();
  for (const row of rows) {
    const id = String(row.id || '').trim();
    const username = String(row.username || '').trim().toLowerCase();
    if (!id) { errors.push(`${name}: empty id`); continue; }
    if (ids.has(id)) errors.push(`${name}: duplicate id ${id}`); else ids.add(id);
    if (!usernames.has(username)) errors.push(`${name}: unknown username ${username} (${id})`);
    if (dateField) {
      const date = ymd(row[dateField]);
      if (!date) errors.push(`${name}: invalid ${dateField} (${id})`);
      const key = `${username}\0${date}`;
      if (unique.has(key)) {
        const message = `${name}: legacy duplicate ${username}/${date}`;
        if (allowLegacyDuplicates) warnings.push(message); else errors.push(message);
      } else unique.add(key);
    }
  }
}

validateOwned(checkins, 'CheckIns');
validateOwned(leaves, 'Leaves');
validateOwned(claims, 'Claims', 'inspect_date');
validateOwned(settlements, 'Settlements', 'inspect_date', true);
validateOwned(receipts, 'Receipts', 'inspect_date');

for (const row of claims) if (!Array.isArray(safeJson(row.items_json, null))) errors.push(`Claims: invalid items_json (${row.id})`);
for (const row of settlements) if (!Array.isArray(safeJson(row.rows_json, null))) errors.push(`Settlements: invalid rows_json (${row.id})`);
for (const row of appOptions) if (safeJson(row.value_json, undefined) === undefined) errors.push(`AppOptions: invalid value_json (${row.key})`);

const summary = {
  Users: users.length, CheckIns: checkins.length, Leaves: leaves.length,
  ClaimRates: claimRates.length, Claims: claims.length, SettleRates: settleRates.length,
  Settlements: settlements.length, AppOptions: appOptions.length, Receipts: receipts.length
};

if (errors.length) {
  console.error(JSON.stringify({ ok: false, summary, errors, warnings }, null, 2));
  db.close();
  process.exit(1);
}
if (validateOnly) {
  console.log(JSON.stringify({ ok: true, mode: 'validate', spreadsheetId: source.spreadsheetId, summary, warnings }, null, 2));
  db.close();
  process.exit(0);
}

const importedAt = nowIso();
transaction(() => {
  const upsertUser = db.prepare(`INSERT INTO users
    (username,password_hash,name,role,active,shipping_code,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,name=excluded.name,role=excluded.role,
      active=excluded.active,shipping_code=excluded.shipping_code,updated_at=excluded.updated_at`);
  for (const row of users) {
    const username = String(row.username).trim();
    upsertUser.run(username, passwordHash(String(row.password)), String(row.name || username), normalizeRole(row.role),
      parseActive(row.active) ? 1 : 0, String(row.shipping_code || '').trim(), importedAt, importedAt);
  }

  // Token จาก Apps Script ใช้กับ backend ใหม่ไม่ได้ และ token scaffold ต้องไม่หลงเหลือ
  db.prepare('DELETE FROM sessions').run();

  const upsertCheckin = db.prepare(`INSERT INTO checkins
    (id,server_time,local_date,device_time,username,name,type,latitude,longitude,accuracy_m,address,map_link,photo_url,photo_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET server_time=excluded.server_time,local_date=excluded.local_date,device_time=excluded.device_time,
      username=excluded.username,name=excluded.name,type=excluded.type,latitude=excluded.latitude,longitude=excluded.longitude,
      accuracy_m=excluded.accuracy_m,address=excluded.address,map_link=excluded.map_link,photo_url=excluded.photo_url,photo_id=excluded.photo_id`);
  for (const row of checkins) {
    upsertCheckin.run(String(row.id), isoBangkok(row.server_time), ymd(row.server_time), String(row.device_time || ''),
      String(row.username).trim(), String(row.name || row.username), String(row.type || 'เข้างาน'),
      Number(row.latitude) || 0, Number(row.longitude) || 0, Number(row.accuracy_m) || 0,
      String(row.address || ''), String(row.map_link || ''), String(row.photo_url || ''), String(row.photo_id || ''));
  }

  const upsertLeave = db.prepare(`INSERT INTO leaves
    (id,created_at,username,name,leave_type,start_date,end_date,days,reason,status,decided_by,decided_at,note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at,username=excluded.username,name=excluded.name,
      leave_type=excluded.leave_type,start_date=excluded.start_date,end_date=excluded.end_date,days=excluded.days,
      reason=excluded.reason,status=excluded.status,decided_by=excluded.decided_by,decided_at=excluded.decided_at,note=excluded.note`);
  for (const row of leaves) {
    upsertLeave.run(String(row.id), isoBangkok(row.created), String(row.username), String(row.name || row.username),
      String(row.leave_type || ''), ymd(row.start_date), ymd(row.end_date), Number(row.days) || 1,
      String(row.reason || ''), String(row.status || 'pending'), String(row.decided_by || ''),
      isoBangkok(row.decided_at), String(row.note || ''));
  }

  const updateClaimRate = db.prepare('UPDATE claim_rates SET rate=?,reasons_json=?,updated_at=? WHERE key=?');
  for (const row of claimRates) updateClaimRate.run(Number(row.rate) || 0, JSON.stringify(safeJson(row.reasons, [])), importedAt, String(row.key));

  const upsertClaim = db.prepare(`INSERT INTO claims
    (id,created_at,updated_at,username,name,inspect_date,containers,total,edit_count,items_json,detail,detail_all,detail_first,edit_details_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at,updated_at=excluded.updated_at,username=excluded.username,
      name=excluded.name,inspect_date=excluded.inspect_date,containers=excluded.containers,total=excluded.total,
      edit_count=excluded.edit_count,items_json=excluded.items_json,detail=excluded.detail,detail_all=excluded.detail_all,
      detail_first=excluded.detail_first,edit_details_json=excluded.edit_details_json`);
  for (const row of claims) {
    const editDetails = [1, 2, 3, 4, 5].map((index) => String(row[`edit_detail_${index}`] || ''));
    const detail = String(row.detail || '');
    upsertClaim.run(String(row.id), isoBangkok(row.created), isoBangkok(row.updated), String(row.username),
      String(row.name || row.username), ymd(row.inspect_date), Number(row.containers) || 0, Number(row.total) || 0,
      Number(row.edit_count) || 0, JSON.stringify(safeJson(row.items_json, [])), detail,
      String(row.detail_all || detail), String(row.detail_first || detail), JSON.stringify(editDetails));
  }

  const updateSettleRate = db.prepare('UPDATE settle_rates SET rate=?,updated_at=? WHERE key=?');
  for (const row of settleRates) updateSettleRate.run(Number(row.rate) || 0, importedAt, String(row.key));

  const upsertSettlement = db.prepare(`INSERT INTO settlements
    (id,created_at,updated_at,username,name,inspect_date,claim_total,total_expense,balance,edit_count,returned_date,
     company_returned_date,rows_json,detail,image_url,slip_url,slip_txn,slip_amount,slip_date,slip_status,slip_bank,legacy_duplicate)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at,updated_at=excluded.updated_at,username=excluded.username,
      name=excluded.name,inspect_date=excluded.inspect_date,claim_total=excluded.claim_total,total_expense=excluded.total_expense,
      balance=excluded.balance,edit_count=excluded.edit_count,returned_date=excluded.returned_date,
      company_returned_date=excluded.company_returned_date,rows_json=excluded.rows_json,detail=excluded.detail,
      image_url=excluded.image_url,slip_url=excluded.slip_url,slip_txn=excluded.slip_txn,slip_amount=excluded.slip_amount,
      slip_date=excluded.slip_date,slip_status=excluded.slip_status,slip_bank=excluded.slip_bank,
      legacy_duplicate=excluded.legacy_duplicate`);
  const settlementDates = new Set();
  for (const row of settlements) {
    if (!String(row.id || '').trim()) continue;
    const settlementDate = ymd(row.inspect_date);
    const settlementKey = `${String(row.username).toLowerCase()}\0${settlementDate}`;
    const legacyDuplicate = settlementDates.has(settlementKey) ? 1 : 0;
    settlementDates.add(settlementKey);
    upsertSettlement.run(String(row.id), isoBangkok(row.created), isoBangkok(row.updated), String(row.username),
      String(row.name || row.username), settlementDate, Number(row.claim_total) || 0,
      Number(row.total_expense) || 0, Number(row.balance) || 0, Number(row.edit_count) || 0,
      ymd(row.returned_date), ymd(row.company_returned_date), JSON.stringify(safeJson(row.rows_json, [])),
      String(row.detail || ''), String(row.image_url || ''), String(row.slip_url || ''), String(row.slip_txn || ''),
      Number(row.slip_amount) || 0, ymd(row.slip_date), String(row.slip_status || ''), String(row.slip_bank || ''),
      legacyDuplicate);
  }

  const upsertOption = db.prepare(`INSERT INTO app_options (key,value_json,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`);
  for (const row of appOptions) upsertOption.run(String(row.key), JSON.stringify(safeJson(row.value_json, null)), importedAt);

  const upsertReceipt = db.prepare(`INSERT INTO receipts
    (id,server_time,device_time,username,name,note,latitude,longitude,accuracy_m,address,map_link,photo_url,photo_id,inspect_date,retake_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET server_time=excluded.server_time,device_time=excluded.device_time,username=excluded.username,
      name=excluded.name,note=excluded.note,latitude=excluded.latitude,longitude=excluded.longitude,
      accuracy_m=excluded.accuracy_m,address=excluded.address,map_link=excluded.map_link,photo_url=excluded.photo_url,
      photo_id=excluded.photo_id,inspect_date=excluded.inspect_date,retake_count=excluded.retake_count`);
  for (const row of receipts) {
    upsertReceipt.run(String(row.id), isoBangkok(row.server_time), String(row.device_time || ''), String(row.username),
      String(row.name || row.username), String(row.note || ''), Number(row.latitude) || 0, Number(row.longitude) || 0,
      Number(row.accuracy_m) || 0, String(row.address || ''), String(row.map_link || ''), String(row.photo_url || ''),
      String(row.photo_id || ''), ymd(row.inspect_date), Number(row.retake_count) || 0);
  }
});

const counts = {};
for (const [label, table] of Object.entries({
  Users: 'users', CheckIns: 'checkins', Leaves: 'leaves', ClaimRates: 'claim_rates', Claims: 'claims',
  SettleRates: 'settle_rates', Settlements: 'settlements', AppOptions: 'app_options', Receipts: 'receipts', Sessions: 'sessions'
})) counts[label] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
const quickCheck = db.prepare('PRAGMA quick_check').get().quick_check;
const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all();
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();

console.log(JSON.stringify({
  ok: quickCheck === 'ok' && foreignKeyErrors.length === 0,
  mode: 'import', spreadsheetId: source.spreadsheetId, sourceSummary: summary,
  databaseCounts: counts, warnings, quickCheck, foreignKeyErrors
}, null, 2));
