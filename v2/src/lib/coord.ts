import crypto from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  driverLinkInvites, drivers, evidenceFiles, jobEvents, jobPlanItems, jobPlans, jobSteps,
  lineOutbox, locationReports, locationRequests, meetingPoints
} from '@/db/schema';
import { driverUrl, flexMessage, lineMode, notifyStaff, pushToDriver, staffUrl, verifyLineIdToken } from './coord-line';
import { env } from './env';
import { sendPlainSms, smsConfig, smsPhone, thShortDate } from './sms';
import { createSignedUpload, fileExists } from './storage';
import type { ApiBody, ApiResult } from './types';
import { id, nowIso, validYmd, ymd } from './utils';

/**
 * ประสานงานคนขับ — ชิปปิ้ง 1 คน + วันตรวจปล่อย 1 วัน = 1 ชุดงาน (แถวในแพลนที่ผู้จัดการ Confirm แล้ว)
 *
 * ลำดับงานจริง:
 *   ขอพิกัดรอบแรก (CARD_PICKUP) → แจกการ์ดรับตู้ → คนขับรับตู้ → ผ่าน X-Ray
 *   → [ทุกตู้ในชุดผ่าน X-Ray] → ขอพิกัดรอบสอง (EIR_HANDOVER) → ส่งมอบ EIR (ชิปปิ้ง → คนขับ)
 *   → คนขับยืนยันรับ EIR → ส่งรูปการ์ด EIR + รูป Seal ของ "แต่ละตู้" → จบงาน (ไม่ต้องรอตรวจ)
 *
 * กติกา:
 *   - ทุกสถานะเป็นของ "ตู้" ไม่ใช่ของคนขับ (คนขับ 1 คนหลายตู้ = รายงานแยกทีละตู้)
 *   - ส่งข้อความ 1 ครั้งต่อคนขับ 1 คนต่อรอบ (ไม่ใช่ต่อตู้)
 *   - รอบสองกดได้เมื่อทุกตู้ในชุดผ่าน X-Ray เท่านั้น — ตรวจซ้ำที่เซิร์ฟเวอร์ตอนกด ไม่มีทางลัด
 *   - พิกัดรอบแรกใช้ตอบรอบสองไม่ได้ / ไม่มีการติดตามตำแหน่งเบื้องหลัง
 */

export type Phase = 'CARD_PICKUP' | 'EIR_HANDOVER';
const PHASES: Phase[] = ['CARD_PICKUP', 'EIR_HANDOVER'];
const REQUEST_EXPIRY_MIN = 30;
const RESEND_COOLDOWN_MIN = 10;
const FRESH_MIN = 15;
const INVITE_DAYS = 7;
const SESSION_HOURS = 12;
const EVIDENCE_KINDS = ['EIR_CARD_PHOTO', 'CONTAINER_SEAL_PHOTO'] as const;
type EvidenceKind = typeof EVIDENCE_KINDS[number];

const text = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);
const addMin = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60000).toISOString();
const shiftDate = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
};
const randomCode = (len: number) => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(len), (b) => alphabet[b % alphabet.length]).join('');
};

// ---------------- session คนขับ (ลงลายเซ็น HMAC เหมือน ticket ของ DocScan) ----------------

const sessionSecret = () => env.driverSessionSecret
  || crypto.createHash('sha256').update('driver-session:' + (process.env.DATABASE_URL || 'dev')).digest('hex');
const sign = (payload: string) => crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');

type DriverSession = { d: string; exp: number; via: 'line' | 'code' | 'demo' };

