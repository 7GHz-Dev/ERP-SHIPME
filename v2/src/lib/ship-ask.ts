import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import { appOptions, jobPlanItems, jobPlans, jobSteps, shippingAsks, users } from '@/db/schema';
import { flexMessage, lineGroupName, lineMode, pushToDriver, replyLine, staffUrl } from './coord-line';
import { staffLineStatus } from './coord-meet';
import { thShortDate } from './sms';
import type { ApiBody, ApiResult } from './types';
import { id, nowIso, validYmd, ymd } from './utils';

/**
 * ผู้จัดการถามชิปปิ้งทาง LINE OA: "งานตรวจปล่อยวันนี้เสร็จครบแล้วหรือยัง"
 *
 * - ส่งการ์ดที่มีปุ่ม ✅ เสร็จครบแล้ว / ⏳ ยังไม่เสร็จ (postback) — ชิปปิ้งกดตอบในแชทได้เลย ไม่ต้องเปิดเว็บ
 * - ตอบ "ยังไม่เสร็จ" แล้ว ข้อความถัดไปที่ชิปปิ้งพิมพ์ในแชท (ภายใน NOTE_WINDOW_MIN) = ที่ยังค้าง
 * - ทุกคำตอบแจ้งผู้จัดการคนที่ถามทาง LINE (ถ้าผูกไว้) และเห็นในแท็บ "ถามชิปปิ้ง" ของหน้าผู้จัดการ
 * - ส่งถึงชิปปิ้งแม้ตั้งปิดแจ้งเตือนไว้ เพราะเป็นคำถามตรงจากผู้จัดการ ไม่ใช่แจ้งเตือนอัตโนมัติ
 * - ระบบแสดงความคืบหน้าในระบบ (ปิดงานกี่ตู้) คู่กับคำตอบเสมอ — คำตอบของชิปปิ้งไม่แก้สถานะตู้
 * - เลือกกลุ่ม LINE ไว้ (แท็บ "ถามชิปปิ้ง") = ทุกคำตอบส่งเข้ากลุ่มนั้นด้วย
 *   ระบบรู้จักกลุ่มเมื่อเชิญ OA เข้ากลุ่ม (join) หรือมีคนพิมพ์ในกลุ่มที่ OA อยู่แล้ว (เก็บไว้ที่ app_options.lineGroups)
 */

type Staff = { username: string; name: string; role: string };

const RESEND_COOLDOWN_MIN = 10;
const NOTE_WINDOW_MIN = 180;
const ANSWER_TH: Record<string, string> = { DONE: '✅ เสร็จครบแล้ว', NOT_DONE: '⏳ ยังไม่เสร็จ' };
const text = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);
const minutesAgo = (min: number) => new Date(Date.now() - min * 60000).toISOString();
const appUrl = (origin: string) => `${origin.replace(/\/+$/, '')}/admin.html?tab=shipask&openExternalBrowser=1`;

/** ตู้ในแพลนของวันนั้น + ปิดงานแล้วกี่ตู้ ต่อชิปปิ้ง 1 คน */
async function progress(date: string) {
  const items = await db.select({ username: jobPlanItems.username, n: sql<number>`count(*)::int` })
    .from(jobPlanItems).where(and(eq(jobPlanItems.inspectDate, date), ne(jobPlanItems.username, '')))
    .groupBy(jobPlanItems.username);
  const done = await db.select({ username: jobSteps.username, n: sql<number>`count(*)::int` })
    .from(jobSteps).where(and(eq(jobSteps.inspectDate, date), ne(jobSteps.completedAt, '')))
    .groupBy(jobSteps.username);
  const map = new Map<string, { containers: number; completed: number }>();
  for (const r of items) map.set(String(r.username).toLowerCase(), { containers: r.n, completed: 0 });
  for (const r of done) {
    const k = String(r.username).toLowerCase();
    map.set(k, { containers: map.get(k)?.containers || 0, completed: r.n });
  }
  return map;
}

