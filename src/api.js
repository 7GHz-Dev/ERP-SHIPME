import { config } from './config.js';
import { db, passwordHash, passwordMatches, transaction } from './db.js';
import { appOptionsPayload, readAppOptions, sheetLayoutDefault, writeAppOption } from './options.js';
import { lookupTransport, transportDiagnostics } from './transport.js';
import { ocrDiagnostics, verifySlip } from './slip.js';
import { saveDataImage, replaceDataImage } from './storage.js';
import {
  checkinPolicy, daysBetween, id, isWindowsDevice, normalizeRole, nowIso, parseActive,
  publicUser, safeJson, token, validYmd, ymd
} from './utils.js';
import {
  claimConfig, listClaims, readClaimItems, saveClaim, saveClaimRates
} from './claims.js';
import {
  listSettlements, saveSettlement, saveSettlementImage, saveSettleRates, settleConfig
} from './settlements.js';

function currentUser(sessionToken) {
  if (!sessionToken) return { ok: false, error: 'no_token' };
  const row = db.prepare(`SELECT s.expires_at, u.* FROM sessions s
    JOIN users u ON u.username = s.username WHERE s.token = ?`).get(String(sessionToken));
  if (!row) return { ok: false, error: 'invalid_token' };
  if (new Date(row.expires_at) <= new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(String(sessionToken));
    return { ok: false, error: 'session_expired' };
  }
  if (!row.active) return { ok: false, error: 'account_disabled' };
  return { ok: true, user: publicUser(row) };
}

function guard(body, roles = null) {
  const session = currentUser(body?.token);
  if (!session.ok) return { error: session };
  if (roles && !roles.includes(session.user.role)) return { error: { ok: false, error: 'forbidden' } };
  return session;
}

async function reverseGeocode(latitude, longitude) {
  const point = `${Number(latitude).toFixed(4)},${Number(longitude).toFixed(4)}`;
  const cached = db.prepare('SELECT address FROM geocode_cache WHERE point = ?').get(point);
  if (cached) return cached.address;
  let address = `${Number(latitude).toFixed(6)}, ${Number(longitude).toFixed(6)}`;
  if (config.geocodeEndpoint) {
    try {
      const endpoint = new URL(config.geocodeEndpoint);
      endpoint.searchParams.set('lat', latitude);
      endpoint.searchParams.set('lon', longitude);
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(3500), headers: { accept: 'application/json' } });
      if (response.ok) {
        const payload = await response.json();
        address = String(payload.address || payload.display_name || address).slice(0, 500);
      }
    } catch { /* พิกัดดิบเป็น fallback ที่เชื่อถือได้และเร็ว */ }
  }
  db.prepare(`INSERT INTO geocode_cache (point,address,updated_at) VALUES (?,?,?)
    ON CONFLICT(point) DO UPDATE SET address=excluded.address, updated_at=excluded.updated_at`)
    .run(point, address, nowIso());
  return address;
}

function checkinRecord(row) {
  if (!row) return null;
  return {
    id: row.id, time: row.server_time, deviceTime: row.device_time,
    username: row.username, name: row.name, type: row.type,
    lat: row.latitude, lng: row.longitude, accuracy: row.accuracy_m,
    address: row.address, mapLink: row.map_link, photoUrl: row.photo_url
  };
}

async function login(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return { ok: false, error: 'missing_credentials' };
  const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!row || !passwordMatches(password, row.password_hash)) return { ok: false, error: 'invalid_credentials' };
  if (!row.active) return { ok: false, error: 'account_disabled' };
  const sessionToken = token();
  const created = new Date();
  const expires = new Date(created.getTime() + config.sessionHours * 3600000);
  transaction(() => {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(created.toISOString());
    db.prepare('INSERT INTO sessions (token,username,created_at,expires_at,device) VALUES (?,?,?,?,?)')
      .run(sessionToken, row.username, created.toISOString(), expires.toISOString(), String(body.device || '').slice(0, 500));
  });
  return { ok: true, token: sessionToken, user: publicUser(row) };
}

