import { createHash } from 'node:crypto';
import { and, inArray, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import { appOptions, invoices, settlements } from '@/db/schema';
import { SPECIAL_PER_CONTAINER } from './settlements';
import { signedUrlFor } from './storage';
import type { ApiBody, ApiResult } from './types';
import { fmtDateStr, nowIso, round2, safeJson } from './utils';

/**
 * ส่งค่าบริการเพิ่มเติมพิเศษของ BL (จากใบปิดบัญชีชิปปิ้ง) พร้อมรูปแนบ ไปให้ฝ่ายขาย ERP KOLA เจรจา
 * สเปกฝั่ง KOLA: SHIPME-SPECIAL-CHARGES-API.md — POST /api/shipme/special-charges
 *
 * ตั้งค่า (Vercel env ของโปรเจกต์นี้):
 *   KOLA_SPECIALS_KEY = ค่าเดียวกับ SHIPME_API_KEY ฝั่ง KOLA (ว่าง = ปิดส่ง)
 *   KOLA_SPECIALS_URL = ไม่ต้องตั้ง ถ้าใช้ https://erp-kola.vercel.app/api/shipme/special-charges
 *
 * ส่งตอนฝ่ายบัญชีจัดชุด/เพิ่มใบเข้าชุด (หน้าเว็บเรียก pushKolaSpecials ต่อทันที) และกดส่งซ้ำเองได้
 * BL ละ 1 ชุดที่ KOLA — batchId = SHIPME-<BL> ส่งซ้ำได้ (KOLA แทนชุดเดิมถ้ายังไม่เริ่มเจรจา)
 * ถ้าเริ่มเจรจาแล้ว (409) แต่รายการเปลี่ยน → ส่งเป็นชุดใหม่ SHIPME-<BL>-2, -3 …
 * สถานะล่าสุดเก็บใน app_options คีย์ kolaSpc:<BL> (ไม่ต้อง migration)
 */

const DEFAULT_URL = 'https://erp-kola.vercel.app/api/shipme/special-charges';
const STATE_PREFIX = 'kolaSpc:';
// ค่าน็อคตู้ไม่ส่ง KOLA (เจ้าของแจ้ง 9 พ.ย. 69) — รองรับสะกด ็ / ๊
const SKIP_LABEL = /น[็๊]?อค/;
const MAX_ATTACHMENTS = 10;      // เพดานฝั่ง KOLA
const MAX_ITEMS = 100;
const CALL_TIMEOUT_MS = 25000;   // KOLA ดาวน์โหลดรูปเองไฟล์ละไม่เกิน 20 วินาที
const BUDGET_MS = 45000;         // /api ตัดที่ 55 วินาที — BL ที่ไม่ทันให้กดส่งอีกครั้ง
const CONCURRENCY = 3;

const CODES: Record<string, string> = { 'ยางเกิน': 'TIRE_OVER', 'สำแดงเท็จ': 'FALSE_DECL' };

export const kolaBlKey = (bl: unknown) => String(bl ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

type Item = { code: string; description: string; quantity: number; amount: number; note?: string };
type Photo = { path: string; fileName: string };
export type KolaSpcState = {
  bl: string; batchId: string; rev: number; hash: string;
  status: 'sent' | 'negotiating' | 'error' | 'none';
  kolaId?: string; jobMatched?: boolean; warning?: string; error?: string;
  items: number; total: number; photos: number; sentPhotos: number;
  invoiceNo?: string; sentAt: string;
};

function config() {
  const key = String(process.env.KOLA_SPECIALS_KEY || '').trim();
  const url = String(process.env.KOLA_SPECIALS_URL || '').trim() || DEFAULT_URL;
  return { key, url };
}

/** รูปในฐานข้อมูลเป็น /files/specials/<ชื่อ> — แปลงเป็นคีย์ใน Storage */
function storageKey(url: string) {
  const match = /^\/files\/(specials)\/(.+)$/.exec(url);
  if (!match) return '';
  try { return `${match[1]}/${decodeURIComponent(match[2])}`; } catch { return ''; }
}

/**
 * ค่าพิเศษของ BL จากทุกใบปิดบัญชีที่มี BL นี้ (BL เดียวตรวจปล่อยหลายวันได้)
 * หัวข้อรายตู้ (ยางเกิน/สำแดงเท็จ) แยกเป็นรายการละตู้ ให้ฝ่ายขายต่อรองทีละตู้ได้
 */
export async function collectBlSpecials(bl: string) {
  const key = kolaBlKey(bl);
  // กรองหยาบด้วยข้อความ BL (ตามที่พิมพ์ หรือแบบตัดช่องว่าง/ขีด) แล้วเทียบ BL ทีละแถวด้านล่าง
  const like = `%${String(bl).trim().replace(/[%_\\]/g, '')}%`;
  const rows = await db.select({
    id: settlements.id, name: settlements.name, inspectDate: settlements.inspectDate, rowsJson: settlements.rowsJson
  }).from(settlements).where(sql`(${settlements.rowsJson} ilike ${like} or ${settlements.rowsJson} ilike ${`%${key}%`})`)
    .orderBy(settlements.inspectDate).limit(50);

  const items: Item[] = [];
  const photos: Photo[][] = [];   // รูปแยกตามรายการ — เลือกแบบวนทีละรายการตอนเกินเพดาน
  for (const settlement of rows) {
    const where = `ชิปปิ้ง ${settlement.name} · ตรวจปล่อย ${fmtDateStr(settlement.inspectDate)}`;
    for (const row of safeJson<any[]>(settlement.rowsJson, [])) {
      if (kolaBlKey(row?.bl) !== key) continue;
      for (const special of Array.isArray(row?.specials) ? row.specials : []) {
        const label = String(special?.label || '').trim();
        if (!label || SKIP_LABEL.test(label.replace(/\s+/g, ''))) continue;
        const code = CODES[label] || 'SPECIAL';
        const perContainer = SPECIAL_PER_CONTAINER.includes(label) && Array.isArray(special?.items) && special.items.length;
        if (perContainer) {
          for (const item of special.items) {
            const amount = round2(item?.amount);
            if (!(amount > 0)) continue;
            const container = String(item?.container || '').trim().toUpperCase();
            const list = (Array.isArray(item?.photos) ? item.photos : []).map(String);
            items.push({ code, description: `${label} ตู้ ${container}`, quantity: 1, amount,
              note: `${where} · รูป ${list.length} รูป` });
            photos.push(list.map((url: string, i: number) => ({
              path: storageKey(url),
              fileName: `${code}_${container.replace(/[^A-Z0-9]/g, '') || 'CNT'}_${i + 1}.jpg`
            })).filter((p: Photo) => p.path));
          }
        } else {
          const amount = round2(special?.amount);
          if (!(amount > 0)) continue;
          items.push({ code, description: label, quantity: Math.max(1, Number(row?.containers) || 1), amount,
            note: where + (row?.containers ? ` · ${row.containers} ตู้` : '') });
          photos.push([]);
        }
      }
    }
  }
  return { items: items.slice(0, MAX_ITEMS), photos: photos.slice(0, MAX_ITEMS) };
}

/** เกิน 10 รูป → หยิบวนทีละรายการ ให้ทุกตู้มีรูปอย่างน้อย 1 รูปก่อน */
function pickPhotos(groups: Photo[][]) {
  const out: Photo[] = [];
  for (let round = 0; out.length < MAX_ATTACHMENTS; round += 1) {
    let any = false;
    for (const group of groups) {
      if (group[round]) { any = true; out.push(group[round]); if (out.length >= MAX_ATTACHMENTS) break; }
    }
    if (!any) break;
  }
  return out;
}

async function readStates(keys: string[]) {
  const map = new Map<string, KolaSpcState>();
  const wanted = [...new Set(keys.filter(Boolean))].map((k) => STATE_PREFIX + k);
  if (!wanted.length) return map;
  const rows = await db.select({ key: appOptions.key, valueJson: appOptions.valueJson })
    .from(appOptions).where(inArray(appOptions.key, wanted));
  for (const row of rows) {
    const value = safeJson<KolaSpcState | null>(row.valueJson, null);
    if (value) map.set(row.key.slice(STATE_PREFIX.length), value);
  }
  return map;
}

/** สถานะส่ง KOLA ของหลาย BL — listInvoices แนบไปกับแต่ละใบ */
export async function kolaSpecialStates(bls: string[]) {
  return readStates(bls.map(kolaBlKey));
}

async function writeState(key: string, state: KolaSpcState) {
  const valueJson = JSON.stringify(state);
  const updatedAt = nowIso();
  await db.insert(appOptions).values({ key: STATE_PREFIX + key, valueJson, updatedAt })
    .onConflictDoUpdate({ target: appOptions.key, set: { valueJson, updatedAt } });
}

async function postKola(url: string, apiKey: string, payload: unknown) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
    });
    const body = await res.json().catch(() => ({})) as any;
    return { status: res.status, body };
  } catch (err) {
    const timeout = err instanceof Error && /timeout|abort/i.test(err.name + err.message);
    return { status: 0, body: { error: timeout ? 'KOLA ตอบช้าเกิน 25 วินาที' : 'เชื่อมต่อ ERP KOLA ไม่ได้' } };
  }
}

