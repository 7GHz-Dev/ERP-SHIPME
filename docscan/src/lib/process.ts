import { applyAdjust, applyFilter, detectQuad, isCvReady, warpQuad } from './cv';
import { detectDoc, refineDoc } from './detect';
import {
  MAX_ORIGINAL, MAX_PROCESSED, blobToCanvas, canvasToBlob, ctx2d, getImageData, imageDataToCanvas,
  makeCanvas, rotateFlip, thumbnail, toCanvas
} from './image';
import { drawMarkup } from './markup';
import type { Adjustments, FilterName, MarkupObject, Quad } from './types';
import { DEFAULT_ADJUST } from './types';

const DETECT_MAX = 640;     // รูปนิ่ง: หาขอบที่ความละเอียดนี้
const REFINE_MAX = 1000;    // เกลามุมให้ละเอียดที่ความละเอียดนี้ (คลาด ±0.5px = ±2px บนภาพ 4K)

/** หดเข้าหาจุดกึ่งกลางเล็กน้อย — ขอบที่หาได้อยู่ "บนเส้นขอบพอดี" ครอบตรงนั้นจะมีพื้นโต๊ะติดขอบภาพ 1–2px */
export function insetQuad(q: Quad, k = 0.005): Quad {
  const cx = q.reduce((s, p) => s + p.x, 0) / 4, cy = q.reduce((s, p) => s + p.y, 0) / 4;
  return q.map((p) => ({ x: p.x + (cx - p.x) * k, y: p.y + (cy - p.y) * k })) as Quad;
}

/**
 * เกลากรอบบนภาพความละเอียดสูง (ตอนถ่ายจริง) — กรอบจากภาพสด 400px คลาดได้ ±1–2px = ±10px บนภาพ 4K
 * errPx = ความคลาดเคลื่อนที่คาดไว้ (พิกเซลของ src) • คืนพิกัดของ src
 */
export async function refineOnCanvas(src: HTMLCanvasElement, quad: Quad, errPx: number): Promise<Quad> {
  const mid = toCanvas(src, REFINE_MAX);
  const s = mid.width / src.width;
  try {
    const r = await refineDoc(getImageData(mid), quad.map((p) => ({ x: p.x * s, y: p.y * s })) as Quad, Math.max(3, errPx * s));
    return r.quad.map((p) => ({ x: p.x / s, y: p.y / s })) as Quad;
  } catch {
    return quad;
  }
}

/** หาขอบเอกสารจากรูปนิ่ง (ย่อก่อนหา แล้วเกลามุมบนภาพใหญ่) — ไม่เจอ = null */
export async function suggestQuad(src: HTMLCanvasElement): Promise<{ quad: Quad | null; confidence: number }> {
  const small = toCanvas(src, DETECT_MAX);
  const scale = src.width / small.width;
  try {
    const r = await detectDoc(getImageData(small), 'still');
    let quad = r.quad ? r.quad.map((p) => ({ x: p.x * scale, y: p.y * scale })) as Quad : null;
    let confidence = r.area;
    // สำรอง: ตัวหาขอบเดิม (OpenCV) เผื่อกระดาษโค้งจนขอบไม่เป็นเส้นตรง — ใช้เมื่อโหลดไว้แล้วเท่านั้น ไม่รอ
    if (!quad && isCvReady()) {
      const o = await detectQuad(getImageData(small));
      if (o.quad && o.confidence >= 0.2) { quad = o.quad.map((p) => ({ x: p.x * scale, y: p.y * scale })) as Quad; confidence = o.confidence; }
    }
    if (!quad) return { quad: null, confidence: 0 };
    quad = await refineOnCanvas(src, quad, 2 * scale);
    return { quad: insetQuad(quad), confidence };
  } catch {
    return { quad: null, confidence: 0 };
  }
}

