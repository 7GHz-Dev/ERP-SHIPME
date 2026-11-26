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

import { docKey, validDocInput } from '../src/lib/transport-docs-rules';

test('docKey strips everything but A-Z0-9', () => {
  assert.equal(docKey(' kg1042026-74915(amp0574862) '), 'KG104202674915AMP0574862');
});

test('validDocInput rejects non-pdf, >20MB, bad kind', () => {
  const ok = { bl: 'X1', kind: 'DECL', fileName: 'a.pdf', size: 1000 };
  assert.equal(validDocInput({ ...ok, size: 20 * 1024 * 1024 + 1 }), 'file_too_large');
  assert.equal(validDocInput({ ...ok, kind: 'OTHER' }), 'bad_kind');
  assert.equal(validDocInput({ ...ok, fileName: 'a.jpg' }), 'pdf_only');
  assert.equal(validDocInput({ ...ok, bl: '' }), 'bad_bl');
  assert.equal(validDocInput(ok), null);
  assert.equal(validDocInput({ ...ok, kind: 'EOFFICE', fileName: 'AMP0572751A E-744810.PDF' }), null);
});
