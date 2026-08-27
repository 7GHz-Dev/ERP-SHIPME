import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { checkins, geocodeCache } from '@/db/schema';
import { guard, login } from './auth';
import { env } from './env';
import { saveDataImage } from './storage';
import { checkinPolicy, id, isWindowsDevice, nowIso, ymd } from './utils';

export type ApiBody = Record<string, any>;
export type ApiResult = Record<string, any>;
type Handler = (body: ApiBody) => Promise<ApiResult>;

/**
 * หน้าเว็บทั้งระบบยิงมาที่ POST /api ปลายทางเดียว แล้วแยกด้วยฟิลด์ "action"
 * (โครงเดิมจากตอนเป็น Apps Script) — พอร์ตมาเป็น registry ตรง ๆ
 * ชื่อ action ต้องตรงกับของเดิมทุกตัว ไม่งั้น index.html / admin.html เรียกไม่เจอ
 */

async function reverseGeocode(latitude: number, longitude: number) {
  const point = `${Number(latitude).toFixed(4)},${Number(longitude).toFixed(4)}`;
  const [cached] = await db.select({ address: geocodeCache.address })
    .from(geocodeCache).where(eq(geocodeCache.point, point)).limit(1);
  if (cached) return cached.address;

  let address = `${Number(latitude).toFixed(6)}, ${Number(longitude).toFixed(6)}`;
  if (env.geocodeEndpoint) {
    try {
      const endpoint = new URL(env.geocodeEndpoint);
      endpoint.searchParams.set('lat', String(latitude));
      endpoint.searchParams.set('lon', String(longitude));
      const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(3500),
        headers: { accept: 'application/json' }
      });
      if (response.ok) {
        const payload = await response.json();
        address = String(payload.address || payload.display_name || address).slice(0, 500);
      }
    } catch { /* พิกัดดิบเป็น fallback ที่เชื่อถือได้และเร็ว */ }
  }

  await db.insert(geocodeCache).values({ point, address, updatedAt: nowIso() })
    .onConflictDoUpdate({ target: geocodeCache.point, set: { address, updatedAt: nowIso() } });
  return address;
}

type CheckinRow = typeof checkins.$inferSelect;
const checkinRecord = (row: CheckinRow | undefined | null) => row ? {
  id: row.id, time: row.serverTime, deviceTime: row.deviceTime,
  username: row.username, name: row.name, type: row.type,
  lat: row.latitude, lng: row.longitude, accuracy: row.accuracyM,
  address: row.address, mapLink: row.mapLink, photoUrl: row.photoUrl
} : null;

async function checkin(body: ApiBody): Promise<ApiResult> {
  const session = await guard(body);
  if (session.error) return session.error;
  const user = session.user;

  const policy = checkinPolicy(user.role);
  if (!policy.canCheckin) return { ok: false, error: 'checkin_not_allowed' };

  const windows = isWindowsDevice(body.userAgent);
  if (policy.device === 'windows' && !windows) return { ok: false, error: 'need_desktop' };
  if (policy.device === 'mobile' && windows) return { ok: false, error: 'need_mobile' };

  const latitude = Number(body.lat);
  const longitude = Number(body.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { ok: false, error: 'missing_location' };

  const accuracy = Number(body.accuracy) || 0;
  const limit = windows ? env.maxAccuracyDesktop : env.maxAccuracy;
  if (limit > 0 && accuracy > limit) return { ok: false, error: 'low_accuracy', accuracy, limit };

  const localDate = ymd();
  const [existing] = await db.select().from(checkins)
    .where(and(eq(checkins.username, user.username), eq(checkins.localDate, localDate))).limit(1);
  if (existing) return { ok: false, error: 'already_checked_in', record: checkinRecord(existing) };

  let photoUrl = '';
  let photoId = '';
  if (policy.photo) {
    if (!body.photo) return { ok: false, error: 'photo_required' };
    const saved = await saveDataImage(body.photo, 'checkins', `${user.username}_${localDate}`);
    photoUrl = saved.url;
    photoId = saved.id;
  }

  const address = await reverseGeocode(latitude, longitude);
  const row = {
    id: id('chk_'),
    serverTime: nowIso(),
    localDate,
    deviceTime: String(body.deviceTime || ''),
    username: user.username,
    name: user.name,
    type: String(body.type || 'in'),
    latitude,
    longitude,
    accuracyM: accuracy,
    address,
    mapLink: `https://www.google.com/maps?q=${latitude},${longitude}`,
    photoUrl,
    photoId
  };

  try {
    await db.insert(checkins).values(row);
  } catch (error) {
    // ชน unique (username, local_date) = กดพร้อมกันสองเครื่อง ให้ถือว่าเช็กอินไปแล้ว
    if (String((error as Error).message).includes('checkins_user_date_idx')) {
      const [again] = await db.select().from(checkins)
        .where(and(eq(checkins.username, user.username), eq(checkins.localDate, localDate))).limit(1);
      return { ok: false, error: 'already_checked_in', record: checkinRecord(again) };
    }
    throw error;
  }
  return { ok: true, record: checkinRecord(row as CheckinRow) };
}

const notImplemented = (action: string): Handler => async () => ({
  ok: false,
  error: 'not_implemented',
  detail: `ยังไม่ได้พอร์ต action "${action}" มาที่ v2`
});

const handlers: Record<string, Handler> = {
  // ---- พอร์ตแล้ว ----
  login,
  me: async (body) => {
    const session = await guard(body);
    return session.error || { ok: true, user: session.user };
  },
  todayStatus: async (body) => {
    const session = await guard(body);
    if (session.error) return session.error;
    const [row] = await db.select().from(checkins)
      .where(and(eq(checkins.username, session.user.username), eq(checkins.localDate, ymd()))).limit(1);
    return { ok: true, checkedIn: Boolean(row), record: checkinRecord(row) };
  },
  checkin,
  myCheckins: async (body) => {
    const session = await guard(body);
    if (session.error) return session.error;
    const rows = await db.select().from(checkins)
      .where(eq(checkins.username, session.user.username))
      .orderBy(desc(checkins.serverTime)).limit(100);
    return { ok: true, rows: rows.map(checkinRecord) };
  },
  report: async (body) => {
    const session = await guard(body, ['admin', 'manager']);
    if (session.error) return session.error;
    const rows = await db.select().from(checkins).orderBy(desc(checkins.serverTime)).limit(5000);
    return { ok: true, rows: rows.map(checkinRecord) };
  },

  // ---- ยังต้องพอร์ต (ดู MIGRATION.md) ----
  ...Object.fromEntries([
    'requestLeave', 'myLeaves', 'listLeaves', 'decideLeave',
    'listEmployees', 'saveEmployee',
    'appOptions', 'saveAppOptions', 'saveSheetLayout',
    'claimConfig', 'saveClaimConfig', 'saveClaim', 'myClaims', 'listClaims',
    'settleConfig', 'saveSettleRates', 'saveSettlement', 'saveSettleImage',
    'mySettlements', 'listSettlements',
    'saveReceipt', 'myReceipts', 'listReceipts',
    'blLookup', 'transportDiag', 'verifySlip', 'slipOcrDiag'
  ].map((action) => [action, notImplemented(action)]))
};

export async function dispatch(body: ApiBody = {}): Promise<ApiResult> {
  const action = String(body.action || '');
  const handler = handlers[action];
  if (!handler) return { ok: false, error: 'unknown_action' };
  return handler(body);
}
