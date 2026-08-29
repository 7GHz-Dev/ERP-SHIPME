const bool = (value: string | undefined, fallback = false) =>
  value == null || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value);

const number = (value: string | undefined, fallback: number) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

/**
 * ค่าที่ขาดไม่ได้ — ล้มตั้งแต่ตอน start ดีกว่าไปพังกลางทางตอนพนักงานกดใช้งาน
 * ตัดช่องว่างและเครื่องหมายคำพูดหัวท้ายให้ เพราะการก๊อปค่าไปวางในหน้า Vercel
 * มักติดช่องว่างหรือ " " มาด้วย แล้วไปพังตอน parse เป็น URL ทีหลังแบบงง ๆ
 */
export function requireEnv(name: string, hint = ''): string {
  const raw = process.env[name];
  const value = String(raw ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!value) throw new Error(`ยังไม่ได้ตั้ง ${name}${hint ? ` — ${hint}` : ''}`);
  return value;
}

/**
 * เหมือน requireEnv แต่ต้องเป็น URL ที่ใช้ได้จริง
 * ถ้าไม่บอกให้ชัดตรงนี้ จะไปโผล่เป็น "TypeError: Invalid URL" ตอน build ซึ่งอ่านไม่ออกว่าตัวไหนผิด
 */
export function requireUrl(name: string, hint = ''): string {
  const value = requireEnv(name, hint);
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error('protocol');
  } catch {
    throw new Error(
      `ค่าของ ${name} ไม่ใช่ URL ที่ใช้ได้ — ได้รับ "${value}"\n` +
      `  ต้องเป็นแบบ https://xxxxxxxx.supabase.co เท่านั้น\n` +
      `  เช็กว่าไม่ได้เผลอวางทั้งบรรทัด (${name}=https://...) ลงในช่องค่า${hint ? `\n  ${hint}` : ''}`
    );
  }
  return value.replace(/\/+$/, '');            // ตัด / ท้ายออก กัน //auth/v1 ซ้อน
}

export const env = {
  sessionHours: number(process.env.SESSION_HOURS, 12),
  maxAccuracy: number(process.env.MAX_ACCURACY_METERS, 200),
  maxAccuracyDesktop: number(process.env.MAX_ACCURACY_METERS_DESKTOP, 5000),
  // ไม่มี ADMIN_* แล้ว — ระบบเดิมสร้างบัญชีผู้ดูแลตอนเปิดเซิร์ฟเวอร์ครั้งแรกที่ฐานข้อมูลว่าง
  // แต่ serverless ไม่มีจังหวะ "เปิดเซิร์ฟเวอร์" ให้ทำแบบนั้น
  // ผู้ใช้มาจากการนำเข้าข้อมูล ถ้าต้องสร้างเพิ่มให้ใช้ scripts/temp-user.mts
  geocodeEndpoint: process.env.GEOCODE_ENDPOINT || '',
  ocrEndpoint: process.env.OCR_ENDPOINT || '',
  // endpoint OCR เป็น URL สาธารณะ ถ้าตั้ง token ไว้จะแนบไปกับทุกคำขอ
  ocrToken: process.env.OCR_TOKEN || '',
  // Drive OCR — ตัวเดียวกับที่ระบบเดิมบน Apps Script ใช้ ฟรีและไม่ต้องเปิด billing
  googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
  googleRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
  // ทางเลือก: Google Cloud Vision (แม่นกว่า แต่ต้องเปิด billing ถึงจะใช้โควตาฟรีได้)
  visionApiKey: process.env.GOOGLE_VISION_API_KEY || '',
  slipStrict: bool(process.env.SLIP_STRICT),
  slipAmountTolerance: number(process.env.SLIP_AMOUNT_TOLERANCE, 1),
  // กุญแจให้ Apps Script ในชีตงานขนส่งยิงข้อมูลเข้ามาได้ (เว้นว่าง = ปิดรับ sync)
  transportSyncToken: (process.env.TRANSPORT_SYNC_TOKEN || '').trim(),
  // ถังของ Supabase Storage — ตั้งเป็น private ทั้งหมด แล้วเข้าถึงผ่าน signed URL เท่านั้น
  bucket: process.env.SUPABASE_BUCKET || 'uploads'
} as const;
