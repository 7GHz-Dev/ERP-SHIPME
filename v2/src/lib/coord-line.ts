import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { lineOutbox } from '@/db/schema';
import { env } from './env';
import { id, nowIso } from './utils';

/**
 * LINE OA สำหรับประสานงานคนขับ
 *
 * - live: ตั้งค่า LINE ครบ 4 ค่า → ส่ง push message จริงผ่าน Messaging API
 * - demo: ยังไม่มี LINE OA → บันทึกข้อความลง line_outbox สถานะ 'demo' ให้ดูใน "จำลองแชท LINE" ของหน้าชิปปิ้ง
 *         ไม่มีการอ้างว่าส่งสำเร็จ — สถานะ demo คือไม่ได้ส่งจริง
 *
 * ทุกข้อความลง outbox ก่อนส่งเสมอ (มี retryKey ไม่ซ้ำ) กดซ้ำ/เรียกซ้ำจะไม่ส่งซ้ำ
 * LINE ไม่บอกว่าผู้รับอ่านแล้ว สถานะสูงสุดที่รู้ได้คือ "ส่งถึงผู้ให้บริการแล้ว" (sent)
 */

export type LineMode = 'live' | 'demo';

export function lineMode(): LineMode {
  return env.lineAccessToken && env.lineChannelSecret && env.lineLoginChannelId && env.liffId ? 'live' : 'demo';
}

/** ลิงก์เปิดหน้าคนขับ — live เปิดใน LINE (LIFF) / demo หรือ SMS เปิดหน้าเว็บตรง */
export function driverUrl(origin: string, query: string, inLine: boolean) {
  if (inLine && lineMode() === 'live') return `https://liff.line.me/${env.liffId}?${query}`;
  return `${origin.replace(/\/+$/, '')}/driver?${query}`;
}

/** UUID จากข้อความ — X-Line-Retry-Key ต้องเป็นรูปแบบ UUID และต้องเหมือนเดิมเมื่อส่งเรื่องเดิมซ้ำ */
function uuidFrom(text: string) {
  const h = crypto.createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** ตรวจลายเซ็น webhook กับ body ดิบ (ก่อน parse JSON) — HMAC-SHA256 base64 ด้วย channel secret */
export function verifyLineSignature(rawBody: string, signature: string | null) {
  if (!env.lineChannelSecret || !signature) return false;
  const expect = crypto.createHmac('sha256', env.lineChannelSecret).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(expect), b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** ตรวจ ID token จาก LIFF ฝั่งเซิร์ฟเวอร์ — ไม่เชื่อ userId ที่หน้าเว็บส่งมาเอง */
export async function verifyLineIdToken(idToken: string): Promise<{ ok: true; sub: string; name: string; picture: string } | { ok: false; error: string }> {
  if (lineMode() !== 'live') return { ok: false, error: 'line_not_configured' };
  if (!idToken) return { ok: false, error: 'missing_id_token' };
  try {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: env.lineLoginChannelId }),
      signal: AbortSignal.timeout(8000)
    });
    const data = await res.json().catch(() => ({})) as any;
    if (!res.ok || !data?.sub) return { ok: false, error: 'invalid_id_token' };
    return { ok: true, sub: String(data.sub), name: String(data.name || ''), picture: String(data.picture || '') };
  } catch {
    return { ok: false, error: 'line_unreachable' };
  }
}

type PushInput = {
  lineUserId: string; driverId: string; kind: string; ref: string; messages: unknown[];
};

/**
 * ส่งข้อความหาคนขับ 1 คน — ref คือรหัสเรื่องที่ส่ง (เช่น id คำขอพิกัด) ใช้กันส่งซ้ำ
 * คืนสถานะจริง: sent | failed | demo | duplicate
 */
