import fs from 'node:fs';
import path from 'node:path';
import { db, transaction } from '../src/db.js';
import { nowIso } from '../src/utils.js';

const sourcePath = path.resolve(process.argv[2] || 'data/imports/transport-sheet-export.json');
const validateOnly = process.argv.includes('--validate');
if (!fs.existsSync(sourcePath)) {
  console.error(`Source not found: ${sourcePath}`);
  process.exit(1);
}

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const records = Array.isArray(source.records) ? source.records : [];
const errors = [];
const warnings = [];
const validDate = /^\d{4}-\d{2}-\d{2}$/;
for (let index = 0; index < records.length; index++) {
  const row = records[index] || {};
  if (!validDate.test(String(row.transport_date || ''))) errors.push(`row ${index + 1}: invalid transport_date`);
  if (!String(row.shipping || '').trim()) warnings.push(`row ${index + 1}: missing shipping (kept for history; lookup will skip it)`);
  if (!String(row.bl || '').trim()) errors.push(`row ${index + 1}: missing bl`);
}
const dates = records.map((row) => row.transport_date).sort();
const summary = {
  sourceName: source.sourceName || '', records: records.length,
  firstDate: dates[0] || '', lastDate: dates.at(-1) || '',
  sheets: [...new Set(records.map((row) => row.source_sheet))]
};
if (errors.length) {
  console.error(JSON.stringify({ ok: false, summary, errors: errors.slice(0, 100), warnings }, null, 2));
  db.close();
  process.exit(1);
}
if (validateOnly) {
  console.log(JSON.stringify({ ok: true, mode: 'validate', spreadsheetId: source.spreadsheetId, summary, warnings }, null, 2));
  db.close();
  process.exit(0);
}

const importedAt = nowIso();
const sources = [...new Set(records.map((row) => String(row.source_file || source.sourceName || 'transport-import')))];
const insert = db.prepare(`INSERT INTO transport_jobs
  (transport_date,shipping,bl,container_no,quantity,port,customer,source_file,source_sheet,source_name,imported_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
transaction(() => {
  const remove = db.prepare('DELETE FROM transport_jobs WHERE source_file = ?');
  for (const sourceFile of sources) remove.run(sourceFile);
  for (const row of records) {
    insert.run(String(row.transport_date), String(row.shipping), String(row.bl), String(row.container_no || ''),
      Number(row.quantity) || 0, String(row.port || ''), String(row.customer || ''), String(row.source_file || ''),
      String(row.source_sheet || ''), String(row.source_name || ''), importedAt);
  }
});

const count = Number(db.prepare('SELECT COUNT(*) AS n FROM transport_jobs').get().n);
const quickCheck = db.prepare('PRAGMA quick_check').get().quick_check;
const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all();
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
console.log(JSON.stringify({
  ok: quickCheck === 'ok' && foreignKeyErrors.length === 0,
  mode: 'import', spreadsheetId: source.spreadsheetId, summary,
  databaseTransportRows: count, warnings, quickCheck, foreignKeyErrors
}, null, 2));
