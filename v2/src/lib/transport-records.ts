import { and, asc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import { invoices, portAssignments, settlements, transportRecords, users } from '@/db/schema';
import { portKey } from './options';
import type { ApiBody, ApiResult } from './types';
import { id, nowIso, round2, safeJson } from './utils';
import { blKeyOf, cleanImport, realDate, text } from './transport-clean';

export { blKeyOf };

/**
 * ตารางขนส่งของระบบ (transport_records) — ดูคำอธิบาย 5 ส่วนใน schema.ts
 *
 * ส่วน 1 ตอนนี้ Import จากไฟล์ Transport Request (วาง Copy/Paste หรืออัปไฟล์) ที่เมนูแพลนงาน
 *   คอลัมน์ ETA → วันที่ตรวจปล่อย (TRANSPORT) · SHIPPER → ชิปเปอร์ · CON → จำนวนตู้ · BILL OF LADING → BL
 *   CONTAINER NO. (คั่นด้วย , ) → เลขตู้ · SHIPLINE → VESSEL (ช่องเดิมของชีต) · VESSEL → ชื่อเรือ · PORT → ท่า
 *   ชิปปิ้ง = ชิปปิ้งประจำท่าของเดือนนั้น (ตั้งค่าระบบ → ชิปปิ้งประจำท่า)
 *   BL + วันที่เดิม นำเข้าซ้ำ = อัปเดตเฉพาะข้อมูลส่วน 1 (ยอดส่วน 2/3 ไม่หาย)
 * ส่วน 4 / 5 อ่านสดตอนแสดงตาราง ไม่เก็บซ้ำ
 */
export const SOURCES = ['MAESOT FREEZONE', 'TRANSIT'];
const addDays = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** ชิปปิ้งประจำท่าของแต่ละเดือนที่ต้องใช้ → Map(period|portKey → username) */
async function portOwners(periods: string[]) {
  const map = new Map<string, string>();
  if (!periods.length) return map;
  const rows = await db.select({ period: portAssignments.period, portKey: portAssignments.portKey, username: portAssignments.username })
    .from(portAssignments).where(inArray(portAssignments.period, periods));
  for (const r of rows) map.set(`${r.period}|${r.portKey}`, String(r.username));
  return map;
}

async function shipperLabels() {
  const rows = await db.select({ username: users.username, name: users.name, code: users.shippingCode }).from(users);
  return new Map(rows.map((u) => [String(u.username).toLowerCase(), { name: u.name, code: u.code || '' }]));
}

/**
 * Import Transport Request — commit = false: ตรวจ/ดูตัวอย่าง · commit = true: บันทึก
 * แถวที่มีข้อผิดพลาดไม่บันทึก (แถวอื่นบันทึกได้)
 */
export async function importTransportRequest(body: ApiBody, actor: { username: string }): Promise<ApiResult> {
  return runTransportImport(body.rows, {
    source: text(body.source), commit: body.commit === true, actor: actor.username, importedFrom: 'import'
  });
}

/** ตรรกะนำเข้ากลาง — ปุ่มนำเข้าในแพลนงาน (importedFrom = import) และ ERP-KOLA (importedFrom = kola) */
export async function runTransportImport(input: unknown, opts: {
  source: string; commit: boolean; actor: string; importedFrom: 'import' | 'kola';
}): Promise<ApiResult> {
  const source = SOURCES.includes(opts.source) ? opts.source : SOURCES[0];
  const rows = cleanImport(input);
  if (!rows.length) return { ok: false, error: 'no_rows' };

  // BL ซ้ำในไฟล์เดียวกัน (วันเดียวกัน) — ใช้แถวแรก
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.error) continue;
    const k = `${r.blKey}|${r.transportDate}`;
    if (seen.has(k)) r.error = 'BL ซ้ำในไฟล์ (วันเดียวกัน)';
    seen.add(k);
  }
  const good = rows.filter((r) => !r.error);
  const periods = [...new Set(good.map((r) => r.transportDate.slice(0, 7).replace('-', '')))];
  const [owners, labels] = await Promise.all([portOwners(periods), shipperLabels()]);
  const existing = good.length ? await db.select({ id: transportRecords.id, blKey: transportRecords.blKey, transportDate: transportRecords.transportDate })
    .from(transportRecords).where(inArray(transportRecords.blKey, [...new Set(good.map((r) => r.blKey))])) : [];
  const existKey = new Map(existing.map((e) => [`${e.blKey}|${e.transportDate}`, e.id]));

  const preview = rows.map((r) => {
    const username = owners.get(`${r.transportDate.slice(0, 7).replace('-', '')}|${portKey(r.port)}`) || '';
    const who = labels.get(username.toLowerCase());
    return {
      line: r.line, transportDate: r.transportDate, customer: r.customer, bl: r.bl, containers: r.containers,
      quantity: r.quantity, vessel: r.vessel, vesselName: r.vesselName, port: r.port,
      username, shipping: who ? (who.code || who.name) : '',
      status: r.error ? 'error' : (existKey.has(`${r.blKey}|${r.transportDate}`) ? 'update' : 'new'), error: r.error || '', warning: r.warning || ''
    };
  });
  const summary = {
    total: rows.length, new: preview.filter((p) => p.status === 'new').length,
    update: preview.filter((p) => p.status === 'update').length, error: preview.filter((p) => p.status === 'error').length,
    noShipping: preview.filter((p) => p.status !== 'error' && !p.username).length
  };
  if (!opts.commit) return { ok: true, source, preview, summary, committed: false };

  const at = nowIso();
  await db.transaction(async (tx) => {
    for (const r of good) {
      const p = preview.find((x) => x.line === r.line)!;
      const part1 = {
        source, customer: r.customer, vessel: r.vessel, vesselName: r.vesselName, bl: r.bl,
        containersJson: JSON.stringify(r.containers), quantity: r.quantity, port: r.port, username: p.username,
        importedFrom: opts.importedFrom, updatedBy: opts.actor, updatedAt: at
      };
      await tx.insert(transportRecords).values({
        id: id('TR'), transportDate: r.transportDate, blKey: r.blKey, ...part1, createdBy: opts.actor, createdAt: at
      }).onConflictDoUpdate({ target: [transportRecords.blKey, transportRecords.transportDate], set: part1 });
    }
  });
  return { ok: true, source, preview, summary, committed: true };
}

