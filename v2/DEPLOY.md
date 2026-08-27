# ขึ้น production บน Vercel

repo นี้มี 2 ระบบอยู่ด้วยกัน — Fastify เดิมที่ root และ Next.js ใหม่ในโฟลเดอร์ `v2/`
**ต้องตั้ง Root Directory เป็น `v2`** ไม่งั้น Vercel จะไปเจอ Fastify แล้ว build ไม่ผ่าน

## 1. สร้างโปรเจกต์

1. เข้า [vercel.com/new](https://vercel.com/new) → **Import Git Repository** → เลือก `7GHz-Dev/ERP-SHIPME`
2. **Root Directory** → กด *Edit* → เลือก **`v2`**
   (Framework จะขึ้น **Next.js** ให้เอง ไม่ต้องแก้ Build Command / Output Directory)
3. **ยังไม่ต้องกด Deploy** — ใส่ env ให้ครบก่อนตามข้อ 2

### เช็กว่า Root Directory ถูกไหมจาก log

ถ้าตั้งถูก log จะขึ้นแบบนี้:

```
Installing dependencies...
added 69 packages
Detected Next.js version: 15.1.9
```

ถ้าตั้งผิด (ชี้ไป root ของ repo) จะได้แบบนี้แทน — สังเกตจำนวน package ที่น้อยผิดปกติ
เพราะไปเจอโปรเจกต์ Fastify เดิมที่มี dependency ตัวเดียว:

```
Warning: Detected "engines": { "node": ">=24" } in your package.json
added 49 packages
Error: No Next.js version detected.
```

แก้ที่ **Settings → General → Root Directory → `v2`** แล้ว **Redeploy**
(ตั้งครั้งเดียวจำถาวร แต่ถ้าเผลอไปกดแก้ทีหลังจะกลับมาพังแบบเดิม)

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
| `GOOGLE_VISION_API_KEY` | | อ่านสลิปอัตโนมัติ — เว้นว่าง = พนักงานกรอกเอง (ดูข้อ 6) |
| `OCR_ENDPOINT` | | ใช้ OCR เจ้าอื่น — ถ้าตั้งไว้จะถูกใช้ก่อน Google Vision |

**ถ้าลืมตั้ง 4 ตัวแรก build จะล้มทันที** พร้อมข้อความบอกว่าขาดตัวไหนและเอามาจากไหน
(ตั้งใจให้ล้มตั้งแต่ build ดีกว่า deploy ผ่านแล้วพังตอนพนักงานกำลังใช้งาน)

### เวลากรอกค่า อย่าวางทั้งบรรทัด

ช่อง **Key** กับ **Value** แยกกัน — ให้วาง **เฉพาะค่า** ในช่อง Value

| | |
|---|---|
| ✅ ถูก | `https://buzitxvrqcoomlxkyhxn.supabase.co` |
| ❌ ผิด | `NEXT_PUBLIC_SUPABASE_URL=https://buzitxvrqcoomlxkyhxn.supabase.co` |

ถ้าวางทั้งบรรทัด build จะล้มพร้อมบอกว่าได้ค่าอะไรมา
ส่วนช่องว่างหัวท้าย เครื่องหมายคำพูด และ `/` ท้าย URL ระบบตัดให้เองแล้ว ไม่ต้องกังวล

> อยากกรอกทีเดียวหลายตัว ให้ใช้ปุ่มวางแบบ `.env` ของ Vercel แล้ววางเนื้อไฟล์ `v2/.env.local` ทั้งก้อน

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

## 6. เปิดอ่านสลิปอัตโนมัติ (Google Cloud Vision)

ไม่ตั้งก็ใช้งานได้ — พนักงานกรอกยอด วันที่ และเลขที่รายการจากสลิปเอง
แล้วระบบตรวจให้ว่าตรงกับยอดที่ต้องโอนคืนไหม แต่ถ้าเปิดไว้จะกรอกให้อัตโนมัติ

1. [console.cloud.google.com](https://console.cloud.google.com) → เลือกหรือสร้างโปรเจกต์
2. เปิดใช้ **Cloud Vision API** (ค้นใน API Library)
3. **APIs & Services → Credentials → Create credentials → API key**
4. กด **Restrict key** → **API restrictions** → เลือกเฉพาะ **Cloud Vision API**
   (ถ้าไม่จำกัด key ที่หลุดออกไปจะเรียก API อื่นในโปรเจกต์ได้ทั้งหมด)
5. เอา key ไปใส่เป็น `GOOGLE_VISION_API_KEY` ใน Vercel แล้ว **Redeploy**

**ค่าใช้จ่าย:** ฟรี 1,000 รูป/เดือน หลังจากนั้นราว $1.50 ต่อ 1,000 รูป
ปริมาณจริงของระบบนี้ราว 30 สลิป/เดือน จึงอยู่ในโควตาฟรี

**ตรวจว่าใช้ได้จริง:** หน้า admin → **ตรวจ OCR** — ปุ่มนี้จะเอา**สลิปใบล่าสุดในระบบมาลองอ่านจริง**
แล้วบอกว่าอ่านยอด/วันที่/เลขที่รายการออกครบไหม (แค่ "ตั้งค่าแล้ว" ไม่พอ เพราะ key ผิด
หรือลืมเปิด API ก็ยังดูเหมือนตั้งค่าเรียบร้อย)

**อ่านได้แต่ไม่ครบ?** ในหน้าปิดบัญชีมีปุ่มเพิ่มความละเอียดของรูปสลิปแล้วลองอ่านใหม่
ถ้ายังไม่ได้ก็กรอกเองได้เหมือนเดิม ระบบตรวจยอด/วันที่ให้ทุกกรณีอยู่แล้ว

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

**Node บน Vercel ปักไว้ที่ 22.x** (`v2/package.json` → `engines`) ไม่ให้ขยับเองเวลา Vercel เปลี่ยนค่าเริ่มต้น
ส่วน**บนเครื่องตัวเองต้องใช้ Node 24 ขึ้นไป** ถ้าจะรัน `scripts/import-sqlite.mts`
เพราะอ่านไฟล์ `.sqlite` ด้วย `node:sqlite` ซึ่งเสถียรตั้งแต่ 24 (สคริปต์พวกนี้ไม่ได้รันบน Vercel)
