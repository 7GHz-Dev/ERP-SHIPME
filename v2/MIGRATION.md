# ย้าย SHIPME จาก Fastify + SQLite → Next.js + Supabase

ระบบเดิม (Fastify + SQLite) อยู่ที่ root ของ repo และ **ยังใช้งานได้ตามปกติ** ระหว่างที่ v2 ยังไม่เสร็จ
โฟลเดอร์นี้คือของใหม่ วางโครงแบบเดียวกับ `ERP-KOLA/v2` เพื่อให้ทั้งสองระบบดูแลด้วยความรู้ชุดเดียวกัน

## ทำไมต้องเปลี่ยน 3 อย่างนี้

| ของเดิม | ของใหม่ | เพราะ |
|---|---|---|
| `node:sqlite` (synchronous) | Drizzle ORM → Supabase Postgres (async) | Vercel ไม่มีดิสก์ถาวร ไฟล์ `.sqlite` หายทุก deploy |
| `fs.writeFileSync` ลง `data/uploads/` | Supabase Storage | เหตุผลเดียวกัน |
| Fastify เสิร์ฟทุกอย่าง | Next.js route handler | Vercel รันเป็น serverless function ไม่ใช่เซิร์ฟเวอร์ค้าง |

## สิ่งที่ตัดสินใจไว้ (อ่านก่อนแก้ต่อ)

- **วันที่ยังเก็บเป็น `text`** ไม่ใช่ `timestamp` — ทั้งระบบเทียบวันที่แบบ string และผู้ใช้ทำงานตามเวลาไทย
  ถ้าเปลี่ยนเป็น timestamp จะเจอบั๊ก timezone ทันที เพราะ Vercel รันที่ UTC
- **`username` ใช้ citext** แทน `COLLATE NOCASE` ของ SQLite (โค้ดเดิมพึ่ง COLLATE ไว้ 37 จุด)
  ต้องรัน `sql/001_extensions.sql` ใน Supabase ก่อน migrate
- **hash รหัสผ่านใช้ scrypt รูปแบบเดิมทุกอย่าง** → ข้อมูลผู้ใช้เดิมย้ายมาได้เลย **พนักงานไม่ต้องตั้งรหัสใหม่**
- **ฐานข้อมูลเก็บ path รูปแบบเดิม** (`/files/<category>/<name>`) ไม่ใช่ signed URL
  เพราะ signed URL หมดอายุ — route `/files/[...path]` ออก signed URL ใหม่ให้ทุกครั้งที่เปิดดู
  ผลคือ `index.html` / `admin.html` และข้อมูลเก่าใช้ต่อได้โดยไม่ต้องแก้
- **ต่อ Postgres ผ่าน Supavisor transaction pooler (6543) เท่านั้น** ไม่ใช่ 5432
  serverless เปิดหลาย instance พร้อมกัน ถ้าต่อตรงจะ connection เต็ม

## ความคืบหน้า

### เสร็จแล้ว
- โครงโปรเจกต์ + config (Next.js 15 / Drizzle 0.38 / Supabase JS 2.47 ตรงกับ KOLA v2)
- `src/db/schema.ts` — **ครบทั้ง 13 ตาราง** พร้อม index/FK/partial unique index
  (ตรวจแล้วว่า `drizzle-kit generate` ออก SQL ถูกต้อง รวมถึง `upper(slip_txn)` partial index)
- `src/lib/utils.ts` — พอร์ตครบ รวม scrypt
- `src/lib/auth.ts` — session / login / guard
- `src/lib/storage.ts` — อัปโหลด, signed upload URL สำหรับรูปใหญ่, signed URL ตอนอ่าน
- `src/app/api/route.ts` + `src/app/files/[...path]/route.ts`
- **24 / 33 action**
  - เช็กอิน — `login` `me` `todayStatus` `checkin` `myCheckins` `report`
  - ลา — `requestLeave` `myLeaves` `listLeaves` `decideLeave`
  - พนักงาน — `listEmployees` `saveEmployee`
  - ตัวเลือกระบบ — `appOptions` `saveAppOptions` `saveSheetLayout`
  - ใบเสร็จ — `saveReceipt` `myReceipts` `listReceipts`
  - การเบิก — `claimConfig` `saveClaimConfig` `saveClaim` `myClaims` `listClaims`

