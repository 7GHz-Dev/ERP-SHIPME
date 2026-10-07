import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  jobPlanItems, jobPlans, portAssignments, smsMessages, transportJobs, users
} from '@/db/schema';
import { TRANSPORT_SOURCE_ORDER } from './constants';
import { portKey, readAppOptions } from './options';
import { meetingMapsList, smsConfig, smsRowView } from './sms';
import { personMatches } from './transport';
import type { ApiBody, ApiResult } from './types';
import { id, nowIso, validYmd, ymd } from './utils';

/**
 * แพลนงานตรวจปล่อย (ผู้จัดการ) → งานปล่อย (ชิปปิ้ง)
 *
 * 1) ผู้จัดการเลือกวันที่ตรวจปล่อย → ดึงงานจากตาราง MAESOT FREEZONE + TRANSIT ของวันนั้น (1 แถว = 1 ตู้)
 * 2) อัปไฟล์ข้อมูลคนขับรถ (Excel) → จับคู่ด้วยเลขตู้ (ไม่มีเลขตู้ค่อยใช้ BL) — ทำฝั่งหน้าเว็บ
 * 3) เลือกชิปปิ้งให้อัตโนมัติจาก "ชิปปิ้งประจำท่า" ของเดือนนั้น ไม่เจอค่อยใช้ชื่อชิปปิ้งในชีต แก้เองได้ทุกแถว
 * 4) Confirm Plan → ชิปปิ้งแต่ละคนเห็นเฉพาะแถวของตัวเองในเมนู "งานปล่อย"
 */

const MAX_ITEMS = 400;
const text = (value: unknown, max = 200) => String(value ?? '').trim().slice(0, max);
const periodOf = (date: string) => date.slice(0, 7).replace('-', '');
const validPeriod = (value: unknown) => /^\d{6}$/.test(String(value ?? ''));

/** ymd ที่เติม 0 ให้ครบ — input type=date ส่งมาครบอยู่แล้ว แต่กันคนพิมพ์ 2026-1-5 */
function cleanDate(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!validYmd(raw)) return '';
  const [y, m, d] = raw.split('-');
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** ชิปปิ้งที่ยังทำงานอยู่ — ใช้เป็นตัวเลือกในแพลนและหน้าตั้งค่าชิปปิ้งประจำท่า */
export async function activeShippers() {
  const rows = await db.select({ username: users.username, name: users.name, shippingCode: users.shippingCode })
    .from(users)
    .where(and(eq(users.role, 'employee-shipping'), eq(users.active, true)))
    .orderBy(asc(users.username));
  return rows.map((row) => ({ username: String(row.username), name: row.name, shippingCode: row.shippingCode || '' }));
}

// ---------------- ชิปปิ้งประจำท่า (รายเดือน) ----------------

async function assignmentsOf(period: string) {
  return db.select({ port: portAssignments.port, portKey: portAssignments.portKey, username: portAssignments.username })
    .from(portAssignments).where(eq(portAssignments.period, period)).orderBy(asc(portAssignments.port));
}

export async function portAssignmentData(body: ApiBody): Promise<ApiResult> {
  const period = validPeriod(body.period) ? String(body.period) : periodOf(ymd());
  const options = await readAppOptions();
  const rows = await assignmentsOf(period);
  const shippers = await activeShippers();
  // เดือนล่าสุดที่เคยตั้งไว้ก่อนหน้า — ปุ่ม "คัดลอกจากเดือนก่อน" ใช้
  const [prev] = await db.select({ period: portAssignments.period }).from(portAssignments)
    .where(sql`${portAssignments.period} < ${period}`)
    .orderBy(desc(portAssignments.period)).limit(1);
  const prevRows = prev ? await assignmentsOf(prev.period) : [];
  return {
    ok: true, period, ports: options.ports, shippers,
    rows: rows.map((row) => ({ ...row, username: String(row.username) })),
    prev: prev ? { period: prev.period, rows: prevRows.map((row) => ({ ...row, username: String(row.username) })) } : null
  };
}

