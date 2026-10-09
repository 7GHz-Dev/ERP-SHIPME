import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { db } from '@/db';
import { drivers, jobPlanItems, jobSteps, locationRequests, meetings } from '@/db/schema';
import { driverUrl, flexMessage, notifyStaff, pushToDriver, staffUrl } from './coord-line';
import { nowIso, ymd } from './utils';

/**
 * เตือนอัตโนมัติ — Supabase pg_cron เรียกทุก 5 นาที (POST /api/cron/coord-reminders)
 *
 * เตือนแต่ละเรื่องครั้งเดียว: ref ของข้อความไม่ซ้ำ → line_outbox กันส่งซ้ำให้เอง (เรียกถี่แค่ไหนก็ไม่ส่งรัว)
 * เฉพาะคนขับที่ผูก LINE แล้ว (ไม่เตือนทาง SMS เพราะเสียเงินทุกข้อความ) และเฉพาะ 06:00–21:00 เวลาไทย
 */
const HOURS = { from: 6, to: 21 };
const min = (n: number) => n * 60000;
const agoIso = (n: number) => new Date(Date.now() - min(n)).toISOString();

/** opts.date = จำกัดเฉพาะงานวันที่นั้น (ใช้ทดสอบ ไม่ให้แตะงานจริง) — cron จริงไม่ส่งมา */
export async function runCoordReminders(origin: string, opts: { date?: string; ignoreHours?: boolean } = {}) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Bangkok' }).format(new Date()));
  if (!opts.ignoreHours && (hour < HOURS.from || hour >= HOURS.to)) return { ok: true, skipped: 'outside_hours', hour };
  const today = opts.date || ymd(), now = nowIso();
  const reqDate = opts.date ? eq(locationRequests.inspectDate, opts.date) : undefined;
  const counts: Record<string, number> = { location: 0, locationExpired: 0, meeting: 0, pickup: 0, xray: 0, eirReceipt: 0, photos: 0 };
  const driverCache = new Map<string, typeof drivers.$inferSelect | null>();
  const driverOf = async (id: string) => {
    if (!driverCache.has(id)) { const [d] = await db.select().from(drivers).where(eq(drivers.id, id)).limit(1); driverCache.set(id, d || null); }
    return driverCache.get(id)!;
  };
  const push = async (driverId: string, ref: string, title: string, lines: string[], label: string, query: string) => {
    const d = await driverOf(driverId);
    if (!d?.lineUserId) return false;
    const r = await pushToDriver({ lineUserId: d.lineUserId, driverId: d.id, kind: 'REMINDER', ref,
      messages: [flexMessage(title, title, lines, [{ label, uri: driverUrl(origin, query, true), primary: true }])] });
    return r.state === 'sent' || r.state === 'demo';
  };

  // 1) คำขอพิกัดที่ยังไม่ตอบ — เตือนที่ 10 และ 20 นาที (คำขออายุ 30 นาที)
  const pending = await db.select().from(locationRequests).where(and(eq(locationRequests.status, 'sent'), gt(locationRequests.expiresAt, now),
    lt(locationRequests.requestedAt, agoIso(10)), reqDate));
  for (const r of pending) {
    const age = (Date.now() - Date.parse(r.requestedAt)) / 60000;
    const round = age >= 20 ? 2 : 1;
    const title = r.phase === 'CARD_PICKUP' ? '⏰ เตือน: ส่งตำแหน่งเพื่อรับการ์ดรับตู้' : '⏰ เตือน: ส่งตำแหน่งเพื่อรับ EIR';
    if (await push(r.driverId, `remind-loc${round}:${r.id}`, title, ['ชิปปิ้งยังรอตำแหน่งของคุณ', 'กดปุ่มด้านล่างแล้วอนุญาตตำแหน่ง'], 'ส่งตำแหน่งตอนนี้', `r=${r.code}`)) counts.location++;
  }

  // 2) คำขอหมดอายุแล้วคนขับไม่ตอบ — แจ้งชิปปิ้ง (สำคัญ) ให้โทรหา
  const expired = await db.select().from(locationRequests).where(and(eq(locationRequests.status, 'sent'), lt(locationRequests.expiresAt, now),
    gt(locationRequests.expiresAt, agoIso(30)), reqDate));
  for (const r of expired) {
    const d = await driverOf(r.driverId);
    await notifyStaff({ username: String(r.username), level: 'important', ref: `expired:${r.id}`, title: `📵 ${d?.name || 'คนขับ'} ยังไม่ส่งตำแหน่ง`,
      lines: ['คำขอหมดอายุแล้ว — โทรหาคนขับ หรือส่งคำขอใหม่', d?.phone ? `โทร ${d.phone}` : ''].filter(Boolean),
      url: staffUrl(origin, `date=${r.inspectDate}&tab=map&phase=${r.phase}`), button: 'เปิดแผนที่' });
    counts.locationExpired++;
  }

  // 3) นัดที่คนขับยังไม่กดรับ — เตือนเมื่อส่งไปเกิน 10 นาที หรือเหลือไม่ถึง 20 นาทีก่อนเวลานัด
  const proposed = await db.select().from(meetings).where(and(eq(meetings.status, 'PROPOSED'), eq(meetings.inspectDate, today)));
  for (const m of proposed) {
    const due = Date.parse(m.scheduledAt) - Date.now() < min(20) || Date.now() - Date.parse(m.createdAt) > min(10);
    if (!due || Date.parse(m.scheduledAt) < Date.now() - min(30)) continue;
    const t = new Date(m.scheduledAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
    if (await push(m.driverId, `remind-meet:${m.id}`, '⏰ เตือน: นัดหมายกับชิปปิ้ง', [`เวลา ${t} น. ที่ ${m.label}`, 'กด "รับทราบนัด" ให้ชิปปิ้งรู้ว่าคุณได้รับแล้ว'],
      'ดูนัดหมาย', `m=${m.id}`)) counts.meeting++;
  }

  // 4) รายตู้: ได้การ์ดแล้วยังไม่ส่งงานรับตู้ (90 นาที) / ส่งงานรับตู้แล้วยังไม่กด "X-Ray แล้ว" (90 นาที)
  //    / ชิปปิ้งส่ง EIR แล้วคนขับยังไม่ยืนยัน (15 นาที) / รับ EIR แล้วยังไม่ส่งรูป (60 นาที)
  const steps = await db.select().from(jobSteps).where(and(eq(jobSteps.inspectDate, today), eq(jobSteps.completedAt, ''), sql`${jobSteps.driverId} <> ''`));
  const ids = steps.map((s) => s.itemId);
  const items = ids.length ? await db.select({ id: jobPlanItems.id, containerNo: jobPlanItems.containerNo, bl: jobPlanItems.bl }).from(jobPlanItems).where(inArray(jobPlanItems.id, ids)) : [];
  const cn = (id: string) => { const i = items.find((x) => x.id === id); return i ? (i.containerNo || i.bl) : ''; };
  for (const s of steps) {
    const card = s.cardHandedAt || s.cardAckAt;
    if (card && !s.pickedUpAt && card < agoIso(90)) {
      if (await push(s.driverId, `remind-pickup:${s.itemId}`, `⏰ ส่งงานรับตู้ ${cn(s.itemId)}`, ['รับตู้แล้ว ถ่ายรูปหน้ารถ หลังรถ และซีลตู้', 'แล้วกด "ส่งงานรับตู้"'], 'ส่งงานรับตู้', 'home=1')) counts.pickup++;
    }
    if (s.pickedUpAt && s.xrayStatus === 'pending' && s.pickedUpAt < agoIso(90)) {
      if (await push(s.driverId, `remind-xray:${s.itemId}`, `⏰ ตู้ ${cn(s.itemId)} เข้าเครื่อง X-Ray แล้วหรือยัง?`, ['เข้าเครื่องแล้ว กด "X-Ray แล้ว" ให้ชิปปิ้งเช็กผล'], 'อัปเดตสถานะ X-Ray', 'home=1')) counts.xray++;
    }
    if (s.eirHandedAt && !s.eirReceivedAt && s.eirHandedAt < agoIso(15)) {
      if (await push(s.driverId, `remind-eir:${s.itemId}`, `⏰ ยืนยันรับ EIR ตู้ ${cn(s.itemId)}`, ['ชิปปิ้งบันทึกว่าส่งมอบ EIR ให้คุณแล้ว', 'ถ้าได้รับแล้ว กด "ได้รับ EIR แล้ว"'], 'ยืนยันรับ EIR', 'home=1')) counts.eirReceipt++;
    }
    if (s.eirReceivedAt && s.eirReceivedAt < agoIso(60)) {
      if (await push(s.driverId, `remind-photo:${s.itemId}`, `⏰ ส่งรูปจบงานตู้ ${cn(s.itemId)}`, ['ตรวจปล่อยเสร็จแล้ว ถ่ายรูปการ์ด EIR + รูป Seal ตู้ แล้วกด "ยืนยันจบงาน"'], 'ส่งรูปจบงาน', 'home=1')) counts.photos++;
    }
  }
  return { ok: true, at: now, counts };
}