### ยังต้องทำ — 9 action ที่เหลือ

1. **งานขนส่ง** — `blLookup` `transportDiag` (จาก `src/transport.js`)
2. **ปิดบัญชี** — `settleConfig` `saveSettleRates` `saveSettlement` `saveSettleImage` `mySettlements` `listSettlements` (จาก `src/settlements.js`)
3. **สลิป** — `verifySlip` `slipOcrDiag` (จาก `src/slip.js`)

action ที่ยังไม่พอร์ตจะตอบ `not_implemented` พร้อมชื่อ action — ไม่เงียบหาย

### ฐานข้อมูลจริง — ย้ายแล้ว (2026-08-27)

Supabase project `buzitxvrqcoomlxkyhxn` (Singapore) — migrate + import ข้อมูลจาก `data/checkin.sqlite` เรียบร้อย

| ตาราง | แถว | | ตาราง | แถว |
|---|---|---|---|---|
| users | 10 | | claims | 25 |
| checkins | 65 | | settlements | 28 |
| receipts | 8 | | transport_jobs | 1,245 |
| app_options | 6 | | claim_rates / settle_rates | 12 / 9 |

- **ข้าม sessions** โดยตั้งใจ ทุกคนต้องล็อกอินใหม่ (รหัสผ่านเดิมใช้ได้ ไม่ต้องตั้งใหม่)
- **รูปเก่ายังเป็นลิงก์ Google Drive** — ข้อมูลชุดนี้ย้ายมาจากระบบ Sheets เดิม ไม่เคยมีไฟล์ในดิสก์
  (`data/uploads/` ว่างเปล่า) รูปเก่าจึงยังเปิดได้ตราบใดที่ไฟล์ใน Drive ยังแชร์อยู่ **รูปใหม่เท่านั้น**ที่ไปอยู่ Supabase Storage
- รันซ้ำได้: `npm run import:sqlite` ใช้ `ON CONFLICT DO NOTHING`

ทดสอบผ่าน HTTP จริงแล้ว 20/20 (`scripts/smoke.mts`) — ล็อกอิน, citext ไม่สนตัวพิมพ์,
อ่านข้อมูลที่ย้ายมาได้ครบ, EXTRA MOVEMENT ยังขั้นต่ำ 2 ตู้, action ที่ยังไม่พอร์ตตอบ `not_implemented`

### งานอื่นที่เหลือ
- `public/index.html`, `public/admin.html` — ก๊อปมาจาก root แล้วแก้เฉพาะ **การอัปโหลดรูปใหญ่**
  (รูปใบปิดบัญชี PNG ~4,000px เกินลิมิต body 4.5 MB ของ Vercel ต้องเปลี่ยนไปใช้ `createSignedUpload`)
  รูปเช็กอินเป็น JPEG คุณภาพ 0.55 ขนาดเล็ก ยังส่งผ่าน API ได้ตามเดิม
- `scripts/import-sqlite.ts` — ย้ายข้อมูลจริงจาก `data/checkin.sqlite` เข้า Postgres
- เทส — ของเดิมมี 3 เทสที่ครอบ flow หลัก ควรพอร์ตมาให้ครบก่อนตัดระบบ

## ตั้งค่าครั้งแรก

```bash
cd v2
npm install
cp .env.example .env.local      # แล้วเติมค่าจาก Supabase
```

1. สร้าง project ใน Supabase (เลือก region **Singapore**)
2. รัน `sql/001_extensions.sql` ใน SQL Editor
3. สร้าง bucket ชื่อ `uploads` แบบ **private**
4. `npm run db:migrate`
5. `npm run dev`
