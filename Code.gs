/**
 * ระบบเช็คชื่อเข้างานนอกสถานที่ (Off-site Attendance Check-in)
 * Backend: Google Apps Script Web App
 *
 * ==== วิธีตั้งค่า (ทำครั้งเดียว) ====
 * 1) เปิด Google Sheet ที่จะใช้เป็นฐานข้อมูล แล้วเมนู Extensions > Apps Script
 * 2) วางไฟล์นี้ทั้งหมดลงใน Code.gs
 * 3) แก้ค่า CONFIG ด้านล่างให้ตรง (SHEET_ID, PHOTO_FOLDER_ID ถ้ามี)
 * 4) รันฟังก์ชัน setupSheets() หนึ่งครั้ง เพื่อสร้างแท็บ Users / CheckIns / Sessions
 * 5) Deploy > New deployment > เลือก type = Web app
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    แล้วคัดลอก URL (ลงท้าย /exec) ไปใส่ใน index.html (ตัวแปร API_URL)
 *
 * ทุกครั้งที่แก้โค้ดแล้วต้อง Deploy > Manage deployments > แก้ version = New version
 */

// ============ CONFIG ============
var CONFIG = {
  // ถ้าเปิด Apps Script จากใน Sheet โดยตรง ปล่อยว่างได้ (ระบบจะใช้ Active Spreadsheet)
  // หรือใส่ ID ของ Sheet (ส่วนกลางของลิงก์ .../spreadsheets/d/<SHEET_ID>/edit)
  SHEET_ID: '1ADnivyELPvtc8I0BAkD2IIiQlzslDd8g-KF2_D1EvfM',

  // โฟลเดอร์ Google Drive สำหรับเก็บรูป (ปล่อยว่าง = สร้างโฟลเดอร์ชื่อ CheckinPhotos อัตโนมัติ)
  PHOTO_FOLDER_ID: '',

  // โฟลเดอร์เก็บรูปใบเสร็จจากเมนู "ส่งใบเสร็จ" (ปล่อยว่าง = สร้างโฟลเดอร์ชื่อ ReceiptPhotos อัตโนมัติ)
  RECEIPT_FOLDER_ID: '',

  SESSION_HOURS: 12,          // อายุ token ของการล็อกอิน (ชั่วโมง)
  MAX_ACCURACY_METERS: 200,   // ความคลาดเคลื่อนพิกัดสูงสุดที่ยอมรับ (กันตำแหน่งมั่ว) ตั้ง 0 = ปิด

  // คอมพิวเตอร์ไม่มีชิป GPS — หาตำแหน่งจาก Wi-Fi/IP ความคลาดเคลื่อนปกติหลักร้อยถึงหลักพันเมตร
  // ถ้าใช้เพดานเดียวกับมือถือ (200 ม.) พนักงานสำนักงาน/ผู้จัดการจะกดเข้างานไม่ผ่านแทบทุกครั้ง
  MAX_ACCURACY_METERS_DESKTOP: 5000,

  // ---- ชีตงานขนส่ง (ใช้ในเมนู "ปิดบัญชี" เพื่อดึงเลข BL / จำนวนตู้) ----
  // ใส่ได้หลายไฟล์ — ระบบอ่าน **ทุกแท็บของทุกไฟล์** แล้วรวมเป็นรายการเดียว
  // ต้องแชร์ทุกไฟล์ให้บัญชี Google ที่ใช้ Deploy เห็นได้ (อย่างน้อยสิทธิ์ "ผู้อ่าน")
  // เพิ่มไฟล์ใหม่ = เอา ID (ส่วนกลางของลิงก์ .../spreadsheets/d/<ID>/edit) มาต่อในลิสต์นี้
  TRANSPORT_SHEET_IDS: [
    '17NsBNqE8vlMfAH_CnUpms_jcrLQhs20Xw18yNHHTaT8',
    '1B733V3nfzECPxL0SHUG17Mo8Kzf0xnjirDK51Xe3Y-U'
  ],
  // ค่าเดิมของเวอร์ชันก่อน (ไฟล์เดียว) — ยังใส่ได้ ระบบจะรวมกับ TRANSPORT_SHEET_IDS ให้เอง
  TRANSPORT_SHEET_ID: '',
  TRANSPORT_HEADER_SCAN_ROWS: 15,   // หัวตารางอาจไม่ได้อยู่แถวแรก เลยไล่หาในไม่กี่แถวแรก
  TRANSPORT_CACHE_SECONDS: 180,     // จำผลค้นหาไว้สั้น ๆ กันอ่านทั้งไฟล์ซ้ำ ๆ

  // วิธีนับจำนวนตู้: 'auto' = มีคอลัมน์จำนวนตู้ใช้อันนั้น, ไม่มีก็นับเบอร์ตู้ที่ไม่ซ้ำ, ไม่มีอีกก็นับจำนวนแถว
  // บังคับได้ด้วย 'qty' | 'container' | 'rows' ถ้าชีตจริงนับแบบไหนแน่นอนแล้ว
  TRANSPORT_COUNT_MODE: 'auto',

  // โฟลเดอร์ Google Drive ที่เก็บรูปใบปิดบัญชี (แยกโฟลเดอร์ย่อยรายเดือนให้อัตโนมัติ)
  // ต้องแชร์โฟลเดอร์นี้ให้บัญชีที่ใช้ Deploy มีสิทธิ์ "ผู้แก้ไข"
  SETTLE_IMAGE_FOLDER_ID: '1mnQYA8hGyE3KAFGWQSsPJIM-YxK9iJmM',

  // ---- สลิปโอนเงินคืนบริษัท (ใช้เมื่อคงเหลือเป็นบวก = พนักงานต้องโอนคืน) ----
  // ปล่อยว่าง = สร้างโฟลเดอร์ชื่อ TransferSlips ให้อัตโนมัติ (แยกโฟลเดอร์ย่อยรายเดือน)
  SLIP_FOLDER_ID: '',
  // true  = อ่านสลิปไม่ออก (เช่น ยังไม่เปิด Drive API หรือรูปไม่ชัด) ให้ "บันทึกไม่ได้"
  // false = บันทึกได้ แต่ติดสถานะ "รอผู้ดูแลตรวจ" ให้ admin/manager มาตรวจเองภายหลัง
  //         (แนะนำ false ไว้ก่อน เพราะสลิปบางธนาคาร/รูปเอียง OCR อาจอ่านไม่ออก จะทำให้พนักงานปิดบัญชีไม่ได้เลย)
  SLIP_STRICT: false,
  // ยอดในสลิปต่างจากยอดที่ต้องโอนได้ไม่เกินกี่บาท (กันปัญหาปัดเศษสตางค์)
  SLIP_AMOUNT_TOLERANCE: 1,
};

// ชื่อหัวคอลัมน์ที่ยอมรับในชีตงานขนส่ง (เทียบแบบตัดช่องว่าง/จุด/วงเล็บ และไม่สนตัวพิมพ์)
// ถ้าชีตจริงใช้ชื่ออื่น เพิ่มลงในลิสต์ที่ตรงกันได้เลย แล้ว Deploy ใหม่
var TRANSPORT_ALIASES = {
  shipping:  ['ชิปปิ้ง', 'ชิบปิ้ง', 'ชิปปิ่ง', 'ชื่อชิปปิ้ง', 'ชื่อshipping', 'shipping', 'shippingname', 'พนักงานชิปปิ้ง'],
  transport: ['transport', 'วันที่transport', 'วันtransport', 'transportdate', 'วันที่ตรวจปล่อย', 'วันตรวจปล่อย'],
  bl:        ['เลขbl', 'bl', 'blno', 'blnumber', 'เลขที่bl', 'hbl', 'mbl', 'housebl'],
  container: ['containerno', 'เบอร์ตู้', 'หมายเลขตู้', 'เลขตู้', 'container', 'containernumber', 'cntrno', 'ตู้'],
  qty:       ['จำนวนตู้', 'จำนวน', 'จน.ตู้', 'qty', 'quantity'],
  port:      ['ท่า', 'ท่าเรือ', 'ท่าส่งออก', 'port', 'terminal'],
  // ในชีตงานขนส่งใช้คำว่า "ชิปเปอร์" (ผู้ส่งออก) เป็นชื่อลูกค้าในฟอร์มปิดบัญชี
  customer:  ['ชื่อลูกค้า', 'ลูกค้า', 'ชิปเปอร์', 'ชิพเปอร์', 'shipper', 'customer', 'customername', 'consignee', 'ชื่อผู้นำเข้า']
};

// ============ ROLES & นโยบายการเช็คชื่อ ============
// admin             : ผู้ดูแลระบบ (ไม่มีเมนูเข้างาน)
// manager           : ผู้จัดการ — เข้างานผ่านคอมพิวเตอร์ Windows เท่านั้น ใช้แค่ตำแหน่ง ไม่ต้องถ่ายรูป
// employee-office   : พนักงานสำนักงาน — เงื่อนไขเดียวกับ manager (Windows + ตำแหน่ง ไม่ถ่ายรูป)
// employee-shipping : พนักงานจัดส่ง — ห้ามเข้างานผ่านคอมพิวเตอร์ Windows ต้องเปิดกล้องถ่ายรูปด้วย
//
// role เดิมในชีตที่เป็น 'employee' เฉย ๆ ถือเป็น employee-shipping (พฤติกรรมเหมือนเดิมทุกอย่าง)
function normalizeRole(role) {
  var r = String(role || 'employee').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (r === 'employee' || r === 'shipping') return 'employee-shipping';
  if (r === 'office') return 'employee-office';
  return r;
}

// นโยบายเช็คชื่อของแต่ละ role — ส่งให้ frontend ใช้ตัดสินใจหน้าจอ และเซิร์ฟเวอร์บังคับซ้ำอีกชั้นตอน checkin
function checkinPolicy(role) {
  var r = normalizeRole(role);
  if (r === 'manager' || r === 'employee-office') {
    return { canCheckin: true, device: 'windows', photo: false };
  }
  if (r === 'employee-shipping') {
    return { canCheckin: true, device: 'mobile', photo: true };
  }
  return { canCheckin: false, device: 'any', photo: false };  // admin และ role อื่น ๆ
}

function isWindowsDevice(userAgent) {
  var ua = String(userAgent || '');
  return /Windows NT/i.test(ua) && !/Windows Phone/i.test(ua);
}

// ============ ROUTER ============
function doGet(e) {
  // ใช้สำหรับทดสอบว่า Web App ทำงาน
  return jsonOut({ ok: true, message: 'Check-in API is running', time: new Date() });
}

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var action = body.action || '';
    var result;
    switch (action) {
      case 'login':         result = apiLogin(body);         break;
      case 'checkin':       result = apiCheckin(body);       break;
      case 'report':        result = apiReport(body);        break;
      case 'me':            result = apiMe(body);            break;
      case 'todayStatus':   result = apiTodayStatus(body);   break;
      case 'myCheckins':    result = apiMyCheckins(body);    break;  // ประวัติการเข้างานของตัวเอง (พนักงาน)
      // ---- ระบบลา ----
      case 'requestLeave':  result = apiRequestLeave(body);  break;  // พนักงานยื่นลา
      case 'myLeaves':      result = apiMyLeaves(body);      break;  // ประวัติลาของตัวเอง
      case 'listLeaves':    result = apiListLeaves(body);    break;  // admin ดูใบลาทั้งหมด
      case 'decideLeave':   result = apiDecideLeave(body);   break;  // admin อนุมัติ/ปฏิเสธ
      // ---- จัดการพนักงาน (admin) ----
      case 'listEmployees': result = apiListEmployees(body); break;
      case 'saveEmployee':  result = apiSaveEmployee(body);  break;
      // ---- การเบิกค่าใช้จ่าย ----
      case 'claimConfig':     result = apiClaimConfig(body);     break;  // อ่านหัวข้อ + อัตราต่อตู้
      case 'saveClaimConfig': result = apiSaveClaimConfig(body); break;  // admin/manager ปรับอัตรา
      case 'saveClaim':       result = apiSaveClaim(body);       break;  // บันทึก/แก้ไขใบเบิก
      case 'myClaims':        result = apiMyClaims(body);        break;  // ใบเบิกของตัวเอง
      case 'listClaims':      result = apiListClaims(body);      break;  // admin/manager ดูทั้งหมด
      // ---- ปิดบัญชี ----
      case 'settleConfig':     result = apiSettleConfig(body);     break;  // ช่องค่าใช้จ่าย + วันที่ที่เบิกไว้
      case 'blLookup':         result = apiBlLookup(body);         break;  // ดึงเลข BL/จำนวนตู้ จากชีตงานขนส่ง
      case 'transportDiag':    result = apiTransportDiag(body);    break;  // admin ตรวจการเชื่อมชีตงานขนส่ง
      case 'slipOcrDiag':      result = apiSlipOcrDiag(body);      break;  // admin ตรวจระบบอ่านสลิป (OCR)
      case 'saveSettlement':   result = apiSaveSettlement(body);   break;
      case 'verifySlip':       result = apiVerifySlip(body);       break;  // อัปโหลด+ตรวจสลิปโอนคืนบริษัท
      case 'saveSettleRates':  result = apiSaveSettleRates(body);  break;  // admin/manager ตั้งอัตราคิดอัตโนมัติ
      case 'saveSettleImage':  result = apiSaveSettleImage(body);  break;  // เก็บรูปใบปิดบัญชีลง Drive
      case 'mySettlements':    result = apiMySettlements(body);    break;
      case 'listSettlements':  result = apiListSettlements(body);  break;
      // ---- ตัวเลือก dropdown (ท่า / ค่าตะกั่ว / ค่าน็อคตู้ / ค่าล่วงเวลา) ----
      case 'appOptions':       result = apiAppOptions(body);       break;
      case 'saveAppOptions':   result = apiSaveAppOptions(body);   break;  // admin/manager
      case 'saveSheetLayout':  result = apiSaveSheetLayout(body);  break;  // หน้าตารูปใบปิดบัญชี (admin เท่านั้น)
      // ---- ส่งใบเสร็จ ----
      case 'saveReceipt':      result = apiSaveReceipt(body);      break;
      case 'myReceipts':       result = apiMyReceipts(body);       break;
      case 'listReceipts':     result = apiListReceipts(body);     break;  // admin/manager
      default:              result = { ok: false, error: 'unknown_action' };
    }
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

// ============ API: LOGIN ============
function apiLogin(body) {
  var username = String(body.username || '').trim();
  var password = String(body.password || '');
  if (!username || !password) return { ok: false, error: 'missing_credentials' };

  var users = getSheet('Users');
  var data = users.getDataRange().getValues();
  var head = data[0];
  var col = colMap(head);

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var uname = String(row[col.username]).trim();
    if (uname.toLowerCase() !== username.toLowerCase()) continue;

    var active = String(row[col.active]).trim().toLowerCase();
    if (active === 'no' || active === 'false' || active === '0') {
      return { ok: false, error: 'account_disabled' };
    }
    // เทียบรหัสผ่านแบบ plaintext (จัดการง่ายในชีต)
    if (String(row[col.password]) !== password) {
      return { ok: false, error: 'invalid_credentials' };
    }

    var device = String(body.device || '').slice(0, 500);
    var token = createSession(uname, device);
    var role = normalizeRole(row[col.role]);
    return {
      ok: true,
      token: token,
      user: {
        username: uname,
        name: String(row[col.name] || uname),
        role: role,
        shippingCode: col.shippingCode >= 0 ? String(row[col.shippingCode] || '').trim() : '',
        policy: checkinPolicy(role)
      }
    };
  }
  return { ok: false, error: 'invalid_credentials' };
}

// ============ API: ME (ตรวจ token) ============
function apiMe(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  return { ok: true, user: s.user };
}

// ============ API: สถานะเช็คชื่อวันนี้ (จำกัดเข้างานได้วันละ 1 ครั้ง) ============
function apiTodayStatus(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  var rec = findTodayCheckin(s.user.username);
  return { ok: true, checkedIn: !!rec, record: rec };
}

// หาแถวเช็คชื่อของ username ในวันนี้ (ตามเวลาเซิร์ฟเวอร์) ถ้ามีแล้วคืนค่าแถวนั้น ไม่มีคืน null
function findTodayCheckin(username) {
  var sheet = getSheet('CheckIns');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var tz = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  // appendRow ต่อท้ายเสมอ (เวลาเรียงเพิ่มขึ้น) เช็คแค่แถวท้าย ๆ ก็พอ ไม่ต้องโหลดทั้งชีตทุกครั้ง
  // (ชีตสะสมนานเป็นปีจะมีเป็นหมื่นแถว โหลดทั้งหมดทุกครั้งที่กดเข้างานจะช้าลงเรื่อย ๆ)
  var CHUNK = 2000;
  var startRow = Math.max(2, lastRow - CHUNK + 1);
  var rows = sheet.getRange(startRow, 1, lastRow - startRow + 1, 12).getValues();

  for (var i = rows.length - 1; i >= 0; i--) {
    var r = rows[i];
    if (!r[0]) continue;
    var d = Utilities.formatDate(new Date(r[1]), tz, 'yyyy-MM-dd');
    if (d !== today) break; // ย้อนออกนอกวันนี้แล้ว ไม่ต้องหาไกลกว่านี้
    if (String(r[3]).toLowerCase() === String(username).toLowerCase()) {
      return {
        id: r[0],
        time: r[1] ? new Date(r[1]).toISOString() : '',
        type: r[5],
        address: r[9],
        mapLink: r[10],
        photoUrl: r[11]
      };
    }
  }
  return null;
}

// ============ API: CHECK-IN ============
function apiCheckin(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  var user = s.user;

  // ---- ตรวจสิทธิ์/ชนิดอุปกรณ์ตาม role (frontend กันไว้ชั้นหนึ่งแล้ว ตรงนี้กันซ้ำฝั่งเซิร์ฟเวอร์) ----
  var policy = checkinPolicy(user.role);
  if (!policy.canCheckin) return { ok: false, error: 'checkin_not_allowed' };

  var onWindows = isWindowsDevice(body.userAgent);
  if (policy.device === 'windows' && !onWindows) return { ok: false, error: 'windows_required' };
  if (policy.device === 'mobile' && onWindows) return { ok: false, error: 'mobile_required' };

  var already = findTodayCheckin(user.username);
  if (already) return { ok: false, error: 'already_checked_in', record: already };

  var lat = parseFloat(body.lat);
  var lng = parseFloat(body.lng);
  var accuracy = parseFloat(body.accuracy || 0);
  var type = String(body.type || 'in').toLowerCase();       // 'in' = เข้างาน, 'out' = เลิกงาน
  var deviceTime = String(body.deviceTime || '');
  // role ที่ไม่ต้องถ่ายรูป จะไม่รับรูปที่ส่งมาเลย (กันแอบแนบรูปเก่า)
  var photoBase64 = policy.photo ? String(body.photo || '') : '';

  if (isNaN(lat) || isNaN(lng)) return { ok: false, error: 'no_location' };
  if (policy.photo && !photoBase64) return { ok: false, error: 'no_photo' };

  var maxAccuracy = (policy.device === 'windows') ? CONFIG.MAX_ACCURACY_METERS_DESKTOP : CONFIG.MAX_ACCURACY_METERS;
  if (maxAccuracy > 0 && accuracy > 0 && accuracy > maxAccuracy) {
    return { ok: false, error: 'location_inaccurate', accuracy: accuracy };
  }

  // เวลาจากเซิร์ฟเวอร์ = แหล่งเวลาจริง แก้ไขไม่ได้จากฝั่งผู้ใช้
  var now = new Date();

  // แปลงพิกัดเป็นที่อยู่ (reverse geocode ด้วย Google Maps ในตัว Apps Script)
  var address = reverseGeocode(lat, lng);

  // บันทึกรูปลง Drive (เฉพาะ role ที่ต้องถ่ายรูป)
  var photo = photoBase64 ? savePhoto(photoBase64, user.username, now) : { id: '', url: '' };

  var mapLink = 'https://www.google.com/maps?q=' + lat + ',' + lng;

  var sheet = getSheet('CheckIns');
  var id = 'CK' + now.getTime();
  sheet.appendRow([
    id,
    now,                                  // เวลาเซิร์ฟเวอร์
    deviceTime,                           // เวลาในเครื่อง (อ้างอิง)
    user.username,
    user.name,
    (type === 'out' ? 'เลิกงาน' : 'เข้างาน'),
    lat,
    lng,
    accuracy,
    address,
    mapLink,
    photo.url,
    photo.id
  ]);

  return {
    ok: true,
    record: {
      id: id, time: now, type: type, name: user.name,
      lat: lat, lng: lng, accuracy: accuracy,
      address: address, mapLink: mapLink, photoUrl: photo.url
    }
  };
}

// ============ API: REPORT (admin เท่านั้น) ============
function apiReport(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  if (s.user.role !== 'admin' && s.user.role !== 'manager') return { ok: false, error: 'forbidden' };

  var sheet = getSheet('CheckIns');
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[0]) continue;
    rows.push({
      id: r[0],
      time: r[1] ? new Date(r[1]).toISOString() : '',
      deviceTime: r[2],
      username: r[3],
      name: r[4],
      type: r[5],
      lat: r[6],
      lng: r[7],
      accuracy: r[8],
      address: r[9],
      mapLink: r[10],
      photoUrl: r[11]
    });
  }
  rows.reverse(); // ล่าสุดขึ้นก่อน
  return { ok: true, rows: rows };
}

// ============ API: ประวัติการเข้างานของตัวเอง (พนักงานทุกคนดูของตัวเองได้) ============
function apiMyCheckins(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;

  var sheet = getSheet('CheckIns');
  var data = sheet.getDataRange().getValues();
  var rows = [];
  var MAX_RESULTS = 100; // แสดงล่าสุดพอ ไม่ต้องดึงประวัติทั้งหมดตั้งแต่วันแรก
  for (var i = data.length - 1; i >= 1; i--) {
    var r = data[i];
    if (!r[0]) continue;
    if (String(r[3]).toLowerCase() !== s.user.username.toLowerCase()) continue;
    rows.push({
      id: r[0],
      time: r[1] ? new Date(r[1]).toISOString() : '',
      type: r[5],
      address: r[9],
      mapLink: r[10],
      photoUrl: r[11]
    });
    if (rows.length >= MAX_RESULTS) break;
  }
  return { ok: true, rows: rows };
}

// ============ ADMIN GUARD ============
function requireAdmin(body) {
  var s = validateSession(body.token);
  if (!s.ok) return { err: s };
  if (s.user.role !== 'admin') return { err: { ok: false, error: 'forbidden' } };
  return { user: s.user };
}

// ใช้กับงานที่ผู้จัดการทำได้ด้วย (เช่น ปรับอัตราค่าใช้จ่ายต่อตู้ / ดูใบเบิกของพนักงาน)
function requireManager(body) {
  var s = validateSession(body.token);
  if (!s.ok) return { err: s };
  if (s.user.role !== 'admin' && s.user.role !== 'manager') return { err: { ok: false, error: 'forbidden' } };
  return { user: s.user };
}

// ============ LEAVE: หัวตารางแท็บ Leaves ============
var LEAVE_HEADERS = ['id','created','username','name','leave_type','start_date','end_date','days','reason','status','decided_by','decided_at','note'];

function getLeaveSheet() {
  var ss = getSpreadsheet();
  var sh = ss.getSheetByName('Leaves');
  if (!sh) { sh = ss.insertSheet('Leaves'); }
  if (sh.getLastRow() === 0) { sh.appendRow(LEAVE_HEADERS); sh.setFrozenRows(1); }
  return sh;
}

function daysBetween(start, end) {
  try {
    var a = new Date(start + 'T00:00:00');
    var b = new Date(end + 'T00:00:00');
    var d = Math.round((b - a) / 86400000) + 1;
    return d > 0 ? d : 1;
  } catch (e) { return 1; }
}

// ============ API: พนักงานยื่นลา ============
function apiRequestLeave(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  var user = s.user;

  var leaveType = String(body.leaveType || '').trim();
  var startDate = String(body.startDate || '').trim();
  var endDate = String(body.endDate || startDate).trim();
  var reason = String(body.reason || '').trim();

  if (!leaveType || !startDate) return { ok: false, error: 'missing_leave_fields' };
  if (!endDate) endDate = startDate;
  if (endDate < startDate) return { ok: false, error: 'invalid_date_range' };

  var now = new Date();
  var id = 'LV' + now.getTime();
  var days = daysBetween(startDate, endDate);

  getLeaveSheet().appendRow([
    id, now, user.username, user.name, leaveType,
    startDate, endDate, days, reason, 'pending', '', '', ''
  ]);

  return { ok: true, record: { id: id, leaveType: leaveType, startDate: startDate, endDate: endDate, days: days, status: 'pending' } };
}

