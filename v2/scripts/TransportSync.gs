/**
 * ติดสคริปต์นี้ไว้ใน "ชีตงานขนส่ง" แต่ละไฟล์ แล้วมันจะยิงข้อมูลเข้า Supabase ให้ทันทีที่มีคนแก้
 * (ไฟล์นี้อยู่ใน repo เพื่อเก็บเป็นต้นฉบับ — ตัวที่ทำงานจริงคือสำเนาที่วางในชีต)
 *
 * ติดตั้ง: ดู v2/TRANSPORT-SYNC.md
 *
 * ตรรกะแยกคอลัมน์/เติมค่า BL ที่เว้นว่าง คัดลอกมาจาก scanTransport ใน Code.gs ให้ตรงกัน
 * ต่างกันตรงที่ไม่กรองด้วยพนักงาน/วันที่ — ส่งทั้งแท็บขึ้นไป แล้วให้ v2 ค้นเอาจาก Postgres
 */

// ============ CONFIG ============
var SYNC = {
  // URL ของ v2 บน Vercel (ลงท้ายด้วย /api)
  API_URL: 'https://<โดเมนของคุณ>.vercel.app/api',

  // ต้องตรงกับ TRANSPORT_SYNC_TOKEN ที่ตั้งไว้ใน Vercel
  TOKEN: '<วางค่า TRANSPORT_SYNC_TOKEN ตรงนี้>',

  // กันยิงรัวตอนคนพิมพ์ติด ๆ กัน — รอให้หยุดพิมพ์กี่วินาทีก่อนค่อยส่ง
  DEBOUNCE_SECONDS: 15,

  // แท็บที่ไม่ต้อง sync (ชื่อตรงตัว) เช่น ['สรุป', 'Note']
  SKIP_SHEETS: []
};

// ชื่อหัวคอลัมน์ที่ยอมรับ — ชุดเดียวกับ TRANSPORT_ALIASES ใน Code.gs
var ALIASES = {
  shipping:  ['ชิปปิ้ง', 'ชิบปิ้ง', 'ชิปปิ่ง', 'ชื่อชิปปิ้ง', 'ชื่อshipping', 'shipping', 'shippingname', 'พนักงานชิปปิ้ง'],
  transport: ['transport', 'วันที่transport', 'วันtransport', 'transportdate', 'วันที่ตรวจปล่อย', 'วันตรวจปล่อย'],
  bl:        ['เลขbl', 'bl', 'blno', 'blnumber', 'เลขที่bl', 'hbl', 'mbl', 'housebl'],
  container: ['containerno', 'เบอร์ตู้', 'หมายเลขตู้', 'เลขตู้', 'container', 'containernumber', 'cntrno', 'ตู้'],
  qty:       ['จำนวนตู้', 'จำนวน', 'จน.ตู้', 'qty', 'quantity'],
  port:      ['ท่า', 'ท่าเรือ', 'ท่าส่งออก', 'port', 'terminal'],
  customer:  ['ชื่อลูกค้า', 'ลูกค้า', 'ชิปเปอร์', 'ชิพเปอร์', 'shipper', 'customer', 'customername', 'consignee', 'ชื่อผู้นำเข้า']
};

var SOURCE_ORDER = ['MAESOT FREEZONE', 'TRANSIT'];
var HEADER_SCAN_ROWS = 15;

// ============ ตัวจัดการ trigger ============

/** รันครั้งเดียวหลังวางสคริปต์ — ติด trigger ทั้งตอนแก้เซลล์และตอนแก้จากที่อื่น */
function setupSync() {
  var ss = SpreadsheetApp.getActive();
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) ScriptApp.deleteTrigger(existing[i]);

  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('onSheetChange').forSpreadsheet(ss).onChange().create();
  // ตัวยิงจริง — onEdit สร้าง trigger เองไม่ได้ (สิทธิ์จำกัด) จึงต้องมีตัวนี้เดินรอเก็บคิว
  ScriptApp.newTrigger('flushQueue').timeBased().everyMinutes(1).create();
  // กันกรณี trigger พลาด (แก้จากมือถือบางรุ่น / สคริปต์อื่นเขียนทับ) — กวาดใหม่ทุกชั่วโมง
  ScriptApp.newTrigger('syncAllSheets').timeBased().everyHours(1).create();

  syncAllSheets();
  SpreadsheetApp.getActive().toast('ติดตั้ง sync เรียบร้อย', 'SHIPME', 5);
}