function makeSession(driverId: string, via: DriverSession['via']) {
  const payload = Buffer.from(JSON.stringify({ d: driverId, exp: Date.now() + SESSION_HOURS * 3600_000, via })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readSession(raw: unknown): DriverSession | null {
  const [payload, sig] = String(raw || '').split('.');
  if (!payload || !sig) return null;
  const expect = sign(payload);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DriverSession;
    return s.d && s.exp > Date.now() ? s : null;
  } catch { return null; }
}

async function driverFromSession(body: ApiBody) {
  const s = readSession(body.session);
  if (!s) return null;
  const [d] = await db.select().from(drivers).where(eq(drivers.id, s.d)).limit(1);
  return d || null;
}

// ---------------- โหลดชุดงาน + เตรียมทะเบียนคนขับ / สถานะรายตู้ ----------------

type ItemRow = typeof jobPlanItems.$inferSelect;
type StepRow = typeof jobSteps.$inferSelect;
type DriverRow = typeof drivers.$inferSelect;

export async function logEvents(rows: { itemId: string; inspectDate: string; username: string }[], actorType: string, actorId: string, event: string, meta: Record<string, unknown> = {}) {
  if (!rows.length) return;
  const at = nowIso();
  await db.insert(jobEvents).values(rows.map((r) => ({
    id: id('je_'), itemId: r.itemId, inspectDate: r.inspectDate, username: r.username,
    actorType, actorId, event, metaJson: JSON.stringify(meta).slice(0, 2000), createdAt: at
  })));
}

/**
 * คนขับในทะเบียนสร้างจากเบอร์มือถือในแพลน (1 เบอร์ = 1 คน) และทุกตู้มีแถวสถานะใน job_steps
 * ผู้จัดการเปลี่ยนคนขับในแพลน = ตู้นั้นเปลี่ยนเจ้าของ (บันทึกประวัติไว้)
 */
async function ensureRegistry(items: ItemRow[]) {
  const phones = [...new Set(items.map((i) => smsPhone(i.phone)).filter(Boolean))];
  const known = phones.length ? await db.select().from(drivers).where(inArray(drivers.phone, phones)) : [];
  const byPhone = new Map(known.map((d) => [d.phone, d]));
  const at = nowIso();
  for (const item of items) {
    const phone = smsPhone(item.phone);
    if (!phone) continue;
    const found = byPhone.get(phone);
    if (!found) {
      const row = { id: id('drv_'), name: item.driverName, phone, plate: item.plate, createdAt: at, updatedAt: at };
      await db.insert(drivers).values(row).onConflictDoNothing();
      const [saved] = await db.select().from(drivers).where(eq(drivers.phone, phone)).limit(1);
      if (saved) byPhone.set(phone, saved);
    } else if ((item.driverName && item.driverName !== found.name) || (item.plate && item.plate !== found.plate)) {
      await db.update(drivers).set({ name: item.driverName || found.name, plate: item.plate || found.plate, updatedAt: at })
        .where(eq(drivers.id, found.id));
      byPhone.set(phone, { ...found, name: item.driverName || found.name, plate: item.plate || found.plate });
    }
  }

  const steps = items.length ? await db.select().from(jobSteps).where(inArray(jobSteps.itemId, items.map((i) => i.id))) : [];
  const stepById = new Map(steps.map((s) => [s.itemId, s]));
  for (const item of items) {
    const driverId = byPhone.get(smsPhone(item.phone))?.id || '';
    const step = stepById.get(item.id);
    if (!step) {
      const row = { itemId: item.id, inspectDate: item.inspectDate, username: String(item.username), driverId, updatedAt: at };
      await db.insert(jobSteps).values(row).onConflictDoNothing();
      stepById.set(item.id, { ...emptyStep(), ...row } as StepRow);
    } else if (step.driverId !== driverId || String(step.username).toLowerCase() !== String(item.username).toLowerCase()) {
      await db.update(jobSteps).set({ driverId, username: String(item.username), updatedAt: at, version: step.version + 1 })
        .where(eq(jobSteps.itemId, item.id));
      await logEvents([{ itemId: item.id, inspectDate: item.inspectDate, username: String(item.username) }], 'system', '',
        'DRIVER_REASSIGNED', { from: step.driverId, to: driverId });
      stepById.set(item.id, { ...step, driverId, username: String(item.username) });
    }
  }
  const driverIds = [...new Set([...stepById.values()].map((s) => s.driverId).filter(Boolean))];
  const driverRows = driverIds.length ? await db.select().from(drivers).where(inArray(drivers.id, driverIds)) : [];
  return { steps: stepById, drivers: new Map(driverRows.map((d) => [d.id, d])) };
}

function emptyStep(): Omit<StepRow, 'itemId' | 'inspectDate' | 'username' | 'driverId' | 'updatedAt'> {
  return { cardHandedAt: '', cardHandedBy: '', cardAckAt: '', pickedUpAt: '', xrayStatus: 'pending', xrayAt: '', xrayNote: '',
    eirHandedAt: '', eirHandedBy: '', eirReceivedAt: '', completedAt: '', problem: '', version: 0 };
}

export async function loadBatch(date: string, username: string) {
  const [plan] = await db.select().from(jobPlans).where(eq(jobPlans.inspectDate, date)).limit(1);
  const confirmed = plan?.status === 'confirmed';
  const items = confirmed
    ? await db.select().from(jobPlanItems)
      .where(and(eq(jobPlanItems.inspectDate, date), eq(jobPlanItems.username, username)))
      .orderBy(asc(jobPlanItems.seq))
    : [];
  const reg = await ensureRegistry(items);
  return { plan, confirmed, items, ...reg };
}

/** ประตูรอบสอง: ทุกตู้ในชุดต้องรายงานผ่าน X-Ray — ไม่มีตู้เลย (0/0) ไม่นับว่าผ่าน */
export function xrayGate(items: ItemRow[], steps: Map<string, StepRow>, driverMap: Map<string, DriverRow>) {
  const blockers = items.filter((i) => steps.get(i.id)?.xrayStatus !== 'passed').map((i) => {
    const s = steps.get(i.id);
    return { itemId: i.id, containerNo: i.containerNo || i.bl, driverName: driverMap.get(s?.driverId || '')?.name || i.driverName,
      xrayStatus: s?.xrayStatus || 'pending', pickedUp: Boolean(s?.pickedUpAt) };
  });
  return { ready: items.length > 0 && blockers.length === 0, total: items.length, passed: items.length - blockers.length, blockers };
}

/** สรุปขั้นของตู้ (ไว้แสดงผล — ตัวจริงคือเวลาของแต่ละขั้น) */
export function stageOf(s: StepRow | undefined) {
  if (!s) return 'PLANNED';
  if (s.completedAt) return 'DONE';
  if (s.eirReceivedAt) return 'EIR_RECEIVED';
  if (s.eirHandedAt) return 'EIR_HANDED';
  if (s.xrayStatus === 'passed') return 'XRAY_PASSED';
  if (s.xrayStatus === 'hold') return 'XRAY_HOLD';
  if (s.xrayStatus === 'waiting') return 'XRAY_WAITING';
  if (s.pickedUpAt) return 'PICKED_UP';
  if (s.cardHandedAt || s.cardAckAt) return 'CARD_HANDED';
  return 'PLANNED';
}

function config(origin: string) {
  return {
    lineMode: lineMode(), liffId: lineMode() === 'live' ? env.liffId : '', mapsKey: env.googleMapsBrowserKey,
    smsReady: smsConfig().ready, freshMinutes: FRESH_MIN, requestExpiryMinutes: REQUEST_EXPIRY_MIN,
    resendCooldownMinutes: RESEND_COOLDOWN_MIN, origin
  };
}

type Staff = { username: string; name: string; role: string };

/** ชิปปิ้งดูได้เฉพาะชุดของตัวเอง — ผู้จัดการ/admin เลือกดูของชิปปิ้งคนไหนก็ได้ */
export function staffScope(body: ApiBody, user: Staff) {
  if (user.role === 'employee-shipping') return user.username;
  return text(body.staff, 60) || user.username;
}

// ---------------- ชิปปิ้ง: แดชบอร์ด ----------------

export async function coordDashboard(body: ApiBody, user: Staff): Promise<ApiResult> {
  const today = ymd();
  const username = staffScope(body, user);
  // วันที่ที่มีงาน (แพลน Confirm แล้ว) ย้อนหลัง 7 วันถึงอนาคต
  const dates = await db.select({ date: jobPlanItems.inspectDate, containers: sql<number>`count(*)::int` })
    .from(jobPlanItems).innerJoin(jobPlans, eq(jobPlans.inspectDate, jobPlanItems.inspectDate))
    .where(and(eq(jobPlanItems.username, username), eq(jobPlans.status, 'confirmed'), gte(jobPlanItems.inspectDate, shiftDate(today, -7))))
    .groupBy(jobPlanItems.inspectDate).orderBy(asc(jobPlanItems.inspectDate)).limit(60);
  let date = validYmd(body.date) ? String(body.date) : '';
  if (!date) date = dates.find((d) => d.date >= today)?.date || dates.at(-1)?.date || today;

  const batch = await loadBatch(date, username);
  const { items, steps, drivers: driverMap } = batch;
  const itemIds = items.map((i) => i.id);
  const evidence = itemIds.length ? await db.select().from(evidenceFiles).where(inArray(evidenceFiles.itemId, itemIds)).orderBy(asc(evidenceFiles.createdAt)) : [];
  const requests = items.length ? await db.select().from(locationRequests)
    .where(and(eq(locationRequests.inspectDate, date), eq(locationRequests.username, username)))
    .orderBy(desc(locationRequests.requestedAt)) : [];
  const reqIds = requests.map((r) => r.id);
  const reports = reqIds.length ? await db.select().from(locationReports).where(inArray(locationReports.requestId, reqIds))
    .orderBy(desc(locationReports.receivedAt)) : [];

  const now = Date.now();
  const driverList = [...driverMap.values()].map((d) => {
    const mine = items.filter((i) => steps.get(i.id)?.driverId === d.id).map((i) => i.id);
    const perPhase: Record<string, any> = {};
    for (const phase of PHASES) {
      const req = requests.find((r) => r.driverId === d.id && r.phase === phase);
      const rep = reports.find((r) => r.driverId === d.id && r.phase === phase);
      perPhase[phase] = {
        request: req ? { id: req.id, status: req.status, channel: req.channel, requestedAt: req.requestedAt, expiresAt: req.expiresAt,
          respondedAt: req.respondedAt, error: req.error, expired: Date.parse(req.expiresAt) < now, code: req.code } : null,
        location: rep ? { lat: rep.latitude, lng: rep.longitude, accuracy: rep.accuracyM, at: rep.receivedAt,
          ageMin: Math.round((now - Date.parse(rep.receivedAt)) / 60000), fresh: now - Date.parse(rep.receivedAt) <= FRESH_MIN * 60000 } : null
      };
    }
    return { id: d.id, name: d.name, phone: d.phone, plate: d.plate, linked: Boolean(d.lineUserId),
      demoLinked: d.lineUserId.startsWith('DEMO-'), friend: d.lineFriend, lineName: d.lineName, itemIds: mine, phases: perPhase };
  });

  const view = items.map((i) => {
    const s = steps.get(i.id);
    const ev = evidence.filter((e) => e.itemId === i.id);
    return {
      id: i.id, bl: i.bl, containerNo: i.containerNo, port: i.port, destination: i.destination, customer: i.customer,
      driverId: s?.driverId || '', driverName: driverMap.get(s?.driverId || '')?.name || i.driverName, plate: i.plate, phone: i.phone,
      stage: stageOf(s), step: s ? { ...s, username: String(s.username), cardHandedBy: String(s.cardHandedBy), eirHandedBy: String(s.eirHandedBy) } : null,
      evidence: ev.map((e) => ({ id: e.id, kind: e.kind, url: e.url, at: e.createdAt }))
    };
  });
  const count = (fn: (s: StepRow | undefined) => boolean) => items.filter((i) => fn(steps.get(i.id))).length;
  const gate = xrayGate(items, steps, driverMap);
  const meet = await import('./coord-meet');
  const meetingRows = items.length ? await meet.meetingsFor(date, username) : [];
  return {
    ok: true, today, date, dates, username, planStatus: batch.plan?.status || '', ...config(String(body._origin || '')),
    items: view, drivers: driverList, gate,
    noDriverPhone: items.filter((i) => !steps.get(i.id)?.driverId).map((i) => i.containerNo || i.bl),
    counts: {
      jobs: items.length, drivers: driverList.length, linked: driverList.filter((d) => d.linked).length,
      cardHanded: count((s) => Boolean(s?.cardHandedAt || s?.cardAckAt)), pickedUp: count((s) => Boolean(s?.pickedUpAt)),
      xrayPassed: gate.passed, eirHanded: count((s) => Boolean(s?.eirHandedAt)), eirReceived: count((s) => Boolean(s?.eirReceivedAt)),
      completed: count((s) => Boolean(s?.completedAt)),
      gpsCard: driverList.filter((d) => d.phases.CARD_PICKUP.location).length,
      gpsEir: driverList.filter((d) => d.phases.EIR_HANDOVER.location).length
    },
    meetingPoints: await db.select().from(meetingPoints).where(eq(meetingPoints.active, true)).orderBy(asc(meetingPoints.port), asc(meetingPoints.name)),
    meetings: meetingRows.map((m) => ({ ...m, username: String(m.username), createdBy: String(m.createdBy), itemIds: JSON.parse(m.itemIdsJson || '[]') })),
    me: await meet.staffLineStatus(user.username),
    routesSource: env.googleRoutesServerKey ? 'GOOGLE_ROUTES_API' : 'ESTIMATE'
  };
}

// ---------------- ชิปปิ้ง: ขอพิกัด (รอบแรก / รอบสอง) ----------------

function requestMessage(phase: Phase, date: string, jobs: ItemRow[], url: string, homeUrl: string) {
  const ports = [...new Set(jobs.map((j) => j.port).filter(Boolean))].join(', ');
  const cnt = jobs.map((j) => j.containerNo || j.bl).join(', ');
  if (phase === 'CARD_PICKUP') {
    return flexMessage(`SHIPME ขอพิกัดเพื่อรับการ์ดรับตู้ (${jobs.length} ตู้)`, '📍 ขอพิกัดเพื่อรับการ์ดรับตู้',
      [`งานวันที่ ${thShortDate(date)} : ${jobs.length} ตู้${ports ? ` | ท่า ${ports}` : ''}`, `ตู้: ${cnt}`,
        'กรุณากด "ส่งตำแหน่งตอนนี้" เพื่อให้ชิปปิ้งนัดหมายแจกการ์ดรับตู้'],
      [{ label: 'ส่งตำแหน่งตอนนี้', uri: url, primary: true }, { label: 'ดูงานของฉัน', uri: homeUrl }]);
  }
  return flexMessage(`SHIPME นัดรับ EIR ขาออก (${jobs.length} ตู้)`, '📄 นัดรับ EIR ขาออก',
    ['ตู้ในกลุ่มงานของคุณผ่าน X-Ray ครบแล้ว', `ตู้: ${cnt}`, 'กรุณาแชร์ตำแหน่งปัจจุบันอีกครั้ง เพื่อให้ชิปปิ้งนัดส่งมอบ EIR'],
    [{ label: 'ส่งตำแหน่งเพื่อรับ EIR', uri: url, primary: true }, { label: 'ดูสถานะงาน', uri: homeUrl }]);
}

export async function coordRequestLocations(body: ApiBody, user: Staff): Promise<ApiResult> {
  const date = String(body.date || '');
  if (!validYmd(date)) return { ok: false, error: 'bad_date' };
  const phase = body.phase === 'EIR_HANDOVER' ? 'EIR_HANDOVER' : 'CARD_PICKUP';
  const username = staffScope(body, user);
  const { confirmed, items, steps, drivers: driverMap } = await loadBatch(date, username);
  if (!confirmed || !items.length) return { ok: false, error: 'plan_not_confirmed' };

  if (phase === 'EIR_HANDOVER') {
    // ตรวจที่เซิร์ฟเวอร์ทุกครั้ง — ปุ่มที่หน้าจอปิดไว้ไม่ใช่ตัวกัน
    const gate = xrayGate(items, steps, driverMap);
    if (!gate.ready) return { ok: false, error: 'XRAY_BATCH_NOT_READY', passed: gate.passed, total: gate.total, blockers: gate.blockers };
    // เข้ารอบสองแล้ว — ปิดคำขอรอบแรกทั้งหมด (ส่งพิกัดรอบแรกเพิ่มไม่ได้ คนขับเห็นแค่คำขอรอบสอง) ประวัติยังอยู่ครบ
    await db.update(locationRequests).set({ expiresAt: nowIso() }).where(and(
      eq(locationRequests.inspectDate, date), eq(locationRequests.username, username), eq(locationRequests.phase, 'CARD_PICKUP'),
      sql`${locationRequests.expiresAt} > ${nowIso()}`));
  }

  const only = Array.isArray(body.driverIds) ? new Set(body.driverIds.map(String)) : null;
  const byDriver = new Map<string, ItemRow[]>();
  for (const item of items) {
    const driverId = steps.get(item.id)?.driverId;
    if (!driverId || (only && !only.has(driverId))) continue;
    if (!byDriver.has(driverId)) byDriver.set(driverId, []);
    byDriver.get(driverId)!.push(item);
  }
  if (!byDriver.size) return { ok: false, error: 'no_recipients' };

  const existing = await db.select().from(locationRequests)
    .where(and(eq(locationRequests.inspectDate, date), eq(locationRequests.username, username), eq(locationRequests.phase, phase)))
    .orderBy(desc(locationRequests.requestedAt));
  const origin = String(body._origin || '');
  const mode = lineMode();
  const results: any[] = [];
  for (const [driverId, jobs] of byDriver) {
    const driver = driverMap.get(driverId)!;
    const last = existing.find((r) => r.driverId === driverId);
    // กันกดซ้ำ / ส่งรัว: คำขอที่ยังไม่หมดอายุและส่งไปไม่ถึง 10 นาที ไม่ส่งซ้ำ (ส่งไม่สำเร็จส่งใหม่ได้ทันที)
    if (last && last.status !== 'failed' && Date.now() - Date.parse(last.requestedAt) < RESEND_COOLDOWN_MIN * 60000) {
      results.push({ driverId, name: driver.name, state: 'cooldown', channel: last.channel, requestId: last.id });
      continue;
    }
    const linked = Boolean(driver.lineUserId);
    const channel = linked ? (mode === 'live' && !driver.lineUserId.startsWith('DEMO-') ? 'line' : 'demo')
      : (smsConfig().ready ? 'sms' : 'none');
    const at = nowIso();
    const req = {
      id: id('lr_'), code: randomCode(10), inspectDate: date, username, driverId, phase, channel, status: 'queued',
      itemIdsJson: JSON.stringify(jobs.map((j) => j.id)), requestedBy: user.username, requestedAt: at, expiresAt: addMin(at, REQUEST_EXPIRY_MIN)
    };
    await db.insert(locationRequests).values(req);
    const url = driverUrl(origin, `r=${req.code}`, channel === 'line');
    const homeUrl = driverUrl(origin, `r=${req.code}&home=1`, channel === 'line');
    let state = 'failed', error = '';
    if (channel === 'line' || channel === 'demo') {
      const sent = await pushToDriver({ lineUserId: driver.lineUserId, driverId, kind: `LOCATION_${phase}`, ref: req.id,
        messages: [requestMessage(phase, date, jobs, url, homeUrl)] });
      state = sent.state === 'duplicate' ? 'sent' : sent.state; error = sent.error || '';
    } else if (channel === 'sms') {
      const msg = phase === 'CARD_PICKUP'
        ? `SHIPME ขอพิกัดเพื่อนัดแจกการ์ดรับตู้ ${jobs.length} ตู้ วันที่ ${thShortDate(date)} กดลิงก์: ${url}`
        : `SHIPME ตู้ผ่าน X-Ray ครบแล้ว กรุณาส่งพิกัดเพื่อนัดรับ EIR กดลิงก์: ${url}`;
      const sent = await sendPlainSms(driver.phone, msg);
      state = sent.ok ? 'sent' : 'failed'; error = sent.ok ? '' : String(sent.error || 'sms_failed');
    } else {
      error = 'ยังไม่ผูก LINE และระบบ SMS ยังไม่พร้อม — ส่งลิงก์ให้คนขับเอง';
    }
    const status = state === 'sent' || state === 'demo' ? 'sent' : 'failed';
    await db.update(locationRequests).set({ status, error }).where(eq(locationRequests.id, req.id));
    await logEvents(jobs.map((j) => ({ itemId: j.id, inspectDate: date, username })), 'staff', user.username, `LOCATION_${phase}_REQUESTED`,
      { requestId: req.id, channel, state });
    results.push({ driverId, name: driver.name, state, channel, requestId: req.id, link: url, error });
  }
  return {
    ok: true, phase, drivers: byDriver.size, containers: [...byDriver.values()].reduce((s, j) => s + j.length, 0),
    sent: results.filter((r) => r.state === 'sent' || r.state === 'demo').length,
    failed: results.filter((r) => r.state === 'failed').length,
    cooldown: results.filter((r) => r.state === 'cooldown').length, results
  };
}

// ---------------- ชิปปิ้ง: แจกการ์ด / ส่งมอบ EIR (บันทึกแยกทีละตู้) ----------------

async function staffMark(body: ApiBody, user: Staff, field: 'card' | 'eir'): Promise<ApiResult> {
  const date = String(body.date || '');
  if (!validYmd(date)) return { ok: false, error: 'bad_date' };
  const username = staffScope(body, user);
  const ids = Array.isArray(body.itemIds) ? body.itemIds.map(String).slice(0, 200) : [];
  if (!ids.length) return { ok: false, error: 'no_items' };
  const { items, steps, drivers: driverMap } = await loadBatch(date, username);
  const mine = items.filter((i) => ids.includes(i.id));
  if (mine.length !== ids.length) return { ok: false, error: 'forbidden' };
  const undo = body.undo === true;
  if (field === 'eir' && !undo) {
    const gate = xrayGate(items, steps, driverMap);
    if (!gate.ready) return { ok: false, error: 'XRAY_BATCH_NOT_READY', passed: gate.passed, total: gate.total, blockers: gate.blockers };
  }
  const at = nowIso();
  const changed: ItemRow[] = [];
  for (const item of mine) {
    const s = steps.get(item.id)!;
    if (field === 'card') {
      if (undo ? !s.cardHandedAt || s.pickedUpAt : s.cardHandedAt) continue;   // รับตู้แล้วถอยการแจกการ์ดไม่ได้
      await db.update(jobSteps).set(undo ? { cardHandedAt: '', cardHandedBy: '', updatedAt: at, version: s.version + 1 }
        : { cardHandedAt: at, cardHandedBy: user.username, updatedAt: at, version: s.version + 1 }).where(eq(jobSteps.itemId, item.id));
    } else {
      if (undo ? !s.eirHandedAt || s.eirReceivedAt : s.eirHandedAt) continue;   // คนขับยืนยันรับแล้วถอยไม่ได้
      await db.update(jobSteps).set(undo ? { eirHandedAt: '', eirHandedBy: '', updatedAt: at, version: s.version + 1 }
        : { eirHandedAt: at, eirHandedBy: user.username, updatedAt: at, version: s.version + 1 }).where(eq(jobSteps.itemId, item.id));
    }
    changed.push(item);
  }
  await logEvents(changed.map((i) => ({ itemId: i.id, inspectDate: date, username })), 'staff', user.username,
    field === 'card' ? (undo ? 'PICKUP_CARD_HANDED_UNDONE' : 'PICKUP_CARD_HANDED') : (undo ? 'EIR_STAFF_HANDED_UNDONE' : 'EIR_STAFF_HANDED_OVER'));
  if (changed.length && !undo) {
    // ส่งมอบครบทุกตู้ของนัด = นัดนั้นจบ
    const fresh = await db.select().from(jobSteps).where(inArray(jobSteps.itemId, items.map((i) => i.id)));
    const { closeMetMeetings } = await import('./coord-meet');
    await closeMetMeetings(date, username, field === 'card' ? 'CARD_PICKUP' : 'EIR_HANDOVER', new Map(fresh.map((f) => [f.itemId, f])));
  }
  return { ok: true, count: changed.length };
}
export const coordCardHanded = (body: ApiBody, user: Staff) => staffMark(body, user, 'card');
export const coordEirHanded = (body: ApiBody, user: Staff) => staffMark(body, user, 'eir');

// ---------------- ชิปปิ้ง: ผูก LINE คนขับ ----------------

export async function coordDriverInvite(body: ApiBody, user: Staff): Promise<ApiResult> {
  const [driver] = await db.select().from(drivers).where(eq(drivers.id, text(body.driverId, 60))).limit(1);
  if (!driver) return { ok: false, error: 'not_found' };
  if (user.role === 'employee-shipping') {
    // ชิปปิ้งออกโค้ดได้เฉพาะคนขับที่อยู่ในงานของตัวเอง
    const [own] = await db.select({ itemId: jobSteps.itemId }).from(jobSteps)
      .where(and(eq(jobSteps.driverId, driver.id), eq(jobSteps.username, user.username))).limit(1);
    if (!own) return { ok: false, error: 'forbidden' };
  }
  const at = nowIso();
  const code = randomCode(8);
  await db.insert(driverLinkInvites).values({ code, driverId: driver.id, createdBy: user.username, createdAt: at, expiresAt: addMin(at, INVITE_DAYS * 1440) });
  const origin = String(body._origin || '');
  const link = driverUrl(origin, `link=${code}`, true);
  let sms = '';
  if (body.sendSms === true) {
    const sent = await sendPlainSms(driver.phone, `SHIPME: กดลิงก์เพื่อเชื่อม LINE รับงานขนส่ง (ใช้ได้ ${INVITE_DAYS} วัน) ${link}`);
    sms = sent.ok ? 'sent' : String(sent.error || 'failed');
  }
  return { ok: true, code, link, expiresAt: addMin(at, INVITE_DAYS * 1440), sms, addFriendHint: lineMode() === 'live' };
}

/** DEMO เท่านั้น — ผูก LINE จำลองให้คนขับ และเปิดหน้าคนขับแทนเพื่อทดลองทั้ง flow */
export async function coordDemo(body: ApiBody, user: Staff): Promise<ApiResult> {
  if (lineMode() !== 'demo') return { ok: false, error: 'demo_only' };
  const [driver] = await db.select().from(drivers).where(eq(drivers.id, text(body.driverId, 60))).limit(1);
  if (!driver) return { ok: false, error: 'not_found' };
  if (body.op === 'link') {
    await db.update(drivers).set({ lineUserId: `DEMO-${driver.id}`, lineName: `${driver.name} (DEMO)`, lineFriend: true,
      lineLinkedAt: nowIso(), updatedAt: nowIso() }).where(eq(drivers.id, driver.id));
    return { ok: true };
  }
  if (body.op === 'unlink') {
    await db.update(drivers).set({ lineUserId: '', lineName: '', lineFriend: false, lineLinkedAt: '', updatedAt: nowIso() })
      .where(eq(drivers.id, driver.id));
    return { ok: true };
  }
  return { ok: true, session: makeSession(driver.id, 'demo'), by: user.username };
}

/** ข้อความที่ระบบส่ง/จะส่งหาคนขับในชุดงาน — DEMO ใช้เป็น "จำลองแชท LINE" */
export async function coordOutbox(body: ApiBody, user: Staff): Promise<ApiResult> {
  const date = String(body.date || '');
  if (!validYmd(date)) return { ok: false, error: 'bad_date' };
  const username = staffScope(body, user);
  const steps = await db.select({ driverId: jobSteps.driverId }).from(jobSteps)
    .where(and(eq(jobSteps.inspectDate, date), eq(jobSteps.username, username)));
  const ids = [...new Set(steps.map((s) => s.driverId).filter(Boolean))];
  const rows = ids.length ? await db.select().from(lineOutbox).where(inArray(lineOutbox.driverId, ids))
    .orderBy(desc(lineOutbox.createdAt)).limit(60) : [];
  return { ok: true, lineMode: lineMode(), rows: rows.map((r) => ({ id: r.id, driverId: r.driverId, kind: r.kind, state: r.state,
    error: r.error, createdAt: r.createdAt, sentAt: r.sentAt, payload: JSON.parse(r.payloadJson || '[]') })) };
}

// ---------------- จุดนัดพบ (ตั้งค่า) ----------------

export async function meetingPointList(): Promise<ApiResult> {
  return { ok: true, rows: await db.select().from(meetingPoints).orderBy(asc(meetingPoints.port), asc(meetingPoints.name)),
    mapsKey: env.googleMapsBrowserKey };
}
export async function meetingPointSave(body: ApiBody, user: Staff): Promise<ApiResult> {
  const name = text(body.name, 100), lat = Number(body.lat), lng = Number(body.lng);
  if (!name) return { ok: false, error: 'missing_name' };
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180) || (!lat && !lng)) return { ok: false, error: 'bad_location' };
  const at = nowIso();
  const values = { name, port: text(body.port, 40), latitude: lat, longitude: lng, note: text(body.note, 300),
    active: body.active !== false, updatedAt: at };
  if (body.id) {
    const done = await db.update(meetingPoints).set(values).where(eq(meetingPoints.id, text(body.id, 60))).returning({ id: meetingPoints.id });
    return done.length ? { ok: true, id: done[0].id } : { ok: false, error: 'not_found' };
  }
  const row = { id: id('mp_'), ...values, createdBy: user.username, createdAt: at };
  await db.insert(meetingPoints).values(row);
  return { ok: true, id: row.id };
}