export async function pushToDriver(input: PushInput): Promise<{ state: 'sent' | 'failed' | 'demo' | 'duplicate'; error?: string }> {
  const retryKey = uuidFrom(`${input.kind}:${input.ref}`);
  const [dup] = await db.select({ state: lineOutbox.state }).from(lineOutbox).where(eq(lineOutbox.retryKey, retryKey)).limit(1);
  if (dup && dup.state !== 'failed') return { state: 'duplicate' };

  const mode = lineMode();
  const rowId = id('lo_');
  if (!dup) {
    await db.insert(lineOutbox).values({
      id: rowId, lineUserId: input.lineUserId, driverId: input.driverId, kind: input.kind,
      payloadJson: JSON.stringify(input.messages), retryKey, state: mode === 'demo' ? 'demo' : 'queued', createdAt: nowIso()
    });
  }
  if (mode === 'demo') return { state: 'demo' };

  let error = '';
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.lineAccessToken}`,
        'content-type': 'application/json',
        'x-line-retry-key': retryKey
      },
      body: JSON.stringify({ to: input.lineUserId, messages: input.messages }),
      signal: AbortSignal.timeout(10000)
    });
    // 409 = retry key เดิมเคยส่งสำเร็จแล้ว (LINE กันซ้ำให้) → นับเป็นส่งแล้ว
    if (!res.ok && res.status !== 409) {
      const data = await res.json().catch(() => ({})) as any;
      error = String(data?.message || `HTTP ${res.status}`).slice(0, 200);
    }
  } catch (e) {
    error = (e as Error)?.name === 'TimeoutError' ? 'LINE ไม่ตอบกลับ' : 'เชื่อมต่อ LINE ไม่ได้';
  }
  await db.update(lineOutbox).set(error
    ? { state: 'failed', error, attempts: 1 }
    : { state: 'sent', sentAt: nowIso(), attempts: 1, error: '' })
    .where(eq(lineOutbox.retryKey, retryKey));
  return error ? { state: 'failed', error } : { state: 'sent' };
}

// ---------------- การ์ดข้อความ (Flex Message) ----------------

const NAVY = '#0D2748', AMBER = '#FFB020', GREEN = '#06C755';

function bubble(title: string, lines: string[], buttons: { label: string; uri: string; primary?: boolean }[]) {
  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: NAVY, paddingAll: '16px',
      contents: [
        { type: 'text', text: 'SHIPME', color: AMBER, weight: 'bold', size: 'sm' },
        { type: 'text', text: title, color: '#FFFFFF', weight: 'bold', size: 'lg', wrap: true }
      ]
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: lines.map((line) => ({ type: 'text', text: line, wrap: true, size: 'sm', color: '#333333' }))
    },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: buttons.map((b) => ({
        type: 'button', style: b.primary ? 'primary' : 'secondary', color: b.primary ? GREEN : undefined, height: 'sm',
        action: { type: 'uri', label: b.label.slice(0, 20), uri: b.uri }
      }))
    }
  };
}

export function flexMessage(altText: string, title: string, lines: string[], buttons: { label: string; uri: string; primary?: boolean }[]) {
  return { type: 'flex', altText: altText.slice(0, 400), contents: bubble(title, lines, buttons) };
}

/**
 * ตรวจการเชื่อมต่อ LINE OA (ปุ่มในตั้งค่าระบบ) — ทดสอบของจริงทุกข้อ ไม่ใช่แค่ดูว่าตั้งค่าไว้
 *   token: เรียกข้อมูลบอท / webhook: ให้ LINE ยิงข้อความทดสอบ (ลงลายเซ็นจริง) มาที่ระบบ / โควตาข้อความเดือนนี้
 */
export async function lineDiagnostics(origin: string) {
  const out: Record<string, unknown> = {
    mode: lineMode(),
    configured: {
      accessToken: Boolean(env.lineAccessToken), channelSecret: Boolean(env.lineChannelSecret),
      loginChannelId: Boolean(env.lineLoginChannelId), liffId: Boolean(env.liffId)
    },
    liffIdFormat: /^\d{10}-[A-Za-z0-9]{8}$/.test(env.liffId), loginChannelIdFormat: /^\d{10}$/.test(env.lineLoginChannelId),
    expectedWebhook: `${origin}/api/line/webhook`, liffEndpoint: `${origin}/driver`
  };
  if (!env.lineAccessToken) return out;
  const call = async (path: string, init: RequestInit = {}) => {
    try {
      const res = await fetch(`https://api.line.me${path}`, {
        ...init, headers: { authorization: `Bearer ${env.lineAccessToken}`, 'content-type': 'application/json', ...(init.headers || {}) },
        signal: AbortSignal.timeout(15000)
      });
      return { status: res.status, data: await res.json().catch(() => ({})) as any };
    } catch { return { status: 0, data: { message: 'เชื่อมต่อ LINE ไม่ได้' } }; }
  };
  const bot = await call('/v2/bot/info');
  out.bot = bot.status === 200 ? { ok: true, displayName: bot.data.displayName, basicId: bot.data.basicId, chatMode: bot.data.chatMode }
    : { ok: false, error: bot.data?.message || `HTTP ${bot.status}` };
  if (bot.status !== 200) return out;
  const hook = await call('/v2/bot/channel/webhook/endpoint');
  out.webhook = { endpoint: hook.data?.endpoint || '', active: Boolean(hook.data?.active), matches: hook.data?.endpoint === out.expectedWebhook };
  const test = await call('/v2/bot/channel/webhook/test', { method: 'POST', body: JSON.stringify({ endpoint: out.expectedWebhook }) });
  out.webhookTest = { ok: Boolean(test.data?.success), statusCode: test.data?.statusCode, reason: test.data?.reason || test.data?.message || '', detail: test.data?.detail || '' };
  const quota = await call('/v2/bot/message/quota');
  const used = await call('/v2/bot/message/quota/consumption');
  out.quota = { type: quota.data?.type, limit: quota.data?.value ?? null, used: used.data?.totalUsage ?? null };
  return out;
}