async function checkin(body) {
  const session = guard(body); if (session.error) return session.error;
  const user = session.user;
  const policy = checkinPolicy(user.role);
  if (!policy.canCheckin) return { ok: false, error: 'checkin_not_allowed' };
  const windows = isWindowsDevice(body.userAgent);
  if (policy.device === 'windows' && !windows) return { ok: false, error: 'windows_required' };
  if (policy.device === 'mobile' && windows) return { ok: false, error: 'mobile_required' };
  const latitude = Number.parseFloat(body.lat);
  const longitude = Number.parseFloat(body.lng);
  const accuracy = Number.parseFloat(body.accuracy || 0) || 0;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { ok: false, error: 'no_location' };
  if (policy.photo && !body.photo) return { ok: false, error: 'no_photo' };
  const maxAccuracy = policy.device === 'windows' ? config.maxAccuracyDesktop : config.maxAccuracy;
  if (maxAccuracy > 0 && accuracy > maxAccuracy) return { ok: false, error: 'location_inaccurate', accuracy };
  const date = ymd();
  const duplicate = db.prepare('SELECT * FROM checkins WHERE username = ? COLLATE NOCASE AND local_date = ?').get(user.username, date);
  if (duplicate) return { ok: false, error: 'already_checked_in', record: checkinRecord(duplicate) };
  const created = nowIso();
  const address = await reverseGeocode(latitude, longitude);
  const photo = policy.photo ? saveDataImage(body.photo, 'checkins', `${date}_${user.username}_${id('CK')}`) : { id: '', url: '' };
  const recordId = id('CK');
  const mapLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
  try {
    db.prepare(`INSERT INTO checkins (id,server_time,local_date,device_time,username,name,type,latitude,longitude,
      accuracy_m,address,map_link,photo_url,photo_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(recordId, created, date, String(body.deviceTime || ''), user.username, user.name,
        String(body.type || 'in').toLowerCase() === 'out' ? 'เลิกงาน' : 'เข้างาน', latitude, longitude,
        accuracy, address, mapLink, photo.url, photo.id);
  } catch (error) {
    if (String(error).includes('UNIQUE')) {
      const row = db.prepare('SELECT * FROM checkins WHERE username = ? COLLATE NOCASE AND local_date = ?').get(user.username, date);
      return { ok: false, error: 'already_checked_in', record: checkinRecord(row) };
    }
    throw error;
  }
  return { ok: true, record: { id: recordId, time: created, type: body.type || 'in', name: user.name,
    lat: latitude, lng: longitude, accuracy, address, mapLink, photoUrl: photo.url } };
}

function readLeaves(where = '', params = []) {
  return db.prepare(`SELECT * FROM leaves ${where} ORDER BY created_at DESC`).all(...params).map((row) => ({
    id: row.id, created: row.created_at, username: row.username, name: row.name,
    leaveType: row.leave_type, startDate: row.start_date, endDate: row.end_date, days: row.days,
    reason: row.reason, status: row.status, decidedBy: row.decided_by, decidedAt: row.decided_at, note: row.note
  }));
}

function employeeSave(body, admin) {
  const employee = body.employee || {};
  const username = String(employee.username || '').trim();
  if (!username) return { ok: false, error: 'missing_username' };
  const original = String(employee.origUsername || username).trim();
  const existing = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(original);
  const now = nowIso();
  const role = normalizeRole(employee.role);
  const name = String(employee.name || username).trim();
  const active = parseActive(employee.active) ? 1 : 0;
  const shippingCode = String(employee.shippingCode || '').trim();
  if (existing) {
    const another = db.prepare('SELECT username FROM users WHERE username = ? COLLATE NOCASE AND username <> ? COLLATE NOCASE').get(username, original);
    if (another) return { ok: false, error: 'username_exists' };
    const password = employee.password ? passwordHash(employee.password) : existing.password_hash;
    db.prepare(`UPDATE users SET username=?,password_hash=?,name=?,role=?,active=?,shipping_code=?,updated_at=?
      WHERE username=? COLLATE NOCASE`).run(username, password, name, role, active, shippingCode, now, original);
    return { ok: true, mode: 'updated', username };
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username)) return { ok: false, error: 'username_exists' };
  if (!employee.password) return { ok: false, error: 'missing_password' };
  db.prepare(`INSERT INTO users (username,password_hash,name,role,active,shipping_code,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(username, passwordHash(employee.password), name, role, active, shippingCode, now, now);
  return { ok: true, mode: 'created', username };
}

function receiptRow(row) {
  return {
    id: row.id, time: row.server_time, deviceTime: row.device_time, username: row.username, name: row.name,
    note: row.note, lat: row.latitude, lng: row.longitude, accuracy: row.accuracy_m,
    address: row.address, mapLink: row.map_link, photoUrl: row.photo_url, photoId: row.photo_id,
    inspectDate: row.inspect_date, retakeCount: row.retake_count
  };
}

async function saveReceipt(body, user) {
  if (normalizeRole(user.role) !== 'employee-shipping') return { ok: false, error: 'receipt_not_allowed' };
  if (isWindowsDevice(body.userAgent)) return { ok: false, error: 'mobile_required' };
  const inspectDate = String(body.inspectDate || '').trim();
  if (!validYmd(inspectDate)) return { ok: false, error: 'missing_inspect_date' };
  if (!body.photo) return { ok: false, error: 'no_photo' };
  const latitude = Number.parseFloat(body.lat);
  const longitude = Number.parseFloat(body.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { ok: false, error: 'no_location' };
  const existing = db.prepare('SELECT * FROM receipts WHERE username = ? COLLATE NOCASE AND inspect_date = ?').get(user.username, inspectDate);
  if (existing && !(body.replace === true || body.replace === 'true')) return { ok: false, error: 'receipt_date_exists', record: receiptRow(existing) };
  const photo = replaceDataImage(body.photo, 'receipts', `${inspectDate}_${user.username}`);
  const address = await reverseGeocode(latitude, longitude);
  const mapLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
  const accuracy = Number.parseFloat(body.accuracy || 0) || 0;
  const note = String(body.note || '').trim().slice(0, 300);
  const now = nowIso();
  if (existing) {
    const retake = Number(existing.retake_count) + 1;
    db.prepare(`UPDATE receipts SET server_time=?,device_time=?,note=?,latitude=?,longitude=?,accuracy_m=?,address=?,
      map_link=?,photo_url=?,photo_id=?,retake_count=? WHERE id=?`)
      .run(now, String(body.deviceTime || ''), note, latitude, longitude, accuracy, address, mapLink, photo.url, photo.id, retake, existing.id);
    return { ok: true, mode: 'replaced', record: { ...receiptRow({ ...existing, server_time: now, note, latitude, longitude,
      accuracy_m: accuracy, address, map_link: mapLink, photo_url: photo.url, photo_id: photo.id, retake_count: retake }) } };
  }
  const receiptId = id('RC');
  db.prepare(`INSERT INTO receipts (id,server_time,device_time,username,name,note,latitude,longitude,accuracy_m,address,
    map_link,photo_url,photo_id,inspect_date,retake_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`)
    .run(receiptId, now, String(body.deviceTime || ''), user.username, user.name, note, latitude, longitude,
      accuracy, address, mapLink, photo.url, photo.id, inspectDate);
  return { ok: true, mode: 'created', record: { id: receiptId, time: now, name: user.name, note, inspectDate,
    retakeCount: 0, lat: latitude, lng: longitude, accuracy, address, mapLink, photoUrl: photo.url } };
}

export async function dispatch(body = {}) {
  const action = String(body.action || '');
  if (action === 'login') return login(body);

  if (action === 'me') {
    const session = guard(body); return session.error || { ok: true, user: session.user };
  }
  if (action === 'todayStatus') {
    const session = guard(body); if (session.error) return session.error;
    const row = db.prepare('SELECT * FROM checkins WHERE username = ? COLLATE NOCASE AND local_date = ?').get(session.user.username, ymd());
    return { ok: true, checkedIn: Boolean(row), record: row ? checkinRecord(row) : null };
  }
  if (action === 'checkin') return checkin(body);
  if (action === 'report') {
    const session = guard(body, ['admin', 'manager']); if (session.error) return session.error;
    return { ok: true, rows: db.prepare('SELECT * FROM checkins ORDER BY server_time DESC LIMIT 5000').all().map(checkinRecord) };
  }
  if (action === 'myCheckins') {
    const session = guard(body); if (session.error) return session.error;
    return { ok: true, rows: db.prepare('SELECT * FROM checkins WHERE username = ? COLLATE NOCASE ORDER BY server_time DESC LIMIT 100')
      .all(session.user.username).map(checkinRecord) };
  }

  if (action === 'requestLeave') {
    const session = guard(body); if (session.error) return session.error;
    const leaveType = String(body.leaveType || '').trim();
    const startDate = String(body.startDate || '').trim();
    const endDate = String(body.endDate || startDate).trim();
    if (!leaveType || !validYmd(startDate)) return { ok: false, error: 'missing_leave_fields' };
    if (!validYmd(endDate) || endDate < startDate) return { ok: false, error: 'invalid_date_range' };
    const leaveId = id('LV');
    const days = daysBetween(startDate, endDate);
    db.prepare(`INSERT INTO leaves (id,created_at,username,name,leave_type,start_date,end_date,days,reason)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(leaveId, nowIso(), session.user.username, session.user.name, leaveType, startDate, endDate, days, String(body.reason || '').trim());
    return { ok: true, record: { id: leaveId, leaveType, startDate, endDate, days, status: 'pending' } };
  }
  if (action === 'myLeaves') {
    const session = guard(body); if (session.error) return session.error;
    return { ok: true, rows: readLeaves('WHERE username = ? COLLATE NOCASE', [session.user.username]) };
  }
  if (action === 'listLeaves') {
    const session = guard(body, ['admin']); if (session.error) return session.error;
    const status = String(body.status || '').trim().toLowerCase();
    return { ok: true, rows: status ? readLeaves('WHERE LOWER(status) = ?', [status]) : readLeaves() };
  }
  if (action === 'decideLeave') {
    const session = guard(body, ['admin']); if (session.error) return session.error;
    const decision = String(body.decision || '').toLowerCase();
    if (!['approved', 'rejected'].includes(decision)) return { ok: false, error: 'bad_request' };
    const result = db.prepare('UPDATE leaves SET status=?,decided_by=?,decided_at=?,note=? WHERE id=?')
      .run(decision, session.user.name, nowIso(), String(body.note || ''), String(body.id || ''));
    return result.changes ? { ok: true, id: body.id, status: decision } : { ok: false, error: 'leave_not_found' };
  }

  if (action === 'listEmployees') {
    const session = guard(body, ['admin']); if (session.error) return session.error;
    return { ok: true, rows: db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map((row) => ({
      username: row.username, password: '', name: row.name, role: normalizeRole(row.role),
      active: row.active ? 'yes' : 'no', shippingCode: row.shipping_code || ''
    })) };
  }
  if (action === 'saveEmployee') {
    const session = guard(body, ['admin']); if (session.error) return session.error;
    return employeeSave(body, session.user);
  }

  if (action === 'appOptions') {
    const session = guard(body); if (session.error) return session.error;
    return { ok: true, ...appOptionsPayload(), canEdit: ['admin', 'manager'].includes(session.user.role), canEditSheet: session.user.role === 'admin' };
  }
  if (action === 'saveAppOptions') {
    const session = guard(body, ['admin', 'manager']); if (session.error) return session.error;
    const current = readAppOptions();
    for (const key of ['ports', 'emPorts', 'seal', 'knock', 'overtime']) if (body.options?.[key] !== undefined) writeAppOption(key, body.options[key] ?? current[key]);
    return { ok: true, ...appOptionsPayload() };
  }
  if (action === 'saveSheetLayout') {
    const session = guard(body, ['admin']); if (session.error) return session.error;
    writeAppOption('sheet', body.reset === true ? sheetLayoutDefault() : body.layout);
    return { ok: true, ...appOptionsPayload(), canEditSheet: true };
  }

  if (action === 'claimConfig') {
    const session = guard(body); if (session.error) return session.error;
    return claimConfig(session.user);
  }
  if (action === 'saveClaimConfig') {
    const session = guard(body, ['admin', 'manager']); if (session.error) return session.error;
    if (!Array.isArray(body.items) || !body.items.length) return { ok: false, error: 'bad_request' };
    return { ok: true, items: saveClaimRates(body.items) };
  }
  if (action === 'saveClaim') {
    const session = guard(body); if (session.error) return session.error;
    return saveClaim(body.claim, session.user);
  }
  if (action === 'myClaims') {
    const session = guard(body); if (session.error) return session.error;
    const settled = new Set(db.prepare('SELECT inspect_date FROM settlements WHERE username = ? COLLATE NOCASE').all(session.user.username).map((row) => row.inspect_date));
    return { ok: true, rows: listClaims(session.user.username, 100).filter((row) => !settled.has(row.inspectDate)), settledDates: [...settled] };
  }
  if (action === 'listClaims') {
    const session = guard(body, ['admin', 'manager']); if (session.error) return session.error;
    return { ok: true, rows: listClaims(null, 500) };
  }

  if (action === 'settleConfig') {
    const session = guard(body); if (session.error) return session.error;
    return settleConfig(session.user);
  }
  if (action === 'blLookup') {
    const session = guard(body); if (session.error) return session.error;
    const date = String(body.date || '').trim();
    if (!validYmd(date)) return { ok: false, error: 'missing_inspect_date' };
    let user = session.user;
    if (body.username && ['admin', 'manager'].includes(user.role)) {
      const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(body.username));
      if (row) user = publicUser(row);
    }
    return { ...lookupTransport(date, user), date, shipping: user.name };
  }
  if (action === 'transportDiag') {
    const session = guard(body, ['admin', 'manager']); if (session.error) return session.error;
    return transportDiagnostics();
  }
  if (action === 'slipOcrDiag') {
    const session = guard(body, ['admin', 'manager']); if (session.error) return session.error;
    return ocrDiagnostics();
  }
  if (action === 'verifySlip') {
    const session = guard(body); if (session.error) return session.error;
    return verifySlip(body, session.user);
  }
  if (action === 'saveSettleRates') {
    const session = guard(body, ['admin', 'manager']); if (session.error) return session.error;
    return { ok: true, autoRates: saveSettleRates(body.rates), autoMin: { extra_movement: 2 } };
  }
  if (action === 'saveSettlement') {
    const session = guard(body); if (session.error) return session.error;
    return saveSettlement(body.settlement, session.user);
  }
  if (action === 'saveSettleImage') {
    const session = guard(body); if (session.error) return session.error;
    if (!body.id || !body.image) return { ok: false, error: 'bad_request' };
    return saveSettlementImage(String(body.id), body.image, session.user);
  }
  if (action === 'mySettlements') {
    const session = guard(body); if (session.error) return session.error;
    return { ok: true, rows: listSettlements(session.user.username, 100) };
  }
  if (action === 'listSettlements') {
    const session = guard(body, ['admin', 'manager']); if (session.error) return session.error;
    return { ok: true, rows: listSettlements(null, 500) };
  }

  if (action === 'saveReceipt') {
    const session = guard(body); if (session.error) return session.error;
    return saveReceipt(body, session.user);
  }
  if (action === 'myReceipts') {
    const session = guard(body); if (session.error) return session.error;
    return { ok: true, rows: db.prepare('SELECT * FROM receipts WHERE username = ? COLLATE NOCASE ORDER BY server_time DESC LIMIT 60')
      .all(session.user.username).map(receiptRow) };
  }
  if (action === 'listReceipts') {
    const session = guard(body, ['admin', 'manager']); if (session.error) return session.error;
    return { ok: true, rows: db.prepare('SELECT * FROM receipts ORDER BY server_time DESC LIMIT 500').all().map(receiptRow) };
  }

  return { ok: false, error: 'unknown_action' };
}