/** ส่ง BL เดียว — คืนสถานะที่บันทึกไว้ */
async function pushOne(bl: string, invoiceNo: string, batchName: string, prev: KolaSpcState | undefined,
  force: boolean, cfg: { key: string; url: string }): Promise<KolaSpcState & { skipped?: boolean }> {
  const key = kolaBlKey(bl);
  const { items, photos } = await collectBlSpecials(bl);
  const total = round2(items.reduce((sum, item) => sum + item.amount, 0));
  const allPhotos = photos.reduce((n, g) => n + g.length, 0);
  const hash = createHash('sha1').update(JSON.stringify([items, photos])).digest('hex').slice(0, 16);
  const base = { bl, invoiceNo, items: items.length, total, photos: allPhotos, sentAt: nowIso() };

  if (!items.length) {
    // ไม่มีค่าพิเศษ — ไม่จดสถานะ (ถ้าเคยส่งไปแล้วแต่ภายหลังลบหมด ให้คงสถานะเดิมไว้ให้เห็น)
    return { ...base, batchId: prev?.batchId || '', rev: prev?.rev || 1, hash, status: 'none', sentPhotos: 0 };
  }
  if (!force && prev && prev.hash === hash && (prev.status === 'sent' || prev.status === 'negotiating')) {
    return { ...prev, skipped: true };
  }

  const picked = pickPhotos(photos);
  const attachments: { fileName: string; contentType: string; url: string }[] = [];
  for (const photo of picked) {
    const signed = await signedUrlFor(photo.path);
    if (signed) attachments.push({ fileName: photo.fileName, contentType: 'image/jpeg', url: signed });
  }
  const notes = [batchName, invoiceNo ? `ใบแจ้งหนี้ ${invoiceNo}` : ''].filter(Boolean);
  if (allPhotos > attachments.length) {
    notes.push(`รูปทั้งหมด ${allPhotos} รูป ส่งมา ${attachments.length} รูป (KOLA รับได้ ${MAX_ATTACHMENTS}) ที่เหลือดูได้ในใบปิดบัญชี ERP SHIPME`);
  }
  const payloadFor = (batchId: string) => ({
    batchId, blNo: bl, invoiceNo: invoiceNo || undefined,
    issuedAt: new Date().toISOString(), currency: 'THB',
    note: notes.join(' · ').slice(0, 2000),
    items, attachments
  });

  let rev = prev?.rev || 1;
  let batchId = prev?.batchId || `SHIPME-${key}`;
  let res = await postKola(cfg.url, cfg.key, payloadFor(batchId));
  if (res.status === 409) {
    // ฝ่ายขายเริ่มเจรจาชุดนี้แล้ว — ข้อมูลเหมือนเดิม = ถือว่าส่งครบแล้ว / เปลี่ยน = ส่งเป็นชุดใหม่
    if (!prev || !prev.hash || prev.hash === hash) {
      const state: KolaSpcState = { ...base, batchId, rev, hash, status: 'negotiating',
        kolaId: res.body?.id, sentPhotos: prev?.sentPhotos ?? attachments.length };
      await writeState(key, state);
      return state;
    }
    rev += 1;
    batchId = `SHIPME-${key}-${rev}`;
    res = await postKola(cfg.url, cfg.key, payloadFor(batchId));
  }
  const ok = res.status === 200 || res.status === 201;
  const state: KolaSpcState = {
    ...base, batchId, rev, hash, sentPhotos: ok ? attachments.length : 0,
    status: ok ? 'sent' : 'error',
    kolaId: res.body?.id || prev?.kolaId,
    jobMatched: ok ? Boolean(res.body?.jobMatched) : prev?.jobMatched,
    warning: ok && res.body?.warning ? String(res.body.warning).slice(0, 300) : undefined,
    error: ok ? undefined : `${res.status ? `HTTP ${res.status}: ` : ''}${String(res.body?.error || 'ส่งไม่สำเร็จ').slice(0, 300)}`
  };
  // ส่งไม่สำเร็จ: hash = ของที่ KOLA มีอยู่จริง (ครั้งล่าสุดที่สำเร็จ) ใช้ตัดสินตอนเจอ 409 ครั้งหน้า
  if (!ok) state.hash = prev?.hash || '';
  await writeState(key, state);
  return state;
}