export async function shipAskList(body: ApiBody, user: Staff): Promise<ApiResult> {
  const date = validYmd(body.date) ? String(body.date) : ymd();
  const [plan] = await db.select({ status: jobPlans.status }).from(jobPlans).where(eq(jobPlans.inspectDate, date)).limit(1);
  const prog = await progress(date);
  const staffRows = await db.select({ username: users.username, name: users.name, lineUserId: users.lineUserId, lineName: users.lineName })
    .from(users).where(and(eq(users.role, 'employee-shipping'), eq(users.active, true)));
  const asks = await db.select().from(shippingAsks).where(eq(shippingAsks.inspectDate, date)).orderBy(desc(shippingAsks.askedAt)).limit(300);
  const askerNames = new Map<string, string>();
  const askers = [...new Set(asks.map((a) => String(a.askedBy)))];
  if (askers.length) {
    for (const u of await db.select({ username: users.username, name: users.name }).from(users).where(inArray(users.username, askers))) {
      askerNames.set(String(u.username).toLowerCase(), u.name);
    }
  }
  const shippers = staffRows.map((u) => ({
    username: String(u.username), name: u.name || String(u.username),
    linked: Boolean(u.lineUserId), lineName: u.lineName,
    ...(prog.get(String(u.username).toLowerCase()) || { containers: 0, completed: 0 })
  })).sort((a, b) => (b.containers - a.containers) || a.name.localeCompare(b.name, 'th'));
  return {
    ok: true, date, today: ymd(), planStatus: plan?.status || '', lineMode: lineMode(),
    me: await staffLineStatus(user.username), shippers, lineGroup: await groupSettings(),
    asks: asks.map((a) => ({
      id: a.id, username: String(a.username), askedBy: String(a.askedBy),
      askedByName: askerNames.get(String(a.askedBy).toLowerCase()) || String(a.askedBy),
      askedAt: a.askedAt, message: a.message, sendState: a.sendState, sendError: a.sendError,
      answer: a.answer, answerNote: a.answerNote, answeredAt: a.answeredAt
    }))
  };
}

