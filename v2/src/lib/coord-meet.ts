import crypto from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  appOptions, drivers, jobPlanItems, locationReports, locationRequests, meetingPoints, meetings, routeRuns, users
} from '@/db/schema';
import { loadBatch, logEvents, staffScope, xrayGate, type Phase } from './coord';
import {
  driverUrl, flexMessage, installRichMenus, lineMode, linkUserRichMenu, notifyStaff, pushToDriver, staffUrl, verifyLineIdToken
} from './coord-line';
import { env } from './env';
import { sendPlainSms, smsConfig, thShortDate } from './sms';
import type { ApiBody, ApiResult } from './types';
import { id, nowIso, validYmd } from './utils';

/**
 * ขั้นที่ 2 ของงานประสานคนขับ
 *   - นัดหมายแจกการ์ด / ส่งมอบ EIR (ใครเดินทางหาใคร + จุด + เวลา) ส่งการ์ดนัดทาง LINE ให้คนขับกดรับนัด
 *   - ชิปปิ้งผูก LINE ของตัวเอง → ได้แจ้งเตือน + Rich Menu "งานชิปปิ้ง"
 *   - Rich Menu ของ OA (คนขับ / ชิปปิ้ง)
 *   - วางเส้นทางแจก EIR / การ์ด: ลดเวลารวมของชิปปิ้ง + คนขับ (heuristic → สถานะ FEASIBLE ไม่อ้างว่าดีที่สุด)
 */

type Staff = { username: string; name: string; role: string };
const ACTIVE = ['PROPOSED', 'ACCEPTED', 'RESCHEDULE_REQUESTED'];
const SERVICE_MIN: Record<Phase, number> = { CARD_PICKUP: 5, EIR_HANDOVER: 4 };
const text = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);
const hm = (iso: string) => new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
const mapsLink = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** พิกัดล่าสุดของคนขับในรอบนี้ (ต้องเป็นรอบเดียวกันเท่านั้น) */
async function latestLocations(date: string, username: string, phase: Phase) {
  const reqs = await db.select({ id: locationRequests.id }).from(locationRequests)
    .where(and(eq(locationRequests.inspectDate, date), eq(locationRequests.username, username), eq(locationRequests.phase, phase)));
  if (!reqs.length) return new Map<string, { lat: number; lng: number; at: string; accuracy: number }>();
  const reps = await db.select().from(locationReports).where(inArray(locationReports.requestId, reqs.map((r) => r.id)))
    .orderBy(desc(locationReports.receivedAt));
  const out = new Map<string, { lat: number; lng: number; at: string; accuracy: number }>();
  for (const r of reps) if (!out.has(r.driverId)) out.set(r.driverId, { lat: r.latitude, lng: r.longitude, at: r.receivedAt, accuracy: r.accuracyM });
  return out;
}

const handed = (phase: Phase, s: any) => phase === 'CARD_PICKUP' ? Boolean(s?.cardHandedAt || s?.cardAckAt) : Boolean(s?.eirHandedAt);

// ---------------- นัดหมาย ----------------

type MeetingInput = {
  date: string; phase: Phase; driverId: string; mode: 'STAFF_TO_DRIVER' | 'DRIVER_TO_STAFF';
  meetingPointId?: string; lat?: number; lng?: number; label?: string; scheduledAt: string; itemIds?: string[];
  note?: string; replace?: boolean; seq?: number; routeRunId?: string; origin: string;
};