// ============ API: ประวัติลาของตัวเอง ============
function apiMyLeaves(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  var rows = readLeaves(function(r) {
    return String(r.username).toLowerCase() === s.user.username.toLowerCase();
  });
  return { ok: true, rows: rows };
}

// ============ API: admin ดูใบลาทั้งหมด ============
function apiListLeaves(body) {
  var g = requireAdmin(body); if (g.err) return g.err;
  var filter = String(body.status || '').trim().toLowerCase();
  var rows = readLeaves(function(r) {
    return !filter || String(r.status).toLowerCase() === filter;
  });
  return { ok: true, rows: rows };
}

function readLeaves(pred) {
  var sh = getLeaveSheet();
  var data = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[0]) continue;
    var obj = {
      id: r[0],
      created: r[1] ? new Date(r[1]).toISOString() : '',
      username: r[2], name: r[3], leaveType: r[4],
      startDate: fmtDate(r[5]), endDate: fmtDate(r[6]), days: r[7],
      reason: r[8], status: r[9], decidedBy: r[10],
      decidedAt: r[11] ? new Date(r[11]).toISOString() : '', note: r[12]
    };
    if (!pred || pred(obj)) out.push(obj);
  }
  out.reverse();
  return out;
}

function fmtDate(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v);
}

// ============ API: admin อนุมัติ/ปฏิเสธการลา ============
function apiDecideLeave(body) {
  var g = requireAdmin(body); if (g.err) return g.err;
  var id = String(body.id || '');
  var decision = String(body.decision || '').toLowerCase(); // approved | rejected
  var note = String(body.note || '');
  if (!id || (decision !== 'approved' && decision !== 'rejected')) return { ok: false, error: 'bad_request' };

  var sh = getLeaveSheet();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === id) {
      sh.getRange(i + 1, 10).setValue(decision);          // status
      sh.getRange(i + 1, 11).setValue(g.user.name);       // decided_by
      sh.getRange(i + 1, 12).setValue(new Date());        // decided_at
      sh.getRange(i + 1, 13).setValue(note);              // note
      return { ok: true, id: id, status: decision };
    }
  }
  return { ok: false, error: 'leave_not_found' };
}

// ============ API: admin รายชื่อพนักงาน ============
function apiListEmployees(body) {
  var g = requireAdmin(body); if (g.err) return g.err;
  var sh = getSheet('Users');
  var data = sh.getDataRange().getValues();
  var col = colMap(data[0]);
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (col.username < 0 || !r[col.username]) continue;
    rows.push({
      username: String(r[col.username]).trim(),
      password: String(r[col.password] || ''),
      name: String(r[col.name] || ''),
      role: normalizeRole(r[col.role]),
      active: String(r[col.active] || 'yes').trim(),
      shippingCode: col.shippingCode >= 0 ? String(r[col.shippingCode] || '').trim() : ''
    });
  }
  return { ok: true, rows: rows };
}

// ============ API: admin เพิ่ม/แก้ไขพนักงาน ============
function apiSaveEmployee(body) {
  var g = requireAdmin(body); if (g.err) return g.err;
  var emp = body.employee || {};
  var username = String(emp.username || '').trim();
  if (!username) return { ok: false, error: 'missing_username' };
  var orig = String(emp.origUsername || '').trim();

  var sh = getSheet('Users');
  ensureUsersShippingColumn(sh);            // ชีตเก่ายังไม่มีคอลัมน์นี้ เติมหัวตารางให้ก่อน
  var data = sh.getDataRange().getValues();
  var col = colMap(data[0]);
  var role = normalizeRole(emp.role);
  var active = String(emp.active || 'yes').trim();
  var name = String(emp.name || username);
  var password = String(emp.password || '');
  var shippingCode = String(emp.shippingCode || '').trim();

  // หาแถวเดิม (แก้ไข) จาก origUsername หรือ username
  var target = -1;
  var key = (orig || username).toLowerCase();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][col.username]).trim().toLowerCase() === key) { target = i; break; }
  }

  if (target >= 0) {
    var row = data[target];
    row[col.username] = username;
    if (password) row[col.password] = password;   // ว่าง = ไม่เปลี่ยนรหัส
    row[col.name] = name;
    row[col.role] = role;
    row[col.active] = active;
    if (col.shippingCode >= 0) row[col.shippingCode] = shippingCode;
    sh.getRange(target + 1, 1, 1, row.length).setValues([row]);
    return { ok: true, mode: 'updated', username: username };
  } else {
    // ป้องกัน username ซ้ำ
    for (var j = 1; j < data.length; j++) {
      if (String(data[j][col.username]).trim().toLowerCase() === username.toLowerCase())
        return { ok: false, error: 'username_exists' };
    }
    // วางค่าตามตำแหน่งคอลัมน์จริง (ชีตบางไฟล์เรียงคอลัมน์ไม่เหมือนกัน)
    var blank = [];
    for (var w = 0; w < data[0].length; w++) blank.push('');
    var put = function (idx, v) { if (idx >= 0) blank[idx] = v; };
    put(col.username, username); put(col.password, password); put(col.name, name);
    put(col.role, role); put(col.active, active); put(col.shippingCode, shippingCode);
    sh.appendRow(blank);
    return { ok: true, mode: 'created', username: username };
  }
}

// ============ ตัวเลือกที่ admin/manager ปรับได้ (เก็บในแท็บ AppOptions) ============
// เก็บเป็น JSON 1 คีย์ต่อ 1 แถว — เพิ่ม/แก้ค่าได้จากหน้า admin โดยไม่ต้องแก้โค้ดและ Deploy ใหม่
//   ports    : รายการ "ท่า" ให้เลือกแบบ dropdown ในใบปิดบัญชี
//   emPorts  : ท่าที่คิดค่า EXTRA MOVEMENT ให้อัตโนมัติในใบปิดบัญชี (ท่าอื่น = ไม่คิดให้ ปล่อยกรอกเอง)
//   seal     : ค่าตะกั่ว — dropdown เริ่มที่ from ขึ้นทีละ step จนถึง to (+ extra ที่ admin เพิ่มเอง)
//   knock    : ค่าน็อคตู้ — เงื่อนไขเดียวกับ seal (แก้ค่าเริ่มต้น/ขึ้นทีละเท่าไหร่ได้)
//   overtime : ค่าล่วงเวลา — 1 ชุด = perSet บาท เลือกได้ 1..maxSets ชุด (ใบเบิก)
//              ส่วนใบปิดบัญชี ติ๊กเลือกแล้วคิด perSet ต่อ 1 รายการ BL
// ---- หน้าตาของ "รูปใบปิดบัญชี" : เฉพาะ admin ปรับได้ (ตั้งค่าระบบ → ใบปิดบัญชี (รูป)) ----
// ทุกคอลัมน์ตั้งได้ 3 อย่าง: w = ความกว้างช่อง (px), size = ขนาดตัวอักษรในช่อง (px),
// align = ตำแหน่งข้อความในช่อง (left = ชิดซ้าย / center = กึ่งกลาง / right = ชิดขวา)
// ลำดับคอลัมน์ + ชื่อหัวคอลัมน์ยังกำหนดจากโค้ด (index.html) เพื่อให้ตรงกับฟอร์มกระดาษ
var SHEET_COL_DEFS = [
  { k: 'no',                    label: 'ลำดับ',                      w: 81,  align: 'center' },
  { k: 'port',                  label: 'ท่า',                        w: 119, align: 'center' },
  { k: 'bl',                    label: 'เลข BL.',                    w: 234, align: 'center' },
  { k: 'containers',            label: 'จำนวนตู้',                    w: 76,  align: 'center' },
  { k: 'lift_on',               label: 'ค่า LIFT ON',                 w: 120, align: 'right' },
  { k: 'lift_off',              label: 'ค่า LIFT OFF',                w: 120, align: 'right' },
  { k: 'storage',               label: 'ค่า STORAGE',                 w: 120, align: 'right' },
  { k: 'extra_movement',        label: 'ค่า EXTRA MOVEMENT',         w: 120, align: 'right' },
  { k: 'extra_service',         label: 'ค่าบริการเพิ่มเติม (ฟรีโซน)',   w: 150, align: 'right' },
  { k: 'extra_service_transit', label: 'ค่าบริการเพิ่มเติม (ผ่านแดน)',  w: 150, align: 'right' },
  { k: 'overtime',              label: 'ค่าล่วงเวลา (มีใบเสร็จ)',      w: 120, align: 'right' },
  { k: 'order_form',            label: 'ค่า ORDER FORM',              w: 150, align: 'right' },
  { k: 'seal',                  label: 'ค่าตะกั่ว',                   w: 120, align: 'right' },
  { k: '__special',             label: 'ค่าบริการเพิ่มเติมพิเศษ',       w: 150, align: 'left' },
  { k: 'otherDetail',           label: 'รายละเอียดค่าใช้จ่ายอื่นๆ',     w: 225, align: 'left' },
  { k: 'total',                 label: 'รวม',                        w: 120, align: 'right' }
];
// ขนาดตัวอักษรส่วนอื่นของใบ (นอกเหนือจากในช่องตาราง)
var SHEET_FONT_DEFS = [
  { k: 'title', label: 'แถบหัวเรื่อง',                     v: 31.5 },
  { k: 'info',  label: 'แถบวันที่ / ชื่อ SHIPPING / ยอดเบิก', v: 25.2 },
  { k: 'head',  label: 'หัวคอลัมน์',                       v: 21 },
  { k: 'cell',  label: 'ตัวอักษรในช่อง (ค่าตั้งต้นของทุกช่อง)', v: 21 },
  { k: 'foot',  label: 'ตัวเลขท้ายตาราง',                  v: 23.1 }
];
var SHEET_ALIGNS = ['left', 'center', 'right'];
var SHEET_W_MIN = 24, SHEET_W_MAX = 800;
var SHEET_FONT_MIN = 8, SHEET_FONT_MAX = 80;
// รวมทุกคอลัมน์กว้างเกินนี้ = ภาพใหญ่จน iOS Safari วาดออกมาว่าง — ย่อทุกช่องตามสัดส่วนให้พอดี
var SHEET_TOTAL_MAX = 3800;

function sheetLayoutDefault() {
  var cellSize = 21, fonts = {}, cols = {};
  for (var i = 0; i < SHEET_FONT_DEFS.length; i++) {
    fonts[SHEET_FONT_DEFS[i].k] = SHEET_FONT_DEFS[i].v;
    if (SHEET_FONT_DEFS[i].k === 'cell') cellSize = SHEET_FONT_DEFS[i].v;
  }
  for (var j = 0; j < SHEET_COL_DEFS.length; j++) {
    var c = SHEET_COL_DEFS[j];
    cols[c.k] = { w: c.w, size: cellSize, align: c.align };
  }
  return { fonts: fonts, cols: cols };
}

var APP_OPTION_DEFAULTS = {
  ports: ['C1C2', 'A2', 'KERRY', 'A0', 'B4', 'B2', 'SiamCSP', 'A1', 'A3', 'A4', 'A5',
          'B1', 'B3', 'B5', 'C0', 'C3', 'D1D2', 'D3', 'KSSP'],
  // ท่าที่คิดค่า EXTRA MOVEMENT ให้อัตโนมัติ (ท่าอื่นปล่อยว่างให้กรอกเอง) — ติ๊กเลือกได้ที่หน้า admin
  emPorts: ['KERRY', 'C1C2', 'A2', 'A3', 'D1D2', 'D3'],
  seal:     { from: 5,   to: 500,  step: 5,   extra: [] },
  knock:    { from: 100, to: 3000, step: 100, extra: [] },
  overtime: { perSet: 400, maxSets: 20 },
  sheet:    sheetLayoutDefault()
};

var APP_OPTION_HEADERS = ['key', 'value_json', 'note'];
var APP_OPTION_NOTES = {
  ports: 'รายการ "ท่า" ใน dropdown ของใบปิดบัญชี (แก้ที่หน้า admin แท็บการเบิก)',
  emPorts: 'ท่าที่คิดค่า EXTRA MOVEMENT ให้อัตโนมัติในใบปิดบัญชี (ท่าอื่น = ปล่อยว่างให้กรอกเอง) • ว่างทั้งหมด = ไม่คิดให้ทุกท่า',
  seal: 'ค่าตะกั่ว: from=ค่าแรก, step=ขึ้นทีละ, to=ค่าสุดท้าย, extra=ค่าที่เพิ่มเอง',
  knock: 'ค่าน็อคตู้: from=ค่าแรก, step=ขึ้นทีละ, to=ค่าสุดท้าย, extra=ค่าที่เพิ่มเอง',
  overtime: 'ค่าล่วงเวลา: perSet=บาทต่อ 1 ชุด, maxSets=เลือกได้สูงสุดกี่ชุด',
  sheet: 'หน้าตารูปใบปิดบัญชี: cols={ความกว้าง/ขนาดตัวอักษร/ตำแหน่งในช่อง}, fonts=ขนาดตัวอักษรส่วนอื่น (เฉพาะ admin แก้)'
};

// ป้องกันตั้ง step เล็ก ๆ จนได้ตัวเลือกเป็นพัน ๆ (มือถือเลื่อนไม่ไหว)
var OPTION_MAX_VALUES = 400;
// ป้ายชื่อเหตุผลย่อยที่ใช้ dropdown ค่าน็อคตู้ (ทั้งใบเบิกและใบปิดบัญชี)
var KNOCK_LABEL = 'ค่าน็อคตู้';

function getAppOptionSheet() {
  var ss = getSpreadsheet();
  var sh = ss.getSheetByName('AppOptions');
  if (!sh) { sh = ss.insertSheet('AppOptions'); }
  if (sh.getLastRow() === 0) { sh.appendRow(APP_OPTION_HEADERS); sh.setFrozenRows(1); }
  return sh;
}

// รายการข้อความ (ท่า) — ตัดช่องว่าง ตัดค่าซ้ำ และคงลำดับที่ admin จัดไว้
function normTextList(v, fallback) {
  var raw = v;
  if (typeof raw === 'string') {
    var t = raw.trim();
    if (!t) return (fallback || []).slice();
    try { raw = JSON.parse(t); } catch (e) { raw = t.split(','); }
  }
  if (!Array.isArray(raw)) return (fallback || []).slice();
  var out = [], seen = {};
  for (var i = 0; i < raw.length && out.length < 300; i++) {
    var s = String(raw[i] == null ? '' : raw[i]).trim().slice(0, 40);
    if (!s || seen[s.toLowerCase()]) continue;
    seen[s.toLowerCase()] = true;
    out.push(s);
  }
  return out.length ? out : (fallback || []).slice();
}

// รายการ "ท่าที่คิดให้อัตโนมัติ" — ต่างจาก normTextList ตรงที่ยอมให้เป็นลิสต์ว่างได้
// (ติ๊กออกหมด = ไม่คิดให้ท่าไหนเลย ไม่ใช่ย้อนกลับไปใช้ค่าตั้งต้น) ส่วนช่องว่างในชีต = ใช้ค่าตั้งต้น
function normPortList(v, fallback) {
  if (v === undefined || v === null || v === '') return (fallback || []).slice();
  var raw = v;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(String(raw).trim()); } catch (e) { raw = String(v).split(','); }
  }
  if (!Array.isArray(raw)) return (fallback || []).slice();
  var out = [], seen = {};
  for (var i = 0; i < raw.length && out.length < 300; i++) {
    var s = String(raw[i] == null ? '' : raw[i]).trim().slice(0, 40);
    if (!s || seen[portKey(s)]) continue;
    seen[portKey(s)] = true;
    out.push(s);
  }
  return out;
}

// เทียบชื่อท่าแบบไม่สนตัวพิมพ์/ช่องว่าง/ขีด — ชีตงานขนส่งเขียนได้หลายแบบ (D1D2 / d1-d2 / D1 D2)
function portKey(p) { return String(p == null ? '' : p).toUpperCase().replace(/[^A-Z0-9ก-๙]/g, ''); }

// ท่านี้คิดค่า EXTRA MOVEMENT ให้อัตโนมัติไหม (ไม่มีท่า = ไม่คิด)
function portInList(port, list) {
  var k = portKey(port);
  if (!k) return false;
  for (var i = 0; i < (list || []).length; i++) if (portKey(list[i]) === k) return true;
  return false;
}

// ตัวเลือกตัวเลขแบบช่วง (ค่าแรก / ขึ้นทีละ / ค่าสุดท้าย + ค่าที่เพิ่มเอง)
function normRangeOption(v, def) {
  var raw = v;
  if (typeof raw === 'string') {
    var t = raw.trim();
    if (!t) return { from: def.from, to: def.to, step: def.step, extra: [] };
    try { raw = JSON.parse(t); } catch (e) { raw = {}; }
  }
  if (!raw || typeof raw !== 'object') raw = {};
  var step = Number(raw.step); if (!(step > 0)) step = def.step;
  var from = Number(raw.from); if (!(from > 0)) from = def.from;
  var to = Number(raw.to);   if (!(to > 0)) to = def.to;
  if (to < from) to = from;
  // ช่วงกว้างเกินไป (ตัวเลือกจะเยอะเกิน) — ตัดปลายลงให้พอดีเพดาน
  if ((to - from) / step + 1 > OPTION_MAX_VALUES) to = round2(from + step * (OPTION_MAX_VALUES - 1));
  var extra = [], seen = {};
  var rawExtra = Array.isArray(raw.extra) ? raw.extra : [];
  for (var i = 0; i < rawExtra.length && extra.length < 100; i++) {
    var n = round2(Number(rawExtra[i]));
    if (!(n > 0) || seen[n]) continue;
    seen[n] = true;
    extra.push(n);
  }
  return { from: round2(from), to: round2(to), step: round2(step), extra: extra };
}

function normOvertimeOption(v, def) {
  var raw = v;
  if (typeof raw === 'string') {
    var t = raw.trim();
    if (!t) return { perSet: def.perSet, maxSets: def.maxSets };
    try { raw = JSON.parse(t); } catch (e) { raw = {}; }
  }
  if (!raw || typeof raw !== 'object') raw = {};
  // perSet = 0 เป็นค่าที่ตั้งได้จริง (ไม่คิดค่าล่วงเวลา) จึงต้องแยก "ไม่ได้ส่งค่ามา" ออกจาก "ส่ง 0 มา"
  var perSet;
  if (raw.perSet === undefined || raw.perSet === null || raw.perSet === '' || isNaN(Number(raw.perSet))) perSet = def.perSet;
  else perSet = round2(Number(raw.perSet));
  if (perSet < 0) perSet = 0;
  var maxSets = parseInt(raw.maxSets, 10); if (!(maxSets > 0)) maxSets = def.maxSets;
  if (maxSets > 100) maxSets = 100;
  return { perSet: perSet, maxSets: maxSets };
}

// ค่าตัวเลขทั้งหมดของ dropdown (ช่วง + ค่าที่เพิ่มเอง) เรียงจากน้อยไปมาก ไม่ซ้ำ
function buildRangeValues(cfg) {
  var out = [], seen = {};
  var push = function (n) {
    n = round2(n);
    if (!(n > 0) || seen[n] || out.length >= OPTION_MAX_VALUES) return;
    seen[n] = true; out.push(n);
  };
  for (var v = cfg.from; v <= cfg.to + 0.0001; v = round2(v + cfg.step)) {
    push(v);
    if (out.length >= OPTION_MAX_VALUES) break;
  }
  (cfg.extra || []).forEach(push);
  out.sort(function (a, b) { return a - b; });
  return out;
}

// ตัวเลขในช่วงที่กำหนด — ค่าว่าง/ค่าที่ผิดให้ถอยไปใช้ค่าเดิม
function clampSheetNum(v, min, max, def) {
  var n = Number(v);
  if (!(n > 0)) return def;
  if (n < min) n = min;
  if (n > max) n = max;
  return Math.round(n * 10) / 10;
}

// หน้าตาใบปิดบัญชีที่ admin ตั้งไว้ — คีย์ที่ไม่รู้จักถูกทิ้ง ค่าที่ผิดถอยไปใช้ค่าเดิม
// รวมความกว้างเกินเพดาน = ย่อทุกช่องตามสัดส่วน (กันภาพใหญ่จนมือถือวาดไม่ออก)
function normSheetLayout(v, def) {
  var raw = v;
  if (typeof raw === 'string') {
    var t = raw.trim();
    if (!t) return sheetLayoutDefault();
    try { raw = JSON.parse(t); } catch (e) { raw = {}; }
  }
  if (!raw || typeof raw !== 'object') raw = {};
  var base = def || sheetLayoutDefault();
  var out = { fonts: {}, cols: {} };

  var rf = raw.fonts || {};
  for (var i = 0; i < SHEET_FONT_DEFS.length; i++) {
    var fk = SHEET_FONT_DEFS[i].k;
    out.fonts[fk] = clampSheetNum(rf[fk], SHEET_FONT_MIN, SHEET_FONT_MAX, base.fonts[fk]);
  }

  var rc = raw.cols || {}, total = 0;
  for (var j = 0; j < SHEET_COL_DEFS.length; j++) {
    var k = SHEET_COL_DEFS[j].k, c = rc[k] || {}, b = base.cols[k] || sheetLayoutDefault().cols[k];
    var al = String(c.align || '');
    out.cols[k] = {
      w: Math.round(clampSheetNum(c.w, SHEET_W_MIN, SHEET_W_MAX, b.w)),
      size: clampSheetNum(c.size, SHEET_FONT_MIN, SHEET_FONT_MAX, b.size),
      align: SHEET_ALIGNS.indexOf(al) >= 0 ? al : b.align
    };
    total += out.cols[k].w;
  }
  if (total > SHEET_TOTAL_MAX) {
    var f = SHEET_TOTAL_MAX / total;
    for (var m = 0; m < SHEET_COL_DEFS.length; m++) {
      var kk = SHEET_COL_DEFS[m].k;
      out.cols[kk].w = Math.max(SHEET_W_MIN, Math.round(out.cols[kk].w * f));
    }
  }
  return out;
}

// อ่านตัวเลือกจากชีต + เติมแถวที่ยังไม่มี (คีย์ใหม่ในโค้ดจะโผล่มาเอง ไม่ต้องรัน setupSheets ซ้ำ)
function readAppOptions() {
  var sh = getAppOptionSheet();
  var data = sh.getDataRange().getValues();
  var saved = {}, orphan = [];
  for (var i = 1; i < data.length; i++) {
    var k = String(data[i][0] || '').trim();
    if (!k) continue;
    if (APP_OPTION_DEFAULTS[k] === undefined) { orphan.push(i + 1); continue; }
    saved[k] = data[i][1];
  }

  var out = {
    ports: normTextList(saved.ports, APP_OPTION_DEFAULTS.ports),
    emPorts: normPortList(saved.emPorts, APP_OPTION_DEFAULTS.emPorts),
    seal: normRangeOption(saved.seal, APP_OPTION_DEFAULTS.seal),
    knock: normRangeOption(saved.knock, APP_OPTION_DEFAULTS.knock),
    overtime: normOvertimeOption(saved.overtime, APP_OPTION_DEFAULTS.overtime),
    sheet: normSheetLayout(saved.sheet, sheetLayoutDefault())
  };

  var add = [];
  for (var key in APP_OPTION_DEFAULTS) {
    if (!APP_OPTION_DEFAULTS.hasOwnProperty(key)) continue;
    if (saved[key] === undefined) add.push([key, JSON.stringify(out[key]), APP_OPTION_NOTES[key] || '']);
  }
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, APP_OPTION_HEADERS.length).setValues(add);
  for (var m = orphan.length - 1; m >= 0; m--) sh.deleteRow(orphan[m]);
  return out;
}

// ชุดข้อมูลที่หน้าเว็บใช้ — ส่งทั้งค่าที่ตั้งไว้ และรายการตัวเลือกที่คำนวณแล้ว
function appOptionsPayload() {
  var o = readAppOptions();
  return {
    ports: o.ports,
    emPorts: o.emPorts,                    // ท่าที่คิดค่า EXTRA MOVEMENT ให้อัตโนมัติ
    seal: o.seal, knock: o.knock, overtime: o.overtime,
    sealValues: buildRangeValues(o.seal),
    knockValues: buildRangeValues(o.knock),
    knockLabel: KNOCK_LABEL,
    // หน้าตารูปใบปิดบัญชี — หน้าพนักงานใช้วาดรูป, หน้า admin ใช้แก้ (defs = ชื่อ/ช่วงค่าที่อนุญาต)
    sheet: o.sheet,
    sheetDefs: { cols: SHEET_COL_DEFS, fonts: SHEET_FONT_DEFS, aligns: SHEET_ALIGNS,
                 wMin: SHEET_W_MIN, wMax: SHEET_W_MAX,
                 fontMin: SHEET_FONT_MIN, fontMax: SHEET_FONT_MAX, totalMax: SHEET_TOTAL_MAX }
  };
}