export async function shipAskSend(body: ApiBody, user: Staff): Promise<ApiResult> {
  const date = String(body.date || '');
  if (!validYmd(date)) return { ok: false, error: 'bad_date' };
  const wanted = Array.isArray(body.usernames) ? [...new Set(body.usernames.map((u: unknown) => text(u, 60)).filter(Boolean))] : [];
  if (!wanted.length) return { ok: false, error: 'no_recipients' };
  if (wanted.length > 50) return { ok: false, error: 'too_many_recipients' };
  const message = text(body.message, 300);
  const origin = String(body._origin || '');

  const targets = await db.select({ username: users.username, name: users.name, lineUserId: users.lineUserId })
    .from(users).where(and(inArray(users.username, wanted as string[]), eq(users.role, 'employee-shipping'), eq(users.active, true)));
  const prog = await progress(date);
  const recent = await db.select({ username: shippingAsks.username }).from(shippingAsks).where(and(
    eq(shippingAsks.inspectDate, date), eq(shippingAsks.answer, ''), gte(shippingAsks.askedAt, minutesAgo(RESEND_COOLDOWN_MIN)),
    inArray(shippingAsks.sendState, ['sent', 'demo'])
  ));
  const cooling = new Set(recent.map((r) => String(r.username).toLowerCase()));

  const results: { username: string; name: string; state: string; error?: string }[] = [];
  for (const t of targets) {
    const username = String(t.username), name = t.name || username;
    if (!t.lineUserId) { results.push({ username, name, state: 'not_linked' }); continue; }
    if (cooling.has(username.toLowerCase())) { results.push({ username, name, state: 'cooldown' }); continue; }

    const askId = id('ask_');
    const p = prog.get(username.toLowerCase());
    const lines = [
      `งานตรวจปล่อยวันที่ ${thShortDate(date)}${date === ymd() ? ' (วันนี้)' : ''}`,
      `${user.name} สอบถามว่างานของคุณเสร็จครบทั้งหมดแล้วหรือยัง`,
      ...(p?.containers ? [`ในระบบ: ตู้ของคุณ ${p.containers} ตู้ · ปิดงานแล้ว ${p.completed} ตู้`] : []),
      ...(message ? [`💬 ${message}`] : []),
      'กดปุ่มด้านล่างเพื่อตอบได้เลย'
    ];
    const flex = flexMessage(`ผู้จัดการถาม: งานตรวจปล่อย ${thShortDate(date)} เสร็จครบหรือยัง`, 'งานตรวจปล่อยเสร็จครบแล้วหรือยัง?', lines, [
      { label: '✅ เสร็จครบแล้ว', data: `shipask=${askId}&a=DONE`, displayText: `✅ งานตรวจปล่อยวันที่ ${thShortDate(date)} เสร็จครบแล้ว`, primary: true },
      { label: '⏳ ยังไม่เสร็จ', data: `shipask=${askId}&a=NOT_DONE`, displayText: `⏳ งานตรวจปล่อยวันที่ ${thShortDate(date)} ยังไม่เสร็จ` },
      { label: 'เปิดงานชิปปิ้ง', uri: staffUrl(origin, `date=${date}&tab=status`) }
    ]);
    await db.insert(shippingAsks).values({
      id: askId, inspectDate: date, username, askedBy: user.username, askedAt: nowIso(), message, sendState: 'queued'
    });
    const sent = await pushToDriver({ lineUserId: t.lineUserId, driverId: '', kind: 'SHIP_ASK', ref: askId, messages: [flex] })
      .catch((e) => ({ state: 'failed' as const, error: String((e as Error)?.message || e).slice(0, 200) }));
    const state = sent.state === 'duplicate' ? 'sent' : sent.state;
    await db.update(shippingAsks).set({ sendState: state, sendError: sent.error || '' }).where(eq(shippingAsks.id, askId));
    results.push({ username, name, state, ...(sent.error ? { error: sent.error } : {}) });
  }
  const found = new Set(targets.map((t) => String(t.username).toLowerCase()));
  for (const u of wanted) if (!found.has(String(u).toLowerCase())) results.push({ username: String(u), name: String(u), state: 'unknown_shipper' });
  return { ok: true, results, mode: lineMode() };
}

// ---------------- กลุ่ม LINE ที่รับคำตอบ ----------------

type LineGroup = { id: string; type: string; name: string; active: boolean; joinedAt: string; lastSeen: string };
const GROUPS_KEY = 'lineGroups', TARGET_KEY = 'shipAskGroup';

async function readOption<T>(key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(appOptions).where(eq(appOptions.key, key)).limit(1);
  try { return row ? JSON.parse(row.valueJson) as T : fallback; } catch { return fallback; }
}
async function writeOption(key: string, value: unknown) {
  const valueJson = JSON.stringify(value), updatedAt = nowIso();
  await db.insert(appOptions).values({ key, valueJson, updatedAt }).onConflictDoUpdate({ target: appOptions.key, set: { valueJson, updatedAt } });
}

/** webhook: OA เข้ากลุ่ม / ออกจากกลุ่ม / มีข้อความในกลุ่ม → จำกลุ่มไว้ให้เลือกในหน้าผู้จัดการ */
export async function rememberLineGroup(ev: any) {
  const src = ev?.source || {};
  const gid = String(src.groupId || src.roomId || '');
  if (!gid || (src.type !== 'group' && src.type !== 'room')) return;
  const list = await readOption<LineGroup[]>(GROUPS_KEY, []);
  const at = nowIso();
  let g = list.find((x) => x.id === gid);
  const leaving = ev.type === 'leave';
  // ข้อความทั่วไปในกลุ่มที่รู้จักแล้ว ไม่ต้องเขียนทุกครั้ง
  if (g && g.active && !leaving && ev.type !== 'join' && g.name) return;
  if (!g) { g = { id: gid, type: src.type, name: '', active: true, joinedAt: at, lastSeen: at }; list.push(g); }
  g.active = !leaving; g.lastSeen = at;
  if (!leaving && !g.name) g.name = await lineGroupName(gid);
  await writeOption(GROUPS_KEY, list.slice(-50));
}

