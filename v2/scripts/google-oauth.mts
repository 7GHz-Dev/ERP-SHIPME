/**
 * ขอ refresh token ของ Google Drive สำหรับใช้ทำ OCR สลิป (ทำครั้งเดียว)
 *
 *   npx tsx scripts/google-oauth.mts <CLIENT_ID> <CLIENT_SECRET>
 *
 * ก่อนรัน ต้องสร้าง OAuth client แบบ "Desktop app" ที่
 *   console.cloud.google.com → APIs & Services → Credentials → Create credentials
 * และเปิดใช้ "Google Drive API" ในโปรเจกต์นั้นด้วย (ฟรี ไม่ต้องเปิด billing)
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const clientId = process.argv[2];
const clientSecret = process.argv[3];

if (!clientId || !clientSecret) {
  console.error('ใช้: npx tsx scripts/google-oauth.mts <CLIENT_ID> <CLIENT_SECRET>');
  process.exit(1);
}

// ขอสิทธิ์แค่ไฟล์ที่แอปนี้สร้างเอง ไม่ใช่ Drive ทั้งบัญชี
// (สลิปถูกอัปเป็นไฟล์ชั่วคราวแล้วลบทิ้งทันที จึงพอสำหรับงานนี้)
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',          // ต้องมี ถึงจะได้ refresh token
  prompt: 'consent'                // บังคับให้ออก refresh token ใหม่ทุกครั้ง
});

console.log('\n1) เปิดลิงก์นี้ในเบราว์เซอร์แล้วอนุญาตสิทธิ์:\n');
console.log(authUrl);
console.log('\n2) คัดลอกรหัสที่ Google แสดงกลับมา แล้ววางที่นี่\n');

const rl = readline.createInterface({ input: stdin, output: stdout });
const code = (await rl.question('รหัสที่ได้: ')).trim();
rl.close();

if (!code) {
  console.error('ไม่ได้ใส่รหัส');
  process.exit(1);
}

const response = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: REDIRECT, grant_type: 'authorization_code'
  })
});
const body = await response.json();

if (!response.ok || !body.refresh_token) {
  console.error('\nแลกรหัสไม่สำเร็จ:', body.error_description || body.error || response.status);
  if (body.refresh_token === undefined && body.access_token) {
    console.error('ได้ access_token แต่ไม่ได้ refresh_token — ลองใหม่โดยถอนสิทธิ์แอปออกก่อนที่ myaccount.google.com/permissions');
  }
  process.exit(1);
}

console.log('\nสำเร็จ — เอา 3 ค่านี้ไปใส่ใน Vercel (Settings → Environment Variables)\n');
console.log(`GOOGLE_OAUTH_CLIENT_ID=${clientId}`);
console.log(`GOOGLE_OAUTH_CLIENT_SECRET=${clientSecret}`);
console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${body.refresh_token}`);
console.log('\nrefresh token ใช้ได้ตลอดจนกว่าจะถอนสิทธิ์ — เก็บเป็นความลับเหมือนรหัสผ่าน\n');
