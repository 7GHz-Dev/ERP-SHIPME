# ขึ้น production บน Vercel

repo นี้มี 2 ระบบอยู่ด้วยกัน — Fastify เดิมที่ root และ Next.js ใหม่ในโฟลเดอร์ `v2/`
**ต้องตั้ง Root Directory เป็น `v2`** ไม่งั้น Vercel จะไปเจอ Fastify แล้ว build ไม่ผ่าน

## 1. สร้างโปรเจกต์

1. เข้า [vercel.com/new](https://vercel.com/new) → **Import Git Repository** → เลือก `7GHz-Dev/ERP-SHIPME`
2. **Root Directory** → กด *Edit* → เลือก **`v2`**
   (Framework จะขึ้น **Next.js** ให้เอง ไม่ต้องแก้ Build Command / Output Directory)
3. **ยังไม่ต้องกด Deploy** — ใส่ env ให้ครบก่อนตามข้อ 2

> ระบบนี้เป็น ERP ของบริษัท จึงใช้ Hobby plan ไม่ได้ตามเงื่อนไขของ Vercel — ต้องเป็น **Pro**

## 2. Environment Variables

ใส่ที่ **Settings → Environment Variables** ให้ครบทุกตัวก่อน deploy ครั้งแรก
ค่าจริงอยู่ในไฟล์ `v2/.env.local` บนเครื่องอยู่แล้ว (ไฟล์นี้ไม่ขึ้น GitHub) — คัดลอกมาวางได้เลย

| ตัวแปร | จำเป็น | หมายเหตุ |
|---|---|---|
| `DATABASE_URL` | ✅ | ต้องเป็น **Transaction pooler พอร์ต 6543** ห้ามใช้ 5432 |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | `https://buzitxvrqcoomlxkyhxn.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | ข้าม RLS ได้ทั้งหมด — ตั้งเป็น **Sensitive** |
| `SUPABASE_BUCKET` | ✅ | `uploads` |
| `SESSION_HOURS` | | ไม่ตั้ง = 12 |
| `MAX_ACCURACY_METERS` | | ไม่ตั้ง = 200 (มือถือ) |
| `MAX_ACCURACY_METERS_DESKTOP` | | ไม่ตั้ง = 5000 (คอมไม่มี GPS) |
| `SLIP_STRICT` | | ไม่ตั้ง = false (อ่านสลิปไม่ออกยังบันทึกได้ แต่ติดสถานะรอตรวจ) |
| `SLIP_AMOUNT_TOLERANCE` | | ไม่ตั้ง = 1 บาท |
| `GEOCODE_ENDPOINT` | | เว้นว่าง = แสดงพิกัดเป็นตัวเลข ไม่ส่งตำแหน่งออกนอกระบบ |
| `OCR_ENDPOINT` | | เว้นว่าง = ให้พนักงานกรอกค่าจากสลิปเอง |

**ถ้าลืมตั้ง 4 ตัวแรก build จะล้มทันที** พร้อมข้อความบอกว่าขาดตัวไหนและเอามาจากไหน
(ตั้งใจให้ล้มตั้งแต่ build ดีกว่า deploy ผ่านแล้วพังตอนพนักงานกำลังใช้งาน)

## 3. Deploy

กด **Deploy** — ใช้เวลาราว 1–2 นาที

`vercel.json` ตั้ง region เป็น **`sin1` (Singapore)** ไว้แล้วให้อยู่ใกล้ Supabase
ถ้าไม่ตั้ง Vercel จะรันที่อเมริกา แล้วทุก query ต้องวิ่งข้ามทวีปกลับมา ช้ากว่ามาก

## 4. ตรวจหลัง deploy

```bash
curl https://<โดเมนที่ได้>/api
# ต้องได้ {"ok":true,...,"stack":"Next.js + Supabase"}
```

แล้วลองจริงบนเบราว์เซอร์:

- `https://<โดเมน>/` — หน้าพนักงาน
- `https://<โดเมน>/admin` — หน้าผู้ดูแล

ล็อกอินด้วย**รหัสเดิมจากระบบเก่า** (hash ย้ายมาทั้งชุด ไม่ต้องตั้งใหม่)

ยิงเทสอัตโนมัติใส่ของจริงก็ได้:

```bash
cd v2
npx tsx scripts/smoke.mts https://<โดเมน> <username> <password>
```

## 5. หลังจากนี้

push ขึ้น `main` แล้ว Vercel จะ build + deploy ให้เอง ไม่ต้องสั่งอะไรเพิ่ม

---

## เรื่องที่ต้องรู้

**HTTPS จำเป็น** — หน้าเช็กอินใช้ GPS กับกล้อง ซึ่งเบราว์เซอร์บล็อกถ้าไม่ใช่ HTTPS
Vercel ให้ HTTPS อัตโนมัติอยู่แล้ว แต่ถ้าย้ายไปที่อื่นต้องดูข้อนี้

**รูปเก่ายังอยู่บน Google Drive** — ข้อมูลที่ย้ายมาเก็บลิงก์ Drive ไว้เป็นประวัติ
**อย่าลบโฟลเดอร์ Drive เดิม** ไม่งั้นรูปเก่าจะเปิดไม่ได้ ส่วนรูปใหม่เก็บบน Supabase Storage

**ไม่มีการสร้างบัญชีผู้ดูแลอัตโนมัติ** — ระบบเดิมสร้างให้ตอนเปิดเซิร์ฟเวอร์ครั้งแรกที่ฐานข้อมูลว่าง
แต่ serverless ไม่มีจังหวะนั้น ผู้ใช้ทั้ง 10 คนมาจากการนำเข้าข้อมูลแล้ว
ถ้าต้องสร้างเพิ่มเองให้ใช้:

```bash
cd v2
npx tsx scripts/temp-user.mts create <username> <password> admin
```

**ระบบเดิมยังอยู่** — Fastify ที่ root ยังรันได้ ยังไม่ต้องปิดจนกว่าจะมั่นใจว่า v2 ใช้งานได้ครบ
แต่ **อย่าเปิดพร้อมกันสองระบบ** เพราะคนละฐานข้อมูล ข้อมูลจะแยกกันคนละทาง
