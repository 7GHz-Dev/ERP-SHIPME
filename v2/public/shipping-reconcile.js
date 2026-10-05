/**
 * กระทบยอดชิปปิ้ง — ค่าใช้จ่ายตามชีตงานขนส่ง (MAESOT FREEZONE + TRANSIT) เทียบใบเบิก/ใบปิดบัญชี
 * แยกตามชื่อชิปปิ้ง ต่อวันที่ตรวจปล่อย (รูปแบบเดียวกับรายงาน "เบิกเงินและคืนเงิน" ของฝ่ายบัญชี)
 *
 * ชีต = ค่าใช้จ่ายทุกช่อง ยกเว้น DO / DEM / ค่านายตรวจ / ค่า พรบ. / ค่าบริการ พรบ.
 * ค่าบริการฟรีโซน (500/ตู้) ไม่มีในชีต ใช้ยอดจากใบปิดบัญชีบวกก่อนเทียบ
 * ส่วนต่าง = ยอดใช้จริงในใบปิดบัญชี − (ชีต + ค่าบริการฟรีโซน)
 * (ไม่มีตัวเลือกตัดค่าล่วงเวลา — ข้อมูลจริงบางวันเบิก OT ในใบปิดบัญชี บางวันไม่เบิก ตัดทิ้งทั้งหมดจะผิดอีกแบบ)
 *
 * ใช้ $, api, state, esc, downloadCSV จากสคริปต์หลักของ admin.html (เรียกตอนเปิดแท็บ)
 */
var recState = { ready:false, data:null, open:{} };

