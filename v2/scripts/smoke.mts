/**
 * ยิง API จริงผ่าน HTTP เหมือนที่หน้าเว็บทำ เพื่อดูว่า v2 ตอบเหมือนระบบเดิมไหม
 *   npx tsx scripts/smoke.mts [baseUrl] [username] [password]
 */
const base = process.argv[2] || 'http://localhost:3100';
const username = process.argv[3] || 'admin';
const password = process.argv[4] || '';

const call = async (body: Record<string, unknown>) => {
  const response = await fetch(`${base}/api`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },   // เหมือนที่หน้าเว็บส่งมา
    body: JSON.stringify(body)
  });
  return response.json() as Promise<any>;
};

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

console.log('== ไม่ต้องล็อกอิน ==');
const health = await fetch(`${base}/api`).then((r) => r.json());
check('GET /api ตอบ ok', health.ok === true, health.stack);
check('token ผิด = invalid_token', (await call({ action: 'me', token: 'x' })).error === 'invalid_token');
check('action มั่ว = unknown_action', (await call({ action: 'zzz' })).error === 'unknown_action');
check('รหัสผิด = invalid_credentials',
  (await call({ action: 'login', username, password: 'ผิดแน่นอน' })).error === 'invalid_credentials');

if (!password) {
  console.log('\n(ไม่ได้ใส่รหัสผ่าน — ข้ามการทดสอบส่วนที่ต้องล็อกอิน)');
  console.log(`\nผ่าน ${pass} / ไม่ผ่าน ${fail}`);
  process.exit(fail ? 1 : 0);
}

console.log('\n== ล็อกอินด้วยรหัสเดิมจากระบบเก่า ==');
const loggedIn = await call({ action: 'login', username, password });
check('login สำเร็จ', loggedIn.ok === true, loggedIn.error || loggedIn.user?.role);
if (!loggedIn.ok) {
  console.log(`\nผ่าน ${pass} / ไม่ผ่าน ${fail}`);
  process.exit(1);
}
const token = loggedIn.token;

// ชื่อผู้ใช้ต้องเทียบแบบไม่สนตัวพิมพ์เหมือน COLLATE NOCASE เดิม
check('ล็อกอินด้วยตัวพิมพ์ใหญ่ก็ได้ (citext)',
  (await call({ action: 'login', username: username.toUpperCase(), password })).ok === true);

console.log('\n== อ่านข้อมูลที่ย้ายมา ==');
const me = await call({ action: 'me', token });
check('me คืนผู้ใช้', me.ok && me.user?.username?.toLowerCase() === username.toLowerCase(), me.user?.name);

const today = await call({ action: 'todayStatus', token });
check('todayStatus ตอบได้', today.ok === true, `checkedIn=${today.checkedIn}`);

const mine = await call({ action: 'myCheckins', token });
check('myCheckins ตอบได้', mine.ok === true, `${mine.rows?.length ?? 0} แถว`);

const options = await call({ action: 'appOptions', token });
check('appOptions มีรายการท่า', options.ok && Array.isArray(options.ports), `${options.ports?.length} ท่า`);
check('emPorts ย้ายมาครบ', Array.isArray(options.emPorts), (options.emPorts || []).join(', '));

const claimCfg = await call({ action: 'claimConfig', token });
const em = (claimCfg.items || []).find((i: any) => i.key === 'extra_movement');
check('claimConfig มี 12 หัวข้อ', claimCfg.items?.length === 12, `${claimCfg.items?.length}`);
check('EXTRA MOVEMENT ขั้นต่ำ 2 ตู้', em?.minContainers === 2, `minContainers=${em?.minContainers}, rate=${em?.rate}`);

const claims = await call({ action: 'myClaims', token });
check('myClaims ตอบได้', claims.ok === true, `${claims.rows?.length ?? 0} ใบ / ปิดบัญชีแล้ว ${claims.settledDates?.length ?? 0} วัน`);

const receipts = await call({ action: 'myReceipts', token });
check('myReceipts ตอบได้', receipts.ok === true, `${receipts.rows?.length ?? 0} แถว`);

const leaves = await call({ action: 'myLeaves', token });
check('myLeaves ตอบได้', leaves.ok === true, `${leaves.rows?.length ?? 0} แถว`);

if (me.user?.role === 'admin') {
  console.log('\n== เฉพาะ admin ==');
  const employees = await call({ action: 'listEmployees', token });
  check('listEmployees ครบ', employees.ok === true, `${employees.rows?.length ?? 0} คน`);
  const report = await call({ action: 'report', token });
  check('report ตอบได้', report.ok === true, `${report.rows?.length ?? 0} แถว`);
  const all = await call({ action: 'listClaims', token });
  check('listClaims ตอบได้', all.ok === true, `${all.rows?.length ?? 0} ใบ`);
}

console.log('\n== action ที่ยังไม่พอร์ต ต้องบอกชัดว่ายังไม่มี ==');
const settle = await call({ action: 'settleConfig', token });
check('settleConfig = not_implemented', settle.error === 'not_implemented', settle.detail);

console.log(`\nผ่าน ${pass} / ไม่ผ่าน ${fail}`);
process.exit(fail ? 1 : 0);