// ============ API: อ่าน/บันทึกตัวเลือก ============
function apiAppOptions(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  var res = appOptionsPayload();
  res.ok = true;
  res.canEdit = (s.user.role === 'admin' || s.user.role === 'manager');
  res.canEditSheet = (s.user.role === 'admin');    // หน้าตารูปใบปิดบัญชี เฉพาะ admin
  return res;
}

// ============ API: บันทึกหน้าตารูปใบปิดบัญชี (เฉพาะ admin) ============
function apiSaveSheetLayout(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  if (normalizeRole(s.user.role) !== 'admin') return { ok: false, error: 'forbidden' };

  var cur = readAppOptions();
  var next = (body.reset === true) ? sheetLayoutDefault() : normSheetLayout(body.layout, cur.sheet);
  writeAppOption('sheet', next);

  var res = appOptionsPayload();
  res.ok = true;
  res.canEditSheet = true;
  return res;
}

// เขียนค่าลงแถวของคีย์นั้นในชีต AppOptions (ยังไม่มีแถว = เพิ่มให้)
function writeAppOption(key, value) {
  var sh = getAppOptionSheet();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0] || '').trim() !== key) continue;
    sh.getRange(i + 1, 2, 1, 2).setValues([[JSON.stringify(value), APP_OPTION_NOTES[key] || '']]);
    return;
  }
  sh.appendRow([key, JSON.stringify(value), APP_OPTION_NOTES[key] || '']);
}

function apiSaveAppOptions(body) {
  var g = requireManager(body); if (g.err) return g.err;
  var opt = body.options || {};
  var cur = readAppOptions();

  var next = {
    ports: (opt.ports !== undefined) ? normTextList(opt.ports, cur.ports) : cur.ports,
    // ติ๊กออกหมดได้ (= ไม่คิด EXTRA MOVEMENT ให้ท่าไหนเลย) จึงไม่ใช้ normTextList ที่ย้อนกลับไปค่าตั้งต้น
    emPorts: (opt.emPorts !== undefined) ? normPortList(opt.emPorts, cur.emPorts) : cur.emPorts,
    seal: (opt.seal !== undefined) ? normRangeOption(opt.seal, APP_OPTION_DEFAULTS.seal) : cur.seal,
    knock: (opt.knock !== undefined) ? normRangeOption(opt.knock, APP_OPTION_DEFAULTS.knock) : cur.knock,
    overtime: (opt.overtime !== undefined) ? normOvertimeOption(opt.overtime, APP_OPTION_DEFAULTS.overtime) : cur.overtime
  };

  var sh = getAppOptionSheet();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var k = String(data[i][0] || '').trim();
    if (!k || next[k] === undefined) continue;
    sh.getRange(i + 1, 2, 1, 2).setValues([[JSON.stringify(next[k]), APP_OPTION_NOTES[k] || '']]);
  }
  var res = appOptionsPayload();
  res.ok = true;
  return res;
}

// ============ การเบิกค่าใช้จ่าย (CLAIMS) ============
// หัวข้อค่าใช้จ่ายและลำดับการแสดงกำหนดจากโค้ด ส่วน "อัตราต่อ 1 ตู้" เก็บในชีต ClaimRates (admin/manager แก้ได้)
//   perContainer: true  = คิดอัตโนมัติ (อัตรา x จำนวนตู้) พนักงานแก้ยอดเองไม่ได้
//   perContainer: false = ไม่คิดจากจำนวนตู้ พนักงานกรอกจำนวนเงินเอง (อัตราในชีตใช้เป็นค่าตั้งต้นเฉย ๆ)
//   primary: true       = 5 หัวข้อหลักที่โชว์ให้เลย ที่เหลือซ่อนไว้ใต้สวิตช์ "แสดงหัวข้อทั้งหมด"
//   ownQty: true        = คิดจากจำนวนตู้ "ของหัวข้อนี้เอง" มีปุ่ม ＋ / − เพิ่มลดแยกจากจำนวนตู้ของใบเบิก
//                         (ตั้งต้นเท่าจำนวนตู้ของใบ พอกดปรับเองแล้วจะไม่ถูกทับอีก)
//   input: 'select'     = เลือกจำนวนเงินจาก dropdown (ตัวเลือกมาจาก AppOptions ตาม optionKey)
//   input: 'sets'       = เลือกจำนวน "ชุด" ยอด = ชุด x ค่าต่อชุด (ตั้งค่าที่ AppOptions.overtime)

// จำนวนตู้ขั้นต่ำที่ระบบจะเริ่ม "คิดยอดให้อัตโนมัติ" — ใช้ชุดเดียวกันทั้งใบเบิกและใบปิดบัญชี
// EXTRA MOVEMENT: 1 ชุดงาน BL ที่มีตู้เดียวไม่มีการย้ายตู้เพิ่ม จึงไม่คิดให้เอง เริ่มคิดตั้งแต่ 2 ตู้ขึ้นไป
// (ตู้เดียวแต่มีค่าใช้จ่ายจริง = พนักงานกดเพิ่มจำนวนตู้ของหัวข้อนั้น / พิมพ์ยอดเองได้ตามปกติ)
var AUTO_MIN_CONTAINERS = { extra_movement: 2 };

function autoMinContainers(key) { return Number(AUTO_MIN_CONTAINERS[String(key || '')]) || 0; }

// จำนวนตู้ที่ระบบคิดให้เองของหัวข้อนั้น — ยังไม่ถึงขั้นต่ำ = ไม่คิดให้ (0)
function autoQtyFor(key, containers) {
  var n = Math.max(0, Number(containers) || 0);
  var min = autoMinContainers(key);
  return (min && n < min) ? 0 : n;
}

var CLAIM_ITEM_DEFAULTS = [
  { key: 'lift_on',        label: 'LIFT ON',                     perContainer: true,  rate: 0, primary: true },
  { key: 'extra_service',  label: 'ค่าบริการเพิ่มเติม(ฟรีโซน)',    perContainer: true,  rate: 0, primary: true, ownQty: true },
  { key: 'extra_movement', label: 'EXTRA MOVEMENT',              perContainer: true,  rate: 0, primary: true, ownQty: true },
  { key: 'lift_off',       label: 'LIFT OFF',                    perContainer: false, rate: 0, primary: true },
  { key: 'reserve',        label: 'เงินสำรอง',                    perContainer: false, rate: 0, primary: true },
  { key: 'extra_service_transit', label: 'ค่าบริการเพิ่มเติม(ผ่านแดน)', perContainer: true, rate: 0, ownQty: true },
  { key: 'storage',        label: 'STORAGE',                     perContainer: false, rate: 0 },
  { key: 'order_form',     label: 'ORDER FORM',                  perContainer: true,  rate: 0, ownQty: true },
  { key: 'overtime',       label: 'ค่าล่วงเวลา',                  perContainer: false, rate: 0, input: 'sets' },
  { key: 'seal',           label: 'ค่าตะกั่ว',                    perContainer: false, rate: 0, input: 'select', optionKey: 'seal' },
  // หัวข้อเดียวที่มีเหตุผลย่อยให้ติ๊กเลือก — พนักงานเพิ่มเหตุผลอื่นเองได้ตอนทำใบเบิก
  // "ค่าน็อคตู้" เป็นเหตุผลย่อยตรงนี้ และเลือกจำนวนเงินแบบ dropdown (ตั้งค่าที่ AppOptions.knock)
  { key: 'special',        label: 'ค่าบริการเพิ่มเติมพิเศษ',       perContainer: false, rate: 0,
    reasons: [{ label: 'ยางเกิน', rate: 0 }, { label: 'สำแดงเท็จ', rate: 0 }, { label: KNOCK_LABEL, rate: 0 }] },
  { key: 'other',          label: 'ค่าใช้จ่ายอื่นๆ',               perContainer: false, rate: 0 }
];

var CLAIM_RATE_HEADERS = ['key', 'label', 'per_container', 'rate', 'reasons', 'sort'];

// แก้ไขใบเบิกได้ไม่เกิน 5 ครั้ง (เก็บข้อความของแต่ละครั้งไว้คนละคอลัมน์)
var CLAIM_MAX_EDITS = 5;

// detail       = ข้อความสรุปล่าสุด (คอลัมน์เดิม เก็บไว้เพื่อความเข้ากันได้กับที่อื่นในระบบ)
// detail_all   = สรุปทั้งใบ (ทุกรายการ + ยอดรวมทั้งสิ้น) ของครั้งล่าสุด
// detail_first = สรุปของ "ครั้งแรก" ที่บันทึก (ไม่เปลี่ยนอีกแล้วหลังจากนั้น)
// edit_detail_N = ข้อความ "เฉพาะรายการที่เพิ่มขึ้น" ของการแก้ไขครั้งที่ N (คัดลอกแยกครั้งได้)
var CLAIM_HEADERS = ['id', 'created', 'updated', 'username', 'name', 'inspect_date', 'containers', 'total', 'edit_count', 'items_json', 'detail',
                     'detail_all', 'detail_first',
                     'edit_detail_1', 'edit_detail_2', 'edit_detail_3', 'edit_detail_4', 'edit_detail_5'];
var CLAIM_COL_DETAIL_ALL = 11;                 // ตำแหน่งคอลัมน์ (0-based) ของ detail_all
var CLAIM_COL_DETAIL_FIRST = 12;
var CLAIM_COL_EDIT_1 = 13;                     // edit_detail_1..5 = 13..17

function claimDefault(key) {
  for (var i = 0; i < CLAIM_ITEM_DEFAULTS.length; i++) {
    if (CLAIM_ITEM_DEFAULTS[i].key === key) return CLAIM_ITEM_DEFAULTS[i];
  }
  return null;
}

function getClaimRateSheet() {
  var ss = getSpreadsheet();
  var sh = ss.getSheetByName('ClaimRates');
  if (!sh) { sh = ss.insertSheet('ClaimRates'); }
  if (sh.getLastRow() === 0) { sh.appendRow(CLAIM_RATE_HEADERS); sh.setFrozenRows(1); }
  return sh;
}

function getClaimSheet() {
  var ss = getSpreadsheet();
  var sh = ss.getSheetByName('Claims');
  if (!sh) { sh = ss.insertSheet('Claims'); }
  if (sh.getLastRow() === 0) { sh.appendRow(CLAIM_HEADERS); sh.setFrozenRows(1); }
  else ensureClaimColumns(sh);
  return sh;
}

// เติมคอลัมน์ใหม่ต่อท้ายให้ชีตที่สร้างไว้ก่อนหน้านี้ (ข้อมูลเดิมไม่เลื่อน เพราะเพิ่มท้ายเท่านั้น)
function ensureClaimColumns(sh) {
  var need = CLAIM_HEADERS.length;
  if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
  var head = sh.getRange(1, 1, 1, need).getValues()[0];
  for (var i = 0; i < need; i++) {
    if (String(head[i] || '').trim() !== CLAIM_HEADERS[i]) sh.getRange(1, i + 1).setValue(CLAIM_HEADERS[i]);
  }
}

// รับได้ทั้ง JSON ที่เก็บในชีต, array จากหน้าเว็บ และข้อความคั่นด้วยจุลภาค (เผื่อพิมพ์ในชีตเอง)
function parseReasons(v) {
  if (!v) return [];
  var raw = v;
  if (typeof raw === 'string') {
    var t = raw.trim();
    if (!t) return [];
    try { raw = JSON.parse(t); } catch (e) { raw = t.split(','); }
  }
  if (!Array.isArray(raw)) return [];
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var r = raw[i];
    var isObj = r && typeof r === 'object';
    var label = String(isObj ? (r.label || '') : (r || '')).trim().slice(0, 120);
    if (!label) continue;
    var rate = isObj ? (Number(r.rate) || 0) : 0;
    out.push({ label: label, rate: rate < 0 ? 0 : rate });
  }
  return out;
}

// อ่านหัวข้อ + อัตราจากชีต แล้วเติมแถวของหัวข้อที่ยังไม่มี
// (เพิ่มหัวข้อใหม่ในโค้ดภายหลังจะโผล่มาเอง ไม่ต้องรัน setupSheets ซ้ำ)
// ย้าย "ค่าน็อคตู้" ไปเป็นเหตุผลย่อยของค่าบริการเพิ่มเติมพิเศษ ให้ชีตที่ตั้งค่าไว้ก่อนหน้านี้ — ทำครั้งเดียว
// (หลังจากนี้ admin ลบ/แก้เหตุผลได้ตามปกติ ระบบจะไม่เติมกลับมาอีก)
function migrateKnockToSpecial() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('claim_knock_moved')) return;
  var sh = getClaimRateSheet();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() !== 'special') continue;
    var rs = parseReasons(data[i][4]), has = false;
    for (var j = 0; j < rs.length; j++) if (rs[j].label === 'ค่าน็อคตู้') has = true;
    if (!has) { rs.push({ label: 'ค่าน็อคตู้', rate: 0 }); sh.getRange(i + 1, 5).setValue(JSON.stringify(rs)); }
    break;
  }
  try { props.setProperty('claim_knock_moved', '1'); } catch (e) {}
}

function readClaimItems() {
  migrateKnockToSpecial();
  var sh = getClaimRateSheet();
  var data = sh.getDataRange().getValues();
  var saved = {};
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[0]) continue;
    saved[String(r[0]).trim()] = {
      row: i + 1,
      label: String(r[1] || ''),
      perContainer: String(r[2]).trim().toLowerCase() === 'yes',
      rate: Number(r[3]) || 0,
      reasons: parseReasons(r[4])
    };
  }

  // หัวข้อที่ถูกเอาออกจากโค้ดแล้ว แต่ยังมีแถวค้างในชีต — เก็บเลขแถวไว้ลบทีหลัง
  // (ใบเบิกเก่าไม่กระทบ เพราะเก็บรายการที่เบิกไว้ในตัวเองแล้วที่คอลัมน์ items_json)
  var orphan = [];
  for (var n = 1; n < data.length; n++) {
    if (data[n][0] && !claimDefault(String(data[n][0]).trim())) orphan.push(n + 1);
  }

  var out = [], add = [], fix = [];
  for (var j = 0; j < CLAIM_ITEM_DEFAULTS.length; j++) {
    var d = CLAIM_ITEM_DEFAULTS[j];
    var s = saved[d.key];
    if (!s) add.push([d.key, d.label, d.perContainer ? 'yes' : 'no', d.rate, JSON.stringify(d.reasons || []), j + 1]);
    // ป้ายชื่อ/วิธีคิดในชีตไม่ตรงกับโค้ด (เช่น เปลี่ยนหัวข้อเป็นกรอกเองภายหลัง) — อัปเดตชีตให้ตรง ไม่งั้นคนเปิดชีตจะเข้าใจผิด
    else if (s.perContainer !== d.perContainer || s.label !== d.label) fix.push([s.row, d.label, d.perContainer ? 'yes' : 'no']);
    out.push({
      key: d.key,
      label: d.label,                                   // ป้ายชื่อและวิธีคิดยึดตามโค้ดเสมอ กันชีตถูกแก้จนคำนวณเพี้ยน
      perContainer: d.perContainer,
      rate: s ? s.rate : d.rate,
      primary: !!d.primary,                             // หัวข้อหลักที่โชว์ให้เลยในหน้าเบิก
      ownQty: !!d.ownQty,                               // มีจำนวนตู้ของตัวเอง (EXTRA MOVEMENT)
      minContainers: autoMinContainers(d.key),          // ต่ำกว่านี้ = ไม่คิดให้อัตโนมัติ (EXTRA MOVEMENT เริ่มที่ 2 ตู้)
      input: d.input || (d.perContainer ? 'auto' : 'money'),
      optionKey: d.optionKey || '',
      reasons: d.key === 'special' ? (s ? s.reasons : (d.reasons || [])) : []
    });
  }
  if (add.length) {
    sh.getRange(sh.getLastRow() + 1, 1, add.length, CLAIM_RATE_HEADERS.length).setValues(add);
  }
  for (var k = 0; k < fix.length; k++) {
    sh.getRange(fix[k][0], 2, 1, 2).setValues([[fix[k][1], fix[k][2]]]);
  }
  // ลบจากแถวล่างขึ้นบน เลขแถวที่เหลือจะได้ไม่เลื่อน (ทำหลัง fix/add ที่ยังอ้างเลขแถวเดิม)
  for (var m = orphan.length - 1; m >= 0; m--) sh.deleteRow(orphan[m]);
  return out;
}

// ============ API: อ่านหัวข้อ + อัตรา (ผู้ใช้ที่ล็อกอินแล้วทุกคน) ============
function apiClaimConfig(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  return {
    ok: true,
    items: readClaimItems(),
    options: appOptionsPayload(),          // ตัวเลือก dropdown (ค่าตะกั่ว / ค่าน็อคตู้ / ชุดล่วงเวลา)
    canEditRates: (s.user.role === 'admin' || s.user.role === 'manager')
  };
}

// ============ API: ปรับอัตราค่าใช้จ่ายต่อตู้ (admin/manager เท่านั้น) ============
function apiSaveClaimConfig(body) {
  var g = requireManager(body); if (g.err) return g.err;
  var items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return { ok: false, error: 'bad_request' };

  readClaimItems();                 // ให้แน่ใจว่าทุกหัวข้อมีแถวในชีตแล้วค่อยเขียนทับอัตรา
  var sh = getClaimRateSheet();
  var data = sh.getDataRange().getValues();
  var rowOf = {};
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) rowOf[String(data[i][0]).trim()] = i + 1;
  }

  for (var j = 0; j < items.length; j++) {
    var it = items[j] || {};
    var def = claimDefault(String(it.key || ''));
    if (!def || !rowOf[def.key]) continue;              // คีย์ที่ไม่รู้จัก = ไม่เขียน
    var rate = Number(it.rate) || 0; if (rate < 0) rate = 0;
    var reasons = def.key === 'special' ? parseReasons(it.reasons) : [];
    sh.getRange(rowOf[def.key], 2, 1, 4).setValues([[def.label, def.perContainer ? 'yes' : 'no', rate, JSON.stringify(reasons)]]);
  }
  return { ok: true, items: readClaimItems() };
}

// คำนวณยอดใหม่ทั้งหมดฝั่งเซิร์ฟเวอร์ ไม่เชื่อยอด/อัตราที่ส่งมาจากหน้าเว็บ
// (หัวข้อที่คิดจากจำนวนตู้ต้องใช้อัตราจากชีตเท่านั้น พนักงานปรับอัตราเองไม่ได้)
function computeClaim(lines, containers) {
  var cfg = readClaimItems();
  var opt = readAppOptions();
  var byKey = {};
  for (var i = 0; i < cfg.length; i++) byKey[cfg[i].key] = cfg[i];

  var items = [], total = 0;
  for (var j = 0; j < lines.length; j++) {
    var l = lines[j] || {};
    var c = byKey[String(l.key || '')];
    if (!c) continue;

    var item = {
      key: c.key, label: c.label, perContainer: c.perContainer,
      rate: 0, qty: 0, unit: '', amount: 0,
      note: String(l.note || '').trim().slice(0, 300),
      reasons: []
    };

    if (c.perContainer) {
      // EXTRA MOVEMENT มีจำนวนตู้ของตัวเอง (ownQty) — หัวข้ออื่นใช้จำนวนตู้ของใบเบิก
      // หัวข้อที่มีขั้นต่ำ (EXTRA MOVEMENT เริ่มที่ 2 ตู้) ใบที่ยังไม่ถึงขั้นต่ำ = คิดให้ 0 ตู้
      var qty = autoQtyFor(c.key, containers);
      if (c.ownQty) {
        var own = parseInt(l.qty, 10);                  // พนักงานกดปรับจำนวนตู้ของหัวข้อนี้เอง = ใช้ค่านั้น
        if (own > 0) qty = Math.min(own, 999);
      }
      if (!(qty > 0)) continue;                         // 0 ตู้ = ไม่มีอะไรให้คิด (เช่น ใบตู้เดียวที่ไม่คิด EXTRA MOVEMENT)
      item.rate = c.rate;
      item.qty = qty;
      item.unit = 'ตู้';
      item.amount = round2(c.rate * qty);
    } else if (c.input === 'sets') {
      // ค่าล่วงเวลา: 1 ชุด = perSet บาท (อัตราและจำนวนชุดสูงสุดตั้งที่ AppOptions — พนักงานปรับไม่ได้)
      var sets = parseInt(l.qty, 10);
      if (!(sets > 0)) sets = 0;
      if (sets > opt.overtime.maxSets) sets = opt.overtime.maxSets;
      item.rate = opt.overtime.perSet;
      item.qty = sets;
      item.unit = 'ชุด';
      item.amount = round2(sets * opt.overtime.perSet);
    } else if (c.key === 'special') {
      var rs = Array.isArray(l.reasons) ? l.reasons : [];
      var sum = 0;
      for (var k = 0; k < rs.length; k++) {
        var label = String((rs[k] && rs[k].label) || '').trim().slice(0, 120);
        if (!label) continue;
        var amt = Number(rs[k].amount) || 0; if (amt < 0) amt = 0;
        item.reasons.push({ label: label, amount: round2(amt) });
        sum += amt;
      }
      if (!item.reasons.length) continue;               // ติ๊กหัวข้อแต่ไม่ได้เลือกเหตุผล = ไม่นับ
      item.amount = round2(sum);
    } else {
      var v = Number(l.amount) || 0; if (v < 0) v = 0;
      item.amount = round2(v);
    }

    items.push(item);
    total += item.amount;
  }
  return { items: items, total: round2(total) };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// yyyy-MM-dd -> d/M/yyyy ค.ศ. เช่น 8/8/2026 (รูปแบบวันที่มาตรฐานของทั้งระบบ)
function fmtDateStr(ymd) {
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(ymd || '').trim());
  if (!m) return String(ymd || '');
  return Number(m[3]) + '/' + Number(m[2]) + '/' + Number(m[1]);
}

function fmtBaht(n) {
  var v = round2(n);
  var s = (v % 1 === 0) ? String(v) : v.toFixed(2);
  var p = s.split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return p.join('.');
}

// 1 บรรทัดต่อ 1 หัวข้อในข้อความสรุป (ใช้ทั้งข้อความเต็มและข้อความ "รายการที่เพิ่ม")
function claimItemLine(it) {
  if (it.perContainer || it.unit) {
    return it.label + ' = ' + fmtBaht(it.rate) + ' x ' + it.qty + ' ' + (it.unit || 'ตู้') + ' = ' + fmtBaht(it.amount);
  }
  return it.label + (it.note ? (' (' + it.note + ')') : '') + ' = ' + fmtBaht(it.amount);
}

// ข้อความสรุปที่เก็บลงคอลัมน์ detail ของชีต — รูปแบบเดียวกับปุ่ม "คัดลอก" ในหน้าเว็บ
function claimDetailText(rec) {
  var L = [];
  L.push('📋 สรุปยอดเบิก');
  L.push('วันที่ตรวจปล่อย: ' + fmtDateStr(rec.inspectDate));
  L.push('จำนวนตู้: ' + rec.containers + ' ตู้');
  L.push('--------------------------------');
  for (var i = 0; i < rec.items.length; i++) {
    var it = rec.items[i];
    if (it.key === 'special') {
      L.push(it.label + ' = ' + fmtBaht(it.amount));
      for (var j = 0; j < it.reasons.length; j++) {
        L.push('   - ' + it.reasons[j].label + ' = ' + fmtBaht(it.reasons[j].amount));
      }
    } else {
      L.push(claimItemLine(it));
    }
  }
  L.push('--------------------------------');
  L.push('รวมทั้งสิ้น ' + fmtBaht(rec.total) + ' บาท');
  L.push('ผู้เบิก: ' + rec.name);
  if (rec.editCount > 0) L.push('(แก้ไขครั้งที่ ' + rec.editCount + ')');
  return L.join('\n');
}

// รายการก่อนแก้ไข -> แผนที่ค้นหาเร็ว { key: { amount, reasons:{ label:amount } } }
function claimItemMap(items) {
  var map = {};
  var list = Array.isArray(items) ? items : [];
  for (var i = 0; i < list.length; i++) {
    var it = list[i] || {};
    var key = String(it.key || '');
    if (!key) continue;
    var m = { amount: Number(it.amount) || 0, reasons: {} };
    var rs = Array.isArray(it.reasons) ? it.reasons : [];
    for (var j = 0; j < rs.length; j++) {
      var lb = String((rs[j] && rs[j].label) || '').trim();
      if (lb) m.reasons[lb] = Number(rs[j].amount) || 0;
    }
    map[key] = m;
  }
  return map;
}