/** คนแก้เซลล์ — จดว่าแท็บไหนเปลี่ยน แล้วรอให้หยุดพิมพ์ก่อนค่อยยิง */
function onSheetEdit(e) {
  if (!e || !e.range) return;
  queueSheet(e.range.getSheet().getName());
}

/**
 * แถวถูกเพิ่ม/ลบ หรือแท็บถูกเพิ่ม/ลบ — onEdit ไม่จับกรณีพวกนี้
 * onChange ได้สิทธิ์เต็มกว่า onEdit แต่ก็ไม่รับประกัน จึงไม่เรียก syncAllSheets ตรง ๆ
 * (ถ้าล้มกลางทางแท็บอื่นจะไม่ได้ยิง) — จดคิวไว้ให้ flushQueue เก็บเหมือนกันทุกกรณี
 */
function onSheetChange(e) {
  var type = e && e.changeType ? String(e.changeType) : '';
  var ss = SpreadsheetApp.getActive();
  if (type === 'REMOVE_GRID' || type === 'INSERT_GRID') {
    // แท็บหาย/เพิ่ม ต้องกวาดทั้งไฟล์เพื่อให้ pruneTransport ลบแท็บที่ไม่มีแล้วออกจาก Supabase
    var sheets = ss.getSheets();
    for (var i = 0; i < sheets.length; i++) queueSheet(sheets[i].getName());
    PropertiesService.getDocumentProperties().setProperty('needPrune', '1');
    return;
  }
  var sheet = ss.getActiveSheet();
  if (sheet) queueSheet(sheet.getName());
}

/**
 * จดว่าแท็บไหนเปลี่ยน แล้วปล่อยให้ flushQueue (trigger รายนาที) มาเก็บทีหลัง
 *
 * ห้ามสร้าง trigger จากในนี้เด็ดขาด — onEdit ทำงานด้วยสิทธิ์จำกัด (AuthMode.LIMITED)
 * เรียก ScriptApp.newTrigger() แล้วจะโยน exception ทันที ทำให้ทั้งฟังก์ชันตายก่อนได้ยิงข้อมูล
 * (บั๊กเดิมเป็นแบบนั้น: sync ทำงานเฉพาะตอนกด Run เองเท่านั้น)
 * PropertiesService ใช้ได้ใน LIMITED จึงเหลือแค่จดคิวไว้อย่างเดียว
 */
function queueSheet(name) {
  if (!name) return;
  var props = PropertiesService.getDocumentProperties();
  var pending = {};
  try { pending = JSON.parse(props.getProperty('pending') || '{}'); } catch (err) { pending = {}; }
  pending[name] = Date.now();
  props.setProperty('pending', JSON.stringify(pending));
}

/**
 * trigger รายนาที — ยิงเฉพาะแท็บที่ "หยุดแก้แล้วอย่างน้อย DEBOUNCE_SECONDS วินาที"
 * แท็บที่ยังพิมพ์อยู่จะรอรอบหน้า กันยิงรัวระหว่างคนกำลังพิมพ์ติด ๆ กัน
 */
