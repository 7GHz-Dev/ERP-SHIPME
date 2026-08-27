import crypto from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
export const safeJson = (value, fallback = null) => {
  try { return JSON.parse(value); } catch { return fallback; }
};
export const id = (prefix) => `${prefix}${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
export const token = () => crypto.randomBytes(32).toString('hex');
export const ymd = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};
export const validYmd = (value) => /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(value || '').trim());
export const isWindowsDevice = (ua) => /Windows NT/i.test(String(ua || '')) && !/Windows Phone/i.test(String(ua || ''));

export function normalizeRole(role) {
  const value = String(role || 'employee').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (value === 'employee' || value === 'shipping') return 'employee-shipping';
  if (value === 'office') return 'employee-office';
  return value;
}

export function checkinPolicy(role) {
  const value = normalizeRole(role);
  if (value === 'manager' || value === 'employee-office') return { canCheckin: true, device: 'windows', photo: false };
  if (value === 'employee-shipping') return { canCheckin: true, device: 'mobile', photo: true };
  return { canCheckin: false, device: 'any', photo: false };
}

export function publicUser(row) {
  if (!row) return null;
  const role = normalizeRole(row.role);
  return {
    username: String(row.username),
    name: String(row.name || row.username),
    role,
    shippingCode: String(row.shipping_code || ''),
    policy: checkinPolicy(role)
  };
}

export function daysBetween(start, end) {
  const a = new Date(`${start}T00:00:00+07:00`);
  const b = new Date(`${end}T00:00:00+07:00`);
  const days = Math.round((b - a) / 86400000) + 1;
  return Number.isFinite(days) && days > 0 ? days : 1;
}

export function fmtDateStr(value) {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(value || '').trim());
  return match ? `${Number(match[3])}/${Number(match[2])}/${Number(match[1])}` : String(value || '');
}

export function fmtBaht(value) {
  return round2(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function parseActive(value) {
  return !/^(no|false|0|inactive|disabled)$/i.test(String(value ?? 'yes').trim());
}

export function contentTypeFor(fileName) {
  const ext = String(fileName).toLowerCase().split('.').pop();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' })[ext] || 'application/octet-stream';
}
