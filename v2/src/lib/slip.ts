import { desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { slips } from '@/db/schema';
import { env } from './env';
import { createSignedUpload, downloadAsDataUrl, fileExists, saveDataImage } from './storage';
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
  const source = String(text || '');
  const values: number[] = [];
  const push = (raw: string) => {
    const value = Number(raw.replace(/,/g, ''));
    if (value > 0 && value < 100000000 && !values.includes(value)) values.push(value);
  };
  // มีคอมมาคั่นหลักพัน หรือมีทศนิยม 2 ตำแหน่ง — รูปแบบปกติของยอดเงินในสลิป
  for (const m of source.matchAll(/(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2})/g)) push(m[1]);
  // จำนวนเต็มที่มีหน่วยเงินกำกับ เช่น "จำนวน 500 บาท" (บางธนาคารตัด .00 ทิ้ง)
  for (const m of source.matchAll(/(\d{1,8})\s*(?:บาท|บ\.|THB|Baht)/gi)) push(m[1]);
  return values.slice(0, 40);
}

// สลิปไทยเขียนเดือนได้ทั้งชื่อเต็ม ตัวย่อมีจุด และภาษาอังกฤษ
const MONTHS: Record<string, number> = {};
[
  ['มกราคม', 'ม.ค.', 'january', 'jan'],
  ['กุมภาพันธ์', 'ก.พ.', 'february', 'feb'],
  ['มีนาคม', 'มี.ค.', 'march', 'mar'],
  ['เมษายน', 'เม.ย.', 'april', 'apr'],
  ['พฤษภาคม', 'พ.ค.', 'may'],
  ['มิถุนายน', 'มิ.ย.', 'june', 'jun'],
  ['กรกฎาคม', 'ก.ค.', 'july', 'jul'],
  ['สิงหาคม', 'ส.ค.', 'august', 'aug'],
  ['กันยายน', 'ก.ย.', 'september', 'sept', 'sep'],
  ['ตุลาคม', 'ต.ค.', 'october', 'oct'],
  ['พฤศจิกายน', 'พ.ย.', 'november', 'nov'],
  ['ธันวาคม', 'ธ.ค.', 'december', 'dec']
].forEach((names, index) => names.forEach((name) => { MONTHS[name.toLowerCase()] = index + 1; }));

const MONTH_PATTERN = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)                    // ชื่อยาวก่อน กัน "พ.ค." ไปชนกลางคำอื่น
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/**
 * ปีในสลิปมีทั้ง พ.ศ. และ ค.ศ. และมีทั้ง 4 หลักกับ 2 หลัก
 * 2 หลักเดาไม่ได้ตรง ๆ ("69" เป็นได้ทั้ง พ.ศ.2569 = ค.ศ.2026 และ ค.ศ.2069)
 * จึงลองทั้งสองแบบแล้วเลือกอันที่ตกอยู่ในช่วงเวลาที่เป็นไปได้จริง
 */
function normalizeYear(raw: string): number | null {
  const now = new Date().getFullYear();
  const inRange = (year: number) => year >= now - 5 && year <= now + 1;

  if (raw.length === 4) {
    const year = Number(raw);
    const gregorian = year > 2400 ? year - 543 : year;    // 2569 = พ.ศ.
    return gregorian > 1900 ? gregorian : null;
  }
  const yy = Number(raw);
  const buddhist = 2500 + yy - 543;                       // "69" → พ.ศ.2569 → 2026
  const gregorian = 2000 + yy;                            // "26" → 2026
  if (inRange(buddhist)) return buddhist;                 // สลิปไทยใช้ พ.ศ. เป็นหลัก
  if (inRange(gregorian)) return gregorian;
  return null;
}

