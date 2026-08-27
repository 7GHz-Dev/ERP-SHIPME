import { eq, lt } from 'drizzle-orm';
import { db } from '@/db';
import { sessions, users } from '@/db/schema';
import { env } from './env';
import { nowIso, passwordMatches, publicUser, token as newToken } from './utils';

export type Session = ReturnType<typeof publicUser>;
export type ApiError = { ok: false; error: string };
export type Guarded = { user: NonNullable<Session>; error?: undefined } | { error: ApiError; user?: undefined };

/** ตรวจ token → คืนผู้ใช้ที่ล็อกอินอยู่ (หมดอายุ/ถูกปิดบัญชี = ใช้ไม่ได้) */
export async function currentUser(sessionToken: unknown): Promise<Guarded> {
  if (!sessionToken) return { error: { ok: false, error: 'no_token' } };

  const [row] = await db
    .select({
      expiresAt: sessions.expiresAt,
      username: users.username,
      name: users.name,
      role: users.role,
      shippingCode: users.shippingCode,
      active: users.active
    })
    .from(sessions)
    .innerJoin(users, eq(users.username, sessions.username))
    .where(eq(sessions.token, String(sessionToken)))
    .limit(1);

  if (!row) return { error: { ok: false, error: 'invalid_token' } };
  if (new Date(row.expiresAt) <= new Date()) {
    await db.delete(sessions).where(eq(sessions.token, String(sessionToken)));
    return { error: { ok: false, error: 'session_expired' } };
  }
  if (!row.active) return { error: { ok: false, error: 'account_disabled' } };
  return { user: publicUser(row)! };
}

/** ตรวจ token + จำกัดสิทธิ์ตาม role — ใช้เปิดหัวทุก action ที่ต้องล็อกอิน */
export async function guard(body: Record<string, unknown>, roles: string[] | null = null): Promise<Guarded> {
  const session = await currentUser(body?.token);
  if (session.error) return session;
  if (roles && !roles.includes(session.user.role)) return { error: { ok: false, error: 'forbidden' } };
  return session;
}

export async function login(body: Record<string, unknown>) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return { ok: false, error: 'missing_credentials' };

  // username เป็น citext จึงเทียบแบบไม่สนตัวพิมพ์ให้เองเหมือน COLLATE NOCASE เดิม
  const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!row || !passwordMatches(password, row.passwordHash)) {
    return { ok: false, error: 'invalid_credentials' };
  }
  if (!row.active) return { ok: false, error: 'account_disabled' };

  const token = newToken();
  const now = new Date();
  const expires = new Date(now.getTime() + env.sessionHours * 3600 * 1000);
  await db.insert(sessions).values({
    token,
    username: row.username,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    device: String(body.device || '').slice(0, 200)
  });

  return { ok: true, token, expiresAt: expires.toISOString(), user: publicUser(row) };
}

/** ลบ session ที่หมดอายุทิ้ง — เรียกเป็นครั้งคราว ไม่ต้องมี cron */
export async function pruneSessions() {
  await db.delete(sessions).where(lt(sessions.expiresAt, nowIso()));
}

export { nowIso };