export async function savePortAssignments(body: ApiBody, user: { username: string }): Promise<ApiResult> {
  const period = String(body.period || '');
  if (!validPeriod(period)) return { ok: false, error: 'bad_period' };
  const list = Array.isArray(body.rows) ? body.rows.slice(0, 300) : [];
  const shippers = new Set((await activeShippers()).map((row) => row.username.toLowerCase()));
  const seen = new Set<string>();
  const values: (typeof portAssignments.$inferInsert)[] = [];
  const at = nowIso();
  for (const row of list) {
    const port = text(row?.port, 40);
    const key = portKey(port);
    const username = text(row?.username, 60);
    if (!key || !username || seen.has(key)) continue;   // ว่าง = ท่านั้นยังไม่มีคนประจำ
    if (!shippers.has(username.toLowerCase())) return { ok: false, error: 'unknown_shipper', detail: username };
    seen.add(key);
    values.push({ period, portKey: key, port, username, updatedBy: user.username, updatedAt: at });
  }
  await db.transaction(async (tx) => {
    await tx.delete(portAssignments).where(eq(portAssignments.period, period));
    if (values.length) await tx.insert(portAssignments).values(values);
  });
  return { ok: true, period, saved: values.length };
}

// ---------------- แพลนงาน (ผู้จัดการ) ----------------

type Shipper = Awaited<ReturnType<typeof activeShippers>>[number];

/** งานจากตาราง MAESOT FREEZONE + TRANSIT ของวันนั้น — 1 แถวต่อตู้ เรียงตามลำดับที่มาเหมือนหน้าปิดบัญชี */
async function transportRowsFor(date: string, shippers: Shipper[]) {
  const rows = await db.select().from(transportJobs)
    .where(eq(transportJobs.transportDate, date))
    .orderBy(asc(transportJobs.id));
  const rank = (source: string) => {
    const i = TRANSPORT_SOURCE_ORDER.findIndex((name) => String(source).toUpperCase().includes(name));
    return i < 0 ? TRANSPORT_SOURCE_ORDER.length : i;
  };
  const seen = new Set<string>();
  const out = [];
  for (const row of [...rows].sort((a, b) => rank(a.sourceFile) - rank(b.sourceFile) || a.id - b.id)) {
    const container = row.containerNo.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const key = `${row.bl.toUpperCase()}|${container || row.id}`;
    if (seen.has(key)) continue;          // ชีตบางแท็บมีแถวซ้ำ (BL + ตู้เดิม)
    seen.add(key);
    const owner = row.shipping ? shippers.find((s) => personMatches(row.shipping, s)) : undefined;
    out.push({
      bl: row.bl, containerNo: row.containerNo, port: row.port, customer: row.customer,
      source: row.sourceFile || row.sourceName, sheetShipping: row.shipping,
      sheetUser: owner?.username || '', sheetDriver: row.driver
    });
  }
  return out;
}

export async function planLoad(body: ApiBody): Promise<ApiResult> {
  const date = cleanDate(body.date);
  if (!date) return { ok: false, error: 'bad_date' };
  const shippers = await activeShippers();
  const [plan] = await db.select().from(jobPlans).where(eq(jobPlans.inspectDate, date)).limit(1);
  const items = plan
    ? await db.select().from(jobPlanItems).where(eq(jobPlanItems.inspectDate, date)).orderBy(asc(jobPlanItems.seq))
    : [];
  const jobs = await transportRowsFor(date, shippers);
  const assignments = await assignmentsOf(periodOf(date));
  const sms = plan
    ? await db.select().from(smsMessages).where(eq(smsMessages.inspectDate, date)).orderBy(desc(smsMessages.createdAt))
    : [];
  // แพลนช่วงใกล้ ๆ — แถบลัดด้านบนให้กดสลับวันได้เร็ว
  const recent = await db.select({
    date: jobPlans.inspectDate, status: jobPlans.status,
    items: sql<number>`(select count(*)::int from ${jobPlanItems} where ${jobPlanItems.inspectDate} = ${jobPlans.inspectDate})`
  }).from(jobPlans)
    .where(and(gte(jobPlans.inspectDate, shiftDate(date, -10)), lte(jobPlans.inspectDate, shiftDate(date, 20))))
    .orderBy(asc(jobPlans.inspectDate));
  const options = await readAppOptions();
  return {
    ok: true, date, period: periodOf(date),
    plan: plan || null,
    items: items.map((row) => ({ ...row, username: String(row.username) })),
    jobs, shippers, ports: options.ports,
    assignments: assignments.map((row) => ({ ...row, username: String(row.username) })),
    sms: sms.map(smsRowView),
    recent
  };
}

