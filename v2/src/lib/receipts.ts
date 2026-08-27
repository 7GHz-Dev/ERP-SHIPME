import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { receipts } from '@/db/schema';
import { replaceDataImage } from './storage';
import type { ApiBody, ApiResult } from './types';
import { id, isWindowsDevice, normalizeRole, nowIso, validYmd } from './utils';

type ReceiptRow = typeof receipts.$inferSelect;

export const receiptRecord = (row: ReceiptRow) => ({
  id: row.id, time: row.serverTime, deviceTime: row.deviceTime, username: row.username, name: row.name,
  note: row.note, lat: row.latitude, lng: row.longitude, accuracy: row.accuracyM,
  address: row.address, mapLink: row.mapLink, photoUrl: row.photoUrl, photoId: row.photoId,
  inspectDate: row.inspectDate, retakeCount: row.retakeCount
});

export async function saveReceipt(
  body: ApiBody,
  user: { username: string; name: string; role: string },
  reverseGeocode: (lat: number, lng: number) => Promise<string>
): Promise<ApiResult> {
  // ใบเสร็จถ่ายได้เฉพาะพนักงานชิปปิ้ง และต้องถ่ายจากมือถือเท่านั้น
  if (normalizeRole(user.role) !== 'employee-shipping') return { ok: false, error: 'receipt_not_allowed' };
  if (isWindowsDevice(body.userAgent)) return { ok: false, error: 'mobile_required' };

  const inspectDate = String(body.inspectDate || '').trim();
  if (!validYmd(inspectDate)) return { ok: false, error: 'missing_inspect_date' };
  if (!body.photo) return { ok: false, error: 'no_photo' };

  const latitude = Number.parseFloat(body.lat);
  const longitude = Number.parseFloat(body.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { ok: false, error: 'no_location' };

  const [existing] = await db.select().from(receipts)
    .where(and(eq(receipts.username, user.username), eq(receipts.inspectDate, inspectDate))).limit(1);
  const replacing = body.replace === true || body.replace === 'true';
  if (existing && !replacing) {
    return { ok: false, error: 'receipt_date_exists', record: receiptRecord(existing) };
  }

  const photo = await replaceDataImage(body.photo, 'receipts', `${inspectDate}_${user.username}`);
  const address = await reverseGeocode(latitude, longitude);
  const mapLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
  const accuracy = Number.parseFloat(body.accuracy || 0) || 0;
  const note = String(body.note || '').trim().slice(0, 300);
  const now = nowIso();

  if (existing) {
    const retakeCount = Number(existing.retakeCount) + 1;
    const patch = {
      serverTime: now, deviceTime: String(body.deviceTime || ''), note,
      latitude, longitude, accuracyM: accuracy, address, mapLink,
      photoUrl: photo.url, photoId: photo.id, retakeCount
    };
    await db.update(receipts).set(patch).where(eq(receipts.id, existing.id));
    return { ok: true, mode: 'replaced', record: receiptRecord({ ...existing, ...patch }) };
  }

  const row = {
    id: id('RC'),
    serverTime: now,
    deviceTime: String(body.deviceTime || ''),
    username: user.username,
    name: user.name,
    note,
    latitude,
    longitude,
    accuracyM: accuracy,
    address,
    mapLink,
    photoUrl: photo.url,
    photoId: photo.id,
    inspectDate,
    retakeCount: 0
  };
  await db.insert(receipts).values(row);
  return { ok: true, mode: 'created', record: receiptRecord(row as ReceiptRow) };
}

export async function myReceipts(username: string): Promise<ApiResult> {
  const rows = await db.select().from(receipts)
    .where(eq(receipts.username, username))
    .orderBy(desc(receipts.serverTime)).limit(60);
  return { ok: true, rows: rows.map(receiptRecord) };
}

export async function listReceipts(): Promise<ApiResult> {
  const rows = await db.select().from(receipts).orderBy(desc(receipts.serverTime)).limit(500);
  return { ok: true, rows: rows.map(receiptRecord) };
}
