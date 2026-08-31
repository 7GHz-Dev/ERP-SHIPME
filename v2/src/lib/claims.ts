import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { claimRates, claims } from '@/db/schema';
import { AUTO_MIN_CONTAINERS, CLAIM_ITEM_DEFAULTS, CLAIM_MAX_EDITS } from './constants';
import { appOptionsPayload, readAppOptions } from './options';
import type { ApiResult } from './types';
import { fmtBaht, fmtDateStr, id, nowIso, round2, safeJson, validYmd } from './utils';

const defaultOf = (key: string) => CLAIM_ITEM_DEFAULTS.find((item) => item.key === key);

export type ClaimReason = { label: string; amount: number };
export type ClaimItem = {
  key: string; label: string; perContainer: boolean;
  rate: number; qty: number; unit: string; amount: number;
  note: string; reasons: ClaimReason[];
};

export async function readClaimItems() {
  const rows = await db.select().from(claimRates);
  const saved = Object.fromEntries(rows.map((row) => [row.key, row]));
  return CLAIM_ITEM_DEFAULTS.map((item) => ({
    key: item.key,
    label: item.label,
    perContainer: item.perContainer,
    rate: Number(saved[item.key]?.rate) || Number(item.rate) || 0,
    primary: Boolean(item.primary),
    ownQty: Boolean(item.ownQty),
    // ต่ำกว่านี้ = ไม่คิดให้อัตโนมัติ (EXTRA MOVEMENT เริ่มที่ 2 ตู้)
    minContainers: Number(AUTO_MIN_CONTAINERS[item.key]) || 0,
    input: item.input || (item.perContainer ? 'auto' : 'money'),
    optionKey: item.optionKey || '',
    reasons: item.key === 'special'
      ? safeJson<{ label: string; rate: number }[]>(saved[item.key]?.reasonsJson, item.reasons || [])
      : []
  }));
}

export async function saveClaimRates(items: unknown) {
  const incoming = Array.isArray(items) ? items : [];
  // ทำในทรานแซกชันเดียว ไม่งั้นแก้อัตราค้างกลางคันแล้วยอดเพี้ยนคนละครึ่ง
  await db.transaction(async (tx) => {
    for (const raw of incoming) {
      const item = defaultOf(String((raw as any)?.key || ''));
      if (!item) continue;
      const rate = Math.max(0, round2((raw as any).rate));
      const reasons = item.key === 'special'
        ? (Array.isArray((raw as any).reasons) ? (raw as any).reasons : [])
            .map((reason: any) => ({
              label: String(reason?.label || '').trim().slice(0, 120),
              rate: Math.max(0, round2(reason?.rate))
            }))
            .filter((reason: any) => reason.label)
        : [];
      await tx.update(claimRates)
        .set({ rate, reasonsJson: JSON.stringify(reasons), updatedAt: nowIso() })
        .where(eq(claimRates.key, item.key));
    }
  });
  return readClaimItems();
}

/** จำนวนตู้ที่ระบบคิดให้เอง — ยังไม่ถึงขั้นต่ำของหัวข้อนั้น = ไม่คิดให้ (0) */
function autoQty(key: string, containers: number) {
  const min = Number(AUTO_MIN_CONTAINERS[key]) || 0;
  return min && containers < min ? 0 : containers;
}

export async function computeClaim(lines: unknown, containers: number) {
  const config = Object.fromEntries((await readClaimItems()).map((item) => [item.key, item]));
  const options = await readAppOptions();
  const items: ClaimItem[] = [];
  let total = 0;

  for (const line of Array.isArray(lines) ? lines : []) {
    const itemConfig = config[String((line as any)?.key || '')];
    if (!itemConfig) continue;
    const item: ClaimItem = {
      key: itemConfig.key, label: itemConfig.label, perContainer: itemConfig.perContainer,
      rate: 0, qty: 0, unit: '', amount: 0,
      note: String((line as any)?.note || '').trim().slice(0, 300), reasons: []
    };

    if (itemConfig.perContainer) {
      let quantity = autoQty(itemConfig.key, containers);
      const own = Number.parseInt((line as any)?.qty, 10);
      // พนักงานกดปรับจำนวนตู้ของหัวข้อนี้เอง = ใช้ค่านั้น (ข้ามกฎขั้นต่ำได้ ถ้ามีค่าใช้จ่ายจริง)
      if (itemConfig.ownQty && own > 0) quantity = Math.min(own, 999);
      if (!(quantity > 0)) continue;          // 0 ตู้ = ไม่มีอะไรให้คิด ไม่ต้องบันทึกบรรทัดนี้
      item.rate = itemConfig.rate;
      item.qty = quantity;
      item.unit = 'ตู้';
      item.amount = round2(item.rate * quantity);
    } else if (itemConfig.input === 'sets') {
      item.qty = Math.max(0, Math.min(Number.parseInt((line as any)?.qty, 10) || 0, options.overtime.maxSets));
      item.rate = options.overtime.perSet;
      item.unit = 'ชุด';
      item.amount = round2(item.qty * item.rate);
    } else if (itemConfig.key === 'special') {
      for (const reason of Array.isArray((line as any)?.reasons) ? (line as any).reasons : []) {
        const label = String(reason?.label || '').trim().slice(0, 120);
        const amount = Math.max(0, round2(reason?.amount));
        if (label) item.reasons.push({ label, amount });
      }
      if (!item.reasons.length) continue;     // ติ๊กหัวข้อแต่ไม่ได้เลือกเหตุผล = ไม่นับ
      item.amount = round2(item.reasons.reduce((sum, reason) => sum + reason.amount, 0));
    } else {
      item.amount = Math.max(0, round2((line as any)?.amount));
    }

    items.push(item);
    total += item.amount;
  }
  return { items, total: round2(total) };
}