const ASSIGNED_BY = new Set(['port', 'sheet', 'manual', '']);

export async function planSave(body: ApiBody, user: { username: string }): Promise<ApiResult> {
  const date = cleanDate(body.date);
  if (!date) return { ok: false, error: 'bad_date' };
  const confirm = body.mode === 'confirm';
  const list = Array.isArray(body.items) ? body.items : [];
  if (list.length > MAX_ITEMS) return { ok: false, error: 'too_many_items' };
  if (confirm && !list.length) return { ok: false, error: 'plan_empty' };

  const shippers = new Set((await activeShippers()).map((row) => row.username.toLowerCase()));
  const [plan] = await db.select().from(jobPlans).where(eq(jobPlans.inspectDate, date)).limit(1);
  const oldIds = new Set(plan
    ? (await db.select({ id: jobPlanItems.id }).from(jobPlanItems).where(eq(jobPlanItems.inspectDate, date))).map((row) => row.id)
    : []);

  const at = nowIso();
  const values: (typeof jobPlanItems.$inferInsert)[] = [];
  let unassigned = 0;
  for (const [index, raw] of list.entries()) {
    const bl = text(raw?.bl, 60);
    const containerNo = text(raw?.containerNo, 30).toUpperCase();
    if (!bl && !containerNo) continue;     // แถวว่างที่กดเพิ่มไว้แต่ไม่ได้กรอก
    const username = text(raw?.username, 60);
    if (username && !shippers.has(username.toLowerCase())) return { ok: false, error: 'unknown_shipper', detail: username };
    if (!username) unassigned++;
    // id เดิมเก็บไว้ให้ SMS ที่ส่งไปแล้วยังผูกกับแถวเดิม — id ที่ไม่ใช่ของแพลนนี้ออกใหม่
    const keepId = typeof raw?.id === 'string' && oldIds.has(raw.id) ? raw.id : id('jpi_');
    values.push({
      id: keepId, inspectDate: date, seq: index + 1,
      bl, containerNo,
      port: text(raw?.port, 40), destination: text(raw?.destination, 60), customer: text(raw?.customer, 160),
      source: text(raw?.source, 40), sheetShipping: text(raw?.sheetShipping, 60),
      driverName: text(raw?.driverName, 80), plate: text(raw?.plate, 120), phone: text(raw?.phone, 60),
      username, assignedBy: ASSIGNED_BY.has(String(raw?.assignedBy)) ? String(raw?.assignedBy) : 'manual',
      createdAt: at, updatedAt: at
    });
  }
  if (confirm && unassigned) return { ok: false, error: 'plan_unassigned', detail: String(unassigned) };

  const driverFile = text(body.driverFile, 160);
  await db.transaction(async (tx) => {
    if (!plan) {
      await tx.insert(jobPlans).values({
        inspectDate: date, status: confirm ? 'confirmed' : 'draft', driverFile,
        confirmCount: confirm ? 1 : 0,
        createdBy: user.username, createdAt: at, updatedBy: user.username, updatedAt: at,
        confirmedBy: confirm ? user.username : '', confirmedAt: confirm ? at : ''
      });
    } else {
      await tx.update(jobPlans).set({
        status: confirm ? 'confirmed' : 'draft',
        driverFile: driverFile || plan.driverFile,
        confirmCount: confirm ? plan.confirmCount + 1 : plan.confirmCount,
        updatedBy: user.username, updatedAt: at,
        ...(confirm ? { confirmedBy: user.username, confirmedAt: at } : {})
      }).where(eq(jobPlans.inspectDate, date));
    }
    await tx.delete(jobPlanItems).where(eq(jobPlanItems.inspectDate, date));
    if (values.length) await tx.insert(jobPlanItems).values(values);
  });

  const perShipper: Record<string, number> = {};
  for (const row of values) perShipper[row.username || ''] = (perShipper[row.username || ''] || 0) + 1;
  return { ok: true, date, status: confirm ? 'confirmed' : 'draft', items: values.length, perShipper };
}

