import { saveInvoicePairs } from './invoice-pairs';
import {
  createScanTicket, deleteInspectionFile, listInspectionFiles, registerInspectionFile,
  scanLogin, scanTicketInfo, scanUploadDone, scanUploadSign, signInspectionUpload
} from './inspection';
import { serviceInvoiceData } from './service-invoices';
import {
  coordCardHanded, coordDashboard, coordDemo, coordDriverInvite, coordEirHanded, coordOutbox, coordRequestLocations,
  coordTimeline, driverAuth, driverComplete, driverEvidenceCommit, driverEvidenceDelete, driverEvidenceSign,
  driverHome, driverReportLocation, driverStep, meetingPointList, meetingPointSave
} from './coord';
import {
  cancelServiceInvoices, getServiceInvoice, issueServiceReceipts, listServiceInvoices, matchServiceReceivables,
  saveServiceInvoices, serviceInvoiceNext, settleServiceReceivables, unsettleServiceReceivables
} from './service-ar';
import {
  myReleaseJobs, planDelete, planLoad, planSave, portAssignmentData, savePortAssignments, smsTracking
} from './plans';
import {
  linkLocation, linkOpened, meetingMapsList, saveMeetingMap, sendDriverSms, signMapUpload, smsConfig
} from './sms';
import { withholdingData } from './withholding';
import { shippingIncomeData } from './shipping-income';
import { shippingReconcileData } from './shipping-reconcile';
import {
  acceptDocs, clearDocFix, createInvoiceBatch, flagDocsForFix, issueReceipts,
  listInvoiceBatches, listPendingDocs, listReceivables, matchReceivables, renameInvoiceBatch,
  resetInvoices, sendBatchToKola, settleReceivables, unbatchInvoices, unsettleReceivables
} from './invoice-batches';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { checkins, geocodeCache, settlements, users } from '@/db/schema';
import { guard, login } from './auth';
import { claimConfig, listClaims, saveClaim, saveClaimRates } from './claims';
import { ACCOUNT_ROLES, AUTO_MIN_CONTAINERS } from './constants';
import { env } from './env';
import {
  appOptionsPayload, readAppOptions, sheetLayoutDefault, writeAppOption
} from './options';
import {
  decideLeave, leavesByStatus, leavesOf, listEmployees, readLeaves, requestLeave, saveEmployee
} from './people';
import { listReceipts, myReceipts, saveReceipt } from './receipts';
import {
  listSettlements, saveCompanyRefund, saveSettleRates, saveSettlement, saveSettlementImage,
  settleConfig, signSettlementImage
} from './settlements';
import { ocrDiagnostics, signSlipUpload, verifySlip } from './slip';
import { saveDataImage } from './storage';
import { lookupTransport, transportDiagnostics } from './transport';
import { pruneTransportSheets, syncTransportSheet, transportSyncStatus } from './transport-sync';
import {
  checkInvoiceNumber, decideInvoice, getInvoice, invoiceConfig, invoicePreview, invoiceSources, listInvoices, updateInvoice,
  saveInvoice, saveInvoiceBatch
} from './invoices';
import type { ApiBody, ApiResult, Handler } from './types';
import { lineDiagnostics, lineMode } from './coord-line';
import { checkinPolicy, id, isWindowsDevice, nowIso, publicUser, validYmd, ymd } from './utils';

export type { ApiBody, ApiResult };

/** แพลนงาน / ชิปปิ้งประจำท่า / รูปแผนที่นัดหมาย */
const PLAN_ROLES = ['admin', 'manager'];
/** ประสานงานคนขับ — ชิปปิ้งเห็นเฉพาะชุดของตัวเอง ผู้จัดการ/admin ดูของทุกคน */
const COORD_STAFF = ['employee-shipping', 'admin', 'manager'];

