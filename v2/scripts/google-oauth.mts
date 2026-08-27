/**
 * ขอ refresh token ของ Google Drive สำหรับใช้ทำ OCR สลิป (ทำครั้งเดียว)
 *
 *   npx tsx scripts/google-oauth.mts <CLIENT_ID> <CLIENT_SECRET>
 *
 * ก่อนรัน ต้องมี OAuth client แบบ "Desktop app" และเปิดใช้ "Google Drive API"
 * ในโปรเจกต์เดียวกัน (ฟรี ไม่ต้องเปิด billing) — ดูขั้นตอนใน DEPLOY.md ข้อ 6
 *
 * ใช้วิธี loopback (เปิดเซิร์ฟเวอร์เล็ก ๆ ที่ localhost รอรับรหัส)
 * เพราะ Google ปิดวิธีคัดลอกรหัสด้วยมือ (OOB) ไปตั้งแต่ 31 ม.ค. 2023
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const clientId = process.argv[2];
const clientSecret = process.argv[3];

if (!clientId || !clientSecret) {
  console.error('ใช้: npx tsx scripts/google-oauth.mts <CLIENT_ID> <CLIENT_SECRET>');
  process.exit(1);
}

// ขอสิทธิ์แค่ไฟล์ที่แอปนี้สร้างเอง ไม่ใช่ Drive ทั้งบัญชี
// (สลิปถูกอัปเป็นไฟล์ชั่วคราวแล้วลบทิ้งทันทีหลังอ่านข้อความเสร็จ)
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const page = (title: string, detail: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<div style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.7">` +
  `<h2>${title}</h2><p>${detail}</p></div>`;

let resolveCode: (code: string) => void;
let rejectCode: (error: Error) => void;
const codePromise = new Promise<string>((resolve, reject) => {
  resolveCode = resolve;
  rejectCode = reject;
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (url.pathname !== '/') { response.writeHead(404).end(); return; }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });

  if (code) {
    response.end(page('เชื่อมต่อสำเร็จ ✓', 'กลับไปดูรหัสที่หน้าต่างคำสั่งได้เลย ปิดแท็บนี้ได้'));
    resolveCode(code);
  } else {
    response.end(page('ไม่สำเร็จ', `Google ตอบกลับมาว่า: ${error || 'ไม่ทราบสาเหตุ'}`));
    rejectCode(new Error(error || 'ไม่ได้รับรหัสจาก Google'));
  }
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as { port: number };
const redirectUri = `http://localhost:${port}`;

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',          // ต้องมี ถึงจะได้ refresh token
  prompt: 'consent'                // บังคับให้ออก refresh token ใหม่ทุกครั้ง
});

console.log('\nกำลังเปิดเบราว์เซอร์ให้อนุญาตสิทธิ์…');
console.log('ถ้าไม่เปิดให้เอง ให้คัดลอก "ทั้งบรรทัด" ข้างล่างนี้ไปวางในเบราว์เซอร์:\n');
console.log(authUrl + '\n');

// เปิดเบราว์เซอร์ให้ (ไม่ได้ก็ไม่เป็นไร ผู้ใช้คัดลอกลิงก์ข้างบนไปเปิดเองได้)
//
// บน Windows ห้ามใช้ `cmd /c start` เพราะ cmd ตีความ & ในลิงก์เป็นตัวคั่นคำสั่ง
// ลิงก์จะถูกตัดตั้งแต่ & ตัวแรก เหลือแค่ client_id แล้ว Google ตอบว่าขาด response_type
// rundll32 ส่ง argument ตรง ๆ ไม่ผ่าน shell จึงปลอดภัย
try {
  const opener: [string, string[]] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', authUrl]]
    : process.platform === 'darwin'
      ? ['open', [authUrl]]
      : ['xdg-open', [authUrl]];
  spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
} catch { /* เปิดเองไม่ได้ ก็ให้ผู้ใช้คัดลอกลิงก์ */ }

const timer = setTimeout(() => rejectCode(new Error('รอเกิน 5 นาที — รันคำสั่งใหม่อีกครั้ง')), 5 * 60 * 1000);

let code: string;
try {
  code = await codePromise;
} catch (error) {
  console.error('\n' + String((error as Error).message));
  process.exit(1);
} finally {
  clearTimeout(timer);
  server.close();
}

const response = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, grant_type: 'authorization_code'
  })
});
const body = await response.json();

if (!response.ok || !body.refresh_token) {
  console.error('\nแลกรหัสไม่สำเร็จ:', body.error_description || body.error || response.status);
  if (!body.refresh_token && body.access_token) {
    console.error('ได้ access_token แต่ไม่ได้ refresh_token — ถอนสิทธิ์แอปที่ myaccount.google.com/permissions แล้วรันใหม่');
  }
  process.exit(1);
}

console.log('สำเร็จ — เอา 3 ค่านี้ไปใส่ใน Vercel (Settings → Environment Variables)\n');
console.log(`GOOGLE_OAUTH_CLIENT_ID=${clientId}`);
console.log(`GOOGLE_OAUTH_CLIENT_SECRET=${clientSecret}`);
console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${body.refresh_token}`);
console.log('\nrefresh token ใช้ได้ตลอดจนกว่าจะถอนสิทธิ์ — เก็บเป็นความลับเหมือนรหัสผ่าน\n');
