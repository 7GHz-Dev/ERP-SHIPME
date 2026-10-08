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

/** ตัดช่องว่าง/เครื่องหมายคำพูดหัวท้ายที่มักติดมาตอนวางค่าในหน้า Vercel */
const clean = (value: string | undefined) => String(value ?? '').trim().replace(/^['"]|['"]$/g, '');

/** ดึงไอดีโฟลเดอร์ออกจากค่าที่ผู้ใช้วางมา — รับได้ทั้งไอดีล้วนและลิงก์เต็ม */
const folderId = (value: string | undefined) => {
  const raw = String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
  return (/\/folders\/([^/?#]+)/.exec(raw)?.[1] ?? raw.split(/[?#]/)[0]).trim();
};

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
  //
  // แบบที่ 1 (แนะนำ): service account — เซ็น JWT ขอ access token เอง ไม่มี refresh token
  // จึงไม่มีอะไรหมดอายุ ตั้งครั้งเดียวจบ ไม่ต้อง publish app ไม่ต้องผ่าน verification
  googleServiceEmail: (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim(),
  // service account ไม่มีพื้นที่ Drive ของตัวเอง (Google เลิกให้โควตาแล้ว)
  // จึงต้องอัปไฟล์ชั่วคราวลงโฟลเดอร์ของบัญชีคนจริงที่แชร์สิทธิ์แก้ไขไว้ให้
  //
  // รับได้ทั้งไอดีล้วนและลิงก์ที่ก๊อปจากแถบที่อยู่ เพราะการวางทั้งลิงก์เป็นเรื่องปกติ
  // ถ้าไม่ตัดให้ Drive จะตอบ "File not found: <ทั้งลิงก์>" ซึ่งดูไม่ออกว่าผิดตรงไหน
  googleDriveFolderId: folderId(process.env.GOOGLE_DRIVE_FOLDER_ID),
  // private key ใน JSON ของ Google เก็บการขึ้นบรรทัดใหม่เป็นอักษรสองตัว (\n)
  // เวลาวางลงช่องค่าของ Vercel จึงได้อักษรสองตัวนั้นมา ไม่ใช่การขึ้นบรรทัดจริง — แปลงกลับให้ตรงนี้
  googleServiceKey: (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n').trim(),
  // แบบที่ 2 (เดิม): OAuth ของบัญชีผู้ใช้ — refresh token หมดอายุใน 7 วันถ้า consent screen
  // ยังเป็น Testing อยู่ เก็บไว้ให้ระบบที่ตั้งค่าแบบนี้ไว้แล้วใช้ต่อได้โดยไม่ต้องรีบย้าย
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
  bucket: process.env.SUPABASE_BUCKET || 'uploads',
  /** แอป DocScan (คนละลิงก์กับ ERP) — หน้าปิดบัญชีเปิดไปถ่ายเอกสารตรวจปล่อย */
  docscanUrl: (process.env.DOCSCAN_URL || 'https://docscan-shipme.vercel.app').replace(/\/+$/, ''),
  /** กุญแจลงลายเซ็น ticket ของ DocScan — ไม่ตั้งก็ได้ ระบบใช้ค่าที่ได้จาก DATABASE_URL แทน */
  scanTicketSecret: process.env.SCAN_TICKET_SECRET || '',
  // ---- SMS หาคนขับรถ (ThaiBulkSMS) — ไม่ตั้ง key = ปุ่มส่ง SMS ใช้ไม่ได้ (ยังส่งจากแอป SMS ในมือถือได้) ----
  smsApiKey: clean(process.env.THAIBULKSMS_API_KEY),
  smsApiSecret: clean(process.env.THAIBULKSMS_API_SECRET),
  /** ชื่อผู้ส่งที่ ThaiBulkSMS อนุมัติแล้ว — เว้นว่าง = ใช้ชื่อตั้งต้นของบัญชี */
  smsSender: clean(process.env.THAIBULKSMS_SENDER),
  /** standard | corporate — ต้องตรงกับประเภทเครดิตที่ซื้อไว้ */
  smsForce: clean(process.env.THAIBULKSMS_FORCE) || 'standard',
  /** true = ไม่ส่งจริง บันทึกเหมือนส่งสำเร็จ (ไว้ทดสอบหน้าจอก่อนเติมเครดิต) */
  smsDryRun: bool(process.env.SMS_DRY_RUN),
  /** โดเมนที่ใส่ในลิงก์ SMS (เช่นโดเมนสั้นของบริษัท) — เว้นว่าง = ใช้โดเมนที่ผู้ใช้เปิดอยู่ */
  smsLinkBase: clean(process.env.SMS_LINK_BASE).replace(/\/+$/, ''),
  // ---- LINE OA (ประสานงานคนขับ) — ไม่ครบ 4 ค่า = DEMO MODE (บันทึกข้อความไว้ในระบบ ไม่ส่งจริง) ----
  /** Messaging API channel → Channel access token (long-lived) */
  lineAccessToken: clean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
  /** Messaging API channel → Channel secret (ตรวจลายเซ็น webhook) */
  lineChannelSecret: clean(process.env.LINE_CHANNEL_SECRET),
  /** LINE Login channel → Channel ID (ตรวจ ID token ของ LIFF) — ต้องอยู่ Provider เดียวกับ Messaging API */
  lineLoginChannelId: clean(process.env.LINE_LOGIN_CHANNEL_ID),
  /** LIFF ID ของหน้าคนขับ (endpoint = https://<โดเมน>/driver) */
  liffId: clean(process.env.LIFF_ID),
  /** Google Maps JavaScript API (ฝั่งเบราว์เซอร์ — จำกัด HTTP referrer ที่ Google Cloud Console) */
  googleMapsBrowserKey: clean(process.env.GOOGLE_MAPS_BROWSER_KEY),
  /** Google Routes API (ฝั่งเซิร์ฟเวอร์ — จำกัด IP/ไม่จำกัด referrer) ไม่ตั้ง = วางเส้นทางแบบประมาณการจากระยะทาง */
  googleRoutesServerKey: clean(process.env.GOOGLE_ROUTES_SERVER_KEY),
  /** กุญแจลงลายเซ็น session คนขับ — ไม่ตั้งก็ได้ ใช้ค่าที่ได้จาก DATABASE_URL */
  driverSessionSecret: clean(process.env.DRIVER_SESSION_SECRET)
} as const;
