/**
 * ตรวจแถว Transport Request (ส่วน 1 ของตารางขนส่ง) — ฟังก์ชันล้วน ไม่แตะฐานข้อมูล
 * ใช้ร่วมกันทั้งปุ่ม "📥 รับ Transport Request" ในแพลนงาน และแถวที่ ERP-KOLA ส่งมา (kola-transport.ts)
 * วันที่ = คอลัมน์ TRANSPORT (วันลากตู้/ตรวจปล่อย) ไม่ใช่ ETA
 */
export const MAX_IMPORT = 500;
export const text = (value: unknown, max = 200) => String(value ?? '').trim().slice(0, max);
export const blKeyOf = (bl: unknown) => String(bl ?? '').toUpperCase().replace(/\s+/g, '');

export const realDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};
const splitContainers = (value: unknown) => [...new Set(String(value ?? '')
  .toUpperCase().split(/[\s,;/]+/).map((x) => x.replace(/[^A-Z0-9]/g, '')).filter((x) => x.length >= 4))];

type ImportRow = {
  transportDate: string; customer: string; quantity: number; bl: string; blKey: string;
  containers: string[]; vessel: string; vesselName: string; port: string;
};

/** ตรวจแถวที่หน้าเว็บอ่านจากไฟล์/ที่วางมา — คืนแถวที่ใช้ได้ + ข้อผิดพลาดรายแถว */
export function cleanImport(input: unknown) {
  const rows: (ImportRow & { line: number; error?: string; warning?: string })[] = [];
  for (const [i, raw] of (Array.isArray(input) ? input.slice(0, MAX_IMPORT) : []).entries()) {
    const r = raw as any;
    const transportDate = text(r?.transportDate, 10);
    const bl = text(r?.bl, 120);
    const containers = splitContainers(r?.containers);
    const given = Math.round(Number(r?.quantity) || 0);
    const row = {
      line: Number(r?.line) || i + 1, transportDate, customer: text(r?.customer, 200), bl, blKey: blKeyOf(bl),
      containers, quantity: given > 0 ? given : containers.length,
      vessel: text(r?.vessel, 80), vesselName: text(r?.vesselName, 120), port: text(r?.port, 60)
    };
    let error = '';
    if (!bl) error = 'ไม่มีเลข BL';
    else if (!realDate(transportDate)) error = 'วันที่ TRANSPORT ไม่ถูกต้อง';
    // CON ไม่ตรงกับจำนวนเลขตู้ = เตือน (ยังนำเข้าได้ ใช้ CON ตามไฟล์)
    const warning = given > 0 && containers.length && given !== containers.length ? `CON ${given} แต่มีเลขตู้ ${containers.length} ตู้` : '';
    rows.push({ ...row, ...(error ? { error } : {}), ...(warning ? { warning } : {}) });
  }
  return rows;
}