async function createMeeting(m: MeetingInput, user: Staff, username: string, batch?: Awaited<ReturnType<typeof loadBatch>>) {
  const b = batch || await loadBatch(m.date, username);
  if (!b.confirmed || !b.items.length) return { ok: false, error: 'plan_not_confirmed' };
  if (m.phase === 'EIR_HANDOVER' && !xrayGate(b.items, b.steps, b.drivers).ready) return { ok: false, error: 'XRAY_BATCH_NOT_READY' };
  const driver = b.drivers.get(m.driverId);
  if (!driver) return { ok: false, error: 'not_found' };
  const own = b.items.filter((i) => b.steps.get(i.id)?.driverId === driver.id);
  const ids = (m.itemIds?.length ? own.filter((i) => m.itemIds!.includes(i.id)) : own.filter((i) => !handed(m.phase, b.steps.get(i.id))));
  if (!ids.length) return { ok: false, error: 'no_items' };
  const when = Date.parse(m.scheduledAt);
  if (!Number.isFinite(when)) return { ok: false, error: 'bad_time' };

  // จุดนัด: จุดที่ผู้จัดการปักไว้ / ตำแหน่งคนขับ (ชิปปิ้งไปหา) / พิกัดที่ระบุ
  let lat = Number(m.lat), lng = Number(m.lng), label = text(m.label, 120), pointId = '';
  if (m.meetingPointId) {
    const [p] = await db.select().from(meetingPoints).where(eq(meetingPoints.id, m.meetingPointId)).limit(1);
    if (!p || !p.active) return { ok: false, error: 'point_not_found' };
    lat = p.latitude; lng = p.longitude; label = p.name + (p.port ? ` (${p.port})` : ''); pointId = p.id;
  } else if (!(Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng))) {
    const loc = (await latestLocations(m.date, username, m.phase)).get(driver.id);
    if (!loc) return { ok: false, error: 'no_location' };
    lat = loc.lat; lng = loc.lng; label = label || 'ตำแหน่งที่คนขับส่งมา';
  }

  // คนขับมีนัดรอบนี้ค้างอยู่: นัดที่คนขับรับแล้วห้ามเปลี่ยนเงียบ ๆ ต้องยืนยัน replace (แล้วแจ้งคนขับ)
  const existing = await db.select().from(meetings).where(and(eq(meetings.inspectDate, m.date), eq(meetings.driverId, driver.id),
    eq(meetings.phase, m.phase), inArray(meetings.status, ACTIVE)));
  if (existing.some((e) => e.status === 'ACCEPTED') && !m.replace) return { ok: false, error: 'meeting_confirmed_exists', driver: driver.name };

  // ชิปปิ้งอยู่สองที่ในเวลาเดียวกันไม่ได้ (เฉพาะนัดที่ชิปปิ้งเดินทางไปหา คนละจุด)
  if (m.mode === 'STAFF_TO_DRIVER') {
    const mine = await db.select().from(meetings).where(and(eq(meetings.inspectDate, m.date), eq(meetings.username, username),
      inArray(meetings.status, ACTIVE)));
    const clash = mine.find((x) => x.driverId !== driver.id && Math.abs(Date.parse(x.scheduledAt) - when) < SERVICE_MIN[m.phase] * 60000
      && x.latitude != null && haversine({ lat, lng }, { lat: x.latitude, lng: x.longitude! }) > 80);
    if (clash) return { ok: false, error: 'staff_overlap', at: clash.scheduledAt, label: clash.label };
  }

  const at = nowIso();
  if (existing.length) {
    await db.update(meetings).set({ status: 'CANCELLED', updatedAt: at }).where(inArray(meetings.id, existing.map((e) => e.id)));
  }
  const row = {
    id: id('mt_'), inspectDate: m.date, username, driverId: driver.id, phase: m.phase, mode: m.mode, meetingPointId: pointId,
    label, latitude: lat, longitude: lng, scheduledAt: new Date(when).toISOString(), seq: m.seq || 0, status: 'PROPOSED',
    itemIdsJson: JSON.stringify(ids.map((i) => i.id)), note: text(m.note, 300), routeRunId: m.routeRunId || '',
    createdBy: user.username, createdAt: at, updatedAt: at
  };
  await db.insert(meetings).values(row);
  await logEvents(ids.map((i) => ({ itemId: i.id, inspectDate: m.date, username })), 'staff', user.username,
    m.phase === 'CARD_PICKUP' ? 'CARD_MEETING_PROPOSED' : 'EIR_MEETING_PROPOSED', { meetingId: row.id, mode: m.mode, at: row.scheduledAt, label });

  // ส่งการ์ดนัดหาคนขับ — LINE เป็นหลัก ยังไม่ผูก LINE ใช้ SMS สำรอง
  const cnt = ids.map((i) => i.containerNo || i.bl).join(', ');
  const title = m.phase === 'CARD_PICKUP' ? '🎫 นัดรับการ์ดรับตู้' : '📄 นัดรับ EIR ขาออก';
  const how = m.mode === 'STAFF_TO_DRIVER' ? 'ชิปปิ้งจะไปหาคุณที่ตำแหน่งนี้' : 'กรุณาไปที่จุดนัด';
  const live = lineMode() === 'live' && driver.lineUserId && !driver.lineUserId.startsWith('DEMO-');
  const link = driverUrl(m.origin, `m=${row.id}`, Boolean(live));
  let sent = 'none';
  if (driver.lineUserId) {
    const r = await pushToDriver({ lineUserId: driver.lineUserId, driverId: driver.id, kind: `MEETING_${m.phase}`, ref: row.id,
      messages: [flexMessage(`${title} ${hm(row.scheduledAt)} น.`, title, [
        `เวลา ${hm(row.scheduledAt)} น. • ${thShortDate(m.date)}`, `จุดนัด: ${label}`, how, `ตู้: ${cnt}`,
        ...(row.note ? [`หมายเหตุ: ${row.note}`] : [])],
      [{ label: 'รับทราบนัด', uri: link, primary: true }, { label: 'เปิดแผนที่นำทาง', uri: mapsLink(lat, lng) }])] });
    sent = r.state;
  } else if (smsConfig().ready) {
    const r = await sendPlainSms(driver.phone, `SHIPME ${title.replace(/^\S+\s/, '')} ${hm(row.scheduledAt)} น. ที่ ${label} ${how} ${mapsLink(lat, lng)}`);
    sent = r.ok ? 'sms' : 'failed';
  }
  return { ok: true, meeting: row, sent };
}