export async function planDelete(body: ApiBody): Promise<ApiResult> {
  const date = cleanDate(body.date);
  if (!date) return { ok: false, error: 'bad_date' };
  await db.delete(jobPlans).where(eq(jobPlans.inspectDate, date));   // items ลบตาม (cascade)
  return { ok: true };
}

// ---------------- งานปล่อย (ชิปปิ้ง) ----------------

const jobItemsDate = jobPlanItems.inspectDate;

/**
 * งานที่ผู้จัดการ Confirm แล้วของชิปปิ้งคนนี้ — วันที่ให้เลือกย้อนหลัง 7 วันถึงอนาคต
 * ไม่ส่งวันที่มา = เลือกวันที่ใกล้วันนี้ที่สุดที่ยังไม่ผ่านไป (ไม่มีก็วันล่าสุด)
 */
export async function myReleaseJobs(body: ApiBody, user: { username: string }): Promise<ApiResult> {
  const today = ymd();
  const dates = await db.select({
    date: jobItemsDate, containers: sql<number>`count(*)::int`
  }).from(jobPlanItems)
    .innerJoin(jobPlans, eq(jobPlans.inspectDate, jobPlanItems.inspectDate))
    .where(and(
      eq(jobPlanItems.username, user.username), eq(jobPlans.status, 'confirmed'),
      gte(jobPlanItems.inspectDate, shiftDate(today, -7))
    ))
    .groupBy(jobItemsDate).orderBy(asc(jobItemsDate)).limit(60);

  let date = cleanDate(body.date);
  if (!date) date = dates.find((row) => row.date >= today)?.date || dates.at(-1)?.date || today;

  const [plan] = await db.select().from(jobPlans).where(eq(jobPlans.inspectDate, date)).limit(1);
  const visible = plan?.status === 'confirmed';
  const items = visible
    ? await db.select().from(jobPlanItems)
      .where(and(eq(jobPlanItems.inspectDate, date), eq(jobPlanItems.username, user.username)))
      .orderBy(asc(jobPlanItems.seq))
    : [];
  const sms = items.length ? await smsFor(date, user.username) : [];
  const maps = await meetingMapsList(true);
  return {
    ok: true, today, date, dates,
    plan: plan ? { status: plan.status, confirmedAt: plan.confirmedAt, confirmCount: plan.confirmCount } : null,
    items: items.map((row) => ({ ...row, username: String(row.username) })),
    sms, maps, smsConfig: smsConfig()
  };
}

async function smsFor(date: string, username: string | null) {
  const rows = await db.select().from(smsMessages)
    .where(username ? and(eq(smsMessages.inspectDate, date), eq(smsMessages.username, username)) : eq(smsMessages.inspectDate, date))
    .orderBy(desc(smsMessages.createdAt));
  return rows.map(smsRowView);
}

/** ติดตามสถานะ SMS (เปิดอ่าน / ตำแหน่ง) — หน้างานปล่อยเรียกซ้ำทุก ๆ 20 วินาที จึงคืนเฉพาะ SMS */
export async function smsTracking(body: ApiBody, user: { username: string; role: string }): Promise<ApiResult> {
  const date = cleanDate(body.date);
  if (!date) return { ok: false, error: 'bad_date' };
  const own = user.role === 'employee-shipping';
  return { ok: true, date, sms: await smsFor(date, own ? user.username : null) };
}
