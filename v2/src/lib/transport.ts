import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { transportJobs } from '@/db/schema';
import { TRANSPORT_SOURCE_ORDER, TRANSPORT_SOURCE_STYLE } from './constants';

/** ตัดช่องว่าง จุด และ zero-width space ที่มักติดมาจากชีตงานขนส่ง */
const normPerson = (value: unknown) => String(value ?? '').toLowerCase().replace(/[\s​.]+/g, '');

type LookupUser = { username: string; name: string; shippingCode?: string };

function personMatches(value: unknown, user: LookupUser) {
  const cell = normPerson(value);
  if (!cell) return false;
  // ตั้งรหัสชิปปิ้งไว้ = ใช้รหัสตรง ๆ อย่างเดียว แม่นกว่าเดาจากชื่อ
  const shippingCode = normPerson(user.shippingCode);
  if (shippingCode) return cell === shippingCode;
  for (const key of [normPerson(user.username), normPerson(user.name)]) {
    if (!key) continue;
    if (cell === key || (key.length >= 3 && cell.includes(key)) || (cell.length >= 3 && key.includes(cell))) return true;
  }
  return false;
}

function sourcePriority(source: unknown) {
  const value = String(source || '').toUpperCase();
  const index = TRANSPORT_SOURCE_ORDER.findIndex((item) => value.includes(item));
  return index < 0 ? TRANSPORT_SOURCE_ORDER.length : index;
}

export async function lookupTransport(date: string, user: LookupUser) {
  const all = await db.select().from(transportJobs)
    .where(eq(transportJobs.transportDate, date))
    .orderBy(asc(transportJobs.id));
  const sourceRows = all.filter((row) => personMatches(row.shipping, user));

  type Group = {
    bl: string; port: string; customer: string;
    source: string; sheet: string; file: string;
    quantity: number; containers: Set<string>; rowCount: number; first: number;
  };
  const groups = new Map<string, Group>();

  for (const row of sourceRows) {
    // แถวเดียวกันของ BL เดียวกันรวมเป็นรายการเดียว (1 BL อาจมีหลายตู้หลายแถว)
    const key = String(row.bl || `(ไม่มีเลข BL) ${row.id}`).toUpperCase();
    if (!groups.has(key)) {
      groups.set(key, {
        bl: row.bl, port: row.port, customer: row.customer,
        source: row.sourceName, sheet: row.sourceSheet, file: row.sourceFile,
        quantity: 0, containers: new Set(), rowCount: 0, first: row.id
      });
    }
    const group = groups.get(key)!;
    if (!group.port) group.port = row.port;
    if (!group.customer) group.customer = row.customer;
    group.quantity += Number(row.quantity) || 0;
    if (row.containerNo) group.containers.add(String(row.containerNo).toUpperCase());
    group.rowCount++;
  }

  const rows = [...groups.values()]
    .sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source) || a.first - b.first)
    .map((group) => ({
      bl: group.bl,
      port: group.port,
      customer: group.customer,
      // มีคอลัมน์จำนวนตู้ใช้อันนั้น ไม่มีก็นับเบอร์ตู้ที่ไม่ซ้ำ ไม่มีอีกก็นับจำนวนแถว
      containers: Math.round(group.quantity || group.containers.size || group.rowCount),
      sheet: group.sheet,
      file: group.file,
      source: group.source,
      style: TRANSPORT_SOURCE_STYLE[group.source] || ''
    }));

  return {
    ok: true,
    rows,
    totalContainers: rows.reduce((sum, row) => sum + row.containers, 0),
    rowsMatched: sourceRows.length,
    scanned: [...new Set(sourceRows.map((row) => `${row.sourceFile}\0${row.sourceSheet}`))].map((key) => {
      const [file, sheet] = key.split('\0');
      return {
        file, sheet, used: true,
        matched: sourceRows.filter((row) => row.sourceFile === file && row.sourceSheet === sheet).length
      };
    }),
    sourceOrder: TRANSPORT_SOURCE_ORDER
  };
}

export async function transportDiagnostics() {
  const stats = await db.select({
    file: transportJobs.sourceFile,
    sheet: transportJobs.sourceSheet,
    rows: sql<number>`count(*)::int`,
    firstDate: sql<string>`min(${transportJobs.transportDate})`,
    lastDate: sql<string>`max(${transportJobs.transportDate})`
  })
    .from(transportJobs)
    .groupBy(transportJobs.sourceFile, transportJobs.sourceSheet)
    .orderBy(transportJobs.sourceFile, transportJobs.sourceSheet);

  const files = [...new Set(stats.map((row) => row.file || 'CSV import'))].map((name) => ({
    id: name, name, ok: true,
    tabs: stats.filter((row) => (row.file || 'CSV import') === name).length
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
