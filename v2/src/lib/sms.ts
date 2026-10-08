import crypto from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { driverLocations, jobPlanItems, jobPlans, meetingMaps, smsMessages } from '@/db/schema';
import { env } from './env';
import { portKey } from './options';
import { createSignedUpload, fileExists } from './storage';
import type { ApiBody, ApiResult } from './types';
import { id, nowIso, safeJson, validYmd } from './utils';

/**
 * SMS หาคนขับรถผ่าน ThaiBulkSMS + หน้าลิงก์ /d/<code>
 *
 * SMS ไม่มีสถานะ "อ่านแล้ว" — สิ่งเดียวที่รู้ได้คือคนขับ "กดลิงก์" ในข้อความ
 * จึงแนบลิงก์ของเราเองไว้ทุกครั้งที่ขอตำแหน่งหรือส่งรูปแผนที่ แล้วนับการเปิดจากหน้าลิงก์
 *   - เปิดอ่าน: หน้าลิงก์ยิง linkOpened ด้วย JavaScript (บอทที่ทำ thumbnail ไม่รัน JS จึงไม่ถูกนับ)
 *   - ตำแหน่ง: เบราว์เซอร์ของคนขับขออนุญาตเอง แล้วยิง linkLocation
 *   - รูปแผนที่: ใส่เป็น og:image ของหน้าลิงก์ → แอปข้อความโชว์เป็นรูปตัวอย่าง (thumbnail) ใต้ข้อความ
 */

const API_URL = 'https://api-v2.thaibulksms.com/sms';
const MAX_RECIPIENTS = 60;
const LINK_DAYS = 30;                     // ลิงก์ใช้ได้ 30 วันหลังส่ง
const MAX_LOCATIONS_PER_LINK = 30;
const MAX_BODY = 500;

/** ข้อความตั้งต้น — ชิปปิ้งแก้ได้ก่อนส่งทุกครั้ง {ชื่อ} = ชื่อต้นของคนขับ */
export const SMS_TEMPLATES: Record<string, string> = {
  appoint: 'SHIPME นัดตรวจปล่อย {วันที่} ตู้ {ตู้} ท่า {ท่า} กรุณากดลิงก์เพื่อยืนยันและแชร์ตำแหน่ง',
  ask: 'SHIPME สอบถามคุณ{ชื่อ} ตู้ {ตู้} ตอนนี้ถึงไหนแล้วครับ กรุณากดลิงก์เพื่อแชร์ตำแหน่ง',
  custom: ''
};
const KINDS = new Set(Object.keys(SMS_TEMPLATES));
export const SMS_PLACEHOLDERS = ['{ชื่อ}', '{ทะเบียน}', '{ตู้}', '{BL}', '{ท่า}', '{ปลายทาง}', '{วันที่}', '{ชิปปิ้ง}'];

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
export const thShortDate = (date: string) => {
  const [, m, d] = date.split('-').map(Number);
  return m && d ? `${d} ${TH_MONTHS[m - 1]}` : date;
};

/** เบอร์มือถือไทยเป็น 0XXXXXXXXX — รับ +66 / 66 / มีขีด / มีวงเล็บ ได้หมด ไม่ใช่มือถือ = '' */
export function normPhone(raw: unknown) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('66') && digits.length === 11) digits = `0${digits.slice(2)}`;
  return /^0[689]\d{8}$/.test(digits) ? digits : '';
}

/** ช่องโทรศัพท์บางแถวมีหลายเบอร์ ("093-143-8926 / 081...") — ใช้เบอร์มือถือเบอร์แรกที่ถูกต้อง */
export function smsPhone(raw: unknown) {
  const compact = String(raw ?? '').replace(/[\s\-().]/g, '');
  for (const match of compact.match(/(?:\+?66|0)\d{8,9}/g) || []) {
    const phone = normPhone(match);
    if (phone) return phone;
  }
  return '';
}

/** จำนวนเครดิตโดยประมาณ — ภาษาไทยเป็น Unicode: 70 ตัว/ข้อความ, ยาวกว่านั้น 67 ตัว/ส่วน */
export function smsParts(message: string) {
  const unicode = /[^\x00-\x7F]/.test(message);
  const length = [...message].length;
  const [single, multi] = unicode ? [70, 67] : [160, 153];
  return { length, unicode, parts: length <= single ? 1 : Math.ceil(length / multi) };
}