export async function coordMeetingCreate(body: ApiBody, user: Staff): Promise<ApiResult> {
  const date = String(body.date || '');
  if (!validYmd(date)) return { ok: false, error: 'bad_date' };
  return createMeeting({
    date, phase: body.phase === 'EIR_HANDOVER' ? 'EIR_HANDOVER' : 'CARD_PICKUP', driverId: text(body.driverId, 60),
    mode: body.mode === 'DRIVER_TO_STAFF' ? 'DRIVER_TO_STAFF' : 'STAFF_TO_DRIVER', meetingPointId: text(body.meetingPointId, 60),
    lat: body.lat, lng: body.lng, label: body.label, scheduledAt: String(body.scheduledAt || ''),
    itemIds: Array.isArray(body.itemIds) ? body.itemIds.map(String) : undefined, note: body.note, replace: body.replace === true,
    origin: String(body._origin || '')
  }, user, staffScope(body, user));
}

export async function coordMeetingCancel(body: ApiBody, user: Staff): Promise<ApiResult> {
  const [m] = await db.select().from(meetings).where(eq(meetings.id, text(body.id, 60))).limit(1);
  if (!m) return { ok: false, error: 'not_found' };
  if (user.role === 'employee-shipping' && String(m.username).toLowerCase() !== user.username.toLowerCase()) return { ok: false, error: 'forbidden' };
  if (!ACTIVE.includes(m.status)) return { ok: true };
  await db.update(meetings).set({ status: 'CANCELLED', updatedAt: nowIso() }).where(eq(meetings.id, m.id));
  const [d] = await db.select().from(drivers).where(eq(drivers.id, m.driverId)).limit(1);
  if (d?.lineUserId) {
    await pushToDriver({ lineUserId: d.lineUserId, driverId: d.id, kind: 'MEETING_CANCELLED', ref: m.id, messages: [
      flexMessage('ยกเลิกนัดหมาย', '❌ ยกเลิกนัดหมาย', [`นัดเวลา ${hm(m.scheduledAt)} น. ที่ ${m.label} ถูกยกเลิก`, 'รอชิปปิ้งนัดใหม่'],
        [{ label: 'ดูงานของฉัน', uri: driverUrl(String(body._origin || ''), 'home=1', true), primary: true }])] });
  }
  return { ok: true };
}

/** คนขับกดรับนัด / ขอเลื่อน — ขอเลื่อนแจ้งชิปปิ้งทันที (สำคัญ) */
export async function driverMeetingRespond(body: ApiBody, driverId: string, driverName: string): Promise<ApiResult> {
  const [m] = await db.select().from(meetings).where(eq(meetings.id, text(body.meetingId, 60))).limit(1);
  if (!m || m.driverId !== driverId) return { ok: false, error: 'forbidden' };
  if (!ACTIVE.includes(m.status)) return { ok: false, error: 'meeting_closed' };
  const accept = body.accept === true, at = nowIso();
  await db.update(meetings).set({ status: accept ? 'ACCEPTED' : 'RESCHEDULE_REQUESTED', responseNote: text(body.note, 300), respondedAt: at, updatedAt: at })
    .where(eq(meetings.id, m.id));
  const ids: string[] = JSON.parse(m.itemIdsJson || '[]');
  await logEvents(ids.map((itemId) => ({ itemId, inspectDate: m.inspectDate, username: String(m.username) })), 'driver', driverId,
    accept ? 'MEETING_ACCEPTED' : 'MEETING_RESCHEDULE_REQUESTED', { meetingId: m.id, note: text(body.note, 300) });
  await notifyStaff({
    username: String(m.username), level: accept ? 'all' : 'important', ref: `meet:${m.id}:${at}`,
    title: accept ? `👍 ${driverName} รับนัด ${hm(m.scheduledAt)} น.` : `🔁 ${driverName} ขอเลื่อน/เปลี่ยนนัด`,
    lines: [`จุดนัด: ${m.label}`, ...(body.note ? [`ข้อความ: ${text(body.note, 200)}`] : [])],
    url: staffUrl(String(body._origin || ''), `date=${m.inspectDate}&tab=status`)
  });
  return { ok: true };
}

