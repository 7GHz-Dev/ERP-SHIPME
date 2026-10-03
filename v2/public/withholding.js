/**
 * ใบหัก ณ ที่จ่าย (กระทำการแทน) — สรุปจำนวนใบและยอดหักตามช่วงวันที่ตรวจปล่อย
 *
 * ข้อมูลจากชีตงานขนส่ง MAESOT FREEZONE + TRANSIT (เซิร์ฟเวอร์แตกเป็นรายการ 1 รายการ = 1 ใบ)
 *   DO             : VESSEL = KNOT GLOBAL / SEAL / M+R — นับตามวันที่จ่ายในชีตค่าแลกดีโอ (ไม่ใช่วันที่ตรวจปล่อย)
 *   EXTRA MOVEMENT : ทุก BL ที่มียอด
 *   STORAGE + LIFT ON + LIFT OFF : รวมเป็น 1 ใบต่อ BL
 * ยอดหัก = ยอดในชีต ÷ ตัวหาร × อัตรา — ตั้งแยกได้ทีละหมวด (ค่าเริ่มต้น ÷ 1.04 × 3%)
 *
 * ใช้ $, api, state, esc, downloadCSV จากสคริปต์หลักของ admin.html (เรียกตอนเปิดแท็บ)
 */
var whtState = { ready:false, data:null, filter:'' };
var WHT_CATS = [
  { key:'DO', label:'DO (KNOT GLOBAL / SEAL / M+R) ตามวันที่จ่าย' },
  { key:'EM', label:'EXTRA MOVEMENT' },
  { key:'PORT', label:'STORAGE / LIFT ON / LIFT OFF' }
];

