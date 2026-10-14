import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { drivers, lineWebhookEvents } from '@/db/schema';
import { verifyLineSignature } from '@/lib/coord-line';
import { handleShipAskPostback, handleShipAskText, rememberLineGroup } from '@/lib/ship-ask';
import { nowIso } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = ['sin1'];

/**
 * Webhook ของ LINE OA — ตรวจลายเซ็นกับ body ดิบก่อน parse เสมอ (ลายเซ็นผิด = ไม่ทำอะไรเลย)
 * follow / unfollow (คนขับเพิ่ม/บล็อก OA) เพื่อรู้ว่าส่งข้อความหาได้ไหม
 * postback / ข้อความ = ชิปปิ้งตอบคำถามผู้จัดการ "งานตรวจปล่อยเสร็จครบหรือยัง" (ship-ask.ts)
 * join / leave / ข้อความในกลุ่ม = จำกลุ่ม LINE ไว้ส่งคำตอบเข้ากลุ่ม
 * LINE ส่งซ้ำได้ — webhookEventId ที่เคยประมวลผลแล้วข้าม
 */
export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifyLineSignature(raw, request.headers.get('x-line-signature'))) {
    return new Response('invalid signature', { status: 401 });
  }
  let events: any[] = [];
  try { events = JSON.parse(raw).events || []; } catch { return new Response('bad request', { status: 400 }); }

  const origin = new URL(request.url).origin;
  for (const ev of events) {
    const eventId = String(ev?.webhookEventId || '');
    if (eventId) {
      const done = await db.insert(lineWebhookEvents).values({ eventId, type: String(ev?.type || ''), receivedAt: nowIso() })
        .onConflictDoNothing().returning({ eventId: lineWebhookEvents.eventId });
      if (!done.length) continue;
    }
    // กลุ่ม LINE: เชิญ OA เข้ากลุ่ม / ออก / มีข้อความในกลุ่ม → จำไว้ให้ผู้จัดการเลือกเป็นกลุ่มรับคำตอบ
    if (ev?.source?.type === 'group' || ev?.source?.type === 'room') {
      await rememberLineGroup(ev).catch((e) => console.error('[line webhook] group', e));
    }
    const userId = String(ev?.source?.userId || '');
    if (!userId) continue;
    if (ev.type === 'follow' || ev.type === 'unfollow') {
      await db.update(drivers).set({ lineFriend: ev.type === 'follow', updatedAt: nowIso() }).where(eq(drivers.lineUserId, userId));
    } else if (ev.type === 'postback') {
      await handleShipAskPostback(ev, origin).catch((e) => console.error('[line webhook] postback', e));
    } else if (ev.type === 'message' && ev.message?.type === 'text') {
      await handleShipAskText(ev, origin).catch((e) => console.error('[line webhook] text', e));
    }
  }
  return new Response('ok');
}
