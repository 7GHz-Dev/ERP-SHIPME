/**
 * ทดสอบที่เก็บเอกสารของ DocScan (โหมด "ให้ระบบเก็บ") ทั้งเส้น — ใช้กับบัญชีชั่วคราว (scripts/temp-user.mts)
 * ล็อกอิน → ขอลิงก์อัป → PUT → ขอลิงก์ดาวน์โหลด → เทียบไฟล์ → รายการเอกสาร/doc.json → ลบไฟล์ที่ไม่ใช้ → ลบทั้งหมด
 * + กุญแจปลอม / path แปลก ๆ ต้องถูกปฏิเสธ • จบแล้วไม่มีไฟล์ค้างบนระบบ
 *
 *   npx tsx scripts/smoke-docscan-cloud.mts [baseUrl] <username> <password>
 */
const base = process.argv[2] || 'http://localhost:3100';
const username = process.argv[3]!;
const password = process.argv[4]!;

const call = async (body: Record<string, unknown>) => {
  const response = await fetch(`${base}/api`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
  return response.json() as Promise<any>;
};
let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (ok) pass++; else fail++;
};

const bad = await call({ action: 'scanCloudLogin', username, password: password + 'x' });
check('รหัสผิด = เข้าไม่ได้', !bad.ok && bad.error === 'invalid_credentials', bad.error);

const login = await call({ action: 'scanCloudLogin', username, password });
check('เข้าสู่ระบบได้กุญแจ', login.ok && typeof login.cloudToken === 'string', login.error);
const cloudToken = login.cloudToken;
const info = await call({ action: 'scanCloudInfo', cloudToken });
check('ตรวจกุญแจ', info.ok && info.username === login.username, info.error);

const [payload, sig] = String(cloudToken).split('.');
const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), u: 'admin' })).toString('base64url');
const forge = await call({ action: 'scanCloudInfo', cloudToken: `${forged}.${sig}` });
check('กุญแจปลอม (แก้ชื่อผู้ใช้) = ถูกปฏิเสธ', !forge.ok && forge.error === 'cloud_login_required', forge.error);
const noTok = await call({ action: 'scanCloudList' });
check('ไม่มีกุญแจ = ถูกปฏิเสธ', !noTok.ok && noTok.error === 'cloud_login_required', noTok.error);
for (const f of ['../x/a.jpg', 'smoke-doc-1/../../a.jpg', 'smoke-doc-1/a.exe', 'abc/a.jpg', 'smoke doc/a.jpg']) {
  const r = await call({ action: 'scanCloudSign', cloudToken, files: [f] });
  check(`path แปลก "${f}" = ถูกปฏิเสธ`, !r.ok && r.error === 'bad_request', r.error);
}

const docId = `smoke-${Date.now()}`;
const img = new Uint8Array(300_000).map((_, i) => (i * 31) % 251);
const files = [`${docId}/a1.jpg`, `${docId}/a2.jpg`, `${docId}/doc.json`];
const signed = await call({ action: 'scanCloudSign', cloudToken, files });
check('ขอลิงก์อัป 3 ไฟล์', signed.ok && signed.uploads?.length === 3, signed.error);
for (const u of signed.uploads || []) {
  const isJson = u.file.endsWith('.json');
  const body = isJson ? JSON.stringify({ v: 1, doc: { id: docId, name: 'smoke' }, pages: [] }) : img;
  const res = await fetch(u.url, { method: 'PUT', headers: { 'Content-Type': isJson ? 'application/json' : 'image/jpeg' }, body });
  check(`PUT ${u.file}`, res.ok, `${res.status}`);
}
// อัปทับ doc.json (upsert) ต้องได้
const again = await call({ action: 'scanCloudSign', cloudToken, files: [`${docId}/doc.json`] });
const reput = await fetch(again.uploads[0].url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, doc: { id: docId, name: 'smoke-2' }, pages: [] }) });
check('อัปทับ doc.json', reput.ok, `${reput.status}`);

const got = await call({ action: 'scanCloudGet', cloudToken, files: [`${docId}/a1.jpg`] });
check('ขอลิงก์ดาวน์โหลด', got.ok && !!got.urls?.[0]?.url, got.error);
const dl = new Uint8Array(await (await fetch(got.urls[0].url)).arrayBuffer());
check('ไฟล์ที่ดาวน์โหลดตรงกับที่อัป', dl.length === img.length && dl.every((b, i) => b === img[i]), `${dl.length} ไบต์`);

const list = await call({ action: 'scanCloudList', cloudToken });
check('รายการเอกสารมีเอกสารทดสอบ', list.ok && list.docs.includes(docId), list.error || JSON.stringify(list.docs));
const mans = await call({ action: 'scanCloudManifests', cloudToken, ids: [docId] });
check('อ่าน doc.json (ฉบับล่าสุด)', mans.ok && mans.manifests?.[0]?.doc?.name === 'smoke-2', JSON.stringify(mans.manifests?.[0]?.doc));

const prune = await call({ action: 'scanCloudPrune', cloudToken, docId, keep: ['a1.jpg', 'doc.json'] });
check('ลบไฟล์ที่ไม่ใช้ (a2.jpg)', prune.ok && prune.removed === 1, JSON.stringify(prune));
const gone = await call({ action: 'scanCloudGet', cloudToken, files: [`${docId}/a2.jpg`] });
check('a2.jpg หายจากระบบแล้ว', gone.ok && !gone.urls[0].url, JSON.stringify(gone.urls?.[0]));

const all = await call({ action: 'scanCloudPrune', cloudToken, docId, keep: [] });
check('ลบเอกสารออกจากระบบทั้งหมด', all.ok && all.removed === 2, JSON.stringify(all));
const after = await call({ action: 'scanCloudList', cloudToken });
check('ไม่เหลือไฟล์ค้าง', after.ok && !after.docs.includes(docId), JSON.stringify(after.docs));

console.log(`\n${pass} ผ่าน, ${fail} ไม่ผ่าน`);
process.exit(fail ? 1 : 0);
