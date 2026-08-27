import { NextResponse } from 'next/server';
import { signedUrlFor } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * เปิดดูรูปที่เก็บใน Supabase Storage ด้วย URL เดิม /files/<category>/<name>
 * ฐานข้อมูลเก็บ path แบบนี้ไว้ ทั้งของเดิมและของใหม่จึงเปิดได้เหมือนกันหมด
 * ตัว signed URL มีอายุจำกัด เลยต้องออกใหม่ทุกครั้งที่มีคนเปิด แล้ว redirect ไป
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const key = (path || []).map((part) => decodeURIComponent(part)).join('/');

  // กัน path traversal ออกนอกถังที่ตั้งใจ
  if (!key || key.includes('..') || key.startsWith('/')) {
    return NextResponse.json({ ok: false, error: 'file_not_found' }, { status: 404 });
  }

  const url = await signedUrlFor(key);
  if (!url) return NextResponse.json({ ok: false, error: 'file_not_found' }, { status: 404 });

  // ห้าม cache ตัว redirect เอง เพราะ signed URL หมดอายุ (แต่ไฟล์ปลายทาง cache ได้)
  return NextResponse.redirect(url, { status: 307, headers: { 'cache-control': 'no-store' } });
}