/** ส่งมอบครบทุกตู้ของนัด = นัดนั้นจบ (MET) — เรียกหลังชิปปิ้งบันทึกแจกการ์ด / EIR */
export async function closeMetMeetings(date: string, username: string, phase: Phase, steps: Map<string, any>) {
  const open = await db.select().from(meetings).where(and(eq(meetings.inspectDate, date), eq(meetings.username, username),
    eq(meetings.phase, phase), inArray(meetings.status, ACTIVE)));
  for (const m of open) {
    const ids: string[] = JSON.parse(m.itemIdsJson || '[]');
    if (ids.length && ids.every((i) => handed(phase, steps.get(i)))) {
      await db.update(meetings).set({ status: 'MET', updatedAt: nowIso() }).where(eq(meetings.id, m.id));
    }
  }
}

export async function meetingsFor(date: string, username: string) {
  return db.select().from(meetings).where(and(eq(meetings.inspectDate, date), eq(meetings.username, username)))
    .orderBy(asc(meetings.phase), asc(meetings.scheduledAt));
}

// ---------------- ชิปปิ้งผูก LINE ของตัวเอง ----------------

const secret = () => env.driverSessionSecret || crypto.createHash('sha256').update('staff-link:' + (process.env.DATABASE_URL || 'dev')).digest('hex');
const sign = (p: string) => crypto.createHmac('sha256', secret()).update(p).digest('base64url');

export async function coordStaffLineLink(body: ApiBody, user: Staff): Promise<ApiResult> {
  if (lineMode() !== 'live') return { ok: false, error: 'line_not_configured' };
  const payload = Buffer.from(JSON.stringify({ u: user.username, exp: Date.now() + 30 * 60000 })).toString('base64url');
  return { ok: true, link: driverUrl(String(body._origin || ''), `slink=${payload}.${sign(payload)}`, true), expiresInMinutes: 30 };
}

export async function staffLineRedeem(body: ApiBody): Promise<ApiResult> {
  const [payload, sig] = String(body.slink || '').split('.');
  if (!payload || !sig || sign(payload) !== sig) return { ok: false, error: 'invite_invalid' };
  let t: { u: string; exp: number };
  try { t = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { ok: false, error: 'invite_invalid' }; }
  if (!t.u || t.exp < Date.now()) return { ok: false, error: 'invite_invalid' };
  const v = await verifyLineIdToken(String(body.idToken || ''));
  if (!v.ok) return { ok: false, error: v.error };
  await db.update(users).set({ lineUserId: v.sub, lineName: v.name, updatedAt: nowIso() }).where(eq(users.username, t.u));
  const menus = await richMenuIds();
  if (menus.staffMenu) await linkUserRichMenu(v.sub, menus.staffMenu);
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.username, t.u)).limit(1);
  return { ok: true, staff: true, name: u?.name || t.u };
}

export async function coordStaffNotify(body: ApiBody, user: Staff): Promise<ApiResult> {
  const level = ['important', 'all', 'off'].includes(String(body.level)) ? String(body.level) : 'important';
  if (body.unlink === true) {
    await db.update(users).set({ lineUserId: '', lineName: '', updatedAt: nowIso() }).where(eq(users.username, user.username));
    return { ok: true };
  }
  await db.update(users).set({ lineNotify: level, updatedAt: nowIso() }).where(eq(users.username, user.username));
  return { ok: true, level };
}