/** สรุปชุดงานหลังคนขับอัปเดต — ใช้แต่งข้อความแจ้งเตือนชิปปิ้ง */
async function batchProgress(date: string, username: string) {
  const rows = await db.select().from(jobSteps).where(and(eq(jobSteps.inspectDate, date), eq(jobSteps.username, username)));
  return {
    total: rows.length,
    xray: rows.filter((r) => r.xrayStatus === 'passed').length,
    eirReceived: rows.filter((r) => r.eirReceivedAt).length,
    completed: rows.filter((r) => r.completedAt).length
  };
}
async function containerOf(itemId: string) {
  const [i] = await db.select({ containerNo: jobPlanItems.containerNo, bl: jobPlanItems.bl }).from(jobPlanItems).where(eq(jobPlanItems.id, itemId)).limit(1);
  return i ? (i.containerNo || i.bl) : itemId;
}

// ---------------- คนขับ: เข้าใช้งาน ----------------

/**
 * เข้าหน้าคนขับได้ 3 ทาง:
 *   1) idToken จาก LIFF (LINE) → ตรวจกับ LINE แล้วหาคนขับที่ผูกไว้
 *   2) link=โค้ดผูก LINE → ผูกบัญชี LINE กับคนขับ (live ต้องมี idToken / demo ผูกแบบจำลอง)
 *   3) r=รหัสคำขอพิกัด → เฉพาะช่องทางสำรอง (SMS / ยังไม่ผูก) หรือ DEMO — ลิงก์ที่ส่งทาง LINE จริงต้องเข้าผ่าน LINE
 */
