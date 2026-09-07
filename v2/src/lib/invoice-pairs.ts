import { inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { invoices, settlements } from '@/db/schema';
import { INVOICE_CUSTOMER } from './constants';
import { invoiceTotals, type InvoiceItem } from './invoices';
import { nowIso, validYmd } from './utils';
import type { ApiBody, ApiResult } from './types';

/** Save both kinds atomically using the exact numbers reviewed on screen. */
export async function saveInvoicePairs(body: ApiBody, actor: { username: string; name: string }): Promise<ApiResult> {
  if (!validYmd(body.issueDate)) return { ok: false, error: 'bad_date' };
  const issueDate = String(body.issueDate);
  const period = issueDate.slice(0, 7).replace('-', '');
  if (!Array.isArray(body.targets) || !body.targets.length || body.targets.length > 50) {
    return { ok: false, error: 'bad_targets' };
  }
  const clean = (value: unknown, limit: number) => String(value ?? '').trim().slice(0, limit);
  const prepared: { kind: string; number: string; seq: number; settlementId: string; bl: string; items: InvoiceItem[] }[] = [];
  const seen = new Set<string>();
  for (const target of body.targets) {
    const settlementId = clean(target.settlementId, 60), bl = clean(target.bl, 120);
    for (const kind of ['V', 'NV']) {
      const number = clean(target.numbers?.[kind], 40);
      const match = number.match(new RegExp('^' + kind + period + '([0-9]{2,6})$'));
      const seq = match ? Number(match[1]) : 0;
      if (!seq || number !== kind + period + String(seq).padStart(2, '0') || seen.has(number)) {
        return { ok: false, error: 'bad_invoice_number', number };
      }
      seen.add(number);
      const input = target.items?.[kind];
      if (!Array.isArray(input) || !input.length || input.length > 100) {
        return { ok: false, error: 'no_items', bl, kind };
      }
      const items: InvoiceItem[] = [];
      for (const item of input) {
        const amount = Number(item.amount), label = clean(item.label, 200);
        if (!label || !Number.isFinite(amount) || amount < 0 || amount > 1e9) {
          return { ok: false, error: 'bad_item', bl, kind };
        }
        items.push({ no: items.length + 1, label, amount: Math.round(amount * 100) / 100,
          qty: 0, unitPrice: 0, note: clean(item.note, 200) });
      }
      prepared.push({ kind, number, seq, settlementId, bl, items });
    }
  }
  const sourceIds = [...new Set(prepared.map(entry => entry.settlementId))];
  const sources = await db.select({ id: settlements.id, rowsJson: settlements.rowsJson })
    .from(settlements).where(inArray(settlements.id, sourceIds));
  for (const entry of prepared) {
    const source = sources.find(row => row.id === entry.settlementId);
    let rows: any[] = [];
    try { rows = JSON.parse(source?.rowsJson || '[]'); } catch { /* invalid source */ }
    if (!Array.isArray(rows) || !rows.some(row => String(row.bl || '').toUpperCase() === entry.bl.toUpperCase())) {
      return { ok: false, error: 'bl_not_found', bl: entry.bl };
    }
  }
  try {
    return await db.transaction(async tx => {
      // Serialize pair creation; the primary key also guards concurrent legacy writers.
      await tx.execute(sql`select pg_advisory_xact_lock(71942026)`);
      const conflicts = await tx.select({ number: invoices.number }).from(invoices)
        .where(inArray(invoices.number, [...seen]));
      if (conflicts.length) return { ok: false, error: 'invoice_number_used', numbers: conflicts.map(row => row.number) };
      const created = [];
      for (const entry of prepared) {
        const totals = invoiceTotals(entry.items, entry.kind);
        const record = { ...entry, issueDate, period, ...totals,
          customerName: INVOICE_CUSTOMER.name, customerAddress: INVOICE_CUSTOMER.address,
          customerTaxId: INVOICE_CUSTOMER.taxId, preparedBy: actor.name };
        const { items, ...columns } = record;
        await tx.insert(invoices).values({ ...columns, itemsJson: JSON.stringify(items),
          createdBy: actor.username, createdAt: nowIso(), updatedAt: nowIso() });
        created.push(record);
      }
      return { ok: true, created, count: created.length };
    });
  } catch (error: any) {
    if (error?.code === '23505' || error?.cause?.code === '23505') return { ok: false, error: 'invoice_number_used' };
    throw error;
  }
}