export function smsConfig() {
  return {
    ready: Boolean((env.smsApiKey && env.smsApiSecret) || env.smsDryRun),
    dryRun: env.smsDryRun,
    templates: SMS_TEMPLATES,
    placeholders: SMS_PLACEHOLDERS,
    linkBase: env.smsLinkBase
  };
}

type SmsRow = typeof smsMessages.$inferSelect;

/** สิ่งที่หน้าเว็บต้องใช้ — ไม่ส่ง providerId / mapKey ออกไป */
export function smsRowView(row: SmsRow) {
  return {
    id: row.id, code: row.code, inspectDate: row.inspectDate,
    itemIds: safeJson<string[]>(row.itemIdsJson, []),
    username: String(row.username), sentBy: String(row.sentBy),
    phone: row.phone, driverName: row.driverName, plate: row.plate, containers: row.containers,
    kind: row.kind, message: row.message, withLocation: row.withLocation, mapId: row.mapId,
    provider: row.provider, status: row.status, error: row.error, credit: row.credit,
    sentAt: row.sentAt, previewAt: row.previewAt,
    openedAt: row.openedAt, lastOpenedAt: row.lastOpenedAt, openCount: row.openCount,
    locationStatus: row.locationStatus, latitude: row.latitude, longitude: row.longitude,
    accuracyM: row.accuracyM, locationAt: row.locationAt, createdAt: row.createdAt
  };
}

// ---------------- รูปแผนที่นัดหมาย ----------------

export async function meetingMapsList(activeOnly: boolean) {
  const rows = await db.select().from(meetingMaps)
    .where(activeOnly ? eq(meetingMaps.active, true) : undefined)
    .orderBy(asc(meetingMaps.port), asc(meetingMaps.name));
  return rows.map((row) => ({
    id: row.id, name: row.name, port: row.port, portKey: row.portKey, url: row.url,
    width: row.width, height: row.height, size: row.size, active: row.active, createdAt: row.createdAt
  }));
}

/** อัปรูปตรงจากเบราว์เซอร์ไป Supabase (รูปรวมแผนที่ + หน้างานใหญ่เกินลิมิต body ของ Vercel) */
export async function signMapUpload(): Promise<ApiResult> {
  const upload = await createSignedUpload('maps', id('map_'), 'jpg');
  return { ok: true, key: upload.key, url: upload.url, uploadUrl: upload.uploadUrl, uploadToken: upload.uploadToken };
}

export async function saveMeetingMap(body: ApiBody, user: { username: string }): Promise<ApiResult> {
  const name = String(body.name ?? '').trim().slice(0, 80);
  const port = String(body.port ?? '').trim().slice(0, 40);
  if (!name) return { ok: false, error: 'missing_name' };
  const at = nowIso();

  // แก้ชื่อ / ท่า / เปิด-ปิด ของรูปเดิม
  if (body.id) {
    const patch: Partial<typeof meetingMaps.$inferInsert> = { name, port, portKey: portKey(port), updatedAt: at };
    if (typeof body.active === 'boolean') patch.active = body.active;
    const done = await db.update(meetingMaps).set(patch).where(eq(meetingMaps.id, String(body.id))).returning({ id: meetingMaps.id });
    return done.length ? { ok: true, id: done[0].id } : { ok: false, error: 'not_found' };
  }

  const key = String(body.key ?? '');
  if (!/^maps\/map_[a-z0-9]+\.jpg$/i.test(key)) return { ok: false, error: 'bad_key' };
  if (!(await fileExists(key))) return { ok: false, error: 'upload_missing' };
  const row = {
    id: id('mm_'), name, port, portKey: portKey(port), storageKey: key,
    url: `/files/${key.split('/').map(encodeURIComponent).join('/')}`,
    width: Math.max(0, Math.round(Number(body.width) || 0)),
    height: Math.max(0, Math.round(Number(body.height) || 0)),
    size: Math.max(0, Math.round(Number(body.size) || 0)),
    active: true, createdBy: user.username, createdAt: at, updatedAt: at
  };
  await db.insert(meetingMaps).values(row);
  return { ok: true, id: row.id };
}

// ---------------- ส่ง SMS ----------------