function parseDates(text: unknown) {
  const source = String(text || '');
  const out: string[] = [];
  const push = (year: number | null, month: number, day: number) => {
    if (!year || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return;
    const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!out.includes(value)) out.push(value);
  };

  // 27/08/2569 • 27-08-2569 • 27.08.2569 (รับปี 2 หลักด้วย)
  // ต้องลอง \d{4} ก่อน \d{2} เสมอ ไม่งั้น regex จับ "2569" ได้แค่ "25" แล้วปีเพี้ยนไปทั้งใบ
  for (const m of source.matchAll(/(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})/g)) {
    push(normalizeYear(m[3]), Number(m[2]), Number(m[1]));
  }
  // 2026-08-27 (ISO)
  for (const m of source.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/g)) {
    push(normalizeYear(m[1]), Number(m[2]), Number(m[3]));
  }
  // 27 ส.ค. 2569 • 27 สิงหาคม 69 • 27 Aug 2026
  const named = new RegExp(`(\\d{1,2})\\s*(${MONTH_PATTERN})\\s*(\\d{4}|\\d{2})`, 'gi');
  for (const m of source.matchAll(named)) {
    push(normalizeYear(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
  }
  return out;
}

export function parseText(text: unknown) {
  const source = String(text || '');
  const amounts = parseAmounts(source);
  const dates = parseDates(source);
  // ป้ายกำกับเลขที่รายการต่างกันไปตามธนาคาร และมักมีจุด/ทวิภาคคั่นก่อนตัวเลข
  const txnMatch = new RegExp(
    '(?:' + [
      'เลขที่รายการ', 'เลขรายการ', 'หมายเลขรายการ', 'เลขที่ธุรกรรม',
      'รหัสอ้างอิง', 'เลขที่อ้างอิง', 'เลขอ้างอิง', 'หมายเลขอ้างอิง',
      'transaction\\s*(?:id|no)?', 'reference\\s*(?:no|number)?', 'ref\\s*(?:no)?'
    ].join('|') + ')' +
    '\\s*[:#.\\-]*\\s*([A-Z0-9][A-Z0-9-]{5,59})',
    'i'
  ).exec(source);
  const bank = BANKS.find(([pattern]) => pattern.test(source))?.[1] || '';
  return { amounts, dates, amount: amounts[0] || 0, date: dates[0] || '', txn: txnMatch?.[1] || '', bank };
}

const fromText = (text: string): Partial<SlipInfo> => ({
  ocr: 'ok', ...parseText(text), sample: text.replace(/\s+/g, ' ').slice(0, 300)
});

/** Google Cloud Vision REST — ต้องบอก languageHints เป็นไทยด้วย ไม่งั้นอ่านสระ/วรรณยุกต์เพี้ยน */
async function runGoogleVision(dataUrl: string): Promise<Partial<SlipInfo>> {
  const content = String(dataUrl).replace(/^data:[^,]*,/, '');
  try {
    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(env.visionApiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content },
            // DOCUMENT_TEXT_DETECTION อ่านข้อความหนาแน่นแบบสลิป/ใบเสร็จได้ดีกว่า TEXT_DETECTION
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            imageContext: { languageHints: ['th', 'en'] }
          }]
        }),
        signal: AbortSignal.timeout(25000)
      }
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return { ocr: 'slip_ocr_failed', detail: `Google Vision: ${body?.error?.message || `HTTP ${response.status}`}` };
    }
    const result = body?.responses?.[0];
    if (result?.error?.message) return { ocr: 'slip_ocr_failed', detail: `Google Vision: ${result.error.message}` };
    const text = result?.fullTextAnnotation?.text || result?.textAnnotations?.[0]?.description || '';
    if (!text) return { ocr: 'slip_ocr_failed', detail: 'Google Vision อ่านไม่พบตัวหนังสือในรูป — ถ่ายให้ชัดขึ้นหรือกดเพิ่มความละเอียด' };
    return fromText(String(text));
  } catch (error) {
    return { ocr: 'slip_ocr_failed', detail: String((error as Error).message || error) };
  }
}

/** endpoint ของตัวเอง: รับ POST {image} แล้วตอบ {text} */
async function runCustomEndpoint(image: string): Promise<Partial<SlipInfo>> {
  try {
    const response = await fetch(env.ocrEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image }),
      signal: AbortSignal.timeout(25000)
    });
    if (!response.ok) throw new Error(`OCR HTTP ${response.status}`);
    const body = await response.json();
    return fromText(String(body.text || ''));
  } catch (error) {
    return { ocr: 'slip_ocr_failed', detail: String((error as Error).message || error) };
  }
}