/** งานที่นำเข้าแล้วของวันหนึ่ง (หน้า Import) — ไว้ตรวจและลบแถวที่นำเข้าผิด */
export async function transportRecordsDay(body: ApiBody): Promise<ApiResult> {
  const date = text(body.date, 10);
  if (!realDate(date)) return { ok: false, error: 'bad_date' };
  const rows = await db.select().from(transportRecords).where(eq(transportRecords.transportDate, date))
    .orderBy(asc(transportRecords.createdAt), asc(transportRecords.bl));
  const labels = await shipperLabels();
  return {
    ok: true, date,
    rows: rows.map((r) => {
      const who = labels.get(String(r.username).toLowerCase());
      return { id: r.id, source: r.source, transportDate: r.transportDate, customer: r.customer, vessel: r.vessel,
        vesselName: r.vesselName, bl: r.bl, containers: safeJson<string[]>(r.containersJson, []), quantity: r.quantity,
        port: r.port, shipping: who ? (who.code || who.name) : '', updatedAt: r.updatedAt };
    })
  };
}

export async function deleteTransportRecord(body: ApiBody): Promise<ApiResult> {
  const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map((v: unknown) => text(v, 60)).filter(Boolean).slice(0, 500);
  if (!ids.length) return { ok: false, error: 'bad_request' };
  const removed = await db.delete(transportRecords).where(inArray(transportRecords.id, ids)).returning({ id: transportRecords.id });
  return { ok: true, count: removed.length };
}

// ---------------- แสดงในตารางขนส่ง ----------------

const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
/** "2026-12" → "ธันวาคม69" (ชื่อเดียวกับแท็บในชีต) */
export const monthTabName = (month: string) => THAI_MONTHS[Number(month.slice(5, 7)) - 1] + String(Number(month.slice(0, 4)) + 543).slice(2);

/** แท็บรายเดือนของตารางระบบ */
export async function systemTabs() {
  return db.select({
    source: transportRecords.source,
    month: sql<string>`substr(${transportRecords.transportDate}, 1, 7)`,
    rows: sql<number>`count(*)::int`,
    from: sql<string>`min(${transportRecords.transportDate})`,
    to: sql<string>`max(${transportRecords.transportDate})`,
    syncedAt: sql<string>`max(${transportRecords.updatedAt})`
  }).from(transportRecords)
    .groupBy(transportRecords.source, sql`substr(${transportRecords.transportDate}, 1, 7)`);
}

const SPECIAL_COLUMNS: [RegExp, string][] = [
  [/(^|[^A-Z])E\s*R($|[^A-Z])/i, 'er'], [/น[็๊]?อค/, 'knock'], [/ยางเกิน/, 'tire'], [/สำแดงเท็จ/, 'falseDecl']
];

/**
 * ส่วน 4 — ค่านายตรวจ (ค่าบริการเพิ่มเติม ฟรีโซน + ผ่านแดน) และค่าพิเศษจากใบปิดบัญชีชิปปิ้ง
 * จับคู่ด้วย BL: ใบปิดบัญชีวันเดียวกับวันที่ตรวจปล่อยก่อน ไม่มีก็ใช้ใบที่อยู่ในช่วง −7 ถึง +60 วัน
 */
