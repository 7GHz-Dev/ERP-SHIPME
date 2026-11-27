import test from 'node:test';
import assert from 'node:assert/strict';

// withholding.ts import db ตอนโหลด (ยังไม่ต่อจริงจนกว่าจะ query) — ใส่ค่าหลอกให้ requireEnv ผ่าน
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const entry = (bl: string, amount: number) => ({ date: '2026-11-20', bl, amount, raw: String(amount), note: '', tab: 'พ.ย.' });

test('KNOT GLOBAL DO uses fixed base 1,000 and withholding 30 (sheet amount not used)', async () => {
  const { buildDoLines } = await import('../src/lib/withholding');
  const vessels = new Map([['KG1042026-74915(AMP0574862)', 'KNOT GLOBAL'], ['SEAL1', 'SEALS']]);
  const { lines } = buildDoLines([entry('KG1042026-74915(AMP0574862)', 18300), entry('SEAL1', 5200)], vessels, '2026-11-01', '2026-11-30');
  const knot = lines.find((l) => l.vessel === 'KNOT GLOBAL')!;
  assert.deepEqual((knot as any).fixed, { base: 1000, wht: 30 });
  const seal = lines.find((l) => l.vessel === 'SEALS')!;
  assert.equal((seal as any).fixed, undefined);
  assert.equal(seal.amount, 5200);
});

import fs from 'node:fs';
import vm from 'node:vm';

test('withholding page shows "-" for sheet amount and uses fixed base/withholding', () => {
  const ctx: Record<string, any> = { $: () => ({ value: '1.04' }) };
  vm.runInNewContext(fs.readFileSync(new URL('../public/withholding.js', import.meta.url), 'utf8'), ctx);
  const knot = { category: 'DO', amount: 18300, fixed: { base: 1000, wht: 30 } };
  const seal = { category: 'DO', amount: 5200 };
  assert.equal(ctx.whtSheetText(knot), '-');
  assert.equal(ctx.whtSheet(knot), 0);
  assert.equal(ctx.whtBase(knot), 1000);
  assert.equal(ctx.whtAmount(knot), 30);
  assert.equal(ctx.whtSheetText(seal), '5,200.00');
  assert.equal(ctx.whtBase(seal), 5000);
});
