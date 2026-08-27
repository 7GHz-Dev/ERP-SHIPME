import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { id, nowIso, round2, safeJson, validYmd } from './utils.js';
import { saveDataImage } from './storage.js';

const BANKS = [
  [/กสิกร|kasikorn|kbank|k\s*plus/i, 'กสิกรไทย (KBank)'],
  [/ไทยพาณิชย์|siam\s*commercial|scb/i, 'ไทยพาณิชย์ (SCB)'],
  [/กรุงเทพ|bangkok\s*bank|bualuang|bbl/i, 'กรุงเทพ (BBL)'],
  [/กรุงไทย|krungthai|ktb/i, 'กรุงไทย (KTB)'],
  [/กรุงศรี|krungsri|ayudhya|kma/i, 'กรุงศรีอยุธยา (Krungsri)'],
  [/ทหารไทยธนชาต|ttb|tmbthanachart|thanachart|ธนชาต/i, 'ทีทีบี (ttb)'],
  [/ออมสิน|gsb|mymo/i, 'ออมสิน (GSB)'],
  [/พร้อมเพย์|promptpay/i, 'พร้อมเพย์ (PromptPay)']
];

function parseAmounts(text) {
  const values = [];
  for (const match of String(text || '').matchAll(/(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2})/g)) {
    const value = Number(match[1].replace(/,/g, ''));
    if (value > 0 && value < 100000000 && !values.includes(value)) values.push(value);
  }
  return values.slice(0, 40);
}

