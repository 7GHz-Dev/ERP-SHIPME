import { NextResponse } from 'next/server';
import { resetDb } from '@/db';
import { dispatch } from '@/lib/dispatch';

// scrypt (crypto.scryptSync) และ postgres.js ใช้ Node API — Edge runtime รันไม่ได้
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// เช็กอิน/ปิดบัญชีต้องอยู่ใกล้ Supabase (Singapore) ไม่งั้นแต่ละ query วิ่งข้ามทวีป
export const preferredRegion = ['sin1'];
// OCR สลิปตั้ง timeout ของตัวเองไว้ 30 วินาที ถ้า function ตัดก่อนจะได้ error กลาง ๆ
// ที่ผู้ใช้อ่านไม่รู้เรื่อง แทนข้อความบอกสาเหตุจริง — เผื่อเวลาให้มากกว่านั้น
export const maxDuration = 60;

// DocScan (คนละโดเมน) เรียก API ด้วย ticket — ทุก action ยังต้องมี token หรือ ticket เอง
// และเบราว์เซอร์ส่ง text/plain จึงไม่มี preflight; เปิด origin ไว้ให้อ่านผลลัพธ์ได้
const noStore = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' };

/**
 * กันหน้าเว็บหมุนค้าง 60 วินาที: งานเกินกำหนด = ตอบ "ระบบไม่ว่างชั่วคราว" ทันที แล้วเปิด connection ฐานข้อมูลใหม่
 * (ส่วนใหญ่เกิดจาก connection ค้าง — ดู src/db/index.ts) งานที่ช้าโดยธรรมชาติ (OCR / ซิงก์ชีต / นำเข้า-ส่งออก) ได้เวลามากกว่า
 */
const SLOW_ACTIONS = /slip|ocr|sync|prune|report|import|export|batch|kola|plan(save|load)|routeplan|sendDriverSms|notifyJobs|requestLocations|diagnostics|richmenu/i;
const busy = () => ({ ok: false, error: 'server_busy', message: 'ระบบไม่ว่างชั่วคราว กรุณาลองใหม่อีกครั้ง' });

async function withWatchdog(body: Record<string, unknown>) {
  const limit = SLOW_ACTIONS.test(String(body.action || '')) ? 55000 : 30000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), limit); });
  try {
    const result = await Promise.race([dispatch(body), timeout]);
    if (result === 'timeout') {
      console.error('[api] watchdog', String(body.action || ''), `${limit}ms — reset DB pool`);
      resetDb();
      return busy();
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...noStore, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
}

export async function GET() {
  return NextResponse.json(
    { ok: true, message: 'Check-in API is running', stack: 'Next.js + Supabase', time: new Date().toISOString() },
    { headers: noStore }
  );
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    // หน้าเว็บเดิมส่งมาเป็น text/plain (กัน CORS preflight สมัยที่ยังอยู่คนละโดเมน) จึง parse เอง
    const raw = await request.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400, headers: noStore });
  }

  // ลิงก์ใน SMS ใช้โดเมนเดียวกับที่ผู้ใช้เปิดอยู่ และหน้าลิงก์เก็บ user agent ของคนขับไว้กับตำแหน่ง
  // เขียนทับเสมอ ไม่เชื่อค่าที่เบราว์เซอร์ส่งมาเอง
  body._origin = new URL(request.url).origin;
  body._ua = request.headers.get('user-agent') || '';

  try {
    return NextResponse.json(await withWatchdog(body), { headers: noStore });
  } catch (error) {
    console.error('[api]', error);
    const detail = process.env.NODE_ENV === 'production'
      ? 'server_error'
      : String((error as Error)?.stack || error);
    return NextResponse.json({ ok: false, error: detail }, { headers: noStore });
  }
}