// ข้อความ "เฉพาะรายการที่เพิ่มขึ้น" ของการแก้ไข 1 ครั้ง (เก็บลงคอลัมน์ edit_detail_N)
// รูปแบบเดียวกับปุ่มคัดลอกในหน้าเว็บทุกตัวอักษร เพื่อให้ข้อความที่คัดจากประวัติตรงกับที่คัดตอนกดบันทึก
// ถ้าครั้งนั้นไม่มีอะไรเพิ่มขึ้นเลย (แก้ยอดลง/แก้แต่ข้อความ) จะเก็บสรุปทั้งใบให้แทน
function claimAddedDetailText(rec, prevItems) {
  var prev = claimItemMap(prevItems), L = [], added = 0, n = 0;
  for (var i = 0; i < rec.items.length; i++) {
    var it = rec.items[i], p = prev[it.key];

    if (it.key === 'special') {
      var pr = (p && p.reasons) || {}, diff = 0, lines = [];
      for (var j = 0; j < it.reasons.length; j++) {
        var lb = it.reasons[j].label, was = Number(pr[lb]) || 0, now = Number(it.reasons[j].amount) || 0;
        if (now <= was) continue;
        diff += now - was;
        lines.push('   - ' + lb + ' = ' + fmtBaht(now) + (was ? (' (เพิ่มจาก ' + fmtBaht(was) + ')') : ''));
      }
      if (!lines.length) continue;
      n++; added += diff;
      L.push(it.label + ' + ' + fmtBaht(diff));
      for (var k = 0; k < lines.length; k++) L.push(lines[k]);
      continue;
    }

    if (!p) { n++; added += it.amount; L.push(claimItemLine(it) + '  ← เพิ่มใหม่'); continue; }
    if (it.amount > p.amount) {
      n++; added += it.amount - p.amount;
      L.push(claimItemLine(it) + ' (เพิ่มจาก ' + fmtBaht(p.amount) + ' = +' + fmtBaht(it.amount - p.amount) + ')');
    }
  }

  if (!n) return claimDetailText(rec);

  var out = [];
  out.push('📋 รายการเบิกที่เพิ่ม' + (rec.editCount > 0 ? (' (แก้ไขครั้งที่ ' + rec.editCount + ')') : ''));
  out.push('วันที่ตรวจปล่อย: ' + fmtDateStr(rec.inspectDate));
  out.push('จำนวนตู้: ' + rec.containers + ' ตู้');
  out.push('--------------------------------');
  for (var m = 0; m < L.length; m++) out.push(L[m]);
  out.push('--------------------------------');
  out.push('ยอดที่เพิ่ม ' + fmtBaht(round2(added)) + ' บาท');
  out.push('ผู้เบิก: ' + rec.name);
  return out.join('\n');
}

// ============ API: บันทึก/แก้ไขใบเบิก ============
// ส่ง claim.id มาด้วย = แก้ไขใบเดิม (นับครั้งที่แก้ไขเพิ่มทีละ 1), ไม่ส่ง = สร้างใบใหม่
function apiSaveClaim(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  var user = s.user;

  var claim = body.claim || {};
  var inspectDate = String(claim.inspectDate || '').trim();
  var containers = parseInt(claim.containers, 10);
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(inspectDate)) return { ok: false, error: 'missing_inspect_date' };
  // หน้าเว็บให้เลื่อนเลือก 1–50 ตู้ ตรงนี้กันค่าที่ผิดปกติจริง ๆ (ไม่ล็อกที่ 50 เพื่อให้ใบเก่าที่มากกว่านั้นยังแก้ได้)
  if (!(containers > 0) || containers > 999) return { ok: false, error: 'invalid_containers' };

  var calc = computeClaim(Array.isArray(claim.items) ? claim.items : [], containers);
  if (!calc.items.length) return { ok: false, error: 'no_claim_items' };

  var now = new Date();
  var sh = getClaimSheet();
  var id = String(claim.id || '').trim();

  if (id) {
    var data = sh.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) !== id) continue;
      var owner = String(data[i][3] || '');
      var isOwner = owner.toLowerCase() === String(user.username).toLowerCase();
      if (!isOwner && user.role !== 'admin' && user.role !== 'manager') return { ok: false, error: 'forbidden' };

      var was = Number(data[i][8]) || 0;
      if (was >= CLAIM_MAX_EDITS) return { ok: false, error: 'claim_edit_limit', maxEdits: CLAIM_MAX_EDITS };

      var prevItems = [];
      try { prevItems = JSON.parse(data[i][9] || '[]') || []; } catch (e0) { prevItems = []; }

      var rec = {
        id: id, username: owner, name: String(data[i][4] || owner),
        inspectDate: inspectDate, containers: containers,
        total: calc.total, editCount: was + 1, items: calc.items
      };
      rec.detail = claimDetailText(rec);
      rec.detailAll = rec.detail;
      // ครั้งแรกของใบเก่าที่บันทึกไว้ก่อนมีคอลัมน์นี้ = ใช้ข้อความสรุปเดิมที่ค้างอยู่แทน (ดีกว่าปล่อยว่าง)
      rec.detailFirst = String(data[i][CLAIM_COL_DETAIL_FIRST] || '') || String(data[i][CLAIM_COL_DETAIL_ALL] || data[i][10] || '');
      rec.editDetails = [];
      for (var e = 0; e < CLAIM_MAX_EDITS; e++) rec.editDetails.push(String(data[i][CLAIM_COL_EDIT_1 + e] || ''));
      rec.editDetails[rec.editCount - 1] = claimAddedDetailText(rec, prevItems);

      var row = [
        id, data[i][1], now, rec.username, rec.name, inspectDate, containers,
        rec.total, rec.editCount, JSON.stringify(calc.items), rec.detail,
        rec.detailAll, rec.detailFirst
      ];
      for (var e2 = 0; e2 < CLAIM_MAX_EDITS; e2++) row.push(rec.editDetails[e2]);
      sh.getRange(i + 1, 1, 1, CLAIM_HEADERS.length).setValues([row]);
      rec.updated = now.toISOString();
      rec.maxEdits = CLAIM_MAX_EDITS;
      return { ok: true, mode: 'updated', record: rec };
    }
    return { ok: false, error: 'claim_not_found' };
  }

  // เบิกได้วันละ 1 ใบต่อวันที่ตรวจปล่อย — ซ้ำให้ไปแก้ใบเดิมแทน
  var dup = findClaimByDate(user.username, inspectDate);
  if (dup) return { ok: false, error: 'claim_date_exists', record: dup };

  var newRec = {
    id: 'CL' + now.getTime(), username: user.username, name: user.name,
    inspectDate: inspectDate, containers: containers,
    total: calc.total, editCount: 0, items: calc.items
  };
  newRec.detail = claimDetailText(newRec);
  newRec.detailAll = newRec.detail;
  newRec.detailFirst = newRec.detail;              // ข้อความของ "ครั้งแรก" ตรึงไว้ตั้งแต่ตอนนี้
  newRec.editDetails = ['', '', '', '', ''];
  sh.appendRow([
    newRec.id, now, now, newRec.username, newRec.name, inspectDate, containers,
    newRec.total, 0, JSON.stringify(calc.items), newRec.detail,
    newRec.detailAll, newRec.detailFirst, '', '', '', '', ''
  ]);
  newRec.created = now.toISOString();
  newRec.updated = now.toISOString();
  newRec.maxEdits = CLAIM_MAX_EDITS;
  return { ok: true, mode: 'created', record: newRec };
}

function claimRowToObj(r) {
  var items = [];
  try { items = JSON.parse(r[9] || '[]') || []; } catch (e) { items = []; }
  var detail = String(r[10] || '');
  var editDetails = [];
  for (var e = 0; e < CLAIM_MAX_EDITS; e++) editDetails.push(String(r[CLAIM_COL_EDIT_1 + e] || ''));
  var editCount = Number(r[8]) || 0;
  return {
    id: String(r[0]),
    created: r[1] ? new Date(r[1]).toISOString() : '',
    updated: r[2] ? new Date(r[2]).toISOString() : '',
    username: String(r[3] || ''),
    name: String(r[4] || ''),
    inspectDate: fmtDate(r[5]),
    containers: Number(r[6]) || 0,
    total: Number(r[7]) || 0,
    editCount: editCount,
    items: items,
    detail: detail,
    detailAll: String(r[CLAIM_COL_DETAIL_ALL] || '') || detail,
    // ใบเก่าที่ยังไม่เคยแก้ = สรุปที่มีอยู่คือของครั้งแรกอยู่แล้ว
    detailFirst: String(r[CLAIM_COL_DETAIL_FIRST] || '') || (editCount ? '' : detail),
    editDetails: editDetails,
    maxEdits: CLAIM_MAX_EDITS,
    editsLeft: Math.max(0, CLAIM_MAX_EDITS - editCount)
  };
}

function readClaims(pred, limit) {
  var sh = getClaimSheet();
  var data = sh.getDataRange().getValues();
  var out = [];
  for (var i = data.length - 1; i >= 1; i--) {     // ล่าสุดขึ้นก่อน
    var r = data[i];
    if (!r[0]) continue;
    var rec = claimRowToObj(r);
    if (pred && !pred(rec)) continue;
    out.push(rec);
    if (limit && out.length >= limit) break;
  }
  return out;
}

// หาใบเบิกของคนนี้ที่วันที่ตรวจปล่อยตรงกัน (ใช้กันเบิกซ้ำวันเดียวกัน)
function findClaimByDate(username, dateYMD) {
  var data = getClaimSheet().getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (!data[i][0]) continue;
    if (String(data[i][3]).toLowerCase() !== String(username).toLowerCase()) continue;
    if (fmtDate(data[i][5]) !== dateYMD) continue;
    return claimRowToObj(data[i]);
  }
  return null;
}

// วันที่ตรวจปล่อยที่ปิดบัญชีไปแล้วของพนักงานคนนี้
function settledDatesFor(username) {
  var data = getSettleSheet().getDataRange().getValues();
  var set = {};
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    if (String(data[i][3]).toLowerCase() !== String(username).toLowerCase()) continue;
    var d = fmtDate(data[i][5]);
    if (d) set[d] = true;
  }
  return set;
}

// ============ API: ใบเบิกของตัวเอง ============
// ใบที่ปิดบัญชีไปแล้วจะไม่ขึ้นในรายการนี้อีก (ไปดู/แก้ได้ที่ประวัติการปิดบัญชีแทน)
function apiMyClaims(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  var uname = String(s.user.username).toLowerCase();
  var settled = settledDatesFor(s.user.username);
  var rows = readClaims(function (r) {
    return r.username.toLowerCase() === uname && !settled[r.inspectDate];
  }, 100);
  return { ok: true, rows: rows, settledDates: Object.keys(settled) };
}

// ============ API: ใบเบิกทั้งหมด (admin/manager) ============
function apiListClaims(body) {
  var g = requireManager(body); if (g.err) return g.err;
  return { ok: true, rows: readClaims(null, 500) };
}

// ============ ชีตงานขนส่ง: ดึงเลข BL + จำนวนตู้ ============
// โครงสร้างชีตจริงอาจต่างกันไปในแต่ละแท็บ จึงไล่หา "แถวหัวตาราง" และจับคอลัมน์จากชื่อ (ดู TRANSPORT_ALIASES)
// แทนที่จะยึดตำแหน่งคอลัมน์ตายตัว — ถ้าจับไม่ได้ ให้ admin กดดู transportDiag เพื่อรู้ว่าชีตนั้นมีหัวอะไรบ้าง

function normHeader(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/[\s​.\-_()\[\]:/]+/g, '');
}

// หาตำแหน่งคอลัมน์: เทียบตรงตัวก่อน ถ้าไม่เจอค่อยเทียบแบบ "มีคำนี้อยู่ข้างใน" (เฉพาะคำยาว ≥ 4 กันจับมั่ว)
function findCol(headers, aliases) {
  var i, j;
  for (j = 0; j < aliases.length; j++) {
    for (i = 0; i < headers.length; i++) if (headers[i] && headers[i] === aliases[j]) return i;
  }
  for (j = 0; j < aliases.length; j++) {
    if (aliases[j].length < 4) continue;
    for (i = 0; i < headers.length; i++) if (headers[i] && headers[i].indexOf(aliases[j]) >= 0) return i;
  }
  return -1;
}

function detectTransportColumns(rows) {
  var best = null;
  var scan = Math.min(rows.length, CONFIG.TRANSPORT_HEADER_SCAN_ROWS);
  for (var i = 0; i < scan; i++) {
    var head = [];
    for (var c = 0; c < rows[i].length; c++) head.push(normHeader(rows[i][c]));
    var cols = {
      shipping:  findCol(head, TRANSPORT_ALIASES.shipping),
      transport: findCol(head, TRANSPORT_ALIASES.transport),
      bl:        findCol(head, TRANSPORT_ALIASES.bl),
      container: findCol(head, TRANSPORT_ALIASES.container),
      qty:       findCol(head, TRANSPORT_ALIASES.qty),
      port:      findCol(head, TRANSPORT_ALIASES.port),
      customer:  findCol(head, TRANSPORT_ALIASES.customer)
    };
    // ให้น้ำหนัก 3 คอลัมน์หลัก (ชิปปิ้ง/TRANSPORT/BL) มากกว่าคอลัมน์เสริม
    var score = (cols.shipping >= 0 ? 2 : 0) + (cols.transport >= 0 ? 2 : 0) + (cols.bl >= 0 ? 2 : 0) +
                (cols.container >= 0 ? 1 : 0) + (cols.qty >= 0 ? 1 : 0) +
                (cols.port >= 0 ? 1 : 0) + (cols.customer >= 0 ? 1 : 0);
    if (!best || score > best.score) best = { row: i, cols: cols, score: score, headers: rows[i] };
  }
  return best;
}

// แปลงค่าในเซลล์เป็น yyyy-MM-dd รองรับทั้งเซลล์วันที่จริง, yyyy-mm-dd, dd/mm/yyyy และปี พ.ศ.
function cellToYMD(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  var pad = function (x) { return (String(x).length < 2 ? '0' : '') + x; };
  var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(s);
  if (m) { var y1 = Number(m[1]); if (y1 > 2400) y1 -= 543; return y1 + '-' + pad(m[2]) + '-' + pad(m[3]); }
  m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/.exec(s);
  if (m) { var y2 = Number(m[3]); if (y2 > 2400) y2 -= 543; return y2 + '-' + pad(m[2]) + '-' + pad(m[1]); }
  return '';
}

function normPerson(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/[\s​.]+/g, '');
}

// ช่อง "ชิปปิ้ง" ในชีตงานขนส่งเป็นรหัสสั้น (เช่น NON / AUN / FOLK / BEST) ไม่ใช่ชื่อเต็ม
// ถ้าตั้ง shipping_code ให้พนักงานไว้ในแท็บ Users จะเทียบด้วยรหัสนั้นแบบตรงตัว (แม่นที่สุด)
// ถ้ายังไม่ได้ตั้ง ค่อยถอยไปเดาจาก username/ชื่อ แบบ "อันหนึ่งอยู่ในอีกอัน" (ยาว ≥ 3)
function personMatches(cellValue, user) {
  var v = normPerson(cellValue);
  if (!v) return false;
  var code = normPerson(user.shippingCode);
  if (code) return v === code;
  var keys = [normPerson(user.username), normPerson(user.name)];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!k) continue;
    if (v === k) return true;
    if (k.length >= 3 && v.indexOf(k) >= 0) return true;
    if (v.length >= 3 && k.indexOf(v) >= 0) return true;
  }
  return false;
}

// รายชื่อไฟล์ชีตงานขนส่งทั้งหมด (รวมค่าเดิมแบบไฟล์เดียวเข้ามาด้วย ตัดค่าว่าง/ค่าซ้ำ)
function transportSheetIds() {
  var out = [], seen = {};
  var push = function (id) {
    var v = String(id || '').trim();
    if (!v || seen[v]) return;
    seen[v] = true; out.push(v);
  };
  push(CONFIG.TRANSPORT_SHEET_ID);
  var arr = CONFIG.TRANSPORT_SHEET_IDS;
  if (Array.isArray(arr)) for (var i = 0; i < arr.length; i++) push(arr[i]);
  return out;
}

// เปิดไฟล์ชีตงานขนส่งทุกไฟล์ — ไฟล์ไหนเปิดไม่ได้ก็ข้ามไป (แต่รายงานไว้ให้เห็น) ไม่ล้มทั้งระบบ
function openTransportSheets() {
  var ids = transportSheetIds();
  if (!ids.length) return { ok: false, error: 'transport_sheet_not_set', files: [] };
  var files = [], okCount = 0, lastErr = '';
  for (var i = 0; i < ids.length; i++) {
    try {
      var ss = SpreadsheetApp.openById(ids[i]);
      files.push({ id: ids[i], name: ss.getName(), ss: ss, ok: true });
      okCount++;
    } catch (e) {
      lastErr = String(e);
      files.push({ id: ids[i], name: '(เปิดไม่ได้)', ss: null, ok: false, detail: lastErr });
    }
  }
  if (!okCount) return { ok: false, error: 'transport_sheet_unavailable', detail: lastErr, files: files };
  return { ok: true, files: files };
}

// (ของเดิม) เปิดไฟล์แรกที่ใช้ได้ — เก็บไว้เผื่อโค้ดส่วนอื่นเรียกใช้
function openTransportSheet() {
  var open = openTransportSheets();
  if (!open.ok) return { ok: false, error: open.error, detail: open.detail || '' };
  for (var i = 0; i < open.files.length; i++) if (open.files[i].ok) return { ok: true, ss: open.files[i].ss };
  return { ok: false, error: 'transport_sheet_unavailable' };
}

// ---- ลำดับการแสดงรายการ BL ในหน้าปิดบัญชี ----
// เทียบกับ "ชื่อไฟล์" ก่อน ถ้าไม่ตรงค่อยเทียบ "ชื่อแท็บ" (ไม่สนตัวพิมพ์/ช่องว่าง/คำว่า "สำเนาของ" หรือ "Copy of")
// ที่ไม่ตรงกับรายการนี้เลย จะต่อท้ายตามลำดับที่อ่านเจอ — เพิ่ม/สลับลำดับได้ที่ลิสต์นี้
var TRANSPORT_SOURCE_ORDER = ['MAESOT FREEZONE', 'TRANSIT'];

// เน้นสีกรอบของงานแต่ละที่มาในหน้าปิดบัญชี — คีย์ = ชื่อใน TRANSPORT_SOURCE_ORDER, ค่า = ชื่อสไตล์ที่หน้าเว็บรู้จัก
// ปัจจุบันหน้าเว็บรองรับ 'transit' = กรอบสีแดงอ่อน (เพิ่มสไตล์ใหม่ต้องเพิ่ม CSS ใน index.html ด้วย)
var TRANSPORT_SOURCE_STYLE = { 'TRANSIT': 'transit' };

function normSource(v) {
  return String(v == null ? '' : v).toLowerCase()
    .replace(/[\s​.\-_()\[\]:/]+/g, '')
    .replace(/สำเนาของ/g, '')
    .replace(/copyof/g, '');
}

// คืน index ของที่มาใน TRANSPORT_SOURCE_ORDER (ไม่ตรง = ท้ายสุด)
function transportPriority(fileName, tabName) {
  var i = transportSourceIndex(fileName, tabName);
  return i < 0 ? TRANSPORT_SOURCE_ORDER.length : i;
}

function transportSourceIndex(fileName, tabName) {
  var f = normSource(fileName), t = normSource(tabName);
  for (var i = 0; i < TRANSPORT_SOURCE_ORDER.length; i++) {
    var p = normSource(TRANSPORT_SOURCE_ORDER[i]);
    if (!p) continue;
    if (f.indexOf(p) >= 0) return i;
  }
  for (var j = 0; j < TRANSPORT_SOURCE_ORDER.length; j++) {
    var p2 = normSource(TRANSPORT_SOURCE_ORDER[j]);
    if (!p2) continue;
    if (t.indexOf(p2) >= 0) return j;
  }
  return -1;
}

// ชื่อที่มาที่จับได้ (เช่น 'TRANSIT') — ใช้เก็บลงใบปิดบัญชีและใช้เลือกสีกรอบ
function transportSourceName(fileName, tabName) {
  var i = transportSourceIndex(fileName, tabName);
  return i < 0 ? '' : TRANSPORT_SOURCE_ORDER[i];
}
function transportSourceStyle(sourceName) {
  return TRANSPORT_SOURCE_STYLE[String(sourceName || '')] || '';
}

// อ่านทุกแท็บของทุกไฟล์ชีตงานขนส่ง หาแถวของพนักงานคนนี้ในวันที่เลือก แล้วรวมเป็นรายการต่อ 1 เลข BL
function scanTransport(dateYMD, user) {
  var open = openTransportSheets();
  if (!open.ok) return { ok: false, error: open.error, detail: open.detail || '' };

  var groups = {}, order = [], scanned = [], totalRowsMatched = 0;
  var sheets = [];
  for (var fi = 0; fi < open.files.length; fi++) {
    var fl = open.files[fi];
    if (!fl.ok) { scanned.push({ file: fl.name, sheet: '—', used: false, reason: 'เปิดไฟล์ไม่ได้ (ยังไม่ได้แชร์สิทธิ์?)' }); continue; }
    var tabs = fl.ss.getSheets();
    for (var ti = 0; ti < tabs.length; ti++) sheets.push({ sh: tabs[ti], file: fl.name });
  }

  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s].sh, name = sh.getName(), fileName = sheets[s].file;
    var prio = transportPriority(fileName, name);
    if (sh.getLastRow() < 2 || sh.getLastColumn() < 2) { scanned.push({ file: fileName, sheet: name, used: false, reason: 'ไม่มีข้อมูล' }); continue; }

    var data = sh.getDataRange().getValues();
    var det = detectTransportColumns(data);
    if (!det || det.score < 4) { scanned.push({ file: fileName, sheet: name, used: false, reason: 'ไม่พบหัวคอลัมน์ที่ต้องใช้' }); continue; }

    var c = det.cols, matched = 0;
    // ในชีตจริง ตู้ใบที่ 2 ของ BL เดิมจะเว้นช่อง "เลข BL / ชิปเปอร์" ไว้ (เขียนแค่แถวแรกของกลุ่ม)
    // จึงต้องจำบริบทของ BL ล่าสุดไว้เติมให้แถวที่เว้นว่าง ไม่งั้นจะนับตู้ผิดและ BL หาย
    var ctx = null;
    for (var r = det.row + 1; r < data.length; r++) {
      var row = data[r];

      var blank = true;
      for (var q = 0; q < row.length; q++) {
        if (String(row[q] == null ? '' : row[q]).trim() !== '') { blank = false; break; }
      }
      if (blank) { ctx = null; continue; }        // แถวว่างทั้งแถว = จบกลุ่ม ไม่เติมข้ามไปกลุ่มถัดไป

      var bl        = c.bl >= 0 ? String(row[c.bl] == null ? '' : row[c.bl]).trim() : '';
      var shipCell  = c.shipping >= 0 ? row[c.shipping] : '';
      var dateCell  = c.transport >= 0 ? row[c.transport] : '';
      var port      = c.port >= 0 ? String(row[c.port] == null ? '' : row[c.port]).trim() : '';
      var customer  = c.customer >= 0 ? String(row[c.customer] == null ? '' : row[c.customer]).trim() : '';

      if (bl) {
        ctx = { bl: bl, shipping: shipCell, date: dateCell, port: port, customer: customer };
      } else if (ctx) {
        bl = ctx.bl;                               // แถวนี้คือตู้ถัดไปของ BL เดิม
        if (!String(shipCell == null ? '' : shipCell).trim()) shipCell = ctx.shipping;
        if (!String(dateCell == null ? '' : dateCell).trim()) dateCell = ctx.date;
        if (!port) port = ctx.port;
        if (!customer) customer = ctx.customer;
      }

      // กรองหลังเติมค่าแล้ว (ctx ต้องอัปเดตทุกแถว ไม่ว่าแถวนั้นจะเป็นของเราหรือไม่)
      if (c.shipping < 0 && c.transport < 0) continue;   // ไม่มีเงื่อนไขให้กรองเลย = ข้าม กันดึงมาทั้งชีต
      if (c.shipping >= 0 && !personMatches(shipCell, user)) continue;
      if (c.transport >= 0 && cellToYMD(dateCell) !== dateYMD) continue;

      var key = bl ? bl.toUpperCase() : ('(ไม่มีเลข BL) ' + fileName + '/' + name);
      if (!groups[key]) {
        // ลำดับ/ที่มา ยึดตามแถวแรกที่เจอ BL นี้ (BL เดียวกันที่กระจายหลายแท็บยังรวมเป็นรายการเดียวเหมือนเดิม)
        groups[key] = { bl: bl, file: fileName, sheet: name, prio: prio, seq: order.length,
                        source: transportSourceName(fileName, name),
                        port: port, customer: customer, qtySum: 0, rowCount: 0, cntrs: {} };
        order.push(key);
      }
      var g = groups[key];
      if (!g.port) g.port = port;
      if (!g.customer) g.customer = customer;

      var qn = c.qty >= 0 ? (Number(row[c.qty]) || 0) : 0;
      if (qn > 0) g.qtySum += qn;
      if (c.container >= 0) {
        var cn = String(row[c.container] == null ? '' : row[c.container]).trim().toUpperCase();
        if (cn) g.cntrs[cn] = 1;
      }
      g.rowCount++;
      matched++; totalRowsMatched++;
    }
    scanned.push({ file: fileName, sheet: name, used: true, headerRow: det.row + 1, matched: matched, order: prio });
  }

  // เรียงตามลำดับไฟล์/แท็บที่กำหนดใน TRANSPORT_SOURCE_ORDER ก่อน แล้วค่อยตามลำดับที่อ่านเจอ
  var keys = order.slice();
  keys.sort(function (a, b) {
    var ga = groups[a], gb = groups[b];
    if (ga.prio !== gb.prio) return ga.prio - gb.prio;
    return ga.seq - gb.seq;
  });

  var mode = CONFIG.TRANSPORT_COUNT_MODE || 'auto';
  var rows = [], totalContainers = 0;
  for (var i = 0; i < keys.length; i++) {
    var g2 = groups[keys[i]];
    var distinct = 0;
    for (var k in g2.cntrs) if (g2.cntrs.hasOwnProperty(k)) distinct++;
    var n;
    if (mode === 'qty') n = g2.qtySum;
    else if (mode === 'container') n = distinct;
    else if (mode === 'rows') n = g2.rowCount;
    else n = g2.qtySum > 0 ? g2.qtySum : (distinct > 0 ? distinct : g2.rowCount);   // auto
    n = Math.round(n) || 0;
    rows.push({ bl: g2.bl, port: g2.port, customer: g2.customer, containers: n,
                sheet: g2.sheet, file: g2.file,
                source: g2.source, style: transportSourceStyle(g2.source) });
    totalContainers += n;
  }

  return { ok: true, rows: rows, totalContainers: totalContainers, rowsMatched: totalRowsMatched,
           scanned: scanned, sourceOrder: TRANSPORT_SOURCE_ORDER };
}

