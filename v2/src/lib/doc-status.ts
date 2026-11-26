import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { transportDocs } from '@/db/schema';
import { fetchKolaDo } from './doc-status-kola';
import { signedDocUrls } from './kola-transport';
import { docKey } from './transport-docs-rules';

/**
 * ความพร้อมเอกสารต่อ BL สำหรับแพลนงาน / งานปล่อย — DO (ถาม ERP-KOLA สด) · ใบขน · E-Office (ไฟล์ที่ KOLA ส่งมา)
 * do: yes = ANN ส่งแลก DO แล้ว · no = ยัง · notfound = ไม่มี BL นี้ใน KOLA · unknown = ถาม KOLA ไม่ได้
 */
export type DocFile = { id: string; url: string; fileName: string };
export type DocState = { do: 'yes' | 'no' | 'notfound' | 'unknown'; decl: DocFile | null; eoffice: DocFile | null };

export async function docStatusFor(bls: string[]): Promise<Record<string, DocState>> {
  // ป้ายเอกสารเป็นส่วนเสริม — อ่านไม่ได้ (เช่น ยังไม่ได้รัน migration 0024) ต้องไม่ทำให้แพลนงาน / งานปล่อยเปิดไม่ขึ้น
  try {
    return await readDocStatus(bls);
  } catch (e) {
    console.error('docStatusFor', e);
    return {};
  }
}

async function readDocStatus(bls: string[]): Promise<Record<string, DocState>> {
  const keys = [...new Set(bls.map(docKey).filter(Boolean))];
  if (!keys.length) return {};
  const [kolaDo, files] = await Promise.all([
    fetchKolaDo(keys),
    db.select({ id: transportDocs.id, blKey: transportDocs.blKey, kind: transportDocs.kind, fileName: transportDocs.fileName, storageKey: transportDocs.storageKey })
      .from(transportDocs).where(and(inArray(transportDocs.blKey, keys), eq(transportDocs.current, true)))
  ]);
  const urls = await signedDocUrls(files.map((f) => f.storageKey));
  const out: Record<string, DocState> = {};
  for (const k of keys) out[k] = { do: kolaDo ? (kolaDo.get(k) || 'notfound') : 'unknown', decl: null, eoffice: null };
  for (const f of files) {
    const file = { id: f.id, url: urls.get(f.storageKey) || '', fileName: f.fileName };
    if (f.kind === 'DECL') out[f.blKey].decl = file;
    if (f.kind === 'EOFFICE') out[f.blKey].eoffice = file;
  }
  return out;
}
