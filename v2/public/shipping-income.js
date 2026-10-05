/**
 * รายงานรายได้ชิปปิ้ง — แยกตามชื่อชิปปิ้งในชีตงานขนส่ง (MAESOT FREEZONE + TRANSIT)
 *
 * เงื่อนไขเหมือนค่าบริการเพิ่มเติมในใบแจ้งหนี้ค่าบริการ ต่างกันที่
 *   - ค่านายตรวจนับทุกงานทั้ง 2 ตาราง (ไม่ใช่เฉพาะ RORO)
 *   - ไม่นับค่าบริการ พรบ.
 * คำนวณที่เซิร์ฟเวอร์ (shipping-income.ts) หน้านี้แสดงผลและส่งออก CSV อย่างเดียว
 *
 * ใช้ $, api, state, esc, downloadCSV จากสคริปต์หลักของ admin.html (เรียกตอนเปิดแท็บ)
 */
var incState = { ready:false, data:null, filter:'' };

function incMoney(n){ return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function incYmd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function incDmy(ymd){ return String(ymd||'').split('-').reverse().join('/'); }
/** หัวคอลัมน์ให้สั้นลง ตารางสรุปจะได้ไม่ล้นจอ */
function incShort(label){ return String(label).replace('ค่าบริการนายตรวจ','นายตรวจ').replace('ค่าน๊อคประตูออกจากท่า','ค่าน๊อคประตู'); }
function incWho(g){ return g.name && g.name.toUpperCase() !== g.shipping ? g.shipping+' ('+g.name+')' : g.shipping; }

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

/** ตารางสรุป: แถว = ชิปปิ้ง, คอลัมน์ = หัวข้อรายได้ */
function incRenderSummary(){
  var d = incState.data, labels = d.labels;
  $('inc-sum-head').innerHTML = '<tr><th>ชิปปิ้ง</th><th class="num">รายการ</th>'
    + labels.map(function(l){ return '<th class="num">'+esc(incShort(l))+'</th>'; }).join('')
    + '<th class="num">รวม</th></tr>';
  var colTotal = {};
  var rows = d.groups.map(function(g){
    labels.forEach(function(l){ colTotal[l] = (colTotal[l]||0) + (g.byLabel[l]||0); });
    return '<tr><td><b>'+esc(incWho(g))+'</b></td><td class="num">'+g.lines.length+'</td>'
      + labels.map(function(l){ return '<td class="num">'+(g.byLabel[l] ? incMoney(g.byLabel[l]) : '<span class="muted">—</span>')+'</td>'; }).join('')
      + '<td class="num"><b>'+incMoney(g.total)+'</b></td></tr>';
  });
  var count = d.groups.reduce(function(s, g){ return s+g.lines.length; }, 0);
  rows.push('<tr style="background:#f1f5f9"><td><b>รวม</b></td><td class="num"><b>'+count+'</b></td>'
    + labels.map(function(l){ return '<td class="num"><b>'+incMoney(colTotal[l])+'</b></td>'; }).join('')
    + '<td class="num"><b>'+incMoney(d.total)+'</b></td></tr>');
  $('inc-sum-body').innerHTML = rows.join('');
}

/** รายละเอียดแยกตามชิปปิ้ง — คนละหัวข้อ เปิด/ปิดได้ */
function incRenderDetail(){
  var groups = incState.data.groups.filter(function(g){ return !incState.filter || g.shipping === incState.filter; });
  $('inc-detail').innerHTML = groups.map(function(g){
    var rows = g.lines.map(function(l, i){
      return '<tr><td class="num">'+(i+1)+'</td><td>'+esc(incDmy(l.date))+'<div class="sub">'+esc(l.source)+'</div></td>'
        + '<td class="mono">'+esc(l.bl)+'</td><td>'+esc(l.label)+'</td><td class="num">'+incMoney(l.amount)+'</td></tr>';
    }).join('');
    return '<details open style="margin-bottom:14px"><summary style="cursor:pointer;padding:8px 2px;font-size:15px">'
      + '<b>'+esc(incWho(g))+'</b> <span class="muted">— '+g.lines.length+' รายการ • รวม</span> <b>'+incMoney(g.total)+'</b> บาท</summary>'
      + '<div class="tablewrap"><table class="inv-tbl"><thead><tr><th class="num">#</th><th>วันที่ตรวจปล่อย</th><th>BL</th><th>รายการ</th><th class="num">ยอด</th></tr></thead>'
      + '<tbody>'+rows+'<tr style="background:#f1f5f9"><td colspan="4"><b>รวม '+esc(g.shipping)+'</b></td><td class="num"><b>'+incMoney(g.total)+'</b></td></tr></tbody></table></div></details>';
  }).join('');
}

function incExport(){
  var d = incState.data;
  if(!d || !d.groups.length){ $('inc-msg').textContent = 'ยังไม่มีข้อมูลให้ส่งออก'; return; }
  var rows = [];
  d.groups.forEach(function(g){
    g.lines.forEach(function(l){ rows.push([g.shipping, g.name, incDmy(l.date), l.source, l.bl, l.label, l.amount]); });
  });
  downloadCSV('shipping_income_'+d.from+'_'+d.to+'.csv',
    ['ชิปปิ้ง','ชื่อ','วันที่ตรวจปล่อย','ไฟล์','BL','รายการ','ยอด'], rows);
}