export async function driverAuth(body: ApiBody): Promise<ApiResult> {
  const mode = lineMode();
  let lineUser: { sub: string; name: string; picture: string } | null = null;
  if (body.idToken) {
    const v = await verifyLineIdToken(String(body.idToken));
    if (!v.ok) return { ok: false, error: v.error };
    lineUser = v;
  }

  const linkCode = text(body.link, 20).toUpperCase();
  if (linkCode) {
    const [invite] = await db.select().from(driverLinkInvites).where(eq(driverLinkInvites.code, linkCode)).limit(1);
    if (!invite || invite.usedAt || Date.parse(invite.expiresAt) < Date.now()) return { ok: false, error: 'invite_invalid' };
    if (mode === 'live' && !lineUser) return { ok: false, error: 'open_in_line' };
    const sub = lineUser?.sub || `DEMO-${invite.driverId}`;
    const [taken] = await db.select({ id: drivers.id }).from(drivers).where(eq(drivers.lineUserId, sub)).limit(1);
    if (taken && taken.id !== invite.driverId) return { ok: false, error: 'line_already_linked' };
    const at = nowIso();
    await db.update(drivers).set({ lineUserId: sub, lineName: lineUser?.name || 'DEMO', linePicture: lineUser?.picture || '',
      lineLinkedAt: at, lineFriend: mode === 'demo' ? true : undefined, updatedAt: at }).where(eq(drivers.id, invite.driverId));
    await db.update(driverLinkInvites).set({ usedAt: at, usedLineUserId: sub }).where(eq(driverLinkInvites.code, linkCode));
    return { ok: true, session: makeSession(invite.driverId, lineUser ? 'line' : 'demo'), linked: true };
  }

  if (lineUser) {
    const [driver] = await db.select().from(drivers).where(eq(drivers.lineUserId, lineUser.sub)).limit(1);
    if (!driver) return { ok: false, error: 'not_linked', lineName: lineUser.name };
    if (driver.lineName !== lineUser.name || driver.linePicture !== lineUser.picture) {
      await db.update(drivers).set({ lineName: lineUser.name, linePicture: lineUser.picture, updatedAt: nowIso() }).where(eq(drivers.id, driver.id));
    }
    return { ok: true, session: makeSession(driver.id, 'line') };
  }

  const code = text(body.r, 20).toUpperCase();
  if (code) {
    const [req] = await db.select().from(locationRequests).where(eq(locationRequests.code, code)).limit(1);
    if (!req) return { ok: false, error: 'link_invalid' };
    // ลิงก์ใช้เปิดดูงานได้ 24 ชั่วโมงหลังส่ง (ส่งพิกัดได้ภายในอายุคำขอเท่านั้น)
    if (Date.now() - Date.parse(req.requestedAt) > 24 * 3600_000) return { ok: false, error: 'link_expired' };
    if (req.channel === 'line' && mode === 'live') return { ok: false, error: 'open_in_line' };
    return { ok: true, session: makeSession(req.driverId, req.channel === 'demo' ? 'demo' : 'code'), requestId: req.id };
  }
  return { ok: false, error: mode === 'live' ? 'open_in_line' : 'no_credentials' };
}

