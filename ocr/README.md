# บริการอ่านสลิป — PaddleOCR PP-OCRv5 (ไทย)

โมเดล PP-OCRv5 เป็น Python และโหลดโมเดลหลักร้อย MB เข้าหน่วยความจำ จึงรันบน Vercel ไม่ได้
ต้องแยกเป็นบริการต่างหาก แล้วให้ระบบหลักเรียกผ่าน `OCR_ENDPOINT`

```
พนักงานแนบสลิป → Next.js บน Vercel → บริการนี้ → ข้อความ → แยกยอด/วันที่/เลขที่รายการ
```

## สัญญาการเรียกใช้

ตรงกับที่ระบบหลักเรียกอยู่แล้ว ไม่ต้องแก้โค้ดฝั่ง Next.js

```
POST /            {"image": "data:image/jpeg;base64,..."}  →  {"text": "...", "lines": [...]}
GET  /health      {"ok": true, "lang": "th", "model": "PP-OCRv5", "loaded": true}
```

ตั้ง `OCR_TOKEN` ไว้ = ต้องส่ง `Authorization: Bearer <token>` มาด้วย
**ควรตั้งเสมอ** เพราะปลายทางเป็น URL สาธารณะ ถ้าไม่ล็อกใครก็เอาไปใช้อ่านรูปฟรีได้

## ลองบนเครื่องตัวเอง

```bash
cd ocr
py -3.11 -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt

# ทดสอบว่าอ่านสลิปไทยออกไหม (สร้างสลิปจำลองให้เอง)
.venv/Scripts/python.exe test_slip.py

# ลองกับสลิปจริง
.venv/Scripts/python.exe test_slip.py C:\path\to\slip.jpg

# รันเป็นบริการ
.venv/Scripts/uvicorn.exe app:app --port 8000
```

แล้วชี้ระบบหลักมาที่เครื่องตัวเองเพื่อทดสอบ (ใน `v2/.env.local`):

```
OCR_ENDPOINT=http://localhost:8000/
```

## ขึ้น production

ต้องใช้ **RAM อย่างน้อย 1 GB** และเก็บสถานะไว้ในหน่วยความจำ (โมเดล) จึงเหมาะกับ container ที่รันค้าง
ไม่เหมาะกับ serverless ที่ปิด-เปิดตลอด เพราะจะโหลดโมเดลใหม่ทุกครั้ง

| ที่ | ราคา/เดือน | หมายเหตุ |
|---|---|---|
| **VPS (Vultr / DigitalOcean) Singapore** | $5–6 | คุมเองทั้งหมด • ใกล้ผู้ใช้ • ต้องดูแล OS เอง |
| **Render** Standard | $25 | กด deploy จาก repo ได้เลย • free/starter แรมไม่พอ |
| **Google Cloud Run** | ตามใช้จริง | ต้องเปิด billing • cold start ช้าเพราะโหลดโมเดลใหม่ |

### วิธีที่ง่ายที่สุด — VPS + Docker

```bash
# บนเครื่อง VPS
git clone https://github.com/7GHz-Dev/ERP-SHIPME.git
cd ERP-SHIPME/ocr
docker build -t slip-ocr .
docker run -d --restart unless-stopped -p 8000:8000 \
  -e OCR_TOKEN='<สุ่มมาสักชุด>' --name slip-ocr slip-ocr
```

แล้วเอา Caddy มาครอบให้เป็น HTTPS (ออก cert อัตโนมัติ):

```bash
docker run -d --restart unless-stopped --network host caddy \
  caddy reverse-proxy --from ocr.yourdomain.com --to localhost:8000
```

จากนั้นตั้งใน Vercel:

```
OCR_ENDPOINT=https://ocr.yourdomain.com/
OCR_TOKEN=<ชุดเดียวกับที่ตั้งไว้ข้างบน>
```

แล้ว **Redeploy** และไปกด **ตรวจ OCR** ที่หน้า admin

## ปรับแต่ง

| ตัวแปร | ค่าตั้งต้น | ทำอะไร |
|---|---|---|
| `OCR_TOKEN` | ว่าง | ว่าง = ใครก็เรียกได้ • ตั้งแล้วต้องส่ง Bearer token |
| `OCR_LANG` | `th` | ภาษาของโมเดล |
| `MAX_IMAGE_MB` | `12` | ปฏิเสธรูปที่ใหญ่เกินนี้ |
| `PORT` | `8000` | พอร์ตที่เปิดฟัง |

## ข้อจำกัดที่ควรรู้

- ความแม่นภาษาไทยของ PP-OCRv5 อยู่ที่ **82.68%** ในชุดทดสอบของ PaddleOCR เอง
  ต่ำกว่าบริการเชิงพาณิชย์อย่าง Google Vision — สลิปที่ถ่ายเอียง แสงไม่ดี หรือความละเอียดต่ำจะพลาดง่ายกว่า
- เลขยอดเงินกับเลขที่รายการเป็นตัวเลข/อังกฤษ ซึ่งอ่านแม่นกว่าตัวหนังสือไทยมาก
  ส่วนภาษาไทยที่ต้องอ่านให้ออกคือ**ป้ายกำกับ** เช่น "จำนวน" "เลขที่รายการ" ที่ใช้ระบุตำแหน่งของค่า
- อ่านไม่ออกก็ยังใช้งานระบบได้ — พนักงานกรอกเอง แล้วระบบตรวจให้ว่าตรงกับยอดที่ต้องโอนคืนไหม
- ในหน้าปิดบัญชีมีปุ่มเพิ่มความละเอียดของรูปแล้วสั่งอ่านใหม่ ช่วยได้เวลารูปแรกอ่านไม่ออก
