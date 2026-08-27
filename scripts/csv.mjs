import fs from 'node:fs';

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { value += '"'; index++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n') { row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = ''; }
    else value += char;
  }
  if (value || row.length) { row.push(value.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

export function readObjects(filePath) {
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  if (!rows.length) return [];
  const headers = rows[0].map((value) => String(value || '').trim());
  return rows.slice(1).filter((row) => row.some((value) => String(value || '').trim())).map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
}

export const normHeader = (value) => String(value || '').toLowerCase().replace(/[\s​._\-()[\]:/]+/g, '');

export function pick(row, aliases, fallback = '') {
  const map = Object.fromEntries(Object.entries(row).map(([key, value]) => [normHeader(key), value]));
  for (const alias of aliases) {
    const key = normHeader(alias);
    if (map[key] !== undefined) return map[key];
  }
  return fallback;
}

export function toYmd(value) {
  const source = String(value || '').trim();
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(source);
  if (match) {
    let year = Number(match[1]); if (year > 2400) year -= 543;
    return `${year}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  }
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(source);
  if (match) {
    let year = Number(match[3]); if (year > 2400) year -= 543;
    return `${year}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
  }
  return '';
}

export function toIso(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  const parsed = new Date(source);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  const date = toYmd(source);
  return date ? `${date}T00:00:00.000+07:00` : '';
}
