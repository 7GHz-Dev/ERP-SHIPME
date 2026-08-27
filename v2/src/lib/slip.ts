import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { slips } from '@/db/schema';
import { env } from './env';
import { downloadAsDataUrl, saveDataImage } from './storage';
import type { ApiBody, ApiResult } from './types';
import { id, nowIso, round2, safeJson, validYmd } from './utils';

const BANKS: [RegExp, string][] = [
  [/กสิกร|kasikorn|kbank|k\s*plus/i, 'กสิกรไทย (KBank)'],
  [/ไทยพาณิชย์|siam\s*commercial|scb/i, 'ไทยพาณิชย์ (SCB)'],
  [/กรุงเทพ|bangkok\s*bank|bualuang|bbl/i, 'กรุงเทพ (BBL)'],
  [/กรุงไทย|krungthai|ktb/i, 'กรุงไทย (KTB)'],
  [/กรุงศรี|krungsri|ayudhya|kma/i, 'กรุงศรีอยุธยา (Krungsri)'],
  [/ทหารไทยธนชาต|ttb|tmbthanachart|thanachart|ธนชาต/i, 'ทีทีบี (ttb)'],
  [/ออมสิน|gsb|mymo/i, 'ออมสิน (GSB)'],
  [/พร้อมเพย์|promptpay/i, 'พร้อมเพย์ (PromptPay)']
];

export type SlipInfo = {
  v?: number; user?: string; uploaded?: string;
  ocr?: string; detail?: string; sample?: string;
  amounts?: number[]; dates?: string[];
  amount?: number; date?: string; txn?: string; bank?: string;
  manual?: { amount: number; date: string; txn: string };
  manualBy?: string; manualAt?: string;
};

function parseAmounts(text: unknown) {
  const values: number[] = [];
  for (const match of String(text || '').matchAll(/(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2})/g)) {
    const value = Number(match[1].replace(/,/g, ''));
    if (value > 0 && value < 100000000 && !values.includes(value)) values.push(value);
  }
  return values.slice(0, 40);
}

