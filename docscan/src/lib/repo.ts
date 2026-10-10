import { FIELD, KINDS, filesOf, forgetFiles, getMode, hasBlob, pageBlob, requestSync } from './cloud';
import { db, getPages, uid } from './db';
import { safeName } from './image';
import { rebuildProcessed } from './process';
import type { BlobKind, DocRecord, Folder, PageRecord, StorageMode } from './types';
import { DEFAULT_ADJUST } from './types';

/** งานข้อมูลทั้งหมด (เอกสาร / หน้า / โฟลเดอร์ / ถังขยะ) — UI เรียกผ่านที่นี่ ไม่แตะ db ตรง */

export const TRASH_DAYS = 30;
export { getPages };

/** storage ไม่ระบุ = ตามที่ตั้งไว้ (ตั้งค่า → ที่เก็บเอกสาร) */
export async function createDocument(name: string, folderId: string | null = null, storage?: StorageMode): Promise<DocRecord> {
  const now = Date.now();
  const doc: DocRecord = {
    id: uid(), name: safeName(name), folderId, createdAt: now, updatedAt: now,
    thumbnail: null, ocrText: '', pageCount: 0, size: 0, tags: [], deletedAt: 0,
    storage: storage ?? await getMode()
  };
  await db.documents.add(doc);
  return doc;
}

/** ขนาดภาพของหน้า — ภาพที่ลบออกจากเครื่องแล้ว (อยู่บนระบบ) ใช้ขนาดที่จดไว้ */
const pageBytes = (p: PageRecord) =>
  (['o', 'c', 'p'] as const).reduce((s, k) => s + (hasBlob(p[FIELD[k]]) ? p[FIELD[k]].size : p.cloud?.[k]?.n ?? 0), 0);

/** คำนวณจำนวนหน้า ขนาด รูปปก และข้อความ OCR รวมของเอกสารใหม่ */
export async function refreshDocument(documentId: string) {
  const pages = await getPages(documentId);
  const cover = pages[0]?.thumbnail;
  await db.documents.update(documentId, {
    pageCount: pages.length, size: pages.reduce((s, p) => s + pageBytes(p), 0),
    // ภาพย่อหน้าแรกยังไม่ได้ดึงจากระบบ (เพิ่งดึงรายการมา) = ใช้ปกเดิมไปก่อน
    ...(hasBlob(cover) || !pages.length ? { thumbnail: cover || null } : {}),
    ocrText: pages.map((p) => p.ocrText).filter(Boolean).join('\n\n'),
    updatedAt: Date.now()
  });
  requestSync();
}

export type NewPage = Pick<PageRecord,
  'originalImage' | 'croppedImage' | 'processedImage' | 'thumbnail' | 'width' | 'height' | 'cropCoordinates' | 'filter'>;

export async function addPage(documentId: string, img: NewPage, atOrder?: number) {
  const pages = await getPages(documentId);
  const order = atOrder ?? (pages.length ? pages[pages.length - 1].order + 1 : 0);
  const page: PageRecord = {
    id: uid(), documentId, order, ...img, rotation: 0, flip: false,
    adjustments: { ...DEFAULT_ADJUST }, markup: [], ocrText: ''
  };
  await db.pages.add(page);
  await refreshDocument(documentId);
  return page;
}

export async function updatePage(id: string, patch: Partial<PageRecord>, rebuild = false) {
  const page = await db.pages.get(id);
  if (!page) return;
  const opts = { ...page, ...patch };
  // ภาพครอบอาจอยู่บนระบบ (โหมดให้ระบบเก็บ) — ดึงมาก่อนสร้างภาพสุดท้ายใหม่
  const rebuilt = rebuild ? await rebuildProcessed(await pageBlob(opts, 'c'), {
    filter: opts.filter, adjustments: opts.adjustments, rotation: opts.rotation, flip: opts.flip, markup: opts.markup
  }) : {};
  // ภาพที่เปลี่ยน → ไฟล์บนระบบของภาพนั้นใช้ไม่ได้แล้ว ต้องอัปใหม่
  const changed: BlobKind[] = KINDS.filter((k) => FIELD[k] in patch || (rebuild && (k === 'p' || k === 't')));
  let next: PageRecord | undefined;
  const dropped: (string | undefined)[] = [];
  // อ่านหน้าล่าสุดอีกรอบแล้วค่อยเขียน — ไม่ทับสิ่งที่ตัวซิงก์เพิ่งจดระหว่างสร้างภาพ
  await db.transaction('rw', db.pages, async () => {
    const cur = await db.pages.get(id);
    if (!cur) return;
    next = { ...cur, ...patch, ...rebuilt };
    if (changed.length) {
      const cloud = { ...cur.cloud };
      for (const k of changed) { dropped.push(cloud[k]?.f); delete cloud[k]; }
      next.cloud = cloud;
      next.rev = (cur.rev ?? 0) + 1;
    }
    await db.pages.put(next);
  });
  await forgetFiles(dropped);
  await refreshDocument(page.documentId);
  return next;
}

export async function deletePage(id: string) {
  const page = await db.pages.get(id);
  if (!page) return;
  await db.pages.delete(id);
  await forgetFiles(filesOf([page]));
  await refreshDocument(page.documentId);
}

