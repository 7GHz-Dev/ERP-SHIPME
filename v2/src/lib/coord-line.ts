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
  // Google Routes (ฝั่งเซิร์ฟเวอร์) — ลองคำนวณระยะ 2 จุดในแหลมฉบังจริง
  if (env.googleRoutesServerKey) {
    try {
      const wp = (lat: number, lng: number) => ({ waypoint: { location: { latLng: { latitude: lat, longitude: lng } } } });
      const res = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.googleRoutesServerKey, 'x-goog-fieldmask': 'originIndex,destinationIndex,duration,distanceMeters,condition' },
        body: JSON.stringify({ origins: [wp(13.0790, 100.8990)], destinations: [wp(13.0950, 100.9300)], travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE' })
      });
      const data = await res.json().catch(() => null) as any;
      const el = Array.isArray(data) ? data[0] : null;
      out.routes = el?.duration ? { ok: true, seconds: parseInt(el.duration, 10), meters: el.distanceMeters }
        : { ok: false, error: String(data?.error?.message || data?.[0]?.error?.message || `HTTP ${res.status}`).slice(0, 200) };
    } catch { out.routes = { ok: false, error: 'เชื่อมต่อ Google Routes ไม่ได้' }; }
  } else out.routes = { ok: false, error: 'ยังไม่ได้ตั้ง GOOGLE_ROUTES_SERVER_KEY (ใช้ประมาณการ)' };
  out.cron = { configured: Boolean(env.cronSecret) };
  const quota = await call('/v2/bot/message/quota');
  const used = await call('/v2/bot/message/quota/consumption');
  out.quota = { type: quota.data?.type, limit: quota.data?.value ?? null, used: used.data?.totalUsage ?? null };
  return out;
}

// ---------------- แจ้งเตือนชิปปิ้งทาง LINE ----------------

/**
 * level: important = เรื่องที่ต้องลงมือ (ผ่าน X-Ray ครบ / มีปัญหา / ขอเลื่อนนัด / จบงานครบ)
 *        all = ทุกความเคลื่อนไหว (ส่งพิกัด / ผ่าน X-Ray ทีละตู้ / ส่งรูป) — ชิปปิ้งเลือกรับเองได้ (เปลืองโควตา)
 * ชิปปิ้งที่ยังไม่ผูก LINE หรือปิดแจ้งเตือน = ไม่ส่ง (ยังเห็นในหน้า /staff ตามปกติ)
 */
export async function notifyStaff(o: {
  username: string; level: 'important' | 'all'; ref: string; title: string; lines: string[]; url: string; button?: string;
}) {
  const { users } = await import('@/db/schema');
  const [u] = await db.select({ lineUserId: users.lineUserId, lineNotify: users.lineNotify }).from(users)
    .where(eq(users.username, o.username)).limit(1);
  if (!u?.lineUserId || u.lineNotify === 'off') return;
  if (o.level === 'all' && u.lineNotify !== 'all') return;
  await pushToDriver({
    lineUserId: u.lineUserId, driverId: '', kind: 'STAFF_NOTIFY', ref: `${o.username}:${o.ref}`,
    messages: [flexMessage(o.title, o.title, o.lines, [{ label: o.button || 'เปิดงานชิปปิ้ง', uri: o.url, primary: true }])]
  }).catch(() => {});
}

/** ลิงก์หน้าชิปปิ้งจากข้อความ LINE — เปิดในเบราว์เซอร์ของเครื่อง (ใช้ล็อกอินเดิมได้) */
export function staffUrl(origin: string, query: string) {
  return `${origin.replace(/\/+$/, '')}/staff?${query}${query ? '&' : ''}openExternalBrowser=1`;
}

// ---------------- Rich Menu ----------------

type MenuButton = { label: string; uri: string };

