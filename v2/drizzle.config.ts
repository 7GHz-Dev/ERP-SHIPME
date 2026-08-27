import type { Config } from 'drizzle-kit';

// drizzle-kit ไม่อ่าน .env.local ให้เอง ต้องโหลดเข้ามาก่อน
// (ยังไม่มีไฟล์ก็ข้ามไป เผื่อรันในที่ที่ตั้ง env ไว้แล้ว เช่น CI)
try { process.loadEnvFile?.('.env.local'); } catch { /* ไม่มีไฟล์ = ใช้ env ที่มีอยู่ */ }

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'ยังไม่ได้ตั้ง DATABASE_URL — เอาจาก Supabase → Project Settings → Database → Connection string'
  );
}

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url }
} satisfies Config;
