import { createSign } from 'node:crypto';
import { env } from './env';

/**
 * อ่านข้อความจากรูปด้วย Google Drive OCR — วิธีเดียวกับที่ระบบเดิมบน Apps Script ใช้
 *
 *   อัปรูปขึ้น Drive โดยสั่งให้แปลงเป็น Google Doc (mimeType ปลายทาง = ...google-apps.document)
 *   พร้อมบอกใบ้ภาษาด้วย ocrLanguage=th → Drive ทำ OCR ให้ตอนแปลง
 *   แล้ว export เป็น text/plain → ลบไฟล์ชั่วคราวทิ้ง
 *
 * Drive API เป็น Workspace API จึง **ฟรีและไม่ต้องเปิด billing** ต่างจาก Cloud Vision
 * ที่ Apps Script ทำได้เลยเพราะมี ScriptApp.getOAuthToken() ให้ ส่วนที่นี่ต้องขอโทเคนเอง
 *
 * ขอโทเคนได้ 2 ทาง เลือก service account ก่อนถ้าตั้งไว้:
 *
 *   1. service account — เซ็น JWT ด้วย private key ที่เราถือเอง ไม่มีอะไรหมดอายุ
 *   2. refresh token ของบัญชีผู้ใช้ — ใช้ได้ แต่หมดอายุใน 7 วันถ้า consent screen
 *      ยังเป็น Testing (Google บังคับ) ต้องมาขอใหม่เรื่อย ๆ
 */

/** ใช้ service account ได้ = ตั้งครบทั้งอีเมลและ private key */
export const driveServiceAccount = () =>
  Boolean(env.googleServiceEmail && env.googleServiceKey);

export const driveOcrConfigured = () =>
  driveServiceAccount() ||
  Boolean(env.googleClientId && env.googleClientSecret && env.googleRefreshToken);

const DOC_MIME = 'application/vnd.google-apps.document';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// access token อายุราว 1 ชั่วโมง — เก็บไว้ใช้ซ้ำ ไม่ต้องขอใหม่ทุกใบ
let cached: { token: string; expiresAt: number } | null = null;

const base64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * เซ็น JWT ด้วย private key ของ service account แล้วเอาไปแลก access token
 *
 * ต่างจาก refresh token ตรงที่ไม่มี "ใบอนุญาต" ที่ Google ออกให้แล้วหมดอายุได้
 * เราถือกุญแจเซ็นเองทุกครั้ง จึงไม่มีอะไรให้หมดอายุหรือถูกเพิกถอนตามรอบ
 */
async function serviceAccountToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: env.googleServiceEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claim))}`;

  let signature: string;
  try {
    signature = base64url(createSign('RSA-SHA256').update(unsigned).sign(env.googleServiceKey));
  } catch (error) {
    // key ผิดรูปแบบเป็นสาเหตุที่เจอบ่อยสุด บอกให้ชัดว่าต้องวางอะไร ไม่งั้นได้แค่ error ของ OpenSSL
    throw new Error(
      'เซ็น JWT ด้วย GOOGLE_SERVICE_ACCOUNT_KEY ไม่สำเร็จ — ต้องวางค่า private_key จากไฟล์ JSON ' +
      `ทั้งก้อนตั้งแต่ -----BEGIN PRIVATE KEY----- ถึง -----END PRIVATE KEY----- (${(error as Error).message})`
    );
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`
    }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) {
    const reason = body?.error_description || body?.error || `HTTP ${response.status}`;
    throw new Error(`ขอ access token ด้วย service account ไม่สำเร็จ: ${reason}`);
  }
  return body.access_token;
}

/** OAuth ของบัญชีผู้ใช้ — refresh token หมดอายุได้ (ดูหมายเหตุใน env.ts) */
async function refreshTokenGrant(): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      refresh_token: env.googleRefreshToken,
      grant_type: 'refresh_token'
    }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) {
    const reason = body?.error_description || body?.error || `HTTP ${response.status}`;
    // สาเหตุนี้แก้ด้วยการขอ token ใหม่อย่างเดียว บอกทางออกไปเลยจะได้ไม่ต้องมานั่งไล่หา
    const hint = /expired or revoked|invalid_grant/i.test(String(reason))
      ? ' — refresh token หมดอายุแล้ว ย้ายไปใช้ service account เพื่อไม่ให้เกิดซ้ำ (ดู v2/DEPLOY.md ข้อ 6)'
      : '';
    throw new Error(`ขอ access token จาก Google ไม่สำเร็จ: ${reason}${hint}`);
  }
  return body.access_token;
}

async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  // service account มาก่อนเสมอ เพราะไม่มีวันหมดอายุ
  const token = driveServiceAccount() ? await serviceAccountToken() : await refreshTokenGrant();
  cached = { token, expiresAt: Date.now() + 3600 * 1000 };
  return token;
}

function decode(dataUrl: string) {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(String(dataUrl || ''));
  const base64 = (match ? match[2] : String(dataUrl || '')).replace(/\s+/g, '');
  return {
    bytes: Buffer.from(base64, 'base64'),
    contentType: (match?.[1] || 'image/jpeg').toLowerCase()
  };
}

/** ประกอบ multipart/related เอง — Drive ต้องการ metadata กับตัวไฟล์ในคำขอเดียว */
function multipart(metadata: object, bytes: Buffer, contentType: string) {
  const boundary = `slip${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  return { boundary, body: Buffer.concat([head, bytes, tail]) };
}

async function removeFile(fileId: string, token: string) {
  // ลบไม่สำเร็จก็ไม่ต้องทำให้ทั้งคำขอพัง แค่ทิ้งขยะไว้ใน Drive
  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000)
    });
  } catch { /* ปล่อยผ่าน */ }
}

export async function driveOcrText(dataUrl: string): Promise<string> {
  const token = await accessToken();
  const { bytes, contentType } = decode(dataUrl);
  if (!bytes.length) throw new Error('ไม่มีข้อมูลรูปภาพ');

  const { boundary, body } = multipart(
    { name: `slip_ocr_${Date.now()}`, mimeType: DOC_MIME },   // mimeType ปลายทาง = สั่งให้แปลงเป็น Doc
    bytes,
    contentType
  );

  const upload = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&ocrLanguage=th&fields=id',
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(45000)
    }
  );
  const created = await upload.json().catch(() => null);
  if (!upload.ok || !created?.id) {
    const reason = created?.error?.message || `HTTP ${upload.status}`;
    // โควตา OCR ของ Drive เต็มได้ถ้ายิงถี่ ๆ บอกให้ชัดจะได้รู้ว่ารอแล้วลองใหม่
    if (/rate limit|quota|limit exceeded/i.test(reason)) {
      throw new Error(`Drive OCR ใช้โควตาเกินชั่วคราว — รอสักครู่แล้วกดอ่านใหม่ (${reason})`);
    }
    throw new Error(`Drive OCR อัปโหลดไม่สำเร็จ: ${reason}`);
  }

  try {
    const exported = await fetch(
      `https://www.googleapis.com/drive/v3/files/${created.id}/export?mimeType=text/plain`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) }
    );
    if (!exported.ok) {
      const reason = await exported.json().catch(() => null);
      throw new Error(`Drive OCR อ่านเอกสารไม่สำเร็จ: ${reason?.error?.message || `HTTP ${exported.status}`}`);
    }
    return await exported.text();
  } finally {
    await removeFile(created.id, token);
  }
}