/** แถวงานที่ผู้ใช้คนนี้ส่ง SMS ได้ — ชิปปิ้งได้เฉพาะแถวของตัวเองในแพลนที่ Confirm แล้ว */
async function itemsForSending(date: string, ids: string[], user: { username: string; role: string }) {
  const [plan] = await db.select({ status: jobPlans.status }).from(jobPlans).where(eq(jobPlans.inspectDate, date)).limit(1);
  if (!plan || plan.status !== 'confirmed') return { error: 'plan_not_confirmed' as const, items: [] };
  if (!ids.length) return { error: 'no_items' as const, items: [] };
  const rows = await db.select().from(jobPlanItems)
    .where(and(eq(jobPlanItems.inspectDate, date), inArray(jobPlanItems.id, ids.slice(0, 400))));
  const mine = user.role === 'employee-shipping'
    ? rows.filter((row) => String(row.username).toLowerCase() === user.username.toLowerCase())
    : rows;
  if (mine.length !== rows.length) return { error: 'forbidden' as const, items: [] };
  return { error: null, items: mine };
}

const firstName = (name: string) => name.trim().replace(/^(นาย|นาง(สาว)?|น\.ส\.|คุณ)\s*/, '').split(/\s+/)[0] || '';
const uniq = (values: string[]) => [...new Set(values.map((v) => v.trim()).filter(Boolean))];

function fillTemplate(template: string, ctx: Record<string, string>) {
  return template.replace(/\{(ชื่อ|ทะเบียน|ตู้|BL|ท่า|ปลายทาง|วันที่|ชิปปิ้ง)\}/g, (_, key: string) => ctx[key] ?? '');
}

const linkCode = () => {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
};

type ProviderResult = { ok: boolean; providerId?: string; credit?: number; remaining?: number | null; error?: string };

async function providerSend(phone: string, message: string): Promise<ProviderResult> {
  if (env.smsDryRun) return { ok: true, providerId: 'dry-run', credit: smsParts(message).parts, remaining: null };
  const form = new URLSearchParams({ msisdn: phone, message, force: env.smsForce });
  if (env.smsSender) form.set('sender', env.smsSender);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${env.smsApiKey}:${env.smsApiSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body: form,
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({})) as any;
    if (!response.ok || data?.error) {
      const err = data?.error || {};
      return { ok: false, error: String(err.description || err.name || err.message || `HTTP ${response.status}`).slice(0, 200) };
    }
    const sent = Array.isArray(data?.phone_number_list) ? data.phone_number_list[0] : null;
    if (!sent) {
      const bad = Array.isArray(data?.bad_phone_number_list) ? data.bad_phone_number_list[0] : null;
      return { ok: false, error: String(bad?.message || 'ผู้ให้บริการไม่รับเบอร์นี้').slice(0, 200) };
    }
    return {
      ok: true, providerId: String(sent.message_id || ''), credit: Number(sent.used_credit) || 0,
      remaining: Number.isFinite(Number(data.remaining_credit)) ? Number(data.remaining_credit) : null
    };
  } catch (error) {
    return { ok: false, error: (error as Error)?.name === 'TimeoutError' ? 'ผู้ให้บริการ SMS ไม่ตอบกลับ' : 'เชื่อมต่อผู้ให้บริการ SMS ไม่ได้' };
  }
}

/**
 * ส่ง SMS หาคนขับรถตามแถวงานที่เลือก — คนขับเบอร์เดียวกันหลายตู้รวมเป็น SMS เดียว
 * via 'device' = ไม่ผ่าน ThaiBulkSMS: ออกลิงก์ติดตามให้ แล้วหน้าเว็บเปิดแอป SMS ในมือถือของชิปปิ้งเอง (ทีละเบอร์)
 */
