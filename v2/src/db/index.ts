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
 */
const connectionString = requireEnv(
  'DATABASE_URL',
  'เอาจาก Supabase → Project Settings → Database → Connection string → Transaction pooler (พอร์ต 6543)'
);

const globalForDb = globalThis as unknown as { sql?: ReturnType<typeof postgres> };

// dev ของ Next.js reload โมดูลบ่อย — ถ้าไม่ cache ไว้จะเปิด pool ใหม่ทุกครั้งจน connection เต็ม
const client = globalForDb.sql ?? postgres(connectionString, {
  prepare: false,
  max: 1,                 // 1 connection ต่อ 1 instance ของ function — ที่เหลือให้ pooler จัดการ
  idle_timeout: 20,
  connect_timeout: 10
});

if (process.env.NODE_ENV !== 'production') globalForDb.sql = client;

export const db = drizzle(client, { schema });
export { schema };