function whtRound2(n){ return Math.round((Number(n)||0)*100)/100; }
function whtMoney(n){ return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function whtYmd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function whtDmy(ymd){ return String(ymd||'').split('-').reverse().join('/'); }

function initWithholding(){
  if(whtState.ready) return;
  whtState.ready = true;
  // ค่าเริ่มต้น: ครึ่งเดือนล่าสุดที่จบไปแล้ว เหมือนแท็บใบแจ้งหนี้ค่าบริการ
  var now = new Date(), y = now.getFullYear(), m = now.getMonth();
  var from = now.getDate() > 15 ? new Date(y, m, 1) : new Date(y, m-1, 16);
  var to = now.getDate() > 15 ? new Date(y, m, 15) : new Date(y, m, 0);
  $('wht-from').value = whtYmd(from);
  $('wht-to').value = whtYmd(to);
  $('wht-from').addEventListener('change', function(){
    if(this.value && (!$('wht-to').value || $('wht-to').value < this.value)) $('wht-to').value = this.value;
  });
  $('wht-load').addEventListener('click', whtLoad);
  $('wht-filter').addEventListener('change', function(){ whtState.filter = this.value; whtRenderLines(); });
  $('wht-csv').addEventListener('click', whtExport);
  whtBindSettings();
}

/** ตัวหารและอัตราของหมวดนั้น จากช่องบนหน้าจอ */
function whtSetting(cat){
  var div = Number($('wht-div-'+cat).value), rate = Number($('wht-rate-'+cat).value);
  return { divisor: div > 0 ? div : 1, rate: (rate >= 0 ? rate : 0) / 100 };
}
function whtBase(line){ return whtRound2(line.amount / whtSetting(line.category).divisor); }
function whtAmount(line){ return whtRound2(whtBase(line) * whtSetting(line.category).rate); }

function whtLoad(){
  var from = $('wht-from').value, to = $('wht-to').value;
  if(!from || !to){ $('wht-msg').textContent = 'เลือกช่วงวันที่ตรวจปล่อยก่อน'; return; }
  $('wht-msg').textContent = 'กำลังดึงข้อมูลจากชีตงานขนส่ง…';
  $('wht-load').disabled = true;
  api({ action:'withholdingData', token:state.token, from:from, to:to }).then(function(res){
    $('wht-load').disabled = false;
    if(!res.ok){ $('wht-msg').textContent = 'ดึงข้อมูลไม่สำเร็จ: '+res.error; return; }
    whtState.data = res;
    // ตั้งค่าเริ่มต้นเฉพาะช่องที่ยังว่าง — ที่ผู้ใช้แก้ไว้แล้วไม่ทับ
    WHT_CATS.forEach(function(c){
      if(!$('wht-div-'+c.key).value) $('wht-div-'+c.key).value = res.defaults.divisor;
      if(!$('wht-rate-'+c.key).value) $('wht-rate-'+c.key).value = whtRound2(res.defaults.rate*100);
    });
    $('wht-msg').textContent = 'ช่วงวันที่ '+whtDmy(res.from)+' - '+whtDmy(res.to)+' • '+res.lines.length+' ใบ'
      + (res.doTabs && res.doTabs.length ? (' • ชีตค่าแลกดีโอ: '+res.doTabs.join(', ')) : '');
    $('wht-result').classList.remove('hidden');
    whtRenderDoWarn(res);
    whtRender();
  }).catch(function(){
    $('wht-load').disabled = false;
    $('wht-msg').textContent = 'ดึงข้อมูลไม่สำเร็จ ตรวจสอบอินเทอร์เน็ต';
  });
}

function whtRender(){ whtRenderSummary(); whtRenderLines(); }

/**
 * เตือนเรื่อง DO — อ่านชีตค่าแลกดีโอไม่ได้ หรือ BL ที่จ่าย DO แล้วแต่ยังหาสายเรือไม่เจอ
 * (ส่วนใหญ่คือ BL ที่ยังไม่ได้ลงชีตงานขนส่ง) ถ้าเป็นสายเรือที่ต้องออกใบหัก จะยังไม่ถูกนับ
 */
function whtRenderDoWarn(res){
  var html = '';
  if(res.doError){
    html += '<div><b>อ่านชีตค่าแลกดีโอไม่ได้</b> ('+esc(res.doError)+') — ยังไม่ได้นับใบหักค่า DO • ตรวจว่าชีตยังแชร์แบบ "ทุกคนที่มีลิงก์" อยู่</div>';
  }
  var list = res.doUnmatched || [];
  if(list.length){
    html += '<div><b>BL ที่จ่าย DO แล้วแต่หาสายเรือ (VESSEL) ในชีตงานขนส่งไม่เจอ '+list.length+' รายการ</b>'
      + ' — ยังไม่นับเป็นใบหัก ถ้าเป็น KNOT GLOBAL / SEAL / M+R ให้ลง BL ในชีตงานขนส่งก่อนแล้วดึงใหม่</div>'
      + '<div style="margin-top:4px;font-size:12px">'+list.map(function(x){
          return esc(whtDmy(x.date))+' <span class="mono">'+esc(x.bl)+'</span> '+whtMoney(x.amount);
        }).join(' • ')+'</div>';
  }
  $('wht-do-warn').innerHTML = html;
  $('wht-do-warn').classList.toggle('hidden', !html);
}

/** ตารางสรุปต่อหมวด — แก้ตัวหาร/อัตราในแถวได้ ยอดเปลี่ยนทันที */
function whtRenderSummary(){
  var lines = (whtState.data && whtState.data.lines) || [];
  var tCount = 0, tAmount = 0, tBase = 0, tWht = 0;
  $('wht-sum-body').querySelectorAll('tr[data-cat]').forEach(function(tr){
    var cat = tr.getAttribute('data-cat');
    var list = lines.filter(function(l){ return l.category === cat; });
    var amount = whtRound2(list.reduce(function(s, l){ return s+l.amount; }, 0));
    var base = whtRound2(list.reduce(function(s, l){ return s+whtBase(l); }, 0));
    var wht = whtRound2(list.reduce(function(s, l){ return s+whtAmount(l); }, 0));
    tr.querySelector('.wht-c').textContent = list.length;
    tr.querySelector('.wht-a').textContent = whtMoney(amount);
    tr.querySelector('.wht-b').textContent = whtMoney(base);
    tr.querySelector('.wht-w').textContent = whtMoney(wht);
    tCount += list.length; tAmount += amount; tBase += base; tWht += wht;
  });
  $('wht-t-c').textContent = tCount;
  $('wht-t-a').textContent = whtMoney(tAmount);
  $('wht-t-b').textContent = whtMoney(tBase);
  $('wht-t-w').textContent = whtMoney(tWht);
}

function whtRenderLines(){
  var lines = ((whtState.data && whtState.data.lines) || []).filter(function(l){
    return !whtState.filter || l.category === whtState.filter;
  });
  $('wht-lines-body').innerHTML = lines.length ? lines.map(function(l, i){
    return '<tr><td class="num">'+(i+1)+'</td><td>'+esc(whtDmy(l.date))+'<div class="sub">'+esc(l.source)+'</div></td>'
      + '<td class="mono">'+esc(l.bl)+'</td><td>'+esc(l.vessel||'—')+'</td>'
      + '<td>'+esc(l.detail)+'</td>'
      + '<td class="num">'+whtMoney(l.amount)+'</td><td class="num">'+whtMoney(whtBase(l))+'</td>'
      + '<td class="num"><b>'+whtMoney(whtAmount(l))+'</b></td></tr>';
  }).join('') : '<tr><td colspan="8" class="muted" style="padding:14px">ไม่มีรายการ</td></tr>';
}

function whtExport(){
  var d = whtState.data;
  if(!d || !d.lines.length){ $('wht-msg').textContent = 'ยังไม่มีข้อมูลให้ส่งออก'; return; }
  var catLabel = {}; WHT_CATS.forEach(function(c){ catLabel[c.key] = c.label; });
  var rows = d.lines.map(function(l, i){
    return [i+1, catLabel[l.category], whtDmy(l.date), l.source, l.bl, l.vessel, l.detail,
            l.amount, whtBase(l), whtAmount(l)];
  });
  downloadCSV('withholding_'+d.from+'_'+d.to+'.csv',
    ['ลำดับ','หมวด','วันที่ (DO = วันที่จ่าย)','ที่มา','BL','VESSEL','รายละเอียด','ยอดในชีต','ฐานภาษี','ยอดหัก ณ ที่จ่าย'], rows);
}

// ตัวหาร/อัตราเปลี่ยน = คิดยอดใหม่ทั้งหน้า (ผูกครั้งเดียวตอนโหลดไฟล์ได้ เพราะเป็นแค่ฟังก์ชัน)
function whtBindSettings(){
  WHT_CATS.forEach(function(c){
    ['div','rate'].forEach(function(k){
      $('wht-'+k+'-'+c.key).addEventListener('input', function(){ if(whtState.data) whtRender(); });
    });
  });
}