type ClaimRecord = {
  id: string; username: string; name: string; inspectDate: string; containers: number;
  total: number; editCount: number; items: ClaimItem[];
  detail?: string; detailAll?: string; detailFirst?: string; editDetails?: string[];
};

function itemLine(item: ClaimItem) {
  if (item.perContainer || item.unit) {
    return `${item.label} = ${fmtBaht(item.rate)} x ${item.qty} ${item.unit || 'ตู้'} = ${fmtBaht(item.amount)}`;
  }
  return `${item.label}${item.note ? ` (${item.note})` : ''} = ${fmtBaht(item.amount)}`;
}

function claimDetail(record: ClaimRecord) {
  const lines = [
    '📋 สรุปยอดเบิก',
    `วันที่ตรวจปล่อย: ${fmtDateStr(record.inspectDate)}`,
    `จำนวนตู้: ${record.containers} ตู้`,
    '--------------------------------'
  ];
  for (const item of record.items) {
    if (item.key === 'special') {
      lines.push(`${item.label} = ${fmtBaht(item.amount)}`);
      for (const reason of item.reasons) lines.push(`   - ${reason.label} = ${fmtBaht(reason.amount)}`);
    } else lines.push(itemLine(item));
  }
  lines.push('--------------------------------', `รวมทั้งสิ้น ${fmtBaht(record.total)} บาท`, `ผู้เบิก: ${record.name}`);
  if (record.editCount > 0) lines.push(`(แก้ไขครั้งที่ ${record.editCount})`);
  return lines.join('\n');
}

function itemMap(items: unknown) {
  const map: Record<string, { label: string; amount: number; reasons: Record<string, number> }> = {};
  for (const raw of Array.isArray(items) ? items : []) {
    const item = raw as ClaimItem;
    map[item.key] = {
      label: String(item.label || item.key),
      amount: Number(item.amount) || 0,
      reasons: Object.fromEntries((item.reasons || []).map((r) => [r.label, Number(r.amount) || 0]))
    };
  }
  return map;
}

/**
 * ข้อความของ "การแก้ไขครั้งนั้น" — เฉพาะสิ่งที่ต่างจากใบก่อนหน้า ไม่ใช่ใบเต็ม
 * เดิมถ้าไม่มีรายการเพิ่มเลยจะคัดลอกใบเต็มแทน ซึ่งอ่านแล้วเหมือนใบเบิกใหม่ทั้งใบ
 * (เคสจริง: FOLK 31/8/2026 แก้เงินสำรอง 43,500 → 16,000 แล้วได้ใบเต็ม เสี่ยงจ่ายซ้ำ)
 * ยอดที่ "ลดลง/ตัดออก" จึงต้องขึ้นด้วย ไม่งั้นบรรทัดสรุปจะบอกยอดผิดทาง
 */