function parseDates(text) {
  const out = [];
  for (const match of String(text || '').matchAll(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/g)) {
    let year = Number(match[3]); if (year > 2400) year -= 543;
    const value = `${year}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
    if (!out.includes(value)) out.push(value);
  }
  for (const match of String(text || '').matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    const value = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function parseText(text) {
  const source = String(text || '');
  const amounts = parseAmounts(source);
  const dates = parseDates(source);
  const txnMatch = /(?:เลขที่รายการ|เลขรายการ|รหัสอ้างอิง|เลขอ้างอิง|transaction(?:\s*id)?|reference(?:\s*no)?|ref\s*no)\s*[:#-]?\s*([A-Z0-9-]{6,60})/i.exec(source);
  const bank = BANKS.find(([pattern]) => pattern.test(source))?.[1] || '';
  return { amounts, dates, amount: amounts[0] || 0, date: dates[0] || '', txn: txnMatch?.[1] || '', bank };
}

async function runOcr(image) {
  if (!config.ocrEndpoint) return { ocr: 'slip_ocr_unavailable', detail: 'ยังไม่ได้ตั้งค่า OCR_ENDPOINT' };
  try {
    const response = await fetch(config.ocrEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image }), signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`OCR HTTP ${response.status}`);
    const body = await response.json();
    const parsed = parseText(body.text || '');
    return { ocr: 'ok', ...parsed, sample: String(body.text || '').replace(/\s+/g, ' ').slice(0, 300) };
  } catch (error) {
    return { ocr: 'slip_ocr_failed', detail: String(error.message || error) };
  }
}

function checkSlip(info, expectDate, expectAmount) {
  const amounts = info.amounts || [];
  const dates = info.dates || [];
  const amountOk = amounts.some((amount) => Math.abs(amount - Number(expectAmount)) <= config.slipAmountTolerance);
  const dateOk = dates.includes(String(expectDate || ''));
  const readable = info.ocr === 'ok' && (amounts.length || dates.length);
  if (!readable && info.manual) {
    const manualAmountOk = Math.abs((Number(info.manual.amount) || 0) - Number(expectAmount)) <= config.slipAmountTolerance;
    const manualDateOk = String(info.manual.date || '') === String(expectDate || '');
    const transactionOk = Boolean(String(info.manual.txn || '').trim());
    if (manualAmountOk && manualDateOk && transactionOk) {
      return { status: 'manual', label: 'กรอกค่าจากสลิปเอง — รอผู้ดูแลตรวจสลิป', amountOk: true, dateOk: true, manual: true };
    }
    return {
      status: 'mismatch', amountOk: manualAmountOk, dateOk: manualDateOk, manual: true,
      label: !transactionOk ? 'ต้องกรอกเลขที่รายการในสลิปด้วย' : (!manualAmountOk ? 'ยอดที่กรอกไม่ตรงกับยอดที่ต้องโอนคืน' : 'วันที่ที่กรอกไม่ตรงกับวันที่โอนคืนที่เลือก')
    };
  }
  if (!readable) return { status: 'unreadable', label: 'อ่านข้อมูลในสลิปอัตโนมัติไม่ได้ (กรอกค่าจากสลิปเองได้)', amountOk: false, dateOk: false };
  if (amountOk && dateOk) return { status: 'verified', label: 'ตรวจอัตโนมัติผ่าน (ยอดและวันที่ตรง)', amountOk, dateOk };
  return {
    status: 'mismatch', amountOk, dateOk,
    label: !amountOk && !dateOk ? 'ยอดเงินและวันที่ในสลิปไม่ตรงกับที่ต้องโอน' : (!amountOk ? 'ยอดเงินในสลิปไม่ตรงกับยอดที่ต้องโอนคืน' : 'วันที่ในสลิปไม่ตรงกับวันที่โอนคืนที่เลือก')
  };
}

function response(idValue, url, info, expectDate, expectAmount) {
  const checked = checkSlip(info, expectDate, expectAmount);
  const values = info.manual || info;
  return {
    ok: true, fileId: idValue, url,
    amount: values.amount || 0, date: values.date || '', txn: values.txn || '', bank: info.bank || '',
    ocr: info.ocr, ocrDetail: info.detail || '', sample: info.sample || '', isManual: Boolean(checked.manual),
    status: checked.status, label: checked.label, amountOk: checked.amountOk, dateOk: checked.dateOk,
    strict: config.slipStrict,
    canSave: checked.status === 'verified' || checked.status === 'manual' || (checked.status === 'unreadable' && !config.slipStrict),
    canManual: checked.status === 'unreadable' || checked.status === 'manual'
  };
}

export async function verifySlip(body, user) {
  const expectDate = String(body.expectDate || '').trim();
  const expectAmount = round2(body.expectAmount);
  if (!validYmd(expectDate)) return { ok: false, error: 'returned_date_required' };
  if (!(expectAmount > 0)) return { ok: false, error: 'slip_not_required' };
  let row;
  if (body.image) {
    const fileId = id('SP');
    const file = saveDataImage(body.image, 'slips', `${expectDate}_${user.username}_${fileId}`);
    const info = { v: 1, user: user.username.toLowerCase(), uploaded: nowIso(), ...(await runOcr(body.image)) };
    db.prepare('INSERT INTO slips (id, username, uploaded_at, file_name, url, info_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fileId, user.username, info.uploaded, file.id, file.url, JSON.stringify(info));
    row = { id: fileId, url: file.url, info_json: JSON.stringify(info), username: user.username };
  } else {
    row = db.prepare('SELECT * FROM slips WHERE id = ?').get(String(body.fileId || ''));
    if (!row) return { ok: false, error: 'slip_not_found' };
    if (row.username.toLowerCase() !== user.username.toLowerCase()) return { ok: false, error: 'forbidden' };
  }
  const info = safeJson(row.info_json, {});
  if (body.retryOcr && !body.image) {
    if (!config.ocrEndpoint) return response(row.id, row.url, info, expectDate, expectAmount);
    const filePath = path.join(config.dataDir, 'uploads', row.file_name);
    const raw = fs.readFileSync(filePath).toString('base64');
    Object.assign(info, await runOcr(`data:image/jpeg;base64,${raw}`));
  }
  if (body.manual) {
    const readable = info.ocr === 'ok' && ((info.amounts || []).length || (info.dates || []).length);
    if (readable) return { ok: false, error: 'slip_manual_not_allowed' };
    info.manual = {
      amount: round2(body.manual.amount),
      date: validYmd(body.manual.date) ? String(body.manual.date) : '',
      txn: String(body.manual.txn || '').trim().slice(0, 60)
    };
    info.manualBy = user.username.toLowerCase();
    info.manualAt = nowIso();
  }
  db.prepare('UPDATE slips SET info_json = ? WHERE id = ?').run(JSON.stringify(info), row.id);
  return response(row.id, row.url, info, expectDate, expectAmount);
}

export function getSlip(fileId, username) {
  const row = db.prepare('SELECT * FROM slips WHERE id = ?').get(String(fileId || ''));
  if (!row) return { ok: false, error: 'slip_not_found' };
  if (username && row.username.toLowerCase() !== String(username).toLowerCase()) return { ok: false, error: 'forbidden' };
  return { ok: true, row, info: safeJson(row.info_json, {}) };
}

export function checkStoredSlip(info, expectDate, expectAmount) {
  return checkSlip(info, expectDate, expectAmount);
}

export function ocrDiagnostics() {
  return {
    ok: true,
    driveService: false,
    v2: false,
    strict: config.slipStrict,
    status: config.ocrEndpoint ? 'ok' : 'not_configured',
    message: config.ocrEndpoint
      ? 'ตั้งค่า OCR endpoint แล้ว ระบบจะตรวจเมื่ออัปโหลดสลิป'
      : 'ไม่ได้ใช้ Google Drive OCR; ขณะนี้ใช้การกรอกค่าจากสลิปเอง หรือตั้ง OCR_ENDPOINT เพื่อเปิดตรวจอัตโนมัติ'
  };
}
