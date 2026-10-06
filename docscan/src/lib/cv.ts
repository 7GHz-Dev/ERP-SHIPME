import type { Adjustments, FilterName, Quad } from './types';

/**
 * ตัวเรียก OpenCV worker — คืน Promise ต่อคำสั่ง ส่ง ImageData แบบโอน buffer
 * worker โหลด opencv.js (~10MB) ครั้งแรกครั้งเดียว แล้ว service worker แคชไว้ใช้ออฟไลน์
 */
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker('/cv-worker.js');
  worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.result);
    else p.reject(new Error(e.data.error || 'ประมวลผลภาพไม่สำเร็จ'));
  };
  worker.onerror = () => {
    // worker พัง (เช่นโหลด opencv.js ไม่ได้ตอนออฟไลน์ครั้งแรก) — ตีกลับทุกงานที่ค้าง แล้วเริ่มใหม่รอบหน้า
    pending.forEach((p) => p.reject(new Error('โหลดตัวประมวลผลภาพไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตในการเปิดครั้งแรก')));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function call<T>(msg: Record<string, unknown>, image?: ImageData): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ ...msg, id, image }, image ? [image.data.buffer] : []);
  });
}

let ready = false;
/** เริ่มโหลด OpenCV ล่วงหน้า (ตอนเปิดแอป) จะได้ไม่รอตอนบันทึกหน้าแรก */
export const warmUp = () => call<{ ok: boolean }>({ type: 'ping' }).then((r) => { ready = true; return r; }).catch(() => undefined);
/** OpenCV โหลดเสร็จแล้วหรือยัง (ไว้ตัดสินใจว่าจะใช้ตัวหาขอบสำรองแบบเดิมได้ทันทีไหม) */
export const isCvReady = () => ready;

export function detectQuad(image: ImageData) {
  return call<{ quad: Quad | null; confidence: number }>({ type: 'detect' }, image);
}
export function warpQuad(image: ImageData, quad: Quad, size?: { w: number; h: number }) {
  return call<ImageData>({ type: 'warp', quad, size }, image);
}
export function applyFilter(image: ImageData, name: FilterName) { return call<ImageData>({ type: 'filter', name }, image); }
export function applyAdjust(image: ImageData, adjust: Adjustments) { return call<ImageData>({ type: 'adjust', adjust }, image); }