function lookupTransport(dateYMD, user, refresh) {
  var cache = CacheService.getScriptCache();
  var key = 'bl_' + dateYMD + '_' + normPerson(user.username);
  if (!refresh) {
    var hit = cache.get(key);
    if (hit) { try { var o = JSON.parse(hit); o.cached = true; return o; } catch (e) {} }
  }
  var res = scanTransport(dateYMD, user);
  if (res.ok) { try { cache.put(key, JSON.stringify(res), CONFIG.TRANSPORT_CACHE_SECONDS); } catch (e) {} }
  return res;
}

// ============ API: ดึงเลข BL + จำนวนตู้ ของวันที่เลือก ============
function apiBlLookup(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  var date = String(body.date || '').trim();
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(date)) return { ok: false, error: 'missing_inspect_date' };

  var target = s.user;
  if (body.username && (s.user.role === 'admin' || s.user.role === 'manager')) {
    var u = findUser(String(body.username));
    if (u) target = u;
  }
  var res = lookupTransport(date, target, !!body.refresh);
  if (!res.ok) return res;
  res.date = date;
  res.shipping = target.name;
  return res;
}

// ============ API: ตรวจการเชื่อมชีตงานขนส่ง (admin/manager) ============
// ใช้ดูว่าเปิดชีตได้ไหม แต่ละแท็บจับหัวคอลัมน์อะไรได้บ้าง — เอาไว้แก้เวลาชื่อคอลัมน์ในชีตจริงไม่ตรง
function apiTransportDiag(body) {
  var g = requireManager(body); if (g.err) return g.err;
  var open = openTransportSheets();
  if (!open.ok) return { ok: false, error: open.error, detail: open.detail || '', files: [] };

  var labels = { shipping: 'ชิปปิ้ง', transport: 'TRANSPORT (วันที่)', bl: 'เลข BL', container: 'เบอร์ตู้', qty: 'จำนวนตู้', port: 'ท่า', customer: 'ชื่อลูกค้า' };
  var out = [], fileInfo = [], names = [];

  for (var f = 0; f < open.files.length; f++) {
    var fl = open.files[f];
    if (!fl.ok) {
      fileInfo.push({ id: fl.id, name: fl.name, ok: false, detail: fl.detail || '', tabs: 0 });
      out.push({ file: fl.name, sheet: '—', rows: 0, usable: false, note: 'เปิดไฟล์ไม่ได้ — ยังไม่ได้แชร์ให้บัญชีที่ Deploy?', found: {}, missing: [], headers: [] });
      continue;
    }
    var sheets = fl.ss.getSheets();
    fileInfo.push({ id: fl.id, name: fl.name, ok: true, tabs: sheets.length, order: transportPriority(fl.name, '') });
    names.push(fl.name);

    for (var i = 0; i < sheets.length; i++) {
      var sh = sheets[i];
      var info = { file: fl.name, sheet: sh.getName(), order: transportPriority(fl.name, sh.getName()),
                   rows: Math.max(0, sh.getLastRow() - 1), found: {}, missing: [], headers: [] };
      if (sh.getLastRow() < 2 || sh.getLastColumn() < 2) { info.note = 'ไม่มีข้อมูล'; out.push(info); continue; }

      var data = sh.getRange(1, 1, Math.min(sh.getLastRow(), CONFIG.TRANSPORT_HEADER_SCAN_ROWS + 5), sh.getLastColumn()).getValues();
      var det = detectTransportColumns(data);
      info.headerRow = det ? det.row + 1 : 0;
      info.score = det ? det.score : 0;
      if (det) {
        for (var h = 0; h < det.headers.length; h++) {
          var t = String(det.headers[h] == null ? '' : det.headers[h]).trim();
          if (t) info.headers.push(t);
        }
        for (var k in labels) {
          if (!labels.hasOwnProperty(k)) continue;
          if (det.cols[k] >= 0) info.found[labels[k]] = String(det.headers[det.cols[k]] || '').trim();
          else info.missing.push(labels[k]);
        }
      }
      info.usable = !!det && det.score >= 4;
      out.push(info);
    }
  }

  // เรียงผลตรวจตามลำดับที่หน้าปิดบัญชีจะแสดงจริง เพื่อให้เห็นภาพเดียวกัน
  out.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });

  return {
    ok: true,
    files: fileInfo,
    sheetIds: transportSheetIds(),
    sheetName: names.join('  +  '),
    countMode: CONFIG.TRANSPORT_COUNT_MODE,
    sourceOrder: TRANSPORT_SOURCE_ORDER,
    sheets: out
  };
}

// ============ สลิปโอนเงินคืนบริษัท (TRANSFER SLIP) ============
// ใช้เฉพาะกรณี "คงเหลือเป็นบวก" = พนักงานต้องโอนเงินคืนบริษัท → บังคับแนบสลิป + ระบบตรวจให้
//
// วิธีอ่านสลิป: อัปรูปขึ้น Drive แล้วให้ Google แปลงเป็นข้อความด้วย OCR (ภาษาไทย)
//   ⚠️ ต้องเปิด Advanced Service "Drive API" (v2) ในโปรเจกต์ Apps Script ก่อน ไม่งั้นจะอ่านสลิปไม่ได้
//      (Editor → Services → + → Drive API → เลือก v2 → Add)  ดูวิธีในไฟล์ README
//   ถอดค่า: ยอดเงิน / วันที่โอน / เลขที่รายการ (Transaction) / ชื่อธนาคาร
//   แล้วเทียบ "ยอดที่ต้องโอน" และ "วันที่โอนคืนที่พนักงานเลือก"
//
// ผลการอ่านถูกเก็บใน description ของไฟล์สลิปใน Drive — ตอนบันทึกใบปิดบัญชี เซิร์ฟเวอร์อ่านจากตรงนั้น
// แล้วคำนวณผลตรวจใหม่เองทั้งหมด ไม่เชื่อค่าที่หน้าเว็บส่งมา (กันแก้ค่าจากฝั่งผู้ใช้)

var SLIP_DESC_VERSION = 1;

var SLIP_MONTHS_TH = {
  'ม.ค': 1, 'มกราคม': 1, 'ก.พ': 2, 'กุมภาพันธ์': 2, 'มี.ค': 3, 'มีนาคม': 3,
  'เม.ย': 4, 'เมษายน': 4, 'พ.ค': 5, 'พฤษภาคม': 5, 'มิ.ย': 6, 'มิถุนายน': 6,
  'ก.ค': 7, 'กรกฎาคม': 7, 'ส.ค': 8, 'สิงหาคม': 8, 'ก.ย': 9, 'กันยายน': 9,
  'ต.ค': 10, 'ตุลาคม': 10, 'พ.ย': 11, 'พฤศจิกายน': 11, 'ธ.ค': 12, 'ธันวาคม': 12
};
var SLIP_MONTHS_EN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// ป้ายกำกับ "เลขที่รายการ" ที่พบในสลิปของธนาคารไทย (เทียบแบบตัดช่องว่าง/จุด/ทวิภาค)
var SLIP_TXN_LABELS = ['เลขที่รายการ', 'เลขรายการ', 'รหัสอ้างอิง', 'หมายเลขอ้างอิง', 'เลขที่อ้างอิง', 'เลขอ้างอิง',
  'รายการเลขที่', 'transactionid', 'transactionno', 'transaction', 'transid', 'referenceno', 'reference', 'refno', 'refid'];

// ชื่อธนาคาร/ผู้ให้บริการในไทย (ใช้แสดงให้ผู้ดูแลดูว่าเป็นสลิปของที่ไหน)
var SLIP_BANKS = [
  { re: /กสิกร|kasikorn|kbank|k\s*plus/i,                      name: 'กสิกรไทย (KBank)' },
  { re: /ไทยพาณิชย์|siam\s*commercial|scb/i,                    name: 'ไทยพาณิชย์ (SCB)' },
  { re: /กรุงเทพ|bangkok\s*bank|bualuang|bbl/i,                 name: 'กรุงเทพ (BBL)' },
  { re: /กรุงไทย|krungthai|ktb/i,                               name: 'กรุงไทย (KTB)' },
  { re: /กรุงศรี|krungsri|ayudhya|kma/i,                        name: 'กรุงศรีอยุธยา (Krungsri)' },
  { re: /ทหารไทยธนชาต|ttb|tmbthanachart|thanachart|ธนชาต/i,     name: 'ทีทีบี (ttb)' },
  { re: /ออมสิน|gsb|mymo/i,                                     name: 'ออมสิน (GSB)' },
  { re: /เพื่อการเกษตร|ธ\s*\.?\s*ก\s*\.?\s*ส|baac/i,            name: 'ธ.ก.ส. (BAAC)' },
  { re: /อาคารสงเคราะห์|ghbank|gh\s*bank|ghb/i,                 name: 'อาคารสงเคราะห์ (GHB)' },
  { re: /ซีไอเอ็มบี|cimb/i,                                     name: 'ซีไอเอ็มบี ไทย (CIMBT)' },
  { re: /ยูโอบี|uob/i,                                          name: 'ยูโอบี (UOB)' },
  { re: /แลนด์\s*แอนด์|lh\s*bank|lhfg/i,                        name: 'แลนด์ แอนด์ เฮ้าส์ (LH Bank)' },
  { re: /ทิสโก้|tisco/i,                                        name: 'ทิสโก้ (TISCO)' },
  { re: /เกียรตินาคิน|kiatnakin|kkp/i,                          name: 'เกียรตินาคินภัทร (KKP)' },
  { re: /ไอซีบีซี|icbc/i,                                       name: 'ไอซีบีซี (ไทย)' },
  { re: /อิสลาม|ibank/i,                                        name: 'อิสลามแห่งประเทศไทย (ISBT)' },
  { re: /เอสเอ็มอี|sme\s*d?\s*bank/i,                           name: 'SME D Bank' },
  { re: /เอ็กซิม|exim/i,                                        name: 'เอ็กซิมแบงก์ (EXIM)' },
  { re: /ซิตี้แบงก์|citibank/i,                                 name: 'ซิตี้แบงก์' },
  { re: /สแตนดาร์ดชาร์เตอร์ด|standard\s*chartered/i,            name: 'สแตนดาร์ดชาร์เตอร์ด' },
  { re: /มิซูโฮ|mizuho/i,                                       name: 'มิซูโฮ' },
  { re: /ซูมิโตโม|sumitomo/i,                                   name: 'ซูมิโตโม มิตซุย' },
  { re: /พร้อมเพย์|promptpay/i,                                 name: 'พร้อมเพย์ (PromptPay)' },
  { re: /ทรูมันนี่|truemoney|true\s*wallet/i,                   name: 'ทรูมันนี่ วอลเล็ท' }
];

function getSlipFolder(dateYMD) {
  return featureFolder('SLIP_FOLDER_ID', 'TransferSlips', 'slip_folder', dateYMD);
}

// สิทธิ์ที่ระบบอ่านสลิปต้องใช้ — ถ้าโปรเจกต์ล็อก oauthScopes ไว้ใน appsscript.json จะต้องเพิ่มเอง
var SLIP_SCOPES = [
  'https://www.googleapis.com/auth/documents',              // อ่านข้อความจาก Doc ที่ OCR แปลงให้ (ทางหลัก)
  'https://www.googleapis.com/auth/script.external_request' // ดาวน์โหลดข้อความจากลิงก์ export ของ Drive (ทางสำรอง)
];
var SLIP_SCOPE_HINT = 'ต้องเพิ่มสิทธิ์ให้สคริปต์ก่อน: ' + SLIP_SCOPES.join(' และ ') +
  ' — เปิด Apps Script → ⚙️ Project Settings → ติ๊ก "Show appsscript.json manifest file in editor" → ' +
  'เปิดไฟล์ appsscript.json → เพิ่ม 2 บรรทัดนี้ในลิสต์ "oauthScopes" (หรือลบทั้งบล็อก oauthScopes ออก เพื่อให้ระบบตรวจสิทธิ์เองอัตโนมัติ) → ' +
  'Save → Run ฟังก์ชัน checkSlipOcr → กด Allow → Deploy เวอร์ชันใหม่';

// อ่านข้อความจาก Google Doc ที่ได้จากการ OCR — มี 2 ทาง เผื่อโปรเจกต์ให้สิทธิ์ไม่ครบทางใดทางหนึ่ง
//   ทางหลัก : DocumentApp (ต้องมีสิทธิ์ .../auth/documents)
//   ทางสำรอง: ดึงข้อความจากลิงก์ export ของ Drive (ต้องมีสิทธิ์ .../auth/script.external_request)
function readDocText(id) {
  var errs = [];
  try { return { ok: true, text: String(DocumentApp.openById(id).getBody().getText() || '') }; }
  catch (e) { errs.push('DocumentApp: ' + e); }

  try {
    var meta = Drive.Files.get(id);
    var link = (meta && meta.exportLinks) ? (meta.exportLinks['text/plain'] || '') : '';
    if (!link) errs.push('export: ไม่มีลิงก์ text/plain');
    else {
      var res = UrlFetchApp.fetch(link, {
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      });
      if (res.getResponseCode() === 200) return { ok: true, text: String(res.getContentText() || '') };
      errs.push('export: HTTP ' + res.getResponseCode());
    }
  } catch (e2) { errs.push('export: ' + e2); }

  return { ok: false, error: errs.join(' / ') };
}

// OCR รูปเป็นข้อความด้วย Drive (แปลงเป็น Google Doc แบบ OCR แล้วอ่านข้อความ จากนั้นลบไฟล์ชั่วคราว)
// ลองส่ง 2 แบบ เพราะบางบัญชี/บางรูปแบบพารามิเตอร์ Drive v2 คืนไฟล์ที่ยังไม่ถูกแปลงเป็น Doc
function ocrImageText(blob) {
  if (typeof Drive === 'undefined' || !Drive.Files) {
    return { ok: false, error: 'slip_ocr_unavailable',
             detail: 'ยังไม่ได้เพิ่ม Advanced Service "Drive API" ในโปรเจกต์ Apps Script' };
  }
  if (!Drive.Files.insert) {
    return { ok: false, error: 'slip_ocr_unavailable',
             detail: 'Drive API ที่เพิ่มไว้เป็น v3 — OCR ใช้ได้เฉพาะ v2 (ลบออกแล้วเพิ่มใหม่โดยเลือก Version = v2)' };
  }

  // สำคัญ: ต้องส่ง mimeType เป็น "ชนิดของรูป" (หรือไม่ส่งเลย) + ใส่ convert:true ให้ Drive แปลงผลเป็น Google Doc
  // ถ้าใส่ mimeType เป็น application/vnd.google-apps.document ตรง ๆ Drive จะตอบว่า
  //   "OCR is not supported for files of type application/vnd.google-apps.document"
  // และถ้าใส่แค่ ocr:true โดยไม่มี convert:true ไฟล์ที่ได้จะยังเป็นรูป (เปิดด้วย DocumentApp ไม่ได้)
  var DOC_MIME = 'application/vnd.google-apps.document';
  var srcType = '';
  try { srcType = String(blob.getContentType() || ''); } catch (e0) {}

  var tries = [
    { res: { title: 'slip_ocr_1_' + Date.now() },                            opt: { ocr: true, convert: true, ocrLanguage: 'th' } },
    { res: { title: 'slip_ocr_2_' + Date.now(), mimeType: srcType || 'image/jpeg' }, opt: { ocr: true, convert: true, ocrLanguage: 'th' } },
    { res: { title: 'slip_ocr_3_' + Date.now() },                            opt: { ocr: true, convert: true } }
  ];

  var tmp = [], errs = [], rateHit = false;
  var isRateLimit = function (s) { return /rate\s*limit|ratelimit|limit exceeded|quota|โควตา/i.test(String(s)); };
  var insertOnce = function (t) {
    try { return { file: Drive.Files.insert(t.res, blob, t.opt) }; }
    catch (e) { return { err: String(e) }; }
  };

  try {
    for (var i = 0; i < tries.length; i++) {
      var tag = 'วิธีที่ ' + (i + 1);
      var r = insertOnce(tries[i]);

      // โควตา OCR เต็ม — พัก 2 วินาทีแล้วลองซ้ำครั้งเดียว ถ้ายังไม่ได้ก็หยุดทันที
      // (ไม่ลองวิธีอื่นต่อ เพราะเจอลิมิตเดียวกันและยิ่งเปลืองโควตา)
      if (r.err && isRateLimit(r.err)) {
        Utilities.sleep(2000);
        r = insertOnce(tries[i]);
        if (r.err && isRateLimit(r.err)) { rateHit = true; errs.push(tag + ': ' + r.err); break; }
      }
      if (r.err) { errs.push(tag + ': ' + r.err); continue; }

      var file = r.file;
      if (!file || !file.id) { errs.push(tag + ': ไม่ได้ไฟล์กลับมา'); continue; }
      tmp.push(file.id);
      if (file.mimeType && file.mimeType !== DOC_MIME) {
        errs.push(tag + ': ไฟล์ไม่ถูกแปลงเป็น Google Doc (ได้ ' + file.mimeType + ')');
        continue;
      }
      var got = readDocText(file.id);
      if (!got.ok) { errs.push(tag + ': เปิด Doc ไม่ได้ — ' + got.error); continue; }
      if (String(got.text || '').trim()) return { ok: true, text: got.text };
      errs.push(tag + ': แปลงไฟล์ได้แต่ไม่มีข้อความ (รูปอาจเบลอ/เล็กเกินไป)');
    }

    var all = errs.join(' | ');
    if (rateHit) {
      return { ok: false, error: 'slip_ocr_rate',
               detail: 'โควตาการอ่านสลิปอัตโนมัติ (OCR) ของ Google เต็มชั่วคราว — รอ 1–2 นาที แล้วกด "ลองอ่านสลิปอีกครั้ง" หรือกรอกค่าจากสลิปเองได้เลย',
               raw: all };
    }
    if (/permission|authoriz|scope|access|denied|ไม่ได้รับอนุญาต/i.test(all)) {
      return { ok: false, error: 'slip_ocr_scope', detail: all, hint: SLIP_SCOPE_HINT, scopes: SLIP_SCOPES };
    }
    if (/ไม่มีข้อความ/.test(all)) {
      return { ok: false, error: 'slip_ocr_empty',
               detail: 'OCR ทำงานแล้วแต่ไม่ได้ข้อความจากรูป — รูปอาจเล็ก/เบลอ/เอียงเกินไป (' + all + ')' };
    }
    return { ok: false, error: 'slip_ocr_failed', detail: all || 'ไม่ทราบสาเหตุ' };
  } finally {
    for (var t = 0; t < tmp.length; t++) { try { DriveApp.getFileById(tmp[t]).setTrashed(true); } catch (e2) {} }
  }
}

// สลิปใบล่าสุดในโฟลเดอร์เก็บสลิป (ไล่ทั้งโฟลเดอร์หลักและโฟลเดอร์ย่อยรายเดือน) — ใช้ทดลองอ่าน
function latestSlipFile() {
  var f = featureFolder('SLIP_FOLDER_ID', 'TransferSlips', 'slip_folder', '');
  if (!f.ok) return null;
  var root = f.folder;

  var newest = null;
  var scan = function (folder) {
    var fi = folder.getFiles();
    while (fi.hasNext()) {
      var f = fi.next();
      if (!newest || f.getLastUpdated() > newest.getLastUpdated()) newest = f;
    }
  };
  scan(root);
  var subs = root.getFolders();
  while (subs.hasNext()) scan(subs.next());
  return newest;
}

// ============ ตรวจระบบอ่านสลิป (OCR) ============
// เรียกได้ 2 ทาง: ปุ่มในหน้า admin (แท็บตั้งค่าระบบ → ตรวจสอบการเชื่อมต่อ) หรือรันฟังก์ชันนี้จาก Editor
function slipOcrStatus(fileId) {
  var out = {
    driveService: (typeof Drive !== 'undefined' && !!Drive.Files),
    v2: (typeof Drive !== 'undefined' && !!(Drive.Files && Drive.Files.insert)),
    strict: !!CONFIG.SLIP_STRICT
  };
  if (!out.driveService) {
    out.status = 'no_service';
    out.message = 'ยังไม่ได้เพิ่ม Advanced Service "Drive API" — เปิด Apps Script → Services → ＋ → Drive API → Version v2 → Add';
    return out;
  }
  if (!out.v2) {
    out.status = 'wrong_version';
    out.message = 'Drive API ที่เพิ่มไว้เป็น v3 — OCR ใช้ได้เฉพาะ v2 (ลบออกแล้วเพิ่มใหม่โดยเลือก Version = v2)';
    return out;
  }

  var file = null;
  try { file = fileId ? DriveApp.getFileById(String(fileId)) : latestSlipFile(); }
  catch (e) { out.status = 'file_error'; out.message = 'เปิดไฟล์สลิปไม่ได้: ' + e; return out; }

  if (!file) {
    out.status = 'no_slip';
    out.message = 'บริการพร้อมแล้ว แต่ยังไม่มีสลิปในระบบให้ทดลองอ่าน — ให้พนักงานแนบสลิป 1 ใบก่อน แล้วกดตรวจอีกครั้ง';
    return out;
  }
  out.file = file.getName();
  out.fileUrl = 'https://drive.google.com/file/d/' + file.getId() + '/view';

  var ocr = ocrImageText(file.getBlob());
  if (!ocr.ok) {
    out.status = (ocr.error === 'slip_ocr_scope') ? 'need_scope'
               : (ocr.error === 'slip_ocr_rate' ? 'rate_limit' : 'ocr_failed');
    out.error = ocr.error;
    out.message = ocr.detail || '';
    if (ocr.hint) out.hint = ocr.hint;
    if (ocr.scopes) out.scopes = ocr.scopes;
    return out;
  }

  var info = parseSlipText(ocr.text);
  out.status = 'ok';
  out.sample = String(ocr.text).replace(/\s+/g, ' ').trim().slice(0, 600);
  out.parsed = {
    amount: info.amount, date: info.date, txn: info.txn, bank: info.bank,
    amounts: (info.amounts || []).slice(0, 8), dates: (info.dates || []).slice(0, 5)
  };
  out.message = (info.amount && info.date && info.txn)
    ? 'อ่านสลิปได้ครบทุกค่า — ระบบพร้อมใช้งาน'
    : 'OCR อ่านข้อความได้ แต่ถอดค่าได้ไม่ครบ (ดูข้อความที่อ่านได้ด้านล่าง)';
  return out;
}

