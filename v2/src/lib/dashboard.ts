import { sql } from 'drizzle-orm';
import { db } from '@/db';
import type { ApiResult } from './types';

/**
 * สถานะ sync ชีตงานขนส่ง — หน้า dashboard ดึงซ้ำทุก 15 วินาที
 *
 * ยิงทีละ query ห้ามใช้ Promise.all — pool ตั้ง max:1 ต่อ instance
 * ถ้ายิงพร้อมกันจะแย่ง connection เดียวกันจนค้างทั้งเซิร์ฟเวอร์
 */
export async function dashboardOverview(): Promise<ApiResult> {
  const queries = [
    // สถานะปัจจุบันของแต่ละแท็บ
    () => db.execute(sql`
      select source_file, source_sheet, count(*)::int as rows,
             max(imported_at) as last_sync,
             min(transport_date) as first_date, max(transport_date) as last_date,
             count(distinct bl)::int as bls,
             count(*) filter (where do_fee > 0)::int as with_do_fee
      from transport_jobs group by 1,2 order by max(imported_at) desc
    `),
    // ประวัติรอบที่มีการเปลี่ยนแปลงจริง
    () => db.execute(sql`
      select synced_at, source_file, source_sheet, rows_before, rows_after,
             added, removed, changed, added_bls, removed_bls, details
      from transport_sync_logs order by synced_at desc limit 25
    `),
    // ยอดรวมทั้งตาราง
    () => db.execute(sql`
      select count(*)::int as rows, count(distinct bl)::int as bls,
             count(distinct source_sheet)::int as sheets,
             max(imported_at) as last_sync
      from transport_jobs
    `)
  ];

  const results: any[] = [];
  for (const run of queries) results.push(await run());
  const [sheets, logs, totals] = results;
  const rowsOf = (r: any) => (Array.isArray(r) ? r : r?.rows ?? []);

  const parse = (value: unknown) => {
    try { const v = JSON.parse(String(value || '[]')); return Array.isArray(v) ? v : []; }
    catch { return []; }
  };

  return {
    ok: true,
    at: new Date().toISOString(),
    totals: rowsOf(totals)[0] || { rows: 0, bls: 0, sheets: 0, last_sync: '' },
    sheets: rowsOf(sheets).map((r: any) => ({
      file: r.source_file, sheet: r.source_sheet,
      rows: Number(r.rows) || 0, lastSync: r.last_sync || '',
      firstDate: r.first_date || '', lastDate: r.last_date || '',
      bls: Number(r.bls) || 0, withDoFee: Number(r.with_do_fee) || 0
    })),
    logs: rowsOf(logs).map((r: any) => ({
      syncedAt: r.synced_at, file: r.source_file, sheet: r.source_sheet,
      rowsBefore: Number(r.rows_before) || 0, rowsAfter: Number(r.rows_after) || 0,
      added: Number(r.added) || 0, removed: Number(r.removed) || 0,
      changed: Number(r.changed) || 0,
      addedBls: parse(r.added_bls), removedBls: parse(r.removed_bls),
      details: parse(r.details)
    }))
  };
}
