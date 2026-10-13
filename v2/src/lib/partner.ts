import crypto from 'node:crypto';
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { driverLinkInvites, drivers, driverSignupLinks, evidenceFiles, jobEvents, jobPlanItems, jobSteps } from '@/db/schema';
import { makeSession } from './coord';
import { driverUrl, lineMode, verifyLineIdToken } from './coord-line';
import { smsPhone } from './sms';
import type { ApiBody, ApiResult } from './types';
import { id, nowIso, validYmd, ymd } from './utils';

/**
 * พาร์ทเนอร์หาคนขับ (role: ttn-admin-driver) — หน้า /partner
 *   - คนขับ: เพิ่มคนขับเอง / สร้างลิงก์ + QR ผูก LINE ให้ทีละคน / ยกเลิกการผูก
 *   - QR รับสมัคร: ลิงก์เดียวใช้ได้หลายคน — คนขับสแกนใน LINE กรอกชื่อ เบอร์ ทะเบียน แล้วผูกทันที
 *   - รูปงาน: รูปรับตู้ (หน้ารถ / ท้ายรถ) ซีลตู้ ER ออกท่า ซีลตะกั่ว ของทุกงาน
 * คนขับที่เพิ่มไว้ก่อน พอมีชื่ออยู่ในแพลน (เบอร์เดียวกัน) ระบบจับคู่เป็นคนเดียวกันเอง และใช้ LINE ที่ผูกไว้ส่งงานได้ทันที
 */

type Staff = { username: string; name: string; role: string };
const INVITE_DAYS = 7;
const text = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);
const randomCode = (len: number) => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(len), (b) => alphabet[b % alphabet.length]).join('');
};
const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86400000).toISOString();

// ---------------- คนขับ ----------------

export async function partnerDrivers(body: ApiBody): Promise<ApiResult> {
  const q = text(body.q, 60);
  const like = `%${q}%`;
  const rows = await db.select().from(drivers)
    .where(q ? or(ilike(drivers.name, like), ilike(drivers.phone, like), ilike(drivers.plate, like), ilike(drivers.lineName, like)) : undefined)
    .orderBy(desc(drivers.updatedAt)).limit(500);
  const ids = rows.map((d) => d.id);
  // งานล่าสุด / จำนวนงาน ของแต่ละคน
  const jobs = ids.length ? await db.select({ driverId: jobSteps.driverId, last: sql<string>`max(${jobSteps.inspectDate})`, n: sql<number>`count(*)::int` })
    .from(jobSteps).where(inArray(jobSteps.driverId, ids)).groupBy(jobSteps.driverId) : [];
  const byDriver = new Map(jobs.map((j) => [j.driverId, j]));
  return {
    ok: true, lineMode: lineMode(),
    rows: rows.map((d) => ({
      id: d.id, name: d.name, phone: d.phone, plate: d.plate, note: d.note, source: d.source, createdBy: String(d.createdBy),
      linked: Boolean(d.lineUserId), demo: d.lineUserId.startsWith('DEMO-'), lineName: d.lineName, linePicture: d.linePicture,
      lineLinkedAt: d.lineLinkedAt, friend: d.lineFriend, createdAt: d.createdAt,
      lastJob: byDriver.get(d.id)?.last || '', jobs: byDriver.get(d.id)?.n || 0
    }))
  };
}

export async function partnerDriverSave(body: ApiBody, user: Staff): Promise<ApiResult> {
  const name = text(body.name, 100), plate = text(body.plate, 40), note = text(body.note, 300);
  const phone = smsPhone(body.phone);
  if (!name) return { ok: false, error: 'missing_name' };
  if (!phone) return { ok: false, error: 'bad_phone' };
  const at = nowIso();
  const editId = text(body.id, 60);
  const [same] = await db.select({ id: drivers.id }).from(drivers).where(eq(drivers.phone, phone)).limit(1);
  if (same && same.id !== editId) return { ok: false, error: 'phone_exists', driverId: same.id };
  if (editId) {
    const done = await db.update(drivers).set({ name, phone, plate, note, updatedAt: at }).where(eq(drivers.id, editId)).returning({ id: drivers.id });
    return done.length ? { ok: true, id: editId } : { ok: false, error: 'not_found' };
  }
  const row = { id: id('drv_'), name, phone, plate, note, source: 'partner', createdBy: user.username, createdAt: at, updatedAt: at };
  await db.insert(drivers).values(row);
  return { ok: true, id: row.id };
}

