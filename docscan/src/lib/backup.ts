import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { CLOUD_SETTINGS, emptyBlob } from './cloud';
import { db } from './db';
import type { DocRecord, Folder, PageRecord, SignatureRecord } from './types';

/**
 * แบ็กอัปในเครื่อง — ไฟล์ .docscan (ZIP) ไฟล์เดียว: manifest.json + รูปทุกไฟล์
 * วันหน้าเพิ่มปลายทาง Google Drive / OneDrive / Dropbox ได้ด้วยการส่ง Blob จาก createBackup() ขึ้นไป
 */
const VERSION = 1;
type BlobKeys = 'originalImage' | 'croppedImage' | 'processedImage' | 'thumbnail';
const PAGE_BLOBS: BlobKeys[] = ['originalImage', 'croppedImage', 'processedImage', 'thumbnail'];

export async function createBackup(onProgress?: (p: number) => void): Promise<Blob> {
  const [documents, pages, folders, signatures, settings] = await Promise.all([
    db.documents.toArray(), db.pages.toArray(), db.folders.toArray(), db.signatures.toArray(), db.settings.toArray()
  ]);
  const files: Record<string, Uint8Array> = {};
  const pageMeta = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const meta: Record<string, unknown> = { ...p };
    for (const k of PAGE_BLOBS) {
      // ภาพที่อยู่บนระบบ (โหมดให้ระบบเก็บ) ไม่ได้อยู่ในเครื่อง — แบ็กอัปเก็บแค่ที่อ้างถึง (page.cloud) ดึงจากระบบได้ภายหลัง
      if (!p[k].size) { meta[k] = null; continue; }
      const path = `pages/${p.id}/${k}.jpg`;
      files[path] = new Uint8Array(await p[k].arrayBuffer());
      meta[k] = path;
    }
    pageMeta.push(meta);
    onProgress?.((i + 1) / Math.max(1, pages.length));
  }
  const sigMeta = [];
  for (const s of signatures) {
    const path = `signatures/${s.id}.png`;
    files[path] = new Uint8Array(await s.image.arrayBuffer());
    sigMeta.push({ ...s, image: path });
  }
  const docMeta = documents.map((d) => ({ ...d, thumbnail: null }));
  files['manifest.json'] = strToU8(JSON.stringify({
    app: 'DocScan', version: VERSION, createdAt: new Date().toISOString(),
    documents: docMeta, pages: pageMeta, folders, signatures: sigMeta,
    settings: settings.filter((s) => !CLOUD_SETTINGS.includes(s.key))
  }));
  return new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' });
}

/** นำเข้าแบ็กอัป — รวมกับข้อมูลเดิม (id ซ้ำ = เขียนทับด้วยของในแบ็กอัป) */
export async function restoreBackup(file: File) {
  let unz: Record<string, Uint8Array>;
  try { unz = unzipSync(new Uint8Array(await file.arrayBuffer())); }
  catch { throw new Error('ไฟล์แบ็กอัปเสียหรือไม่ใช่ไฟล์ของ DocScan'); }
  const raw = unz['manifest.json'];
  if (!raw) throw new Error('ไม่พบข้อมูลในไฟล์แบ็กอัป');
  const m = JSON.parse(strFromU8(raw));
  if (m.app !== 'DocScan') throw new Error('ไม่ใช่ไฟล์แบ็กอัปของ DocScan');
  const blob = (path: string, type = 'image/jpeg') => {
    const b = unz[path];
    if (!b) throw new Error(`ไฟล์ในแบ็กอัปไม่ครบ (${path})`);
    return new Blob([b as BlobPart], { type });
  };
  const pages: PageRecord[] = m.pages.map((p: Record<string, unknown>) => {
    const out = { ...p } as unknown as PageRecord;
    for (const k of PAGE_BLOBS) (out as unknown as Record<string, Blob>)[k] = p[k] == null ? emptyBlob() : blob(String(p[k]));
    return out;
  });
  const signatures: SignatureRecord[] = (m.signatures || []).map((s: Record<string, unknown>) =>
    ({ ...s, image: blob(String(s.image), 'image/png') }) as SignatureRecord);
  await db.transaction('rw', [db.documents, db.pages, db.folders, db.signatures, db.settings], async () => {
    await db.folders.bulkPut(m.folders as Folder[]);
    await db.documents.bulkPut((m.documents as DocRecord[]).map((d) => ({ ...d, thumbnail: null })));
    await db.pages.bulkPut(pages);
    await db.signatures.bulkPut(signatures);
    if (Array.isArray(m.settings)) await db.settings.bulkPut(m.settings);
  });
  // รูปปกคำนวณใหม่จากหน้าแรก (ไม่ได้เก็บซ้ำในแบ็กอัป)
  for (const d of m.documents as DocRecord[]) {
    const first = pages.filter((p) => p.documentId === d.id).sort((a, b) => a.order - b.order)[0];
    await db.documents.update(d.id, { thumbnail: first?.thumbnail || null });
  }
  return { documents: m.documents.length, pages: pages.length };
}