// ---- รันจาก Editor: เลือกฟังก์ชันนี้ → Run → กด Allow (ครั้งแรก) แล้วดูผลใน Execution log ----
// ไม่รับพารามิเตอร์ เพื่อให้เห็นในรายการฟังก์ชันของ Editor แน่นอน
function checkSlipOcr() {
  var out = slipOcrStatus('');
  Logger.log('Advanced Drive Service: ' + (out.driveService ? 'มี' : 'ไม่มี') + ' / รองรับ OCR (v2): ' + (out.v2 ? 'ใช่' : 'ไม่ใช่'));
  Logger.log('สถานะ: ' + out.status + ' — ' + (out.message || ''));
  if (out.hint) Logger.log('*** วิธีแก้: ' + out.hint);
  if (out.file) Logger.log('ไฟล์ที่ทดลองอ่าน: ' + out.file);
  if (out.sample) Logger.log('ข้อความที่ OCR อ่านได้:\n' + out.sample);
  if (out.parsed) {
    Logger.log('ถอดค่าได้: ยอด=' + out.parsed.amount + ' | วันที่=' + out.parsed.date +
               ' | เลขที่รายการ=' + out.parsed.txn + ' | ธนาคาร=' + out.parsed.bank);
  }
  return out;
}

// ============ API: ตรวจระบบอ่านสลิป (admin/manager) ============
function apiSlipOcrDiag(body) {
  var g = requireManager(body); if (g.err) return g.err;
  var res = slipOcrStatus(String((body && body.fileId) || ''));
  res.ok = true;
  return res;
}

// ---- ถอดค่าจากข้อความในสลิป ----
function slipCleanLabel(s) { return String(s == null ? '' : s).toLowerCase().replace(/[\s.:,_\-]/g, ''); }

// ตัวเลขที่ "หน้าตาเป็นจำนวนเงิน" ทั้งหมดในสลิป (มีจุลภาคหรือทศนิยม 2 ตำแหน่ง)
function parseSlipAmounts(text) {
  var out = [], re = /(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2})/g, m;
  while ((m = re.exec(String(text || '')))) {
    var n = Number(String(m[1]).replace(/,/g, ''));
    if (n > 0 && n < 100000000 && out.indexOf(n) < 0) out.push(n);
    if (out.length >= 40) break;
  }
  return out;
}

// ยอดเงินที่ "น่าจะเป็นยอดโอน" — ดูจากป้ายกำกับก่อน ถ้าไม่มีค่อยใช้ตัวเลขที่มากที่สุด
function parseSlipAmount(text) {
  var t = String(text || '');
  var labels = ['จำนวนเงิน', 'จำนวนเงินโอน', 'ยอดเงิน', 'ยอดโอน', 'จำนวน', 'amount', 'total'];
  var lines = t.split(/[\r\n]+/);
  for (var i = 0; i < lines.length; i++) {
    var lc = slipCleanLabel(lines[i]), hit = false;
    for (var j = 0; j < labels.length; j++) if (lc.indexOf(slipCleanLabel(labels[j])) >= 0) { hit = true; break; }
    if (!hit) continue;
    var near = parseSlipAmounts(lines[i] + ' ' + (lines[i + 1] || ''));
    if (near.length) return near[0];
  }
  var all = parseSlipAmounts(t);
  if (!all.length) return 0;
  var max = all[0];
  for (var k = 1; k < all.length; k++) if (all[k] > max) max = all[k];
  return max;
}

// วันที่ทั้งหมดที่พบในสลิป (คืนเป็น yyyy-MM-dd) — รองรับ ค.ศ./พ.ศ., ปี 2 หลัก, เดือนไทย/อังกฤษ
function parseSlipDates(text) {
  var t = String(text || ''), out = [];
  var push = function (y, mo, d) {
    y = Number(y); mo = Number(mo); d = Number(d);
    if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return false;
    if (y < 100) y = (y >= 40) ? (2500 + y - 543) : (2000 + y);   // 69 = พ.ศ.2569 → 2026, 26 = ค.ศ.2026
    else if (y > 2400) y -= 543;
    if (y < 2000 || y > 2100) return false;
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    var s = y + '-' + p(mo) + '-' + p(d);
    if (out.indexOf(s) < 0 && out.length < 20) out.push(s);
    return true;
  };
  // OCR มักติดตัวเลขเวลาต่อท้ายปี (เช่น "10 ส.ค. 69 12:04" → ปีกลายเป็น "6912")
  // จึงลองตีความปีจากค่าที่จับได้ → 4 ตัวแรก → 2 ตัวแรก ตามลำดับ
  var pushY = function (yStr, mo, d) {
    var s = String(yStr);
    if (push(s, mo, d)) return true;
    if (s.length > 4 && push(s.slice(0, 4), mo, d)) return true;
    if (s.length > 2 && push(s.slice(0, 2), mo, d)) return true;
    return false;
  };

  var m, re1 = /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/g;        // 2026-08-10
  while ((m = re1.exec(t))) push(m[1], m[2], m[3]);
  var re2 = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,6})/g;         // 10/08/2569, 10-8-69 (เผื่อเวลาต่อท้าย)
  while ((m = re2.exec(t))) pushY(m[3], m[2], m[1]);

  for (var k in SLIP_MONTHS_TH) {                                  // 10 ส.ค. 2569 / 10 สิงหาคม 69
    if (!SLIP_MONTHS_TH.hasOwnProperty(k)) continue;
    var pat = k.replace(/\./g, '\\.?');
    var reTh = new RegExp('(\\d{1,2})\\s*' + pat + '\\.?\\s*(\\d{2,6})', 'g');
    while ((m = reTh.exec(t))) pushY(m[2], SLIP_MONTHS_TH[k], m[1]);
  }

  var re3 = /(\d{1,2})\s*([A-Za-z]{3,9})\.?\s*(\d{2,6})/g;         // 10 Aug 2026
  while ((m = re3.exec(t))) {
    var mo = SLIP_MONTHS_EN[String(m[2]).toLowerCase().slice(0, 3)];
    if (mo) pushY(m[3], mo, m[1]);
  }
  return out;
}

// โทเคนที่หน้าตาเป็น "เลขที่รายการ" ในบรรทัดนั้น (ยาว ≥ 10 และมีตัวเลขเยอะ)
function pickSlipTxnToken(line) {
  var re = /[A-Za-z0-9]{10,30}/g, m, best = '';
  while ((m = re.exec(String(line || '')))) {
    var tk = m[0], digits = (tk.match(/\d/g) || []).length;
    if (digits < 6) continue;
    if (tk.length > best.length) best = tk;
  }
  return best;
}

function parseSlipTxn(text) {
  var lines = String(text || '').split(/[\r\n]+/);
  for (var i = 0; i < lines.length; i++) {
    var lc = slipCleanLabel(lines[i]), hit = false;
    for (var j = 0; j < SLIP_TXN_LABELS.length; j++) {
      if (lc.indexOf(slipCleanLabel(SLIP_TXN_LABELS[j])) >= 0) { hit = true; break; }
    }
    if (!hit) continue;
    var cand = pickSlipTxnToken(lines[i]) || pickSlipTxnToken(lines[i + 1] || '');
    if (cand) return cand;
  }
  // ไม่มีป้ายกำกับ — เอาโทเคนยาวสุดในสลิป (สลิปส่วนใหญ่พิมพ์เลขรายการยาว 12–25 ตัว)
  var best = '';
  for (var k = 0; k < lines.length; k++) {
    var t2 = pickSlipTxnToken(lines[k]);
    if (t2.length > best.length) best = t2;
  }
  return best.length >= 12 ? best : '';
}

function detectSlipBank(text) {
  var t = String(text || '');
  for (var i = 0; i < SLIP_BANKS.length; i++) if (SLIP_BANKS[i].re.test(t)) return SLIP_BANKS[i].name;
  return '';
}

// ถอดค่าทั้งหมดจากข้อความสลิป
// OCR มักแตกช่องว่างกลางคำ/กลางตัวเลข (เช่น "1 0 ส.ค. 6 9") จึงลองอ่านซ้ำจากข้อความที่ตัดช่องว่างออกด้วย
function parseSlipText(text) {
  var t = String(text || '');
  var tight = t.replace(/[ \t ​]+/g, '');    // ตัดช่องว่างในบรรทัด (คงการขึ้นบรรทัดใหม่ไว้)
  var info = { amounts: [], dates: [], amount: 0, date: '', txn: '', bank: '' };

  info.amounts = parseSlipAmounts(t);
  if (!info.amounts.length) info.amounts = parseSlipAmounts(tight);
  info.dates = parseSlipDates(t);
  if (!info.dates.length) info.dates = parseSlipDates(tight);
  info.amount = parseSlipAmount(t) || parseSlipAmount(tight);
  info.date = info.dates.length ? info.dates[0] : '';
  info.txn = parseSlipTxn(t) || parseSlipTxn(tight);
  info.bank = detectSlipBank(t) || detectSlipBank(tight);
  return info;
}

// อ่านสลิป 1 ใบ → คืนค่าที่ถอดได้ (ยังไม่เทียบกับยอด/วันที่)
function readSlip(blob) {
  var ocr = ocrImageText(blob);
  var info = { ocr: ocr.ok ? 'ok' : (ocr.error || 'slip_ocr_failed'), amounts: [], dates: [], amount: 0, date: '', txn: '', bank: '' };
  if (!ocr.ok) {
    // เอาเฉพาะใจความสั้น ๆ ไปโชว์ให้พนักงาน (รายละเอียดเต็มดูได้ที่ปุ่มตรวจระบบในหน้า admin)
    if (ocr.error === 'slip_ocr_scope') {
      info.detail = 'ระบบยังไม่ได้รับสิทธิ์อ่านไฟล์ที่ OCR แปลง — แจ้งผู้ดูแลให้กดตรวจระบบอ่านสลิปในหน้าตั้งค่าระบบ';
    } else {
      info.detail = String(ocr.detail || '').slice(0, 200);
    }
    return info;
  }
  var got = parseSlipText(ocr.text);
  info.amounts = got.amounts; info.dates = got.dates;
  info.amount = got.amount; info.date = got.date;
  info.txn = got.txn; info.bank = got.bank;
  info.sample = String(ocr.text).replace(/\s+/g, ' ').trim().slice(0, 300);   // เก็บไว้ให้ผู้ดูแลดูว่า OCR อ่านได้อะไร
  return info;
}

// เทียบค่าที่อ่านได้กับ "ยอดที่ต้องโอน" และ "วันที่โอนคืนที่เลือก"
// อ่านไม่ออกเลย = unreadable (บันทึกได้หรือไม่ ขึ้นกับ CONFIG.SLIP_STRICT)
function checkSlip(info, expectDate, expectAmount) {
  var tol = Number(CONFIG.SLIP_AMOUNT_TOLERANCE) || 0;
  var amounts = info.amounts || [], dates = info.dates || [];
  var amountOk = false, dateOk = false, i;
  for (i = 0; i < amounts.length; i++) if (Math.abs(amounts[i] - Number(expectAmount)) <= tol) { amountOk = true; break; }
  dateOk = dates.indexOf(String(expectDate || '')) >= 0;

  var readable = (info.ocr === 'ok') && (amounts.length > 0 || dates.length > 0);

  // อ่านอัตโนมัติไม่ได้ แต่พนักงานกรอกค่าจากสลิปเองแล้ว — ยังบังคับว่ายอด/วันที่ต้องตรง และต้องมีเลขที่รายการ
  if (!readable && info.manual) {
    var mAmt = Math.abs((Number(info.manual.amount) || 0) - Number(expectAmount)) <= tol;
    var mDate = String(info.manual.date || '') === String(expectDate || '');
    var mTxn = !!String(info.manual.txn || '').trim();
    if (mAmt && mDate && mTxn) {
      return { status: 'manual', label: 'กรอกค่าจากสลิปเอง — รอผู้ดูแลตรวจสลิป', amountOk: true, dateOk: true, manual: true };
    }
    return {
      status: 'mismatch', amountOk: mAmt, dateOk: mDate, manual: true,
      label: !mTxn ? 'ต้องกรอกเลขที่รายการในสลิปด้วย'
           : (!mAmt ? 'ยอดที่กรอกไม่ตรงกับยอดที่ต้องโอนคืน' : 'วันที่ที่กรอกไม่ตรงกับวันที่โอนคืนที่เลือก')
    };
  }

  var status, label;
  if (!readable) {
    status = 'unreadable';
    if (info.ocr === 'slip_ocr_unavailable') label = 'ยังไม่ได้เปิด Drive API — อ่านสลิปอัตโนมัติไม่ได้ (กรอกค่าจากสลิปเองได้)';
    else if (info.ocr === 'slip_ocr_rate') label = 'โควตาอ่านสลิปของ Google เต็มชั่วคราว — รอสักครู่แล้วกด "ลองอ่านสลิปอีกครั้ง" หรือกรอกค่าเอง';
    else if (info.ocr === 'slip_ocr_scope') label = 'ระบบอ่านสลิปยังไม่ได้รับสิทธิ์ — แจ้งผู้ดูแล (กรอกค่าจากสลิปเองได้)';
    else label = 'อ่านข้อมูลในสลิปไม่ออก (กรอกค่าจากสลิปเองได้)';
  } else if (amountOk && dateOk) {
    status = 'verified';  label = 'ตรวจอัตโนมัติผ่าน (ยอดและวันที่ตรง)';
  } else if (!amountOk && !dateOk) {
    status = 'mismatch';  label = 'ยอดเงินและวันที่ในสลิปไม่ตรงกับที่ต้องโอน';
  } else if (!amountOk) {
    status = 'mismatch';  label = 'ยอดเงินในสลิปไม่ตรงกับยอดที่ต้องโอนคืน';
  } else {
    status = 'mismatch';  label = 'วันที่ในสลิปไม่ตรงกับวันที่โอนคืนที่เลือก';
  }
  return { status: status, label: label, amountOk: amountOk, dateOk: dateOk };
}

// ============ API: อัปโหลด + ตรวจสลิป ============
// ส่ง image (base64) = อัปสลิปใหม่ / ส่งแค่ fileId = ตรวจซ้ำจากค่าที่อ่านไว้แล้ว (เช่น เปลี่ยนวันที่โอน)
function apiVerifySlip(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  var user = s.user;

  var expectDate = String(body.expectDate || '').trim();
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(expectDate)) return { ok: false, error: 'returned_date_required' };
  var expectAmount = round2(Number(body.expectAmount) || 0);
  if (!(expectAmount > 0)) return { ok: false, error: 'slip_not_required' };

  var fileId = String(body.fileId || '').trim();
  var img = String(body.image || '');
  var info = null, url = '';

  if (img) {
    var f = getSlipFolder(expectDate);
    if (!f.ok) return f;
    var file;
    try {
      var clean = img.replace(/^data:image\/\w+;base64,/, '');
      var name = expectDate + '_' + user.username + '_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HHmmss') + '.jpg';
      file = f.folder.createFile(Utilities.newBlob(Utilities.base64Decode(clean), 'image/jpeg', name));
    } catch (e) { return { ok: false, error: 'slip_save_failed', detail: String(e) }; }

    info = readSlip(file.getBlob());
    info.v = SLIP_DESC_VERSION;
    info.user = String(user.username).toLowerCase();
    info.uploaded = new Date().toISOString();
    try { file.setDescription(JSON.stringify(info)); } catch (e2) {}
    fileId = file.getId();
    url = 'https://drive.google.com/file/d/' + fileId + '/view';

    // อัปสลิปใหม่แทนใบเดิมของใบปิดบัญชีนี้ — ทิ้งไฟล์เก่าลงถังขยะ (กู้คืนได้)
    var oldId = String(body.replaceId || '').trim();
    if (oldId && oldId !== fileId) { try { DriveApp.getFileById(oldId).setTrashed(true); } catch (e3) {} }
  } else {
    if (!fileId) return { ok: false, error: 'bad_request' };
    var prev = slipInfoOf(fileId, user.username);
    if (!prev.ok) return prev;
    info = prev.info;
    url = 'https://drive.google.com/file/d/' + fileId + '/view';

    // กด "ลองอ่านสลิปอีกครั้ง" — อ่าน OCR จากไฟล์เดิมใหม่ (ใช้ตอนโควตาเต็มแล้วรอจนหายติดลิมิต)
    // ไม่ต้องอัปรูปใหม่ และเก็บค่าที่เคยกรอกเองไว้ให้
    if (body.retryOcr) {
      var again = readSlip(prev.file.getBlob());
      again.v = SLIP_DESC_VERSION;
      again.user = String(info.user || user.username).toLowerCase();
      again.uploaded = info.uploaded || new Date().toISOString();
      if (info.manual) again.manual = info.manual;
      try { prev.file.setDescription(JSON.stringify(again)); } catch (e5) {}
      info = again;
    }

    // ส่ง manual มา = พนักงานกรอกค่าจากสลิปเอง (ทำได้เฉพาะกรณีที่อ่านอัตโนมัติไม่ได้)
    if (body.manual) {
      var autoReadable = (info.ocr === 'ok') && (((info.amounts || []).length > 0) || ((info.dates || []).length > 0));
      if (autoReadable) return { ok: false, error: 'slip_manual_not_allowed' };
      var mDate = String(body.manual.date || '').trim();
      if (mDate && !/^\d{4}-\d{1,2}-\d{1,2}$/.test(mDate)) mDate = '';
      info.manual = {
        amount: round2(Number(body.manual.amount) || 0),
        date: mDate,
        txn: String(body.manual.txn || '').trim().slice(0, 60)
      };
      info.manualBy = String(user.username).toLowerCase();
      info.manualAt = new Date().toISOString();
      try { prev.file.setDescription(JSON.stringify(info)); } catch (e4) {}
    }
  }

  var chk = checkSlip(info, expectDate, expectAmount);
  var manual = info.manual || null;
  return {
    ok: true, fileId: fileId, url: url,
    amount: manual ? manual.amount : info.amount,
    date: manual ? manual.date : info.date,
    txn: manual ? manual.txn : info.txn,
    bank: info.bank,
    ocr: info.ocr, ocrDetail: info.detail || '', sample: info.sample || '',
    isManual: !!chk.manual,
    status: chk.status, label: chk.label, amountOk: chk.amountOk, dateOk: chk.dateOk,
    strict: !!CONFIG.SLIP_STRICT,
    // กรอกเองแล้วบันทึกได้ (ยอด/วันที่ต้องตรง) • อ่านไม่ออกและยังไม่กรอก = ขึ้นกับ SLIP_STRICT
    canSave: (chk.status === 'verified') || (chk.status === 'manual') ||
             (chk.status === 'unreadable' && !CONFIG.SLIP_STRICT),
    canManual: (chk.status === 'unreadable' || chk.status === 'manual')
  };
}

// อ่านผลที่เคยถอดไว้จาก description ของไฟล์สลิป (แหล่งข้อมูลที่เชื่อถือได้ฝั่งเซิร์ฟเวอร์)
function slipInfoOf(fileId, username) {
  var file;
  try { file = DriveApp.getFileById(String(fileId || '')); }
  catch (e) { return { ok: false, error: 'slip_not_found' }; }
  var info = null;
  try { info = JSON.parse(file.getDescription() || 'null'); } catch (e2) { info = null; }
  if (!info || Number(info.v) !== SLIP_DESC_VERSION) return { ok: false, error: 'slip_not_verified' };
  if (username && String(info.user || '') !== String(username).toLowerCase()) return { ok: false, error: 'forbidden' };
  return { ok: true, info: info, file: file };
}

// ============ ปิดบัญชี (SETTLEMENTS) ============
// ช่องค่าใช้จ่ายในตาราง ตามฟอร์ม "รายการปิดบัญชี (รายละเอียดการตรวจปล่อย)"
// ลำดับตามฟอร์มกระดาษ "รายการปิดบัญชี (รายละเอียดการตรวจปล่อย)"
// input: 'check'  = ติ๊กเลือก แล้วคิดยอดให้อัตโนมัติต่อ 1 รายการ BL (ค่าล่วงเวลา ใช้ AppOptions.overtime.perSet)
// input: 'select' = เลือกจำนวนเงินจาก dropdown (ตัวเลือกจาก AppOptions ตาม optionKey) + มีตัวเลือก "อื่นๆ" ให้พิมพ์เอง
// primary: true   = หัวข้อหลัก โชว์ในทุกรายการ BL เสมอ ไม่ต้องรอว่าเบิกไว้หรือกด"แสดงหัวข้อทั้งหมด"
var SETTLE_COST_COLUMNS = [
  { key: 'lift_on',        label: 'ค่า LIFT ON' },
  { key: 'lift_off',       label: 'ค่า LIFT OFF' },
  { key: 'storage',        label: 'ค่า STORAGE' },
  { key: 'extra_movement', label: 'ค่า EXTRA MOVEMENT' },
  { key: 'extra_service',  label: 'ค่าบริการเพิ่มเติม(ฟรีโซน)' },
  { key: 'extra_service_transit', label: 'ค่าบริการเพิ่มเติม(ผ่านแดน)' },
  { key: 'overtime',       label: 'ค่าล่วงเวลา (มีใบเสร็จ)', input: 'check' },
  { key: 'order_form',     label: 'ค่า ORDER FORM (ค่าธรรมเนียม)' },
  { key: 'seal',           label: 'ค่าตะกั่ว', input: 'select', optionKey: 'seal', primary: true }
];

// คอลัมน์ "ค่าบริการเพิ่มเติมพิเศษ" เป็นคอลัมน์เดียว แต่ข้างในแยกเป็นหัวข้อย่อยพร้อมจำนวนเงิน
var SETTLE_SPECIAL_LABEL = 'ค่าบริการเพิ่มเติมพิเศษ';
var SETTLE_SPECIAL_PRESETS = ['ยางเกิน', 'สำแดงเท็จ', KNOCK_LABEL];

// อัตราตั้งต้นของช่องที่คิดให้อัตโนมัติจากจำนวนตู้ (0 = ไม่คิดอัตโนมัติ ให้กรอกเอง)
// ค่าจริงเก็บในแท็บ SettleRates — admin/manager แก้ได้จากหน้า admin
// ช่องที่มีขั้นต่ำจำนวนตู้ตาม AUTO_MIN_CONTAINERS (EXTRA MOVEMENT) — BL ที่ตู้ยังไม่ถึงขั้นต่ำจะไม่คิดให้ ปล่อยว่างให้กรอกเอง
var SETTLE_AUTO_RATE_DEFAULTS = {
  lift_on: 1040,
  lift_off: 0,
  storage: 0,
  extra_movement: 530.4,
  extra_service: 500,
  extra_service_transit: 0,
  overtime: 0,
  order_form: 0,
  seal: 0
};

var SETTLE_RATE_HEADERS = ['key', 'label', 'rate'];

function getSettleRateSheet() {
  var ss = getSpreadsheet();
  var sh = ss.getSheetByName('SettleRates');
  if (!sh) { sh = ss.insertSheet('SettleRates'); }
  if (sh.getLastRow() === 0) { sh.appendRow(SETTLE_RATE_HEADERS); sh.setFrozenRows(1); }
  return sh;
}

// อ่านอัตราจากชีต + เติมแถวของช่องที่ยังไม่มี และลบแถวของช่องที่ไม่ใช้แล้ว
function readSettleRates() {
  var sh = getSettleRateSheet();
  var data = sh.getDataRange().getValues();
  var saved = {}, orphan = [];
  for (var i = 1; i < data.length; i++) {
    var k = String(data[i][0] || '').trim();
    if (!k) continue;
    if (SETTLE_AUTO_RATE_DEFAULTS[k] === undefined) { orphan.push(i + 1); continue; }
    saved[k] = Number(data[i][2]) || 0;
  }

  var out = {}, add = [];
  for (var c = 0; c < SETTLE_COST_COLUMNS.length; c++) {
    var col = SETTLE_COST_COLUMNS[c];
    if (saved[col.key] === undefined) {
      out[col.key] = Number(SETTLE_AUTO_RATE_DEFAULTS[col.key]) || 0;
      add.push([col.key, col.label, out[col.key]]);
    } else {
      out[col.key] = saved[col.key];
    }
  }
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, SETTLE_RATE_HEADERS.length).setValues(add);
  for (var m = orphan.length - 1; m >= 0; m--) sh.deleteRow(orphan[m]);
  return out;
}

// ============ API: ปรับอัตราคิดอัตโนมัติของใบปิดบัญชี (admin/manager) ============
function apiSaveSettleRates(body) {
  var g = requireManager(body); if (g.err) return g.err;
  var rates = body.rates || {};
  readSettleRates();                       // ให้ทุกช่องมีแถวในชีตก่อน
  var sh = getSettleRateSheet();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var k = String(data[i][0] || '').trim();
    if (!k || rates[k] === undefined) continue;
    var v = Number(rates[k]) || 0; if (v < 0) v = 0;
    sh.getRange(i + 1, 3).setValue(round2(v));
  }
  return { ok: true, autoRates: readSettleRates(), autoMin: AUTO_MIN_CONTAINERS };
}

