import crypto from 'node:crypto';
import { runTransportImport } from './transport-records';
import { text } from './transport-clean';
import type { ApiBody, ApiResult } from './types';

/**
 * ERP-KOLA (MAY) → ตารางขนส่ง + ไฟล์ใบขน / E-Office — เมนูชั่วคราวฝั่ง KOLA ระหว่างที่ KOLA ยังส่งเองไม่ได้
 * สเปก: ERP-KOLA docs/SHIPME-TRANSPORT-REQUEST.md
 *
 * ยืนยันตัวด้วย KOLA_SYNC_TOKEN (ฝั่ง KOLA ชื่อ SHIPME_SYNC_TOKEN ค่าเดียวกัน) ไม่ใช้ session ผู้ใช้ · เว้นว่าง = ปิดรับ
 */

export function kolaDenied(body: ApiBody): ApiResult | null {
  const token = (process.env.KOLA_SYNC_TOKEN || '').trim();
  if (!token) return { ok: false, error: 'sync_not_configured' };
  const given = Buffer.from(text(body.token, 300));
  const want = Buffer.from(token);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return { ok: false, error: 'invalid_token' };
  return null;
}

/**
 * Transport Request จาก KOLA — ตรรกะเดียวกับปุ่ม "📥 รับ Transport Request" (BL + วันที่ TRANSPORT เดิม = อัปเดตแถวเดิม)
 * commit = false: ตรวจ/ดูตัวอย่าง · true: บันทึก
 */
export async function kolaTransportPush(body: ApiBody): Promise<ApiResult> {
  const no = kolaDenied(body);
  if (no) return no;
  return runTransportImport(body.rows, {
    source: text(body.source), commit: body.commit === true,
    actor: `kola:${text(body.sentBy, 60) || 'MAY'}`, importedFrom: 'kola'
  });
}
