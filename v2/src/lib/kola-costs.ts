import { and, inArray, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import { invoices, settlements, transportJobs } from '@/db/schema';
import { blKey as occKey, reusedBls } from './bl-occurrence';
import { INVOICE_VAT_EXEMPT_LABELS, SETTLE_COST_COLUMNS, VAT_RATE } from './constants';
import { fmtDateStr, round2, safeJson } from './utils';

/**
 * ค่าใช้จ่ายราย BL → เมนู Total cost ของฝ่ายบัญชี ERP KOLA
 * สเปกฝั่ง KOLA: docs/SHIPME-COSTS-API.md ใน ERP-KOLA — POST /api/shipme/costs
 *
 * ส่งพร้อมค่าบริการเพิ่มเติมพิเศษ (pushKolaSpecials) ตอนจัดชุด / เพิ่มใบเข้าชุด / กดส่งซ้ำ — คีย์เดียวกัน (KOLA_SPECIALS_KEY)
 * ส่งรายการดิบทีละบรรทัด ไม่จัดหมวดเอง — KOLA จัดหมวด คิดหัก ณ ที่จ่าย 3% และกันนับซ้ำเอง
 *   INVOICE    บรรทัดในใบแจ้งหนี้ ADV (V/NV ที่ไม่ยกเลิก) — amount = ยอดในใบ (ก่อน VAT), vat = 7% ของบรรทัดที่เข้าฐานภาษี
 *   SETTLEMENT ช่องค่าใช้จ่าย + ค่าบริการเพิ่มเติมพิเศษในใบปิดบัญชีชิปปิ้ง (ยอดที่ชิปปิ้งจ่าย ไม่มี VAT)
 *   TRANSPORT  DEM ในชีตงานขนส่ง (ไม่มีช่องในใบปิดบัญชี)
 * BL ละชุด ส่งซ้ำ = KOLA แทนชุดเดิมทั้งหมด จึงไม่ต้องจำสถานะฝั่งนี้
 *
 * ตั้งค่า: KOLA_COSTS_URL ไม่ต้องตั้ง ถ้าใช้ที่อยู่เดียวกับ KOLA_SPECIALS_URL (แทน /special-charges ด้วย /costs)
 */

const DEFAULT_URL = 'https://erp-kola.vercel.app/api/shipme/costs';
const CALL_TIMEOUT_MS = 25000;
const MAX_BLS = 200;
const MAX_LINES = 300;
const CONCURRENCY = 4;

const blKey = (bl: unknown) => String(bl ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normBl = (col: unknown) => sql`regexp_replace(upper(${col}), '[^A-Z0-9]', '', 'g')`;
const flat = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const isVatExempt = (label: unknown) => (INVOICE_VAT_EXEMPT_LABELS as readonly string[]).includes(flat(label));

type Line = { source: 'INVOICE' | 'SETTLEMENT' | 'TRANSPORT'; ref: string; kind?: string; key?: string; label: string; amount: number; vat: number; note?: string };
type InvoiceRef = { number: string; kind: string; issueDate: string; batchName: string };
export type KolaCostBl = { blNo: string; customer: string; invoices: InvoiceRef[]; lines: Line[] };

export function kolaCostsUrl() {
  const own = String(process.env.KOLA_COSTS_URL || '').trim();
  if (own) return own;
  const spc = String(process.env.KOLA_SPECIALS_URL || '').trim();
  return spc ? spc.replace(/\/special-charges\/?$/, '/costs') : DEFAULT_URL;
}

/** ใบแจ้งหนี้ ADV ทั้งหมดของ BL ในชุด (V + NV ที่ไม่ยกเลิก) — ดึงทีเดียวทุก BL */
async function invoiceLines(keys: string[]) {
  const rows = keys.length ? await db.select({
    number: invoices.number, kind: invoices.kind, bl: invoices.bl, issueDate: invoices.issueDate,
    batchName: invoices.batchName, customerName: invoices.customerName, itemsJson: invoices.itemsJson
  }).from(invoices).where(and(ne(invoices.status, 'cancelled'), inArray(invoices.kind, ['V', 'NV']),
    inArray(normBl(invoices.bl), keys))) : [];
  const out = new Map<string, { refs: InvoiceRef[]; lines: Line[]; customer: string }>();
  for (const row of rows.sort((a, b) => a.number.localeCompare(b.number))) {
    const key = blKey(row.bl);
    const entry = out.get(key) || { refs: [], lines: [], customer: '' };
    entry.refs.push({ number: row.number, kind: row.kind, issueDate: row.issueDate, batchName: row.batchName });
    for (const item of safeJson<any[]>(row.itemsJson, [])) {
      const amount = round2(item?.amount);
      const label = flat(item?.label).slice(0, 200);
      if (!label || !amount) continue;
      const vat = row.kind === 'V' && !isVatExempt(label) ? round2(amount * VAT_RATE) : 0;
      entry.lines.push({ source: 'INVOICE', ref: row.number, kind: row.kind, label, amount, vat,
        note: flat(item?.note).slice(0, 300) || undefined });
    }
    out.set(key, entry);
  }
  return out;
}

/** ใบปิดบัญชีที่มี BL นี้ (BL เดียวตรวจปล่อยหลายวันได้) — คืนรายการ + วันที่ตรวจปล่อย */
async function settlementLines(bl: string) {
  const key = blKey(bl);
  const like = `%${String(bl).trim().replace(/[%_\\]/g, '')}%`;
  const rows = await db.select({ name: settlements.name, inspectDate: settlements.inspectDate, rowsJson: settlements.rowsJson })
    .from(settlements).where(sql`(${settlements.rowsJson} ilike ${like} or ${settlements.rowsJson} ilike ${`%${key}%`})`)
    .orderBy(settlements.inspectDate).limit(50);
  const lines: Line[] = [];
  const dates = new Set<string>();
  let customer = '';
  for (const settlement of rows) {
    const ref = `ชิปปิ้ง ${settlement.name} · ตรวจปล่อย ${fmtDateStr(settlement.inspectDate)}`;
    for (const row of safeJson<any[]>(settlement.rowsJson, [])) {
      if (blKey(row?.bl) !== key) continue;
      dates.add(settlement.inspectDate);
      customer = customer || flat(row?.customer);
      const note = [row?.port ? `ท่า ${row.port}` : '', row?.containers ? `${row.containers} ตู้` : ''].filter(Boolean).join(' · ') || undefined;
      for (const column of SETTLE_COST_COLUMNS) {
        const amount = round2(row?.costs?.[column.key]);
        if (amount > 0) lines.push({ source: 'SETTLEMENT', ref, key: column.key, label: column.label, amount, vat: 0, note });
      }
      for (const special of Array.isArray(row?.specials) ? row.specials : []) {
        const amount = round2(special?.amount);
        const label = flat(special?.label).slice(0, 200);
        if (label && amount > 0) lines.push({ source: 'SETTLEMENT', ref, key: 'special', label, amount, vat: 0, note });
      }
    }
  }
  return { lines, dates, customer };
}

/** DEM ในชีตงานขนส่ง — BL ที่สายเรือใช้เลขซ้ำ (SEALS) เอาเฉพาะวันที่ตรวจปล่อยของงานนี้ */
async function demLines(keys: string[], datesByBl: Map<string, Set<string>>) {
  const rows = keys.length ? await db.select({ bl: transportJobs.bl, transportDate: transportJobs.transportDate, dem: transportJobs.dem, containerNo: transportJobs.containerNo })
    .from(transportJobs).where(and(inArray(normBl(transportJobs.bl), keys), sql`${transportJobs.dem} > 0`)) : [];
  const reused = rows.length ? await reusedBls(rows.map((r) => r.bl)) : new Set<string>();
  const out = new Map<string, Line[]>();
  for (const row of rows) {
    const key = blKey(row.bl);
    const dates = datesByBl.get(key);
    if (reused.has(occKey(row.bl)) && dates?.size && !dates.has(row.transportDate)) continue;
    const list = out.get(key) || [];
    list.push({ source: 'TRANSPORT', ref: `ชีตงานขนส่ง · ${fmtDateStr(row.transportDate)}`, key: 'dem', label: 'DEM',
      amount: round2(row.dem), vat: 0, note: row.containerNo ? `ตู้ ${flat(row.containerNo).slice(0, 200)}` : undefined });
    out.set(key, list);
  }
  return out;
}

/** รวมข้อมูลของหลาย BL เป็น payload ฝั่ง KOLA */
export async function collectKolaCosts(bls: { key: string; bl: string; batchName: string }[]) {
  const list = bls.slice(0, MAX_BLS);
  const keys = list.map((b) => b.key);
  const settled = new Map<string, Awaited<ReturnType<typeof settlementLines>>>();
  const queue = [...list];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) settled.set(next.key, await settlementLines(next.bl));
  }));
  const datesByBl = new Map([...settled].map(([k, v]) => [k, v.dates]));
  const [inv, dem] = await Promise.all([invoiceLines(keys), demLines(keys, datesByBl)]);
  return list.map((b): KolaCostBl => {
    const i = inv.get(b.key);
    const s = settled.get(b.key);
    return {
      blNo: b.bl,
      customer: s?.customer || i?.customer || '',
      invoices: i?.refs || [],
      lines: [...(i?.lines || []), ...(s?.lines || []), ...(dem.get(b.key) || [])].slice(0, MAX_LINES),
    };
  });
}

