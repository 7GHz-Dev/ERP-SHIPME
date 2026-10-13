import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { requireEnv } from '@/lib/env';
import * as schema from './schema';

/**
 * ต้องใช้ connection string ของ **Supavisor transaction pooler** (พอร์ต 6543)
 * ไม่ใช่ direct connection (5432) เพราะ Vercel เปิด function หลายตัวพร้อมกัน
 * ถ้าต่อตรงจะกิน connection ของ Postgres จนเต็มแล้วล่มทั้งระบบ
 *
 * transaction mode ใช้ prepared statement ไม่ได้ จึงต้อง prepare: false
 *
 * Vercel (Fluid compute) ให้หลาย request ใช้ instance เดียวกันพร้อมกัน — ถ้ามี connection เดียว
 * แล้ว connection นั้นค้าง (pooler ตัดสายเงียบ ๆ) ทุก request ใน instance จะรอจนโดนตัดที่ 60 วินาที
 * (เกิดจริง 13 ต.ค. 2026 11:50–11:53) จึง:
 *   - เปิดได้หลาย connection ต่อ instance (ตัวที่ค้างไม่ขวางตัวอื่น)
 *   - เปลี่ยน connection ใหม่เป็นระยะ (max_lifetime) — statement_timeout ตั้งจากฝั่งนี้ไม่ได้ (pooler ไม่รับ ค่าฝั่งฐานข้อมูล = 2 นาที)
 *   - resetDb(): API ใช้ตอนรอนานผิดปกติ — ทิ้ง pool เดิม เปิดใหม่ให้ request ถัดไป
 */
const connectionString = requireEnv(
  'DATABASE_URL',
  'เอาจาก Supabase → Project Settings → Database → Connection string → Transaction pooler (พอร์ต 6543)'
);

function makeDb() {
  const client = postgres(connectionString, {
    prepare: false,
    max: 4,
    idle_timeout: 20,
    max_lifetime: 60 * 10,
    connect_timeout: 10
  });
  return drizzle(client, { schema });
}
type Db = ReturnType<typeof makeDb>;

const globalForDb = globalThis as unknown as { db?: Db };

// dev ของ Next.js reload โมดูลบ่อย — ถ้าไม่ cache ไว้จะเปิด pool ใหม่ทุกครั้งจน connection เต็ม
let current: Db = globalForDb.db ?? makeDb();
if (process.env.NODE_ENV !== 'production') globalForDb.db = current;

/** ทิ้ง pool ที่ค้าง เปิดใหม่ — query ที่ค้างอยู่ใน pool เดิมจะจบด้วย error (ไม่รอต่อ) */
export function resetDb() {
  const old = current;
  current = makeDb();
  if (process.env.NODE_ENV !== 'production') globalForDb.db = current;
  old.$client.end({ timeout: 1 }).catch(() => undefined);
}

/** ใช้ได้เหมือน drizzle ปกติ — ชี้ไป pool ปัจจุบันเสมอ (เปลี่ยนได้ด้วย resetDb) */
export const db = new Proxy({} as Db, {
  get: (_, key) => {
    const value = (current as any)[key];
    return typeof value === 'function' ? value.bind(current) : value;
  }
});
export { schema };
