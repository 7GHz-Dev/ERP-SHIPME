import crypto from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const round2 = (value: unknown) => Math.round((Number(value) || 0) * 100) / 100;

export const safeJson = <T,>(value: unknown, fallback: T): T => {
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
};

export const id = (prefix: string) => `${prefix}${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
export const token = () => crypto.randomBytes(32).toString('hex');

/** วันที่ตามเวลาไทยเสมอ — เซิร์ฟเวอร์ Vercel รันที่ UTC ถ้าใช้วันที่ของเครื่องจะข้ามวันตอนเย็น */
export const ymd = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};

export const validYmd = (value: unknown) => /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(value ?? '').trim());
export const isWindowsDevice = (ua: unknown) =>
  /Windows NT/i.test(String(ua ?? '')) && !/Windows Phone/i.test(String(ua ?? ''));

export function normalizeRole(role: unknown) {
  const value = String(role || 'employee').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (value === 'employee' || value === 'shipping') return 'employee-shipping';
  if (value === 'office') return 'employee-office';
  return value;
}

export function checkinPolicy(role: unknown) {
  const value = normalizeRole(role);
  if (value === 'manager' || value === 'employee-office') return { canCheckin: true, device: 'windows', photo: false };
  if (value === 'employee-shipping') return { canCheckin: true, device: 'mobile', photo: true };
  return { canCheckin: false, device: 'any', photo: false };
}

export type UserRow = {
  username: string; name: string; role: string; shippingCode: string; active: boolean;
};

export function publicUser(row: UserRow | null | undefined) {
  if (!row) return null;
  const role = normalizeRole(row.role);
  return {
    username: String(row.username),
    name: String(row.name || row.username),
    role,
    shippingCode: String(row.shippingCode || ''),
    policy: checkinPolicy(role)
  };
}

export function daysBetween(start: string, end: string) {
  const a = new Date(`${start}T00:00:00+07:00`).getTime();
  const b = new Date(`${end}T00:00:00+07:00`).getTime();
  const days = Math.round((b - a) / 86400000) + 1;
  return Number.isFinite(days) && days > 0 ? days : 1;
}

export function fmtDateStr(value: unknown) {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(value ?? '').trim());
  return match ? `${Number(match[3])}/${Number(match[2])}/${Number(match[1])}` : String(value ?? '');
}

export function fmtBaht(value: unknown) {
  return round2(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function parseActive(value: unknown) {
  return !/^(no|false|0|inactive|disabled)$/i.test(String(value ?? 'yes').trim());
}

export function contentTypeFor(fileName: string) {
  const ext = String(fileName).toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif'
  };
  return map[ext] || 'application/octet-stream';
}

// ---- รหัสผ่าน ----
// รูปแบบ scrypt:salt:hash เหมือนเดิมทุกอย่าง ฐานข้อมูลเดิมจึงย้ายมาใช้ได้เลย
// พนักงานไม่ต้องตั้งรหัสใหม่หลังย้ายระบบ
export function passwordHash(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function passwordMatches(password: string, stored: string) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const actual = crypto.scryptSync(String(password), parts[1], 64);
  const expected = Buffer.from(parts[2], 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}