/**
 * ขนาดภาพหลังปรับมุมมอง — ถ้าสัดส่วนใกล้ A4 (±10%) ปรับเป็น 1:1.414 พอดี
 * (กล้องเอียงทำให้กระดาษดูสั้นกว่าจริง) โดยขยายด้านที่สั้นเกิน ไม่หดด้านไหนลง แล้วจำกัดไม่เกิน max
 */
export function targetSize(q: Quad, max = MAX_PROCESSED) {
  const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  let w = Math.max(d(q[0], q[1]), d(q[3], q[2])), h = Math.max(d(q[0], q[3]), d(q[1], q[2]));
  const r = Math.max(w, h) / Math.max(1, Math.min(w, h));
  if (Math.abs(r / Math.SQRT2 - 1) <= 0.1) {
    if (r < Math.SQRT2) { if (h >= w) h = w * Math.SQRT2; else w = h * Math.SQRT2; }
    else if (h >= w) w = h / Math.SQRT2;
    else h = w / Math.SQRT2;
  }
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** กรอบเต็มภาพ (ใช้เมื่อหาขอบไม่เจอ หรือผู้ใช้ไม่ต้องการครอบ) */
export function fullQuad(w: number, h: number): Quad {
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
}

/** ครอบ + ปรับมุมมอง → ภาพแบนเหมือนสแกน (อ่านเฉพาะพื้นที่รอบกรอบ ไม่ต้องดึงทั้งภาพ 4K) */
export async function cropToCanvas(src: HTMLCanvasElement, quad: Quad | null) {
  if (!quad) return toCanvas(src, MAX_PROCESSED);
  const size = targetSize(quad);
  const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2), y0 = Math.max(0, Math.floor(Math.min(...ys)) - 2);
  const x1 = Math.min(src.width, Math.ceil(Math.max(...xs)) + 2), y1 = Math.min(src.height, Math.ceil(Math.max(...ys)) + 2);
  const region = ctx2d(src).getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  const local = quad.map((p) => ({ x: p.x - x0, y: p.y - y0 })) as Quad;
  return imageDataToCanvas(await warpQuad(region, local, size));
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

/** สร้างข้อมูลหน้าใหม่จากภาพบน canvas (เฟรมกล้อง/รูปที่ decode แล้ว) — quad อยู่ในพิกัดของ src */
export async function buildPageFromCanvas(src: HTMLCanvasElement, quad: Quad | null, filter: FilterName = 'document') {
  const orig = Math.max(src.width, src.height) > MAX_ORIGINAL ? toCanvas(src, MAX_ORIGINAL) : src;
  const k = orig.width / src.width;
  const q = quad && k !== 1 ? quad.map((p) => ({ x: p.x * k, y: p.y * k })) as Quad : quad;
  // เข้ารหัสต้นฉบับไปพร้อม ๆ กับปรับภาพ (toBlob ทำงานเบื้องหลัง)
  const originalP = canvasToBlob(orig, 'image/jpeg', 0.9);
  const cropped = await cropToCanvas(orig, q);
  const opts: RenderOptions = { filter, adjustments: { ...DEFAULT_ADJUST }, rotation: 0, flip: false, markup: [] };
  const processed = await renderPage(cropped, opts);
  const [originalImage, croppedImage, processedImage, thumb] = await Promise.all([
    originalP, canvasToBlob(cropped, 'image/jpeg', 0.92), canvasToBlob(processed, 'image/jpeg', 0.88), thumbnail(processed)
  ]);
  return {
    originalImage, croppedImage, processedImage, thumbnail: thumb,
    width: processed.width, height: processed.height, cropCoordinates: q, filter
  };
}

/** สร้างข้อมูลหน้าใหม่จากไฟล์รูป — เข้ารหัสใหม่เสมอ (ย่อไม่เกิน 4000px, หมุนตาม EXIF, HEIC → JPEG) */
export async function buildPageImages(original: Blob, quad: Quad | null, filter: FilterName = 'document') {
  return buildPageFromCanvas(await blobToCanvas(original, MAX_ORIGINAL), quad, filter);
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
