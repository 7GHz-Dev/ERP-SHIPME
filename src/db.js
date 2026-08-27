import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import {
  CLAIM_ITEM_DEFAULTS,
  SETTLE_COST_COLUMNS,
  SETTLE_RATE_DEFAULTS
} from './constants.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'checkin.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    shipping_code TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE REFERENCES users(username) ON UPDATE CASCADE ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    device TEXT NOT NULL DEFAULT ''
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(username, expires_at);

  CREATE TABLE IF NOT EXISTS checkins (
    id TEXT PRIMARY KEY,
    server_time TEXT NOT NULL,
    local_date TEXT NOT NULL,
    device_time TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL COLLATE NOCASE REFERENCES users(username) ON UPDATE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    accuracy_m REAL NOT NULL DEFAULT 0,
    address TEXT NOT NULL DEFAULT '',
    map_link TEXT NOT NULL DEFAULT '',
    photo_url TEXT NOT NULL DEFAULT '',
    photo_id TEXT NOT NULL DEFAULT '',
    UNIQUE(username, local_date)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS checkins_time_idx ON checkins(server_time DESC);

  CREATE TABLE IF NOT EXISTS leaves (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    username TEXT NOT NULL COLLATE NOCASE REFERENCES users(username) ON UPDATE CASCADE,
    name TEXT NOT NULL,
    leave_type TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    days INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT NOT NULL DEFAULT '',
    decided_at TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT ''
  ) STRICT;
  CREATE INDEX IF NOT EXISTS leaves_user_idx ON leaves(username, created_at DESC);

  CREATE TABLE IF NOT EXISTS app_options (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS claim_rates (
    key TEXT PRIMARY KEY,
    rate REAL NOT NULL DEFAULT 0,
    reasons_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    username TEXT NOT NULL COLLATE NOCASE REFERENCES users(username) ON UPDATE CASCADE,
    name TEXT NOT NULL,
    inspect_date TEXT NOT NULL,
    containers INTEGER NOT NULL,
    total REAL NOT NULL,
    edit_count INTEGER NOT NULL DEFAULT 0,
    items_json TEXT NOT NULL,
    detail TEXT NOT NULL,
    detail_all TEXT NOT NULL,
    detail_first TEXT NOT NULL,
    edit_details_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE(username, inspect_date)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS claims_user_idx ON claims(username, inspect_date DESC);

  CREATE TABLE IF NOT EXISTS settle_rates (
    key TEXT PRIMARY KEY,
    rate REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS slips (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE REFERENCES users(username) ON UPDATE CASCADE,
    uploaded_at TEXT NOT NULL,
    file_name TEXT NOT NULL,
    url TEXT NOT NULL,
    info_json TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS settlements (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    username TEXT NOT NULL COLLATE NOCASE REFERENCES users(username) ON UPDATE CASCADE,
    name TEXT NOT NULL,
    inspect_date TEXT NOT NULL,
    claim_total REAL NOT NULL,
    total_expense REAL NOT NULL,
    balance REAL NOT NULL,
    edit_count INTEGER NOT NULL DEFAULT 0,
    returned_date TEXT NOT NULL DEFAULT '',
    company_returned_date TEXT NOT NULL DEFAULT '',
    rows_json TEXT NOT NULL,
    detail TEXT NOT NULL,
    image_url TEXT NOT NULL DEFAULT '',
    slip_url TEXT NOT NULL DEFAULT '',
    slip_txn TEXT NOT NULL DEFAULT '',
    slip_amount REAL NOT NULL DEFAULT 0,
    slip_date TEXT NOT NULL DEFAULT '',
    slip_status TEXT NOT NULL DEFAULT '',
    slip_bank TEXT NOT NULL DEFAULT '',
    legacy_duplicate INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS settlements_slip_txn_idx ON settlements(UPPER(slip_txn)) WHERE slip_txn <> '';

  CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY,
    server_time TEXT NOT NULL,
    device_time TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL COLLATE NOCASE REFERENCES users(username) ON UPDATE CASCADE,
    name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    accuracy_m REAL NOT NULL DEFAULT 0,
    address TEXT NOT NULL DEFAULT '',
    map_link TEXT NOT NULL DEFAULT '',
    photo_url TEXT NOT NULL,
    photo_id TEXT NOT NULL,
    inspect_date TEXT NOT NULL,
    retake_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(username, inspect_date)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS receipts_time_idx ON receipts(server_time DESC);

  CREATE TABLE IF NOT EXISTS transport_jobs (
    id INTEGER PRIMARY KEY,
    transport_date TEXT NOT NULL,
    shipping TEXT NOT NULL DEFAULT '',
    bl TEXT NOT NULL DEFAULT '',
    container_no TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL DEFAULT 0,
    port TEXT NOT NULL DEFAULT '',
    customer TEXT NOT NULL DEFAULT '',
    source_file TEXT NOT NULL DEFAULT '',
    source_sheet TEXT NOT NULL DEFAULT '',
    source_name TEXT NOT NULL DEFAULT '',
    imported_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS transport_lookup_idx ON transport_jobs(transport_date, shipping);

  CREATE TABLE IF NOT EXISTS geocode_cache (
    point TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
`);

// v2.1: ชีตเดิมมีใบปิดบัญชีบางวันมากกว่า 1 ใบต่อคน ต้องเก็บประวัติทั้งหมด
// แต่ข้อมูลที่สร้างใหม่ยังใช้ partial unique index กันกดซ้ำพร้อมกันตามเดิม
const settlementColumns = db.prepare('PRAGMA table_info(settlements)').all().map((row) => row.name);
if (!settlementColumns.includes('legacy_duplicate')) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP INDEX IF EXISTS settlements_slip_txn_idx;
    ALTER TABLE settlements RENAME TO settlements_before_legacy_duplicates;
    CREATE TABLE settlements (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      username TEXT NOT NULL COLLATE NOCASE REFERENCES users(username) ON UPDATE CASCADE,
      name TEXT NOT NULL,
      inspect_date TEXT NOT NULL,
      claim_total REAL NOT NULL,
      total_expense REAL NOT NULL,
      balance REAL NOT NULL,
      edit_count INTEGER NOT NULL DEFAULT 0,
      returned_date TEXT NOT NULL DEFAULT '',
      company_returned_date TEXT NOT NULL DEFAULT '',
      rows_json TEXT NOT NULL,
      detail TEXT NOT NULL,
      image_url TEXT NOT NULL DEFAULT '',
      slip_url TEXT NOT NULL DEFAULT '',
      slip_txn TEXT NOT NULL DEFAULT '',
      slip_amount REAL NOT NULL DEFAULT 0,
      slip_date TEXT NOT NULL DEFAULT '',
      slip_status TEXT NOT NULL DEFAULT '',
      slip_bank TEXT NOT NULL DEFAULT '',
      legacy_duplicate INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    INSERT INTO settlements
      (id,created_at,updated_at,username,name,inspect_date,claim_total,total_expense,balance,edit_count,
       returned_date,company_returned_date,rows_json,detail,image_url,slip_url,slip_txn,slip_amount,
       slip_date,slip_status,slip_bank,legacy_duplicate)
    SELECT id,created_at,updated_at,username,name,inspect_date,claim_total,total_expense,balance,edit_count,
       returned_date,company_returned_date,rows_json,detail,image_url,slip_url,slip_txn,slip_amount,
       slip_date,slip_status,slip_bank,0
    FROM settlements_before_legacy_duplicates;
    DROP TABLE settlements_before_legacy_duplicates;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS settlements_new_date_idx
    ON settlements(username, inspect_date) WHERE legacy_duplicate = 0;
  CREATE UNIQUE INDEX IF NOT EXISTS settlements_slip_txn_idx
    ON settlements(UPPER(slip_txn)) WHERE slip_txn <> '';
`);

export function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function passwordMatches(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const actual = crypto.scryptSync(String(password), parts[1], 64);
  const expected = Buffer.from(parts[2], 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const now = new Date().toISOString();
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (!userCount) {
  db.prepare(`INSERT INTO users
    (username, password_hash, name, role, active, shipping_code, created_at, updated_at)
    VALUES (?, ?, ?, 'admin', 1, '', ?, ?)`)
    .run(config.adminUsername, passwordHash(config.adminPassword), config.adminName, now, now);
  if (process.env.NODE_ENV === 'production' && config.adminPassword === '1234') {
    console.warn('SECURITY: Set ADMIN_PASSWORD before first production start.');
  }
} else if (userCount === 1 && process.env.ADMIN_PASSWORD) {
  // รองรับฐานข้อมูล scaffold ที่เคยถูกเปิดด้วยค่า dev 1234: เมื่อผู้ดูแลตั้ง .env
  // ครั้งแรก ให้เปลี่ยนรหัสเริ่มต้นทันที แต่จะไม่ทับรหัสที่ผู้ดูแลเปลี่ยนเองแล้ว
  const seeded = db.prepare('SELECT username, password_hash FROM users LIMIT 1').get();
  if (seeded?.username.toLowerCase() === config.adminUsername.toLowerCase()
      && passwordMatches('1234', seeded.password_hash)
      && config.adminPassword !== '1234') {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE username = ? COLLATE NOCASE')
      .run(passwordHash(config.adminPassword), now, seeded.username);
    db.prepare('DELETE FROM sessions').run();
  }
}

const insertClaimRate = db.prepare(`INSERT OR IGNORE INTO claim_rates
  (key, rate, reasons_json, updated_at) VALUES (?, ?, ?, ?)`);
for (const item of CLAIM_ITEM_DEFAULTS) {
  insertClaimRate.run(item.key, Number(item.rate) || 0, JSON.stringify(item.reasons || []), now);
}

const insertSettleRate = db.prepare(`INSERT OR IGNORE INTO settle_rates
  (key, rate, updated_at) VALUES (?, ?, ?)`);
for (const item of SETTLE_COST_COLUMNS) {
  insertSettleRate.run(item.key, Number(SETTLE_RATE_DEFAULTS[item.key]) || 0, now);
}
