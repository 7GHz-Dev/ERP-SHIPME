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

import { fetchKolaDo, kolaDocStatusUrl } from '../src/lib/doc-status-kola';

const cfg = { key: 'k', url: 'https://kola.example/api/shipme/special-charges' };

test('kolaDocStatusUrl uses the KOLA origin of KOLA_SPECIALS_URL', () => {
  assert.equal(kolaDocStatusUrl(cfg.url, ['A1', 'B 2']), 'https://kola.example/api/shipme/doc-status?bl=A1&bl=B+2');
});

test('fetchKolaDo returns null on network error', async () => {
  const r = await fetchKolaDo(['A1'], cfg, async () => { throw new Error('down'); });
  assert.equal(r, null);
});

test('fetchKolaDo returns null on 401', async () => {
  const r = await fetchKolaDo(['A1'], cfg, async () => new Response('{"ok":false}', { status: 401 }));
  assert.equal(r, null);
});

test('fetchKolaDo returns null without a key', async () => {
  let called = false;
  const r = await fetchKolaDo(['A1'], { key: '', url: cfg.url }, async () => { called = true; return new Response('{}'); });
  assert.equal(r, null);
  assert.equal(called, false);
});

test('fetchKolaDo maps found/doExchangedAt', async () => {
  const body = { ok: true, items: { A1: { found: true, doExchangedAt: '2026-11-20T00:00:00Z' }, B2: { found: true, doExchangedAt: null }, C3: { found: false } } };
  const r = await fetchKolaDo(['A1', 'B2', 'C3'], cfg, async () => new Response(JSON.stringify(body)));
  assert.equal(r?.get('A1'), 'yes');
  assert.equal(r?.get('B2'), 'no');
  assert.equal(r?.get('C3'), 'notfound');
});

test('fetchKolaDo chunks at 300 keys', async () => {
  let calls = 0;
  const keys = Array.from({ length: 301 }, (_, i) => `K${i}`);
  await fetchKolaDo(keys, cfg, async () => { calls++; return new Response('{"ok":true,"items":{}}'); });
  assert.equal(calls, 2);
});

import fs from 'node:fs';
import vm from 'node:vm';

test('docBadges shows ? when KOLA could not be asked, and links files', () => {
  const ctx: Record<string, any> = {};
  vm.runInNewContext(fs.readFileSync(new URL('../public/doc-badges.js', import.meta.url), 'utf8'), ctx);
  const docs = { AMP0572751A: { do: 'unknown', decl: { id: '1', url: 'https://x/a.pdf', fileName: 'A031.pdf' }, eoffice: null } };
  const html: string = ctx.docBadges(docs, 'amp 0572751a');
  assert.match(html, /\? DO/);
  assert.match(html, /href="https:\/\/x\/a\.pdf"[^>]*>✓ ใบขน/);
  assert.match(html, /✗ E-Office/);
  assert.equal(ctx.docBadges(docs, 'NOPE'), '');
});
