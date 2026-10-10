import { PDFDocument } from 'pdf-lib';
import { zipSync } from 'fflate';
import { pageBlob } from './cloud';
import { blobToCanvas, canvasToBlob, safeName, toCanvas } from './image';
import type { PageRecord } from './types';

/** ตัวเลือกส่งออก PDF */
export interface PdfOptions {
  pageSize: 'auto' | 'a4' | 'letter';
  orientation: 'auto' | 'portrait' | 'landscape';
  quality: 'low' | 'medium' | 'high' | 'original';
  compression: 'small' | 'balanced' | 'best';
  dpi: 72 | 150 | 200 | 300;
}
export const DEFAULT_PDF: PdfOptions = { pageSize: 'auto', orientation: 'auto', quality: 'high', compression: 'balanced', dpi: 200 };

const SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;   // หน่วย point (1/72 นิ้ว)
const JPEG_Q = { small: 0.6, balanced: 0.78, best: 0.92 } as const;
const QUALITY_MAX = { low: 1200, medium: 1800, high: 2600, original: Infinity } as const;

/**
 * รวมทุกหน้าเป็น PDF เดียว — รูปเข้ารหัสใหม่ตามความละเอียด (DPI) และคุณภาพที่เลือก
 * โครงสร้างเผื่อเพิ่มชั้นข้อความ OCR แบบมองไม่เห็น (ค้นหาใน PDF ได้) ภายหลัง: ข้อความอยู่ใน page.ocrText แล้ว
 */
export async function exportPdf(pages: PageRecord[], o: PdfOptions, title = 'เอกสาร'): Promise<Blob> {
  if (!pages.length) throw new Error('เอกสารนี้ยังไม่มีหน้า');
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator('DocScan');
  for (const p of pages) {
    const src = await blobToCanvas(await pageBlob(p, 'p'));
    const landscapeImg = src.width > src.height;
    let pw: number, ph: number;
    if (o.pageSize === 'auto') {
      // ขนาดหน้าตามสัดส่วนรูป: ด้านยาวเท่ากระดาษ A4 ที่ DPI ที่เลือก
      const longPt = SIZES.a4[1];
      const s = longPt / Math.max(src.width, src.height);
      pw = src.width * s; ph = src.height * s;
    } else {
      const [w, h] = SIZES[o.pageSize];
      const land = o.orientation === 'landscape' || (o.orientation === 'auto' && landscapeImg);
      pw = land ? h : w; ph = land ? w : h;
    }
    // พิกเซลที่ต้องใช้ = นิ้วของหน้า × DPI (จำกัดตามระดับคุณภาพ)
    const targetPx = Math.min(QUALITY_MAX[o.quality], (Math.max(pw, ph) / 72) * o.dpi);
    const img = toCanvas(src, targetPx);
    const jpg = await canvasToBlob(img, 'image/jpeg', o.quality === 'original' ? 0.95 : JPEG_Q[o.compression]);
    const embedded = await pdf.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
    const page = pdf.addPage([pw, ph]);
    // วางรูปให้พอดีหน้าโดยรักษาสัดส่วน มีขอบเล็กน้อยเมื่อเป็นขนาดกระดาษมาตรฐาน
    const margin = o.pageSize === 'auto' ? 0 : 18;
    const s = Math.min((pw - margin * 2) / embedded.width, (ph - margin * 2) / embedded.height);
    const dw = embedded.width * s, dh = embedded.height * s;
    page.drawImage(embedded, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
  }
  const bytes = await pdf.save();
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

/** ชื่อไฟล์ JPG: ชื่อเอกสาร_Page_001.jpg */
export const jpgName = (doc: string, index: number) => `${safeName(doc)}_Page_${String(index + 1).padStart(3, '0')}.jpg`;

/** หลายหน้า = รวมเป็น ZIP ไฟล์เดียว (เบราว์เซอร์ส่วนใหญ่บล็อกการดาวน์โหลดหลายไฟล์พร้อมกัน) */
export async function zipFiles(files: { name: string; blob: Blob }[]) {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.name] = new Uint8Array(await f.blob.arrayBuffer());
  return new Blob([zipSync(entries, { level: 0 }) as BlobPart], { type: 'application/zip' });
}

/** นำเข้า PDF เป็นรูปทีละหน้า (PDF.js เรนเดอร์ในเครื่อง) */
export async function pdfToImages(file: File, onProgress?: (done: number, total: number) => void): Promise<Blob[]> {
  if (file.size > 80 * 1024 * 1024) throw new Error('ไฟล์ PDF ใหญ่เกิน 80MB');
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
  // PDF.js v6: ปิดด้วย loadingTask.destroy() (ตัวเอกสารไม่มี destroy แล้ว)
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let doc;
  try {
    doc = await task.promise;
  } catch {
    throw new Error('เปิดไฟล์ PDF นี้ไม่ได้ (ไฟล์อาจเสียหรือมีรหัสผ่าน)');
  }
  const out: Blob[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 2400 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('เบราว์เซอร์ไม่รองรับ canvas');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise;
    out.push(await canvasToBlob(c, 'image/jpeg', 0.9));
    onProgress?.(i, doc.numPages);
  }
  await task.destroy();
  return out;
}