function flushQueue() {
  var props = PropertiesService.getDocumentProperties();
  var pending = {};
  try { pending = JSON.parse(props.getProperty('pending') || '{}'); } catch (err) { pending = {}; }

  var ss = SpreadsheetApp.getActive();
  var now = Date.now();
  var stillWaiting = {};
  var sent = 0;

  for (var name in pending) {
    if (!pending.hasOwnProperty(name)) continue;
    var changedAt = Number(pending[name]) || 0;
    if (now - changedAt < SYNC.DEBOUNCE_SECONDS * 1000) { stillWaiting[name] = changedAt; continue; }
    var sheet = ss.getSheetByName(name);
    if (sheet) { pushSheet(sheet); sent++; }
  }

  // เขียนคิวที่เหลือกลับ (เฉพาะตอนมีการเปลี่ยนแปลง กัน write ทุกนาทีโดยเปล่าประโยชน์)
  if (sent > 0) {
    var keys = Object.keys(stillWaiting);
    if (keys.length) props.setProperty('pending', JSON.stringify(stillWaiting));
    else props.deleteProperty('pending');

    // มีแท็บถูกเพิ่ม/ลบ — บอก v2 ว่าตอนนี้เหลือแท็บอะไรบ้าง จะได้ลบแท็บที่หายไปออก
    if (props.getProperty('needPrune') && !keys.length) {
      props.deleteProperty('needPrune');
      var names = [];
      var all = ss.getSheets();
      for (var j = 0; j < all.length; j++) {
        if (SYNC.SKIP_SHEETS.indexOf(all[j].getName()) < 0) names.push(all[j].getName());
      }
      if (names.length) call({ action: 'pruneTransport', token: SYNC.TOKEN, sourceFile: ss.getName(), sheets: names });
    }
  }
}

/** กวาดทุกแท็บในไฟล์นี้ แล้วบอก v2 ว่าเหลือแท็บอะไรบ้าง (แท็บที่ถูกลบจะได้หายไปด้วย) */
function syncAllSheets() {
  var ss = SpreadsheetApp.getActive();
  var sheets = ss.getSheets();
  var names = [];
  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName();
    if (SYNC.SKIP_SHEETS.indexOf(name) >= 0) continue;
    names.push(name);
    pushSheet(sheets[i]);
  }
  if (names.length) {
    call({ action: 'pruneTransport', token: SYNC.TOKEN, sourceFile: ss.getName(), sheets: names });
  }
}

// ============ อ่านชีต → ยิงขึ้น v2 ============

function pushSheet(sheet) {
  var ss = SpreadsheetApp.getActive();
  var fileName = ss.getName();
  var sheetName = sheet.getName();
  if (SYNC.SKIP_SHEETS.indexOf(sheetName) >= 0) return;

  var rows = readSheetRows(sheet);
  return call({
    action: 'syncTransport',
    token: SYNC.TOKEN,
    sourceFile: fileName,
    sourceSheet: sheetName,
    sourceName: sourceNameOf(fileName, sheetName),
    rows: rows
  });
}

function readSheetRows(sheet) {
  if (sheet.getLastRow() < 2 || sheet.getLastColumn() < 2) return [];
  var data = sheet.getDataRange().getValues();
  var detected = detectColumns(data);
  if (!detected || detected.score < 4) return [];

  var c = detected.cols;
  var out = [];
  // ตู้ใบที่ 2 ของ BL เดิมเว้นช่อง BL/ชิปเปอร์ไว้ ต้องจำบริบทมาเติม ไม่งั้นตู้หายและ BL ขาด
  var ctx = null;

  for (var r = detected.row + 1; r < data.length; r++) {
    var row = data[r];

    var blank = true;
    for (var q = 0; q < row.length; q++) {
      if (String(row[q] == null ? '' : row[q]).trim() !== '') { blank = false; break; }
    }
    if (blank) { ctx = null; continue; }

    var bl       = c.bl >= 0 ? String(row[c.bl] == null ? '' : row[c.bl]).trim() : '';
    var shipCell = c.shipping >= 0 ? row[c.shipping] : '';
    var dateCell = c.transport >= 0 ? row[c.transport] : '';
    var port     = c.port >= 0 ? String(row[c.port] == null ? '' : row[c.port]).trim() : '';
    var customer = c.customer >= 0 ? String(row[c.customer] == null ? '' : row[c.customer]).trim() : '';

    if (bl) {
      ctx = { bl: bl, shipping: shipCell, date: dateCell, port: port, customer: customer };
    } else if (ctx) {
      bl = ctx.bl;
      if (!String(shipCell == null ? '' : shipCell).trim()) shipCell = ctx.shipping;
      if (!String(dateCell == null ? '' : dateCell).trim()) dateCell = ctx.date;
      if (!port) port = ctx.port;
      if (!customer) customer = ctx.customer;
    }

    var ymd = cellToYMD(dateCell);
    if (!ymd) continue;                       // ไม่มีวันที่ตรวจปล่อย = หน้าปิดบัญชีค้นไม่เจออยู่ดี

    out.push({
      transportDate: ymd,
      shipping: String(shipCell == null ? '' : shipCell).trim(),
      bl: bl,
      containerNo: c.container >= 0 ? String(row[c.container] == null ? '' : row[c.container]).trim() : '',
      quantity: c.qty >= 0 ? (Number(row[c.qty]) || 0) : 0,
      port: port,
      customer: customer
    });
  }
  return out;
}