async function settlementParts(recs: { blKey: string; transportDate: string }[]) {
  const out = new Map<string, Record<string, number>>();
  if (!recs.length) return out;
  const dates = recs.map((r) => r.transportDate).sort();
  const rows = await db.select({ inspectDate: settlements.inspectDate, rowsJson: settlements.rowsJson }).from(settlements)
    .where(and(gte(settlements.inspectDate, addDays(dates[0], -7)), lte(settlements.inspectDate, addDays(dates[dates.length - 1], 60))));
  const byBl = new Map<string, { date: string; row: any }[]>();
  const wanted = new Set(recs.map((r) => r.blKey));
  for (const s of rows) {
    for (const row of safeJson<any[]>(s.rowsJson, [])) {
      const key = blKeyOf(row?.bl);
      if (!wanted.has(key)) continue;
      const list = byBl.get(key) || [];
      list.push({ date: s.inspectDate, row });
      byBl.set(key, list);
    }
  }
  for (const r of recs) {
    const all = byBl.get(r.blKey) || [];
    const same = all.filter((x) => x.date === r.transportDate);
    const pick = same.length ? same : all.filter((x) => x.date >= addDays(r.transportDate, -7) && x.date <= addDays(r.transportDate, 60));
    const v: Record<string, number> = { inspectorFee: 0, er: 0, knock: 0, tire: 0, falseDecl: 0 };
    for (const { row } of pick) {
      v.inspectorFee += (Number(row?.costs?.extra_service) || 0) + (Number(row?.costs?.extra_service_transit) || 0);
      for (const sp of Array.isArray(row?.specials) ? row.specials : []) {
        const hit = SPECIAL_COLUMNS.find(([re]) => re.test(String(sp?.label || '')));
        if (hit) v[hit[1]] += Number(sp?.amount) || 0;
      }
    }
    for (const k of Object.keys(v)) v[k] = round2(v[k]);
    out.set(`${r.blKey}|${r.transportDate}`, v);
  }
  return out;
}

/** ส่วน 5 — เลขที่ใบแจ้งหนี้ (ใบ V ก่อน ไม่มีใช้ NV) ของ BL */
async function invoiceNumbers(keys: string[]) {
  const out = new Map<string, string>();
  if (!keys.length) return out;
  const rows = await db.select({ number: invoices.number, kind: invoices.kind, bl: invoices.bl }).from(invoices)
    .where(and(inArray(sql`upper(regexp_replace(${invoices.bl}, '\\s+', '', 'g'))`, keys), ne(invoices.status, 'cancelled')));
  for (const kind of ['NV', 'V']) {
    for (const r of rows) if (r.kind === kind) out.set(blKeyOf(r.bl), r.number);
  }
  return out;
}

/** แถวของตารางระบบในรูปแบบเดียวกับตารางขนส่ง (transport-table.ts groupByBl) */
export async function systemRows(where: any) {
  const recs = await db.select().from(transportRecords).where(where)
    .orderBy(asc(transportRecords.transportDate), asc(transportRecords.createdAt), asc(transportRecords.bl)).limit(5000);
  const [parts, invs, labels] = await Promise.all([
    settlementParts(recs), invoiceNumbers([...new Set(recs.map((r) => r.blKey))]), shipperLabels()
  ]);
  return recs.map((r) => {
    const p = parts.get(`${r.blKey}|${r.transportDate}`) || {};
    const who = labels.get(String(r.username).toLowerCase());
    const containers = safeJson<string[]>(r.containersJson, []);
    return {
      id: r.id, transportDate: r.transportDate, customer: r.customer, vessel: r.vessel, bl: r.bl,
      containerNo: containers.join('\n'), quantity: r.quantity || containers.length,
      doFee: r.doFee, dem: r.dem, extraMovement: r.extraMovement, storage: r.storage, liftOn: r.liftOn, liftOff: r.liftOff,
      orderForm: 0, overtime: r.overtime, sealFee: r.sealFee, prb: r.prb, prbService: r.prbService,
      inspectorFee: p.inspectorFee || 0, er: p.er || 0, knock: p.knock || 0, tire: p.tire || 0, falseDecl: p.falseDecl || 0,
      detention: r.detention, repairFee: r.repairFee, otherFee: 0, note: r.note, port: r.port, docSentDate: r.docSentDate,
      shipping: who ? (who.code || who.name) : '', invoiceNo: invs.get(r.blKey) || '', driver: '', settled: false,
      source: r.source, sheet: monthTabName(r.transportDate.slice(0, 7)), system: true
    };
  });
}