export async function staffLineStatus(username: string) {
  const [u] = await db.select({ lineUserId: users.lineUserId, lineName: users.lineName, lineNotify: users.lineNotify }).from(users)
    .where(eq(users.username, username)).limit(1);
  return { linked: Boolean(u?.lineUserId), lineName: u?.lineName || '', notify: u?.lineNotify || 'important' };
}

// ---------------- Rich Menu ----------------

async function richMenuIds(): Promise<{ driverMenu?: string; staffMenu?: string }> {
  const [row] = await db.select().from(appOptions).where(eq(appOptions.key, 'lineRichMenus')).limit(1);
  try { return row ? JSON.parse(row.valueJson) : {}; } catch { return {}; }
}

export async function lineRichMenuInstall(body: ApiBody): Promise<ApiResult> {
  const origin = String(body._origin || '');
  const res = await installRichMenus({
    driverImage: String(body.driverImage || ''), staffImage: String(body.staffImage || ''),
    driverButtons: [
      { label: 'งานของฉัน', uri: driverUrl(origin, 'home=1', true) },
      { label: 'ส่งตำแหน่ง', uri: driverUrl(origin, 'loc=1', true) },
      { label: 'ช่วยเหลือ', uri: driverUrl(origin, 'help=1', true) }
    ],
    staffButtons: [
      { label: 'งานชิปปิ้ง', uri: staffUrl(origin, 'tab=plan') },
      { label: 'แผนที่', uri: staffUrl(origin, 'tab=map') },
      { label: 'สถานะงาน', uri: staffUrl(origin, 'tab=status') }
    ]
  });
  if (!res.ok) return res;
  const value = JSON.stringify({ driverMenu: res.driverMenu, staffMenu: res.staffMenu, installedAt: nowIso() });
  await db.insert(appOptions).values({ key: 'lineRichMenus', valueJson: value, updatedAt: nowIso() })
    .onConflictDoUpdate({ target: appOptions.key, set: { valueJson: value, updatedAt: nowIso() } });
  // ชิปปิ้งที่ผูก LINE ไว้แล้วได้เมนูชิปปิ้งทันที
  const staff = await db.select({ lineUserId: users.lineUserId }).from(users).where(sql`${users.lineUserId} <> ''`);
  let linked = 0;
  for (const s of staff) if (await linkUserRichMenu(s.lineUserId, res.staffMenu!)) linked++;
  return { ok: true, driverMenu: res.driverMenu, staffMenu: res.staffMenu, staffLinked: linked };
}

// ---------------- วางเส้นทาง ----------------

type Pt = { lat: number; lng: number };
type Matrix = (a: number, b: number) => number;

/** เวลาเดินทาง (วินาที) ระหว่างจุด — Google Routes API ถ้ามี key ไม่งั้นประมาณการจากระยะทาง (ติดป้ายชัดเจน) */
async function travelMatrix(points: Pt[], estimate: boolean): Promise<{ m: Matrix; source: 'GOOGLE_ROUTES_API' | 'ESTIMATE'; error?: string }> {
  const n = points.length;
  const est: Matrix = (a, b) => a === b ? 0 : Math.max(60, Math.round(haversine(points[a], points[b]) * 1.35 / (30 / 3.6)));
  if (estimate || !env.googleRoutesServerKey) return { m: est, source: 'ESTIMATE' };
  const grid: number[][] = Array.from({ length: n }, () => Array(n).fill(NaN));
  const wp = (p: Pt) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
  const chunk = Math.max(1, Math.floor(625 / n));     // origins × destinations ≤ 625 ต่อคำขอ
  try {
    for (let o = 0; o < n; o += chunk) {
      const origins = points.slice(o, o + chunk);
      const res = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.googleRoutesServerKey,
          'x-goog-fieldmask': 'originIndex,destinationIndex,duration,condition' },
        body: JSON.stringify({ origins: origins.map(wp), destinations: points.map(wp), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE' }),
        signal: AbortSignal.timeout(20000)
      });
      const data = await res.json().catch(() => null) as any;
      if (!res.ok || !Array.isArray(data)) return { m: est, source: 'GOOGLE_ROUTES_API', error: String(data?.error?.message || `HTTP ${res.status}`) };
      for (const e of data) {
        if (e.condition === 'ROUTE_EXISTS' && e.duration) grid[o + (e.originIndex || 0)][e.destinationIndex || 0] = parseInt(String(e.duration), 10);
      }
    }
  } catch (e) {
    return { m: est, source: 'GOOGLE_ROUTES_API', error: (e as Error)?.name === 'TimeoutError' ? 'Google Routes ไม่ตอบกลับ' : 'เชื่อมต่อ Google Routes ไม่ได้' };
  }
  return { m: (a, b) => a === b ? 0 : grid[a][b], source: 'GOOGLE_ROUTES_API' };
}