function recMoney(n){ return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function recYmd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function recDmy(ymd){ return ymd ? String(ymd).split('-').reverse().join('/') : '—'; }
function recSheet(x){ return Math.round((x.sheet||0)*100)/100; }
/** ส่วนต่าง: null = ยังไม่มีใบปิดบัญชี (เทียบไม่ได้) */
function recDiff(x, used){
  if(used == null) return null;
  return Math.round((used - (recSheet(x) + (x.freezone||0)))*100)/100;
}
function recOk(diff){ return diff != null && Math.abs(diff) < 0.01; }
/**
 * สีพื้นหลังแยกกลุ่มคอลัมน์ — ฝั่งใบเบิก/ใบปิดบัญชี (ยอดเบิก / ค่าใช้จ่ายจริง / ยอดคืนเงิน) กับฝั่งชีต
 * แถวที่ไม่ตรงใช้สีเข้มขึ้นของกลุ่มเดิม จะได้ยังเห็นว่าเป็นคอลัมน์กลุ่มไหน
 */
var REC_BG = { claim:'#eaf2ff', claimBad:'#dbe6fb', sheet:'#fff6e0', sheetBad:'#fdebc2', head:{ claim:'#d6e4fb', sheet:'#fde9b8' } };
function recTd(group, bad, html){
  return '<td class="num" style="background:'+REC_BG[group+(bad?'Bad':'')]+'">'+html+'</td>';
}
/** ค่าใช้จ่ายจริง = ยอดในใบปิดบัญชี (รวมค่าบริการฟรีโซนแล้ว) — บอกยอดฟรีโซนไว้ใต้ตัวเลข */
function recUsedHtml(used, freezone, bold){
  if(used == null) return '<span class="muted">—</span>';
  var v = bold ? '<b>'+recMoney(used)+'</b>' : recMoney(used);
  return v + (freezone ? '<div class="sub">รวมฟรีโซน '+recMoney(freezone)+'</div>' : '');
}

function initShippingReconcile(){
  if(recState.ready) return;
  recState.ready = true;
  // ค่าเริ่มต้น: เดือนที่แล้วทั้งเดือน (รายงานกระทบยอดของฝ่ายบัญชีทำรายเดือน)
  var now = new Date();
  $('rec-from').value = recYmd(new Date(now.getFullYear(), now.getMonth()-1, 1));
  $('rec-to').value = recYmd(new Date(now.getFullYear(), now.getMonth(), 0));
  $('rec-from').addEventListener('change', function(){
    if(this.value && (!$('rec-to').value || $('rec-to').value < this.value)) $('rec-to').value = this.value;
  });
  $('rec-load').addEventListener('click', recLoad);
  $('rec-only-diff').addEventListener('change', recRender);
  $('rec-csv').addEventListener('click', recExport);
}

function recLoad(){
  var from = $('rec-from').value, to = $('rec-to').value;
  if(!from || !to){ $('rec-msg').textContent = 'เลือกช่วงวันที่ตรวจปล่อยก่อน'; return; }
  $('rec-msg').textContent = 'กำลังดึงข้อมูล…';
  $('rec-load').disabled = true;
  api({ action:'shippingReconcileData', token:state.token, from:from, to:to }).then(function(res){
    $('rec-load').disabled = false;
    if(!res.ok){ $('rec-msg').textContent = 'ดึงข้อมูลไม่สำเร็จ: '+res.error; return; }
    recState.data = res; recState.open = {};
    $('rec-result').classList.toggle('hidden', !res.groups.length);
    recRender();
  }).catch(function(){
    $('rec-load').disabled = false;
    $('rec-msg').textContent = 'ดึงข้อมูลไม่สำเร็จ ตรวจสอบอินเทอร์เน็ต';
  });
}

function recStatus(d){
  if(!d.hasSettlement) return '<span class="pill pending">ยังไม่ปิดบัญชี</span>';
  if(!(d.refund > 0)) return '<span class="muted">ไม่ต้องคืน</span>';
  if(/ผ่าน/.test(d.slipStatus||'')) return '<span class="pill approved">✓ ตรวจแล้ว</span>';
  // ข้อความสถานะสลิปยาว (เช่น "อ่านข้อมูลในสลิปอัตโนมัติไม่ได้ …") ย่อเป็นคำสั้น เต็มอยู่ใน tooltip
  return '<span class="pill pending" title="'+esc(d.slipStatus || '')+'">'+(/กรอก/.test(d.slipStatus||'') ? 'กรอกเอง รอตรวจ' : 'รอตรวจ')+'</span>';
}
function recDiffCell(diff){
  if(diff == null) return '<span class="muted">—</span>';
  if(recOk(diff)) return '<span style="color:#15803d">✓ ตรง</span>';
  return '<b style="color:#b91c1c">'+(diff > 0 ? '+' : '')+recMoney(diff)+'</b>';
}

function recRender(){
  var d = recState.data; if(!d) return;
  var only = $('rec-only-diff').checked;
  var totalBad = 0;
  $('rec-body').innerHTML = d.groups.map(function(g){
    var bad = 0, tSheet = 0, tDiff = 0;
    var rows = g.days.map(function(day, i){
      var diff = recDiff(day, day.used), ok = recOk(diff);
      if(!ok) bad++;
      tSheet += recSheet(day); tDiff += diff || 0;
      if(only && ok) return '';
      var key = g.shipping+'|'+day.date, open = !!recState.open[key];
      var row = '<tr class="rec-row" data-k="'+esc(key)+'" style="cursor:pointer'+(ok ? '' : ';background:#fef2f2')+'">'
        + '<td>'+recDmy(day.claimDate)+'</td><td><b>'+recDmy(day.date)+'</b></td>'
        + recTd('claim', !ok, day.claim ? recMoney(day.claim) : '<span class="muted">—</span>')
        + recTd('claim', !ok, recUsedHtml(day.used, day.freezone))
        + recTd('claim', !ok, day.refund == null ? '<span class="muted">—</span>' : recMoney(day.refund))
        + recTd('sheet', !ok, recMoney(recSheet(day)))
        + '<td class="num">'+recDiffCell(diff)+'</td>'
        + '<td>'+recDmy(day.returnedDate)+'</td><td>'+recStatus(day)+'</td></tr>';
      if(open) row += recBlRows(day);
      return row;
    }).join('');
    totalBad += bad;
    var t = g.totals;
    var head = '<div style="background:#dbe7f8;border:1px solid #b6c9e6;border-bottom:0;border-radius:10px 10px 0 0;padding:8px 12px;font-weight:700">'
      + 'ผู้เบิก : '+esc(g.fullName || g.shipping)+(g.fullName ? ' ('+esc(g.shipping)+')' : '')
      + ' <span style="font-weight:400" class="muted">— '+g.days.length+' วัน'
      + (bad ? ' • <b style="color:#b91c1c">ไม่ตรง '+bad+' วัน</b>' : ' • <span style="color:#15803d">ตรงทุกวัน</span>')+'</span></div>';
    return '<div style="margin-bottom:20px">'+head+'<div class="tablewrap" style="border-radius:0 0 10px 10px"><table class="inv-tbl">'
      + '<thead><tr><th>วันที่ทำใบเบิก</th><th>วันที่ตรวจปล่อย</th>'
      + '<th class="num" style="background:'+REC_BG.head.claim+'">ยอดเบิก</th>'
      + '<th class="num" style="background:'+REC_BG.head.claim+'">ค่าใช้จ่ายจริง<div class="sub">ใบปิดบัญชี</div></th>'
      + '<th class="num" style="background:'+REC_BG.head.claim+'">ยอดคืนเงิน</th>'
      + '<th class="num" style="background:'+REC_BG.head.sheet+'">ค่าใช้จ่ายตามชีต</th>'
      + '<th class="num">ส่วนต่าง<div class="sub">ไม่นับค่าบริการฟรีโซน</div></th>'
      + '<th>วันที่คืนเงิน</th><th>สถานะ</th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="9" class="muted" style="padding:12px">ตรงทุกวัน</td></tr>')
      + '<tr style="background:#f1f5f9"><td colspan="2"><b>รวม</b></td>'
      + recTd('claim', false, '<b>'+recMoney(t.claim)+'</b>')
      + recTd('claim', false, recUsedHtml(t.used, t.freezone, true))
      + recTd('claim', false, '<b>'+recMoney(t.refund)+'</b>')
      + recTd('sheet', false, '<b>'+recMoney(tSheet)+'</b>')
      + '<td class="num">'+recDiffCell(Math.round(tDiff*100)/100)+'</td>'
      + '<td colspan="2"></td></tr></tbody></table></div></div>';
  }).join('');
  $('rec-msg').textContent = 'วันที่ตรวจปล่อย '+recDmy(d.from)+' - '+recDmy(d.to)+' • '+d.groups.length+' คน • '
    + (totalBad ? ('ไม่ตรง '+totalBad+' วัน — กดแถวเพื่อดูราย BL') : 'ตรงทุกวัน');
  Array.prototype.forEach.call($('rec-body').querySelectorAll('.rec-row'), function(tr){
    tr.addEventListener('click', function(){
      var k = tr.getAttribute('data-k');
      recState.open[k] = !recState.open[k];
      recRender();
    });
  });
}