async function runOcr(image: string): Promise<Partial<SlipInfo>> {
  // ตั้ง OCR_ENDPOINT ไว้ = ตั้งใจใช้ของตัวเอง ให้มาก่อนเสมอ
  if (env.ocrEndpoint) return runCustomEndpoint(image);
  if (env.visionApiKey) return runGoogleVision(image);
  return {
    ocr: 'slip_ocr_unavailable',
    detail: 'ยังไม่ได้ตั้ง GOOGLE_VISION_API_KEY (หรือ OCR_ENDPOINT ถ้าใช้บริการอื่น)'
  };
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

export async function signSlipUpload(expectDate: string, user: { username: string }): Promise<ApiResult> {
  if (!validYmd(expectDate)) return { ok: false, error: 'returned_date_required' };
  const fileId = id('SP');
  const file = await createSignedUpload('slips', `${expectDate}_${user.username}_${fileId}`, 'jpg');
  return {
    ok: true, fileId, key: file.key, url: file.url,
    uploadUrl: file.uploadUrl, uploadToken: file.uploadToken
  };
}

/** ตรวจว่า key ที่ส่งกลับมาเป็นของ user คนนี้จริง และไฟล์ขึ้นไปแล้ว */
async function takePendingSlip(key: string, username: string) {
  const match = /^slips\/(.+)_([A-Za-z0-9]+)\.jpg$/.exec(key);
  const owner = match?.[1]?.split('_').slice(1).join('_');
  if (!match || !owner || owner.toLowerCase() !== username.toLowerCase()) {
    return { ok: false as const, error: 'forbidden' };
  }
  if (!(await fileExists(key))) return { ok: false as const, error: 'upload_missing' };
  const fileName = key.slice('slips/'.length);
  return {
    ok: true as const,
    fileId: match[2],
    key,
    url: `/files/slips/${encodeURIComponent(fileName)}`
  };
}

export async function verifySlip(body: ApiBody, user: { username: string }): Promise<ApiResult> {
  const expectDate = String(body.expectDate || '').trim();
  const expectAmount = round2(body.expectAmount);
  if (!validYmd(expectDate)) return { ok: false, error: 'returned_date_required' };
  if (!(expectAmount > 0)) return { ok: false, error: 'slip_not_required' };

  let row: { id: string; url: string; infoJson: string; username: string; fileName: string };

  // สลิปที่เบราว์เซอร์อัปตรงไป Supabase แล้ว (รูปความละเอียดสูงเกินลิมิต body ของ Vercel)
  // ต้องโหลดกลับมาเข้า OCR เอง เพราะฝั่งเซิร์ฟเวอร์ไม่เคยเห็นไฟล์
  if (body.key) {
    const pending = await takePendingSlip(String(body.key), user.username);
    if (!pending.ok) return pending;
    const dataUrl = await downloadAsDataUrl(pending.key);
    if (!dataUrl) return { ok: false, error: 'upload_missing' };
    const info: SlipInfo = {
      v: 1, user: user.username.toLowerCase(), uploaded: nowIso(), ...(await runOcr(dataUrl))
    };
    await db.insert(slips).values({
      id: pending.fileId, username: user.username, uploadedAt: info.uploaded!,
      fileName: pending.key, url: pending.url, infoJson: JSON.stringify(info)
    });
    row = {
      id: pending.fileId, url: pending.url, infoJson: JSON.stringify(info),
      username: user.username, fileName: pending.key
    };
  } else if (body.image) {
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

const ocrProvider = () => env.ocrEndpoint ? 'OCR endpoint ของตัวเอง'
  : (env.visionApiKey ? 'Google Cloud Vision' : '');

/**
 * ปุ่ม "ตรวจ OCR" ในหน้า admin — ลองอ่านสลิปใบล่าสุดจริง ๆ
 * บอกแค่ว่า "ตั้งค่าแล้ว" ไม่พอ เพราะ API key ผิดหรือยังไม่ได้เปิด API ก็ยังดูเหมือนตั้งค่าแล้ว
 */
export async function ocrDiagnostics() {
  const provider = ocrProvider();
  const base = { ok: true, driveService: false, v2: false, strict: env.slipStrict, provider };

  if (!provider) {
    return {
      ...base,
      status: 'not_configured',
      message: 'ยังไม่ได้ตั้งค่า OCR — ตอนนี้พนักงานต้องกรอกยอด วันที่ และเลขที่รายการจากสลิปเอง'
    };
  }

  const [latest] = await db.select().from(slips).orderBy(desc(slips.uploadedAt)).limit(1);
  if (!latest) {
    return {
      ...base,
      status: 'ok',
      message: `ตั้งค่า ${provider} แล้ว — ยังไม่มีสลิปในระบบให้ทดลองอ่าน จะตรวจให้อัตโนมัติเมื่อพนักงานแนบสลิปใบแรก`
    };
  }

  const dataUrl = await downloadAsDataUrl(latest.fileName);
  if (!dataUrl) {
    return { ...base, status: 'ok', message: `ตั้งค่า ${provider} แล้ว แต่เปิดไฟล์สลิปใบล่าสุดไม่ได้`, file: latest.fileName };
  }

  const result = await runOcr(dataUrl);
  const parsed = { amount: result.amount || 0, date: result.date || '', txn: result.txn || '', bank: result.bank || '' };
  const complete = Boolean(parsed.amount && parsed.date && parsed.txn);

  return {
    ...base,
    status: result.ocr === 'ok' ? 'ok' : 'error',
    message: result.ocr === 'ok'
      ? (complete
        ? `${provider} อ่านสลิปใบล่าสุดได้ครบทุกช่อง`
        : `${provider} อ่านได้บางส่วน — ช่องที่ขาดพนักงานต้องกรอกเอง`)
      : `${provider} อ่านไม่สำเร็จ: ${result.detail || ''}`,
    parsed,
    sample: result.sample || '',
    file: latest.fileName,
    fileUrl: latest.url
  };
}