/**
 * หน้าเว็บทั้งระบบยิงมาที่ POST /api ปลายทางเดียว แล้วแยกด้วยฟิลด์ "action"
 * (โครงเดิมจากตอนเป็น Apps Script) — พอร์ตมาเป็น registry ตรง ๆ
 * ชื่อ action ต้องตรงกับของเดิมทุกตัว ไม่งั้น index.html / admin.html เรียกไม่เจอ
 */

async function reverseGeocode(latitude: number, longitude: number) {
  const point = `${Number(latitude).toFixed(4)},${Number(longitude).toFixed(4)}`;
  const [cached] = await db.select({ address: geocodeCache.address })
    .from(geocodeCache).where(eq(geocodeCache.point, point)).limit(1);
  if (cached) return cached.address;

  let address = `${Number(latitude).toFixed(6)}, ${Number(longitude).toFixed(6)}`;
  if (env.geocodeEndpoint) {
    try {
      const endpoint = new URL(env.geocodeEndpoint);
      endpoint.searchParams.set('lat', String(latitude));
      endpoint.searchParams.set('lon', String(longitude));
      const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(3500),
        headers: { accept: 'application/json' }
      });
      if (response.ok) {
        const payload = await response.json();
        address = String(payload.address || payload.display_name || address).slice(0, 500);
      }
    } catch { /* พิกัดดิบเป็น fallback ที่เชื่อถือได้และเร็ว */ }
  }

  await db.insert(geocodeCache).values({ point, address, updatedAt: nowIso() })
    .onConflictDoUpdate({ target: geocodeCache.point, set: { address, updatedAt: nowIso() } });
  return address;
}

type CheckinRow = typeof checkins.$inferSelect;
const checkinRecord = (row: CheckinRow | undefined | null) => row ? {
  id: row.id, time: row.serverTime, deviceTime: row.deviceTime,
  username: row.username, name: row.name, type: row.type,
  lat: row.latitude, lng: row.longitude, accuracy: row.accuracyM,
  address: row.address, mapLink: row.mapLink, photoUrl: row.photoUrl
} : null;