// ---------------- คนขับ: งานของฉัน ----------------

export async function driverHome(body: ApiBody): Promise<ApiResult> {
  const driver = await driverFromSession(body);
  if (!driver) return { ok: false, error: 'session_expired' };
  const today = ymd();
  // ปกติแสดงงาน 2 วันก่อนถึง 14 วันข้างหน้า — ระบุวันที่ได้ (ยังเห็นเฉพาะงานของตัวเอง)
  const only = validYmd(body.date) ? String(body.date) : '';
  const stepRows = await db.select().from(jobSteps)
    .where(and(eq(jobSteps.driverId, driver.id), gte(jobSteps.inspectDate, only || shiftDate(today, -2)), lte(jobSteps.inspectDate, only || shiftDate(today, 14))));
  const ids = stepRows.map((s) => s.itemId);
  const items = ids.length ? await db.select().from(jobPlanItems).where(inArray(jobPlanItems.id, ids)) : [];
  const plans = items.length ? await db.select().from(jobPlans).where(inArray(jobPlans.inspectDate, [...new Set(items.map((i) => i.inspectDate))])) : [];
  const confirmedDates = new Set(plans.filter((p) => p.status === 'confirmed').map((p) => p.inspectDate));
  const visible = items.filter((i) => confirmedDates.has(i.inspectDate) && stepRows.find((s) => s.itemId === i.id)?.username.toLowerCase() === String(i.username).toLowerCase());
  const evidence = visible.length ? await db.select().from(evidenceFiles).where(inArray(evidenceFiles.itemId, visible.map((i) => i.id))) : [];

  // ประตู EIR ของแต่ละชุดงาน (ชิปปิ้ง + วันที่) ที่คนขับมีตู้อยู่
  const batches = [...new Set(visible.map((i) => `${i.inspectDate}|${String(i.username)}`))];
  const gates: Record<string, boolean> = {};
  for (const key of batches) {
    const [date, username] = key.split('|');
    const all = await db.select({ status: jobSteps.xrayStatus }).from(jobSteps)
      .where(and(eq(jobSteps.inspectDate, date), eq(jobSteps.username, username)));
    gates[key] = all.length > 0 && all.every((s) => s.status === 'passed');
  }
  const requests = await db.select().from(locationRequests)
    .where(and(eq(locationRequests.driverId, driver.id), gte(locationRequests.inspectDate, only || shiftDate(today, -2))))
    .orderBy(desc(locationRequests.requestedAt)).limit(20);
  const now = Date.now();
  const active = requests.filter((r) => Date.parse(r.expiresAt) > now && r.status !== 'received').map((r) => ({
    id: r.id, phase: r.phase, inspectDate: r.inspectDate, expiresAt: r.expiresAt, itemIds: JSON.parse(r.itemIdsJson || '[]') }));

  const { meetings: meetingsTable } = await import('@/db/schema');
  const myMeetings = await db.select().from(meetingsTable).where(and(eq(meetingsTable.driverId, driver.id),
    gte(meetingsTable.inspectDate, only || shiftDate(today, -2)), inArray(meetingsTable.status, ['PROPOSED', 'ACCEPTED', 'RESCHEDULE_REQUESTED'])))
    .orderBy(asc(meetingsTable.scheduledAt));
  const { driverHelp } = await import('./coord-meet');
  return {
    ok: true, today, driver: { id: driver.id, name: driver.name, plate: driver.plate, lineName: driver.lineName, linked: Boolean(driver.lineUserId) },
    meetings: myMeetings.map((m) => ({ id: m.id, phase: m.phase, mode: m.mode, label: m.label, lat: m.latitude, lng: m.longitude,
      scheduledAt: m.scheduledAt, status: m.status, note: m.note, inspectDate: m.inspectDate, itemIds: JSON.parse(m.itemIdsJson || '[]') })),
    help: await driverHelp(driver.id),
    lineMode: lineMode(), liffId: lineMode() === 'live' ? env.liffId : '',
    requests: active,
    jobs: visible.sort((a, b) => a.inspectDate.localeCompare(b.inspectDate) || a.seq - b.seq).map((i) => {
      const s = stepRows.find((x) => x.itemId === i.id)!;
      const ev = evidence.filter((e) => e.itemId === i.id);
      return {
        id: i.id, inspectDate: i.inspectDate, bl: i.bl, containerNo: i.containerNo, port: i.port, destination: i.destination,
        stage: stageOf(s), cardHandedAt: s.cardHandedAt, cardAckAt: s.cardAckAt, pickedUpAt: s.pickedUpAt, xrayStatus: s.xrayStatus,
        xrayAt: s.xrayAt, eirHandedAt: s.eirHandedAt, eirReceivedAt: s.eirReceivedAt, completedAt: s.completedAt,
        eirGateOpen: gates[`${i.inspectDate}|${String(i.username)}`] || false,
        evidence: ev.map((e) => ({ id: e.id, kind: e.kind, url: e.url }))
      };
    })
  };
}