/**
 * ส่งค่าพิเศษของ BL ในชุดเอกสาร (batchNo + period) หรือของใบที่เลือก (numbers)
 * force = กดส่งซ้ำเอง (ส่งแม้ข้อมูลไม่เปลี่ยน — เช่น ลิงก์รูปหมดอายุก่อน KOLA ดาวน์โหลด)
 */
export async function pushKolaSpecials(body: ApiBody): Promise<ApiResult> {
  const cfg = config();
  if (!cfg.key) return { ok: true, configured: false, results: [] };

  const numbers = Array.isArray(body.numbers)
    ? [...new Set(body.numbers.map((n: unknown) => String(n ?? '').trim().slice(0, 40)).filter(Boolean))].slice(0, 200)
    : [];
  const batchNo = Number(body.batchNo);
  const period = String(body.period ?? '').trim();
  let scope;
  if (numbers.length) scope = inArray(invoices.number, numbers as string[]);
  else if (Number.isInteger(batchNo) && /^\d{6}$/.test(period)) {
    scope = and(sql`${invoices.batchNo} = ${batchNo}`, sql`${invoices.batchPeriod} = ${period}`);
  } else return { ok: false, error: 'bad_request' };

  const rows = await db.select({ number: invoices.number, bl: invoices.bl, batchName: invoices.batchName })
    .from(invoices).where(and(scope, ne(invoices.status, 'cancelled')));
  // BL ละครั้ง — ใบ V กับ NV ของ BL เดียวกันรวมเป็นชุดเดียว
  const byBl = new Map<string, { bl: string; numbers: string[]; batchName: string }>();
  for (const row of rows) {
    const key = kolaBlKey(row.bl);
    if (!key) continue;
    const entry = byBl.get(key) || { bl: row.bl.trim(), numbers: [], batchName: row.batchName };
    entry.numbers.push(row.number);
    byBl.set(key, entry);
  }
  const force = body.force === true;
  const states = await readStates([...byBl.keys()]);
  const queue = [...byBl.entries()];
  const results: any[] = [];
  const started = Date.now();
  const worker = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [key, entry] = next;
      if (Date.now() - started > BUDGET_MS) {
        results.push({ bl: entry.bl, status: 'pending' });
        continue;
      }
      try {
        const state = await pushOne(entry.bl, entry.numbers.sort().join(', '), entry.batchName, states.get(key), force, cfg);
        results.push(state);
      } catch (err) {
        console.error('[kola-specials]', entry.bl, err);
        results.push({ bl: entry.bl, status: 'error', error: 'ระบบผิดพลาด' });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const count = (status: string) => results.filter((r) => r.status === status).length;
  return {
    ok: true, configured: true, results,
    summary: { sent: count('sent'), negotiating: count('negotiating'), none: count('none'),
      error: count('error'), pending: count('pending') }
  };
}
