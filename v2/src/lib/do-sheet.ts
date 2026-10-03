import { DO_SHEET_ID } from './constants';
import { round2 } from './utils';

/**
 * อ่านชีต "ค่าแลกดีโอ" (public link) — วันที่จ่ายค่า DO จริงต่อ BL
 *
 * รูปแบบในชีต: หัว "วันที่ | BL | ยอด" วันที่เขียนแค่แถวแรกของวัน แถวถัดไปเว้นว่าง
 * ยอดอาจเป็น "6,300+8,000(มัดจำ)" → ค่ามัดจำไม่ใช่ค่า DO ตัดทิ้ง
 *            "4,900+1,872(โอนแยก)" → โอนแยกยังเป็นค่า DO รวมให้
 * BL อาจมีหมายเหตุภาษาไทยในวงเล็บ "KBLC-010(โอนเพิ่มชุดบี)" → BL คือ KBLC-010
 */
export type DoEntry = { date: string; bl: string; amount: number; raw: string; note: string; tab: string };

/** CSV ทีละบรรทัด รองรับค่าที่มีจุลภาคในเครื่องหมายคำพูด ("18,300") */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** "1/9/2026" (ค.ศ.) หรือ "1/9/2569" (พ.ศ.) → 2026-09-01 */
function parseDate(value: string) {
  const m = String(value).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  let year = Number(m[3]);
  if (year > 2400) year -= 543;
  return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** ยอดค่า DO จาก "6,300+8,000(มัดจำ)" — ไม่นับส่วนที่หมายเหตุว่ามัดจำ */
export function parseDoAmount(value: string) {
  let total = 0;
  for (const part of String(value).split('+')) {
    const m = part.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(?:\(([^)]*)\)?)?/);
    if (!m) continue;
    if (/มัดจำ/.test(m[2] || '')) continue;
    total += Number(m[1]);
  }
  return round2(total);
}

/** แยก BL ออกจากหมายเหตุภาษาไทยในวงเล็บ — วงเล็บที่เป็นเลข BL (ONEYTYOG…) คงไว้ */
export function splitBl(value: string) {
  const raw = String(value).trim();
  const thai = raw.match(/^(.*?)\s*\(([^)]*[ก-๙][^)]*)\)?\s*$/);
  return thai ? { bl: thai[1].trim(), note: thai[2].trim() } : { bl: raw, note: '' };
}

export function parseDoTab(csv: string, tab: string): DoEntry[] {
  const out: DoEntry[] = [];
  let date = '';
  for (const cells of parseCsv(csv)) {
    const [c0 = '', c1 = '', c2 = ''] = cells;
    const d = parseDate(c0);
    if (d) date = d;
    if (!date || !c1.trim() || !c2.trim()) continue;      // หัวชีต / แถวว่าง
    const { bl, note } = splitBl(c1);
    const amount = parseDoAmount(c2);
    out.push({ date, bl, amount, raw: c2.trim(), note, tab });
  }
  return out;
}

let cache: { at: number; entries: DoEntry[]; tabs: string[] } | null = null;

/** อ่านทุกแท็บของชีต (แท็บใหม่แต่ละเดือนเจอเอง) — จำไว้ 1 นาที */
export async function readDoSheet(): Promise<{ entries: DoEntry[]; tabs: string[] }> {
  if (cache && Date.now() - cache.at < 60_000) return cache;
  const base = `https://docs.google.com/spreadsheets/d/${DO_SHEET_ID}`;
  const view = await fetch(`${base}/htmlview`, { cache: 'no-store' });
  if (!view.ok) throw new Error(`do_sheet_http_${view.status}`);
  const html = await view.text();
  const tabs = [...html.matchAll(/\{name:\s*"([^"]+)",[^}]*?gid:\s*"(\d+)"/g)].map((m) => ({ name: m[1], gid: m[2] }));
  if (!tabs.length) throw new Error('do_sheet_no_tabs');
  const entries: DoEntry[] = [];
  // ทีละแท็บ ไม่ยิงพร้อมกัน — Google ตอบ 429 ถ้าถี่เกิน
  for (const tab of tabs) {
    const res = await fetch(`${base}/export?format=csv&gid=${tab.gid}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`do_sheet_http_${res.status}`);
    entries.push(...parseDoTab(await res.text(), tab.name));
  }
  cache = { at: Date.now(), entries, tabs: tabs.map((t) => t.name) };
  return cache;
}