/** แถวงานของคนขับคนนี้เท่านั้น — เดาเลข itemId ของคนอื่นไม่ได้ */
async function ownStep(driverId: string, itemId: string) {
  const [s] = await db.select().from(jobSteps).where(and(eq(jobSteps.itemId, itemId), eq(jobSteps.driverId, driverId))).limit(1);
  return s || null;
}

export async function driverReportLocation(body: ApiBody): Promise<ApiResult> {
  const driver = await driverFromSession(body);
  if (!driver) return { ok: false, error: 'session_expired' };
  const [req] = await db.select().from(locationRequests).where(eq(locationRequests.id, text(body.requestId, 60))).limit(1);
  if (!req || req.driverId !== driver.id) return { ok: false, error: 'not_found' };
  if (Date.parse(req.expiresAt) < Date.now()) return { ok: false, error: 'request_expired' };
  const at = nowIso();
  if (body.denied === true) {
    if (req.status !== 'received') await db.update(locationRequests).set({ status: 'denied', respondedAt: at }).where(eq(locationRequests.id, req.id));
    return { ok: true };
  }
  const lat = Number(body.lat), lng = Number(body.lng);
  if (!(Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) || (!lat && !lng)) {
    return { ok: false, error: 'bad_location' };
  }
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(locationReports).where(eq(locationReports.requestId, req.id));
  if (n >= 20) return { ok: false, error: 'too_many' };
  await db.insert(locationReports).values({
    id: id('lp_'), requestId: req.id, driverId: driver.id, phase: req.phase, latitude: lat, longitude: lng,
    accuracyM: Math.max(0, Math.min(100000, Number(body.accuracy) || 0)),
    capturedAt: text(body.capturedAt, 40) || at, receivedAt: at, userAgent: text(body._ua, 300)
  });
  await db.update(locationRequests).set({ status: 'received', respondedAt: at }).where(eq(locationRequests.id, req.id));
  const itemIds: string[] = JSON.parse(req.itemIdsJson || '[]');
  await logEvents(itemIds.map((itemId) => ({ itemId, inspectDate: req.inspectDate, username: String(req.username) })), 'driver', driver.id,
    `LOCATION_${req.phase}_RECEIVED`, { requestId: req.id, accuracy: Number(body.accuracy) || 0 });
  // แจ้งชิปปิ้ง: ทุกคนในรอบนี้ (ที่ยังไม่หมดอายุ) ส่งพิกัดครบ = สำคัญ / รายคน = ทุกความเคลื่อนไหว
  const round = await db.select({ status: locationRequests.status, driverId: locationRequests.driverId }).from(locationRequests)
    .where(and(eq(locationRequests.inspectDate, req.inspectDate), eq(locationRequests.username, String(req.username)), eq(locationRequests.phase, req.phase)));
  const drv = [...new Set(round.map((r) => r.driverId))];
  const got = drv.filter((d) => round.some((r) => r.driverId === d && r.status === 'received')).length;
  const phaseText = req.phase === 'CARD_PICKUP' ? 'รอบแรก (การ์ดรับตู้)' : 'รอบสอง (EIR)';
  const url = staffUrl(String(body._origin || ''), `date=${req.inspectDate}&tab=map&phase=${req.phase}`);
  if (got === drv.length) {
    await notifyStaff({ username: String(req.username), level: 'important', ref: `loc-all:${req.inspectDate}:${req.phase}:${got}`,
      title: `📍 ได้พิกัด${phaseText} ครบ ${got}/${drv.length} คน`, lines: [`งานวันที่ ${thShortDate(req.inspectDate)}`, 'เปิดแผนที่เพื่อนัดหมายได้เลย'], url, button: 'เปิดแผนที่' });
  } else {
    await notifyStaff({ username: String(req.username), level: 'all', ref: `loc:${req.id}:${at}`,
      title: `📍 ${driver.name} ส่งพิกัด${phaseText} แล้ว`, lines: [`ได้พิกัดแล้ว ${got}/${drv.length} คน`], url, button: 'เปิดแผนที่' });
  }
  return { ok: true, receivedAt: at };
}