/** ลำดับจุด: เริ่มจากจุดใกล้สุดทีละจุด แล้วสลับคู่ (2-opt) จนลดเวลาไม่ได้อีก */
function sequence(stops: number[], m: Matrix) {
  const left = [...stops], order: number[] = [];
  let cur = 0;
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++) if (m(cur, left[i]) < m(cur, left[best])) best = i;
    cur = left.splice(best, 1)[0]; order.push(cur);
  }
  const cost = (o: number[]) => o.reduce((s, x, i) => s + m(i ? o[i - 1] : 0, x), 0);
  let improved = true, guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) for (let k = i + 1; k < order.length; k++) {
      const next = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
      if (cost(next) + 1 < cost(order)) { order.splice(0, order.length, ...next); improved = true; }
    }
  }
  return order;
}

export async function coordRoutePlan(body: ApiBody, user: Staff): Promise<ApiResult> {
  const date = String(body.date || '');
  if (!validYmd(date)) return { ok: false, error: 'bad_date' };
  const phase: Phase = body.phase === 'EIR_HANDOVER' ? 'EIR_HANDOVER' : 'CARD_PICKUP';
  const username = staffScope(body, user);
  const start = { lat: Number(body.start?.lat), lng: Number(body.start?.lng) };
  if (!(Math.abs(start.lat) <= 90 && Math.abs(start.lng) <= 180) || (!start.lat && !start.lng)) return { ok: false, error: 'start_required' };
  const policy = ['STAFF_TO_DRIVER', 'DRIVER_TO_STAFF'].includes(String(body.policy)) ? String(body.policy) : 'auto';
  const b = await loadBatch(date, username);
  if (!b.confirmed || !b.items.length) return { ok: false, error: 'plan_not_confirmed' };
  if (phase === 'EIR_HANDOVER' && !xrayGate(b.items, b.steps, b.drivers).ready) return { ok: false, error: 'XRAY_BATCH_NOT_READY' };

  const locs = await latestLocations(date, username, phase);
  const pending = [...b.drivers.values()].map((d) => ({ d, items: b.items.filter((i) => b.steps.get(i.id)?.driverId === d.id && !handed(phase, b.steps.get(i.id))) }))
    .filter((x) => x.items.length);
  const routable = pending.filter((x) => locs.has(x.d.id));
  const missing = pending.filter((x) => !locs.has(x.d.id)).map((x) => ({ driverId: x.d.id, name: x.d.name }));
  if (!routable.length) return { ok: false, error: 'no_locations', missing };
  const points = (await db.select().from(meetingPoints).where(and(eq(meetingPoints.active, true), eq(meetingPoints.kind, 'MEETING'))))
    .map((p) => ({ id: p.id, lat: p.latitude, lng: p.longitude, label: p.name + (p.port ? ` (${p.port})` : '') }));
  if (policy === 'DRIVER_TO_STAFF' && !points.length) return { ok: false, error: 'no_meeting_points' };

  // โหนด: 0 = จุดเริ่มของชิปปิ้ง, ตำแหน่งคนขับ, จุดนัดพบ
  const nodes: (Pt & { kind: string; ref: string; label: string })[] = [{ ...start, kind: 'start', ref: '', label: 'จุดเริ่ม' }];
  const driverNode = new Map<string, number>();
  for (const x of routable) { driverNode.set(x.d.id, nodes.length); nodes.push({ ...locs.get(x.d.id)!, kind: 'driver', ref: x.d.id, label: x.d.name }); }
  const pointNode = new Map<string, number>();
  for (const p of points) { pointNode.set(p.id, nodes.length); nodes.push({ lat: p.lat, lng: p.lng, kind: 'point', ref: p.id, label: p.label }); }

  let tm = await travelMatrix(nodes, body.allowEstimate === true);
  if (tm.error) {
    // มี key แต่เรียกไม่ได้ → ไม่เดาเวลาให้เอง ให้ชิปปิ้งเลือกใช้ค่าประมาณการเองถ้าต้องการ
    return { ok: false, error: 'routes_failed', detail: tm.error, missing };
  }
  const m = tm.m;
  const svc = SERVICE_MIN[phase] * 60;
  const nearestPoint = (dn: number) => points.length ? points.reduce((best, p) => m(dn, pointNode.get(p.id)!) < m(dn, pointNode.get(best.id)!) ? p : best, points[0]) : null;

  type Plan = { mode: Map<string, 'STAFF_TO_DRIVER' | 'DRIVER_TO_STAFF'> };
  const evaluate = (plan: Plan) => {
    // จุดจอด: คนขับที่ชิปปิ้งไปหา = ตำแหน่งคนขับ / คนขับที่มาหา = จุดนัดที่ใกล้คนขับที่สุด (หลายคนจุดเดียวกัน = จอดครั้งเดียว)
    const stops = new Map<number, string[]>();
    for (const x of routable) {
      const dn = driverNode.get(x.d.id)!;
      const node = plan.mode.get(x.d.id) === 'DRIVER_TO_STAFF' ? pointNode.get(nearestPoint(dn)!.id)! : dn;
      if (!Number.isFinite(m(0, node))) return null;
      stops.set(node, [...(stops.get(node) || []), x.d.id]);
    }
    const order = sequence([...stops.keys()], m);
    let t = 0, staffTravel = 0, staffWait = 0, driverTravel = 0, driverWait = 0, prev = 0;
    const out = [];
    for (const node of order) {
      const leg = m(prev, node);
      if (!Number.isFinite(leg)) return null;
      staffTravel += leg; t += leg;
      const ds = stops.get(node)!;
      // คนขับที่ต้องเดินทางมา: เวลาที่มาถึงจุดนัด (เริ่มออกตอนได้นัด)
      const arrivals = ds.map((d) => plan.mode.get(d) === 'DRIVER_TO_STAFF' ? m(driverNode.get(d)!, node) : 0);
      arrivals.forEach((a) => { driverTravel += a; });
      const meetAt = Math.max(t, ...arrivals);
      staffWait += meetAt - t;
      arrivals.forEach((a) => { driverWait += meetAt - a; });
      t = meetAt + svc * ds.length;
      out.push({ node, drivers: ds, eta: meetAt, legSec: leg });
      prev = node;
    }
    return { out, totals: { staffTravelSeconds: staffTravel, driverIncrementalTravelSeconds: driverTravel, staffWaitingSeconds: staffWait,
      driverWaitingSeconds: driverWait }, cost: staffTravel + driverTravel + staffWait + driverWait };
  };

  const plan: Plan = { mode: new Map(routable.map((x) => [x.d.id, policy === 'DRIVER_TO_STAFF' ? 'DRIVER_TO_STAFF' : 'STAFF_TO_DRIVER'] as const)) };
  let best = evaluate(plan);
  if (!best) return { ok: false, error: 'INFEASIBLE', missing };
  if (policy === 'auto' && points.length) {
    // ลองให้คนขับทีละคนเปลี่ยนเป็น "มาหาที่จุดนัด" ถ้าเวลารวมลดลงก็ใช้
    let changed = true, rounds = 0;
    while (changed && rounds++ < 5) {
      changed = false;
      for (const x of routable) {
        const was = plan.mode.get(x.d.id)!;
        plan.mode.set(x.d.id, was === 'STAFF_TO_DRIVER' ? 'DRIVER_TO_STAFF' : 'STAFF_TO_DRIVER');
        const trial = evaluate(plan);
        if (trial && trial.cost + 30 < best!.cost) { best = trial; changed = true; } else plan.mode.set(x.d.id, was);
      }
    }
  }

  const startAt = Date.parse(String(body.startAt || '')) || Date.now();
  const stops = best.out.map((s, i) => {
    const n = nodes[s.node];
    return {
      seq: i + 1, lat: n.lat, lng: n.lng, label: n.kind === 'point' ? n.label : `ตำแหน่ง ${n.label}`,
      meetingPointId: n.kind === 'point' ? n.ref : '', legSeconds: Math.round(s.legSec), eta: new Date(startAt + s.eta * 1000).toISOString(),
      drivers: s.drivers.map((d) => {
        const x = routable.find((r) => r.d.id === d)!;
        return { driverId: d, name: x.d.name, mode: plan.mode.get(d), itemIds: x.items.map((i) => i.id),
          containers: x.items.map((i) => i.containerNo || i.bl), travelSeconds: plan.mode.get(d) === 'DRIVER_TO_STAFF' ? Math.round(m(driverNode.get(d)!, s.node)) : 0 };
      })
    };
  });

  // เส้นทางจริงบนถนน — เฉพาะเมื่อได้ผลจาก Google Routes (ประมาณการไม่วาดเส้น)
  let polyline = '';
  if (tm.source === 'GOOGLE_ROUTES_API' && stops.length <= 26) {
    const wp = (p: Pt) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    try {
      const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.googleRoutesServerKey, 'x-goog-fieldmask': 'routes.polyline.encodedPolyline' },
        body: JSON.stringify({ origin: wp(start), destination: wp(stops.at(-1)!), intermediates: stops.slice(0, -1).map(wp), travelMode: 'DRIVE' }),
        signal: AbortSignal.timeout(15000)
      });
      const data = await res.json().catch(() => ({})) as any;
      polyline = String(data?.routes?.[0]?.polyline?.encodedPolyline || '');
    } catch { /* ไม่มีเส้นก็ยังใช้ลำดับได้ */ }
  }

  const result = {
    batchDate: date, phase, solverStatus: 'FEASIBLE', source: tm.source, calculatedAt: nowIso(), objectiveUnit: 'seconds',
    policy, start, startAt: new Date(startAt).toISOString(), totals: Object.fromEntries(Object.entries(best.totals).map(([k, v]) => [k, Math.round(v)])),
    stops, missing, polyline,
    warnings: tm.source === 'ESTIMATE' ? ['ESTIMATE_NOT_ACTUAL_ROUTE — เวลาประมาณจากระยะทางเส้นตรง ×1.35 ที่ 30 กม./ชม. ไม่ใช่ผลจาก Google Routes'] : []
  };
  const runId = id('rr_');
  await db.insert(routeRuns).values({ id: runId, inspectDate: date, username, phase, source: tm.source, status: 'FEASIBLE', resultJson: JSON.stringify(result), createdAt: nowIso() });
  return { ok: true, runId, ...result };
}

