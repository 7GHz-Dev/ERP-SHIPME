"""
บริการอ่านสลิปด้วย PaddleOCR PP-OCRv5 (ภาษาไทย)

สัญญาเดียวกับที่ระบบหลักเรียกใช้อยู่แล้ว:
    POST /            {"image": "data:image/jpeg;base64,..."}  ->  {"text": "..."}
    GET  /health      {"ok": true, ...}

ตั้ง OCR_TOKEN ไว้แล้วผู้เรียกต้องส่ง Authorization: Bearer <token> มาด้วย
(ปลายทางนี้เป็น URL สาธารณะ ถ้าไม่ล็อกไว้ใครก็เอาไปใช้อ่านรูปฟรีได้)
"""
import base64
import binascii
import io
import os
import re
import threading

import numpy as np
from fastapi import FastAPI, Header, HTTPException
from PIL import Image
from pydantic import BaseModel

OCR_TOKEN = os.environ.get("OCR_TOKEN", "").strip()
OCR_LANG = os.environ.get("OCR_LANG", "th").strip() or "th"
MAX_IMAGE_BYTES = int(os.environ.get("MAX_IMAGE_MB", "12")) * 1024 * 1024

app = FastAPI(title="Slip OCR (PP-OCRv5)")

# โหลดโมเดลครั้งเดียวแล้วใช้ซ้ำ — โหลดใหม่ทุก request จะกินเวลาหลายวินาที
_ocr = None
_lock = threading.Lock()


def get_ocr():
    global _ocr
    if _ocr is None:
        with _lock:
            if _ocr is None:
                from paddleocr import PaddleOCR

                # สลิปเป็นภาพตรงอยู่แล้ว ปิดตัวหมุน/ดัดภาพทิ้งเพื่อให้เร็วและกินแรมน้อยลง
                _ocr = PaddleOCR(
                    lang=OCR_LANG,
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_textline_orientation=False,
                )
    return _ocr


class OcrRequest(BaseModel):
    image: str


DATA_URL = re.compile(r"^data:(?P<mime>[^;,]+)?(?:;base64)?,(?P<body>.*)$", re.DOTALL)


def decode_image(raw: str) -> np.ndarray:
    """รับได้ทั้ง data URL และ base64 เปล่า ๆ"""
    value = (raw or "").strip()
    match = DATA_URL.match(value)
    if match:
        value = match.group("body")
    value = re.sub(r"\s+", "", value)
    if not value:
        raise HTTPException(status_code=400, detail="ไม่มีข้อมูลรูปภาพ")

    try:
        blob = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="ถอดรหัส base64 ไม่สำเร็จ")

    if len(blob) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail=f"รูปใหญ่เกิน {MAX_IMAGE_BYTES // 1024 // 1024} MB")

    try:
        image = Image.open(io.BytesIO(blob))
        image.load()
    except Exception:
        raise HTTPException(status_code=400, detail="เปิดไฟล์รูปไม่ได้")

    # PaddleOCR รับ 3 ช่องสี ภาพจากสลิปบางใบเป็น RGBA/ขาวดำ ต้องแปลงก่อน
    return np.array(image.convert("RGB"))


def read_lines(result) -> list[str]:
    """ดึงข้อความออกจากผลลัพธ์ PaddleOCR 3.x (รูปแบบผลลัพธ์ต่างกันตามเวอร์ชันย่อย)"""
    lines: list[str] = []
    for page in result or []:
        texts = None
        if isinstance(page, dict):
            texts = page.get("rec_texts")
        if texts is None:
            try:
                texts = page["rec_texts"]
            except Exception:
                texts = getattr(page, "rec_texts", None)
        if texts:
            lines.extend(str(t) for t in texts if str(t).strip())
    return lines


def verify(authorization: str | None):
    if not OCR_TOKEN:
        return
    expected = f"Bearer {OCR_TOKEN}"
    if (authorization or "").strip() != expected:
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health():
    return {"ok": True, "lang": OCR_LANG, "model": "PP-OCRv5", "loaded": _ocr is not None, "auth": bool(OCR_TOKEN)}


@app.post("/")
def ocr_image(body: OcrRequest, authorization: str | None = Header(default=None)):
    verify(authorization)
    image = decode_image(body.image)
    result = get_ocr().predict(image)
    lines = read_lines(result)
    # ระบบหลักคาดหวังแค่ {"text": ...} — ส่ง lines ไปด้วยเผื่อดูตอนแก้ปัญหา
    return {"text": "\n".join(lines), "lines": lines}
