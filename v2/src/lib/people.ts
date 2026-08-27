import { and, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { leaves, users } from '@/db/schema';
import type { ApiBody, ApiResult } from './types';
import { daysBetween, id, normalizeRole, nowIso, parseActive, passwordHash, validYmd } from './utils';

type LeaveRow = typeof leaves.$inferSelect;

const leaveRecord = (row: LeaveRow) => ({
  id: row.id, created: row.createdAt, username: row.username, name: row.name,
  leaveType: row.leaveType, startDate: row.startDate, endDate: row.endDate, days: row.days,
  reason: row.reason, status: row.status, decidedBy: row.decidedBy, decidedAt: row.decidedAt, note: row.note
});

export async function readLeaves(where?: SQL) {
  const rows = await db.select().from(leaves)
    .where(where)
    .orderBy(desc(leaves.createdAt));
  return rows.map(leaveRecord);
}

/** ใบลาของคนเดียว / ตามสถานะ — ตัวช่วยให้ dispatch เรียกสั้น ๆ */
export const leavesOf = (username: string) => readLeaves(eq(leaves.username, username));
export const leavesByStatus = (status: string) =>
  readLeaves(sql`lower(${leaves.status}) = ${status}`);

export async function requestLeave(body: ApiBody, user: { username: string; name: string }): Promise<ApiResult> {
  const leaveType = String(body.leaveType || '').trim();
  const startDate = String(body.startDate || '').trim();
  const endDate = String(body.endDate || startDate).trim();
  if (!leaveType || !validYmd(startDate)) return { ok: false, error: 'missing_leave_fields' };
  if (!validYmd(endDate) || endDate < startDate) return { ok: false, error: 'invalid_date_range' };

  const leaveId = id('LV');
  const days = daysBetween(startDate, endDate);
  await db.insert(leaves).values({
    id: leaveId,
    createdAt: nowIso(),
    username: user.username,
    name: user.name,
    leaveType,
    startDate,
    endDate,
    days,
    reason: String(body.reason || '').trim()
  });
  return { ok: true, record: { id: leaveId, leaveType, startDate, endDate, days, status: 'pending' } };
}

export async function decideLeave(body: ApiBody, adminName: string): Promise<ApiResult> {
  const decision = String(body.decision || '').toLowerCase();
  if (!['approved', 'rejected'].includes(decision)) return { ok: false, error: 'bad_request' };
  const updated = await db.update(leaves)
    .set({ status: decision, decidedBy: adminName, decidedAt: nowIso(), note: String(body.note || '') })
    .where(eq(leaves.id, String(body.id || '')))
    .returning({ id: leaves.id });
  return updated.length
    ? { ok: true, id: body.id, status: decision }
    : { ok: false, error: 'leave_not_found' };
}

export async function listEmployees(): Promise<ApiResult> {
  const rows = await db.select().from(users).orderBy(users.username);
  return {
    ok: true,
    rows: rows.map((row) => ({
      username: row.username,
      password: '',
      name: row.name,
      role: normalizeRole(row.role),
      active: row.active ? 'yes' : 'no',
      shippingCode: row.shippingCode || ''
    }))
  };
}

export async function saveEmployee(body: ApiBody): Promise<ApiResult> {
  const employee = body.employee || {};
  const username = String(employee.username || '').trim();
  if (!username) return { ok: false, error: 'missing_username' };

  const original = String(employee.origUsername || username).trim();
  const [existing] = await db.select().from(users).where(eq(users.username, original)).limit(1);
  const now = nowIso();
  const role = normalizeRole(employee.role);
  const name = String(employee.name || username).trim();
  const active = parseActive(employee.active);
  const shippingCode = String(employee.shippingCode || '').trim();

  if (existing) {
    // เปลี่ยนชื่อผู้ใช้ไปชนกับคนอื่น (citext จึงเทียบไม่สนตัวพิมพ์ให้เอง)
    const [clash] = await db.select({ username: users.username }).from(users)
      .where(and(eq(users.username, username), ne(users.username, original))).limit(1);
    if (clash) return { ok: false, error: 'username_exists' };

    const passwordHashValue = employee.password ? passwordHash(String(employee.password)) : existing.passwordHash;
    await db.update(users)
      .set({ username, passwordHash: passwordHashValue, name, role, active, shippingCode, updatedAt: now })
      .where(eq(users.username, original));
    return { ok: true, mode: 'updated', username };
  }

  const [taken] = await db.select({ username: users.username }).from(users)
    .where(eq(users.username, username)).limit(1);
  if (taken) return { ok: false, error: 'username_exists' };
  if (!employee.password) return { ok: false, error: 'missing_password' };

  await db.insert(users).values({
    username,
    passwordHash: passwordHash(String(employee.password)),
    name,
    role,
    active,
    shippingCode,
    createdAt: now,
    updatedAt: now
  });
  return { ok: true, mode: 'created', username };
}