/** ยืนยันแผน → สร้างนัดตามลำดับและส่งการ์ดนัดทาง LINE (นัดที่คนขับรับแล้วไม่ทับ) */
export async function coordRouteConfirm(body: ApiBody, user: Staff): Promise<ApiResult> {
  const [run] = await db.select().from(routeRuns).where(eq(routeRuns.id, text(body.runId, 60))).limit(1);
  if (!run) return { ok: false, error: 'not_found' };
  const username = staffScope(body, user);
  if (String(run.username).toLowerCase() !== username.toLowerCase()) return { ok: false, error: 'forbidden' };
  if (run.confirmedAt) return { ok: false, error: 'already_confirmed' };
  if (Date.now() - Date.parse(run.createdAt) > 30 * 60000) return { ok: false, error: 'route_expired' };
  const r = JSON.parse(run.resultJson);
  const batch = await loadBatch(run.inspectDate, username);
  const made: any[] = [], skipped: any[] = [];
  for (const s of r.stops) for (const d of s.drivers) {
    const res = await createMeeting({
      date: run.inspectDate, phase: run.phase as Phase, driverId: d.driverId, mode: d.mode, meetingPointId: s.meetingPointId || undefined,
      lat: s.lat, lng: s.lng, label: s.label, scheduledAt: s.eta, itemIds: d.itemIds, seq: s.seq, routeRunId: run.id, origin: String(body._origin || '')
    }, user, username, batch);
    if (res.ok) made.push({ name: d.name, sent: res.sent }); else skipped.push({ name: d.name, error: res.error });
  }
  await db.update(routeRuns).set({ confirmedAt: nowIso() }).where(eq(routeRuns.id, run.id));
  return { ok: true, made, skipped };
}

/** ชื่อเต็ม/สถานะคนขับที่ใช้ในข้อความช่วยเหลือ */
export async function driverHelp(driverId: string) {
  const rows = await db.select({ username: jobPlanItems.username }).from(jobPlanItems)
    .innerJoin(sql`job_steps`, sql`job_steps.item_id = ${jobPlanItems.id}`)
    .where(sql`job_steps.driver_id = ${driverId} and ${jobPlanItems.inspectDate} >= to_char(now() at time zone 'Asia/Bangkok' - interval '2 day', 'YYYY-MM-DD')`);
  const names = [...new Set(rows.map((r) => String(r.username)))];
  const staff = names.length ? await db.select({ username: users.username, name: users.name }).from(users).where(inArray(users.username, names)) : [];
  return staff.map((s) => ({ name: s.name }));
}