/**
 * ติดตั้ง Rich Menu 2 ชุด: คนขับ (ตั้งเป็นค่าเริ่มต้นของ OA) และชิปปิ้ง (ผูกรายคนตอนชิปปิ้งผูก LINE)
 * รูปวาดจากหน้าแอดมิน (2500×843 JPEG) ส่งมาเป็น data URL — ลบเมนูชุดเก่าของระบบทิ้งก่อน
 */
export async function installRichMenus(o: { driverImage: string; staffImage: string; driverButtons: MenuButton[]; staffButtons: MenuButton[] }) {
  if (lineMode() !== 'live') return { ok: false, error: 'line_not_configured' };
  const auth = { authorization: `Bearer ${env.lineAccessToken}` };
  const api = async (url: string, init: RequestInit = {}) => {
    const res = await fetch(url, { ...init, headers: { ...auth, ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
    const data = await res.json().catch(() => ({})) as any;
    return { ok: res.ok, status: res.status, data };
  };
  const decode = (dataUrl: string) => {
    const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(dataUrl);
    if (!m) throw new Error('bad_image');
    return { type: `image/${m[1]}`, bytes: Buffer.from(m[2], 'base64') };
  };
  const create = async (name: string, chatBarText: string, buttons: MenuButton[], image: string) => {
    const w = Math.floor(2500 / buttons.length);
    const body = {
      size: { width: 2500, height: 843 }, selected: true, name, chatBarText,
      areas: buttons.map((b, i) => ({
        bounds: { x: i * w, y: 0, width: i === buttons.length - 1 ? 2500 - i * w : w, height: 843 },
        action: { type: 'uri', label: b.label.slice(0, 20), uri: b.uri }
      }))
    };
    const made = await api('https://api.line.me/v2/bot/richmenu', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!made.ok) throw new Error(`create ${name}: ${made.data?.message || made.status}`);
    const id = String(made.data.richMenuId);
    const img = decode(image);
    if (img.bytes.length > 1024 * 1024) throw new Error('image_too_large');
    const up = await api(`https://api-data.line.me/v2/bot/richmenu/${id}/content`, { method: 'POST', headers: { 'content-type': img.type }, body: new Uint8Array(img.bytes) });
    if (!up.ok) throw new Error(`upload ${name}: ${up.data?.message || up.status}`);
    return id;
  };
  try {
    // ลบเมนูเก่าที่ระบบเคยสร้าง (ชื่อขึ้นต้น SHIPME-) — เมนูที่สร้างเองใน OA Manager ไม่แตะ
    const list = await api('https://api.line.me/v2/bot/richmenu/list');
    for (const m of (list.data?.richmenus || []) as any[]) {
      if (String(m.name || '').startsWith('SHIPME-')) await api(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, { method: 'DELETE' });
    }
    const driverMenu = await create('SHIPME-driver', 'เมนู SHIPME', o.driverButtons, o.driverImage);
    const staffMenu = await create('SHIPME-staff', 'งานชิปปิ้ง', o.staffButtons, o.staffImage);
    const def = await api(`https://api.line.me/v2/bot/user/all/richmenu/${driverMenu}`, { method: 'POST' });
    if (!def.ok) throw new Error(`default: ${def.data?.message || def.status}`);
    return { ok: true, driverMenu, staffMenu };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e).slice(0, 200) };
  }
}

/** ผูกเมนูชิปปิ้งให้บัญชี LINE ของชิปปิ้ง (คนขับใช้เมนูเริ่มต้นของ OA) */
export async function linkUserRichMenu(lineUserId: string, richMenuId: string) {
  if (lineMode() !== 'live' || !richMenuId || !lineUserId) return false;
  const res = await fetch(`https://api.line.me/v2/bot/user/${encodeURIComponent(lineUserId)}/richmenu/${richMenuId}`, {
    method: 'POST', headers: { authorization: `Bearer ${env.lineAccessToken}` }, signal: AbortSignal.timeout(10000)
  }).catch(() => null);
  return Boolean(res?.ok);
}
