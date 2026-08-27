import { db } from './db.js';
import { TRANSPORT_SOURCE_ORDER, TRANSPORT_SOURCE_STYLE } from './constants.js';

const normPerson = (value) => String(value ?? '').toLowerCase().replace(/[\s​.]+/g, '');

function personMatches(value, user) {
  const cell = normPerson(value);
  if (!cell) return false;
  const shippingCode = normPerson(user.shippingCode);
  if (shippingCode) return cell === shippingCode;
  for (const key of [normPerson(user.username), normPerson(user.name)]) {
    if (!key) continue;
    if (cell === key || (key.length >= 3 && cell.includes(key)) || (cell.length >= 3 && key.includes(cell))) return true;
  }
  return false;
}

function sourcePriority(source) {
  const value = String(source || '').toUpperCase();
  const index = TRANSPORT_SOURCE_ORDER.findIndex((item) => value.includes(item));
  return index < 0 ? TRANSPORT_SOURCE_ORDER.length : index;
}

export function lookupTransport(date, user) {
  const sourceRows = db.prepare('SELECT * FROM transport_jobs WHERE transport_date = ? ORDER BY id').all(date)
    .filter((row) => personMatches(row.shipping, user));
  const groups = new Map();
  for (const row of sourceRows) {
    const key = String(row.bl || `(ไม่มีเลข BL) ${row.id}`).toUpperCase();
    if (!groups.has(key)) {
      groups.set(key, {
        bl: row.bl, port: row.port, customer: row.customer,
        source: row.source_name, sheet: row.source_sheet, file: row.source_file,
        quantity: 0, containers: new Set(), rowCount: 0, first: row.id
      });
    }
    const group = groups.get(key);
    if (!group.port) group.port = row.port;
    if (!group.customer) group.customer = row.customer;
    group.quantity += Number(row.quantity) || 0;
    if (row.container_no) group.containers.add(String(row.container_no).toUpperCase());
    group.rowCount++;
  }
  const rows = [...groups.values()].sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source) || a.first - b.first)
    .map((group) => {
      const containers = Math.round(group.quantity || group.containers.size || group.rowCount);
      return {
        bl: group.bl, port: group.port, customer: group.customer, containers,
        sheet: group.sheet, file: group.file, source: group.source,
        style: TRANSPORT_SOURCE_STYLE[group.source] || ''
      };
    });
  return {
    ok: true,
    rows,
    totalContainers: rows.reduce((sum, row) => sum + row.containers, 0),
    rowsMatched: sourceRows.length,
    scanned: [...new Set(sourceRows.map((row) => `${row.source_file}\0${row.source_sheet}`))].map((key) => {
      const [file, sheet] = key.split('\0');
      return { file, sheet, used: true, matched: sourceRows.filter((row) => row.source_file === file && row.source_sheet === sheet).length };
    }),
    sourceOrder: TRANSPORT_SOURCE_ORDER
  };
}

export function transportDiagnostics() {
  const stats = db.prepare(`SELECT source_file AS file, source_sheet AS sheet, COUNT(*) AS rows,
      MIN(transport_date) AS firstDate, MAX(transport_date) AS lastDate
    FROM transport_jobs GROUP BY source_file, source_sheet ORDER BY source_file, source_sheet`).all();
  const files = [...new Set(stats.map((row) => row.file || 'CSV import'))].map((name) => ({
    id: name, name, ok: true, tabs: stats.filter((row) => (row.file || 'CSV import') === name).length
  }));
  return {
    ok: true,
    files,
    sheetIds: [],
    sheetName: files.map((file) => file.name).join(' + '),
    countMode: 'auto',
    sourceOrder: TRANSPORT_SOURCE_ORDER,
    sheets: stats.map((row) => ({
      file: row.file || 'CSV import', sheet: row.sheet || 'ข้อมูลนำเข้า', rows: row.rows,
      usable: true, score: 7, found: {}, missing: [], headers: [],
      note: `${row.firstDate || '-'} ถึง ${row.lastDate || '-'}`
    }))
  };
}
