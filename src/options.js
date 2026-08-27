import { db } from './db.js';
import {
  SHEET_COL_DEFS,
  SHEET_FONT_DEFS
} from './constants.js';
import { nowIso, round2, safeJson } from './utils.js';

const ALIGNS = ['left', 'center', 'right'];
const W_MIN = 24;
const W_MAX = 800;
const FONT_MIN = 8;
const FONT_MAX = 80;
const TOTAL_MAX = 3800;
const MAX_VALUES = 400;

export function sheetLayoutDefault() {
  const fonts = Object.fromEntries(SHEET_FONT_DEFS.map((item) => [item.k, item.v]));
  const cols = Object.fromEntries(SHEET_COL_DEFS.map((item) => [item.k, { w: item.w, size: fonts.cell, align: item.align }]));
  return { fonts, cols };
}

export const APP_OPTION_DEFAULTS = {
  ports: ['C1C2', 'A2', 'KERRY', 'A0', 'B4', 'B2', 'SiamCSP', 'A1', 'A3', 'A4', 'A5', 'B1', 'B3', 'B5', 'C0', 'C3', 'D1D2', 'D3', 'KSSP'],
  emPorts: ['KERRY', 'C1C2', 'A2', 'A3', 'D1D2', 'D3'],
  seal: { from: 5, to: 500, step: 5, extra: [] },
  knock: { from: 100, to: 3000, step: 100, extra: [] },
  overtime: { perSet: 400, maxSets: 20 },
  sheet: sheetLayoutDefault()
};

const portKey = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9ก-๙]/g, '');

function normTextList(value, fallback, allowEmpty = false) {
  let raw = value;
  if (typeof raw === 'string') raw = safeJson(raw, raw.split(','));
  if (!Array.isArray(raw)) return [...fallback];
  const out = [];
  const seen = new Set();
  for (const item of raw.slice(0, 300)) {
    const text = String(item ?? '').trim().slice(0, 40);
    const key = allowEmpty ? portKey(text) : text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.length || allowEmpty ? out : [...fallback];
}

function normRange(value, fallback) {
  const raw = typeof value === 'string' ? safeJson(value, {}) : (value || {});
  let step = Number(raw.step); if (!(step > 0)) step = fallback.step;
  let from = Number(raw.from); if (!(from > 0)) from = fallback.from;
  let to = Number(raw.to); if (!(to > 0)) to = fallback.to;
  if (to < from) to = from;
  if ((to - from) / step + 1 > MAX_VALUES) to = from + step * (MAX_VALUES - 1);
  const extra = [...new Set((Array.isArray(raw.extra) ? raw.extra : []).map(round2).filter((n) => n > 0))].slice(0, 100);
  return { from: round2(from), to: round2(to), step: round2(step), extra };
}

function normOvertime(value, fallback) {
  const raw = typeof value === 'string' ? safeJson(value, {}) : (value || {});
  let perSet = raw.perSet === '' || raw.perSet == null || Number.isNaN(Number(raw.perSet)) ? fallback.perSet : round2(raw.perSet);
  let maxSets = Number.parseInt(raw.maxSets, 10);
  if (perSet < 0) perSet = 0;
  if (!(maxSets > 0)) maxSets = fallback.maxSets;
  return { perSet, maxSets: Math.min(maxSets, 100) };
}

const clamp = (value, min, max, fallback) => {
  let number = Number(value);
  if (!(number > 0)) return fallback;
  number = Math.max(min, Math.min(max, number));
  return Math.round(number * 10) / 10;
};

export function normSheetLayout(value, fallback = sheetLayoutDefault()) {
  const raw = typeof value === 'string' ? safeJson(value, {}) : (value || {});
  const out = { fonts: {}, cols: {} };
  for (const def of SHEET_FONT_DEFS) out.fonts[def.k] = clamp(raw.fonts?.[def.k], FONT_MIN, FONT_MAX, fallback.fonts[def.k]);
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
  if (total > TOTAL_MAX) {
    const scale = TOTAL_MAX / total;
    for (const def of SHEET_COL_DEFS) out.cols[def.k].w = Math.max(W_MIN, Math.round(out.cols[def.k].w * scale));
  }
  return out;
}

function normalize(key, value, current = APP_OPTION_DEFAULTS[key]) {
  if (key === 'ports') return normTextList(value, current);
  if (key === 'emPorts') return normTextList(value, current, true);
  if (key === 'seal' || key === 'knock') return normRange(value, APP_OPTION_DEFAULTS[key]);
  if (key === 'overtime') return normOvertime(value, APP_OPTION_DEFAULTS.overtime);
  if (key === 'sheet') return normSheetLayout(value, current);
  return current;
}

export function readAppOptions() {
  const saved = Object.fromEntries(db.prepare('SELECT key, value_json FROM app_options').all().map((row) => [row.key, safeJson(row.value_json)]));
  const out = {};
  const insert = db.prepare('INSERT OR IGNORE INTO app_options (key, value_json, updated_at) VALUES (?, ?, ?)');
  for (const key of Object.keys(APP_OPTION_DEFAULTS)) {
    out[key] = normalize(key, saved[key] === undefined ? APP_OPTION_DEFAULTS[key] : saved[key]);
    insert.run(key, JSON.stringify(out[key]), nowIso());
  }
  return out;
}

export function writeAppOption(key, value) {
  if (!(key in APP_OPTION_DEFAULTS)) return;
  const current = readAppOptions()[key];
  const clean = normalize(key, value, current);
  db.prepare(`INSERT INTO app_options (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(clean), nowIso());
}

function rangeValues(cfg) {
  const values = [];
  const seen = new Set();
  const push = (value) => {
    const clean = round2(value);
    if (clean > 0 && !seen.has(clean) && values.length < MAX_VALUES) { seen.add(clean); values.push(clean); }
  };
  for (let value = cfg.from; value <= cfg.to + 0.0001 && values.length < MAX_VALUES; value = round2(value + cfg.step)) push(value);
  for (const value of cfg.extra) push(value);
  return values.sort((a, b) => a - b);
}

export function appOptionsPayload() {
  const options = readAppOptions();
  return {
    ...options,
    sealValues: rangeValues(options.seal),
    knockValues: rangeValues(options.knock),
    knockLabel: 'ค่าน็อคตู้',
    sheetDefs: {
      cols: SHEET_COL_DEFS, fonts: SHEET_FONT_DEFS, aligns: ALIGNS,
      wMin: W_MIN, wMax: W_MAX, fontMin: FONT_MIN, fontMax: FONT_MAX, totalMax: TOTAL_MAX
    }
  };
}