// คอลัมน์ slip_* ต่อท้ายตาราง (ไม่แทรกกลาง) ชีตเดิมจึงไม่เลื่อน — เก็บข้อมูลสลิปให้ admin/manager ดูย้อนหลัง
var SETTLE_HEADERS = ['id', 'created', 'updated', 'username', 'name', 'inspect_date', 'claim_total',
  'total_expense', 'balance', 'edit_count', 'returned_date', 'company_returned_date', 'rows_json', 'detail', 'image_url',
  'slip_url', 'slip_txn', 'slip_amount', 'slip_date', 'slip_status', 'slip_bank'];

function getSettleSheet() {
  var ss = getSpreadsheet();
  var sh = ss.getSheetByName('Settlements');
  if (!sh) { sh = ss.insertSheet('Settlements'); }
  if (sh.getLastRow() === 0) { sh.appendRow(SETTLE_HEADERS); sh.setFrozenRows(1); }
  else ensureSettleColumns(sh);
  return sh;
}

// ชีตเดิมที่ยังไม่มีคอลัมน์ใหม่ (image_url / slip_*) — เติมหัวคอลัมน์ให้อัตโนมัติ ไม่ต้องรัน setupSheets ซ้ำ
function ensureSettleColumns(sh) {
  var need = SETTLE_HEADERS.length;
  if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
  var head = sh.getRange(1, 1, 1, need).getValues()[0];
  for (var i = 0; i < need; i++) {
    if (String(head[i] || '').trim() !== SETTLE_HEADERS[i]) sh.getRange(1, i + 1).setValue(SETTLE_HEADERS[i]);
  }
}

// ยอดเบิกของวันนั้น = ผลรวมใบเบิกทุกใบของพนักงานคนนี้ที่วันที่ตรวจปล่อยตรงกัน
function claimTotalFor(username, dateYMD) {
  var data = getClaimSheet().getDataRange().getValues();
  var sum = 0, n = 0;
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    if (String(data[i][3]).toLowerCase() !== String(username).toLowerCase()) continue;
    if (fmtDate(data[i][5]) !== dateYMD) continue;
    sum += Number(data[i][7]) || 0; n++;
  }
  return { total: round2(sum), count: n };
}

// ============ API: ข้อมูลตั้งต้นของหน้าปิดบัญชี ============
function apiSettleConfig(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  var uname = String(s.user.username).toLowerCase();

  // รวมใบเบิกเป็นรายวัน ให้เลือกวันที่ตรวจปล่อยจากวันที่เคยเบิกไว้
  var claims = readClaims(function (r) { return r.username.toLowerCase() === uname; }, 200);
  var byDate = {}, dates = [];
  for (var i = 0; i < claims.length; i++) {
    var d = claims[i].inspectDate;
    if (!d) continue;
    if (!byDate[d]) { byDate[d] = { date: d, claimTotal: 0, claims: 0, keys: [], _seen: {} }; dates.push(byDate[d]); }
    byDate[d].claimTotal = round2(byDate[d].claimTotal + (Number(claims[i].total) || 0));
    byDate[d].claims++;
    // หัวข้อที่เบิกไว้ของวันนั้น — หน้าปิดบัญชีเอาไปเลือกว่าจะโชว์ช่องไหนให้กรอก
    var its = claims[i].items || [];
    for (var k = 0; k < its.length; k++) {
      var key = String(its[k].key || '');
      if (key && !byDate[d]._seen[key]) { byDate[d]._seen[key] = true; byDate[d].keys.push(key); }
    }
  }
  for (var m = 0; m < dates.length; m++) delete dates[m]._seen;
  dates.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });

  // หัวข้อที่เบิกไว้ของ "ทุกวัน" — ใบที่ปิดบัญชีไปแล้วยังต้องใช้ตอนเปิดมาแก้
  var keysByDate = {};
  for (var n = 0; n < dates.length; n++) keysByDate[dates[n].date] = dates[n].keys;

  // ตัวเลือกวันที่ = เฉพาะใบเบิกที่ยังไม่ได้ปิดบัญชี
  var settled = settledDatesFor(s.user.username);
  var selectable = [];
  for (var p = 0; p < dates.length; p++) if (!settled[dates[p].date]) selectable.push(dates[p]);

  var optPayload = appOptionsPayload();
  return {
    ok: true,
    columns: SETTLE_COST_COLUMNS,
    specialLabel: SETTLE_SPECIAL_LABEL,
    specialPresets: SETTLE_SPECIAL_PRESETS,
    options: optPayload,                 // ท่า / ค่าตะกั่ว / ค่าน็อคตู้ / ค่าล่วงเวลาต่อชุด
    sourceStyles: TRANSPORT_SOURCE_STYLE, // ที่มาไหนต้องเน้นสีกรอบ (เช่น TRANSIT = แดงอ่อน)
    slipStrict: !!CONFIG.SLIP_STRICT,     // อ่านสลิปไม่ออกแล้วห้ามบันทึกหรือไม่
    autoRates: readSettleRates(),
    autoMin: AUTO_MIN_CONTAINERS,        // ช่องที่มีขั้นต่ำจำนวนตู้ (EXTRA MOVEMENT เริ่มคิดให้ที่ 2 ตู้)
    // ช่องที่คิดให้เฉพาะบางท่า — ท่าอื่นปล่อยว่างให้กรอกเอง (ตั้งรายชื่อท่าได้ที่หน้า admin)
    autoPorts: { extra_movement: optPayload.emPorts || [] },
    dates: selectable,
    keysByDate: keysByDate,
    claimDates: dates.length,           // มีใบเบิกทั้งหมดกี่วัน (ใช้แยกข้อความว่า "ยังไม่เคยเบิก" กับ "ปิดบัญชีครบแล้ว")
    canSetCompanyReturn: (s.user.role === 'admin' || s.user.role === 'manager')
  };
}

function normSettleRow(r) {
  r = r || {};
  var row = {
    port: String(r.port || '').trim().slice(0, 80),
    customer: String(r.customer || '').trim().slice(0, 150),
    bl: String(r.bl || '').trim().slice(0, 80),
    containers: Math.max(0, parseInt(r.containers, 10) || 0),
    otherDetail: String(r.otherDetail || '').trim().slice(0, 300),
    // ที่มาของงาน (เช่น TRANSIT) — เก็บไว้ให้หน้าปิดบัญชีเน้นสีกรอบได้แม้เปิดใบเดิมมาแก้
    source: String(r.source || '').trim().slice(0, 40),
    costs: {}, specials: [], total: 0
  };
  var t = 0, src = r.costs || {};
  for (var i = 0; i < SETTLE_COST_COLUMNS.length; i++) {
    var k = SETTLE_COST_COLUMNS[i].key;
    var v = Number(src[k]) || 0; if (v < 0) v = 0;
    v = round2(v); row.costs[k] = v; t += v;
  }
  // หัวข้อย่อยของค่าบริการเพิ่มเติมพิเศษ — เก็บเฉพาะที่มีชื่อและมีจำนวนเงินจริง
  var sp = Array.isArray(r.specials) ? r.specials : [];
  for (var j = 0; j < sp.length; j++) {
    var label = String((sp[j] && sp[j].label) || '').trim().slice(0, 120);
    var amt = Number(sp[j] && sp[j].amount) || 0; if (amt < 0) amt = 0;
    if (!label || !amt) continue;
    amt = round2(amt);
    row.specials.push({ label: label, amount: amt });
    t += amt;
  }
  row.total = round2(t);
  return row;
}

// ยอดรวมของคอลัมน์ "ค่าบริการเพิ่มเติมพิเศษ" ในแถวนั้น
function specialTotal(row) {
  var t = 0, sp = (row && row.specials) || [];
  for (var i = 0; i < sp.length; i++) t += Number(sp[i].amount) || 0;
  return round2(t);
}

// ข้อความสรุปของใบปิดบัญชี
// กรณี "บริษัทโอนคืนพนักงาน" (คงเหลือติดลบ) = เอาเฉพาะ **หัว + ท้าย** ไม่ต้องมีรายละเอียดแต่ละ BL
// (รูปใบปิดบัญชีที่กดสร้างยังมีรายละเอียดครบเหมือนเดิม)
function settleDetailText(rec) {
  var companyPays = (Number(rec.balance) || 0) < 0;
  var L = [];
  L.push('📕 รายการปิดบัญชี (รายละเอียดการตรวจปล่อย)');
  L.push('วันที่ตรวจปล่อย: ' + fmtDateStr(rec.inspectDate));
  L.push('ชื่อ SHIPPING: ' + rec.name);
  L.push('ยอดเบิกเงิน: ' + fmtBaht(rec.claimTotal) + ' บาท');
  if (companyPays) L.push('จำนวน ' + rec.rows.length + ' รายการ BL');
  L.push('--------------------------------');
  if (!companyPays) {
    for (var i = 0; i < rec.rows.length; i++) {
      var r = rec.rows[i];
      var head = (i + 1) + ') BL ' + (r.bl || '-');
      if (r.port) head += ' • ท่า ' + r.port;
      if (r.customer) head += ' • ' + r.customer;
      head += ' • ' + r.containers + ' ตู้';
      L.push(head);
      for (var c = 0; c < SETTLE_COST_COLUMNS.length; c++) {
        var col = SETTLE_COST_COLUMNS[c];
        var v = r.costs[col.key] || 0;
        if (v > 0) L.push('   ' + col.label + ' = ' + fmtBaht(v));
      }
      var sp = r.specials || [];
      if (sp.length) {
        L.push('   ' + SETTLE_SPECIAL_LABEL + ' = ' + fmtBaht(specialTotal(r)));
        for (var q = 0; q < sp.length; q++) L.push('      - ' + sp[q].label + ' = ' + fmtBaht(sp[q].amount));
      }
      if (r.otherDetail) L.push('   รายละเอียดค่าใช้จ่ายอื่นๆ: ' + r.otherDetail);
      L.push('   รวม = ' + fmtBaht(r.total));
    }
    L.push('--------------------------------');
  }
  L.push('รวมค่าใช้จ่าย ' + fmtBaht(rec.totalExpense) + ' บาท');
  L.push('หัก ยอดเบิก ' + fmtBaht(rec.claimTotal) + ' บาท');
  if (rec.balance >= 0) L.push('คงเหลือ ' + fmtBaht(rec.balance) + ' บาท (โอนคืนบริษัท)');
  else L.push('คงเหลือ ' + fmtBaht(-rec.balance) + ' บาท (บริษัทโอนคืนพนักงาน)');
  if (rec.returnedDate) L.push('วันที่โอนคืนบริษัท: ' + fmtDateStr(rec.returnedDate));
  if (rec.slipTxn) L.push('เลขที่รายการสลิป: ' + rec.slipTxn);
  if (rec.companyReturnedDate) L.push('วันที่บริษัทโอนคืน: ' + fmtDateStr(rec.companyReturnedDate));
  if (rec.editCount > 0) L.push('(แก้ไขครั้งที่ ' + rec.editCount + ')');
  return L.join('\n');
}

// ============ API: บันทึก/แก้ไขใบปิดบัญชี ============
function apiSaveSettlement(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  var user = s.user;
  var isBoss = (user.role === 'admin' || user.role === 'manager');

  var st = body.settlement || {};
  var inspectDate = String(st.inspectDate || '').trim();
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(inspectDate)) return { ok: false, error: 'missing_inspect_date' };

  var raw = Array.isArray(st.rows) ? st.rows : [];
  var rows = [], totalExpense = 0;
  for (var i = 0; i < raw.length; i++) {
    var row = normSettleRow(raw[i]);
    if (!row.bl && !row.total && !row.otherDetail && !row.containers) continue;   // แถวว่างล้วน = ไม่เก็บ
    rows.push(row); totalExpense += row.total;
  }
  if (!rows.length) return { ok: false, error: 'no_settle_rows' };
  totalExpense = round2(totalExpense);

  var now = new Date();
  var sh = getSettleSheet();
  var id = String(st.id || '').trim();
  var returnedDate = String(st.returnedDate || '').trim();
  if (returnedDate && !/^\d{4}-\d{1,2}-\d{1,2}$/.test(returnedDate)) returnedDate = '';
  var companyDate = String(st.companyReturnedDate || '').trim();
  if (companyDate && !/^\d{4}-\d{1,2}-\d{1,2}$/.test(companyDate)) companyDate = '';

  if (id) {
    var data = sh.getDataRange().getValues();
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][0]) !== id) continue;
      var owner = String(data[r][3] || '');
      if (owner.toLowerCase() !== String(user.username).toLowerCase() && !isBoss) return { ok: false, error: 'forbidden' };

      var ct = claimTotalFor(owner, inspectDate);
      var bal = round2(ct.total - totalExpense);
      // แก้ไขใบเดิม: ถ้าไม่ได้แนบสลิปใหม่มา ให้ใช้สลิปเดิมของใบนั้น
      var gate = settleTransferGate(bal, returnedDate, st.slip, owner, id, {
        url: String(data[r][15] || ''), txn: String(data[r][16] || ''),
        amount: Number(data[r][17]) || 0, date: fmtDate(data[r][18]),
        status: String(data[r][19] || ''), bank: String(data[r][20] || '')
      });
      if (gate.err) return gate.err;

      var rec = {
        id: id, username: owner, name: String(data[r][4] || owner),
        inspectDate: inspectDate, claimTotal: ct.total,
        rows: rows, totalExpense: totalExpense, balance: bal,
        editCount: (Number(data[r][9]) || 0) + 1,
        returnedDate: gate.returnedDate,
        // ช่อง "วันที่บริษัทโอนคืน" เป็นของพนักงานบัญชี — พนักงานทั่วไปแก้ไม่ได้ ใช้ค่าเดิมเสมอ
        companyReturnedDate: isBoss ? companyDate : fmtDate(data[r][11])
      };
      rec.slipUrl = gate.slip.url; rec.slipTxn = gate.slip.txn;
      rec.slipAmount = gate.slip.amount; rec.slipDate = gate.slip.date;
      rec.slipStatus = gate.slip.status; rec.slipBank = gate.slip.bank;
      rec.detail = settleDetailText(rec);
      rec.imageUrl = String(data[r][14] || '');
      sh.getRange(r + 1, 1, 1, SETTLE_HEADERS.length).setValues([[
        id, data[r][1], now, rec.username, rec.name, inspectDate, rec.claimTotal,
        rec.totalExpense, rec.balance, rec.editCount, rec.returnedDate, rec.companyReturnedDate,
        JSON.stringify(rows), rec.detail, rec.imageUrl,
        rec.slipUrl, rec.slipTxn, rec.slipAmount, rec.slipDate, rec.slipStatus, rec.slipBank
      ]]);
      rec.updated = now.toISOString();
      return { ok: true, mode: 'updated', record: rec };
    }
    return { ok: false, error: 'settlement_not_found' };
  }

  var ct2 = claimTotalFor(user.username, inspectDate);
  var bal2 = round2(ct2.total - totalExpense);
  var gate2 = settleTransferGate(bal2, returnedDate, st.slip, user.username, '', null);
  if (gate2.err) return gate2.err;

  var newRec = {
    id: 'ST' + now.getTime(), username: user.username, name: user.name,
    inspectDate: inspectDate, claimTotal: ct2.total,
    rows: rows, totalExpense: totalExpense, balance: bal2,
    editCount: 0, returnedDate: gate2.returnedDate,
    companyReturnedDate: isBoss ? companyDate : '',
    slipUrl: gate2.slip.url, slipTxn: gate2.slip.txn, slipAmount: gate2.slip.amount,
    slipDate: gate2.slip.date, slipStatus: gate2.slip.status, slipBank: gate2.slip.bank
  };
  newRec.detail = settleDetailText(newRec);
  newRec.imageUrl = '';
  sh.appendRow([
    newRec.id, now, now, newRec.username, newRec.name, inspectDate, newRec.claimTotal,
    newRec.totalExpense, newRec.balance, 0, newRec.returnedDate, newRec.companyReturnedDate,
    JSON.stringify(rows), newRec.detail, '',
    newRec.slipUrl, newRec.slipTxn, newRec.slipAmount, newRec.slipDate, newRec.slipStatus, newRec.slipBank
  ]);
  newRec.created = now.toISOString();
  newRec.updated = now.toISOString();
  return { ok: true, mode: 'created', record: newRec };
}

// ---- ด่านตรวจ "การโอนคืนบริษัท" ----
// คงเหลือ > 0 (พนักงานต้องโอนคืน) : ต้องมีวันที่โอนคืน + สลิปที่ตรวจแล้ว (ยอด/วันที่ตรง) + เลขรายการไม่ซ้ำใบอื่น
// คงเหลือ <= 0 (บริษัทโอนคืน/พอดี) : ไม่ต้องมีวันที่โอนคืนและไม่ต้องมีสลิป (ล้างค่าทิ้งให้เลย)
// prevSlip = สลิปเดิมของใบนั้น (ตอนแก้ไขใบเดิมโดยไม่ได้แนบสลิปใหม่)
function settleTransferGate(balance, returnedDate, slipIn, owner, selfId, prevSlip) {
  var empty = { url: '', txn: '', amount: '', date: '', status: '', bank: '' };
  if (!(balance > 0)) return { returnedDate: '', slip: empty };   // ไม่ต้องโอนคืน = ไม่เก็บวันที่/สลิป

  if (!returnedDate) return { err: { ok: false, error: 'returned_date_required' } };

  slipIn = slipIn || {};
  var fileId = String(slipIn.fileId || '').trim();

  // ไม่ได้แนบสลิปใหม่ — ใช้สลิปเดิมของใบนี้ได้ ถ้าเงื่อนไข (ยอด/วันที่) ยังตรงกับที่บันทึกใหม่
  if (!fileId) {
    if (prevSlip && prevSlip.url) {
      // มีค่ายอด/วันที่ของสลิปเดิมอยู่ (ตรวจอัตโนมัติผ่าน หรือกรอกเอง) = ต้องยังตรงกับยอด/วันที่ล่าสุด
      var hasVals = (Number(prevSlip.amount) || 0) > 0 || !!prevSlip.date;
      if (hasVals) {
        var tol0 = Number(CONFIG.SLIP_AMOUNT_TOLERANCE) || 0;
        var sameDate = String(prevSlip.date || '') === returnedDate;
        var sameAmt = Math.abs((Number(prevSlip.amount) || 0) - balance) <= tol0;
        if (!(sameDate && sameAmt)) return { err: { ok: false, error: 'slip_recheck_required' } };
      }
      return { returnedDate: returnedDate, slip: prevSlip };
    }
    return { err: { ok: false, error: 'slip_required' } };
  }

  // มีสลิปใหม่ — อ่านผลที่ถอดไว้จาก Drive แล้วตรวจใหม่เองทั้งหมด (ไม่เชื่อค่าที่หน้าเว็บส่งมา)
  var got = slipInfoOf(fileId, owner);
  if (!got.ok) return { err: got };
  var chk = checkSlip(got.info, returnedDate, balance);
  if (chk.status === 'mismatch') return { err: { ok: false, error: 'slip_mismatch', detail: chk.label } };
  if (chk.status === 'unreadable' && CONFIG.SLIP_STRICT) {
    return { err: { ok: false, error: 'slip_unreadable', detail: chk.label } };
  }

  // กรอกค่าจากสลิปเอง = ใช้ค่าที่กรอก (ผ่านการเทียบยอด/วันที่มาแล้วใน checkSlip)
  var man = chk.manual ? (got.info.manual || {}) : null;
  var txn = String((man ? man.txn : got.info.txn) || '');
  if (txn) {
    var dup = findSettlementBySlipTxn(txn, selfId);
    if (dup) return { err: { ok: false, error: 'slip_txn_duplicate', detail: 'ใช้กับใบปิดบัญชีวันที่ ' + fmtDateStr(dup.inspectDate) + ' ไปแล้ว' } };
  }

  return {
    returnedDate: returnedDate,
    slip: {
      url: 'https://drive.google.com/file/d/' + fileId + '/view',
      txn: txn,
      amount: round2(Number((man ? man.amount : got.info.amount)) || 0),
      date: String((man ? man.date : got.info.date) || ''),
      status: chk.label,
      bank: String(got.info.bank || '')
    }
  };
}

// กันใช้สลิปใบเดียวซ้ำหลายใบปิดบัญชี (ข้ามใบของตัวเองตอนแก้ไข)
function findSettlementBySlipTxn(txn, selfId) {
  var key = String(txn || '').trim().toUpperCase();
  if (!key) return null;
  var data = getSettleSheet().getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    if (selfId && String(data[i][0]) === String(selfId)) continue;
    if (String(data[i][16] || '').trim().toUpperCase() === key) {
      return { id: String(data[i][0]), inspectDate: fmtDate(data[i][5]), username: String(data[i][3] || '') };
    }
  }
  return null;
}

function settleRowToObj(r) {
  var rows = [];
  try { rows = JSON.parse(r[12] || '[]') || []; } catch (e) { rows = []; }
  return {
    id: String(r[0]),
    created: r[1] ? new Date(r[1]).toISOString() : '',
    updated: r[2] ? new Date(r[2]).toISOString() : '',
    username: String(r[3] || ''), name: String(r[4] || ''),
    inspectDate: fmtDate(r[5]),
    claimTotal: Number(r[6]) || 0,
    totalExpense: Number(r[7]) || 0,
    balance: Number(r[8]) || 0,
    editCount: Number(r[9]) || 0,
    returnedDate: fmtDate(r[10]),
    companyReturnedDate: fmtDate(r[11]),
    rows: rows,
    detail: String(r[13] || ''),
    imageUrl: String(r[14] || ''),
    slipUrl: String(r[15] || ''),
    slipTxn: String(r[16] || ''),
    slipAmount: Number(r[17]) || 0,
    slipDate: fmtDate(r[18]),
    slipStatus: String(r[19] || ''),
    slipBank: String(r[20] || '')
  };
}

function readSettlements(pred, limit) {
  var data = getSettleSheet().getDataRange().getValues();
  var out = [];
  for (var i = data.length - 1; i >= 1; i--) {
    if (!data[i][0]) continue;
    var rec = settleRowToObj(data[i]);
    if (pred && !pred(rec)) continue;
    out.push(rec);
    if (limit && out.length >= limit) break;
  }
  return out;
}

// ============ เก็บรูปใบปิดบัญชีลง Google Drive ============
// โครงสร้าง: <โฟลเดอร์หลัก>/<yyyy-MM>/<yyyy-MM-dd>_<username>.png  (1 ใบปิดบัญชี = 1 ไฟล์)
function getSettleImageFolder(dateYMD) {
  if (!CONFIG.SETTLE_IMAGE_FOLDER_ID) return { ok: false, error: 'settle_folder_not_set' };
  var root;
  try { root = DriveApp.getFolderById(CONFIG.SETTLE_IMAGE_FOLDER_ID); }
  catch (e) { return { ok: false, error: 'settle_folder_unavailable', detail: String(e) }; }

  var m = /^(\d{4})-(\d{1,2})/.exec(String(dateYMD || ''));
  var sub = m ? (m[1] + '-' + (String(m[2]).length < 2 ? '0' : '') + m[2]) : 'ไม่ระบุเดือน';
  var it = root.getFoldersByName(sub);
  var folder = it.hasNext() ? it.next() : root.createFolder(sub);
  return { ok: true, folder: folder, sub: sub };
}

function apiSaveSettleImage(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  var id = String(body.id || '').trim();
  var img = String(body.image || '');
  if (!id || !img) return { ok: false, error: 'bad_request' };

  var sh = getSettleSheet();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== id) continue;
    var owner = String(data[i][3] || '');
    var isBoss = (s.user.role === 'admin' || s.user.role === 'manager');
    if (owner.toLowerCase() !== String(s.user.username).toLowerCase() && !isBoss) return { ok: false, error: 'forbidden' };

    var date = fmtDate(data[i][5]);
    var f = getSettleImageFolder(date);
    if (!f.ok) return f;

    var name = date + '_' + owner + '.png';
    // แทนที่ไฟล์เดิมของใบนี้ (แก้ไขใบแล้วสร้างรูปใหม่ = ไฟล์เดียวเสมอ ไม่กองซ้ำ)
    try {
      var old = f.folder.getFilesByName(name);
      while (old.hasNext()) old.next().setTrashed(true);
    } catch (e) {}

    var file;
    try {
      var clean = img.replace(/^data:image\/\w+;base64,/, '');
      var blob = Utilities.newBlob(Utilities.base64Decode(clean), 'image/png', name);
      file = f.folder.createFile(blob);
    } catch (e2) {
      return { ok: false, error: 'settle_image_save_failed', detail: String(e2) };
    }

    var url = 'https://drive.google.com/file/d/' + file.getId() + '/view';
    sh.getRange(i + 1, SETTLE_HEADERS.length).setValue(url);
    return { ok: true, url: url, name: name, folder: f.sub };
  }
  return { ok: false, error: 'settlement_not_found' };
}