async function checkin(body: ApiBody): Promise<ApiResult> {
  const session = await guard(body);
  if (session.error) return session.error;
  const user = session.user;

  const policy = checkinPolicy(user.role);
  if (!policy.canCheckin) return { ok: false, error: 'checkin_not_allowed' };

  const windows = isWindowsDevice(body.userAgent);
  if (policy.device === 'windows' && !windows) return { ok: false, error: 'need_desktop' };
  if (policy.device === 'mobile' && windows) return { ok: false, error: 'need_mobile' };

  const latitude = Number(body.lat);
  const longitude = Number(body.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { ok: false, error: 'missing_location' };

  const accuracy = Number(body.accuracy) || 0;
  const limit = windows ? env.maxAccuracyDesktop : env.maxAccuracy;
  if (limit > 0 && accuracy > limit) return { ok: false, error: 'low_accuracy', accuracy, limit };

  const localDate = ymd();
  const [existing] = await db.select().from(checkins)
    .where(and(eq(checkins.username, user.username), eq(checkins.localDate, localDate))).limit(1);
  if (existing) return { ok: false, error: 'already_checked_in', record: checkinRecord(existing) };

  let photoUrl = '';
  let photoId = '';
  if (policy.photo) {
    if (!body.photo) return { ok: false, error: 'photo_required' };
    const saved = await saveDataImage(body.photo, 'checkins', `${user.username}_${localDate}`);
    photoUrl = saved.url;
    photoId = saved.id;
  }

  const address = await reverseGeocode(latitude, longitude);
  const row = {
    id: id('chk_'),
    serverTime: nowIso(),
    localDate,
    deviceTime: String(body.deviceTime || ''),
    username: user.username,
    name: user.name,
    type: String(body.type || 'in'),
    latitude,
    longitude,
    accuracyM: accuracy,
    address,
    mapLink: `https://www.google.com/maps?q=${latitude},${longitude}`,
    photoUrl,
    photoId
  };

  try {
    await db.insert(checkins).values(row);
  } catch (error) {
    // ชน unique (username, local_date) = กดพร้อมกันสองเครื่อง ให้ถือว่าเช็กอินไปแล้ว
    if (String((error as Error).message).includes('checkins_user_date_idx')) {
      const [again] = await db.select().from(checkins)
        .where(and(eq(checkins.username, user.username), eq(checkins.localDate, localDate))).limit(1);
      return { ok: false, error: 'already_checked_in', record: checkinRecord(again) };
    }
    throw error;
  }
  return { ok: true, record: checkinRecord(row as CheckinRow) };
}

const handlers: Record<string, Handler> = {
  // ---- เช็กอิน ----
  login,
  me: async (body) => {
    const session = await guard(body);
    return session.error || { ok: true, user: session.user };
  },
  todayStatus: async (body) => {
    const session = await guard(body);
    if (session.error) return session.error;
    const [row] = await db.select().from(checkins)
      .where(and(eq(checkins.username, session.user.username), eq(checkins.localDate, ymd()))).limit(1);
    return { ok: true, checkedIn: Boolean(row), record: checkinRecord(row) };
  },
  checkin,
  myCheckins: async (body) => {
    const session = await guard(body);
    if (session.error) return session.error;
    const rows = await db.select().from(checkins)
      .where(eq(checkins.username, session.user.username))
      .orderBy(desc(checkins.serverTime)).limit(100);
    return { ok: true, rows: rows.map(checkinRecord) };
  },
  report: async (body) => {
    const session = await guard(body, ['admin', 'manager']);
    if (session.error) return session.error;
    const rows = await db.select().from(checkins).orderBy(desc(checkins.serverTime)).limit(5000);
    return { ok: true, rows: rows.map(checkinRecord) };
  },

  // ---- ลา ----
  requestLeave: async (body) => {
    const session = await guard(body);
    return session.error || requestLeave(body, session.user);
  },
  myLeaves: async (body) => {
    const session = await guard(body);
    if (session.error) return session.error;
    return { ok: true, rows: await leavesOf(session.user.username) };
  },
  listLeaves: async (body) => {
    const session = await guard(body, ['admin']);
    if (session.error) return session.error;
    const status = String(body.status || '').trim().toLowerCase();
    return { ok: true, rows: status ? await leavesByStatus(status) : await readLeaves() };
  },
  decideLeave: async (body) => {
    const session = await guard(body, ['admin']);
    return session.error || decideLeave(body, session.user.name);
  },

  // ---- พนักงาน ----
  listEmployees: async (body) => {
    const session = await guard(body, ['admin']);
    return session.error || listEmployees();
  },
  saveEmployee: async (body) => {
    const session = await guard(body, ['admin']);
    return session.error || saveEmployee(body);
  },

  // ---- ตัวเลือกระบบ ----
  appOptions: async (body) => {
    const session = await guard(body);
    if (session.error) return session.error;
    return {
      ok: true,
      ...(await appOptionsPayload()),
      canEdit: ['admin', 'manager'].includes(session.user.role),
      canEditSheet: session.user.role === 'admin'
    };
  },
  saveAppOptions: async (body) => {
    const session = await guard(body, ['admin', 'manager']);
    if (session.error) return session.error;
    const current = await readAppOptions();
    for (const key of ['ports', 'emPorts', 'seal', 'knock', 'overtime'] as const) {
      if (body.options?.[key] !== undefined) {
        await writeAppOption(key, body.options[key] ?? current[key]);
      }
    }
    return { ok: true, ...(await appOptionsPayload()) };
  },
  saveSheetLayout: async (body) => {
    const session = await guard(body, ['admin']);
    if (session.error) return session.error;
    await writeAppOption('sheet', body.reset === true ? sheetLayoutDefault() : body.layout);
    return { ok: true, ...(await appOptionsPayload()), canEditSheet: true };
  },

  // ---- ใบเสร็จ ----
  saveReceipt: async (body) => {
    const session = await guard(body);
    return session.error || saveReceipt(body, session.user, reverseGeocode);
  },
  myReceipts: async (body) => {
    const session = await guard(body);
    return session.error || myReceipts(session.user.username);
  },
  listReceipts: async (body) => {
    const session = await guard(body, ['admin', 'manager']);
    return session.error || listReceipts();
  },

  // ---- การเบิก ----
  claimConfig: async (body) => {
    const session = await guard(body);
    return session.error || claimConfig(session.user);
  },
  saveClaimConfig: async (body) => {
    const session = await guard(body, ['admin', 'manager']);
    if (session.error) return session.error;
    if (!Array.isArray(body.items) || !body.items.length) return { ok: false, error: 'bad_request' };
    return { ok: true, items: await saveClaimRates(body.items) };
  },
  saveClaim: async (body) => {
    const session = await guard(body);
    return session.error || saveClaim(body.claim, session.user);
  },
  myClaims: async (body) => {
    const session = await guard(body);
    if (session.error) return session.error;
    // ใบที่ปิดบัญชีไปแล้วไม่ต้องโชว์ให้แก้ แต่ยังส่งวันที่กลับไปให้หน้าเว็บเตือนได้
    const settledRows = await db.select({ inspectDate: settlements.inspectDate }).from(settlements)
      .where(eq(settlements.username, session.user.username));
    const settled = new Set(settledRows.map((row) => row.inspectDate));
    const rows = await listClaims(session.user.username, 100);
    return {
      ok: true,
      rows: rows.filter((row) => !settled.has(row.inspectDate)),
      settledDates: [...settled]
    };
  },
  listClaims: async (body) => {
    const session = await guard(body, ['admin', 'manager']);
    if (session.error) return session.error;
    return { ok: true, rows: await listClaims(null, 500) };
  },

  // ---- งานขนส่ง ----
  blLookup: async (body) => {
    const session = await guard(body);
    if (session.error) return session.error;
    const date = String(body.date || '').trim();
    if (!validYmd(date)) return { ok: false, error: 'missing_inspect_date' };
    let user = session.user;
    // admin/manager ดูของพนักงานคนอื่นได้
    if (body.username && ['admin', 'manager'].includes(user.role)) {
      const [row] = await db.select().from(users).where(eq(users.username, String(body.username))).limit(1);
      if (row) user = publicUser(row)!;
    }
    return { ...(await lookupTransport(date, user)), date, shipping: user.name };
  },
  transportDiag: async (body) => {
    const session = await guard(body, ['admin', 'manager']);
    return session.error || transportDiagnostics();
  },

  // ---- ปิดบัญชี ----
  settleConfig: async (body) => {
    const session = await guard(body);
    return session.error || settleConfig(session.user);
  },
  saveSettleRates: async (body) => {
    const session = await guard(body, ['admin', 'manager']);
    if (session.error) return session.error;
    return { ok: true, autoRates: await saveSettleRates(body.rates), autoMin: AUTO_MIN_CONTAINERS };
  },
  saveSettlement: async (body) => {
    const session = await guard(body);
    return session.error || saveSettlement(body.settlement, session.user);
  },
  saveSettleImage: async (body) => {
    const session = await guard(body);
    if (session.error) return session.error;
    if (!body.id || !(body.image || body.key)) return { ok: false, error: 'bad_request' };
    return saveSettlementImage(String(body.id), body.image, session.user, body.key);
  },
  mySettlements: async (body) => {
    const session = await guard(body);
    if (session.error) return session.error;
    return { ok: true, rows: await listSettlements(session.user.username, 100) };
  },
  // ฝ่ายบัญชีเห็นใบปิดบัญชีทั้งหมดด้วย (ต้องแนบสลิปบริษัทโอนคืนชิปปิ้ง)
  listSettlements: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    if (session.error) return session.error;
    return { ok: true, rows: await listSettlements(null, 500) };
  },
  saveCompanyRefund: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || saveCompanyRefund(body, session.user);
  },

  /**
   * ขอ URL ให้เบราว์เซอร์อัปรูปตรงไป Supabase — ใช้กับรูปที่เกินลิมิต body 4.5 MB ของ Vercel
   * (รูปใบปิดบัญชี PNG ~4,000px และสลิปความละเอียดสูง)
   * path คิดจากฝั่งเซิร์ฟเวอร์ทั้งหมด เบราว์เซอร์ส่งมาได้แค่ว่าจะอัปของอะไร
   */
  signUpload: async (body) => {
    const session = await guard(body);
    if (session.error) return session.error;
    const purpose = String(body.purpose || '');
    if (purpose === 'settlement') return signSettlementImage(body.id, session.user);
    if (purpose === 'slip') return signSlipUpload(String(body.expectDate || ''), session.user);
    return { ok: false, error: 'bad_request' };
  },

  // ---- หลักฐานการตรวจปล่อย (DocScan) ----
  createScanTicket: async (body) => {
    const session = await guard(body);
    return session.error || createScanTicket(body, session.user);
  },
  // DocScan (คนละโดเมน) — ตรวจรหัสแล้วคืนใบเบิก + ticket ต่อใบ โดยไม่สร้าง session
  scanLogin: (body) => scanLogin(body),
  // 3 ตัวนี้ DocScan เรียกด้วย ticket แทนการล็อกอิน (อยู่คนละโดเมน)
  scanTicketInfo: (body) => scanTicketInfo(body),
  scanUploadSign: (body) => scanUploadSign(body),
  scanUploadDone: (body) => scanUploadDone(body),
  signInspectionUpload: async (body) => {
    const session = await guard(body);
    return session.error || signInspectionUpload(body, session.user);
  },
  registerInspectionFile: async (body) => {
    const session = await guard(body);
    return session.error || registerInspectionFile(body, session.user);
  },
  listInspectionFiles: async (body) => {
    const session = await guard(body);
    return session.error || listInspectionFiles(body, session.user);
  },
  deleteInspectionFile: async (body) => {
    const session = await guard(body);
    return session.error || deleteInspectionFile(body, session.user);
  },

  // ---- สลิป ----
  verifySlip: async (body) => {
    const session = await guard(body);
    return session.error || verifySlip(body, session.user);
  },
  slipOcrDiag: async (body) => {
    const session = await guard(body, ['admin', 'manager']);
    return session.error || ocrDiagnostics();
  },

  // ---- ชีตงานขนส่งยิงข้อมูลเข้ามาเอง ----
  // ไม่ใช้ token ของผู้ใช้ เพราะคนยิงคือ Apps Script ในชีต ไม่ใช่คนที่ล็อกอินอยู่
  syncTransport: syncTransportSheet,
  pruneTransport: pruneTransportSheets,
  transportSyncStatus: async (body) => {
    const session = await guard(body, ['admin', 'manager']);
    return session.error || transportSyncStatus();
  },

  // ---- แพลนงานตรวจปล่อย (ผู้จัดการ) ----
  portAssignmentData: async (body) => {
    const session = await guard(body, PLAN_ROLES);
    return session.error || portAssignmentData(body);
  },
  savePortAssignments: async (body) => {
    const session = await guard(body, PLAN_ROLES);
    return session.error || savePortAssignments(body, session.user);
  },
  planLoad: async (body) => {
    const session = await guard(body, PLAN_ROLES);
    return session.error || planLoad(body);
  },
  planSave: async (body) => {
    const session = await guard(body, PLAN_ROLES);
    return session.error || planSave(body, session.user);
  },
  planDelete: async (body) => {
    const session = await guard(body, PLAN_ROLES);
    return session.error || planDelete(body);
  },
  meetingMaps: async (body) => {
    const session = await guard(body, PLAN_ROLES);
    return session.error || { ok: true, maps: await meetingMapsList(false), ports: (await readAppOptions()).ports, smsConfig: smsConfig() };
  },
  signMapUpload: async (body) => {
    const session = await guard(body, PLAN_ROLES);
    return session.error || signMapUpload();
  },
  saveMeetingMap: async (body) => {
    const session = await guard(body, PLAN_ROLES);
    return session.error || saveMeetingMap(body, session.user);
  },

  // ---- งานปล่อย + SMS คนขับรถ (ชิปปิ้ง — ผู้จัดการส่งแทนได้) ----
  myReleaseJobs: async (body) => {
    const session = await guard(body, ['employee-shipping']);
    return session.error || myReleaseJobs(body, session.user);
  },
  smsTracking: async (body) => {
    const session = await guard(body, ['employee-shipping', ...PLAN_ROLES]);
    return session.error || smsTracking(body, session.user);
  },
  sendDriverSms: async (body) => {
    const session = await guard(body, ['employee-shipping', ...PLAN_ROLES]);
    return session.error || sendDriverSms(body, session.user);
  },
  // หน้าลิงก์ใน SMS — คนขับรถไม่มีบัญชี จึงไม่มี token ใช้รหัสลิงก์แทน
  linkOpened,
  linkLocation,

  // ---- ใบแจ้งหนี้ (ฝ่ายบัญชี) ----
  // employee-account ออกใบได้ แต่อนุมัติเองไม่ได้ — manager-account เป็นคนอนุมัติ
  invoiceConfig: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || invoiceConfig();
  },
  invoiceSources: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || invoiceSources(body);
  },
  invoicePreview: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || invoicePreview(body);
  },
  saveInvoice: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || saveInvoice(body, session.user);
  },
  checkInvoiceNumber: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || checkInvoiceNumber(body);
  },
  saveInvoiceBatch: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || (body.kind === 'BOTH' ? saveInvoicePairs(body, session.user) : saveInvoiceBatch(body, session.user));
  },
  // ใบแจ้งหนี้ค่าบริการ (IN) — ดึงจากชีตงานขนส่งตามช่วงวันที่ อ่านอย่างเดียว ไม่บันทึกใบ
  // ใบหัก ณ ที่จ่าย (กระทำการแทน) — นับจากชีตงานขนส่งตามช่วงวันที่ อ่านอย่างเดียว
  // รายงานรายได้ชิปปิ้ง — แยกตามชื่อชิปปิ้งในชีตงานขนส่ง อ่านอย่างเดียว
  // กระทบยอดชิปปิ้ง — ชีตงานขนส่งเทียบใบเบิก/ใบปิดบัญชี อ่านอย่างเดียว
  shippingReconcileData: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || shippingReconcileData(body);
  },
  shippingIncomeData: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || shippingIncomeData(body);
  },
  withholdingData: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || withholdingData(body);
  },
  serviceInvoiceData: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || serviceInvoiceData(body);
  },
  // ---- ประสานงานคนขับ: หน้าชิปปิ้ง (/staff) ----
  coordDashboard: async (body) => {
    const session = await guard(body, COORD_STAFF);
    return session.error || coordDashboard(body, session.user);
  },
  coordRequestLocations: async (body) => {
    const session = await guard(body, COORD_STAFF);
    return session.error || coordRequestLocations(body, session.user);
  },
  coordCardHanded: async (body) => {
    const session = await guard(body, COORD_STAFF);
    return session.error || coordCardHanded(body, session.user);
  },
  coordEirHanded: async (body) => {
    const session = await guard(body, COORD_STAFF);
    return session.error || coordEirHanded(body, session.user);
  },
  coordDriverInvite: async (body) => {
    const session = await guard(body, COORD_STAFF);
    return session.error || coordDriverInvite(body, session.user);
  },
  coordDemo: async (body) => {
    const session = await guard(body, COORD_STAFF);
    return session.error || coordDemo(body, session.user);
  },
  coordOutbox: async (body) => {
    const session = await guard(body, COORD_STAFF);
    return session.error || coordOutbox(body, session.user);
  },
  coordTimeline: async (body) => {
    const session = await guard(body, COORD_STAFF);
    return session.error || coordTimeline(body, session.user);
  },
  meetingPointList: async (body) => {
    const session = await guard(body, COORD_STAFF);
    return session.error || meetingPointList();
  },
  meetingPointSave: async (body) => {
    const session = await guard(body, PLAN_ROLES);
    return session.error || meetingPointSave(body, session.user);
  },
  // ---- หน้าคนขับ (/driver) — ไม่มีบัญชี ERP ใช้ session ที่ได้จาก LINE (LIFF) หรือลิงก์ ----
  lineDiagnostics: async (body) => {
    const session = await guard(body, PLAN_ROLES);
    return session.error || { ok: true, ...(await lineDiagnostics(String(body._origin || ''))) };
  },
  driverConfig: async () => ({ ok: true, lineMode: lineMode(), liffId: lineMode() === 'live' ? env.liffId : '' }),
  driverAuth,
  driverHome,
  driverReportLocation,
  driverStep,
  driverEvidenceSign,
  driverEvidenceCommit,
  driverEvidenceDelete,
  driverComplete,

  // ---- ใบแจ้งหนี้ค่าบริการ (IN) + ลูกหนี้คงค้างค่าบริการ + ใบเสร็จ RE ----
  serviceInvoiceNext: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || serviceInvoiceNext(body);
  },
  saveServiceInvoices: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || saveServiceInvoices(body, session.user);
  },
  listServiceInvoices: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || listServiceInvoices(body);
  },
  getServiceInvoice: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || getServiceInvoice(body);
  },
  cancelServiceInvoices: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || cancelServiceInvoices(body);
  },
  matchServiceReceivables: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || matchServiceReceivables(body);
  },
  settleServiceReceivables: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || settleServiceReceivables(body);
  },
  unsettleServiceReceivables: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || unsettleServiceReceivables(body);
  },
  issueServiceReceipts: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || issueServiceReceipts(body);
  },
  listInvoices: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || listInvoices(body, session.user);
  },
  getInvoice: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || getInvoice(body);
  },
  updateInvoice: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || updateInvoice(body, session.user);
  },
  createInvoiceBatch: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || createInvoiceBatch(body);
  },
  listInvoiceBatches: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || listInvoiceBatches();
  },
  unbatchInvoices: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || unbatchInvoices(body);
  },
  renameInvoiceBatch: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || renameInvoiceBatch(body);
  },
  sendBatchToKola: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || sendBatchToKola(body);
  },
  listPendingDocs: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || listPendingDocs();
  },
  acceptDocs: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || acceptDocs(body, session.user);
  },
  flagDocsForFix: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || flagDocsForFix(body, session.user);
  },
  clearDocFix: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || clearDocFix(body, session.user);
  },
  listReceivables: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || listReceivables(body);
  },
  matchReceivables: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || matchReceivables(body);
  },
  settleReceivables: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || settleReceivables(body, session.user);
  },
  unsettleReceivables: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || unsettleReceivables(body, session.user);
  },
  // ถอยใบกลับไปหน้าออกใบใหม่ = ลบใบทิ้งทั้งชุด จำกัดไว้ที่ admin เท่านั้น
  resetInvoices: async (body) => {
    const session = await guard(body, ['admin']);
    return session.error || resetInvoices(body, session.user);
  },
  issueReceipts: async (body) => {
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || issueReceipts(body);
  },
  decideInvoice: async (body) => {
    // ฝ่ายบัญชีทุกคนยกเลิกใบได้ (เดิมเฉพาะ admin / manager-account)
    const session = await guard(body, ACCOUNT_ROLES);
    return session.error || decideInvoice(body, session.user);
  }
};

export async function dispatch(body: ApiBody = {}): Promise<ApiResult> {
  const action = String(body.action || '');
  const handler = handlers[action];
  if (!handler) return { ok: false, error: 'unknown_action' };
  return handler(body);
}