export async function shipAskGroupSet(body: ApiBody): Promise<ApiResult> {
  const groupId = text(body.groupId, 80);
  if (groupId) {
    const list = await readOption<LineGroup[]>(GROUPS_KEY, []);
    if (!list.some((g) => g.id === groupId)) return { ok: false, error: 'group_not_found' };
  }
  await writeOption(TARGET_KEY, { groupId });
  return { ok: true, groupId };
}

async function groupSettings() {
  const groups = await readOption<LineGroup[]>(GROUPS_KEY, []);
  const target = await readOption<{ groupId?: string }>(TARGET_KEY, {});
  return { groups: groups.map((g) => ({ id: g.id, type: g.type, name: g.name, active: g.active, joinedAt: g.joinedAt })), groupId: target.groupId || '' };
}

/** ส่งคำตอบเข้ากลุ่มที่เลือกไว้ (ไม่ได้เลือก / OA ออกจากกลุ่มแล้ว = ข้าม) */
async function notifyGroup(title: string, lines: string[], origin: string, ref: string) {
  const { groups, groupId } = await groupSettings();
  const g = groups.find((x) => x.id === groupId);
  if (!g || !g.active) return;
  await pushToDriver({
    lineUserId: g.id, driverId: '', kind: 'SHIP_ASK_GROUP', ref: `${ref}:group`,
    messages: [flexMessage(title, title, lines, [{ label: 'ดูคำตอบทั้งหมด', uri: appUrl(origin), primary: true }])]
  }).catch(() => {});
}

// ---------------- คำตอบจากแชท LINE (เรียกจาก webhook) ----------------

async function notifyAsker(ask: typeof shippingAsks.$inferSelect, shipperName: string, origin: string, ref: string, isNote = false) {
  const [asker] = await db.select({ lineUserId: users.lineUserId }).from(users).where(eq(users.username, ask.askedBy)).limit(1);
  // ภาพรวมรอบที่ถามวันนั้น: คำถามล่าสุดของชิปปิ้งแต่ละคน
  const all = await db.select({ username: shippingAsks.username, answer: shippingAsks.answer, sendState: shippingAsks.sendState, askedAt: shippingAsks.askedAt })
    .from(shippingAsks).where(eq(shippingAsks.inspectDate, ask.inspectDate)).orderBy(desc(shippingAsks.askedAt));
  const latest = new Map<string, string>();
  for (const a of all) {
    if (a.sendState === 'failed') continue;
    const k = String(a.username).toLowerCase();
    if (!latest.has(k)) latest.set(k, a.answer);
  }
  const answers = [...latest.values()];
  const done = answers.filter((a) => a === 'DONE').length, notDone = answers.filter((a) => a === 'NOT_DONE').length;
  const waiting = answers.length - done - notDone;
  const lines = [
    `งานตรวจปล่อยวันที่ ${thShortDate(ask.inspectDate)}`,
    ...(ask.answerNote ? [`ยังค้าง: ${ask.answerNote}`] : []),
    `ภาพรวม: เสร็จ ${done} · ยังไม่เสร็จ ${notDone} · รอตอบ ${waiting} คน`
  ];
  const title = isNote ? `📝 ${shipperName} แจ้งงานที่ยังค้าง` : `${ANSWER_TH[ask.answer] || ask.answer} — ${shipperName}`;
  if (asker?.lineUserId) {
    await pushToDriver({
      lineUserId: asker.lineUserId, driverId: '', kind: 'SHIP_ASK_ANSWER', ref,
      messages: [flexMessage(title, title, lines, [{ label: 'ดูคำตอบทั้งหมด', uri: appUrl(origin), primary: true }])]
    }).catch(() => {});
  }
  await notifyGroup(title, lines, origin, ref);
}

async function shipperByLine(lineUserId: string) {
  const [u] = await db.select({ username: users.username, name: users.name }).from(users)
    .where(and(eq(users.lineUserId, lineUserId), eq(users.active, true))).limit(1);
  return u;
}

