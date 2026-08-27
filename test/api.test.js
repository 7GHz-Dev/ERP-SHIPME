import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-fastify-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = testData;
process.env.ADMIN_PASSWORD = 'test-admin-password';

const { buildServer } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const app = buildServer();
await app.ready();

async function action(payload) {
  const response = await app.inject({ method: 'POST', url: '/api', payload });
  assert.equal(response.statusCode, 200);
  return response.json();
}

test.after(async () => {
  await app.close();
  db.close();
  fs.rmSync(testData, { recursive: true, force: true });
});

test('health endpoint identifies the new stack', async () => {
  const response = await app.inject({ method: 'GET', url: '/api' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().stack, 'Fastify + SQLite');
});

test('serves both frontends from the same origin', async () => {
  const employee = await app.inject({ method: 'GET', url: '/' });
  const admin = await app.inject({ method: 'GET', url: '/admin' });
  assert.equal(employee.statusCode, 200);
  assert.equal(admin.statusCode, 200);
  assert.match(employee.body, /var API_URL = '\/api'/);
  assert.match(admin.body, /var API_URL = '\/api'/);
});

test('core attendance, claim, and settlement flow', async () => {
  const adminLogin = await action({ action: 'login', username: 'admin', password: 'test-admin-password' });
  assert.equal(adminLogin.ok, true);

  const employee = await action({
    action: 'saveEmployee', token: adminLogin.token,
    employee: { username: 'office01', password: 'pass1234', name: 'Office Test', role: 'employee-office', active: 'yes' }
  });
  assert.equal(employee.mode, 'created');

  const login = await action({ action: 'login', username: 'office01', password: 'pass1234', device: 'Windows' });
  assert.equal(login.user.policy.device, 'windows');

  const checked = await action({
    action: 'checkin', token: login.token, type: 'in', userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
    lat: 13.7563, lng: 100.5018, accuracy: 25, deviceTime: new Date().toISOString()
  });
  assert.equal(checked.ok, true);

  const duplicate = await action({
    action: 'checkin', token: login.token, type: 'in', userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
    lat: 13.7563, lng: 100.5018, accuracy: 25
  });
  assert.equal(duplicate.error, 'already_checked_in');

  const inspectDate = '2026-08-26';
  const claim = await action({
    action: 'saveClaim', token: login.token,
    claim: { inspectDate, containers: 1, items: [{ key: 'reserve', amount: 1000 }] }
  });
  assert.equal(claim.ok, true);
  assert.equal(claim.record.total, 1000);

  const settlement = await action({
    action: 'saveSettlement', token: login.token,
    settlement: {
      inspectDate,
      rows: [{ bl: 'BL-TEST', containers: 1, costs: { lift_on: 1200 } }]
    }
  });
  assert.equal(settlement.ok, true);
  assert.equal(settlement.record.balance, -200);

  const report = await action({ action: 'report', token: adminLogin.token });
  assert.equal(report.rows.length, 1);

  await action({
    action: 'saveEmployee', token: adminLogin.token,
    employee: { username: 'ship01', password: 'ship-pass', name: 'Shipping Test', role: 'employee-shipping', active: 'yes' }
  });
  const shipping = await action({ action: 'login', username: 'ship01', password: 'ship-pass', device: 'Android' });
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const shippingDate = '2026-08-25';

  const receipt = await action({
    action: 'saveReceipt', token: shipping.token, inspectDate: shippingDate,
    userAgent: 'Mozilla/5.0 (Linux; Android 14)', photo: image, lat: 13.7, lng: 100.5, accuracy: 20
  });
  assert.equal(receipt.ok, true);

  await action({
    action: 'saveClaim', token: shipping.token,
    claim: { inspectDate: shippingDate, containers: 1, items: [{ key: 'reserve', amount: 1000 }] }
  });
  const uploadedSlip = await action({
    action: 'verifySlip', token: shipping.token, image,
    expectDate: shippingDate, expectAmount: 500
  });
  assert.equal(uploadedSlip.canManual, true);
  const manualSlip = await action({
    action: 'verifySlip', token: shipping.token, fileId: uploadedSlip.fileId,
    expectDate: shippingDate, expectAmount: 500,
    manual: { amount: 500, date: shippingDate, txn: 'TXN-TEST-0001' }
  });
  assert.equal(manualSlip.canSave, true);

  const positiveSettlement = await action({
    action: 'saveSettlement', token: shipping.token,
    settlement: {
      inspectDate: shippingDate, returnedDate: shippingDate,
      slip: { fileId: uploadedSlip.fileId },
      rows: [{ bl: 'BL-SHIP', containers: 1, costs: { lift_on: 500 } }]
    }
  });
  assert.equal(positiveSettlement.record.balance, 500);
  assert.equal(positiveSettlement.record.slipTxn, 'TXN-TEST-0001');
});
