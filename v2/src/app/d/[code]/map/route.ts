import { smsByCode } from '@/lib/sms';
import { downloadFile } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = ['sin1'];

/**
 * รูปแผนที่นัดหมายของลิงก์ SMS — ส่งไฟล์ตรง ๆ (ไม่ redirect ไป signed URL)
 * แอปข้อความบางตัวไม่ตาม redirect ตอนทำ thumbnail และ signed URL หมดอายุใน 1 ชั่วโมง
 */
export async function GET(_request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const found = await smsByCode(code);
  if (!found || !found.row.mapKey) return new Response('not found', { status: 404 });
  if (found.expired) return new Response('expired', { status: 410 });
  const file = await downloadFile(found.row.mapKey);
  if (!file) return new Response('not found', { status: 404 });
  return new Response(new Uint8Array(file.buffer), {
    headers: { 'content-type': file.contentType, 'cache-control': 'public, max-age=3600', 'x-robots-tag': 'noindex' }
  });
}
