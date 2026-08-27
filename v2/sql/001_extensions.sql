-- รันครั้งเดียวใน Supabase → SQL Editor **ก่อน** npm run db:migrate
--
-- ระบบเดิมบน SQLite เก็บ username เป็น TEXT COLLATE NOCASE คือเทียบแบบไม่สนตัวพิมพ์
-- ("Somchai" กับ "somchai" คือคนเดียวกัน) Postgres ไม่มี COLLATE NOCASE
-- จึงใช้ citext แทน เพื่อให้พฤติกรรมการล็อกอินและการอ้างชื่อผู้ใช้เหมือนเดิมทุกจุด
create extension if not exists citext with schema extensions;
