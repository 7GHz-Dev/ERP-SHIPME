import type { Quad } from './types';

/**
 * ตัวเรียก detect-worker.js — หาขอบเอกสารด้วย JavaScript ล้วน (ไม่ต้องรอโหลด OpenCV)
 * แยก worker จากงานปรับภาพ (cv.ts) เพื่อให้กล้องจับกรอบได้ลื่นแม้กำลังบันทึกหน้าก่อนหน้าอยู่
 */
export interface Signature { v: number[]; sd: number; mean: number }
export interface DetectResult {
  quad: Quad | null;
  score: number;
  sup?: number;
  supMin?: number;
  /** สัดส่วนพื้นที่เอกสารต่อทั้งภาพ */
  area: number;
  sig?: Signature;
  info: { ms: number; edges: number; lines: number; candidates: number; w: number; h: number };
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker('/detect-worker.js');
  worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.result);
    else p.reject(new Error(e.data.error || 'หาขอบเอกสารไม่สำเร็จ'));
  };
  worker.onerror = () => {
    pending.forEach((p) => p.reject(new Error('โหลดตัวหาขอบเอกสารไม่สำเร็จ')));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function call<T>(msg: Record<string, unknown>, image: ImageData): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ ...msg, id, image }, [image.data.buffer]);
  });
}

/** สร้าง worker ไว้ก่อน (ไฟล์เล็ก โหลดแป๊บเดียว) */
export function warmDetector() { getWorker(); }

/** live = เฟรมสดจากกล้อง (เร็ว) • still = รูปนิ่ง/รูปที่นำเข้า (ละเอียดกว่า รับเอกสารเล็กกว่า) */
export function detectDoc(image: ImageData, mode: 'live' | 'still' = 'live', prev: Quad | null = null) {
  return call<DetectResult>({ type: 'detect', opts: { mode, prev } }, image);
}

/** เกลากรอบบนภาพความละเอียดสูงขึ้น — radius = ความคลาดเคลื่อนที่คาดไว้ของกรอบเดิม (พิกเซลของภาพนี้) */
export function refineDoc(image: ImageData, quad: Quad, radius: number) {
  return call<{ quad: Quad }>({ type: 'refine', quad, radius }, image);
}

/** ความเหมือนของเนื้อหาสองหน้า (−1..1) — ใช้กันถ่ายหน้าเดิมซ้ำตอนถ่ายต่อเนื่อง */
export function sigCorrelation(a?: Signature | null, b?: Signature | null) {
  if (!a || !b || a.v.length !== b.v.length) return 0;
  const flatA = a.sd <= 1.5, flatB = b.sd <= 1.5;
  if (flatA || flatB) return flatA && flatB ? 1 - Math.min(1, Math.abs(a.mean - b.mean) / 40) : 0;
  let s = 0;
  for (let i = 0; i < a.v.length; i++) s += a.v[i] * b.v[i];
  return s / a.v.length;
}