export async function duplicatePage(id: string) {
  const page = await db.pages.get(id);
  if (!page) return;
  const pages = await getPages(page.documentId);
  // แทรกต่อจากหน้าเดิม — ขยับลำดับหน้าหลัง ๆ ลงไปหนึ่ง
  await db.transaction('rw', db.pages, async () => {
    for (const p of pages) if (p.order > page.order) await db.pages.update(p.id, { order: p.order + 1 });
    await db.pages.add({ ...page, id: uid(), order: page.order + 1 });
  });
  await refreshDocument(page.documentId);
}

/** เรียงหน้าใหม่ตามลำดับ id ที่ส่งมา */
export async function reorderPages(documentId: string, ids: string[]) {
  await db.transaction('rw', db.pages, async () => {
    for (let i = 0; i < ids.length; i++) await db.pages.update(ids[i], { order: i });
  });
  await refreshDocument(documentId);
}

export async function renameDocument(id: string, name: string) {
  await db.documents.update(id, { name: safeName(name), updatedAt: Date.now() });
  requestSync();
}
export async function moveDocument(id: string, folderId: string | null) {
  await db.documents.update(id, { folderId, updatedAt: Date.now() });
  requestSync();
}

/** สำเนาเก็บที่เดียวกับต้นฉบับ — หน้าที่อยู่บนระบบอ้างไฟล์ชุดเดิม ไม่ต้องดึงลงมาก่อน */
export async function duplicateDocument(id: string) {
  const doc = await db.documents.get(id);
  if (!doc) return;
  const copy = await createDocument(`${doc.name} (สำเนา)`, doc.folderId, doc.storage ?? 'local');
  const pages = await getPages(id);
  await db.pages.bulkAdd(pages.map((p) => ({ ...p, id: uid(), documentId: copy.id })));
  await refreshDocument(copy.id);
  return copy;
}

/** ลบ = ย้ายลงถังขยะก่อนเสมอ (กู้คืนได้ภายใน 30 วัน) */
export async function trashDocument(id: string) { await db.documents.update(id, { deletedAt: Date.now() }); requestSync(); }
export async function restoreDocument(id: string) { await db.documents.update(id, { deletedAt: 0 }); requestSync(); }
export async function deleteForever(id: string) {
  const doc = await db.documents.get(id);
  const pages = await getPages(id);
  await db.transaction('rw', db.documents, db.pages, async () => {
    await db.pages.where('documentId').equals(id).delete();
    await db.documents.delete(id);
  });
  // เคยขึ้นระบบ = ลบบนระบบด้วย (ทำตอนออนไลน์)
  await forgetFiles(filesOf(pages), doc?.storage === 'cloud' || doc?.cloudSig ? [id] : []);
}
export async function emptyTrash() {
  const ids = (await db.documents.where('deletedAt').above(0).toArray()).map((d) => d.id);
  for (const id of ids) await deleteForever(id);
  return ids.length;
}
/** ลบถาวรเอกสารที่อยู่ในถังขยะเกิน 30 วัน (เรียกตอนเปิดแอป) */
export async function purgeExpiredTrash() {
  const cutoff = Date.now() - TRASH_DAYS * 86400_000;
  const old = await db.documents.where('deletedAt').between(1, cutoff).toArray();
  for (const d of old) await deleteForever(d.id);
  return old.length;
}

// ---------- โฟลเดอร์ ----------
export async function createFolder(name: string, parentFolderId: string | null) {
  const f: Folder = { id: uid(), name: safeName(name, 'โฟลเดอร์ใหม่'), parentFolderId, createdAt: Date.now(), deletedAt: 0 };
  await db.folders.add(f);
  requestSync();
  return f;
}
export async function renameFolder(id: string, name: string) { await db.folders.update(id, { name: safeName(name, 'โฟลเดอร์') }); requestSync(); }

/** ย้ายโฟลเดอร์ — ห้ามย้ายเข้าไปในโฟลเดอร์ลูกของตัวเอง (จะวนไม่จบ) */
export async function moveFolder(id: string, parentFolderId: string | null) {
  let cur = parentFolderId;
  while (cur) {
    if (cur === id) throw new Error('ย้ายโฟลเดอร์เข้าไปในโฟลเดอร์ย่อยของตัวเองไม่ได้');
    cur = (await db.folders.get(cur))?.parentFolderId ?? null;
  }
  await db.folders.update(id, { parentFolderId });
  requestSync();
}

/** ลบโฟลเดอร์: เอกสารข้างในลงถังขยะ โฟลเดอร์ย่อยลบตามไปด้วย */
export async function deleteFolder(id: string) {
  const children = await db.folders.where('parentFolderId').equals(id).toArray();
  for (const c of children) await deleteFolder(c.id);
  const docs = await db.documents.where('folderId').equals(id).toArray();
  for (const d of docs) await db.documents.update(d.id, { deletedAt: Date.now(), folderId: null });
  await db.folders.delete(id);
  requestSync();
}

export async function folderPath(id: string | null): Promise<Folder[]> {
  const path: Folder[] = [];
  let cur = id;
  while (cur) {
    const f = await db.folders.get(cur);
    if (!f) break;
    path.unshift(f);
    cur = f.parentFolderId;
  }
  return path;
}

export async function storageStats() {
  const docs = await db.documents.toArray();
  const pages = await db.pages.count();
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
  return {
    documents: docs.filter((d) => !d.deletedAt).length,
    trashed: docs.filter((d) => d.deletedAt).length,
    pages,
    bytes: docs.reduce((s, d) => s + d.size, 0),
    usage: est?.usage ?? 0,
    quota: est?.quota ?? 0
  };
}
