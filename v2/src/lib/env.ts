const bool = (value: string | undefined, fallback = false) =>
  value == null || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value);

const number = (value: string | undefined, fallback: number) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

/** ค่าที่ขาดไม่ได้ — ล้มตั้งแต่ตอน start ดีกว่าไปพังกลางทางตอนพนักงานกดใช้งาน */
export function requireEnv(name: string, hint = ''): string {
  const value = process.env[name];
  if (!value) throw new Error(`ยังไม่ได้ตั้ง ${name}${hint ? ` — ${hint}` : ''}`);
  return value;
}

export const env = {
  sessionHours: number(process.env.SESSION_HOURS, 12),
  maxAccuracy: number(process.env.MAX_ACCURACY_METERS, 200),
  maxAccuracyDesktop: number(process.env.MAX_ACCURACY_METERS_DESKTOP, 5000),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminName: process.env.ADMIN_NAME || 'ผู้ดูแลระบบ',
  geocodeEndpoint: process.env.GEOCODE_ENDPOINT || '',
  ocrEndpoint: process.env.OCR_ENDPOINT || '',
  slipStrict: bool(process.env.SLIP_STRICT),
  slipAmountTolerance: number(process.env.SLIP_AMOUNT_TOLERANCE, 1),
  // ถังของ Supabase Storage — ตั้งเป็น private ทั้งหมด แล้วเข้าถึงผ่าน signed URL เท่านั้น
  bucket: process.env.SUPABASE_BUCKET || 'uploads'
} as const;
