import crypto from 'node:crypto';
import { runCoordReminders } from '@/lib/coord-remind';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = ['sin1'];
export const maxDuration = 60;

/**
 * Supabase pg_cron (pg_net) เรียกทุก 5 นาที: Authorization: Bearer <CRON_SECRET>
 * ไม่ตั้ง CRON_SECRET = ปิด (ตอบ 503) / กุญแจผิด = 401
 */
async function handle(request: Request) {
  if (!env.cronSecret) return Response.json({ ok: false, error: 'cron_not_configured' }, { status: 503 });
  const got = Buffer.from(String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(env.cronSecret);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  try {
    return Response.json(await runCoordReminders(new URL(request.url).origin));
  } catch (e) {
    console.error('[cron]', e);
    return Response.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}
export const POST = handle;
export const GET = handle;
