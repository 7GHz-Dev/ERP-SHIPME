/**
 * ทดสอบเส้นทางอัปโหลดรูปใหญ่ทั้งเส้น (signUpload → PUT → บันทึก)
 * ด้วยรูปที่ใหญ่เกินลิมิต 4.5 MB ของ Vercel เพื่อพิสูจน์ว่าเลี่ยงลิมิตได้จริง
 *
 *   npx tsx scripts/smoke-upload.mts [baseUrl] <username> <password>
 */
const base = process.argv[2] || 'http://localhost:3100';
const username = process.argv[3]!;
const password = process.argv[4]!;

const call = async (body: Record<string, unknown>) => {
  const response = await fetch(`${base}/api`, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body)
  });
  return response.json() as Promise<any>;
};

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const { token, ok: loggedIn } = await call({ action: 'login', username, password });
if (!loggedIn) { console.error('ล็อกอินไม่สำเร็จ'); process.exit(1); }

// หาใบปิดบัญชีสักใบมาใช้ทดสอบ
const settlements = await call({ action: 'listSettlements', token });
const target = settlements.rows?.[0];
if (!target) { console.error('ไม่มีใบปิดบัญชีให้ทดสอบ'); process.exit(1); }
console.log(`ใช้ใบปิดบัญชี ${target.id} (${target.inspectDate} • ${target.username})\n`);

// PNG ปลอมขนาด ~6 MB — ใหญ่กว่าลิมิต 4.5 MB ของ Vercel
const bigPng = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.alloc(6 * 1024 * 1024, 0x7a)
]);
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`ขนาดรูปทดสอบ: ${mb(bigPng.length)} (base64 จะเป็น ${mb(bigPng.length * 1.34)})`);

console.log('\n== เส้นทางเดิม: ส่ง base64 ผ่าน API ==');
const asDataUrl = `data:image/png;base64,${bigPng.toString('base64')}`;
const viaApi = await call({ action: 'saveSettleImage', token, id: target.id, image: asDataUrl });
console.log(`  (ผลลัพธ์: ${viaApi.ok ? 'ผ่าน' : viaApi.error}) — บน Vercel จริงจะโดน FUNCTION_PAYLOAD_TOO_LARGE ตรงนี้`);

console.log('\n== เส้นทางใหม่: อัปตรงไป Supabase ==');
const signed = await call({ action: 'signUpload', token, purpose: 'settlement', id: target.id });
check('ขอ signed upload ได้', signed.ok === true, signed.key || signed.error);
if (!signed.ok) { console.log(`\nผ่าน ${pass} / ไม่ผ่าน ${fail}`); process.exit(1); }

const put = await fetch(signed.uploadUrl, {
  method: 'PUT', headers: { 'content-type': 'image/png' }, body: bigPng
});
check(`อัปไฟล์ ${mb(bigPng.length)} ขึ้นตรงได้`, put.ok, `HTTP ${put.status}`);

const saved = await call({ action: 'saveSettleImage', token, id: target.id, key: signed.key });
check('บันทึกรูปเข้าใบปิดบัญชีได้', saved.ok === true, saved.url || saved.error);

console.log('\n== ความปลอดภัย ==');
const evil = await call({ action: 'saveSettleImage', token, id: target.id, key: 'settlements/../../etc/passwd.png' });
check('key ที่ไม่ใช่ของเซิร์ฟเวอร์ออกให้ = ปฏิเสธ', evil.error === 'bad_request', evil.error);
const notUploaded = await call({ action: 'signUpload', token, purpose: 'settlement', id: 'ไม่มีจริง' });
check('ขอ upload ให้ใบที่ไม่มี = ปฏิเสธ', notUploaded.error === 'settlement_not_found', notUploaded.error);
const badPurpose = await call({ action: 'signUpload', token, purpose: 'มั่ว' });
check('purpose มั่ว = bad_request', badPurpose.error === 'bad_request', badPurpose.error);

console.log('\n== เปิดรูปกลับมาดูได้ไหม ==');
const view = await fetch(`${base}${saved.url}`, { redirect: 'manual' });
check('/files/... redirect ไป signed URL', view.status === 307, `HTTP ${view.status}`);
const signedTarget = view.headers.get('location') || '';
check('ปลายทางเป็น Supabase Storage', signedTarget.includes('/storage/v1/'), signedTarget.slice(0, 60) + '…');
const image = await fetch(signedTarget);
const bytes = Buffer.from(await image.arrayBuffer());
check('โหลดไฟล์กลับมาได้ครบขนาดเดิม', bytes.length === bigPng.length, `${mb(bytes.length)}`);

console.log(`\nผ่าน ${pass} / ไม่ผ่าน ${fail}`);
process.exit(fail ? 1 : 0);
