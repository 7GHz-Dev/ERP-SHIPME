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

console.log('\n== ล็อกอิน ==');
const loggedIn = await call({ action: 'login', username, password });
check('login สำเร็จ', loggedIn.ok === true, loggedIn.error || loggedIn.user?.role);
if (!loggedIn.ok) { console.log(`\nผ่าน ${pass} / ไม่ผ่าน ${fail}`); process.exit(1); }
const token = loggedIn.token;
check('ล็อกอินด้วยตัวพิมพ์ใหญ่ก็ได้ (citext)',
  (await call({ action: 'login', username: username.toUpperCase(), password })).ok === true);

console.log('\n== เช็กอิน / ใบเสร็จ / ลา ==');
const me = await call({ action: 'me', token });
check('me', me.ok && me.user?.username?.toLowerCase() === username.toLowerCase(), me.user?.name);
check('todayStatus', (await call({ action: 'todayStatus', token })).ok === true);
check('myCheckins', (await call({ action: 'myCheckins', token })).ok === true);
check('myReceipts', (await call({ action: 'myReceipts', token })).ok === true);
check('myLeaves', (await call({ action: 'myLeaves', token })).ok === true);
check('requestLeave ตรวจข้อมูลไม่ครบ',
  (await call({ action: 'requestLeave', token, leaveType: '', startDate: '' })).error === 'missing_leave_fields');
check('requestLeave ตรวจช่วงวันที่กลับหลัง',
  (await call({ action: 'requestLeave', token, leaveType: 'ลากิจ', startDate: '2026-08-20', endDate: '2026-08-10' })).error === 'invalid_date_range');

console.log('\n== ตัวเลือกระบบ ==');
const options = await call({ action: 'appOptions', token });
check('appOptions มีรายการท่า', options.ok && Array.isArray(options.ports), `${options.ports?.length} ท่า`);
check('emPorts ย้ายมาครบ', Array.isArray(options.emPorts), (options.emPorts || []).join(', '));
check('sheetDefs มีมา', Array.isArray(options.sheetDefs?.cols), `${options.sheetDefs?.cols?.length} คอลัมน์`);

console.log('\n== การเบิก ==');
const claimCfg = await call({ action: 'claimConfig', token });
const em = (claimCfg.items || []).find((i: any) => i.key === 'extra_movement');
check('claimConfig 12 หัวข้อ', claimCfg.items?.length === 12, `${claimCfg.items?.length}`);
check('EXTRA MOVEMENT ขั้นต่ำ 2 ตู้', em?.minContainers === 2, `rate=${em?.rate}`);
const claims = await call({ action: 'myClaims', token });
check('myClaims', claims.ok === true, `${claims.rows?.length ?? 0} ใบ`);
check('saveClaim ตรวจวันที่', (await call({ action: 'saveClaim', token, claim: {} })).error === 'missing_inspect_date');
check('saveClaim ตรวจจำนวนตู้',
  (await call({ action: 'saveClaim', token, claim: { inspectDate: '2026-08-27', containers: 0 } })).error === 'invalid_containers');

console.log('\n== งานขนส่ง ==');
check('blLookup ตรวจวันที่', (await call({ action: 'blLookup', token, date: '' })).error === 'missing_inspect_date');
const bl = await call({ action: 'blLookup', token, date: '2026-08-01' });
check('blLookup ตอบได้', bl.ok === true, `${bl.rows?.length ?? 0} BL / ${bl.totalContainers ?? 0} ตู้`);

console.log('\n== ปิดบัญชี ==');
const settle = await call({ action: 'settleConfig', token });
check('settleConfig 9 คอลัมน์', settle.ok && settle.columns?.length === 9, `${settle.columns?.length}`);
check('autoMin ส่ง EXTRA MOVEMENT = 2', settle.autoMin?.extra_movement === 2);
check('autoPorts ส่งท่าที่คิดให้', Array.isArray(settle.autoPorts?.extra_movement),
  (settle.autoPorts?.extra_movement || []).join(', '));
check('autoRates มีอัตรา', typeof settle.autoRates?.lift_on === 'number', `lift_on=${settle.autoRates?.lift_on}`);
const mySettle = await call({ action: 'mySettlements', token });
check('mySettlements', mySettle.ok === true, `${mySettle.rows?.length ?? 0} ใบ`);
check('saveSettlement ตรวจวันที่',
  (await call({ action: 'saveSettlement', token, settlement: {} })).error === 'missing_inspect_date');
check('saveSettlement ตรวจว่าไม่มีรายการ',
  (await call({ action: 'saveSettlement', token, settlement: { inspectDate: '2026-08-27', rows: [] } })).error === 'no_settle_rows');
check('saveSettleImage ตรวจ input',
  (await call({ action: 'saveSettleImage', token })).error === 'bad_request');

console.log('\n== สลิป ==');
check('verifySlip ต้องมีวันที่โอนคืน',
  (await call({ action: 'verifySlip', token, expectDate: '' })).error === 'returned_date_required');
check('verifySlip ยอดไม่เป็นบวก = ไม่ต้องแนบ',
  (await call({ action: 'verifySlip', token, expectDate: '2026-08-27', expectAmount: 0 })).error === 'slip_not_required');
check('verifySlip หา fileId ไม่เจอ',
  (await call({ action: 'verifySlip', token, expectDate: '2026-08-27', expectAmount: 100, fileId: 'ไม่มีจริง' })).error === 'slip_not_found');

if (me.user?.role === 'admin' || me.user?.role === 'manager') {
  console.log('\n== เฉพาะ admin / manager ==');
  check('report', (await call({ action: 'report', token })).ok === true);
  check('listClaims', (await call({ action: 'listClaims', token })).ok === true);
  check('listSettlements', (await call({ action: 'listSettlements', token })).ok === true);
  check('listReceipts', (await call({ action: 'listReceipts', token })).ok === true);
  const diag = await call({ action: 'transportDiag', token });
  check('transportDiag', diag.ok === true, `${diag.sheets?.length ?? 0} แหล่งข้อมูล`);
  const ocr = await call({ action: 'slipOcrDiag', token });
  check('slipOcrDiag', ocr.ok === true, ocr.status);
}

if (me.user?.role === 'admin') {
  console.log('\n== เฉพาะ admin ==');
  const employees = await call({ action: 'listEmployees', token });
  check('listEmployees', employees.ok === true, `${employees.rows?.length ?? 0} คน`);
  check('listLeaves', (await call({ action: 'listLeaves', token })).ok === true);
  check('decideLeave ตรวจ decision',
    (await call({ action: 'decideLeave', token, id: 'x', decision: 'มั่ว' })).error === 'bad_request');
  check('decideLeave หาใบลาไม่เจอ',
    (await call({ action: 'decideLeave', token, id: 'ไม่มีจริง', decision: 'approved' })).error === 'leave_not_found');
  check('saveEmployee ต้องมี username',
    (await call({ action: 'saveEmployee', token, employee: {} })).error === 'missing_username');
}

console.log('\n== สิทธิ์ ==');
if (me.user?.role !== 'admin') {
  check('พนักงานเรียก listEmployees ไม่ได้',
    (await call({ action: 'listEmployees', token })).error === 'forbidden');
}

console.log(`\nผ่าน ${pass} / ไม่ผ่าน ${fail}`);
process.exit(fail ? 1 : 0);