function editDetail(record: ClaimRecord, previous: { items: unknown; containers: number }) {
  const old = itemMap(previous.items);
  const up: string[] = [];        // รายการที่เพิ่มขึ้น
  const down: string[] = [];      // รายการที่ลดลง / ถูกตัดออก
  let added = 0;
  let removed = 0;
  const kept = new Set<string>();

  for (const item of record.items) {
    kept.add(item.key);
    const was = old[item.key];

    if (item.key === 'special') {
      const before = { ...(was?.reasons || {}) };
      const nestedUp: string[] = [];
      const nestedDown: string[] = [];
      let plus = 0;
      let minus = 0;
      for (const reason of item.reasons) {
        const wasAmount = Number(before[reason.label]) || 0;
        delete before[reason.label];
        if (reason.amount > wasAmount) {
          plus += reason.amount - wasAmount;
          nestedUp.push(`   - ${reason.label} = ${fmtBaht(reason.amount)}${wasAmount ? ` (เพิ่มจาก ${fmtBaht(wasAmount)})` : ''}`);
        } else if (reason.amount < wasAmount) {
          minus += wasAmount - reason.amount;
          nestedDown.push(`   - ${reason.label} = ${fmtBaht(reason.amount)} (ลดจาก ${fmtBaht(wasAmount)})`);
        }
      }
      // เหตุผลย่อยที่เคยมีแล้วถูกเอาออกทั้งบรรทัด
      for (const [label, amount] of Object.entries(before)) {
        if (!(Number(amount) > 0)) continue;
        minus += Number(amount);
        nestedDown.push(`   - ${label} = ${fmtBaht(Number(amount))}  ← ตัดออก`);
      }
      if (nestedUp.length) { added += plus; up.push(`${item.label} + ${fmtBaht(round2(plus))}`, ...nestedUp); }
      if (nestedDown.length) { removed += minus; down.push(`${item.label} - ${fmtBaht(round2(minus))}`, ...nestedDown); }
      continue;
    }

    if (!was) {
      added += item.amount;
      up.push(`${itemLine(item)}  ← เพิ่มใหม่`);
    } else if (item.amount > was.amount) {
      const difference = round2(item.amount - was.amount);
      added += difference;
      up.push(`${itemLine(item)} (เพิ่มจาก ${fmtBaht(was.amount)} = +${fmtBaht(difference)})`);
    } else if (item.amount < was.amount) {
      const difference = round2(was.amount - item.amount);
      removed += difference;
      down.push(`${itemLine(item)} (ลดจาก ${fmtBaht(was.amount)} = -${fmtBaht(difference)})`);
    }
  }

  // หัวข้อที่ใบก่อนหน้ามี แต่ใบนี้ไม่มีแล้ว
  for (const [key, was] of Object.entries(old)) {
    if (kept.has(key) || !(was.amount > 0)) continue;
    removed += was.amount;
    down.push(`${was.label} = ${fmtBaht(was.amount)}  ← ตัดออก`);
  }

  const body = [...up];
  if (down.length) body.push(...(up.length ? ['— รายการที่ลดลง —'] : []), ...down);
  if (!body.length) body.push('ไม่มีรายการที่ยอดเปลี่ยนแปลง');

  const foot: string[] = [];
  if (added) foot.push(`ยอดที่เพิ่ม ${fmtBaht(round2(added))} บาท`);
  if (removed) foot.push(`ยอดที่ลดลง ${fmtBaht(round2(removed))} บาท`);
  foot.push(`ยอดรวมใหม่ ${fmtBaht(record.total)} บาท`);

  const title = up.length ? 'รายการเบิกที่เพิ่ม' : (down.length ? 'แก้ไขยอดเบิก' : 'แก้ไขใบเบิก');
  const containerLine = previous.containers && previous.containers !== record.containers
    ? `จำนวนตู้: ${record.containers} ตู้ (เดิม ${previous.containers} ตู้)`
    : `จำนวนตู้: ${record.containers} ตู้`;

  return [
    `‼️ ${title} (แก้ไขครั้งที่ ${record.editCount})`,
    `วันที่ตรวจปล่อย: ${fmtDateStr(record.inspectDate)}`,
    containerLine,
    '--------------------------------', ...body, '--------------------------------',
    ...foot, `ผู้เบิก: ${record.name}`
  ].join('\n');
}

type ClaimDbRow = typeof claims.$inferSelect;

export function claimRow(row: ClaimDbRow) {
  const editCount = Number(row.editCount) || 0;
  const detail = String(row.detail || '');
  const editDetails = safeJson<string[]>(row.editDetailsJson, Array(CLAIM_MAX_EDITS).fill(''));
  while (editDetails.length < CLAIM_MAX_EDITS) editDetails.push('');
  return {
    id: row.id, created: row.createdAt, updated: row.updatedAt,
    username: row.username, name: row.name, inspectDate: row.inspectDate,
    containers: Number(row.containers) || 0, total: Number(row.total) || 0,
    editCount, items: safeJson<ClaimItem[]>(row.itemsJson, []), detail,
    detailAll: row.detailAll || detail,
    detailFirst: row.detailFirst || (editCount ? '' : detail),
    editDetails: editDetails.slice(0, CLAIM_MAX_EDITS), maxEdits: CLAIM_MAX_EDITS,
    editsLeft: Math.max(0, CLAIM_MAX_EDITS - editCount)
  };
}

