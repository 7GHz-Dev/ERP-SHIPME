import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, passwordHash, transaction } from '../src/db.js';
import { normalizeRole, nowIso, parseActive, safeJson, ymd } from '../src/utils.js';
import { pick, readObjects, toIso, toYmd } from './csv.mjs';

const sourceDir = path.resolve(process.argv[2] || 'legacy-export');
if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
  console.error('Usage: npm run import:legacy -- <directory containing Users.csv, CheckIns.csv, ...>');
  process.exit(1);
}

const csvFiles = Object.fromEntries(fs.readdirSync(sourceDir)
  .filter((name) => name.toLowerCase().endsWith('.csv'))
  .map((name) => [path.parse(name).name.toLowerCase(), path.join(sourceDir, name)]));
const rowsOf = (name) => csvFiles[name.toLowerCase()] ? readObjects(csvFiles[name.toLowerCase()]) : [];
const count = {};
const iso = (value) => toIso(value) || nowIso();
const json = (value, fallback = []) => JSON.stringify(safeJson(value, fallback));

transaction(() => {
  const users = rowsOf('Users');
  const upsertUser = db.prepare(`INSERT INTO users (username,password_hash,name,role,active,shipping_code,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,name=excluded.name,
    role=excluded.role,active=excluded.active,shipping_code=excluded.shipping_code,updated_at=excluded.updated_at`);
  for (const row of users) {
    const username = String(pick(row, ['username', 'user'])).trim();
    if (!username) continue;
    upsertUser.run(username, passwordHash(pick(row, ['password', 'pass']) || crypto.randomUUID()),
      String(pick(row, ['name', 'ชื่อ'], username)), normalizeRole(pick(row, ['role', 'สิทธิ์'])),
      parseActive(pick(row, ['active', 'ใช้งาน'], 'yes')) ? 1 : 0,
      String(pick(row, ['shipping_code', 'shippingcode', 'รหัสชิปปิ้ง'])), nowIso(), nowIso());
  }
  count.Users = users.length;

  const checkins = rowsOf('CheckIns');
  const insertCheckin = db.prepare(`INSERT OR IGNORE INTO checkins
    (id,server_time,local_date,device_time,username,name,type,latitude,longitude,accuracy_m,address,map_link,photo_url,photo_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of checkins) {
    const username = String(pick(row, ['username'])).trim();
    if (!username || !db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(username)) continue;
    const serverTime = iso(pick(row, ['server_time', 'time', 'timestamp']));
    insertCheckin.run(String(pick(row, ['id'])) || `CK${Date.now()}${count.CheckIns || 0}`, serverTime,
      toYmd(serverTime) || ymd(new Date(serverTime)), String(pick(row, ['device_time'])), username,
      String(pick(row, ['name'], username)), String(pick(row, ['type'], 'เข้างาน')),
      Number(pick(row, ['latitude', 'lat'])) || 0, Number(pick(row, ['longitude', 'lng'])) || 0,
      Number(pick(row, ['accuracy_m', 'accuracy'])) || 0, String(pick(row, ['address'])),
      String(pick(row, ['map_link', 'maplink'])), String(pick(row, ['photo_url', 'photourl'])), String(pick(row, ['photo_id', 'photoid'])));
  }
  count.CheckIns = checkins.length;

  const leaves = rowsOf('Leaves');
  const insertLeave = db.prepare(`INSERT OR REPLACE INTO leaves
    (id,created_at,username,name,leave_type,start_date,end_date,days,reason,status,decided_by,decided_at,note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of leaves) {
    const username = String(pick(row, ['username'])).trim();
    if (!username || !db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(username)) continue;
    insertLeave.run(String(pick(row, ['id'])), iso(pick(row, ['created'])), username, String(pick(row, ['name'], username)),
      String(pick(row, ['leave_type', 'leavetype'])), toYmd(pick(row, ['start_date', 'startdate'])),
      toYmd(pick(row, ['end_date', 'enddate'])), Number(pick(row, ['days'])) || 1, String(pick(row, ['reason'])),
      String(pick(row, ['status'], 'pending')), String(pick(row, ['decided_by', 'decidedby'])),
      toIso(pick(row, ['decided_at', 'decidedat'])), String(pick(row, ['note'])));
  }
  count.Leaves = leaves.length;

  for (const row of rowsOf('AppOptions')) {
    const key = String(pick(row, ['key'])).trim(); if (!key) continue;
    db.prepare(`INSERT INTO app_options (key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(key, String(pick(row, ['value_json', 'valuejson'])) || 'null', nowIso());
  }
  count.AppOptions = rowsOf('AppOptions').length;

  for (const row of rowsOf('ClaimRates')) {
    const key = String(pick(row, ['key'])).trim(); if (!key) continue;
    db.prepare('UPDATE claim_rates SET rate=?,reasons_json=?,updated_at=? WHERE key=?')
      .run(Number(pick(row, ['rate'])) || 0, json(pick(row, ['reasons']), []), nowIso(), key);
  }
  count.ClaimRates = rowsOf('ClaimRates').length;

  const claims = rowsOf('Claims');
  const insertClaim = db.prepare(`INSERT OR REPLACE INTO claims
    (id,created_at,updated_at,username,name,inspect_date,containers,total,edit_count,items_json,detail,detail_all,detail_first,edit_details_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of claims) {
    const username = String(pick(row, ['username'])).trim();
    if (!username || !db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(username)) continue;
    const edits = [1,2,3,4,5].map((n) => String(pick(row, [`edit_detail_${n}`, `editdetail${n}`])));
    const detail = String(pick(row, ['detail']));
    insertClaim.run(String(pick(row, ['id'])), iso(pick(row, ['created'])), iso(pick(row, ['updated'])), username,
      String(pick(row, ['name'], username)), toYmd(pick(row, ['inspect_date', 'inspectdate'])),
      Number(pick(row, ['containers'])) || 0, Number(pick(row, ['total'])) || 0, Number(pick(row, ['edit_count', 'editcount'])) || 0,
      json(pick(row, ['items_json', 'itemsjson']), []), detail, String(pick(row, ['detail_all', 'detailall'], detail)),
      String(pick(row, ['detail_first', 'detailfirst'], detail)), JSON.stringify(edits));
  }
  count.Claims = claims.length;

  for (const row of rowsOf('SettleRates')) {
    const key = String(pick(row, ['key'])).trim(); if (!key) continue;
    db.prepare('UPDATE settle_rates SET rate=?,updated_at=? WHERE key=?').run(Number(pick(row, ['rate'])) || 0, nowIso(), key);
  }
  count.SettleRates = rowsOf('SettleRates').length;

  const settlements = rowsOf('Settlements');
  const insertSettlement = db.prepare(`INSERT OR REPLACE INTO settlements
    (id,created_at,updated_at,username,name,inspect_date,claim_total,total_expense,balance,edit_count,returned_date,
     company_returned_date,rows_json,detail,image_url,slip_url,slip_txn,slip_amount,slip_date,slip_status,slip_bank)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of settlements) {
    const username = String(pick(row, ['username'])).trim();
    if (!username || !db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(username)) continue;
    insertSettlement.run(String(pick(row, ['id'])), iso(pick(row, ['created'])), iso(pick(row, ['updated'])), username,
      String(pick(row, ['name'], username)), toYmd(pick(row, ['inspect_date'])), Number(pick(row, ['claim_total'])) || 0,
      Number(pick(row, ['total_expense'])) || 0, Number(pick(row, ['balance'])) || 0, Number(pick(row, ['edit_count'])) || 0,
      toYmd(pick(row, ['returned_date'])), toYmd(pick(row, ['company_returned_date'])),
      json(pick(row, ['rows_json']), []), String(pick(row, ['detail'])), String(pick(row, ['image_url'])),
      String(pick(row, ['slip_url'])), String(pick(row, ['slip_txn'])), Number(pick(row, ['slip_amount'])) || 0,
      toYmd(pick(row, ['slip_date'])), String(pick(row, ['slip_status'])), String(pick(row, ['slip_bank'])));
  }
  count.Settlements = settlements.length;

  const receipts = rowsOf('Receipts');
  const insertReceipt = db.prepare(`INSERT OR REPLACE INTO receipts
    (id,server_time,device_time,username,name,note,latitude,longitude,accuracy_m,address,map_link,photo_url,photo_id,inspect_date,retake_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of receipts) {
    const username = String(pick(row, ['username'])).trim();
    if (!username || !db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(username)) continue;
    insertReceipt.run(String(pick(row, ['id'])), iso(pick(row, ['server_time', 'time'])), String(pick(row, ['device_time'])),
      username, String(pick(row, ['name'], username)), String(pick(row, ['note'])),
      Number(pick(row, ['latitude', 'lat'])) || 0, Number(pick(row, ['longitude', 'lng'])) || 0,
      Number(pick(row, ['accuracy_m', 'accuracy'])) || 0, String(pick(row, ['address'])),
      String(pick(row, ['map_link'])), String(pick(row, ['photo_url'])), String(pick(row, ['photo_id'])),
      toYmd(pick(row, ['inspect_date'])), Number(pick(row, ['retake_count'])) || 0);
  }
  count.Receipts = receipts.length;
});

console.table(count);
console.log('Legacy CSV import complete. Sessions were intentionally skipped; every user must sign in again.');
db.close();
