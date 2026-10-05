/**
 * รายงานรายได้ชิปปิ้ง — แยกตามชื่อชิปปิ้งในชีตงานขนส่ง (MAESOT FREEZONE + TRANSIT)
 *
 * เงื่อนไขเหมือนค่าบริการเพิ่มเติมในใบแจ้งหนี้ค่าบริการ ต่างกันที่
 *   - ค่านายตรวจนับทุกงานทั้ง 2 ตาราง (ไม่ใช่เฉพาะ RORO)
 *   - ไม่นับค่าบริการ พรบ.
 * คำนวณที่เซิร์ฟเวอร์ (shipping-income.ts) หน้านี้แสดงผล เพิ่มรายการเอง และส่งออก
 * PDF = "ใบสรุปค่าใช้จ่ายเพิ่มเติม" คนละชุดต่อชิปปิ้ง ตามแบบฟอร์มของฝ่ายบัญชี
 *
 * ใช้ $, api, state, esc, downloadCSV จากสคริปต์หลักของ admin.html (เรียกตอนเปิดแท็บ)
 */
var incState = { ready:false, data:null, filter:'', manual:{}, fullName:{} };

function incMoney(n){ return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
/** ยอดในใบสรุป: จำนวนเต็มไม่มีทศนิยม (1,500) แบบเอกสารเดิม มีเศษสตางค์ค่อยแสดง 2 ตำแหน่ง */
function incAmountText(n){
  var v = Math.round((Number(n)||0)*100)/100;
  return v % 1 ? incMoney(v) : v.toLocaleString('en-US');
}
function incYmd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function incDmy(ymd){ return String(ymd||'').split('-').reverse().join('/'); }
/** หัวคอลัมน์ให้สั้นลง ตารางสรุปจะได้ไม่ล้นจอ */
function incShort(label){ return String(label).replace('ค่าบริการนายตรวจ','นายตรวจ').replace('ค่าน๊อคประตูออกจากท่า','ค่าน๊อคประตู'); }
function incWho(g){ return g.name && g.name.toUpperCase() !== g.shipping ? g.shipping+' ('+g.name+')' : g.shipping; }
function incManual(g){ return incState.manual[g.shipping] || (incState.manual[g.shipping] = []); }
function incManualValid(g){ return incManual(g).filter(function(m){ return String(m.bl||'').trim() && Number(m.amount) > 0; }); }
function incTotal(g){
  return Math.round((g.total + incManualValid(g).reduce(function(s, m){ return s+Number(m.amount); }, 0))*100)/100;
}

function initShippingIncome(){
  if(incState.ready) return;
  incState.ready = true;
  // ค่าเริ่มต้น: ครึ่งเดือนล่าสุดที่จบไปแล้ว เหมือนแท็บใบแจ้งหนี้ค่าบริการ / ใบหัก ณ ที่จ่าย
  var now = new Date(), y = now.getFullYear(), m = now.getMonth();
  $('inc-from').value = incYmd(now.getDate() > 15 ? new Date(y, m, 1) : new Date(y, m-1, 16));
  $('inc-to').value = incYmd(now.getDate() > 15 ? new Date(y, m, 15) : new Date(y, m, 0));
  $('inc-from').addEventListener('change', function(){
    if(this.value && (!$('inc-to').value || $('inc-to').value < this.value)) $('inc-to').value = this.value;
  });
  $('inc-load').addEventListener('click', incLoad);
  $('inc-filter').addEventListener('change', function(){ incState.filter = this.value; incRenderDetail(); });
  $('inc-csv').addEventListener('click', incExport);
  $('inc-pdf-all').addEventListener('click', function(){
    var groups = incState.data ? incState.data.groups : [];
    incOpenPdf(groups.map(incDocument), 'ใบสรุปค่าใช้จ่ายเพิ่มเติม-ทุกคน');
  });
}

function incLoad(){
  var from = $('inc-from').value, to = $('inc-to').value;
  if(!from || !to){ $('inc-msg').textContent = 'เลือกช่วงวันที่ตรวจปล่อยก่อน'; return; }
  $('inc-msg').textContent = 'กำลังดึงข้อมูลจากชีตงานขนส่ง…';
  $('inc-load').disabled = true;
  api({ action:'shippingIncomeData', token:state.token, from:from, to:to }).then(function(res){
    $('inc-load').disabled = false;
    if(!res.ok){ $('inc-msg').textContent = 'ดึงข้อมูลไม่สำเร็จ: '+res.error; return; }
    incState.data = res;
    incState.filter = '';
    // ดึงช่วงใหม่ = รายการที่เพิ่มเองของช่วงเดิมไม่เกี่ยวแล้ว (ชื่อในเอกสารที่แก้ไว้เก็บไว้ใช้ต่อ)
    incState.manual = {};
    $('inc-filter').innerHTML = '<option value="">ทุกคน</option>' + res.groups.map(function(g){
      return '<option value="'+esc(g.shipping)+'">'+esc(incWho(g))+'</option>';
    }).join('');
    $('inc-msg').textContent = 'วันที่ตรวจปล่อย '+incDmy(res.from)+' - '+incDmy(res.to)+' • '
      + res.groups.length+' คน • รวม '+incMoney(res.total)+' บาท';
    $('inc-result').classList.toggle('hidden', !res.groups.length);
    if(!res.groups.length) $('inc-msg').textContent += ' — ไม่พบรายการในช่วงนี้';
    incRenderSummary(); incRenderDetail();
  }).catch(function(){
    $('inc-load').disabled = false;
    $('inc-msg').textContent = 'ดึงข้อมูลไม่สำเร็จ ตรวจสอบอินเทอร์เน็ต';
  });
}

/** ตารางสรุป: แถว = ชิปปิ้ง, คอลัมน์ = หัวข้อรายได้ (+ คอลัมน์ "เพิ่มเอง" ถ้ามี) */
function incRenderSummary(){
  var d = incState.data, labels = d.labels;
  var hasManual = d.groups.some(function(g){ return incManualValid(g).length; });
  $('inc-sum-head').innerHTML = '<tr><th>ชิปปิ้ง</th><th class="num">รายการ</th>'
    + labels.map(function(l){ return '<th class="num">'+esc(incShort(l))+'</th>'; }).join('')
    + (hasManual ? '<th class="num">เพิ่มเอง</th>' : '') + '<th class="num">รวม</th></tr>';
  var colTotal = {}, manualTotal = 0, grand = 0, count = 0;
  var rows = d.groups.map(function(g){
    labels.forEach(function(l){ colTotal[l] = (colTotal[l]||0) + (g.byLabel[l]||0); });
    var manual = incManualValid(g), mSum = manual.reduce(function(s, m){ return s+Number(m.amount); }, 0);
    manualTotal += mSum; grand += incTotal(g); count += g.lines.length + manual.length;
    return '<tr><td><b>'+esc(incWho(g))+'</b></td><td class="num">'+(g.lines.length+manual.length)+'</td>'
      + labels.map(function(l){ return '<td class="num">'+(g.byLabel[l] ? incMoney(g.byLabel[l]) : '<span class="muted">—</span>')+'</td>'; }).join('')
      + (hasManual ? '<td class="num">'+(mSum ? incMoney(mSum) : '<span class="muted">—</span>')+'</td>' : '')
      + '<td class="num"><b>'+incMoney(incTotal(g))+'</b></td></tr>';
  });
  rows.push('<tr style="background:#f1f5f9"><td><b>รวม</b></td><td class="num"><b>'+count+'</b></td>'
    + labels.map(function(l){ return '<td class="num"><b>'+incMoney(colTotal[l])+'</b></td>'; }).join('')
    + (hasManual ? '<td class="num"><b>'+incMoney(manualTotal)+'</b></td>' : '')
    + '<td class="num"><b>'+incMoney(grand)+'</b></td></tr>');
  $('inc-sum-body').innerHTML = rows.join('');
}

/** รายละเอียดแยกตามชิปปิ้ง — ชื่อในเอกสาร, รายการจากชีต, รายการเพิ่มเอง, ปุ่ม PDF ของคนนั้น */
function incRenderDetail(){
  var groups = incState.data.groups.filter(function(g){ return !incState.filter || g.shipping === incState.filter; });
  $('inc-detail').innerHTML = groups.map(function(g){
    var rows = g.lines.map(function(l, i){
      return '<tr><td class="num">'+(i+1)+'</td><td>'+esc(incDmy(l.date))+'<div class="sub">'+esc(l.source)+'</div></td>'
        + '<td class="mono">'+esc(l.bl)+'</td><td>'+esc(l.label)+'</td><td class="num">'+incMoney(l.amount)+'</td><td></td></tr>';
    }).join('');
    var manual = incManual(g).map(function(m, i){
      var attr = ' data-s="'+esc(g.shipping)+'" data-i="'+i+'"';
      return '<tr style="background:#fffbeb"><td class="num">+</td><td class="muted">เพิ่มเอง</td>'
        + '<td><input type="text" class="inc-m mono" data-k="bl"'+attr+' value="'+esc(m.bl)+'" placeholder="BL" style="width:100%"></td>'
        + '<td><input type="text" class="inc-m" data-k="note"'+attr+' value="'+esc(m.note)+'" placeholder="หมายเหตุ" style="width:100%"></td>'
        + '<td class="num"><input type="number" class="inc-m" data-k="amount"'+attr+' value="'+(m.amount||'')+'" step="0.01" min="0" style="width:100px;text-align:right"></td>'
        + '<td><button class="btn btn-ghost btn-sm inc-m-del"'+attr+'>ลบ</button></td></tr>';
    }).join('');
    var s = esc(g.shipping);
    var fullName = incState.fullName[g.shipping] != null ? incState.fullName[g.shipping] : (g.fullName || g.name || g.shipping);
    return '<details open style="margin-bottom:16px"><summary style="cursor:pointer;padding:8px 2px;font-size:15px">'
      + '<b>'+esc(incWho(g))+'</b> <span class="muted">— '+(g.lines.length+incManualValid(g).length)+' รายการ • รวม</span> <b class="inc-gt" data-s="'+s+'">'+incMoney(incTotal(g))+'</b> บาท</summary>'
      + '<div class="toolbar" style="margin:4px 0 8px">'
      + '<label style="display:flex;align-items:center;gap:6px">ชื่อในเอกสาร <input type="text" class="inc-name" data-s="'+s+'" value="'+esc(fullName)+'" style="width:240px"></label>'
      + '<span class="grow"></span>'
      + '<button class="btn btn-ghost btn-sm inc-m-add" data-s="'+s+'">+ เพิ่มรายการ</button>'
      + '<button class="btn btn-primary btn-sm inc-pdf" data-s="'+s+'">📄 PDF</button></div>'
      + '<div class="tablewrap"><table class="inv-tbl"><thead><tr><th class="num">#</th><th>วันที่ตรวจปล่อย</th><th>BL</th><th>รายการ</th><th class="num">ยอด</th><th></th></tr></thead>'
      + '<tbody>'+rows+manual+'<tr style="background:#f1f5f9"><td colspan="4"><b>รวม '+s+'</b></td><td class="num"><b class="inc-gt" data-s="'+s+'">'+incMoney(incTotal(g))+'</b></td><td></td></tr></tbody></table></div></details>';
  }).join('');
  incBindDetail();
}

function incGroup(shipping){
  return incState.data.groups.filter(function(g){ return g.shipping === shipping; })[0];
}
function incBindDetail(){
  var root = $('inc-detail');
  Array.prototype.forEach.call(root.querySelectorAll('.inc-name'), function(input){
    input.addEventListener('input', function(){ incState.fullName[input.getAttribute('data-s')] = input.value; });
  });
  Array.prototype.forEach.call(root.querySelectorAll('.inc-m-add'), function(btn){
    btn.addEventListener('click', function(e){
      e.preventDefault();
      incManual(incGroup(btn.getAttribute('data-s'))).push({ bl:'', amount:'', note:'' });
      incRenderDetail();
    });
  });
  Array.prototype.forEach.call(root.querySelectorAll('.inc-m-del'), function(btn){
    btn.addEventListener('click', function(){
      incManual(incGroup(btn.getAttribute('data-s'))).splice(Number(btn.getAttribute('data-i')), 1);
      incRenderDetail(); incRenderSummary();
    });
  });
  Array.prototype.forEach.call(root.querySelectorAll('.inc-m'), function(input){
    input.addEventListener('input', function(){
      var g = incGroup(input.getAttribute('data-s'));
      incManual(g)[Number(input.getAttribute('data-i'))][input.getAttribute('data-k')] = input.value;
      // อัปเดตยอดรวมโดยไม่วาดตารางใหม่ — วาดใหม่แล้ว cursor ในช่องที่พิมพ์อยู่จะหลุด
      Array.prototype.forEach.call(root.querySelectorAll('.inc-gt[data-s="'+g.shipping+'"]'), function(el){ el.textContent = incMoney(incTotal(g)); });
      incRenderSummary();
    });
  });
  Array.prototype.forEach.call(root.querySelectorAll('.inc-pdf'), function(btn){
    btn.addEventListener('click', function(e){
      e.preventDefault();
      var g = incGroup(btn.getAttribute('data-s'));
      incOpenPdf([incDocument(g)], 'ใบสรุปค่าใช้จ่ายเพิ่มเติม-'+g.shipping);
    });
  });
}

/**
 * ใบสรุปค่าใช้จ่ายเพิ่มเติมของคนหนึ่ง — เรียงแบบเอกสารเดิม:
 * งาน TRANSIT ก่อน แล้ว MAESOT FREEZONE • ในแต่ละไฟล์ ค่านายตรวจก่อน แล้วค่อยรายการเพิ่มเติม
 * ค่านายตรวจไม่มีหมายเหตุ รายการเพิ่มเติมใส่ชื่อรายการในหมายเหตุ • รายการเพิ่มเองต่อท้าย
 */
function incDocument(g){
  var srcOrder = function(src){ return src === 'TRANSIT' ? 0 : (src === 'MAESOT FREEZONE' ? 1 : 2); };
  var isInspector = function(l){ return /นายตรวจ/.test(l.label); };
  var lines = g.lines.map(function(l, i){ return { l:l, i:i }; }).sort(function(a, b){
    return srcOrder(a.l.source) - srcOrder(b.l.source)
      || (isInspector(a.l) ? 0 : 1) - (isInspector(b.l) ? 0 : 1)
      || a.i - b.i;
  }).map(function(x){
    return { label:x.l.bl, qty:incAmountText(x.l.amount), note:isInspector(x.l) ? '' : x.l.label, highlight:false };
  });
  incManualValid(g).forEach(function(m){
    lines.push({ label:String(m.bl).trim(), qty:incAmountText(m.amount), note:String(m.note||'').trim(), highlight:false });
  });
  var d = incState.data;
  var name = incState.fullName[g.shipping] != null ? incState.fullName[g.shipping] : (g.fullName || g.name || g.shipping);
  return {
    kind:'SUMMARY', heading:'ใบสรุปค่าใช้จ่ายเพิ่มเติม', date:d.to,
    partyLabel:'ชื่อชิปปิ้ง', partyLines:[name],
    headers:['ลำดับ','รายการ (BL)','จำนวนเงิน','หมายเหตุ'],
    headFill:'#b7b7b7', rowsPerPage:25,
    rows:lines, total:incAmountText(incTotal(g)),
    preparedBy:(state.user && state.user.name) || ''
  };
}

/** สร้าง PDF แล้วเปิดใน popup พร้อมลิงก์ดาวน์โหลด (เปิด popup ก่อน ไม่งั้นเบราว์เซอร์บล็อก) */
async function incOpenPdf(docs, name){
  if(!docs.length){ $('inc-msg').textContent = 'ยังไม่มีข้อมูล — กด "ดึงข้อมูล" ก่อน'; return; }
  var popup = window.open('', '_blank', 'popup,width=1000,height=850');
  if(popup){ popup.document.body.textContent = 'กำลังจัดเตรียม PDF…'; popup.document.body.style.margin = '0'; }
  try{
    var blob = await InvoicePDF.create(docs, incState.data.company);
    var url = URL.createObjectURL(blob), filename = name.replace(/[\\/:*?"<>|]/g, '-')+'.pdf';
    if(popup && !popup.closed){
      popup.document.body.innerHTML = ''; popup.document.title = filename;
      var link = popup.document.createElement('a'); link.href = url; link.download = filename;
      link.textContent = 'ดาวน์โหลด '+filename; link.style.cssText = 'display:block;padding:12px;background:#edf2ff;font:14px Tahoma';
      popup.document.body.appendChild(link);
      var frame = popup.document.createElement('iframe'); frame.src = url; frame.title = filename;
      frame.style.cssText = 'width:100%;height:calc(100vh - 50px);border:0';
      popup.document.body.appendChild(frame);
    } else {
      var a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    }
  }catch(error){
    var msg = 'สร้าง PDF ไม่สำเร็จ: '+error.message;
    $('inc-msg').textContent = msg;
    if(popup && !popup.closed) popup.document.body.textContent = msg;
  }
}

function incExport(){
  var d = incState.data;
  if(!d || !d.groups.length){ $('inc-msg').textContent = 'ยังไม่มีข้อมูลให้ส่งออก'; return; }
  var rows = [];
  d.groups.forEach(function(g){
    g.lines.forEach(function(l){ rows.push([g.shipping, g.name, incDmy(l.date), l.source, l.bl, l.label, l.amount]); });
    incManualValid(g).forEach(function(m){ rows.push([g.shipping, g.name, '', 'เพิ่มเอง', m.bl, m.note, Number(m.amount)]); });
  });
  downloadCSV('shipping_income_'+d.from+'_'+d.to+'.csv',
    ['ชิปปิ้ง','ชื่อ','วันที่ตรวจปล่อย','ไฟล์','BL','รายการ','ยอด'], rows);
}
