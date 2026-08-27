FROM python:3.11-slim

# PaddleOCR ต้องใช้ไลบรารีของ OpenCV ที่ image แบบ slim ไม่มีมาให้
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgomp1 libglib2.0-0 libgl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# โหลดโมเดลตั้งแต่ตอน build — ถ้าไม่ทำ คำขอแรกหลัง deploy จะค้างรอโหลดโมเดลนับสิบวินาที
ARG OCR_LANG=th
ENV OCR_LANG=${OCR_LANG}
RUN python -c "from paddleocr import PaddleOCR; \
PaddleOCR(lang='${OCR_LANG}', use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)"

ENV PORT=8000
EXPOSE 8000
# 1 worker พอ — โมเดลกินแรมหลักร้อย MB ต่อ process และงานเข้าไม่ถี่
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT} --workers 1"]
