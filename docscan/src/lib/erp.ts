/**
 * เชื่อมกับ ERP (ใบปิดบัญชีของพนักงานชิปปิ้ง)
 *
 * หน้าปิดบัญชีใน ERP เปิด DocScan ด้วย ?erp=<ticket> — ticket ผูกกับพนักงาน + วันที่ตรวจปล่อย
 * มีอายุจำกัด และใช้ได้อย่างเดียวคือแนบไฟล์หลักฐานการตรวจปล่อย (ไม่ใช่ token ล็อกอิน)
 * ไฟล์ออกจากเครื่องเฉพาะตอนผู้ใช้กด "ส่งเข้าใบปิดบัญชี" เท่านั้น — นอกนั้นอยู่ในเครื่องทั้งหมด
 */
export const ERP_API = process.env.NEXT_PUBLIC_ERP_API || 'https://erp-shipme-ovmf-theta.vercel.app/api';
const KEY = 'docscan.erpTicket';

export interface ErpTicket { ticket: string; name: string; inspectDate: string; returnUrl: string; expiresAt: string }

async function post<T>(body: Record<string, unknown>): Promise<T & { ok: boolean; error?: string }> {
  // text/plain = simple request ไม่ต้อง preflight (เหมือนที่หน้า ERP เรียกเอง)
  const res = await fetch(ERP_API, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
  return res.json();
}

const ERR: Record<string, string> = {
  ticket_expired: 'ลิงก์แนบไฟล์หมดอายุแล้ว — กลับไปหน้าปิดบัญชีแล้วกด "สแกนด้วย DocScan" ใหม่',
  invalid_ticket: 'ลิงก์แนบไฟล์ไม่ถูกต้อง — กลับไปหน้าปิดบัญชีแล้วกด "สแกนด้วย DocScan" ใหม่',
  upload_missing: 'อัปโหลดไม่สำเร็จ ลองใหม่อีกครั้ง',
  too_large: 'ไฟล์ใหญ่เกินไป (สูงสุด 25MB) — ลดคุณภาพ/DPI ตอนส่งออกแล้วลองใหม่'
};
export const erpError = (code?: string) => ERR[code || ''] || `ส่งไฟล์ไม่สำเร็จ (${code || 'ไม่ทราบสาเหตุ'})`;

/** อ่าน ticket จาก URL ครั้งแรก แล้วจำไว้ใน sessionStorage (สลับหน้าในแอปแล้วยังอยู่) */
export async function loadTicket(): Promise<ErpTicket | null> {
  let fromUrl = '';
  try {
    const u = new URL(location.href);
    fromUrl = u.searchParams.get('erp') || '';
    if (fromUrl) { u.searchParams.delete('erp'); history.replaceState(null, '', u.pathname + u.search + u.hash); }
  } catch { /* ignore */ }
  if (fromUrl) {
    const r = await post<{ name: string; inspectDate: string; returnUrl: string; expiresAt: string }>({ action: 'scanTicketInfo', ticket: fromUrl });
    if (!r.ok) throw new Error(erpError(r.error));
    const t: ErpTicket = { ticket: fromUrl, name: r.name, inspectDate: r.inspectDate, returnUrl: r.returnUrl, expiresAt: r.expiresAt };
    try { sessionStorage.setItem(KEY, JSON.stringify(t)); } catch { /* โหมดส่วนตัว */ }
    return t;
  }
  try {
    const t = JSON.parse(sessionStorage.getItem(KEY) || 'null') as ErpTicket | null;
    if (t && new Date(t.expiresAt).getTime() > Date.now()) return t;
  } catch { /* ignore */ }
  return null;
}
export function clearTicket() { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } }

/** ส่ง PDF เข้าใบปิดบัญชี: ขอลิงก์อัปโหลด → อัปตรงขึ้นที่เก็บไฟล์ → แจ้ง ERP ให้บันทึก */
export async function sendToErp(t: ErpTicket, pdf: Blob, meta: { name: string; pages: number }) {
  if (pdf.size > 25 * 1024 * 1024) throw new Error(erpError('too_large'));
  const signed = await post<{ uploadUrl: string; key: string }>({ action: 'scanUploadSign', ticket: t.ticket });
  if (!signed.ok) throw new Error(erpError(signed.error));
  const up = await fetch(signed.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: pdf });
  if (!up.ok) throw new Error(erpError('upload_missing'));
  const done = await post<{ file: { id: string } }>({
    action: 'scanUploadDone', ticket: t.ticket, key: signed.key, name: meta.name, pages: meta.pages, size: pdf.size
  });
  if (!done.ok) throw new Error(erpError(done.error));
  return done.file;
}
