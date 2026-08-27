/**
 * ทดสอบตัวอ่านค่าจากข้อความสลิป — ใช้ข้อความแบบที่ OCR อ่านสลิปธนาคารไทยได้จริง
 *   npx tsx scripts/test-slip-parse.mts
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'x';
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:6543/postgres';

const { parseText } = await import('../src/lib/slip.ts');

type Case = { bank: string; text: string; amount: number; date: string; txn: string };

const cases: Case[] = [
  {
    bank: 'กสิกร K PLUS (ย่อไทย + พ.ศ.)',
    text: 'K PLUS โอนเงินสำเร็จ 27 ส.ค. 2569 14:32 น. จำนวน 1,060.80 บาท เลขที่รายการ 015082712345678',
    amount: 1060.8, date: '2026-08-27', txn: '015082712345678'
  },
  {
    bank: 'ไทยพาณิชย์ SCB (พ.ศ. 2 หลัก)',
    text: 'SCB EASY โอนเงินสำเร็จ 27 ส.ค. 69 14:32 จำนวนเงิน 1,060.80 บาท รหัสอ้างอิง SCB2569082700123',
    amount: 1060.8, date: '2026-08-27', txn: 'SCB2569082700123'
  },
  {
    bank: 'ปี พ.ศ. 2 หลักของปีก่อน',
    text: 'K PLUS โอนเงินสำเร็จ 27 ส.ค. 68 จำนวน 100.00 บาท เลขที่รายการ 015082700000001',
    amount: 100, date: '2025-08-27', txn: '015082700000001'
  },
  {
    bank: 'ยอดจำนวนเต็มไม่มีทศนิยม',
    text: 'ออมสิน MyMo โอนสำเร็จ 27 ส.ค. 2569 จำนวน 500 บาท เลขที่รายการ GSB082700112233',
    amount: 500, date: '2026-08-27', txn: 'GSB082700112233'
  },
  {
    bank: 'กรุงเทพ BBL (ตัวเลขล้วน พ.ศ.)',
    text: 'Bangkok Bank โอนเงินสำเร็จ 27/08/2569 จำนวน 530.40 บาท เลขที่อ้างอิง BBL0827001234',
    amount: 530.4, date: '2026-08-27', txn: 'BBL0827001234'
  },
  {
    bank: 'พร้อมเพย์ (อังกฤษ ค.ศ.)',
    text: 'PromptPay Transfer Successful 27 Aug 2026 14:32 Amount 2,000.00 THB Reference No. PP123456789012',
    amount: 2000, date: '2026-08-27', txn: 'PP123456789012'
  },
  {
    bank: 'กรุงไทย NEXT (เดือนไทยเต็ม)',
    text: 'Krungthai NEXT รายการสำเร็จ วันที่ 27 สิงหาคม 2569 เวลา 14:32 น. ยอด 1,060.80 บาท เลขที่รายการ KTB998877665544',
    amount: 1060.8, date: '2026-08-27', txn: 'KTB998877665544'
  },
  {
    bank: 'กรุงศรี (ค.ศ. แบบ ISO)',
    text: 'Krungsri Mobile Transfer complete 2026-08-27 14:32 Amount 750.00 Baht Transaction ID KMA26082700099',
    amount: 750, date: '2026-08-27', txn: 'KMA26082700099'
  },
  {
    bank: 'ttb (จุดคั่นวันที่)',
    text: 'ttb touch โอนสำเร็จ 27.08.2569 จำนวน 1,200.50 บาท เลขที่รายการ TTB0827556677',
    amount: 1200.5, date: '2026-08-27', txn: 'TTB0827556677'
  }
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = parseText(c.text);
  const amountOk = (r.amounts || []).includes(c.amount);
  const dateOk = (r.dates || []).includes(c.date);
  const txnOk = r.txn === c.txn;
  const ok = amountOk && dateOk && txnOk;
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${c.bank}`);
  if (!ok) {
    if (!amountOk) console.log(`       ยอด   ต้องได้ ${c.amount} แต่ได้ [${(r.amounts || []).join(', ')}]`);
    if (!dateOk) console.log(`       วันที่ ต้องได้ ${c.date} แต่ได้ [${(r.dates || []).join(', ') || '—'}]`);
    if (!txnOk) console.log(`       เลขที่ ต้องได้ ${c.txn} แต่ได้ ${r.txn || '—'}`);
  }
}

console.log(`\nผ่าน ${pass} / ไม่ผ่าน ${fail}`);
process.exit(fail ? 1 : 0);
