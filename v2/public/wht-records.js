/**
 * ใบหัก ณ ที่จ่าย (บันทึกเอง) — ใบหัก 3% กระทำการแทน ที่กรอกตอนออกใบแจ้งหนี้ ADV (ตาราง invoice_wht)
 * กรองตามวันที่ตรวจปล่อยหรือวันที่ใบหัก • Export Excel จัดรูปแบบสำหรับแจ้ง KOLA (pretty-excel.js)
 *
 * ใช้ $, api, state, esc จากสคริปต์หลักของ admin.html (เรียกตอนเปิดแท็บ)
 */
var whrState = { ready:false, rows:[], from:'', to:'', by:'inspect' };
var WHR_COMPANY = 'บริษัท ชิป มี โลจิสติกส์ จำกัด';

function whrMoney(n){ return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function whrDmy(ymd){ return ymd ? String(ymd).split('-').reverse().join('/') : '—'; }
function whrYmd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function whrRound(n){ return Math.round((Number(n)||0)*100)/100; }
/** รายการในใบ — ตัด "ADV - " หน้าชื่อออก */
function whrItems(r){
  return (r.items||[]).map(function(i){ return String(i.label||'').replace(/^ADV\s*-\s*/,''); }).join(', ');
}

function initWhtRecords(){
  if(whrState.ready) return;
  whrState.ready = true;
  // ค่าเริ่มต้น: ต้นเดือนนี้ถึงวันนี้
  var now = new Date();
  $('whr-from').value = whrYmd(new Date(now.getFullYear(), now.getMonth(), 1));
  $('whr-to').value = whrYmd(now);
  $('whr-from').addEventListener('change', function(){
    if(this.value && (!$('whr-to').value || $('whr-to').value < this.value)) $('whr-to').value = this.value;
  });
  $('whr-load').addEventListener('click', whrLoad);
  $('whr-search').addEventListener('input', whrRender);
  $('whr-excel').addEventListener('click', whrExcel);
  whrLoad();
}

function whrLoad(){
  var from = $('whr-from').value, to = $('whr-to').value, by = $('whr-by').value;
  $('whr-msg').textContent = 'กำลังโหลด…';
  $('whr-load').disabled = true;
  api({ action:'listWhtRecords', token:state.token, from:from, to:to, by:by }).then(function(res){
    $('whr-load').disabled = false;
    if(!res.ok){ $('whr-msg').textContent = 'โหลดไม่สำเร็จ: '+res.error; return; }
    whrState.rows = res.rows || [];
    whrState.from = res.from; whrState.to = res.to; whrState.by = res.by;
    whrRender();
  }).catch(function(){
    $('whr-load').disabled = false;
    $('whr-msg').textContent = 'โหลดไม่สำเร็จ ตรวจสอบอินเทอร์เน็ต';
  });
}

function whrVisible(){
  var q = $('whr-search').value.trim().toLowerCase();
  if(!q) return whrState.rows;
  return whrState.rows.filter(function(r){
    return [r.bl, r.certNo, r.invoiceNumber, whrItems(r)].join(' ').toLowerCase().indexOf(q) >= 0;
  });
}
function whrRangeText(){
  var what = whrState.by === 'cert' ? 'วันที่ใบหัก ณ ที่จ่าย' : 'วันที่ตรวจปล่อย';
  if(whrState.from && whrState.to) return what+' '+whrDmy(whrState.from)+' – '+whrDmy(whrState.to);
  if(whrState.from) return what+' ตั้งแต่ '+whrDmy(whrState.from);
  if(whrState.to) return what+' ถึง '+whrDmy(whrState.to);
  return what+' ทั้งหมด';
}

function whrRender(){
  var rows = whrVisible();
  var base = whrRound(rows.reduce(function(s, r){ return s+Number(r.base); }, 0));
  var amount = whrRound(rows.reduce(function(s, r){ return s+Number(r.amount); }, 0));
  var noNumber = rows.filter(function(r){ return !r.certNo; }).length;
  $('whr-msg').innerHTML = esc(whrRangeText())+' • <b>'+rows.length+' ใบ</b> • ยอดก่อน VAT '+whrMoney(base)
    +' • หัก ณ ที่จ่าย <b>'+whrMoney(amount)+'</b>'
    +(noNumber ? ' • <span style="color:#b45309">ยังไม่มีเลขที่ใบหัก '+noNumber+' ใบ</span>' : '');
  $('whr-excel').disabled = !rows.length;
  $('whr-body').innerHTML = rows.length ? rows.map(function(r, i){
    return '<tr><td class="num">'+(i+1)+'</td><td>'+esc(whrDmy(r.inspectDate))+'</td>'
      + '<td class="mono">'+esc(r.bl)+'<div class="sub">'+esc(r.invoiceNumber)+'</div></td>'
      + '<td class="mono">'+(r.certNo ? esc(r.certNo) : '<span class="pill pending">ยังไม่มีเลข</span>')+'</td>'
      + '<td>'+esc(whrDmy(r.certDate))+'</td>'
      + '<td>'+esc(whrItems(r))+'</td>'
      + '<td class="num">'+whrMoney(r.base)+'</td><td class="num"><b>'+whrMoney(r.amount)+'</b></td></tr>';
  }).join('') + '<tr style="background:#f1f5f9"><td colspan="6"><b>รวม '+rows.length+' ใบ</b></td><td class="num"><b>'+whrMoney(base)+'</b></td><td class="num"><b>'+whrMoney(amount)+'</b></td></tr>'
    : '<tr><td colspan="8" class="muted" style="padding:14px">ไม่มีใบหัก ณ ที่จ่ายในช่วงนี้ — ใบหักบันทึกจากหน้า ใบแจ้งหนี้ ADV → ออกใบใหม่</td></tr>';
}

function whrExcel(){
  var rows = whrVisible();
  if(!rows.length) return;
  var q = $('whr-search').value.trim();
  var base = whrRound(rows.reduce(function(s, r){ return s+Number(r.base); }, 0));
  var amount = whrRound(rows.reduce(function(s, r){ return s+Number(r.amount); }, 0));
  var btn = $('whr-excel'); btn.disabled = true;
  var range = whrState.from ? whrState.from + (whrState.to && whrState.to !== whrState.from ? '_' + whrState.to : '') : 'all';
  PrettyExcel.download({
    fileName: 'ใบหัก-ณ-ที่จ่าย-กระทำการแทน_' + range + '.xlsx',
    company: WHR_COMPANY,
    sheets: [{
      name: 'ใบหัก ณ ที่จ่าย 3%',
      title: 'รายงานใบหัก ณ ที่จ่าย 3% (กระทำการแทน)',
      subtitle: [whrRangeText() + (q ? ' • ค้นหา "' + q + '"' : '') + ' • ' + rows.length + ' ใบ',
        'ฐาน = ยอดก่อน VAT ในใบแจ้งหนี้ ADV • ยอดหัก ณ ที่จ่าย = ฐาน × 3%'],
      columns: [
        { header:'NO', key:'no', width:6, type:'int' },
        { header:'วันที่ตรวจปล่อย', key:'inspectDate', width:13, type:'date' },
        { header:'BL', key:'bl', width:20, type:'center' },
        { header:'เลขที่ใบหัก ณ ที่จ่าย', key:'certNo', width:18, type:'center' },
        { header:'วันที่ใบหัก ณ ที่จ่าย', key:'certDate', width:13, type:'date' },
        { header:'รายการ', key:'items', width:42 },
        { header:'ยอดก่อน VAT', key:'base', width:15, type:'money' },
        { header:'ยอดหัก ณ ที่จ่าย 3%', key:'amount', width:15, type:'money' },
        { header:'ใบแจ้งหนี้', key:'invoiceNumber', width:14, type:'center' }
      ],
      rows: rows.map(function(r, i){
        return { no:i+1, inspectDate:r.inspectDate, bl:r.bl, certNo:r.certNo || '', certDate:r.certDate,
          items:whrItems(r), base:Number(r.base), amount:Number(r.amount), invoiceNumber:r.invoiceNumber };
      }),
      totals: { base:base, amount:amount },
      totalLabelKey: 'items', totalLabel: 'รวม ' + rows.length + ' ใบ'
    }]
  }).catch(function(e){ alert(e.message || e); }).then(function(){ btn.disabled = false; });
}
