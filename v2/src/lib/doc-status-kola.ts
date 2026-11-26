/**
 * ถามสถานะ DO จาก ERP-KOLA — GET <โดเมน KOLA>/api/shipme/doc-status?bl=..  (สเปก: ERP-KOLA docs/SHIPME-TRANSPORT-REQUEST.md)
 *
 * ใช้คีย์และโดเมนชุดเดียวกับที่ส่งค่าพิเศษให้ KOLA (KOLA_SPECIALS_KEY / KOLA_SPECIALS_URL)
 * ถามทุกครั้งที่เปิดแพลน ไม่เก็บซ้ำ — สถานะ DO เปลี่ยนที่ KOLA ภายหลังเสมอ
 * ถามไม่ได้ (ไม่มีคีย์ · KOLA ล่ม · คีย์ผิด · ช้าเกิน 4 วินาที) = null → หน้าเว็บแสดง "?" ห้ามเดาว่าพร้อมหรือไม่พร้อม
 */
export type KolaDo = 'yes' | 'no' | 'notfound';
export type KolaConfig = { key: string; url: string };

const CHUNK = 300;
const TIMEOUT_MS = 4000;
const DEFAULT_URL = 'https://erp-kola.vercel.app/api/shipme/special-charges';

export function kolaConfig(): KolaConfig {
  return {
    key: String(process.env.KOLA_SPECIALS_KEY || '').trim(),
    url: String(process.env.KOLA_SPECIALS_URL || '').trim() || DEFAULT_URL
  };
}

export function kolaDocStatusUrl(baseUrl: string, keys: string[]) {
  const params = new URLSearchParams();
  keys.forEach((k) => params.append('bl', k));
  return `${new URL(baseUrl).origin}/api/shipme/doc-status?${params}`;
}

export async function fetchKolaDo(
  keys: string[], cfg: KolaConfig = kolaConfig(), fetcher: typeof fetch = fetch
): Promise<Map<string, KolaDo> | null> {
  if (!cfg.key) return null;
  const out = new Map<string, KolaDo>();
  try {
    for (let i = 0; i < keys.length; i += CHUNK) {
      const res = await fetcher(kolaDocStatusUrl(cfg.url, keys.slice(i, i + CHUNK)), {
        headers: { Authorization: `Bearer ${cfg.key}` }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store'
      });
      if (!res.ok) return null;
      const body = await res.json() as { ok?: boolean; items?: Record<string, { found?: boolean; doExchangedAt?: string | null }> };
      if (!body?.ok) return null;
      for (const [k, v] of Object.entries(body.items || {})) out.set(k, !v?.found ? 'notfound' : (v.doExchangedAt ? 'yes' : 'no'));
    }
  } catch {
    return null;
  }
  return out;
}
