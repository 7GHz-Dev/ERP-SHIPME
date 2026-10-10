import Dexie, { type Table } from 'dexie';
import type { CloudRefRecord, DocRecord, Folder, PageRecord, SignatureRecord } from './types';

/**
 * ฐานข้อมูลในเครื่อง (IndexedDB) — รูปเก็บเป็น Blob ไม่ใช่ base64 จะได้ไม่กินที่เกินจำเป็น
 * ห้ามเก็บรูปใน localStorage (จำกัด ~5MB และบล็อก UI)
 *
 * ระวัง: Safari คัดลอกทุก Blob ในแถวเป็นไฟล์ชั่วคราวทุกครั้งที่เขียนแถวนั้น (แม้แก้แค่ช่องเดียว)
 * เครื่องที่พื้นที่เต็มจึงเขียนแถวที่มีรูปใหญ่ไม่ได้ — ข้อมูลที่ต้องจดบ่อย (เช่น cloudRefs) ต้องอยู่ตารางที่ไม่มีรูป
 */
class DocScanDB extends Dexie {
  documents!: Table<DocRecord, string>;
  pages!: Table<PageRecord, string>;
  folders!: Table<Folder, string>;
  signatures!: Table<SignatureRecord, string>;
  settings!: Table<{ key: string; value: unknown }, string>;
  cloudRefs!: Table<CloudRefRecord, string>;

  constructor() {
    super('docscan');
    this.version(1).stores({
      documents: 'id, name, folderId, createdAt, updatedAt, size, deletedAt',
      pages: 'id, documentId, [documentId+order]',
      folders: 'id, parentFolderId, name, deletedAt',
      signatures: 'id, createdAt',
      settings: 'key'
    });
    // v2: ย้ายไฟล์บนระบบของแต่ละหน้า (page.cloud) มาตารางแยก — อ่านหน้าอย่างเดียว ไม่เขียนหน้าซ้ำ (ทำได้แม้เครื่องเต็ม)
    this.version(2).stores({ cloudRefs: 'pageId, docId' }).upgrade(async (tx) => {
      const rows: CloudRefRecord[] = [];
      await tx.table<PageRecord>('pages').each((p) => {
        if (p.cloud && Object.keys(p.cloud).length) rows.push({ pageId: p.id, docId: p.documentId, refs: p.cloud });
      });
      if (rows.length) await tx.table<CloudRefRecord>('cloudRefs').bulkPut(rows);
    });
  }
}

export const db = new DocScanDB();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row ? (row.value as T) : fallback;
}
export async function setSetting(key: string, value: unknown) {
  await db.settings.put({ key, value });
}

/** หน้าทั้งหมดของเอกสาร เรียงตามลำดับ */
export function getPages(documentId: string) {
  return db.pages.where('[documentId+order]').between([documentId, -Infinity], [documentId, Infinity]).toArray();
}

export const uid = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