/**
 * ส่งค่าใช้จ่ายของ BL ในชุดให้ KOLA ทีเดียว — คืนผลสรุปให้หน้าเว็บแสดงต่อจากผลค่าพิเศษ
 */
export async function pushKolaCosts(bls: { key: string; bl: string; batchName: string }[], apiKey: string) {
  if (!bls.length) return { ok: true, sent: 0, noJob: [] as string[] };
  try {
    const payload = { batchName: bls[0].batchName || undefined, bls: await collectKolaCosts(bls) };
    const res = await fetch(kolaCostsUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
    });
    const body = await res.json().catch(() => ({})) as any;
    if (!res.ok || !body?.ok) {
      return { ok: false, sent: 0, noJob: [] as string[], error: `${res.status ? `HTTP ${res.status}: ` : ''}${String(body?.error || 'ส่งไม่สำเร็จ').slice(0, 300)}` };
    }
    const results: any[] = Array.isArray(body.results) ? body.results : [];
    return { ok: true, sent: results.length, noJob: results.filter((r) => r && r.jobMatched === false).map((r) => String(r.blNo)) };
  } catch (err) {
    const timeout = err instanceof Error && /timeout|abort/i.test(err.name + err.message);
    console.error('[kola-costs]', err);
    return { ok: false, sent: 0, noJob: [] as string[], error: timeout ? 'KOLA ตอบช้าเกิน 25 วินาที' : 'เชื่อมต่อ ERP KOLA ไม่ได้' };
  }
}