/** รายละเอียดราย BL ของวันนั้น — ชีตมาจากช่องไหนบ้าง เทียบยอดในใบปิดบัญชี */
function recBlRows(day){
  return day.bls.map(function(b){
    var diff = recDiff(b, b.settlement), ok = recOk(diff);
    var parts = b.sheetParts.map(function(p){
      return '<span style="white-space:nowrap">'+esc(p.label)+' '+recMoney(p.amount)+'</span>';
    }).join(' • ');
    return '<tr style="background:'+(ok ? '#f8fafc' : '#fff7ed')+';font-size:12px">'
      + '<td></td><td class="mono">'+esc(b.bl)+'</td>'
      + recTd('claim', false, '')
      + recTd('claim', false, b.settlement == null ? '<span style="color:#b91c1c">ไม่มีในใบปิดบัญชี</span>' : recUsedHtml(b.settlement, b.freezone))
      + recTd('claim', false, '')
      + recTd('sheet', false, recMoney(recSheet(b)))
      + '<td class="num">'+recDiffCell(diff)+'</td>'
      + '<td colspan="2" class="muted">'+(parts || 'ไม่มีในชีต')+'</td></tr>';
  }).join('');
}

function recExport(){
  var d = recState.data;
  if(!d || !d.groups.length){ $('rec-msg').textContent = 'ยังไม่มีข้อมูลให้ส่งออก'; return; }
  var rows = [];
  d.groups.forEach(function(g){
    g.days.forEach(function(day){
      var diff = recDiff(day, day.used);
      rows.push([g.shipping, g.fullName, recDmy(day.claimDate), recDmy(day.date), day.claim,
        day.used == null ? '' : day.used, day.freezone, day.refund == null ? '' : day.refund, recSheet(day),
        diff == null ? '' : diff, day.returnedDate ? recDmy(day.returnedDate) : '', day.hasSettlement ? (day.slipStatus || '') : 'ยังไม่ปิดบัญชี']);
    });
  });
  downloadCSV('shipping_reconcile_'+d.from+'_'+d.to+'.csv',
    ['ชิปปิ้ง','ชื่อ','วันที่ทำใบเบิก','วันที่ตรวจปล่อย','ยอดเบิก','ค่าใช้จ่ายจริง (ใบปิดบัญชี)','ในนั้นเป็นค่าบริการฟรีโซน',
     'ยอดคืนเงิน','ค่าใช้จ่ายตามชีต','ส่วนต่าง (ไม่นับฟรีโซน)','วันที่คืนเงิน','สถานะสลิป'], rows);
}
