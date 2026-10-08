import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { drivers, lineWebhookEvents } from '@/db/schema';
import { verifyLineSignature } from '@/lib/coord-line';
import { nowIso } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = ['sin1'];

/**
 * Webhook ของ LINE OA — ตรวจลายเซ็นกับ body ดิบก่อน parse เสมอ (ลายเซ็นผิด = ไม่ทำอะไรเลย)
 * ตอนนี้ใช้แค่ follow / unfollow (คนขับเพิ่ม/บล็อก OA) เพื่อรู้ว่าส่งข้อความหาได้ไหม
 * LINE ส่งซ้ำได้ — webhookEventId ที่เคยประมวลผลแล้วข้าม
 */
export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifyLineSignature(raw, request.headers.get('x-line-signature'))) {
    return new Response('invalid signature', { status: 401 });
  }
  let events: any[] = [];
  try { events = JSON.parse(raw).events || []; } catch { return new Response('bad request', { status: 400 }); }

  for (const ev of events) {
    const eventId = String(ev?.webhookEventId || '');
    if (eventId) {
      const done = await db.insert(lineWebhookEvents).values({ eventId, type: String(ev?.type || ''), receivedAt: nowIso() })
        .onConflictDoNothing().returning({ eventId: lineWebhookEvents.eventId });
      if (!done.length) continue;
    }
    const userId = String(ev?.source?.userId || '');
    if (!userId) continue;
    if (ev.type === 'follow' || ev.type === 'unfollow') {
      await db.update(drivers).set({ lineFriend: ev.type === 'follow', updatedAt: nowIso() }).where(eq(drivers.lineUserId, userId));
    }
  }
  return new Response('ok');
}
