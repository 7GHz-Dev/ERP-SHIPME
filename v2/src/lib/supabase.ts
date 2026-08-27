import { createClient } from '@supabase/supabase-js';
import { requireEnv } from './env';

/**
 * client ฝั่งเซิร์ฟเวอร์เท่านั้น — ใช้ service_role key ซึ่งข้าม RLS ได้ทั้งหมด
 * ห้าม import ไฟล์นี้จากโค้ดที่ถูกส่งไปเบราว์เซอร์เด็ดขาด
 */
export const supabaseAdmin = createClient(
  requireEnv('NEXT_PUBLIC_SUPABASE_URL', 'เอาจาก Supabase → Project Settings → API'),
  requireEnv('SUPABASE_SERVICE_ROLE_KEY', 'เอาจาก Supabase → Project Settings → API → service_role'),
  { auth: { persistSession: false, autoRefreshToken: false } }
);
