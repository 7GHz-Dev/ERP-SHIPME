import { applyAdjust, applyFilter, detectQuad, warpQuad } from './cv';
import {
  MAX_ORIGINAL, MAX_PROCESSED, blobToCanvas, canvasToBlob, ctx2d, getImageData, imageDataToCanvas,
  makeCanvas, rotateFlip, thumbnail, toCanvas
} from './image';
import { drawMarkup } from './markup';
import type { Adjustments, FilterName, MarkupObject, Quad } from './types';
import { DEFAULT_ADJUST } from './types';

const DETECT_MAX = 640;

/** หาขอบเอกสารจากภาพ (ย่อก่อนหาเพื่อความเร็ว แล้วขยายพิกัดกลับ) — ไม่เจอ = null */
export async function suggestQuad(src: HTMLCanvasElement): Promise<{ quad: Quad | null; confidence: number }> {
  const small = toCanvas(src, DETECT_MAX);
  const scale = src.width / small.width;
  try {
    const r = await detectQuad(getImageData(small));
    if (!r.quad) return r;
    const q = r.quad.map((p) => ({ x: p.x * scale, y: p.y * scale }));
    // หดเข้าหาจุดกึ่งกลาง 0.4% — ขอบที่หาได้มักเลยกระดาษออกไป 1-2px ทำให้มีเส้นพื้นโต๊ะติดขอบภาพ
    const cx = q.reduce((s, p) => s + p.x, 0) / 4, cy = q.reduce((s, p) => s + p.y, 0) / 4;
    const k = 0.004;
    return { quad: q.map((p) => ({ x: p.x + (cx - p.x) * k * 2, y: p.y + (cy - p.y) * k * 2 })) as Quad, confidence: r.confidence };
  } catch {
    return { quad: null, confidence: 0 };
  }
}

/** กรอบเต็มภาพ (ใช้เมื่อหาขอบไม่เจอ หรือผู้ใช้ไม่ต้องการครอบ) */
export function fullQuad(w: number, h: number): Quad {
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
}

/** ครอบ + ปรับมุมมอง → ภาพแบนเหมือนสแกน */
export async function cropToCanvas(src: HTMLCanvasElement, quad: Quad | null) {
  if (!quad) return toCanvas(src, MAX_PROCESSED);
  const out = await warpQuad(getImageData(src), quad);
  return toCanvas(imageDataToCanvas(out), MAX_PROCESSED);
}

export interface RenderOptions {
  filter: FilterName; adjustments: Adjustments; rotation: number; flip: boolean; markup: MarkupObject[];
}

/** ภาพที่ครอบแล้ว → ฟิลเตอร์ → ปรับแสง → หมุน/พลิก → markup (ลำดับเดียวกันทั้ง preview และตอนบันทึก) */
export async function renderPage(cropped: HTMLCanvasElement, o: RenderOptions, maxSide = MAX_PROCESSED) {
  let c = toCanvas(cropped, maxSide);
  if (o.filter !== 'original') c = imageDataToCanvas(await applyFilter(getImageData(c), o.filter));
  const a = o.adjustments;
  if (a.brightness || a.contrast || a.saturation || a.sharpness) c = imageDataToCanvas(await applyAdjust(getImageData(c), a));
  c = rotateFlip(c, o.rotation, o.flip);
  if (o.markup.length) await drawMarkup(ctx2d(c), o.markup, c.width, c.height);
  return c;
}

/** สร้างข้อมูลหน้าใหม่จากภาพที่ถ่าย/นำเข้า */
export async function buildPageImages(original: Blob, quad: Quad | null, filter: FilterName = 'document') {
  // เข้ารหัสใหม่เสมอ: ย่อไม่เกิน 4000px, หมุนตาม EXIF แล้ว, และ HEIC กลายเป็น JPEG ที่ทุกเบราว์เซอร์เปิดได้
  const src = await blobToCanvas(original, MAX_ORIGINAL);
  const originalBlob = await canvasToBlob(src, 'image/jpeg', 0.92);
  const cropped = await cropToCanvas(src, quad);
  const opts: RenderOptions = { filter, adjustments: { ...DEFAULT_ADJUST }, rotation: 0, flip: false, markup: [] };
  const processed = await renderPage(cropped, opts);
  return {
    originalImage: originalBlob,
    croppedImage: await canvasToBlob(cropped, 'image/jpeg', 0.92),
    processedImage: await canvasToBlob(processed, 'image/jpeg', 0.88),
    thumbnail: await thumbnail(processed),
    width: processed.width,
    height: processed.height,
    cropCoordinates: quad,
    filter
  };
}

/** สร้างภาพสุดท้ายใหม่หลังแก้ฟิลเตอร์/หมุน/markup */
export async function rebuildProcessed(cropped: Blob, o: RenderOptions) {
  const c = await renderPage(await blobToCanvas(cropped), o);
  return {
    processedImage: await canvasToBlob(c, 'image/jpeg', 0.88),
    thumbnail: await thumbnail(c),
    width: c.width,
    height: c.height
  };
}

/** หน้าว่างสีขาว (ใช้ทดสอบ / สำรอง) */
export function blankCanvas(w = 1240, h = 1754) {
  const c = makeCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  return c;
}
