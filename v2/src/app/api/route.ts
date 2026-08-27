import { NextResponse } from 'next/server';
import { dispatch } from '@/lib/dispatch';

// scrypt (crypto.scryptSync) และ postgres.js ใช้ Node API — Edge runtime รันไม่ได้
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// เช็กอิน/ปิดบัญชีต้องอยู่ใกล้ Supabase (Singapore) ไม่งั้นแต่ละ query วิ่งข้ามทวีป
export const preferredRegion = ['sin1'];

const noStore = { 'cache-control': 'no-store' };

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

  try {
    return NextResponse.json(await dispatch(body), { headers: noStore });
  } catch (error) {
    console.error('[api]', error);
    const detail = process.env.NODE_ENV === 'production'
      ? 'server_error'
      : String((error as Error)?.stack || error);
    return NextResponse.json({ ok: false, error: detail }, { headers: noStore });
  }
}