/**
 * ปุ่มสถานะของคนขับ (ทีละตู้) — ต้องเป็นตามลำดับ
 *   card-ack: รับการ์ดแล้ว (ชิปปิ้งลืมบันทึกก็ยังเดินงานต่อได้)
 *   picked-up: รับตู้แล้ว (ต้องได้การ์ดก่อน)
 *   xray: waiting | hold | passed (ต้องรับตู้ก่อน) — เป็น "คนขับรายงาน" ไม่ใช่ผลรับรองจากเครื่อง
 *   eir-received: ได้รับ EIR แล้ว (ทุกตู้ในชุดผ่าน X-Ray แล้วเท่านั้น)
 */
export async function driverStep(body: ApiBody): Promise<ApiResult> {
  const driver = await driverFromSession(body);
  if (!driver) return { ok: false, error: 'session_expired' };
  const s = await ownStep(driver.id, text(body.itemId, 60));
  if (!s) return { ok: false, error: 'forbidden' };
  const at = nowIso();
  const op = String(body.op || '');
  let patch: Partial<StepRow> | null = null, event = '';
  if (op === 'card-ack') {
    if (s.cardAckAt) return { ok: true };
    patch = { cardAckAt: at }; event = 'PICKUP_CARD_ACKNOWLEDGED';
  } else if (op === 'picked-up') {
    if (!s.cardHandedAt && !s.cardAckAt) return { ok: false, error: 'card_first' };
    if (s.pickedUpAt) return { ok: true };
    patch = { pickedUpAt: at }; event = 'CONTAINER_PICKED_UP_REPORTED';
  } else if (op === 'xray') {
    if (!s.pickedUpAt) return { ok: false, error: 'pickup_first' };
    const status = ['waiting', 'hold', 'passed'].includes(String(body.status)) ? String(body.status) : '';
    if (!status) return { ok: false, error: 'bad_request' };
    if (s.xrayStatus === 'passed') return { ok: true };
    patch = { xrayStatus: status, xrayAt: at, xrayNote: text(body.note, 300) };
    event = status === 'passed' ? 'XRAY_PASSED_REPORTED' : (status === 'hold' ? 'XRAY_HOLD_REPORTED' : 'XRAY_WAITING_REPORTED');
  } else if (op === 'eir-received') {
    if (s.xrayStatus !== 'passed') return { ok: false, error: 'xray_first' };
    const batch = await db.select({ status: jobSteps.xrayStatus }).from(jobSteps)
      .where(and(eq(jobSteps.inspectDate, s.inspectDate), eq(jobSteps.username, String(s.username))));
    if (!batch.every((b) => b.status === 'passed')) return { ok: false, error: 'XRAY_BATCH_NOT_READY' };
    if (s.eirReceivedAt) return { ok: true };
    patch = { eirReceivedAt: at }; event = 'EIR_DRIVER_RECEIVED';
  } else if (op === 'problem') {
    patch = { problem: text(body.note, 300) }; event = 'PROBLEM_REPORTED';
  } else return { ok: false, error: 'bad_request' };

  await db.update(jobSteps).set({ ...patch, updatedAt: at, version: s.version + 1 }).where(eq(jobSteps.itemId, s.itemId));
  await logEvents([{ itemId: s.itemId, inspectDate: s.inspectDate, username: String(s.username) }], 'driver', driver.id, event,
    op === 'xray' || op === 'problem' ? { note: text(body.note, 300) } : {});

  const staff = String(s.username), origin = String(body._origin || '');
  const cn = await containerOf(s.itemId);
  if (op === 'xray' && body.status === 'passed') {
    const p = await batchProgress(s.inspectDate, staff);
    if (p.xray === p.total) {
      await notifyStaff({ username: staff, level: 'important', ref: `xray-all:${s.inspectDate}`, title: `✅ ผ่าน X-Ray ครบ ${p.total}/${p.total} ตู้`,
        lines: [`งานวันที่ ${thShortDate(s.inspectDate)}`, 'ขอตำแหน่งรอบสองเพื่อนัดส่งมอบ EIR ได้แล้ว'],
        url: staffUrl(origin, `date=${s.inspectDate}&tab=map&phase=EIR_HANDOVER`), button: 'ขอตำแหน่งรอบสอง' });
    } else {
      await notifyStaff({ username: staff, level: 'all', ref: `xray:${s.itemId}`, title: `🛃 ${cn} ผ่าน X-Ray`,
        lines: [`คนขับ ${driver.name}`, `ผ่านแล้ว ${p.xray}/${p.total} ตู้`], url: staffUrl(origin, `date=${s.inspectDate}&tab=status`) });
    }
  } else if ((op === 'xray' && body.status === 'hold') || op === 'problem') {
    await notifyStaff({ username: staff, level: 'important', ref: `problem:${s.itemId}:${at}`, title: `⚠️ ${cn} แจ้งปัญหา`,
      lines: [`คนขับ ${driver.name}`, text(body.note, 200) || (op === 'xray' ? 'ติดปัญหา X-Ray' : '-')], url: staffUrl(origin, `date=${s.inspectDate}&tab=status`) });
  } else if (op === 'eir-received') {
    const p = await batchProgress(s.inspectDate, staff);
    await notifyStaff({ username: staff, level: 'all', ref: `eir:${s.itemId}`, title: `📄 ${driver.name} ยืนยันรับ EIR ${cn}`,
      lines: [`รับ EIR แล้ว ${p.eirReceived}/${p.total} ตู้`], url: staffUrl(origin, `date=${s.inspectDate}&tab=status`) });
  }
  return { ok: true, at };
}

