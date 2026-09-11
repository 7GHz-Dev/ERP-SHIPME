import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { ymd } from './utils';
import type { ApiResult } from './types';

/**
 * ภาพรวมข้อมูลที่เข้า Supabase — หน้า dashboard ดึงซ้ำทุก 15 วินาที
 *
 * รวมทุกอย่างไว้ใน request เดียว ไม่แยกเป็นหลาย action เพราะหน้านี้ยิงถี่
 * ถ้าแยกจะกลายเป็น 8 request ทุก 15 วิ กิน connection ของ pooler โดยไม่จำเป็น
 *
 * ใช้ raw SQL ชุดเดียวแล้ว union กัน เพื่อให้ได้ทั้งจำนวนแถวและเวลาล่าสุด
 * ของทุกตารางในการ query รอบเดียว
 */
export async function dashboardOverview(): Promise<ApiResult> {
  const today = ymd();

  // ต้องยิงทีละ query ห้ามใช้ Promise.all — pool ตั้ง max:1 ต่อ instance
  // ถ้ายิงพร้อมกัน 6 อัน จะแย่ง connection เดียวกันจนค้างทั้งเซิร์ฟเวอร์
  const queries = [
    // จำนวนแถวทุกตาราง + เวลาที่มีข้อมูลเข้าล่าสุด
    () => db.execute(sql`
      select 'checkins' as name, count(*)::int as rows, max(server_time) as latest from checkins
      union all select 'leaves', count(*)::int, max(created_at) from leaves
      union all select 'claims', count(*)::int, max(created_at) from claims
      union all select 'receipts', count(*)::int, max(server_time) from receipts
      union all select 'settlements', count(*)::int, max(created_at) from settlements
      union all select 'invoices', count(*)::int, max(created_at) from invoices
      union all select 'transport_jobs', count(*)::int, max(imported_at) from transport_jobs
      union all select 'users', count(*)::int, null from users
    `),
    // สถานะ sync ของชีตแต่ละแท็บ
    () => db.execute(sql`
      select source_file, source_sheet, count(*)::int as rows, max(imported_at) as last_sync
      from transport_jobs group by 1,2 order by max(imported_at) desc
    `),
    () => db.execute(sql`
      select username, name, type, server_time, address from checkins
      order by server_time desc limit 8
    `),
    () => db.execute(sql`
      select bl, shipping, customer, transport_date, source_file, imported_at
      from transport_jobs order by imported_at desc, id desc limit 8
    `),
    () => db.execute(sql`
      select status, count(*)::int as rows, coalesce(sum(total),0)::float as amount
      from invoices group by status
    `),
    () => db.execute(sql`
      select
        count(*) filter (where sent_to_kola and status <> 'cancelled')::int as sent,
        coalesce(sum(total - paid_amount) filter (where sent_to_kola and status <> 'cancelled' and paid_amount < total),0)::float as outstanding,
        coalesce(sum(paid_amount) filter (where status <> 'cancelled'),0)::float as paid
      from invoices
    `)
  ];
  const results: any[] = [];
  for (const run of queries) results.push(await run());
  const [counts, transport, recentCheckins, recentJobs, invoiceStats, arStats] = results;

  const rowsOf = (result: any) => (Array.isArray(result) ? result : result?.rows ?? []);

  // งานที่เข้ามาวันนี้ — นับจากเวลาที่บันทึก ไม่ใช่วันที่ในเอกสาร
  const todayCheckins = rowsOf(recentCheckins).filter((r: any) =>
    String(r.server_time || '').slice(0, 10) === today).length;

  return {
    ok: true,
    at: new Date().toISOString(),
    today,
    tables: rowsOf(counts).map((r: any) => ({
      name: r.name, rows: Number(r.rows) || 0, latest: r.latest || ''
    })),
    sheets: rowsOf(transport).map((r: any) => ({
      file: r.source_file, sheet: r.source_sheet,
      rows: Number(r.rows) || 0, lastSync: r.last_sync || ''
    })),
    recentCheckins: rowsOf(recentCheckins),
    recentJobs: rowsOf(recentJobs),
    invoiceStats: rowsOf(invoiceStats).map((r: any) => ({
      status: r.status, rows: Number(r.rows) || 0, amount: Number(r.amount) || 0
    })),
    receivables: rowsOf(arStats)[0] || { sent: 0, outstanding: 0, paid: 0 },
    todayCheckins
  };
}