export async function sendDriverSms(body: ApiBody, user: { username: string; name: string; role: string }): Promise<ApiResult> {
  const date = String(body.date ?? '');
  if (!validYmd(date)) return { ok: false, error: 'bad_date' };
  const via = body.via === 'device' ? 'device' : 'api';
  const config = smsConfig();
  if (via === 'api' && !config.ready) return { ok: false, error: 'sms_not_configured' };

  const kind = KINDS.has(String(body.kind)) ? String(body.kind) : 'custom';
  const template = String(body.text ?? '').trim().slice(0, MAX_BODY);
  if (!template) return { ok: false, error: 'missing_message' };
  const withLocation = Boolean(body.withLocation);
  const mapChoice = String(body.mapId ?? '');

  const ids = Array.isArray(body.itemIds) ? body.itemIds.map(String) : [];
  const picked = await itemsForSending(date, ids, user);
  if (picked.error) return { ok: false, error: picked.error };

  // รวมตามเบอร์ — แถวที่ไม่มีเบอร์มือถือที่ใช้ได้แจ้งกลับไปให้แก้ในแพลน
  const groups = new Map<string, typeof picked.items>();
  const noPhone: string[] = [];
  for (const item of picked.items) {
    const phone = smsPhone(item.phone);
    if (!phone) { noPhone.push(item.containerNo || item.bl); continue; }
    if (!groups.has(phone)) groups.set(phone, []);
    groups.get(phone)!.push(item);
  }
  if (!groups.size) return { ok: false, error: 'no_valid_phone', noPhone };
  if (groups.size > MAX_RECIPIENTS) return { ok: false, error: 'too_many_recipients' };
  if (via === 'device' && groups.size > 1) return { ok: false, error: 'device_one_at_a_time' };

  const maps = mapChoice ? await meetingMapsList(true) : [];
  const mapFor = (items: typeof picked.items) => {
    if (!mapChoice) return null;
    if (mapChoice !== 'auto') return maps.find((map) => map.id === mapChoice) || null;
    for (const item of items) {
      const hit = maps.find((map) => map.portKey && map.portKey === portKey(item.port));
      if (hit) return hit;
    }
    return null;
  };
  const mapKeys = new Map((mapChoice ? await db.select({ id: meetingMaps.id, key: meetingMaps.storageKey }).from(meetingMaps) : [])
    .map((row) => [row.id, row.key]));

  const base = env.smsLinkBase || String(body._origin || '').replace(/\/+$/, '');
  const at = nowIso();
  type Job = { row: typeof smsMessages.$inferInsert; items: typeof picked.items };
  const jobs: Job[] = [];
  for (const [phone, items] of groups) {
    const first = items[0];
    const containers = uniq(items.map((item) => item.containerNo));
    const ctx: Record<string, string> = {
      'ชื่อ': firstName(first.driverName), 'ทะเบียน': first.plate.split(/\s+-\s+/)[0] || first.plate,
      'ตู้': containers.join(', ') || first.bl, 'BL': uniq(items.map((item) => item.bl)).join(', '),
      'ท่า': uniq(items.map((item) => item.port)).join(', '), 'ปลายทาง': uniq(items.map((item) => item.destination)).join(', '),
      'วันที่': thShortDate(date), 'ชิปปิ้ง': user.name
    };
    const text = fillTemplate(template, ctx).replace(/[ \t]{2,}/g, ' ').trim();
    const map = mapFor(items);
    const needsLink = withLocation || Boolean(map);
    const code = needsLink ? linkCode() : '';
    const message = code ? `${text}\n${base}/d/${code}` : text;
    jobs.push({
      items,
      row: {
        id: id('sms_'), code, inspectDate: date, itemIdsJson: JSON.stringify(items.map((item) => item.id)),
        username: String(first.username), sentBy: user.username, phone,
        driverName: first.driverName, plate: first.plate, containers: containers.join(', '),
        kind, body: text, message, withLocation,
        mapId: map?.id || '', mapKey: map ? mapKeys.get(map.id) || '' : '',
        provider: via === 'device' ? 'device' : (env.smsDryRun ? 'dry-run' : 'thaibulksms'),
        status: via === 'device' ? 'device' : 'queued', sentAt: via === 'device' ? at : '',
        createdAt: at
      }
    });
  }

  // บันทึกก่อนส่ง — ถ้าฟังก์ชันถูกตัดกลางทาง ยังเห็นว่าเบอร์ไหนค้าง (queued)
  for (const job of jobs) await db.insert(smsMessages).values(job.row);

  if (via === 'device') {
    const job = jobs[0];
    return { ok: true, via, phone: job.row.phone, message: job.row.message, sms: job.row.id };
  }

  // ยิงผู้ให้บริการทีละ 5 เบอร์พร้อมกัน แล้วค่อยเขียนผลลงฐานข้อมูลตามลำดับ (pool มี connection เดียว)
  const results: (ProviderResult & { job: Job })[] = [];
  for (let i = 0; i < jobs.length; i += 5) {
    const chunk = jobs.slice(i, i + 5);
    const sent = await Promise.all(chunk.map((job) => providerSend(job.row.phone!, job.row.message!)));
    sent.forEach((result, k) => results.push({ ...result, job: chunk[k] }));
  }
  let remaining: number | null = null;
  for (const result of results) {
    if (result.remaining != null) remaining = result.remaining;
    await db.update(smsMessages).set(result.ok
      ? { status: 'sent', providerId: result.providerId || '', credit: result.credit || 0, sentAt: nowIso() }
      : { status: 'failed', error: result.error || 'failed' })
      .where(eq(smsMessages.id, result.job.row.id!));
  }
  return {
    ok: true, via, dryRun: env.smsDryRun, remaining, noPhone,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    credit: results.reduce((sum, r) => sum + (r.ok ? r.credit || 0 : 0), 0),
    results: results.map((r) => ({
      phone: r.job.row.phone, driverName: r.job.row.driverName, containers: r.job.row.containers,
      ok: r.ok, error: r.error || ''
    }))
  };
}

