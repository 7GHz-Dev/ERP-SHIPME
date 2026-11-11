/**
 * ใบหัก ณ ที่จ่าย (กระทำการแทน) — สรุปจำนวนใบและยอดหักตามช่วงวันที่ตรวจปล่อย
 *
 * ข้อมูลจากชีตงานขนส่ง MAESOT FREEZONE + TRANSIT (เซิร์ฟเวอร์แตกเป็นรายการ 1 รายการ = 1 ใบ)
 *   DO             : VESSEL = KNOT GLOBAL / SEAL / M+R / IFOUR FREIGHT / JJ / RCL — นับตามวันที่จ่ายในชีตค่าแลกดีโอ (ไม่ใช่วันที่ตรวจปล่อย)
 *   EXTRA MOVEMENT : ทุก BL ที่มียอด
 *   STORAGE + LIFT ON + LIFT OFF : รวมเป็น 1 ใบต่อ BL
 * ยอดหัก = ยอดในชีต ÷ ตัวหาร × อัตรา — ตั้งแยกได้ทีละหมวด (ค่าเริ่มต้น ÷ 1.04 × 3%)
 *
 * ใช้ $, api, state, esc, downloadCSV จากสคริปต์หลักของ admin.html (เรียกตอนเปิดแท็บ)
 */
var whtState = { ready:false, data:null, filter:'' };
var WHT_CATS = [
  { key:'DO', label:'DO (KNOT GLOBAL / SEAL / M+R / IFOUR FREIGHT / JJ / RCL) ตามวันที่จ่าย' },
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
  $('wht-excel').addEventListener('click', whtExcel);
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
    var certs = res.lines.reduce(function(s, l){ return s+(l.count==null?1:l.count); }, 0);
    $('wht-msg').textContent = 'ช่วงวันที่ '+whtDmy(res.from)+' - '+whtDmy(res.to)+' • '+certs+' ใบ'
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
      + ' — ยังไม่นับเป็นใบหัก ถ้าเป็นสายเรือที่ออกใบหัก (KNOT GLOBAL / SEAL / M+R / IFOUR FREIGHT / JJ / RCL) ให้ลง BL ในชีตงานขนส่งก่อนแล้วดึงใหม่</div>'
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
    var count = list.reduce(function(s, l){ return s+(l.count==null?1:l.count); }, 0);
    var amount = whtRound2(list.reduce(function(s, l){ return s+l.amount; }, 0));
    var base = whtRound2(list.reduce(function(s, l){ return s+whtBase(l); }, 0));
    var wht = whtRound2(list.reduce(function(s, l){ return s+whtAmount(l); }, 0));
    tr.querySelector('.wht-c').textContent = count;
    tr.querySelector('.wht-a').textContent = whtMoney(amount);
    tr.querySelector('.wht-b').textContent = whtMoney(base);
    tr.querySelector('.wht-w').textContent = whtMoney(wht);
    tCount += count; tAmount += amount; tBase += base; tWht += wht;
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
      + '<td>'+esc(l.detail)+(l.count!==1?' <span class="pill '+(l.count?'pending':'')+'">'+l.count+' ใบ</span>':'')+'</td>'
      + '<td class="num">'+whtMoney(l.amount)+'</td><td class="num">'+whtMoney(whtBase(l))+'</td>'
      + '<td class="num"><b>'+whtMoney(whtAmount(l))+'</b></td></tr>';
  }).join('') : '<tr><td colspan="8" class="muted" style="padding:14px">ไม่มีรายการ</td></tr>';
}

function whtExport(){
  var d = whtState.data;
  if(!d || !d.lines.length){ $('wht-msg').textContent = 'ยังไม่มีข้อมูลให้ส่งออก'; return; }
  var catLabel = {}; WHT_CATS.forEach(function(c){ catLabel[c.key] = c.label; });
  var rows = d.lines.map(function(l, i){
    return [i+1, catLabel[l.category], whtDmy(l.date), l.source, l.bl, l.vessel, l.detail, (l.count==null?1:l.count),
            l.amount, whtBase(l), whtAmount(l)];
  });
  downloadCSV('withholding_'+d.from+'_'+d.to+'.csv',
    ['ลำดับ','หมวด','วันที่ (DO = วันที่จ่าย)','ที่มา','BL','VESSEL','รายละเอียด','จำนวนใบ','ยอดในชีต','ฐานภาษี','ยอดหัก ณ ที่จ่าย'], rows);
}

// ตัวหาร/อัตราเปลี่ยน = คิดยอดใหม่ทั้งหน้า (ผูกครั้งเดียวตอนโหลดไฟล์ได้ เพราะเป็นแค่ฟังก์ชัน)
function whtBindSettings(){
  WHT_CATS.forEach(function(c){
    ['div','rate'].forEach(function(k){
      $('wht-'+k+'-'+c.key).addEventListener('input', function(){ if(whtState.data) whtRender(); });
    });
  });
}

