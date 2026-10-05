import Dexie, { type Table } from 'dexie';
import type { DocRecord, Folder, PageRecord, SignatureRecord } from './types';

/**
 * ฐานข้อมูลในเครื่อง (IndexedDB) — รูปเก็บเป็น Blob ไม่ใช่ base64 จะได้ไม่กินที่เกินจำเป็น
 * ห้ามเก็บรูปใน localStorage (จำกัด ~5MB และบล็อก UI)
 */
class DocScanDB extends Dexie {
  documents!: Table<DocRecord, string>;
  pages!: Table<PageRecord, string>;
  folders!: Table<Folder, string>;
  signatures!: Table<SignatureRecord, string>;
  settings!: Table<{ key: string; value: unknown }, string>;

  constructor() {
    super('docscan');
    this.version(1).stores({
      documents: 'id, name, folderId, createdAt, updatedAt, size, deletedAt',
      pages: 'id, documentId, [documentId+order]',
      folders: 'id, parentFolderId, name, deletedAt',
      signatures: 'id, createdAt',
      settings: 'key'
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

export const uid = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
