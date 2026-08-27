import { db } from '@/db';
import { appOptions } from '@/db/schema';
import { KNOCK_LABEL, SHEET_COL_DEFS, SHEET_FONT_DEFS } from './constants';
import { nowIso, round2, safeJson } from './utils';

const ALIGNS = ['left', 'center', 'right'];
const W_MIN = 24;
const W_MAX = 800;
const FONT_MIN = 8;
const FONT_MAX = 80;
const TOTAL_MAX = 3800;
const MAX_VALUES = 400;

export type SheetLayout = {
  fonts: Record<string, number>;
  cols: Record<string, { w: number; size: number; align: string }>;
};

export function sheetLayoutDefault(): SheetLayout {
  const fonts = Object.fromEntries(SHEET_FONT_DEFS.map((item) => [item.k, item.v]));
  const cols = Object.fromEntries(
    SHEET_COL_DEFS.map((item) => [item.k, { w: item.w, size: fonts.cell, align: item.align }])
  );
  return { fonts, cols };
}

export type RangeOption = { from: number; to: number; step: number; extra: number[] };
export type OvertimeOption = { perSet: number; maxSets: number };
export type AppOptions = {
  ports: string[];
  emPorts: string[];
  seal: RangeOption;
  knock: RangeOption;
  overtime: OvertimeOption;
  sheet: SheetLayout;
};

export const APP_OPTION_DEFAULTS: AppOptions = {
  ports: ['C1C2', 'A2', 'KERRY', 'A0', 'B4', 'B2', 'SiamCSP', 'A1', 'A3', 'A4', 'A5', 'B1', 'B3', 'B5', 'C0', 'C3', 'D1D2', 'D3', 'KSSP'],
  // ท่าที่คิดค่า EXTRA MOVEMENT ให้อัตโนมัติ — ท่าอื่นปล่อยว่างให้พนักงานกรอกเอง
  emPorts: ['KERRY', 'C1C2', 'A2', 'A3', 'D1D2', 'D3'],
  seal: { from: 5, to: 500, step: 5, extra: [] },
  knock: { from: 100, to: 3000, step: 100, extra: [] },
  overtime: { perSet: 400, maxSets: 20 },
  sheet: sheetLayoutDefault()
};

/** เทียบชื่อท่าแบบไม่สนตัวพิมพ์/ช่องว่าง/ขีด — ชีตงานขนส่งเขียนได้หลายแบบ (D1D2 / d1-d2) */
const portKey = (value: unknown) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9ก-๙]/g, '');

function normTextList(value: unknown, fallback: string[], allowEmpty = false): string[] {
  let raw: unknown = value;
  if (typeof raw === 'string') raw = safeJson<unknown>(raw, raw.split(','));
  if (!Array.isArray(raw)) return [...fallback];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 300)) {
    const text = String(item ?? '').trim().slice(0, 40);
    const key = allowEmpty ? portKey(text) : text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  // emPorts ติ๊กออกหมดได้ (= ไม่คิดให้ท่าไหนเลย) จึงไม่ย้อนกลับไปใช้ค่าตั้งต้น
  return out.length || allowEmpty ? out : [...fallback];
}

function normRange(value: unknown, fallback: RangeOption): RangeOption {
  const raw = (typeof value === 'string' ? safeJson<any>(value, {}) : (value || {})) as any;
  let step = Number(raw.step); if (!(step > 0)) step = fallback.step;
  let from = Number(raw.from); if (!(from > 0)) from = fallback.from;
  let to = Number(raw.to); if (!(to > 0)) to = fallback.to;
  if (to < from) to = from;
  // ตั้ง step เล็กเกินไปจะได้ตัวเลือกเป็นพัน มือถือเลื่อนไม่ไหว — ตัดปลายช่วงลงให้พอดีเพดาน
  if ((to - from) / step + 1 > MAX_VALUES) to = from + step * (MAX_VALUES - 1);
  const extra = [...new Set((Array.isArray(raw.extra) ? raw.extra : []).map(round2).filter((n: number) => n > 0))].slice(0, 100);
  return { from: round2(from), to: round2(to), step: round2(step), extra: extra as number[] };
}

function normOvertime(value: unknown, fallback: OvertimeOption): OvertimeOption {
  const raw = (typeof value === 'string' ? safeJson<any>(value, {}) : (value || {})) as any;
  let perSet = raw.perSet === '' || raw.perSet == null || Number.isNaN(Number(raw.perSet))
    ? fallback.perSet : round2(raw.perSet);
  let maxSets = Number.parseInt(raw.maxSets, 10);
  if (perSet < 0) perSet = 0;
  if (!(maxSets > 0)) maxSets = fallback.maxSets;
  return { perSet, maxSets: Math.min(maxSets, 100) };
}

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  let n = Number(value);
  if (!(n > 0)) return fallback;
  n = Math.max(min, Math.min(max, n));
  return Math.round(n * 10) / 10;
};