// ---------------- หน้าลิงก์ /d/<code> (สาธารณะ ไม่ต้องล็อกอิน) ----------------

const validCode = (code: unknown) => /^[A-Za-z0-9]{6,12}$/.test(String(code ?? ''));

export async function smsByCode(code: string) {
  if (!validCode(code)) return null;
  const [row] = await db.select().from(smsMessages).where(eq(smsMessages.code, code)).limit(1);
  if (!row) return null;
  const sent = Date.parse(row.sentAt || row.createdAt);
  const expired = Number.isFinite(sent) && Date.now() - sent > LINK_DAYS * 86400000;
  return { row, expired };
}

/** แอปข้อความดึงหน้าไปทำ thumbnail = เครื่องคนขับได้รับข้อความแล้ว (ยังไม่นับว่าเปิดอ่าน) */
export async function markPreview(code: string) {
  await db.update(smsMessages).set({ previewAt: nowIso() })
    .where(and(eq(smsMessages.code, code), eq(smsMessages.previewAt, '')));
}

export async function linkOpened(body: ApiBody): Promise<ApiResult> {
  if (!validCode(body.code)) return { ok: false, error: 'not_found' };
  const at = nowIso();
  const done = await db.update(smsMessages).set({
    openedAt: sql`case when ${smsMessages.openedAt} = '' then ${at} else ${smsMessages.openedAt} end`,
    lastOpenedAt: at,
    openCount: sql`least(${smsMessages.openCount} + 1, 9999)`
  }).where(eq(smsMessages.code, String(body.code))).returning({ id: smsMessages.id });
  return done.length ? { ok: true } : { ok: false, error: 'not_found' };
}

export async function linkLocation(body: ApiBody): Promise<ApiResult> {
  const found = await smsByCode(String(body.code ?? ''));
  if (!found || found.expired || !found.row.withLocation) return { ok: false, error: 'not_found' };
  const { row } = found;
  const at = nowIso();

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!(Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) {
    // ปฏิเสธ/หาตำแหน่งไม่ได้ — บันทึกไว้ให้ชิปปิ้งรู้ว่าต้องโทรถามแทน (ไม่ทับตำแหน่งที่เคยได้แล้ว)
    const status = body.status === 'denied' ? 'denied' : 'unavailable';
    await db.update(smsMessages).set({ locationStatus: status })
      .where(and(eq(smsMessages.id, row.id), sql`${smsMessages.locationStatus} <> 'shared'`));
    return { ok: true };
  }
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(driverLocations).where(eq(driverLocations.smsId, row.id));
  if (n >= MAX_LOCATIONS_PER_LINK) return { ok: false, error: 'too_many' };
  const accuracy = Math.max(0, Math.min(100000, Number(body.accuracy) || 0));
  await db.insert(driverLocations).values({
    id: id('dl_'), smsId: row.id, inspectDate: row.inspectDate, phone: row.phone,
    driverName: row.driverName, plate: row.plate, latitude: lat, longitude: lng, accuracyM: accuracy,
    userAgent: String(body._ua || '').slice(0, 300), createdAt: at
  });
  await db.update(smsMessages).set({
    locationStatus: 'shared', latitude: lat, longitude: lng, accuracyM: accuracy, locationAt: at
  }).where(eq(smsMessages.id, row.id));
  return { ok: true };
}

/** SMS ธรรมดา 1 เบอร์ (ช่องทางสำรองของงานประสานคนขับ) — ใช้ตัวส่งเดียวกับหน้างานปล่อย */
export async function sendPlainSms(phone: string, message: string) {
  if (!smsConfig().ready) return { ok: false, error: 'sms_not_configured' };
  return providerSend(phone, message);
}
