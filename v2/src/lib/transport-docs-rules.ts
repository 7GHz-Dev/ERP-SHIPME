/**
 * กติกาไฟล์ใบขน / E-Office ที่ ERP-KOLA ส่งมา (transport_docs) — ฟังก์ชันล้วน ไม่แตะฐานข้อมูล
 */
export const DOC_KINDS = ['DECL', 'EOFFICE'] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const DOC_MAX_BYTES = 20 * 1024 * 1024;

/** key ของ BL สำหรับจับคู่เอกสาร — ตัดทุกอย่างที่ไม่ใช่ A-Z0-9 (ต่างจาก blKeyOf ของตารางขนส่งที่ตัดแค่ช่องว่าง) */
export const docKey = (bl: unknown) => String(bl ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function validDocInput(input: { bl?: unknown; kind?: unknown; fileName?: unknown; size?: unknown }): string | null {
  if (!docKey(input.bl)) return 'bad_bl';
  if (!DOC_KINDS.includes(String(input.kind) as DocKind)) return 'bad_kind';
  if (!/\.pdf$/i.test(String(input.fileName ?? '').trim())) return 'pdf_only';
  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0) return 'bad_size';
  if (size > DOC_MAX_BYTES) return 'file_too_large';
  return null;
}
