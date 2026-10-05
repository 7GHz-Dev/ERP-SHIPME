/**
 * ชั้นกลางของ OCR — UI เรียกผ่าน getOcrEngine() เท่านั้น
 * วันหน้าเปลี่ยนไปใช้ Google Cloud Vision / AWS Textract / Azure Document Intelligence
 * ได้โดยเพิ่มคลาสที่ implement OcrEngine แล้วสลับใน getOcrEngine โดยไม่ต้องแก้หน้าจอ
 */
export type OcrLang = 'tha' | 'eng' | 'tha+eng';
export const OCR_LANGS: { value: OcrLang; label: string }[] = [
  { value: 'tha+eng', label: 'ไทย + อังกฤษ' },
  { value: 'tha', label: 'ไทย' },
  { value: 'eng', label: 'English' }
];

export interface OcrProgress { status: string; progress: number }
export interface OcrEngine {
  readonly name: string;
  readonly local: boolean;
  recognize(image: Blob, lang: OcrLang, onProgress?: (p: OcrProgress) => void): Promise<string>;
}

/** Tesseract.js — ประมวลผลในเครื่อง (Web Worker) ภาพไม่ออกจากเครื่อง โหลดแค่ไฟล์ภาษาครั้งแรก */
class TesseractEngine implements OcrEngine {
  readonly name = 'Tesseract (ในเครื่อง)';
  readonly local = true;
  async recognize(image: Blob, lang: OcrLang, onProgress?: (p: OcrProgress) => void) {
    const { createWorker } = await import('tesseract.js');
    const labels: Record<string, string> = {
      'loading tesseract core': 'กำลังโหลดตัวอ่านข้อความ…',
      'loading language traineddata': 'กำลังโหลดภาษา (ครั้งแรกเท่านั้น)…',
      'initializing api': 'กำลังเตรียม…',
      'recognizing text': 'กำลังวิเคราะห์เอกสาร…'
    };
    const worker = await createWorker(lang, 1, {
      logger: (m: { status: string; progress: number }) =>
        onProgress?.({ status: labels[m.status] || m.status, progress: m.progress || 0 })
    });
    try {
      const { data } = await worker.recognize(image);
      // tesseract ใส่ช่องว่างระหว่างอักษรไทยบ่อย — ยุบช่องว่างที่อยู่ระหว่างอักษรไทยสองตัว
      return String(data.text || '').replace(/([฀-๿]) (?=[฀-๿])/g, '$1').trim();
    } finally {
      await worker.terminate();
    }
  }
}

let engine: OcrEngine | null = null;
export function getOcrEngine(): OcrEngine {
  if (!engine) engine = new TesseractEngine();
  return engine;
}

/** กันข้อความจาก OCR ไปเป็น HTML — แสดงเป็นข้อความล้วนเสมอ */
export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