// ============ helper (ชุดเดียวกับ Code.gs) ============

function normHeader(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/[\s​.\-_()\[\]:/]+/g, '');
}

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

function detectColumns(rows) {
  var best = null;
  var scan = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (var i = 0; i < scan; i++) {
    var head = [];
    for (var c = 0; c < rows[i].length; c++) head.push(normHeader(rows[i][c]));
    var cols = {
      shipping:  findCol(head, ALIASES.shipping),
      transport: findCol(head, ALIASES.transport),
      bl:        findCol(head, ALIASES.bl),
      container: findCol(head, ALIASES.container),
      qty:       findCol(head, ALIASES.qty),
      port:      findCol(head, ALIASES.port),
      customer:  findCol(head, ALIASES.customer)
    };
    var score = (cols.shipping >= 0 ? 2 : 0) + (cols.transport >= 0 ? 2 : 0) + (cols.bl >= 0 ? 2 : 0) +
                (cols.container >= 0 ? 1 : 0) + (cols.qty >= 0 ? 1 : 0) +
                (cols.port >= 0 ? 1 : 0) + (cols.customer >= 0 ? 1 : 0);
    if (!best || score > best.score) best = { row: i, cols: cols, score: score };
  }
  return best;
}

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

function normSource(v) {
  return String(v == null ? '' : v).toLowerCase()
    .replace(/[\s​.\-_()\[\]:/]+/g, '')
    .replace(/สำเนาของ/g, '')
    .replace(/copyof/g, '');
}

function sourceNameOf(fileName, tabName) {
  var f = normSource(fileName), t = normSource(tabName);
  for (var i = 0; i < SOURCE_ORDER.length; i++) {
    if (f.indexOf(normSource(SOURCE_ORDER[i])) >= 0) return SOURCE_ORDER[i];
  }
  for (var j = 0; j < SOURCE_ORDER.length; j++) {
    if (t.indexOf(normSource(SOURCE_ORDER[j])) >= 0) return SOURCE_ORDER[j];
  }
  return '';
}

function call(payload) {
  try {
    var response = UrlFetchApp.fetch(SYNC.API_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var body = String(response.getContentText() || '');
    if (response.getResponseCode() !== 200 || body.indexOf('"ok":true') < 0) {
      console.error('sync ไม่ผ่าน: ' + response.getResponseCode() + ' ' + body.slice(0, 300));
    }
    return body;
  } catch (err) {
    // ยิงไม่ออก (เน็ต/โดเมนเปลี่ยน) — ไม่ให้ล้มจนคนแก้ชีตไม่ได้ รอบกวาดรายชั่วโมงจะตามเก็บให้
    console.error('sync error: ' + err);
    return '';
  }
}

/** กดรันเองเพื่อทดสอบว่าตั้งค่าถูก — ดูผลใน Executions */
function testSync() {
  var sheet = SpreadsheetApp.getActive().getSheets()[0];
  console.log('แท็บ: ' + sheet.getName() + ' อ่านได้ ' + readSheetRows(sheet).length + ' แถว');
  console.log(pushSheet(sheet));
}
