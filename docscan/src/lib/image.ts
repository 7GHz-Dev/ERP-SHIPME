/**
 * งานภาพเบา ๆ ที่ทำบน main thread ได้ (decode / ย่อ / หมุน / เข้ารหัส)
 * งานหนัก (หาขอบเอกสาร, ปรับมุมมอง, ฟิลเตอร์) อยู่ใน Web Worker — ดู cv.ts
 */

export const MAX_ORIGINAL = 4000;   // ด้านยาวสุดของภาพต้นฉบับที่เก็บ
export const MAX_PROCESSED = 2480;  // ด้านยาวสุดของภาพที่ประมวลผลแล้ว (A4 ≈ 210 dpi — คมพอสำหรับเอกสาร และบันทึกเร็ว)
export const THUMB = 360;
export const MAX_FILE_BYTES = 40 * 1024 * 1024;

export class ImageError extends Error {}

/** ไฟล์ HEIC/HEIF (รูปจาก iPhone) — ดูจากหัวไฟล์ ไม่เชื่อนามสกุล/ชนิดที่เบราว์เซอร์บอก */
async function isHeicData(blob: Blob) {
  const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  return ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(ascii(8, 12));
}

/**
 * decode รูปจาก Blob — createImageBitmap ก่อน ไม่ได้ลอง <img>
 * HEIC (iPhone) ที่เบราว์เซอร์เปิดเองไม่ได้ (Chrome / Android / บาง Safari) ใช้ตัวแปลง heic-to
 * ซึ่งโหลดเฉพาะตอนเจอไฟล์ HEIC (~3MB ครั้งแรก แล้ว service worker แคชไว้ ใช้ออฟไลน์ได้)
 */
export async function decodeImage(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch { /* ลองวิธีถัดไป */ }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('img'));
      img.src = url;
    });
  } catch { /* ลองวิธีถัดไป */ } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (!(await isHeicData(blob))) throw new ImageError('เปิดไฟล์รูปนี้ไม่ได้ — ไฟล์อาจเสียหรือเบราว์เซอร์ไม่รองรับรูปแบบนี้');
  try {
    const { heicTo } = await import('heic-to');
    return await heicTo({ blob, type: 'bitmap' });
  } catch {
    throw new ImageError('แปลงไฟล์ HEIC นี้ไม่ได้ — ลองส่งออกจากแอปรูปภาพเป็น JPG แล้วนำเข้าใหม่');
  }
}

const dims = (src: ImageBitmap | HTMLImageElement | HTMLCanvasElement) =>
  'naturalWidth' in src ? { w: src.naturalWidth, h: src.naturalHeight } : { w: src.width, h: src.height };

export function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
export function ctx2d(c: HTMLCanvasElement) {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new ImageError('เบราว์เซอร์ไม่รองรับ canvas');
  return ctx;
}

/** วาดรูปลง canvas โดยย่อให้ด้านยาวสุดไม่เกิน max */
export function toCanvas(src: ImageBitmap | HTMLImageElement | HTMLCanvasElement, max = Infinity) {
  const { w, h } = dims(src);
  const s = Math.min(1, max / Math.max(w, h));
  const c = makeCanvas(w * s, h * s);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/jpeg', quality = 0.9): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new ImageError('บันทึกรูปไม่สำเร็จ'))), type, quality));
}

export async function blobToCanvas(blob: Blob, max = Infinity) {
  const img = await decodeImage(blob);
  const c = toCanvas(img, max);
  if ('close' in img) img.close();
  return c;
}

export function getImageData(c: HTMLCanvasElement) { return ctx2d(c).getImageData(0, 0, c.width, c.height); }
export function imageDataToCanvas(d: ImageData) {
  const c = makeCanvas(d.width, d.height);
  ctx2d(c).putImageData(d, 0, 0);
  return c;
}

/** หมุนทีละ 90° และพลิกซ้าย-ขวา */
export function rotateFlip(src: HTMLCanvasElement, rotation: number, flip: boolean) {
  const r = ((rotation % 360) + 360) % 360;
  if (!r && !flip) return src;
  const swap = r === 90 || r === 270;
  const c = makeCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const ctx = ctx2d(c);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((r * Math.PI) / 180);
  if (flip) ctx.scale(-1, 1);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

export async function thumbnail(c: HTMLCanvasElement) { return canvasToBlob(toCanvas(c, THUMB), 'image/jpeg', 0.75); }

/** ตรวจไฟล์ที่นำเข้า — ชนิดและขนาด */
export function validateImageFile(f: File) {
  const okType = /^image\/(jpeg|png|webp|heic|heif)$/i.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);
  if (!okType) throw new ImageError(`"${f.name}" ไม่ใช่ไฟล์รูปที่รองรับ (JPG, PNG, WEBP, HEIC)`);
  if (f.size > MAX_FILE_BYTES) throw new ImageError(`"${f.name}" ใหญ่เกิน ${MAX_FILE_BYTES / 1024 / 1024}MB`);
}

/** ชื่อไฟล์/ชื่อเอกสารที่ปลอดภัย — ตัดอักขระที่ใช้ในชื่อไฟล์ไม่ได้ และจำกัดความยาว */
export function safeName(name: string, fallback = 'เอกสาร') {
  const v = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return v || fallback;
}

export function formatBytes(n: number) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** แชร์ผ่าน Web Share API ถ้ามี (iOS/Android) — ไม่มีก็ดาวน์โหลดแทน */
export async function shareOrDownload(files: File[], text?: string) {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && (!files.length || nav.canShare?.({ files }))) {
    try {
      await nav.share(files.length ? { files, title: files[0].name } : { text });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled';
    }
  }
  if (files.length) files.forEach((f) => downloadBlob(f, f.name));
  else if (text) downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'text.txt');
  return 'downloaded';
}