/**
 * Excel จัดรูปแบบ — ชีต "สรุป" (ต่อหมวด ตามตัวหาร/อัตราที่ตั้งบนจอ) + ชีต "รายการ" (ทุกหมวด 1 แถว = 1 รายการ)
 * ใช้ PrettyExcel (pretty-excel.js)
 */
function whtExcel(){
  var d = whtState.data;
  if(!d || !d.lines.length){ $('wht-msg').textContent = 'ยังไม่มีข้อมูลให้ส่งออก — กด "ดึงข้อมูล" ก่อน'; return; }
  var catLabel = {}; WHT_CATS.forEach(function(c){ catLabel[c.key] = c.label; });
  var count = function(l){ return l.count==null ? 1 : l.count; };
  var sum = WHT_CATS.map(function(c){
    var list = d.lines.filter(function(l){ return l.category === c.key; }), st = whtSetting(c.key);
    return { cat:c.label, count:list.reduce(function(s, l){ return s+count(l); }, 0),
      amount:whtRound2(list.reduce(function(s, l){ return s+l.amount; }, 0)),
      divisor:st.divisor, rate:whtRound2(st.rate*100)+'%',
      base:whtRound2(list.reduce(function(s, l){ return s+whtBase(l); }, 0)),
      wht:whtRound2(list.reduce(function(s, l){ return s+whtAmount(l); }, 0)) };
  });
  var total = function(list, k){ return whtRound2(list.reduce(function(s, x){ return s+Number(x[k]); }, 0)); };
  var lines = d.lines.map(function(l, i){
    return { no:i+1, cat:catLabel[l.category], date:l.date, source:l.source, bl:l.bl, vessel:l.vessel||'', detail:l.detail,
      count:count(l), amount:l.amount, base:whtBase(l), wht:whtAmount(l) };
  });
  var range = 'วันที่ตรวจปล่อย '+whtDmy(d.from)+' – '+whtDmy(d.to)+' (DO ตามวันที่จ่ายในชีตค่าแลกดีโอ)';
  var btn = $('wht-excel'); btn.disabled = true;
  PrettyExcel.download({
    fileName: 'ใบหัก-ณ-ที่จ่าย-กระทำการแทน-จากชีต_'+d.from+'_'+d.to+'.xlsx',
    company: 'บริษัท ชิป มี โลจิสติกส์ จำกัด',
    sheets: [{
      name: 'สรุป', title: 'สรุปใบหัก ณ ที่จ่าย (กระทำการแทน)', portrait: true,
      subtitle: [range, 'ฐานภาษี = ยอดในชีต ÷ ตัวหาร • ยอดหัก = ฐานภาษี × อัตรา'],
      columns: [
        { header:'หมวด', key:'cat', width:44 }, { header:'จำนวนใบ', key:'count', width:10, type:'int' },
        { header:'ยอดในชีต', key:'amount', width:15, type:'money' }, { header:'ตัวหาร', key:'divisor', width:8, type:'center' },
        { header:'อัตรา', key:'rate', width:8, type:'center' }, { header:'ฐานภาษี', key:'base', width:15, type:'money' },
        { header:'ยอดหัก ณ ที่จ่าย', key:'wht', width:15, type:'money' }
      ],
      rows: sum,
      totals: { count:total(sum,'count'), amount:total(sum,'amount'), base:total(sum,'base'), wht:total(sum,'wht') }
    }, {
      name: 'รายการ', title: 'รายการใบหัก ณ ที่จ่าย (กระทำการแทน)',
      subtitle: [range, d.lines.length+' รายการ'],
      columns: [
        { header:'ลำดับ', key:'no', width:6, type:'int' }, { header:'หมวด', key:'cat', width:24 },
        { header:'วันที่', key:'date', width:12, type:'date' }, { header:'ที่มา', key:'source', width:16 },
        { header:'BL', key:'bl', width:20, type:'center' }, { header:'VESSEL', key:'vessel', width:14 },
        { header:'รายละเอียด', key:'detail', width:34 }, { header:'จำนวนใบ', key:'count', width:9, type:'int' },
        { header:'ยอดในชีต', key:'amount', width:14, type:'money' }, { header:'ฐานภาษี', key:'base', width:14, type:'money' },
        { header:'ยอดหัก ณ ที่จ่าย', key:'wht', width:14, type:'money' }
      ],
      rows: lines,
      totals: { count:total(lines,'count'), amount:total(lines,'amount'), base:total(lines,'base'), wht:total(lines,'wht') },
      totalLabelKey: 'detail', totalLabel: 'รวม'
    }]
  }).catch(function(e){ alert(e.message || e); }).then(function(){ btn.disabled = false; });
}