/** postback จากปุ่มในการ์ด — คืน true ถ้าเป็นเรื่องของฟีเจอร์นี้ (webhook จะไม่ทำอย่างอื่นต่อ) */
export async function handleShipAskPostback(ev: any, origin: string) {
  const params = new URLSearchParams(String(ev?.postback?.data || ''));
  const askId = params.get('shipask');
  if (!askId) return false;
  const answer = params.get('a') === 'DONE' ? 'DONE' : params.get('a') === 'NOT_DONE' ? 'NOT_DONE' : '';
  const replyToken = String(ev?.replyToken || '');
  const reply = (msg: string) => replyLine(replyToken, [{ type: 'text', text: msg }]);

  const [ask] = await db.select().from(shippingAsks).where(eq(shippingAsks.id, askId)).limit(1);
  const shipper = await shipperByLine(String(ev?.source?.userId || ''));
  // กดได้เฉพาะคนที่ถูกถาม (กันการ์ดที่ถูกส่งต่อ / บัญชี LINE ที่ยกเลิกผูกไปแล้ว)
  if (!ask || !answer || !shipper || String(shipper.username).toLowerCase() !== String(ask.username).toLowerCase()) {
    await reply('คำถามนี้ไม่ใช่ของบัญชี LINE นี้ หรือถูกยกเลิกแล้ว');
    return true;
  }
  if (ask.answer === answer) {
    await reply(`บันทึกคำตอบนี้ไว้แล้ว (${ANSWER_TH[answer]})`);
    return true;
  }
  const at = nowIso();
  const [saved] = await db.update(shippingAsks).set({ answer, answeredAt: at, answerNote: answer === 'DONE' ? '' : ask.answerNote })
    .where(eq(shippingAsks.id, askId)).returning();
  await reply(answer === 'DONE'
    ? `ขอบคุณครับ แจ้งผู้จัดการแล้วว่างานวันที่ ${thShortDate(ask.inspectDate)} เสร็จครบ ✅`
    : `รับทราบครับ แจ้งผู้จัดการแล้ว ⏳\nพิมพ์บอกสั้น ๆ ในแชทนี้ได้ว่ายังค้างอะไร / คาดว่าเสร็จกี่โมง\n(ถ้าเสร็จแล้ว กดปุ่ม "✅ เสร็จครบแล้ว" ในการ์ดเดิมได้เลย)`);
  await notifyAsker(saved, shipper.name || String(shipper.username), origin, `${askId}:${answer}:${at}`);
  return true;
}

/** ข้อความแรกที่ชิปปิ้งพิมพ์หลังตอบ "ยังไม่เสร็จ" = รายละเอียดที่ยังค้าง — ข้อความอื่นไม่ยุ่ง */
export async function handleShipAskText(ev: any, origin: string) {
  const msg = text(ev?.message?.text, 500);
  if (!msg || (ev?.source?.type && ev.source.type !== 'user')) return false;   // ข้อความในกลุ่มไม่ใช่คำตอบ
  const shipper = await shipperByLine(String(ev?.source?.userId || ''));
  if (!shipper) return false;
  const [ask] = await db.select().from(shippingAsks).where(and(
    eq(shippingAsks.username, shipper.username), eq(shippingAsks.answer, 'NOT_DONE'), eq(shippingAsks.answerNote, ''),
    gte(shippingAsks.answeredAt, minutesAgo(NOTE_WINDOW_MIN))
  )).orderBy(desc(shippingAsks.answeredAt)).limit(1);
  if (!ask) return false;
  const [saved] = await db.update(shippingAsks).set({ answerNote: msg }).where(and(eq(shippingAsks.id, ask.id), eq(shippingAsks.answerNote, ''))).returning();
  if (!saved) return false;
  await replyLine(String(ev?.replyToken || ''), [{ type: 'text', text: 'ส่งรายละเอียดให้ผู้จัดการแล้วครับ 📝' }]);
  await notifyAsker(saved, shipper.name || String(shipper.username), origin, `${ask.id}:note`, true);
  return true;
}