/** ลิงก์ผูก LINE เฉพาะคนขับคนนี้ (ใช้ครั้งเดียว อายุ 7 วัน) — เปิดใน LINE แล้วผูกทันที */
export async function partnerDriverInvite(body: ApiBody, user: Staff): Promise<ApiResult> {
  const [driver] = await db.select().from(drivers).where(eq(drivers.id, text(body.driverId, 60))).limit(1);
  if (!driver) return { ok: false, error: 'not_found' };
  const at = nowIso(), code = randomCode(8);
  await db.insert(driverLinkInvites).values({ code, driverId: driver.id, createdBy: user.username, createdAt: at, expiresAt: addDays(at, INVITE_DAYS) });
  return { ok: true, code, link: driverUrl(String(body._origin || ''), `link=${code}`, true), expiresAt: addDays(at, INVITE_DAYS), name: driver.name };
}

export async function partnerDriverUnlink(body: ApiBody): Promise<ApiResult> {
  const done = await db.update(drivers).set({ lineUserId: '', lineName: '', linePicture: '', lineFriend: false, lineLinkedAt: '', updatedAt: nowIso() })
    .where(eq(drivers.id, text(body.driverId, 60))).returning({ id: drivers.id });
  return done.length ? { ok: true } : { ok: false, error: 'not_found' };
}

// ---------------- QR รับสมัคร ----------------

/** ลิงก์รับสมัครที่ใช้อยู่ (ไม่มี = สร้างให้) / renew = ปิดลิงก์เดิม สร้างใหม่ (QR เก่าใช้ไม่ได้อีก) */
export async function partnerSignupLink(body: ApiBody, user: Staff): Promise<ApiResult> {
  if (body.renew === true) await db.update(driverSignupLinks).set({ active: false }).where(eq(driverSignupLinks.active, true));
  let [link] = await db.select().from(driverSignupLinks).where(eq(driverSignupLinks.active, true)).orderBy(desc(driverSignupLinks.createdAt)).limit(1);
  if (!link) {
    const row = { code: randomCode(10), label: 'QR รับสมัครคนขับ', createdBy: user.username, createdAt: nowIso() };
    await db.insert(driverSignupLinks).values(row);
    [link] = await db.select().from(driverSignupLinks).where(eq(driverSignupLinks.code, row.code)).limit(1);
  }
  const recent = await db.select().from(drivers).where(eq(drivers.source, 'signup')).orderBy(desc(drivers.createdAt)).limit(30);
  return {
    ok: true, code: link.code, uses: link.uses, createdAt: link.createdAt, link: driverUrl(String(body._origin || ''), `join=${link.code}`, true),
    recent: recent.map((d) => ({ id: d.id, name: d.name, phone: d.phone, plate: d.plate, createdAt: d.createdAt, linked: Boolean(d.lineUserId), lineName: d.lineName }))
  };
}

/**
 * คนขับสแกน QR รับสมัคร (หน้า /driver?join=CODE)
 *   ไม่ส่งชื่อมา = เช็กว่าลิงก์ใช้ได้ไหม / LINE นี้ผูกแล้วหรือยัง (ผูกแล้ว = เข้าใช้งานได้เลย)
 *   ส่งชื่อ + เบอร์มา = สมัคร: เบอร์นี้มีในระบบแล้ว (เช่น จากแพลน / พาร์ทเนอร์เพิ่มไว้) ผูก LINE กับคนนั้น / ไม่มี = สร้างใหม่
 */
export async function driverJoin(body: ApiBody): Promise<ApiResult> {
  const [link] = await db.select().from(driverSignupLinks).where(eq(driverSignupLinks.code, text(body.join, 20).toUpperCase())).limit(1);
  if (!link || !link.active) return { ok: false, error: 'join_invalid' };
  const mode = lineMode();
  let sub = '', lineName = '', picture = '';
  if (body.idToken) {
    const v = await verifyLineIdToken(String(body.idToken));
    if (!v.ok) return { ok: false, error: v.error };
    sub = v.sub; lineName = v.name; picture = v.picture;
  } else if (mode === 'live') return { ok: false, error: 'open_in_line' };

  if (sub) {
    const [already] = await db.select().from(drivers).where(eq(drivers.lineUserId, sub)).limit(1);
    if (already) return { ok: true, registered: true, session: makeSession(already.id, 'line'), name: already.name };
  }
  const name = text(body.name, 100), plate = text(body.plate, 40), phone = smsPhone(body.phone);
  if (!body.name && !body.phone) return { ok: true, registered: false, lineName };
  if (!name) return { ok: false, error: 'missing_name' };
  if (!phone) return { ok: false, error: 'bad_phone' };
  sub = sub || `DEMO-${phone}`;
  const at = nowIso();
  const [same] = await db.select().from(drivers).where(eq(drivers.phone, phone)).limit(1);
  let driverId = '';
  if (same) {
    if (same.lineUserId && same.lineUserId !== sub) return { ok: false, error: 'phone_linked_other' };
    await db.update(drivers).set({ name: same.name || name, plate: same.plate || plate, lineUserId: sub, lineName, linePicture: picture, lineLinkedAt: at,
      lineFriend: mode === 'demo' ? true : same.lineFriend, updatedAt: at }).where(eq(drivers.id, same.id));
    driverId = same.id;
  } else {
    driverId = id('drv_');
    await db.insert(drivers).values({ id: driverId, name, phone, plate, source: 'signup', createdBy: String(link.createdBy), lineUserId: sub, lineName,
      linePicture: picture, lineLinkedAt: at, lineFriend: mode === 'demo', createdAt: at, updatedAt: at });
  }
  await db.update(driverSignupLinks).set({ uses: sql`${driverSignupLinks.uses} + 1` }).where(eq(driverSignupLinks.code, link.code));
  return { ok: true, registered: true, joined: true, session: makeSession(driverId, mode === 'live' ? 'line' : 'demo'), name: same?.name || name };
}