export function normSheetLayout(value: unknown, fallback: SheetLayout = sheetLayoutDefault()): SheetLayout {
  const raw = (typeof value === 'string' ? safeJson<any>(value, {}) : (value || {})) as any;
  const out: SheetLayout = { fonts: {}, cols: {} };
  for (const def of SHEET_FONT_DEFS) {
    out.fonts[def.k] = clamp(raw.fonts?.[def.k], FONT_MIN, FONT_MAX, fallback.fonts[def.k]);
  }
  let total = 0;
  for (const def of SHEET_COL_DEFS) {
    const base = fallback.cols[def.k] || sheetLayoutDefault().cols[def.k];
    const col = raw.cols?.[def.k] || {};
    out.cols[def.k] = {
      w: Math.round(clamp(col.w, W_MIN, W_MAX, base.w)),
      size: clamp(col.size, FONT_MIN, FONT_MAX, base.size),
      align: ALIGNS.includes(String(col.align)) ? String(col.align) : base.align
    };
    total += out.cols[def.k].w;
  }
  // รวมทุกคอลัมน์กว้างเกินไป = ภาพใหญ่จน iOS Safari วาดออกมาว่าง ย่อตามสัดส่วนให้พอดี
  if (total > TOTAL_MAX) {
    const scale = TOTAL_MAX / total;
    for (const def of SHEET_COL_DEFS) {
      out.cols[def.k].w = Math.max(W_MIN, Math.round(out.cols[def.k].w * scale));
    }
  }
  return out;
}

type OptionKey = keyof AppOptions;

function normalize<K extends OptionKey>(key: K, value: unknown, current: AppOptions[K] = APP_OPTION_DEFAULTS[key]): AppOptions[K] {
  if (key === 'ports') return normTextList(value, current as string[]) as AppOptions[K];
  if (key === 'emPorts') return normTextList(value, current as string[], true) as AppOptions[K];
  if (key === 'seal' || key === 'knock') return normRange(value, APP_OPTION_DEFAULTS[key] as RangeOption) as AppOptions[K];
  if (key === 'overtime') return normOvertime(value, APP_OPTION_DEFAULTS.overtime) as AppOptions[K];
  if (key === 'sheet') return normSheetLayout(value, current as SheetLayout) as AppOptions[K];
  return current;
}

export async function readAppOptions(): Promise<AppOptions> {
  const rows = await db.select({ key: appOptions.key, valueJson: appOptions.valueJson }).from(appOptions);
  const saved = Object.fromEntries(rows.map((row) => [row.key, safeJson<unknown>(row.valueJson, undefined)]));

  const out = {} as AppOptions;
  const missing: { key: string; valueJson: string; updatedAt: string }[] = [];
  for (const key of Object.keys(APP_OPTION_DEFAULTS) as OptionKey[]) {
    const raw = saved[key] === undefined ? APP_OPTION_DEFAULTS[key] : saved[key];
    (out as any)[key] = normalize(key, raw);
    // คีย์ใหม่ที่เพิ่งเพิ่มในโค้ดจะโผล่มาในฐานข้อมูลเอง ไม่ต้องรัน migration แยก
    if (saved[key] === undefined) {
      missing.push({ key, valueJson: JSON.stringify(out[key]), updatedAt: nowIso() });
    }
  }
  if (missing.length) await db.insert(appOptions).values(missing).onConflictDoNothing();
  return out;
}

export async function writeAppOption(key: string, value: unknown) {
  if (!(key in APP_OPTION_DEFAULTS)) return;
  const optionKey = key as OptionKey;
  const current = (await readAppOptions())[optionKey];
  const clean = normalize(optionKey, value, current);
  const updatedAt = nowIso();
  await db.insert(appOptions)
    .values({ key: optionKey, valueJson: JSON.stringify(clean), updatedAt })
    .onConflictDoUpdate({
      target: appOptions.key,
      set: { valueJson: JSON.stringify(clean), updatedAt }
    });
}

function rangeValues(cfg: RangeOption) {
  const values: number[] = [];
  const seen = new Set<number>();
  const push = (value: number) => {
    const clean = round2(value);
    if (clean > 0 && !seen.has(clean) && values.length < MAX_VALUES) { seen.add(clean); values.push(clean); }
  };
  for (let value = cfg.from; value <= cfg.to + 0.0001 && values.length < MAX_VALUES; value = round2(value + cfg.step)) push(value);
  for (const value of cfg.extra) push(value);
  return values.sort((a, b) => a - b);
}

export async function appOptionsPayload() {
  const options = await readAppOptions();
  return {
    ...options,
    sealValues: rangeValues(options.seal),
    knockValues: rangeValues(options.knock),
    knockLabel: KNOCK_LABEL,
    sheetDefs: {
      cols: SHEET_COL_DEFS, fonts: SHEET_FONT_DEFS, aligns: ALIGNS,
      wMin: W_MIN, wMax: W_MAX, fontMin: FONT_MIN, fontMax: FONT_MAX, totalMax: TOTAL_MAX
    }
  };
}