export async function listClaims(username: string | null = null, limit = 500) {
  const rows = username
    ? await db.select().from(claims).where(eq(claims.username, username))
        .orderBy(desc(claims.updatedAt)).limit(limit)
    : await db.select().from(claims).orderBy(desc(claims.updatedAt)).limit(limit);
  return rows.map(claimRow);
}

export async function saveClaim(
  claim: any,
  user: { username: string; name: string; role: string }
): Promise<ApiResult> {
  const inspectDate = String(claim?.inspectDate || '').trim();
  const containers = Number.parseInt(claim?.containers, 10);
  if (!validYmd(inspectDate)) return { ok: false, error: 'missing_inspect_date' };
  if (!(containers > 0) || containers > 999) return { ok: false, error: 'invalid_containers' };

  const calculated = await computeClaim(claim?.items, containers);
  if (!calculated.items.length) return { ok: false, error: 'no_claim_items' };

  const now = nowIso();
  const claimId = String(claim?.id || '').trim();

  if (claimId) {
    const [row] = await db.select().from(claims).where(eq(claims.id, claimId)).limit(1);
    if (!row) return { ok: false, error: 'claim_not_found' };
    const isBoss = ['admin', 'manager'].includes(user.role);
    if (row.username.toLowerCase() !== user.username.toLowerCase() && !isBoss) {
      return { ok: false, error: 'forbidden' };
    }
    const editCount = Number(row.editCount) || 0;
    if (editCount >= CLAIM_MAX_EDITS) return { ok: false, error: 'claim_edit_limit', maxEdits: CLAIM_MAX_EDITS };

    const record: ClaimRecord = {
      id: claimId, username: row.username, name: row.name, inspectDate, containers,
      total: calculated.total, editCount: editCount + 1, items: calculated.items
    };
    record.detail = claimDetail(record);
    record.detailAll = record.detail;
    record.detailFirst = row.detailFirst || row.detailAll || row.detail;
    const editDetails = safeJson<string[]>(row.editDetailsJson, Array(CLAIM_MAX_EDITS).fill(''));
    while (editDetails.length < CLAIM_MAX_EDITS) editDetails.push('');
    editDetails[record.editCount - 1] = editDetail(record, {
      items: safeJson<ClaimItem[]>(row.itemsJson, []),
      containers: Number(row.containers) || 0
    });
    record.editDetails = editDetails;

    try {
      await db.update(claims).set({
        updatedAt: now, inspectDate, containers, total: record.total, editCount: record.editCount,
        itemsJson: JSON.stringify(record.items), detail: record.detail, detailAll: record.detailAll,
        detailFirst: record.detailFirst, editDetailsJson: JSON.stringify(editDetails)
      }).where(eq(claims.id, claimId));
    } catch (error) {
      // ชน unique (username, inspect_date) = ย้ายใบไปทับวันที่ที่เบิกไว้แล้ว
      if (String(error).includes('claims_user_date_idx')) return { ok: false, error: 'claim_date_exists' };
      throw error;
    }
    return { ok: true, mode: 'updated', record: { ...record, updated: now, maxEdits: CLAIM_MAX_EDITS } };
  }

  const [existing] = await db.select().from(claims)
    .where(and(eq(claims.username, user.username), eq(claims.inspectDate, inspectDate))).limit(1);
  if (existing) return { ok: false, error: 'claim_date_exists', record: claimRow(existing) };

  const record: ClaimRecord = {
    id: id('CL'), username: user.username, name: user.name, inspectDate, containers,
    total: calculated.total, editCount: 0, items: calculated.items
  };
  record.detail = claimDetail(record);
  record.detailAll = record.detail;
  record.detailFirst = record.detail;
  record.editDetails = Array(CLAIM_MAX_EDITS).fill('');

  await db.insert(claims).values({
    id: record.id, createdAt: now, updatedAt: now, username: record.username, name: record.name,
    inspectDate, containers, total: record.total, editCount: 0,
    itemsJson: JSON.stringify(record.items), detail: record.detail!, detailAll: record.detailAll!,
    detailFirst: record.detailFirst!, editDetailsJson: JSON.stringify(record.editDetails)
  });
  return { ok: true, mode: 'created', record: { ...record, created: now, updated: now, maxEdits: CLAIM_MAX_EDITS } };
}

export async function claimConfig(user: { role: string }) {
  return {
    ok: true,
    items: await readClaimItems(),
    options: await appOptionsPayload(),
    canEditRates: ['admin', 'manager'].includes(user.role)
  };
}