function apiMySettlements(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  var uname = String(s.user.username).toLowerCase();
  return { ok: true, rows: readSettlements(function (r) { return r.username.toLowerCase() === uname; }, 100) };
}

function apiListSettlements(body) {
  var g = requireManager(body); if (g.err) return g.err;
  return { ok: true, rows: readSettlements(null, 500) };
}

// ============ ส่งใบเสร็จ (RECEIPTS) ============
// เมนู "ส่งใบเสร็จ" ทำงานคล้ายเมนูเข้างาน — ถ่ายรูปสดจากกล้อง + เก็บเวลาเซิร์ฟเวอร์และตำแหน่ง
// เงื่อนไข: ต้องเลือก **วันที่ตรวจปล่อย** ก่อนถ่าย และ **1 วันที่ตรวจปล่อย = 1 รูป**
//   - ส่งซ้ำวันเดิมไม่ได้ (เซิร์ฟเวอร์กันไว้) นอกจากกด "ถ่ายใหม่แทนรูปเดิม" ซึ่งจะเขียนทับใบเดิม
//     (รูปเก่าถูกย้ายไปถังขยะ Drive กู้คืนได้) จึงเหลือรูปเดียวต่อ 1 วันที่เสมอ
//   - ไม่มีเพดานความแม่นยำของ GPS เพราะการส่งใบเสร็จไม่ใช่การลงเวลา ถ้าบล็อกเพราะ GPS ไม่แม่นจะส่งไม่ได้เลย
// คอลัมน์ inspect_date / retake_count ต่อท้ายตาราง (ไม่แทรกกลาง) แถวเดิมที่มีอยู่จึงไม่เลื่อน
var RECEIPT_HEADERS = ['id', 'server_time', 'device_time', 'username', 'name', 'note',
  'latitude', 'longitude', 'accuracy_m', 'address', 'map_link', 'photo_url', 'photo_id',
  'inspect_date', 'retake_count'];

function getReceiptSheet() {
  var ss = getSpreadsheet();
  var sh = ss.getSheetByName('Receipts');
  if (!sh) { sh = ss.insertSheet('Receipts'); }
  if (sh.getLastRow() === 0) { sh.appendRow(RECEIPT_HEADERS); sh.setFrozenRows(1); }
  else ensureReceiptColumns(sh);
  return sh;
}

// แท็บที่สร้างไว้ก่อนจะมี "วันที่ตรวจปล่อย" — เติมหัวคอลัมน์ที่ขาดให้อัตโนมัติ ไม่ต้องรัน setupSheets ซ้ำ
function ensureReceiptColumns(sh) {
  var need = RECEIPT_HEADERS.length;
  if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
  var head = sh.getRange(1, 1, 1, need).getValues()[0];
  for (var i = 0; i < need; i++) {
    if (String(head[i] || '').trim() !== RECEIPT_HEADERS[i]) sh.getRange(1, i + 1).setValue(RECEIPT_HEADERS[i]);
  }
}

// ส่งใบเสร็จได้เฉพาะพนักงานจัดส่ง (คนที่ทำใบเบิก/ปิดบัญชี) และต้องถ่ายรูปจากมือถือ
function receiptPolicy(role) {
  var r = normalizeRole(role);
  return { canSend: r === 'employee-shipping', device: 'mobile', photo: true };
}

function getReceiptFolder() {
  var f = featureFolder('RECEIPT_FOLDER_ID', 'ReceiptPhotos', 'receipt_folder', '');
  if (!f.ok) throw new Error(f.detail || 'เปิดโฟลเดอร์เก็บรูปใบเสร็จไม่ได้');
  ensureFolderShared(f.folder);
  return f.folder;
}

function receiptRowToObj(r) {
  return {
    id: String(r[0]),
    time: r[1] ? new Date(r[1]).toISOString() : '',
    deviceTime: String(r[2] || ''),
    username: String(r[3] || ''),
    name: String(r[4] || ''),
    note: String(r[5] || ''),
    lat: r[6], lng: r[7], accuracy: r[8],
    address: String(r[9] || ''),
    mapLink: String(r[10] || ''),
    photoUrl: String(r[11] || ''),
    photoId: String(r[12] || ''),
    inspectDate: fmtDate(r[13]),
    retakeCount: Number(r[14]) || 0
  };
}

// หาใบเสร็จของคนนี้ที่วันที่ตรวจปล่อยตรงกัน (ใช้กัน 1 วันที่ = 1 รูป)
function findReceiptByDate(username, dateYMD) {
  var data = getReceiptSheet().getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (!data[i][0]) continue;
    if (String(data[i][3]).toLowerCase() !== String(username).toLowerCase()) continue;
    if (fmtDate(data[i][13]) !== dateYMD) continue;
    return { row: i + 1, created: data[i][1], rec: receiptRowToObj(data[i]) };
  }
  return null;
}

// ============ API: บันทึกใบเสร็จ (ถ่ายรูปสด) ============
// ต้องมี inspectDate • ส่ง replace = true เท่านั้นจึงจะเขียนทับรูปเดิมของวันนั้นได้
function apiSaveReceipt(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  var user = s.user;

  var policy = receiptPolicy(user.role);
  if (!policy.canSend) return { ok: false, error: 'receipt_not_allowed' };
  if (isWindowsDevice(body.userAgent)) return { ok: false, error: 'mobile_required' };

  var inspectDate = String(body.inspectDate || '').trim();
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(inspectDate)) return { ok: false, error: 'missing_inspect_date' };

  var photoBase64 = String(body.photo || '');
  if (!photoBase64) return { ok: false, error: 'no_photo' };

  var lat = parseFloat(body.lat);
  var lng = parseFloat(body.lng);
  if (isNaN(lat) || isNaN(lng)) return { ok: false, error: 'no_location' };
  var accuracy = parseFloat(body.accuracy || 0) || 0;
  var note = String(body.note || '').trim().slice(0, 300);

  // 1 วันที่ตรวจปล่อย = 1 รูป — ส่งซ้ำต้องยืนยันว่าจะถ่ายใหม่แทนรูปเดิม
  var found = findReceiptByDate(user.username, inspectDate);
  var replace = (body.replace === true || body.replace === 'true');
  if (found && !replace) return { ok: false, error: 'receipt_date_exists', record: found.rec };

  var now = new Date();
  var address = reverseGeocode(lat, lng);

  // อัปโหลดรูปใหม่ให้สำเร็จก่อน แล้วค่อยทิ้งรูปเก่า (อัปไม่ผ่านก็ยังมีรูปเดิมอยู่)
  var photo;
  try {
    var folder = getReceiptFolder();
    var clean = photoBase64.replace(/^data:image\/\w+;base64,/, '');
    var name = inspectDate + '_' + user.username + '.jpg';
    var file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(clean), 'image/jpeg', name));
    photo = { id: file.getId(), url: 'https://drive.google.com/uc?export=view&id=' + file.getId() };
  } catch (e) {
    return { ok: false, error: 'receipt_photo_save_failed', detail: String(e) };
  }

  var mapLink = 'https://www.google.com/maps?q=' + lat + ',' + lng;
  var sh = getReceiptSheet();

  if (found) {
    if (found.rec.photoId) {
      try { DriveApp.getFileById(found.rec.photoId).setTrashed(true); } catch (e2) {}
    }
    var retake = found.rec.retakeCount + 1;
    sh.getRange(found.row, 1, 1, RECEIPT_HEADERS.length).setValues([[
      found.rec.id, found.created || now, String(body.deviceTime || ''), found.rec.username, found.rec.name, note,
      lat, lng, accuracy, address, mapLink, photo.url, photo.id, inspectDate, retake
    ]]);
    return {
      ok: true, mode: 'replaced',
      record: {
        id: found.rec.id, time: now.toISOString(), name: found.rec.name, note: note,
        inspectDate: inspectDate, retakeCount: retake,
        lat: lat, lng: lng, accuracy: accuracy,
        address: address, mapLink: mapLink, photoUrl: photo.url
      }
    };
  }

  var id = 'RC' + now.getTime();
  sh.appendRow([
    id, now, String(body.deviceTime || ''), user.username, user.name, note,
    lat, lng, accuracy, address, mapLink, photo.url, photo.id, inspectDate, 0
  ]);

  return {
    ok: true, mode: 'created',
    record: {
      id: id, time: now.toISOString(), name: user.name, note: note,
      inspectDate: inspectDate, retakeCount: 0,
      lat: lat, lng: lng, accuracy: accuracy,
      address: address, mapLink: mapLink, photoUrl: photo.url
    }
  };
}

function readReceipts(pred, limit) {
  var data = getReceiptSheet().getDataRange().getValues();
  var out = [];
  for (var i = data.length - 1; i >= 1; i--) {          // ล่าสุดขึ้นก่อน
    if (!data[i][0]) continue;
    var rec = receiptRowToObj(data[i]);
    if (pred && !pred(rec)) continue;
    out.push(rec);
    if (limit && out.length >= limit) break;
  }
  return out;
}

function apiMyReceipts(body) {
  var s = validateSession(body.token);
  if (!s.ok) return s;
  var uname = String(s.user.username).toLowerCase();
  return { ok: true, rows: readReceipts(function (r) { return r.username.toLowerCase() === uname; }, 60) };
}

function apiListReceipts(body) {
  var g = requireManager(body); if (g.err) return g.err;
  return { ok: true, rows: readReceipts(null, 500) };
}

// ============ SESSIONS ============
function createSession(username, device) {
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var sheet = getSheet('Sessions');
  ensureSessionsDeviceColumn(sheet);
  var expires = new Date(Date.now() + CONFIG.SESSION_HOURS * 3600 * 1000);
  sheet.appendRow([token, username, new Date(), expires, device || '']);
  return token;
}

// เผื่อชีต Sessions ถูกสร้างไว้ตั้งแต่ก่อนมีคอลัมน์ device ให้เติมหัวตารางให้อัตโนมัติ
function ensureSessionsDeviceColumn(sheet) {
  if (sheet.getLastRow() === 0) return; // ยังไม่มีหัวตารางเลย ปล่อยให้ appendRow ใส่ข้อมูลแถวแรกไปก่อน
  if (String(sheet.getRange(1, 5).getValue()).trim() === '') {
    sheet.getRange(1, 5).setValue('device');
  }
}

// การเช็คอินแต่ละครั้งจริง ๆ เรียก validateSession ซ้ำหลายรอบในเวลาไล่เลี่ยกัน (todayStatus แล้วตามด้วย checkin)
// cache ผลตรวจ token ไว้สั้น ๆ กันอ่านชีต Sessions + Users ซ้ำ ๆ ทุกครั้งที่มี request
function validateSession(token) {
  token = String(token || '');
  if (!token) return { ok: false, error: 'no_token' };

  var cache = CacheService.getScriptCache();
  var cacheKey = 'sess_' + token;
  var cachedUser = cache.get(cacheKey);
  if (cachedUser) {
    try { return { ok: true, user: JSON.parse(cachedUser) }; } catch (e) {}
  }

  var sheet = getSheet('Sessions');
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === token) {
      var expires = new Date(data[i][3]);
      if (new Date() > expires) return { ok: false, error: 'session_expired' };
      var username = String(data[i][1]);
      var u = findUser(username);
      if (!u) return { ok: false, error: 'user_not_found' };
      try { cache.put(cacheKey, JSON.stringify(u), 300); } catch (e) {} // cache 5 นาที
      return { ok: true, user: u };
    }
  }
  return { ok: false, error: 'invalid_token' };
}

function findUser(username) {
  var users = getSheet('Users');
  var data = users.getDataRange().getValues();
  var col = colMap(data[0]);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][col.username]).trim().toLowerCase() === username.toLowerCase()) {
      var role = normalizeRole(data[i][col.role]);
      return {
        username: String(data[i][col.username]).trim(),
        name: String(data[i][col.name] || username),
        role: role,
        shippingCode: col.shippingCode >= 0 ? String(data[i][col.shippingCode] || '').trim() : '',
        policy: checkinPolicy(role)
      };
    }
  }
  return null;
}

// ============ PHOTO -> DRIVE ============
function savePhoto(base64, username, when) {
  var folder = getPhotoFolder();
  var clean = base64.replace(/^data:image\/\w+;base64,/, '');
  var bytes = Utilities.base64Decode(clean);
  var name = username + '_' + Utilities.formatDate(when, Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss') + '.jpg';
  var blob = Utilities.newBlob(bytes, 'image/jpeg', name);
  var file = folder.createFile(blob);
  // ไม่เรียก setSharing() ต่อไฟล์แล้ว — โฟลเดอร์แชร์ "ใครมีลิงก์ดูได้" ไว้ครั้งเดียว (ดู ensureFolderShared)
  // ไฟล์ข้างในจะดูผ่านลิงก์ได้เลย ลดการเรียก Drive API ต่อการเช็คอิน 1 ครั้ง
  var id = file.getId();
  return { id: id, url: 'https://drive.google.com/uc?export=view&id=' + id };
}

function getPhotoFolder() {
  var folder;
  if (CONFIG.PHOTO_FOLDER_ID) {
    folder = DriveApp.getFolderById(CONFIG.PHOTO_FOLDER_ID);
  } else {
    // ไม่ได้ตั้ง ID ไว้ — ใช้ทางเดียวกับฟีเจอร์อื่น (กันกรณีไม่มีสิทธิ์ค้นหาทั้งไดรฟ์)
    var f = featureFolder('PHOTO_FOLDER_ID', 'CheckinPhotos', 'photo_folder', '');
    if (!f.ok) throw new Error(f.detail || 'เปิดโฟลเดอร์เก็บรูปเข้างานไม่ได้');
    folder = f.folder;
  }
  ensureFolderShared(folder);
  return folder;
}

// แชร์โฟลเดอร์ "ใครมีลิงก์ดูได้" แค่ครั้งแรกที่ใช้งาน แล้วจำไว้ถาวรด้วย Script Properties
// กันไม่ให้ต้องเรียก Drive API เช็ค/ตั้งสิทธิ์ซ้ำทุกครั้งที่มีคนกดเข้างาน
function ensureFolderShared(folder) {
  var props = PropertiesService.getScriptProperties();
  var key = 'folder_shared_' + folder.getId();
  if (props.getProperty(key)) return;
  try { folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  props.setProperty(key, '1');
}

// ============ REVERSE GEOCODE ============
// พนักงานมักเช็คอินจากสถานที่เดิมซ้ำ ๆ (ไซต์งาน/สำนักงาน) จึง cache ผลลัพธ์ตามพิกัด (ปัดเศษ ~11 ม.)
// ไว้ 6 ชม. (ค่าสูงสุดของ CacheService) — ตำแหน่งซ้ำเดิมจะไม่ต้องยิง Maps API ใหม่ทุกครั้ง ซึ่งเป็นส่วนที่ช้าที่สุดของการเช็คอิน
function reverseGeocode(lat, lng) {
  var cache = CacheService.getScriptCache();
  var key = 'geo_' + lat.toFixed(4) + ',' + lng.toFixed(4);
  var cached = cache.get(key);
  if (cached) return cached;

  var address = lat.toFixed(6) + ', ' + lng.toFixed(6);
  try {
    var geocoder = Maps.newGeocoder().setLanguage('th');
    var resp = geocoder.reverseGeocode(lat, lng);
    if (resp.results && resp.results.length > 0) {
      address = resp.results[0].formatted_address;
    }
  } catch (err) {
    // เผื่อ Maps service ไม่พร้อม — ใช้พิกัดดิบแทน
  }

  try { cache.put(key, address, 21600); } catch (e) {}
  return address;
}

// ============ โฟลเดอร์เก็บไฟล์ใน Drive (ใช้ร่วมกันหลายฟีเจอร์) ============
// สำคัญ: หลีกเลี่ยง DriveApp.getFoldersByName (ค้นหาทั้งไดรฟ์) เพราะต้องใช้สิทธิ์กว้าง
// (drive / drive.readonly) บางโปรเจกต์ที่อนุญาตสิทธิ์ไว้แบบแคบจะเรียกไม่ได้และขึ้น
// "คุณไม่ได้รับอนุญาตให้เรียกใช้ DriveApp.getFoldersByName"
// จึงยึด "โฟลเดอร์จาก ID ที่ตั้งไว้ในคอนฟิก" เป็นหลัก แล้วสร้างโฟลเดอร์ย่อยข้างในเอง

function subFolderOf(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

// โฟลเดอร์ย่อยรายเดือน (2026-08) ใต้โฟลเดอร์ที่ให้มา
function monthFolderOf(root, dateYMD) {
  var m = /^(\d{4})-(\d{1,2})/.exec(String(dateYMD || ''));
  var sub = m ? (m[1] + '-' + (String(m[2]).length < 2 ? '0' : '') + m[2]) : 'ไม่ระบุเดือน';
  return { ok: true, folder: subFolderOf(root, sub), sub: sub };
}

// โฟลเดอร์เก็บไฟล์ของฟีเจอร์หนึ่ง ๆ ตามลำดับความพยายาม:
//   1) ใช้ ID ที่ตั้งไว้ของฟีเจอร์นั้นตรง ๆ
//   2) ไม่ได้ตั้งไว้ = สร้างโฟลเดอร์ย่อยชื่อ <name> ใต้โฟลเดอร์อื่นที่ตั้ง ID ไว้แล้ว (ไม่ต้องใช้สิทธิ์ค้นหาทั้งไดรฟ์)
//   3) ไม่มี ID ไหนตั้งไว้เลย ค่อยถอยไปค้นหาชื่อโฟลเดอร์ใน Drive (ต้องมีสิทธิ์กว้าง)
// dateYMD ใส่มา = แยกโฟลเดอร์ย่อยรายเดือนให้อีกชั้น
function featureFolder(ownKey, name, errPrefix, dateYMD) {
  var own = String(CONFIG[ownKey] || '').trim();
  var notes = [];

  if (own) {
    try {
      var f0 = DriveApp.getFolderById(own);
      return dateYMD ? monthFolderOf(f0, dateYMD) : { ok: true, folder: f0, sub: '' };
    } catch (e0) { notes.push('ID ที่ตั้งไว้เปิดไม่ได้: ' + e0); }
  }

  // ใช้โฟลเดอร์อื่นที่ตั้ง ID ไว้แล้วเป็นที่อยู่ (โฟลเดอร์เหล่านี้ใช้งานได้อยู่แล้วในระบบ)
  var hosts = ['SETTLE_IMAGE_FOLDER_ID', 'PHOTO_FOLDER_ID', 'RECEIPT_FOLDER_ID', 'SLIP_FOLDER_ID'];
  for (var i = 0; i < hosts.length; i++) {
    if (hosts[i] === ownKey) continue;
    var hid = String(CONFIG[hosts[i]] || '').trim();
    if (!hid) continue;
    try {
      var host = DriveApp.getFolderById(hid);
      var base = subFolderOf(host, name);
      return dateYMD ? monthFolderOf(base, dateYMD) : { ok: true, folder: base, sub: '' };
    } catch (e1) { notes.push(hosts[i] + ': ' + e1); }
  }

  // ทางสุดท้าย: ค้นหาชื่อโฟลเดอร์ใน Drive (ต้องมีสิทธิ์ drive / drive.readonly)
  try {
    var it = DriveApp.getFoldersByName(name);
    var root = it.hasNext() ? it.next() : DriveApp.createFolder(name);
    return dateYMD ? monthFolderOf(root, dateYMD) : { ok: true, folder: root, sub: '' };
  } catch (e2) {
    notes.push('ค้นหาชื่อโฟลเดอร์ไม่ได้: ' + e2);
    return {
      ok: false, error: errPrefix + '_unavailable',
      detail: notes.join(' | ') + ' — วิธีแก้ที่เร็วที่สุด: ใส่ ID โฟลเดอร์ Drive ที่ต้องการลงใน CONFIG.' + ownKey
    };
  }
}

// ============ HELPERS ============
function getSpreadsheet() {
  if (CONFIG.SHEET_ID) return SpreadsheetApp.openById(CONFIG.SHEET_ID);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet(name) {
  var ss = getSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); }
  return sh;
}

function colMap(head) {
  var m = {};
  for (var i = 0; i < head.length; i++) {
    m[String(head[i]).trim().toLowerCase()] = i;
  }
  return {
    username: pick(m, ['username', 'user', 'id', 'employee_id']),
    password: pick(m, ['password', 'pass', 'pwd']),
    name: pick(m, ['name', 'fullname', 'ชื่อ']),
    role: pick(m, ['role', 'type']),
    active: pick(m, ['active', 'status', 'enabled']),
    // รหัสที่ใช้ในช่อง "ชิปปิ้ง" ของชีตงานขนส่ง (ไม่มีคอลัมน์นี้ก็ยังใช้งานระบบเดิมได้ทุกอย่าง)
    shippingCode: pick(m, ['shipping_code', 'shippingcode', 'shipping', 'ชิปปิ้ง', 'ชื่อชิปปิ้ง', 'รหัสชิปปิ้ง'])
  };
}

// เพิ่มคอลัมน์ shipping_code ให้แท็บ Users ถ้ายังไม่มี แล้วคืนตำแหน่งคอลัมน์ (index เริ่มที่ 0)
function ensureUsersShippingColumn(sh) {
  var lastCol = Math.max(1, sh.getLastColumn());
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var m = colMap(head);
  if (m.shippingCode >= 0) return m.shippingCode;
  sh.getRange(1, lastCol + 1).setValue('shipping_code');
  return lastCol;
}
function pick(m, keys) {
  for (var i = 0; i < keys.length; i++) { if (m[keys[i]] !== undefined) return m[keys[i]]; }
  return -1;
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============ SETUP (รันครั้งเดียว) ============
function setupSheets() {
  var ss = getSpreadsheet();

  var users = ss.getSheetByName('Users') || ss.insertSheet('Users');
  if (users.getLastRow() === 0) {
    users.appendRow(['username', 'password', 'name', 'role', 'active']);
    users.appendRow(['admin', '1234', 'ผู้ดูแลระบบ', 'admin', 'yes']);
    users.appendRow(['mgr01', '2222', 'สมหญิง บริหาร', 'manager', 'yes']);
    users.appendRow(['emp01', '1111', 'สมชาย ใจดี', 'employee-shipping', 'yes']);
    users.appendRow(['emp02', '3333', 'สมศรี ตั้งใจ', 'employee-office', 'yes']);
    users.setFrozenRows(1);
  }

  var checkins = ss.getSheetByName('CheckIns') || ss.insertSheet('CheckIns');
  if (checkins.getLastRow() === 0) {
    checkins.appendRow([
      'id', 'server_time', 'device_time', 'username', 'name', 'type',
      'latitude', 'longitude', 'accuracy_m', 'address', 'map_link', 'photo_url', 'photo_id'
    ]);
    checkins.setFrozenRows(1);
  }

  var sessions = ss.getSheetByName('Sessions') || ss.insertSheet('Sessions');
  if (sessions.getLastRow() === 0) {
    sessions.appendRow(['token', 'username', 'created', 'expires', 'device']);
    sessions.setFrozenRows(1);
  } else {
    ensureSessionsDeviceColumn(sessions); // ชีตเก่าที่เคยตั้งค่าไว้แล้ว ไม่มีคอลัมน์ device
  }

  getLeaveSheet();   // สร้างแท็บ Leaves พร้อมหัวตาราง
  getClaimSheet();   // แท็บ Claims (ใบเบิก)
  readClaimItems();  // แท็บ ClaimRates + เติมหัวข้อค่าใช้จ่ายทั้งหมด (อัตราเริ่มต้น 0 ให้ admin ตั้งเอง)
  getSettleSheet();  // แท็บ Settlements (ใบปิดบัญชี)
  readSettleRates(); // แท็บ SettleRates + อัตราคิดอัตโนมัติตั้งต้น
  readAppOptions();  // แท็บ AppOptions (ท่า / ค่าตะกั่ว / ค่าน็อคตู้ / ค่าล่วงเวลา)
  getReceiptSheet(); // แท็บ Receipts (ใบเสร็จที่พนักงานถ่ายส่ง)

  Logger.log('Setup done: Users, CheckIns, Sessions, Leaves, Claims, ClaimRates, Settlements, SettleRates, AppOptions, Receipts พร้อมใช้งาน');
}

// เครื่องมือช่วยเพิ่มผู้ใช้ (จะพิมพ์ในชีตเองก็ได้)
// role: admin | manager | employee-office | employee-shipping
function addUser(username, password, name, role) {
  getSheet('Users').appendRow([username, password, name || username, normalizeRole(role), 'yes']);
}
