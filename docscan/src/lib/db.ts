import Dexie, { type Table } from 'dexie';
import type { CloudRefRecord, DocRecord, Folder, PageRecord, SignatureRecord } from './types';

/**
 * ฐานข้อมูลในเครื่อง (IndexedDB) — รูปเก็บเป็น Blob ไม่ใช่ base64 จะได้ไม่กินที่เกินจำเป็น
 * ห้ามเก็บรูปใน localStorage (จำกัด ~5MB และบล็อก UI)
 *
 * ระวัง: Safari คัดลอกทุก Blob ในแถวเป็นไฟล์ชั่วคราวทุกครั้งที่เขียนแถวนั้น (แม้แก้แค่ช่องเดียว)
 * เครื่องที่พื้นที่เต็มจึงเขียนแถวที่มีรูปใหญ่ไม่ได้ — ข้อมูลที่ต้องจดบ่อย (เช่น cloudRefs) ต้องอยู่ตารางที่ไม่มีรูป
 *
 * iPhone (WebKit) กับ Blob ใน IndexedDB มีปัญหาหลายแบบ แม้เครื่องเหลือหลาย GB:
 *   - เขียนไม่ได้: "Error preparing Blob/File data to be stored in object store" (โหมดส่วนตัว / ในแอป LINE ฯลฯ)
 *   - เขียนได้แต่อ่านกลับไม่ได้: รูปขึ้น "?" + "The object can not be found here." (เบราว์เซอร์ในแอป LINE)
 * ทางแก้: ทุกครั้งที่เขียนรูปลงฐานข้อมูล แปลงเป็นข้อมูลดิบ (ArrayBuffer) ด้วย packBlobs ก่อนเสมอ — ไม่มีไฟล์ Blob ให้พัง
 * ตอนอ่าน hook 'reading' แปลงกลับเป็น Blob ให้เอง — โค้ดส่วนอื่นเห็นเป็น Blob เหมือนเดิม
 * ห้าม put/add แถวที่อ่านมา (มี Blob จาก hook) ตรง ๆ — ต้องผ่าน packBlobs ก่อน / แก้บางช่องใช้ update (Dexie แก้บนข้อมูลดิบ)
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
    this.pages.hook('reading', unpackRow);
    this.documents.hook('reading', unpackRow);
    this.signatures.hook('reading', unpackRow);
  }
}

// ---------- รูปแบบสำรองของรูป (ArrayBuffer) เมื่อ Safari เขียน Blob ไม่ได้ ----------
type PackedBlob = { __buf: ArrayBuffer; type: string };
const isPacked = (v: unknown): v is PackedBlob =>
  !!v && typeof v === 'object' && (v as PackedBlob).__buf instanceof ArrayBuffer;

function unpackRow<T>(row: T): T {
  if (row && typeof row === 'object') {
    const r = row as Record<string, unknown>;
    for (const k of Object.keys(r)) {
      const v = r[k];
      if (isPacked(v)) r[k] = new Blob([v.__buf], { type: v.type || 'image/jpeg' });
    }
  }
  return row;
}

/** แปลงทุก Blob ในแถวเป็น ArrayBuffer — เรียกก่อนเขียนแถว/ช่องที่มีรูปทุกครั้ง */
export async function packBlobs<T extends object>(row: T): Promise<T> {
  const out = { ...row } as Record<string, unknown>;
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (v instanceof Blob) out[k] = { __buf: await v.arrayBuffer(), type: v.type } satisfies PackedBlob;
  }
  return out as T;
}

export const packAll = <T extends object>(rows: T[]) => Promise.all(rows.map((r) => packBlobs(r)));

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
