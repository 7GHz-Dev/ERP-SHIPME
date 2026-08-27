"""
ทดสอบว่า PP-OCRv5 อ่านสลิปโอนเงินภาษาไทยออกไหม

สร้างรูปสลิปจำลองด้วยฟอนต์ไทยของ Windows แล้วส่งเข้า OCR
เทียบว่าอ่าน "ยอด / วันที่ / เลขที่รายการ" ออกครบหรือไม่

    .venv/Scripts/python.exe test_slip.py
    .venv/Scripts/python.exe test_slip.py path/to/real-slip.jpg    # ลองกับสลิปจริง
"""
import base64
import io
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

THAI_FONTS = [
    r"C:\Windows\Fonts\tahoma.ttf",
    r"C:\Windows\Fonts\leelawui.ttf",
    r"C:\Windows\Fonts\upcjl.ttf",
    "/usr/share/fonts/truetype/tlwg/Loma.ttf",
]

SLIP_LINES = [
    ("K PLUS", 34),
    ("โอนเงินสำเร็จ", 26),
    ("27 ส.ค. 2569  14:32 น.", 22),
    ("", 10),
    ("จาก  นาย สมชาย ใจดี", 20),
    ("ธนาคารกสิกรไทย  xxx-x-x1234-5", 18),
    ("ไปยัง  บริษัท ชิปเม้นท์ จำกัด", 20),
    ("ธนาคารกสิกรไทย  xxx-x-x9876-0", 18),
    ("", 10),
    ("จำนวน  1,060.80 บาท", 26),
    ("ค่าธรรมเนียม  0.00 บาท", 18),
    ("เลขที่รายการ 015082712345678", 20),
]

EXPECT = {"amount": 1060.80, "date": "2026-08-27", "txn": "015082712345678"}


def pick_font(size: int):
    for path in THAI_FONTS:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit("ไม่พบฟอนต์ไทยในเครื่อง — ระบุไฟล์ฟอนต์เพิ่มใน THAI_FONTS")


def build_slip() -> bytes:
    width, pad = 620, 40
    height = pad * 2 + sum(size + 14 for _, size in SLIP_LINES)
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    y = pad
    for text, size in SLIP_LINES:
        if text:
            draw.text((pad, y), text, font=pick_font(size), fill=(20, 20, 20))
        y += size + 14
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=92)
    return buffer.getvalue()


def main():
    if len(sys.argv) > 1:
        blob = Path(sys.argv[1]).read_bytes()
        print(f"อ่านสลิปจริง: {sys.argv[1]}")
    else:
        blob = build_slip()
        Path("slip-sample.jpg").write_bytes(blob)
        print("สร้างสลิปจำลอง: slip-sample.jpg")

    import app as service

    data_url = "data:image/jpeg;base64," + base64.b64encode(blob).decode()
    print("กำลังโหลดโมเดล PP-OCRv5 (ครั้งแรกช้าหน่อย)…")
    result = service.ocr_image(service.OcrRequest(image=data_url), authorization=None)

    print("\n--- ข้อความที่อ่านได้ ---")
    for line in result["lines"]:
        print("   ", line)

    # ใช้ตัวแยกค่าชุดเดียวกับที่ระบบหลักใช้ เพื่อให้ผลตรงกับของจริง
    print("\n--- แยกค่าออกมาได้ ---")
    text = result["text"]
    import re

    amounts = [
        float(m.group(1).replace(",", ""))
        for m in re.finditer(r"(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2})", text)
    ]
    txn = re.search(r"(?:เลขที่รายการ|เลขรายการ|รหัสอ้างอิง)\s*[:#.\-]*\s*([A-Z0-9][A-Z0-9-]{5,59})", text, re.I)
    has_date = bool(re.search(r"\d{1,2}\s*(?:ส\.ค\.|สิงหาคม)\s*(?:\d{4}|\d{2})", text))

    ok_amount = EXPECT["amount"] in amounts
    ok_txn = bool(txn and txn.group(1) == EXPECT["txn"])
    print(f"  {'✓' if ok_amount else '✗'} ยอดเงิน   {EXPECT['amount']}  (เจอ {amounts})")
    print(f"  {'✓' if has_date else '✗'} วันที่     รูปแบบ 27 ส.ค. 2569")
    print(f"  {'✓' if ok_txn else '✗'} เลขที่รายการ {EXPECT['txn']}  (เจอ {txn.group(1) if txn else '—'})")

    passed = sum([ok_amount, has_date, ok_txn])
    print(f"\nอ่านออก {passed}/3 ช่อง")
    return 0 if passed == 3 else 1


if __name__ == "__main__":
    raise SystemExit(main())
