# ระบบเช็กอินนอกสถานที่ — Fastify + SQLite

เวอร์ชันนี้ไม่ใช้ Google Apps Script, Google Sheets หรือ Google Drive เป็น backend แล้ว

- Frontend: `index.html` และ `admin.html`
- API: Node.js + Fastify
- Database: SQLite แบบ WAL (มี transaction, index และ unique constraint)
- Files: เก็บใน persistent volume ที่ `data/uploads/`
- Deploy: Docker Compose หรือ Node.js โดยตรง

หน้าเว็บและ API ทำงานบนโดเมนเดียวกันที่ `/api` จึงไม่ต้องตั้ง `API_URL`, ไม่ติด CORS และไม่มี Apps Script cold start/โควตา Sheets

## เริ่มใช้งาน

ต้องใช้ Node.js 24 ขึ้นไป (โปรเจกต์ใช้ `node:sqlite` ที่มากับ Node)

```bash
npm install
copy .env.example .env
npm start
```

จากนั้นเปิด:

- พนักงาน: `http://localhost:8080/`
- ผู้ดูแล: `http://localhost:8080/admin`
- Health check: `http://localhost:8080/health`

ฐานข้อมูลว่างครั้งแรกจะสร้างบัญชี admin จาก `ADMIN_USERNAME`, `ADMIN_PASSWORD` และ `ADMIN_NAME` ใน `.env` เท่านั้น ค่า fallback สำหรับเครื่องพัฒนาคือ `admin` / `1234`; ต้องเปลี่ยนก่อนขึ้น production

## รันด้วย Docker

```bash
copy .env.example .env
# แก้ ADMIN_PASSWORD ใน .env ก่อน
docker compose up -d --build
```

volume `checkin_data` เก็บทั้งฐานข้อมูลและรูป จึงยังอยู่หลัง restart/redeploy ควร backup volume นี้เป็นประจำ

## ย้ายข้อมูลเดิมจาก Google Sheets

ดาวน์โหลดแต่ละแท็บเป็น CSV แล้วใส่ในโฟลเดอร์เดียวกัน โดยใช้ชื่อไฟล์ตามชื่อแท็บเดิมที่มี เช่น:

```text
legacy-export/
  Users.csv
  CheckIns.csv
  Leaves.csv
  AppOptions.csv
  ClaimRates.csv
  Claims.csv
  SettleRates.csv
  Settlements.csv
  Receipts.csv
```

หยุดเว็บชั่วคราวแล้วรัน:

```bash
npm run import:legacy -- ./legacy-export
```

ตัวนำเข้าข้าม Sessions โดยตั้งใจ ผู้ใช้ทุกคนจึงต้องล็อกอินใหม่หลังย้าย ระบบ hash รหัสผ่านเดิมด้วย scrypt ก่อนบันทึกลง SQLite

URL รูปเก่าใน CheckIns/Settlements/Receipts จะถูกเก็บเป็นประวัติเดิม ส่วนรูปใหม่ทั้งหมดเก็บบนเซิร์ฟเวอร์นี้ หากต้องการเลิกใช้ Drive สำหรับรูปย้อนหลังด้วย ให้ดาวน์โหลดรูปเก่าและเปลี่ยน URL หลังนำเข้า

## นำเข้าข้อมูลงานขนส่ง

ส่งออกชีตงานขนส่งเป็น CSV หนึ่งหรือหลายไฟล์ แล้วรัน:

```bash
# ไฟล์เดียว
npm run import:transport -- ./transport/TRANSIT.csv

# ทุกไฟล์ CSV ในโฟลเดอร์
npm run import:transport -- ./transport
```

ระบบจับหัวคอลัมน์เดิมทั้งภาษาไทยและอังกฤษ เช่น ชิปปิ้ง, TRANSPORT, เลข BL, เบอร์ตู้, จำนวนตู้, ท่า และชื่อลูกค้า การนำเข้าไฟล์ชื่อเดิมซ้ำจะแทนข้อมูลจากไฟล์นั้น ไม่สร้างแถวซ้ำ

## OCR สลิป

OCR เป็นโมดูลเสริมและไม่ผูกกับ Google Drive API:

- ไม่ตั้ง `OCR_ENDPOINT`: พนักงานกรอกยอด วันที่ และเลขรายการจากสลิปเอง ระบบตรวจให้ตรงกับยอด/วันที่ก่อนบันทึก
- ตั้ง `OCR_ENDPOINT`: backend ส่ง `POST { "image": "data:image/...;base64,..." }` และคาดหวัง response `{ "text": "ข้อความ OCR" }`
- ตั้ง `SLIP_STRICT=true` เมื่อต้องการห้ามบันทึกหาก OCR อ่านไม่ได้

## Reverse geocode

ค่าตั้งต้นไม่เรียกบริการภายนอก ระบบบันทึกพิกัดทันที จึงเร็วและไม่ส่งตำแหน่งพนักงานออกนอกเซิร์ฟเวอร์ หากต้องการที่อยู่แบบข้อความ ให้ตั้ง `GEOCODE_ENDPOINT` เป็น URL ที่รับ `GET ?lat=...&lon=...` และตอบ `{ "address": "..." }` ผลลัพธ์จะถูก cache ใน SQLite

## คำสั่งสำคัญ

```bash
npm run dev              # reload เมื่อแก้ไฟล์
npm start                # production process
npm test                 # ทดสอบ flow หลัก
npm run import:legacy -- ./legacy-export
npm run import:transport -- ./transport
```

## สำรองและกู้คืน

ข้อมูลที่ต้องสำรองมีเพียง:

```text
data/checkin.sqlite
data/uploads/
```

ก่อน copy ฐานข้อมูลแบบไฟล์ แนะนำหยุด process ชั่วคราว หรือใช้คำสั่ง SQLite backup เพื่อให้ snapshot สอดคล้องกัน ฐานข้อมูลเปิด WAL และ `busy_timeout` แล้ว รองรับคำขอพร้อมกันได้ดีกว่าการใช้ Sheets เป็นฐานข้อมูลโดยตรง

## ไฟล์เดิม

`Code.gs` เหลือไว้เป็นเอกสารอ้างอิงของระบบเก่าเท่านั้น ไม่มีส่วนใดของ runtime ใหม่เรียกหรือ deploy ไฟล์นี้
