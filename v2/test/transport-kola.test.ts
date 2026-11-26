import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanImport } from '../src/lib/transport-clean';

/** ตัวตรวจแถว Transport Request — ใช้ร่วมกันทั้งปุ่มนำเข้าเดิมและที่ ERP-KOLA ส่งมา */

test('cleanImport keeps TRANSPORT date and flags CON mismatch', () => {
  const [row] = cleanImport([{ transportDate: '2026-11-27', bl: 'AMP0572751A', containers: 'SEKU6323323,TLLU7829812', quantity: 3 }]);
  assert.equal(row.error, undefined);
  assert.equal(row.transportDate, '2026-11-27');
  assert.equal(row.warning, 'CON 3 แต่มีเลขตู้ 2 ตู้');
  assert.equal(row.containers.length, 2);
});

test('cleanImport rejects bad date', () => {
  const [row] = cleanImport([{ transportDate: '2026-02-30', bl: 'AMP0572751A', containers: '' }]);
  assert.equal(row.error, 'วันที่ TRANSPORT ไม่ถูกต้อง');
});