function parseDates(text: unknown) {
  const out: string[] = [];
  for (const match of String(text || '').matchAll(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/g)) {
    let year = Number(match[3]);
    if (year > 2400) year -= 543;                 // สลิปไทยมักเป็น พ.ศ.
    const value = `${year}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
    if (!out.includes(value)) out.push(value);
  }
  for (const match of String(text || '').matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    const value = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function parseText(text: unknown) {
  const source = String(text || '');
  const amounts = parseAmounts(source);
  const dates = parseDates(source);
  const txnMatch = /(?:เลขที่รายการ|เลขรายการ|รหัสอ้างอิง|เลขอ้างอิง|transaction(?:\s*id)?|reference(?:\s*no)?|ref\s*no)\s*[:#-]?\s*([A-Z0-9-]{6,60})/i.exec(source);
  const bank = BANKS.find(([pattern]) => pattern.test(source))?.[1] || '';
  return { amounts, dates, amount: amounts[0] || 0, date: dates[0] || '', txn: txnMatch?.[1] || '', bank };
}

async function runOcr(image: string): Promise<Partial<SlipInfo>> {
  if (!env.ocrEndpoint) return { ocr: 'slip_ocr_unavailable', detail: 'ยังไม่ได้ตั้งค่า OCR_ENDPOINT' };
  try {
    const response = await fetch(env.ocrEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image }),
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`OCR HTTP ${response.status}`);
    const body = await response.json();
    return { ocr: 'ok', ...parseText(body.text || ''), sample: String(body.text || '').replace(/\s+/g, ' ').slice(0, 300) };
  } catch (error) {
    return { ocr: 'slip_ocr_failed', detail: String((error as Error).message || error) };
  }
}

export type SlipCheck = {
  status: 'verified' | 'manual' | 'mismatch' | 'unreadable';
  label: string; amountOk: boolean; dateOk: boolean; manual?: boolean;
};

function checkSlip(info: SlipInfo, expectDate: unknown, expectAmount: unknown): SlipCheck {
  const amounts = info.amounts || [];
  const dates = info.dates || [];
  const amountOk = amounts.some((amount) => Math.abs(amount - Number(expectAmount)) <= env.slipAmountTolerance);
  const dateOk = dates.includes(String(expectDate || ''));
  const readable = info.ocr === 'ok' && (amounts.length > 0 || dates.length > 0);

  // OCR อ่านไม่ออกแต่พนักงานกรอกค่าจากสลิปเอง — ยอมให้บันทึกได้ แต่ติดสถานะรอผู้ดูแลตรวจ
  if (!readable && info.manual) {
    const manualAmountOk = Math.abs((Number(info.manual.amount) || 0) - Number(expectAmount)) <= env.slipAmountTolerance;
    const manualDateOk = String(info.manual.date || '') === String(expectDate || '');
    const transactionOk = Boolean(String(info.manual.txn || '').trim());
    if (manualAmountOk && manualDateOk && transactionOk) {
      return { status: 'manual', label: 'กรอกค่าจากสลิปเอง — รอผู้ดูแลตรวจสลิป', amountOk: true, dateOk: true, manual: true };
    }
    return {
      status: 'mismatch', amountOk: manualAmountOk, dateOk: manualDateOk, manual: true,
      label: !transactionOk
        ? 'ต้องกรอกเลขที่รายการในสลิปด้วย'
        : (!manualAmountOk ? 'ยอดที่กรอกไม่ตรงกับยอดที่ต้องโอนคืน' : 'วันที่ที่กรอกไม่ตรงกับวันที่โอนคืนที่เลือก')
    };
  }
  if (!readable) {
    return { status: 'unreadable', label: 'อ่านข้อมูลในสลิปอัตโนมัติไม่ได้ (กรอกค่าจากสลิปเองได้)', amountOk: false, dateOk: false };
  }
  if (amountOk && dateOk) {
    return { status: 'verified', label: 'ตรวจอัตโนมัติผ่าน (ยอดและวันที่ตรง)', amountOk, dateOk };
  }
  return {
    status: 'mismatch', amountOk, dateOk,
    label: !amountOk && !dateOk
      ? 'ยอดเงินและวันที่ในสลิปไม่ตรงกับที่ต้องโอน'
      : (!amountOk ? 'ยอดเงินในสลิปไม่ตรงกับยอดที่ต้องโอนคืน' : 'วันที่ในสลิปไม่ตรงกับวันที่โอนคืนที่เลือก')
  };
}

function slipResponse(idValue: string, url: string, info: SlipInfo, expectDate: string, expectAmount: number) {
  const checked = checkSlip(info, expectDate, expectAmount);
  const values = (info.manual || info) as { amount?: number; date?: string; txn?: string };
  return {
    ok: true, fileId: idValue, url,
    amount: values.amount || 0, date: values.date || '', txn: values.txn || '', bank: info.bank || '',
    ocr: info.ocr, ocrDetail: info.detail || '', sample: info.sample || '', isManual: Boolean(checked.manual),
    status: checked.status, label: checked.label, amountOk: checked.amountOk, dateOk: checked.dateOk,
    strict: env.slipStrict,
    canSave: checked.status === 'verified' || checked.status === 'manual'
      || (checked.status === 'unreadable' && !env.slipStrict),
    canManual: checked.status === 'unreadable' || checked.status === 'manual'
  };
}

export async function verifySlip(body: ApiBody, user: { username: string }): Promise<ApiResult> {
  const expectDate = String(body.expectDate || '').trim();
  const expectAmount = round2(body.expectAmount);
  if (!validYmd(expectDate)) return { ok: false, error: 'returned_date_required' };
  if (!(expectAmount > 0)) return { ok: false, error: 'slip_not_required' };

  let row: { id: string; url: string; infoJson: string; username: string; fileName: string };

  if (body.image) {
    const fileId = id('SP');
    const file = await saveDataImage(body.image, 'slips', `${expectDate}_${user.username}_${fileId}`);
    const info: SlipInfo = {
      v: 1, user: user.username.toLowerCase(), uploaded: nowIso(), ...(await runOcr(body.image))
    };
    await db.insert(slips).values({
      id: fileId, username: user.username, uploadedAt: info.uploaded!,
      fileName: file.id, url: file.url, infoJson: JSON.stringify(info)
    });
    row = { id: fileId, url: file.url, infoJson: JSON.stringify(info), username: user.username, fileName: file.id };
  } else {
    const [found] = await db.select().from(slips).where(eq(slips.id, String(body.fileId || ''))).limit(1);
    if (!found) return { ok: false, error: 'slip_not_found' };
    if (found.username.toLowerCase() !== user.username.toLowerCase()) return { ok: false, error: 'forbidden' };
    row = found;
  }

  const info = safeJson<SlipInfo>(row.infoJson, {});

  if (body.retryOcr && !body.image) {
    if (!env.ocrEndpoint) return slipResponse(row.id, row.url, info, expectDate, expectAmount);
    const dataUrl = await downloadAsDataUrl(row.fileName);
    if (dataUrl) Object.assign(info, await runOcr(dataUrl));
  }

  if (body.manual) {
    // OCR อ่านออกอยู่แล้ว = ห้ามกรอกทับ กันแก้ยอดให้ตรงเอง
    const readable = info.ocr === 'ok' && ((info.amounts || []).length > 0 || (info.dates || []).length > 0);
    if (readable) return { ok: false, error: 'slip_manual_not_allowed' };
    info.manual = {
      amount: round2(body.manual.amount),
      date: validYmd(body.manual.date) ? String(body.manual.date) : '',
      txn: String(body.manual.txn || '').trim().slice(0, 60)
    };
    info.manualBy = user.username.toLowerCase();
    info.manualAt = nowIso();
  }

  await db.update(slips).set({ infoJson: JSON.stringify(info) }).where(eq(slips.id, row.id));
  return slipResponse(row.id, row.url, info, expectDate, expectAmount);
}

export async function getSlip(fileId: unknown, username?: string) {
  const [row] = await db.select().from(slips).where(eq(slips.id, String(fileId || ''))).limit(1);
  if (!row) return { ok: false as const, error: 'slip_not_found' };
  if (username && row.username.toLowerCase() !== String(username).toLowerCase()) {
    return { ok: false as const, error: 'forbidden' };
  }
  return { ok: true as const, row, info: safeJson<SlipInfo>(row.infoJson, {}) };
}

export function checkStoredSlip(info: SlipInfo, expectDate: unknown, expectAmount: unknown) {
  return checkSlip(info, expectDate, expectAmount);
}

export function ocrDiagnostics() {
  return {
    ok: true,
    driveService: false,
    v2: false,
    strict: env.slipStrict,
    status: env.ocrEndpoint ? 'ok' : 'not_configured',
    message: env.ocrEndpoint
      ? 'ตั้งค่า OCR endpoint แล้ว ระบบจะตรวจเมื่ออัปโหลดสลิป'
      : 'ไม่ได้ใช้ Google Drive OCR; ขณะนี้ใช้การกรอกค่าจากสลิปเอง หรือตั้ง OCR_ENDPOINT เพื่อเปิดตรวจอัตโนมัติ'
  };
}
