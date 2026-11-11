import { inArray } from 'drizzle-orm';
import { db } from '@/db';
import { invoiceWht } from '@/db/schema';
import { id, nowIso, validYmd } from './utils';

/**
 * ใบหัก ณ ที่จ่าย 3% กระทำการแทน — กรอกพร้อมออกใบแจ้งหนี้ ADV (หน้า "ออกใบใหม่")
 * บันทึกอย่างเดียว ไม่เปลี่ยนยอดใบแจ้งหนี้ — ดูคำอธิบายตารางใน schema.ts (invoice_wht)
 */
export const WHT_RATE = 0.03;
const MAX_CERTS = 20;
const MAX_ITEMS = 20;

export type WhtCert = {
  seq: number; certNo: string; certDate: string;
  items: { label: string; base: number; amount: number }[];
  base: number; amount: number;
};

const round2 = (value: number) => Math.round(value * 100) / 100;
const clean = (value: unknown, limit: number) => String(value ?? '').trim().slice(0, limit);
/** วันที่จริงในปฏิทิน (validYmd ตรวจแค่รูปแบบ — 2026-13-01 ผ่าน) */
const realDate = (value: string) => {
  if (!validYmd(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** ตรวจใบหักที่หน้าเว็บส่งมา — ยอดหักคิดใหม่ที่นี่ (3% ของฐาน) ไม่เชื่อยอดจากหน้าเว็บ */
export function cleanWhtCerts(input: unknown): { ok: true; certs: WhtCert[] } | { ok: false; error: string } {
  if (input == null) return { ok: true, certs: [] };
  if (!Array.isArray(input) || input.length > MAX_CERTS) return { ok: false, error: 'bad_wht' };
  const certs: WhtCert[] = [];
  for (const raw of input) {
    const certDate = clean((raw as any)?.certDate, 10);
    if (!realDate(certDate)) return { ok: false, error: 'bad_wht_date' };
    const list = (raw as any)?.items;
    if (!Array.isArray(list) || !list.length || list.length > MAX_ITEMS) return { ok: false, error: 'bad_wht' };
    const items = [];
    for (const item of list) {
      const label = clean(item?.label, 200);
      const base = round2(Number(item?.base));
      if (!label || !Number.isFinite(base) || base <= 0 || base > 1e9) return { ok: false, error: 'bad_wht_item' };
      items.push({ label, base, amount: round2(base * WHT_RATE) });
    }
    certs.push({
      seq: certs.length + 1, certNo: clean((raw as any)?.certNo, 40), certDate, items,
      base: round2(items.reduce((sum, item) => sum + item.base, 0)),
      amount: round2(items.reduce((sum, item) => sum + item.amount, 0))
    });
  }
  return { ok: true, certs };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function insertWhtCerts(tx: Tx, certs: WhtCert[], link: {
  invoiceNumber: string; bl: string; settlementId: string; inspectDate: string; username: string;
}) {
  if (!certs.length) return;
  const now = nowIso();
  await tx.insert(invoiceWht).values(certs.map((cert) => ({
    id: id('WHT'), invoiceNumber: link.invoiceNumber, bl: link.bl, settlementId: link.settlementId,
    inspectDate: link.inspectDate, seq: cert.seq, certNo: cert.certNo, certDate: cert.certDate,
    itemsJson: JSON.stringify(cert.items), base: cert.base, amount: cert.amount,
    createdBy: link.username, createdAt: now, updatedAt: now
  })));
}

/** ใบหักของใบแจ้งหนี้หลายใบ — หน้า "ใบที่ออกแล้ว" แสดงใต้เลขใบ */
export async function whtByInvoice(numbers: string[]) {
  const map = new Map<string, WhtCert[]>();
  if (!numbers.length) return map;
  const rows = await db.select().from(invoiceWht).where(inArray(invoiceWht.invoiceNumber, numbers));
  rows.sort((a, b) => a.seq - b.seq);
  for (const row of rows) {
    let items: WhtCert['items'] = [];
    try { items = JSON.parse(row.itemsJson); } catch { items = []; }
    const list = map.get(row.invoiceNumber) || [];
    list.push({ seq: row.seq, certNo: row.certNo, certDate: row.certDate, items, base: row.base, amount: row.amount });
    map.set(row.invoiceNumber, list);
  }
  return map;
}