// ---------------- รูปงาน ----------------

const KINDS = ['TRUCK_FRONT_PHOTO', 'TRUCK_REAR_PHOTO', 'PICKUP_SEAL_PHOTO', 'EIR_CARD_PHOTO', 'CONTAINER_SEAL_PHOTO'];

/** ตู้ที่มีงานในช่วงวันที่ (ค้นเลขตู้ / BL / คนขับได้) พร้อมรูปทุกชนิด — onlyWithPhotos = เฉพาะตู้ที่มีรูป */
export async function partnerPhotos(body: ApiBody): Promise<ApiResult> {
  const to = validYmd(body.to) ? String(body.to) : ymd();
  const from = validYmd(body.from) ? String(body.from) : to;
  const q = text(body.q, 60), like = `%${q}%`;
  const items = await db.select().from(jobPlanItems)
    .where(and(gte(jobPlanItems.inspectDate, from), lte(jobPlanItems.inspectDate, to),
      q ? or(ilike(jobPlanItems.containerNo, like), ilike(jobPlanItems.bl, like), ilike(jobPlanItems.driverName, like), ilike(jobPlanItems.plate, like)) : undefined))
    .orderBy(desc(jobPlanItems.inspectDate), asc(jobPlanItems.seq)).limit(400);
  const ids = items.map((i) => i.id);
  const ev = ids.length ? await db.select().from(evidenceFiles).where(inArray(evidenceFiles.itemId, ids)).orderBy(asc(evidenceFiles.createdAt)) : [];
  const steps = ids.length ? await db.select().from(jobSteps).where(inArray(jobSteps.itemId, ids)) : [];
  const drv = [...new Set(steps.map((s) => s.driverId).filter(Boolean))];
  const drvRows = drv.length ? await db.select({ id: drivers.id, name: drivers.name, plate: drivers.plate, phone: drivers.phone }).from(drivers).where(inArray(drivers.id, drv)) : [];
  const rows = items.map((i) => {
    const s = steps.find((x) => x.itemId === i.id);
    const d = drvRows.find((x) => x.id === s?.driverId);
    const photos = ev.filter((e) => e.itemId === i.id).map((e) => ({ id: e.id, kind: e.kind, url: e.url, at: e.createdAt }));
    return { id: i.id, inspectDate: i.inspectDate, bl: i.bl, containerNo: i.containerNo, port: i.port, customer: i.customer, staff: String(i.username),
      driverName: d?.name || i.driverName, plate: d?.plate || i.plate, phone: d?.phone || i.phone,
      pickedUpAt: s?.pickedUpAt || '', completedAt: s?.completedAt || '', photos };
  }).filter((r) => body.onlyWithPhotos === false || r.photos.length);
  return { ok: true, from, to, rows, kinds: KINDS, total: ev.length };
}

/** ลบรูปที่ผิด (เก็บไฟล์ไว้ในที่เก็บไฟล์ ลบแค่ออกจากงาน) — บันทึกประวัติว่าใครลบ */
export async function partnerPhotoDelete(body: ApiBody, user: Staff): Promise<ApiResult> {
  const [e] = await db.select().from(evidenceFiles).where(eq(evidenceFiles.id, text(body.id, 60))).limit(1);
  if (!e) return { ok: false, error: 'not_found' };
  await db.delete(evidenceFiles).where(eq(evidenceFiles.id, e.id));
  const [s] = await db.select({ username: jobSteps.username }).from(jobSteps).where(eq(jobSteps.itemId, e.itemId)).limit(1);
  await db.insert(jobEvents).values({ id: id('je_'), itemId: e.itemId, inspectDate: e.inspectDate, username: String(s?.username || ''),
    actorType: 'staff', actorId: user.username, event: 'EVIDENCE_DELETED', metaJson: JSON.stringify({ kind: e.kind, key: e.storageKey }), createdAt: nowIso() });
  return { ok: true };
}