// ---------------- คนขับ: รูปปิดงาน + ยืนยันจบงาน ----------------

const isKind = (v: unknown): v is EvidenceKind => EVIDENCE_KINDS.includes(String(v) as EvidenceKind);

export async function driverEvidenceSign(body: ApiBody): Promise<ApiResult> {
  const driver = await driverFromSession(body);
  if (!driver) return { ok: false, error: 'session_expired' };
  const s = await ownStep(driver.id, text(body.itemId, 60));
  if (!s) return { ok: false, error: 'forbidden' };
  if (!isKind(body.kind)) return { ok: false, error: 'bad_request' };
  if (s.completedAt) return { ok: false, error: 'already_completed' };
  const up = await createSignedUpload('evidence', `${s.itemId}-${body.kind === 'EIR_CARD_PHOTO' ? 'eir' : 'seal'}-${randomCode(8).toLowerCase()}`, 'jpg');
  return { ok: true, key: up.key, uploadUrl: up.uploadUrl };
}

export async function driverEvidenceCommit(body: ApiBody): Promise<ApiResult> {
  const driver = await driverFromSession(body);
  if (!driver) return { ok: false, error: 'session_expired' };
  const s = await ownStep(driver.id, text(body.itemId, 60));
  if (!s) return { ok: false, error: 'forbidden' };
  if (!isKind(body.kind)) return { ok: false, error: 'bad_request' };
  if (s.completedAt) return { ok: false, error: 'already_completed' };
  const key = text(body.key, 200);
  const tag = body.kind === 'EIR_CARD_PHOTO' ? 'eir' : 'seal';
  // key ต้องเป็นของตู้นี้และชนิดนี้ (ออกโดย driverEvidenceSign) — กันเอารูปตู้อื่นมาใช้
  if (!new RegExp(`^evidence/${s.itemId}-${tag}-[a-z0-9]{8}\\.jpg$`).test(key)) return { ok: false, error: 'bad_key' };
  if (!(await fileExists(key))) return { ok: false, error: 'upload_missing' };
  const size = Math.round(Number(body.size) || 0);
  if (size > 10 * 1024 * 1024) return { ok: false, error: 'file_too_large' };
  await db.insert(evidenceFiles).values({
    id: id('ev_'), itemId: s.itemId, driverId: driver.id, inspectDate: s.inspectDate, kind: body.kind,
    storageKey: key, url: `/files/${key}`, size, createdAt: nowIso()
  }).onConflictDoNothing();
  return { ok: true };
}

export async function driverEvidenceDelete(body: ApiBody): Promise<ApiResult> {
  const driver = await driverFromSession(body);
  if (!driver) return { ok: false, error: 'session_expired' };
  const [ev] = await db.select().from(evidenceFiles).where(eq(evidenceFiles.id, text(body.id, 60))).limit(1);
  if (!ev || ev.driverId !== driver.id) return { ok: false, error: 'forbidden' };
  const s = await ownStep(driver.id, ev.itemId);
  if (!s || s.completedAt) return { ok: false, error: 'already_completed' };
  await db.delete(evidenceFiles).where(eq(evidenceFiles.id, ev.id));
  return { ok: true };
}

/** ตรวจปล่อยเสร็จแล้ว — ต้องได้รับ EIR และมีรูปการ์ด EIR + รูป Seal ของตู้นี้ครบ แล้วจบงานทันที (ไม่ต้องรอตรวจ) */
export async function driverComplete(body: ApiBody): Promise<ApiResult> {
  const driver = await driverFromSession(body);
  if (!driver) return { ok: false, error: 'session_expired' };
  const s = await ownStep(driver.id, text(body.itemId, 60));
  if (!s) return { ok: false, error: 'forbidden' };
  if (s.completedAt) return { ok: true, at: s.completedAt };
  if (!s.eirReceivedAt) return { ok: false, error: 'eir_first' };
  const files = await db.select({ kind: evidenceFiles.kind }).from(evidenceFiles).where(eq(evidenceFiles.itemId, s.itemId));
  const missing = EVIDENCE_KINDS.filter((k) => !files.some((f) => f.kind === k));
  if (missing.length) return { ok: false, error: 'photos_required', missing };
  const at = nowIso();
  await db.update(jobSteps).set({ completedAt: at, updatedAt: at, version: s.version + 1 }).where(eq(jobSteps.itemId, s.itemId));
  await logEvents([{ itemId: s.itemId, inspectDate: s.inspectDate, username: String(s.username) }], 'driver', driver.id,
    'DRIVER_RELEASE_COMPLETION_SUBMITTED', { photos: files.length });
  const p = await batchProgress(s.inspectDate, String(s.username));
  const url = staffUrl(String(body._origin || ''), `date=${s.inspectDate}&tab=status`);
  const cn = await containerOf(s.itemId);
  if (p.completed === p.total) {
    await notifyStaff({ username: String(s.username), level: 'important', ref: `done-all:${s.inspectDate}`, title: `🎉 จบงานครบ ${p.total}/${p.total} ตู้`,
      lines: [`งานวันที่ ${thShortDate(s.inspectDate)}`, 'คนขับส่งรูปการ์ด EIR + Seal ครบทุกตู้แล้ว'], url });
  } else {
    await notifyStaff({ username: String(s.username), level: 'all', ref: `done:${s.itemId}`, title: `📷 ${cn} ส่งรูปจบงานแล้ว`,
      lines: [`คนขับ ${driver.name}`, `จบงานแล้ว ${p.completed}/${p.total} ตู้`], url });
  }
  return { ok: true, at };
}

/** ประวัติเหตุการณ์ของตู้ (ชิปปิ้งเจ้าของงาน / ผู้จัดการ) */
export async function coordTimeline(body: ApiBody, user: Staff): Promise<ApiResult> {
  const [s] = await db.select().from(jobSteps).where(eq(jobSteps.itemId, text(body.itemId, 60))).limit(1);
  if (!s) return { ok: false, error: 'not_found' };
  if (user.role === 'employee-shipping' && String(s.username).toLowerCase() !== user.username.toLowerCase()) return { ok: false, error: 'forbidden' };
  const rows = await db.select().from(jobEvents).where(eq(jobEvents.itemId, s.itemId)).orderBy(asc(jobEvents.createdAt));
  return { ok: true, rows: rows.map((r) => ({ ...r, meta: JSON.parse(r.metaJson || '{}') })) };
}

/** คนขับกดรับนัด / ขอเลื่อน */
export async function driverMeeting(body: ApiBody): Promise<ApiResult> {
  const driver = await driverFromSession(body);
  if (!driver) return { ok: false, error: 'session_expired' };
  const { driverMeetingRespond } = await import('./coord-meet');
  return driverMeetingRespond(body, driver.id, driver.name);
}
