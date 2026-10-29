/**
 * บัญชีรับจ่ายบริษัท — แท็บ "บัญชีรับจ่ายบริษัท" ในหน้า admin (ฝ่ายบัญชี + admin)
 *   📒 สมุดรายรับ-รายจ่ายประจำเดือน: กด "เพิ่มแถว" กรอกในตาราง — เลือกรายการจากที่ตั้งค่าไว้ (พิมพ์ค้นหาได้)
 *      แล้วผู้รับเงิน / ยอด / VAT / หัก ณ ที่จ่ายเติมให้เอง • สิ้นเดือนเลือกหลายรายการหรือทั้งหมด → ออกใบสำคัญจ่าย (PV) / รับ (RV)
 *      ทีเดียว (1 รายการ = 1 ใบ) ได้ PDF ไฟล์เดียวพร้อมพิมพ์ • พิมพ์สมุด / Excel
 *   ⚙️ ตั้งค่ารายการ: รายการที่ใช้บ่อย ผูกผู้รับเงิน + ยอด + VAT + หัก ณ ที่จ่าย (พนักงานบัญชีตั้งเอง)
 *
 * ยอดสุทธิ = ก่อนหักภาษี + VAT − หัก ณ ที่จ่าย (ภงด.3 หรือ ภงด.53) — เซิร์ฟเวอร์คิดซ้ำเองตอนบันทึก (src/lib/ledger.ts)
 * รายการที่ออกใบสำคัญแล้วถูกล็อก แก้/ลบได้หลังยกเลิกใบสำคัญ — ยอดในใบที่พิมพ์ไปแล้วจึงตรงกับสมุดเสมอ
 *
 * ใช้ $, api, state, esc, baht, toast, XLSX, VoucherPDF จากหน้า admin.html (เรียกตอนเปิดแท็บ)
 */
var lg = { ready:false, company:null, presets:[], book:[], editing:'', rowForm:null, presetDraft:null, presetDirty:false };
var LG_VAT = 0.07, LG_FORM_SEQ = 0, LG_COLS = 16;
var LG_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
var LG_PAY = { cash:'เงินสด', transfer:'เงินโอน', cheque:'เช็ค' };
var LG_WHT = { pnd3:'ภงด.3', pnd53:'ภงด.53' };
var LG_KIND = { PV:{ name:'ใบสำคัญจ่าย', dir:'out', side:'รายจ่าย', party:'จ่ายให้แก่' }, RV:{ name:'ใบสำคัญรับ', dir:'in', side:'รายรับ', party:'รับจาก' } };
var LG_ERR = {
  bad_date:'วันที่ไม่ถูกต้อง', bad_direction:'เลือกรายรับหรือรายจ่าย', missing_description:'กรอกรายการก่อน', bad_qty:'จำนวนไม่ถูกต้อง',
  bad_amount:'จำนวนเงินไม่ถูกต้อง', wht_over_amount:'ยอดหัก ณ ที่จ่ายมากกว่ายอดเงิน', bad_wht_type:'ประเภทหัก ณ ที่จ่ายไม่ถูกต้อง',
  bad_pay_method:'วิธีชำระไม่ถูกต้อง', entry_locked:'รายการออกใบสำคัญแล้ว — ยกเลิกใบสำคัญก่อนจึงแก้/ลบได้', entry_not_found:'ไม่พบรายการ (อาจถูกลบไปแล้ว)',
  no_rows:'ยังไม่ได้เลือกรายการ', bad_kind:'ประเภทใบสำคัญไม่ถูกต้อง',
  bad_number:'เลขที่ไม่ถูกต้อง — ต้องเป็น PV/RV + ปีเดือนของวันที่ในใบ + เลขรัน 2–3 หลัก', seq_overflow:'เลขรันเดือนนี้เกิน 999 แล้ว',
  number_used:'เลขที่นี้ถูกใช้ไปแล้ว', wrong_direction:'ใบสำคัญจ่ายใช้กับรายจ่าย / ใบสำคัญรับใช้กับรายรับเท่านั้น',
  too_many_lines:'ออกใบสำคัญได้ครั้งละไม่เกิน 300 รายการ', voucher_not_found:'ไม่พบใบสำคัญ',
  duplicate_preset:'ชื่อรายการซ้ำกันในประเภทเดียวกัน'
};
function lgErr(res){
  var msg=LG_ERR[res.error] || (typeof errTH==='function' ? errTH(res.error) : res.error);
  return msg+(res.numbers ? ' ('+res.numbers.join(', ')+')' : (res.number ? ' ('+res.number+')' : ''));
}
function lgRound(n){ return Math.round((Number(n)||0)*100)/100; }
function lgDmy(ymd){ return ymd ? String(ymd).split('-').reverse().join('/') : ''; }
function lgToday(){ var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function lgMonthRange(ym){
  var y=+ym.slice(0,4), m=+ym.slice(5,7);
  return { from:ym+'-01', to:ym+'-'+String(new Date(y, m, 0).getDate()).padStart(2,'0') };
}
function lgMonthLabel(ym){ return (LG_MONTHS[+ym.slice(5,7)-1]||'')+' '+ym.slice(0,4); }
function lgYm(input){ return /^\d{4}-\d{2}$/.test(input.value) ? input.value : lgToday().slice(0,7); }
function lgPayText(e){ return (LG_PAY[e.payMethod]||'')+(e.payRef ? ' '+e.payRef : ''); }
/** ผลจาก api — หมดเวลาเข้าสู่ระบบให้หน้าหลักจัดการ (guard) */
function lgOk(res){ return typeof guard!=='function' || guard(res); }
/** รายการ + รายการตั้งค่า + คำที่เคยใช้ (เติมอัตโนมัติ) ตามช่วงวันที่ */
function lgFetch(from, to){
  return api({ action:'ledgerList', token:state.token, from:from, to:to }).then(function(res){
    if(!lgOk(res)) return res;
    if(res.ok){
      lg.company=res.company;
      lg.presets=res.presets||[]; lg.suggest=res.suggest;
      lgFillLists();
    }
    return res;
  });
}

/** datalist: รายการตั้งค่าขึ้นก่อน (มีผู้รับเงิน / ยอดกำกับ) ตามด้วยรายการที่เคยพิมพ์ */
function lgFillLists(){
  var descriptions=(lg.suggest||{}).descriptions, parties=(lg.suggest||{}).parties, seen={}, opts=[];
  lg.presets.forEach(function(p){
    seen[p.description]=1;
    var hint=[p.direction==='in'?'รายรับ':'รายจ่าย', p.party, p.amount ? baht(p.amount) : '', p.hasVat ? 'VAT' : '', p.whtType ? LG_WHT[p.whtType]+' '+p.whtRate+'%' : ''].filter(Boolean).join(' · ');
    opts.push('<option value="'+esc(p.description)+'" label="⭐ '+esc(hint)+'">');
  });
  (descriptions||[]).forEach(function(d){ if(!seen[d]) opts.push('<option value="'+esc(d)+'">'); });
  $('lg-desc-list').innerHTML=opts.join('');
  var ps={}; lg.presets.forEach(function(p){ if(p.party) ps[p.party]=1; }); (parties||[]).forEach(function(v){ ps[v]=1; });
  $('lg-party-list').innerHTML=Object.keys(ps).map(function(v){ return '<option value="'+esc(v)+'">'; }).join('');
}
function lgPresetFor(description, direction){
  var d=String(description||'').trim().toLowerCase(); if(!d) return null;
  var hits=lg.presets.filter(function(p){ return p.description.toLowerCase()===d; });
  return hits.filter(function(p){ return p.direction===direction; })[0] || hits[0] || null;
}

function initLedger(){
  if(lg.ready) return;
  lg.ready=true;
  $('lg-pane-book').innerHTML=lgBookHtml();
  $('lg-pane-presets').innerHTML=lgPresetHtml();
  Array.prototype.forEach.call(document.querySelectorAll('.lg-sub'), function(btn){
    btn.addEventListener('click', function(){ lgShow(btn.getAttribute('data-sub')); });
  });
  lgBookBind(); lgPresetBind();
  lgShow('book');
}
function lgShow(sub){
  if(sub!=='presets' && lg.presetDirty && !confirm('การตั้งค่ารายการยังไม่ได้บันทึก — ออกจากหน้านี้โดยไม่บันทึก?')) return;
  if(sub!=='presets') lg.presetDirty=false;
  Array.prototype.forEach.call(document.querySelectorAll('.lg-sub'), function(b){ b.classList.toggle('active', b.getAttribute('data-sub')===sub); });
  ['book','presets'].forEach(function(s){ $('lg-pane-'+s).classList.toggle('hidden', s!==sub); });
  if(sub==='book') lgBookLoad();
  if(sub==='presets') lgPresetLoad();
}

// ---------------- แถวกรอกรายการในตาราง ----------------
function lgRowFormHtml(){
  var name='lgdir'+(++LG_FORM_SEQ);
  var f=function(label, input, w){ return '<div class="lg-field" style="flex:'+(w||'1 1 120px')+'"><div class="lg-lbl">'+label+'</div>'+input+'</div>'; };
  return '<div class="lg-form lg-rowform">'+
    '<div class="lg-rowline">'+
      '<div class="lg-dir lg-dir-sm"><label class="lg-dir-out"><input type="radio" name="'+name+'" value="out" data-f="direction"> รายจ่าย</label>'+
        '<label class="lg-dir-in"><input type="radio" name="'+name+'" value="in" data-f="direction"> รายรับ</label></div>'+
      f('วันที่', '<input type="date" data-f="entryDate">', '0 0 150px')+
      f('รายการ <small class="muted">— พิมพ์ค้นหา ⭐ = ตั้งค่าไว้</small>', '<input type="text" data-f="description" list="lg-desc-list" maxlength="300" placeholder="พิมพ์ค้นหารายการ…">', '3 1 260px')+
      f('<span data-l="party">จ่ายให้แก่</span>', '<input type="text" data-f="party" list="lg-party-list" maxlength="200">', '2 1 200px')+
      f('หมายเหตุ', '<input type="text" data-f="note" maxlength="300">', '1 1 140px')+
    '</div>'+
    '<div class="lg-rowline">'+
      f('จำนวน', '<input type="number" data-f="qty" min="0" step="any" value="1">', '0 0 70px')+
      f('ก่อนหักภาษี', '<input type="number" data-f="amount" min="0" step="0.01" placeholder="0.00">', '1 1 110px')+
      f('ยอดรวม VAT <small class="muted">(ช่วยคิด)</small>', '<input type="number" data-f="gross" min="0" step="0.01" placeholder="ถอด VAT ให้">', '1 1 120px')+
      f('<label class="lg-chk"><input type="checkbox" data-f="hasVat"> VAT 7%</label>', '<input type="number" data-f="vat" min="0" step="0.01" placeholder="0.00">', '1 1 100px')+
      f('หัก ณ ที่จ่าย', '<div class="lg-row"><select data-f="whtType"><option value="">ไม่หัก</option><option value="pnd3">ภงด.3</option><option value="pnd53">ภงด.53</option></select>'+
        '<select data-f="whtRate" style="flex:0 0 62px"><option value="1">1%</option><option value="2">2%</option><option value="3">3%</option><option value="5">5%</option></select>'+
        '<input type="number" data-f="wht" min="0" step="0.01" placeholder="0.00"></div>', '2 1 240px')+
      f('วิธีชำระ', '<div class="lg-row"><select data-f="payMethod"><option value="transfer">เงินโอน</option><option value="cash">เงินสด</option><option value="cheque">เช็ค</option></select>'+
        '<input type="text" data-f="payRef" maxlength="120" placeholder="ธนาคาร / เลขเช็ค"></div>', '2 1 220px')+
      '<div class="lg-rownet">สุทธิ<b data-l="net">0.00</b><span class="muted" data-l="calc" style="display:none"></span></div>'+
      '<div class="lg-rowbtns"><button type="button" class="btn btn-primary btn-sm" data-x="save" title="Enter">✔ บันทึก</button>'+
        '<button type="button" class="btn btn-ghost btn-sm" data-x="cancel" title="Esc">✖</button></div>'+
    '</div>'+
    '<div class="lg-msg" data-l="msg"></div>'+
  '</div>';
}
/** ผูกการคำนวณในฟอร์ม — คืน { fill, read, check, focus } • เลือกรายการที่ตั้งค่าไว้ = เติมผู้รับเงิน / ยอด / VAT / หัก ณ ที่จ่ายให้ */
function lgForm(root){
  var f=function(k){ return root.querySelector('[data-f="'+k+'"]'); };
  var num=function(k){ var v=f(k).value; return v==='' ? 0 : Number(v)||0; };
  var set=function(k, v){ f(k).value = v ? lgRound(v).toFixed(2) : ''; };
  var applied='';
  function dir(){ var r=root.querySelector('[data-f="direction"]:checked'); return r ? r.value : 'out'; }
  function setDir(d){ Array.prototype.forEach.call(root.querySelectorAll('[data-f="direction"]'), function(r){ r.checked = r.value===d; }); }
  function autoVat(){ if(f('hasVat').checked) set('vat', num('amount')*LG_VAT); }
  function autoWht(){ set('wht', f('whtType').value ? num('amount')*Number(f('whtRate').value)/100 : 0); }
  function recalc(){
    var d=dir();
    root.querySelector('[data-l="party"]').textContent = d==='in' ? 'รับจาก' : 'จ่ายให้แก่';
    root.classList.toggle('is-in', d==='in');
    var hasWht=!!f('whtType').value;
    f('whtRate').disabled=!hasWht; f('wht').disabled=!hasWht;
    f('payRef').classList.toggle('hidden', f('payMethod').value==='cash');
    var amount=num('amount'), vat=num('vat'), wht=hasWht ? num('wht') : 0;
    root.querySelector('[data-l="net"]').textContent=baht(lgRound(amount+vat-wht));
    root.querySelector('[data-l="calc"]').textContent = (vat||wht) ? '= '+baht(amount)+(vat?' + VAT '+baht(vat):'')+(wht?' − หัก '+LG_WHT[f('whtType').value]+' '+baht(wht):'') : '';
  }
  function applyPreset(p){
    setDir(p.direction);
    if(p.party) f('party').value=p.party;
    if(p.amount){ set('amount', p.amount); f('gross').value=''; }
    f('hasVat').checked=!!p.hasVat; set('vat', p.hasVat ? num('amount')*LG_VAT : 0);
    f('whtType').value=p.whtType||''; if(p.whtType) f('whtRate').value=String(p.whtRate||3); autoWht();
    if(p.payMethod){ f('payMethod').value=p.payMethod; f('payRef').value=p.payRef||''; }
    if(p.note) f('note').value=p.note;
    recalc();
    f(p.amount ? 'note' : 'amount').focus();
  }
  f('description').addEventListener('input', function(){
    var v=f('description').value, p=lgPresetFor(v, dir());
    if(p && v!==applied){ applied=v; applyPreset(p); }
  });
  f('amount').addEventListener('input', function(){ f('gross').value=''; autoVat(); autoWht(); recalc(); });
  f('gross').addEventListener('input', function(){
    var g=num('gross'), a=lgRound(g/(1+LG_VAT));
    set('amount', a); f('hasVat').checked=g>0; set('vat', g-a); autoWht(); recalc();
  });
  f('hasVat').addEventListener('change', function(){ f('gross').value=''; set('vat', f('hasVat').checked ? num('amount')*LG_VAT : 0); recalc(); });
  f('vat').addEventListener('input', function(){ f('hasVat').checked=num('vat')>0; recalc(); });
  f('whtType').addEventListener('change', function(){ autoWht(); recalc(); });
  f('whtRate').addEventListener('change', function(){ autoWht(); recalc(); });
  f('wht').addEventListener('input', recalc);
  f('payMethod').addEventListener('change', recalc);
  Array.prototype.forEach.call(root.querySelectorAll('[data-f="direction"]'), function(r){ r.addEventListener('change', recalc); });

  function fill(e){
    setDir(e.direction||'out');
    f('entryDate').value=e.entryDate||lgToday();
    f('description').value=e.description||''; applied=e.description||''; f('party').value=e.party||'';
    f('qty').value=e.qty||1; set('amount', e.amount); f('gross').value='';
    f('hasVat').checked=Number(e.vat)>0; set('vat', e.vat);
    f('whtType').value=e.whtType||''; f('whtRate').value=String(e.whtRate||3); set('wht', e.wht);
    f('payMethod').value=e.payMethod||'transfer'; f('payRef').value=e.payRef||''; f('note').value=e.note||'';
    recalc();
  }
  function read(){
    var t=f('whtType').value;
    return { direction:dir(), entryDate:f('entryDate').value, description:f('description').value.trim(), party:f('party').value.trim(),
      qty:Number(f('qty').value)||1, amount:num('amount'), vat:num('vat'), whtType:t, whtRate:t ? Number(f('whtRate').value) : 0,
      wht:t ? num('wht') : 0, payMethod:f('payMethod').value, payRef:f('payMethod').value==='cash' ? '' : f('payRef').value.trim(), note:f('note').value.trim() };
  }
  function check(e){
    if(!e.entryDate) return 'เลือกวันที่';
    if(!e.description) return 'กรอกรายการ';
    if(!(e.amount>0 || e.vat>0)) return 'กรอกจำนวนเงิน';
    if(e.amount+e.vat-e.wht<0) return LG_ERR.wht_over_amount;
    return '';
  }
  return { fill:fill, read:read, check:check, focus:function(){ f('description').focus(); } };
}

// ---------------- 📒 สมุดรายรับ-รายจ่าย ----------------
function lgBookHtml(){
  var side=function(cls){ return '<th class="num '+cls+'">ก่อนหักภาษี</th><th class="num '+cls+'">VAT 7%</th><th class="num '+cls+'">ภงด.3</th><th class="num '+cls+'">ภงด.53</th><th class="num '+cls+' lg-netcol">สุทธิ</th>'; };
  return '<div class="toolbar">'+
      '<label style="display:flex;align-items:center;gap:6px">เดือน <input type="month" id="lg-b-month"></label>'+
      '<select id="lg-b-dir"><option value="">รายรับ + รายจ่าย</option><option value="in">เฉพาะรายรับ</option><option value="out">เฉพาะรายจ่าย</option></select>'+
      '<input id="lg-b-search" type="text" class="grow" placeholder="ค้นหา รายการ / ผู้รับ-ผู้จ่าย / หมายเหตุ / เลขใบสำคัญ">'+
      '<button id="lg-b-reload" class="btn btn-ghost btn-sm">โหลดใหม่</button>'+
      '<button id="lg-b-print" class="btn btn-ghost btn-sm">🖨 พิมพ์สมุด</button>'+
      '<button id="lg-b-excel" class="btn btn-ghost btn-sm">⬇ Excel</button>'+
    '</div>'+
    '<div id="lg-b-stats" class="stats"></div>'+
    '<div class="lg-selbar">'+
      '<button id="lg-b-add" class="btn btn-primary btn-sm">➕ เพิ่มแถว</button>'+
      '<span id="lg-b-picked" class="muted">เลือกไว้ 0 รายการ</span><span class="grow" style="min-width:0"></span>'+
      '<button id="lg-b-issue" class="btn btn-ok btn-sm" disabled>🧾 ออกใบสำคัญรับ / จ่าย</button>'+
      '<button id="lg-b-vprint" class="btn btn-ghost btn-sm" disabled>🖨 พิมพ์ใบสำคัญที่เลือก</button>'+
      '<button id="lg-b-vcancel" class="btn btn-ghost btn-sm" disabled>↩️ ยกเลิกใบสำคัญ</button>'+
      '<button id="lg-b-del" class="btn btn-ghost btn-sm" disabled style="color:#b91c1c">🗑 ลบ</button>'+
    '</div>'+
    '<div class="tablewrap lg-book"><table class="inv-tbl"><thead>'+
      '<tr><th rowspan="2" style="width:34px"><input type="checkbox" id="lg-b-all" title="เลือกทั้งหมด"></th><th rowspan="2">วันที่</th><th rowspan="2">รายการ</th>'+
        '<th colspan="5" class="lg-in-h" style="text-align:center">รายรับ (บาท)</th><th colspan="5" class="lg-out-h" style="text-align:center">รายจ่าย (บาท)</th>'+
        '<th rowspan="2">หมายเหตุ</th><th rowspan="2">ใบสำคัญ</th><th rowspan="2"></th></tr>'+
      '<tr>'+side('lg-in-h')+side('lg-out-h')+'</tr></thead>'+
      '<tbody id="lg-b-body"><tr><td colspan="'+LG_COLS+'" class="muted">กำลังโหลด…</td></tr></tbody><tfoot id="lg-b-foot"></tfoot></table></div>'+
    '<div class="muted" style="font-size:12px;margin-top:8px">ออกใบสำคัญ: 1 รายการ = 1 ใบ (รายจ่าย → ใบสำคัญจ่าย PV / รายรับ → ใบสำคัญรับ RV) วันที่ในใบ = วันที่ของรายการ • '+
      'รายการที่ออกใบแล้ว (🔒) แก้/ลบได้หลังยกเลิกใบสำคัญ • VAT ซื้อมีอายุใช้สิทธิ์ 6 เดือน</div>';
}
function lgBookBind(){
  $('lg-b-month').value=lgToday().slice(0,7);
  $('lg-b-month').addEventListener('change', function(){ lg.editing=''; lgBookLoad(); });
  $('lg-b-reload').addEventListener('click', function(){ lg.editing=''; lgBookLoad(); });
  $('lg-b-dir').addEventListener('change', lgBookRender);
  $('lg-b-search').addEventListener('input', lgBookRender);
  $('lg-b-print').addEventListener('click', lgBookPrint);
  $('lg-b-excel').addEventListener('click', lgBookExcel);
  $('lg-b-add').addEventListener('click', function(){ lgEditRow('new'); });
  $('lg-b-all').addEventListener('change', function(){
    var on=this.checked;
    Array.prototype.forEach.call($('lg-b-body').querySelectorAll('.lg-pick'), function(cb){ cb.checked=on; });
    lgBookPicked();
  });
  $('lg-b-body').addEventListener('change', function(e){ if(e.target.classList.contains('lg-pick')) lgBookPicked(); });
  $('lg-b-issue').addEventListener('click', lgIssueDialog);
  $('lg-b-vprint').addEventListener('click', function(){
    var nums=lgUniq(lgPicked().map(function(r){ return r.voucherNo; }));
    if(nums.length) lgVoucherPdf(nums, nums.length>1 ? 'ใบสำคัญ '+nums.length+' ใบ' : nums[0]);
  });
  $('lg-b-vcancel').addEventListener('click', function(){
    var nums=lgUniq(lgPicked().map(function(r){ return r.voucherNo; }));
    if(!nums.length || !confirm('ยกเลิกใบสำคัญ '+nums.length+' ใบ?\n'+nums.join(', ')+'\n\nรายการจะกลับไปเป็น "ยังไม่ออกใบสำคัญ" (ไม่ถูกลบ) แก้ไขหรือออกใบใหม่ได้')) return;
    api({ action:'voucherCancel', token:state.token, numbers:nums }).then(function(res){
      if(!lgOk(res)) return;
      if(!res.ok){ alert('ยกเลิกไม่สำเร็จ: '+lgErr(res)); return; }
      toast('ยกเลิกใบสำคัญ '+res.numbers.length+' ใบแล้ว'); lgBookLoad();
    });
  });
  $('lg-b-del').addEventListener('click', function(){
    var rows=lgPicked().filter(function(r){ return !r.voucherNo; });
    if(!rows.length || !confirm('ลบ '+rows.length+' รายการที่เลือก?'+(rows.length<lgPicked().length ? '\n(รายการที่ออกใบสำคัญแล้วจะไม่ถูกลบ)' : ''))) return;
    api({ action:'ledgerDelete', token:state.token, ids:rows.map(function(r){ return r.id; }) }).then(function(res){
      if(!lgOk(res)) return;
      if(!res.ok){ alert('ลบไม่สำเร็จ: '+lgErr(res)); return; }
      toast('ลบ '+res.count+' รายการแล้ว'); lgBookLoad();
    });
  });
  $('lg-b-body').addEventListener('click', function(e){
    var b=e.target.closest('[data-act]'); if(!b) return;
    var row=lg.book.filter(function(r){ return r.id===b.getAttribute('data-id'); })[0];
    if(!row) return;
    var act=b.getAttribute('data-act');
    if(act==='edit') lgEditRow(row.id);
    if(act==='del') lgDelete(row);
    if(act==='pdf') lgVoucherPdf([row.voucherNo]);
  });
}
function lgUniq(list){ var seen={}; return list.filter(function(v){ if(!v || seen[v]) return false; seen[v]=1; return true; }); }
function lgBookLoad(){
  var range=lgMonthRange(lgYm($('lg-b-month')));
  if(!lg.editing) $('lg-b-body').innerHTML='<tr><td colspan="'+LG_COLS+'" class="muted">กำลังโหลด…</td></tr>';
  return lgFetch(range.from, range.to).then(function(res){
    if(!res.ok){ $('lg-b-body').innerHTML='<tr><td colspan="'+LG_COLS+'" class="muted">โหลดไม่สำเร็จ: '+esc(lgErr(res))+'</td></tr>'; return; }
    lg.book=res.rows;
    lgBookRender();
  });
}
function lgBookFiltered(){
  var dir=$('lg-b-dir').value, q=$('lg-b-search').value.trim().toLowerCase();
  return lg.book.filter(function(r){
    return (!dir || r.direction===dir) && (!q || [r.description, r.party, r.note, r.voucherNo, lgPayText(r)].join(' ').toLowerCase().indexOf(q)>=0);
  });
}
/** ยอดรวมแต่ละคอลัมน์ของสมุด (แยกรายรับ / รายจ่าย / ภงด.3 / ภงด.53) */
function lgBookTotals(rows){
  var t={ in:{ amount:0, vat:0, pnd3:0, pnd53:0, net:0, n:0 }, out:{ amount:0, vat:0, pnd3:0, pnd53:0, net:0, n:0 } };
  rows.forEach(function(r){
    var s=t[r.direction]; s.n++;
    s.amount+=r.amount; s.vat+=r.vat; s.net+=r.net;
    if(r.whtType) s[r.whtType]+=r.wht;
  });
  return t;
}
function lgBookCells(r, dir){
  if(r.direction!==dir) return '<td></td><td></td><td></td><td></td><td class="lg-netcol"></td>';
  var z=function(n){ return n ? baht(n) : '<span class="muted">0.00</span>'; };
  return '<td class="num">'+z(r.amount)+'</td><td class="num">'+z(r.vat)+'</td><td class="num">'+z(r.whtType==='pnd3' ? r.wht : 0)+'</td>'+
    '<td class="num">'+z(r.whtType==='pnd53' ? r.wht : 0)+'</td><td class="num lg-netcol"><b>'+baht(r.net)+'</b></td>';
}
function lgBookNote(r){ return [r.payMethod==='cash' ? 'เงินสด' : (r.payMethod==='cheque' ? 'เช็ค'+(r.payRef?' '+r.payRef:'') : ''), r.note].filter(Boolean).join(' • '); }
function lgBookRender(){
  var rows=lgBookFiltered(), t=lgBookTotals(rows), ym=lgYm($('lg-b-month'));
  var stat=function(n, l, color){ return '<div class="stat"><div class="n" style="font-size:22px'+(color?';color:'+color:'')+'">'+n+'</div><div class="l">'+l+'</div></div>'; };
  $('lg-b-stats').innerHTML=
    stat(baht(t.in.net), 'รายรับสุทธิ ('+t.in.n+' รายการ)', '#15803d')+
    stat(baht(t.out.net), 'รายจ่ายสุทธิ ('+t.out.n+' รายการ)', '#b91c1c')+
    stat(baht(t.in.net-t.out.net), 'รายรับ − รายจ่าย • '+lgMonthLabel(ym))+
    stat(baht(t.out.vat), 'ภาษีซื้อ (VAT รายจ่าย)')+
    stat(baht(t.out.pnd3+t.out.pnd53), 'หัก ณ ที่จ่ายที่ต้องนำส่ง (ภงด.3 '+baht(t.out.pnd3)+' / ภงด.53 '+baht(t.out.pnd53)+')');
  var html=rows.map(function(r){
    if(lg.editing===r.id) return lgEditRowHtml();
    return '<tr><td><input type="checkbox" class="lg-pick" data-id="'+r.id+'"></td><td style="white-space:nowrap">'+lgDmy(r.entryDate)+'</td>'+
      '<td style="min-width:200px">'+esc(r.description)+(r.party?'<div class="sub">'+(r.direction==='in'?'รับจาก ':'จ่ายให้ ')+esc(r.party)+'</div>':'')+'</td>'+
      lgBookCells(r, 'in')+lgBookCells(r, 'out')+
      '<td style="font-size:12px">'+esc(lgBookNote(r))+'</td>'+
      '<td>'+(r.voucherNo ? '<button class="btn btn-ghost btn-sm mono" data-act="pdf" data-id="'+r.id+'" title="เปิดใบสำคัญ">🔒 '+esc(r.voucherNo)+'</button>' : '<span class="muted">—</span>')+'</td>'+
      '<td class="acts">'+(r.voucherNo ? '' : '<button class="btn btn-ghost btn-sm" data-act="edit" data-id="'+r.id+'">แก้ไข</button>'+
        '<button class="btn btn-ghost btn-sm" data-act="del" data-id="'+r.id+'" style="color:#b91c1c">ลบ</button>')+'</td></tr>';
  }).join('');
  if(lg.editing==='new') html+=lgEditRowHtml();
  $('lg-b-body').innerHTML=html || '<tr><td colspan="'+LG_COLS+'" class="muted" style="padding:20px">ยังไม่มีรายการในเดือนนี้ — กด "➕ เพิ่มแถว"</td></tr>';
  var f=function(s){ return '<td class="num">'+baht(s.amount)+'</td><td class="num">'+baht(s.vat)+'</td><td class="num">'+baht(s.pnd3)+'</td><td class="num">'+baht(s.pnd53)+'</td><td class="num lg-netcol">'+baht(s.net)+'</td>'; };
  $('lg-b-foot').innerHTML=rows.length ? '<tr class="lg-total"><td colspan="3">รวม '+rows.length+' รายการ</td>'+f(t.in)+f(t.out)+'<td colspan="3"></td></tr>' : '';
  $('lg-b-all').checked=false;
  lgBookPicked();
  if(lg.editing) lgEditRowBind();
}
function lgPicked(){
  return Array.prototype.map.call($('lg-b-body').querySelectorAll('.lg-pick:checked'), function(cb){
    var id=cb.getAttribute('data-id'); return lg.book.filter(function(r){ return r.id===id; })[0];
  }).filter(Boolean);
}
function lgBookPicked(){
  var p=lgPicked(), open=p.filter(function(r){ return !r.voucherNo; }), done=p.filter(function(r){ return r.voucherNo; });
  $('lg-b-picked').textContent='เลือกไว้ '+p.length+' รายการ'+(p.length ? ' • ยังไม่ออกใบ '+open.length+' • ออกใบแล้ว '+done.length : '');
  $('lg-b-issue').disabled=!open.length;
  $('lg-b-issue').textContent='🧾 ออกใบสำคัญรับ / จ่าย'+(open.length ? ' ('+open.length+' ใบ)' : '');
  $('lg-b-vprint').disabled=!done.length; $('lg-b-vcancel').disabled=!done.length;
  $('lg-b-del').disabled=!open.length;
}

/** เปิดแถวกรอก/แก้ไขในตาราง (ครั้งละแถว) — id = 'new' คือแถวใหม่ท้ายตาราง */
function lgEditRow(id){
  lg.editing=id;
  lgBookRender();
}
function lgEditRowHtml(){ return '<tr class="lg-editrow"><td colspan="'+LG_COLS+'">'+lgRowFormHtml()+'</td></tr>'; }
function lgEditRowBind(){
  var tr=$('lg-b-body').querySelector('.lg-editrow'); if(!tr) return;
  var form=lgForm(tr), msg=tr.querySelector('[data-l="msg"]'), id=lg.editing;
  var row=lg.book.filter(function(r){ return r.id===id; })[0];
  if(row) form.fill(row);
  else {
    var ym=lgYm($('lg-b-month')), today=lgToday();
    form.fill({ direction:'out', entryDate: lg.lastDate && lg.lastDate.slice(0,7)===ym ? lg.lastDate : (today.slice(0,7)===ym ? today : ym+'-01'), payMethod:'transfer' });
  }
  form.focus();
  tr.scrollIntoView({ block:'nearest' });
  function save(){
    var e=form.read(), problem=form.check(e);
    if(problem){ msg.textContent='⚠️ '+problem; msg.className='lg-msg err'; return; }
    if(row) e.id=row.id;
    var btn=tr.querySelector('[data-x="save"]'); btn.disabled=true;
    api({ action:'ledgerSave', token:state.token, entry:e }).then(function(res){
      btn.disabled=false;
      if(!lgOk(res)) return;
      if(!res.ok){ msg.textContent='⚠️ บันทึกไม่สำเร็จ: '+lgErr(res); msg.className='lg-msg err'; return; }
      lg.lastDate=res.entry.entryDate;
      toast('บันทึก "'+res.entry.description+'" '+baht(res.entry.net)+' บาทแล้ว');
      // แถวใหม่: บันทึกแล้วเปิดแถวถัดไปให้กรอกต่อทันที (กด ✖ / Esc เพื่อหยุด)
      lg.editing = row ? '' : 'new';
      lgBookLoad();
    }).catch(function(err){ btn.disabled=false; msg.textContent='⚠️ บันทึกไม่สำเร็จ: '+(err && err.message || err); msg.className='lg-msg err'; });
  }
  tr.addEventListener('click', function(e){
    var b=e.target.closest('[data-x]'); if(!b) return;
    if(b.getAttribute('data-x')==='save') save();
    if(b.getAttribute('data-x')==='cancel'){ lg.editing=''; lgBookRender(); }
  });
  tr.addEventListener('keydown', function(e){
    if(e.key==='Enter' && e.target.tagName==='INPUT'){ e.preventDefault(); save(); }
    if(e.key==='Escape'){ lg.editing=''; lgBookRender(); }
  });
}
function lgDelete(row){
  if(!confirm('ลบรายการนี้?\n\n'+lgDmy(row.entryDate)+' '+row.description+'\nสุทธิ '+baht(row.net)+' บาท')) return;
  api({ action:'ledgerDelete', token:state.token, ids:[row.id] }).then(function(res){
    if(!lgOk(res)) return;
    if(!res.ok){ alert('ลบไม่สำเร็จ: '+lgErr(res)); return; }
    toast('ลบรายการแล้ว'); lgBookLoad();
  });
}

/** ออกใบสำคัญจากรายการที่เลือก (ทีละหลายใบ) — เลขเริ่มต้น PV / RV แก้ได้ แล้วเปิด PDF ทุกใบในไฟล์เดียว */
function lgIssueDialog(){
  var rows=lgPicked().filter(function(r){ return !r.voucherNo; });
  if(!rows.length) return;
  if(rows.length>300){ alert(LG_ERR.too_many_lines); return; }
  var by={ PV:rows.filter(function(r){ return r.direction==='out'; }), RV:rows.filter(function(r){ return r.direction==='in'; }) };
  var sum=function(list){ return list.reduce(function(t, r){ return t+r.net; }, 0); };
  var bg=document.createElement('div'); bg.className='modal-bg';
  var block=function(kind){
    var list=by[kind], k=LG_KIND[kind];
    if(!list.length) return '';
    return '<div class="lg-issue-k"><div><b>'+k.name+' ('+kind+')</b> '+list.length+' ใบ • สุทธิรวม '+baht(sum(list))+' บาท</div>'+
      '<label class="lg-field" style="flex:0 0 220px"><span class="lg-lbl">เลขที่เริ่มต้น</span><input type="text" class="mono" data-start="'+kind+'" maxlength="20" placeholder="กำลังหาเลขถัดไป…"></label></div>';
  };
  bg.innerHTML='<div class="modal" style="max-width:640px;width:97%">'+
    '<h3 style="margin-top:0">🧾 ออกใบสำคัญ '+rows.length+' ใบ</h3>'+
    '<p class="muted" style="margin:-6px 0 12px;font-size:13px">1 รายการ = 1 ใบ • วันที่ในใบ = วันที่ของรายการ • เลขรันเรียงตามวันที่ ต่อจากเลขเริ่มต้น (ข้ามเลขที่มีอยู่แล้ว) • ได้ PDF ไฟล์เดียวพร้อมพิมพ์</p>'+
    block('PV')+block('RV')+
    '<div class="lg-field" style="margin-top:10px"><span class="lg-lbl">ผู้จัดทำ</span><input type="text" id="lgi-by" maxlength="120" value="'+esc((state.user && state.user.name)||'')+'"></div>'+
    '<div id="lgi-hint" class="muted" style="font-size:12px;margin-top:8px">เลขเริ่มต้นแก้ได้ ถ้าเดือนนี้เคยออกใบจาก Excel ไปแล้ว (พิมพ์แค่เลขรัน เช่น 38 ก็ได้)</div>'+
    '<div id="lgi-msg" class="lg-msg"></div>'+
    '<div class="actions" style="margin-top:12px"><button class="btn btn-ghost" data-x="close">ยกเลิก</button>'+
      '<button class="btn btn-primary" data-x="issue">✅ ออกใบสำคัญ + เปิด PDF</button></div></div>';
  document.body.appendChild(bg);
  var q=function(s){ return bg.querySelector(s); };
  // เลขถัดไปของเดือนแรกในรายการที่เลือก
  ['PV','RV'].forEach(function(kind){
    if(!by[kind].length) return;
    var first=by[kind].reduce(function(m, r){ return r.entryDate<m ? r.entryDate : m; }, by[kind][0].entryDate);
    api({ action:'voucherNext', token:state.token, kind:kind, voucherDate:first }).then(function(res){
      var input=q('[data-start="'+kind+'"]'); if(res.ok && input && !input.value) input.value=res.number;
    });
  });
  function startOf(kind){
    var input=q('[data-start="'+kind+'"]'); if(!input) return '';
    var v=input.value.trim().toUpperCase();
    if(/^\d{1,3}$/.test(v) && Number(v)>0){
      var first=by[kind].reduce(function(m, r){ return r.entryDate<m ? r.entryDate : m; }, by[kind][0].entryDate);
      v=kind+first.slice(0,7).replace('-','')+String(Number(v)).padStart(2,'0'); input.value=v;
    }
    return v;
  }
  bg.addEventListener('click', function(e){
    if(e.target===bg) return bg.remove();
    var b=e.target.closest('[data-x]'); if(!b) return;
    if(b.getAttribute('data-x')==='close') return bg.remove();
    var starts={ PV:startOf('PV'), RV:startOf('RV') };
    b.disabled=true;
    lgPdf(api({ action:'voucherIssue', token:state.token, entryIds:rows.map(function(r){ return r.id; }), starts:starts, preparedBy:q('#lgi-by').value.trim() }).then(function(res){
      b.disabled=false;
      if(!lgOk(res)) return null;
      if(!res.ok){ q('#lgi-msg').textContent='⚠️ ออกใบสำคัญไม่สำเร็จ: '+lgErr(res); q('#lgi-msg').className='lg-msg err'; return null; }
      bg.remove(); toast('ออกใบสำคัญ '+res.numbers.length+' ใบแล้ว ('+res.numbers[0]+(res.numbers.length>1 ? ' – '+res.numbers[res.numbers.length-1] : '')+')', 4000);
      lgBookLoad();
      return api({ action:'voucherGet', token:state.token, numbers:res.numbers }).then(function(r){ return r.ok ? { vouchers:r.vouchers, company:r.company } : null; });
    }).catch(function(err){ b.disabled=false; throw err; }), 'ใบสำคัญ '+lgMonthLabel(lgYm($('lg-b-month'))));
  });
}

// ---------------- ⚙️ ตั้งค่ารายการ ----------------
function lgPresetHtml(){
  return '<p class="muted" style="margin:0 0 12px">ตั้งรายการที่ใช้บ่อย ผูกกับผู้รับเงิน / ยอดเงิน / VAT / หัก ณ ที่จ่าย — ตอนกรอกในสมุด เลือกรายการแล้วข้อมูลเติมให้เอง (แก้ทีหลังได้ทุกช่อง) • '+
      'ยอดเงินเว้นว่างได้ถ้าแต่ละเดือนไม่เท่ากัน (เช่น ค่าไฟ)</p>'+
    '<div class="toolbar"><button id="lg-p-add" class="btn btn-ghost btn-sm">➕ เพิ่มรายการ</button>'+
      '<input id="lg-p-search" type="text" class="grow" placeholder="ค้นหารายการ / ผู้รับเงิน">'+
      '<span id="lg-p-dirty" class="muted" style="font-size:12px"></span>'+
      '<button id="lg-p-save" class="btn btn-primary btn-sm">💾 บันทึกการตั้งค่า</button></div>'+
    '<div class="tablewrap"><table class="inv-tbl lg-preset-tbl"><thead><tr><th class="no">#</th><th>ประเภท</th><th>รายการ</th><th>ผู้รับเงิน / ผู้จ่าย</th>'+
      '<th class="num">ยอดก่อนภาษี</th><th>VAT 7%</th><th>หัก ณ ที่จ่าย</th><th>วิธีชำระ</th><th>หมายเหตุ</th><th class="num">สุทธิ</th><th></th></tr></thead>'+
      '<tbody id="lg-p-body"><tr><td colspan="11" class="muted">กำลังโหลด…</td></tr></tbody></table></div>'+
    '<div id="lg-p-msg" class="lg-msg"></div>';
}
function lgPresetBind(){
  $('lg-p-add').addEventListener('click', function(){
    lg.presetDraft.push({ id:'', direction:'out', description:'', party:'', amount:0, hasVat:false, whtType:'', whtRate:3, payMethod:'transfer', payRef:'', note:'' });
    $('lg-p-search').value=''; lgPresetDirty(true); lgPresetRender();
    var inputs=$('lg-p-body').querySelectorAll('[data-k="description"]'); if(inputs.length) inputs[inputs.length-1].focus();
  });
  $('lg-p-search').addEventListener('input', lgPresetRender);
  $('lg-p-save').addEventListener('click', lgPresetSave);
  $('lg-p-body').addEventListener('input', lgPresetEdit);
  $('lg-p-body').addEventListener('change', lgPresetEdit);
  $('lg-p-body').addEventListener('click', function(e){
    var b=e.target.closest('[data-del]'); if(!b) return;
    var p=lg.presetDraft[+b.getAttribute('data-del')];
    if(p.description && !confirm('ลบรายการ "'+p.description+'" ออกจากการตั้งค่า?')) return;
    lg.presetDraft.splice(+b.getAttribute('data-del'), 1); lgPresetDirty(true); lgPresetRender();
  });
}
function lgPresetDirty(on){ lg.presetDirty=on; $('lg-p-dirty').textContent=on ? '● ยังไม่ได้บันทึก' : ''; }
function lgPresetLoad(){
  var range=lgMonthRange(lgToday().slice(0,7));
  lgFetch(range.from, range.to).then(function(res){
    if(!res.ok){ $('lg-p-body').innerHTML='<tr><td colspan="11" class="muted">โหลดไม่สำเร็จ: '+esc(lgErr(res))+'</td></tr>'; return; }
    lg.presetDraft=JSON.parse(JSON.stringify(lg.presets)); lgPresetDirty(false);
    lgPresetRender();
  });
}
function lgPresetNet(p){
  var a=Number(p.amount)||0; return lgRound(a+(p.hasVat ? a*LG_VAT : 0)-(p.whtType ? a*(Number(p.whtRate)||0)/100 : 0));
}
function lgPresetRender(){
  var q=$('lg-p-search').value.trim().toLowerCase();
  var sel=function(k, value, opts){ return '<select data-k="'+k+'">'+opts.map(function(o){ return '<option value="'+o[0]+'"'+(String(value)===String(o[0])?' selected':'')+'>'+o[1]+'</option>'; }).join('')+'</select>'; };
  var rows=lg.presetDraft.map(function(p, i){ return [p, i]; }).filter(function(x){
    return !q || (x[0].description+' '+x[0].party).toLowerCase().indexOf(q)>=0;
  });
  $('lg-p-body').innerHTML=rows.length ? rows.map(function(x){
    var p=x[0], i=x[1];
    return '<tr data-i="'+i+'"><td class="no">'+(i+1)+'</td>'+
      '<td>'+sel('direction', p.direction, [['out','รายจ่าย'],['in','รายรับ']])+'</td>'+
      '<td><input type="text" data-k="description" value="'+esc(p.description)+'" maxlength="300" placeholder="เช่น ค่าบริการบัญชี" style="min-width:200px"></td>'+
      '<td><input type="text" data-k="party" value="'+esc(p.party)+'" list="lg-party-list" maxlength="200" placeholder="เช่น บริษัท โสภาการบัญชี จำกัด" style="min-width:200px"></td>'+
      '<td><input type="number" data-k="amount" value="'+(p.amount||'')+'" min="0" step="0.01" placeholder="ไม่กำหนด" style="width:110px;text-align:right"></td>'+
      '<td style="text-align:center"><input type="checkbox" data-k="hasVat"'+(p.hasVat?' checked':'')+'></td>'+
      '<td style="white-space:nowrap">'+sel('whtType', p.whtType, [['','ไม่หัก'],['pnd3','ภงด.3'],['pnd53','ภงด.53']])+' '+
        (p.whtType ? sel('whtRate', p.whtRate||3, [[1,'1%'],[2,'2%'],[3,'3%'],[5,'5%']]) : '')+'</td>'+
      '<td style="white-space:nowrap">'+sel('payMethod', p.payMethod||'transfer', [['transfer','เงินโอน'],['cash','เงินสด'],['cheque','เช็ค']])+'</td>'+
      '<td><input type="text" data-k="note" value="'+esc(p.note)+'" maxlength="300" style="min-width:120px"></td>'+
      '<td class="num" data-l="net">'+(p.amount ? baht(lgPresetNet(p)) : '<span class="muted">—</span>')+'</td>'+
      '<td><button class="btn btn-ghost btn-sm" data-del="'+i+'" style="color:#b91c1c">ลบ</button></td></tr>';
  }).join('') : '<tr><td colspan="11" class="muted" style="padding:20px">'+(q ? 'ไม่พบรายการ' : 'ยังไม่มีรายการตั้งค่า — กด "➕ เพิ่มรายการ"')+'</td></tr>';
}
function lgPresetEdit(e){
  var el=e.target, k=el.getAttribute('data-k'), tr=el.closest('tr[data-i]'); if(!k || !tr) return;
  var p=lg.presetDraft[+tr.getAttribute('data-i')];
  p[k] = el.type==='checkbox' ? el.checked : (k==='amount' || k==='whtRate' ? Number(el.value)||0 : el.value);
  if(k==='whtType' && p.whtType && !p.whtRate) p.whtRate=3;
  lgPresetDirty(true);
  if(k==='whtType' && e.type==='change') return lgPresetRender();
  tr.querySelector('[data-l="net"]').innerHTML=p.amount ? baht(lgPresetNet(p)) : '<span class="muted">—</span>';
}
function lgPresetSave(){
  var msg=$('lg-p-msg'), btn=$('lg-p-save');
  var empty=lg.presetDraft.filter(function(p){ return !String(p.description||'').trim(); }).length;
  if(empty && !confirm(empty+' แถวยังไม่มีชื่อรายการ — แถวเหล่านี้จะไม่ถูกบันทึก ดำเนินการต่อ?')) return;
  btn.disabled=true;
  api({ action:'ledgerPresetsSave', token:state.token, presets:lg.presetDraft }).then(function(res){
    btn.disabled=false;
    if(!lgOk(res)) return;
    if(!res.ok){ msg.textContent='⚠️ บันทึกไม่สำเร็จ: '+lgErr(res); msg.className='lg-msg err'; return; }
    lg.presets=res.presets; lg.presetDraft=JSON.parse(JSON.stringify(res.presets)); lgPresetDirty(false);
    lgFillLists(); lgPresetRender();
    msg.textContent='✅ บันทึกการตั้งค่า '+res.presets.length+' รายการแล้ว'; msg.className='lg-msg ok';
  }).catch(function(err){ btn.disabled=false; msg.textContent='⚠️ บันทึกไม่สำเร็จ: '+(err && err.message || err); msg.className='lg-msg err'; });
}

/** เปิด PDF ใบสำคัญ — เปิดหน้าต่างก่อน (ไม่งั้นเบราว์เซอร์บล็อก) แล้วค่อยใส่ไฟล์ */
function lgPdf(promise, name){
  var popup=window.open('', '_blank', 'popup,width=900,height=1000');
  if(popup){ popup.document.body.textContent='กำลังเตรียม PDF…'; popup.document.body.style.margin='0'; }
  return promise.then(function(pack){
    if(!pack){ if(popup) popup.close(); return; }
    return VoucherPDF.create(pack.vouchers, pack.company).then(function(blob){
      var url=URL.createObjectURL(blob), file=String(name).replace(/[\\/:*?"<>|]/g,'-')+'.pdf';
      if(popup && !popup.closed){
        popup.document.title=file;
        popup.document.body.innerHTML='<a href="'+url+'" download="'+esc(file)+'" style="display:block;padding:12px;background:#edf2ff;font:14px Tahoma">ดาวน์โหลด '+esc(file)+'</a>'+
          '<iframe src="'+url+'" style="width:100%;height:calc(100vh - 50px);border:0"></iframe>';
      } else {
        // เบราว์เซอร์บล็อกหน้าต่างใหม่ — ดาวน์โหลดไฟล์แทน
        var a=document.createElement('a'); a.href=url; a.download=file; document.body.appendChild(a); a.click(); a.remove();
      }
    });
  }).catch(function(e){
    var msg='สร้าง PDF ไม่สำเร็จ: '+(e && e.message || e);
    if(popup && !popup.closed) popup.document.body.textContent=msg; else alert(msg);
  });
}
function lgVoucherPdf(numbers, name){
  return lgPdf(api({ action:'voucherGet', token:state.token, numbers:numbers }).then(function(res){
    if(!lgOk(res)) return null;
    if(!res.ok){ alert('เปิดใบสำคัญไม่สำเร็จ: '+lgErr(res)); return null; }
    return { vouchers:res.vouchers, company:res.company };
  }), name || numbers.join('_'));
}

/** พิมพ์ / บันทึก PDF — หน้าตาเดียวกับสมุดรายรับ-รายจ่ายที่ฝ่ายบัญชีทำใน Excel */
function lgBookPrint(){
  var rows=lgBookFiltered(), t=lgBookTotals(rows), ym=lgYm($('lg-b-month')), co=lg.company||{};
  var w=window.open('', '_blank');
  if(!w){ alert('เบราว์เซอร์บล็อกหน้าต่างใหม่ — อนุญาต popup ก่อน'); return; }
  var m=function(n){ return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
  var filter=[$('lg-b-dir').value==='in' ? 'เฉพาะรายรับ' : ($('lg-b-dir').value==='out' ? 'เฉพาะรายจ่าย' : ''), $('lg-b-search').value.trim() ? 'ค้นหา "'+$('lg-b-search').value.trim()+'"' : ''].filter(Boolean).join(' • ');
  var side=function(r, dir){
    if(r.direction!==dir) return '<td></td><td></td><td></td><td></td><td class="net"></td>';
    return '<td class="r">'+m(r.amount)+'</td><td class="r">'+m(r.vat)+'</td><td class="r">'+m(r.whtType==='pnd3'?r.wht:0)+'</td><td class="r">'+m(r.whtType==='pnd53'?r.wht:0)+'</td><td class="r net">'+m(r.net)+'</td>';
  };
  var tot=function(s){ return '<td class="r">'+m(s.amount)+'</td><td class="r">'+m(s.vat)+'</td><td class="r">'+m(s.pnd3)+'</td><td class="r">'+m(s.pnd53)+'</td><td class="r">'+m(s.net)+'</td>'; };
  var sub='<th>จำนวนเงิน<br>(ก่อนหักภาษี)</th><th>vat 7%</th><th>WHT<br>ภงด. 3</th><th>WHT<br>ภงด. 53</th><th class="net">จำนวนเงินสุทธิ</th>';
  var title='รายการ บัญชีรายรับ-รายจ่าย', month='เดือน '+lgMonthLabel(ym);
  var html='<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><title>'+esc(title+' '+month)+'</title><style>'+
    '@font-face{font-family:Sarabun;src:url("/fonts/Sarabun-Regular.ttf");font-weight:400}'+
    '@font-face{font-family:Sarabun;src:url("/fonts/Sarabun-SemiBold.ttf");font-weight:600}'+
    '@font-face{font-family:Sarabun;src:url("/fonts/Sarabun-Bold.ttf");font-weight:700}'+
    '@page{size:A4 portrait;margin:8mm 7mm 10mm}'+
    '*{box-sizing:border-box}body{margin:0;font-family:Sarabun,sans-serif;color:#000;font-size:9px;background:#eef1f5}'+
    '.page{background:#fff;max-width:210mm;margin:16px auto;padding:8mm 7mm;box-shadow:0 2px 12px rgba(0,0,0,.12)}'+
    '.co{text-align:center;line-height:1.4}.co img{height:46px;display:block;margin:0 auto 2px}.co b{font-size:11px}'+
    'table{width:100%;border-collapse:collapse;margin-top:6px}th,td{border:1px solid #000;padding:2px 4px;vertical-align:middle}'+
    '.band{background:#4a86e8;text-align:center;font-weight:700;font-size:16px;line-height:1.25;padding:10px 4px}'+
    'thead th{background:#9fc5e8;font-weight:700;text-align:center;font-size:9px}thead tr.sub th{font-size:8px;font-weight:600}'+
    '.net{background:#ffff00}.r{text-align:right;white-space:nowrap}.c{text-align:center;white-space:nowrap}'+
    'tfoot td{font-weight:700;font-size:10px;padding:5px 4px}tfoot .lbl{background:#ffff00;text-align:center}'+
    '.note{color:#c00;text-align:center}.filter{text-align:center;color:#444;margin-top:2px}.foot{margin-top:10px;font-size:10px}'+
    'thead{display:table-header-group}tr{page-break-inside:avoid}'+
    '.bar{position:sticky;top:0;background:#0B2A52;color:#fff;padding:10px 16px;display:flex;gap:10px;align-items:center;z-index:2;font-size:14px}'+
    '.bar button{border:0;border-radius:8px;padding:8px 14px;font:600 14px Sarabun,sans-serif;cursor:pointer}'+
    '@media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;padding:0}.bar{display:none}}'+
    '</style></head><body>'+
    '<div class="bar"><b style="flex:1">'+esc(title+' '+month)+'</b><button onclick="window.print()">🖨 พิมพ์ / บันทึก PDF</button></div>'+
    '<div class="page">'+
      '<div class="co">'+(co.logoUrl?'<img src="'+esc(co.logoUrl)+'" onerror="this.remove()">':'')+'<b>'+esc(co.name||'')+'</b><br>'+esc(String(co.address||'').replace(/^ที่อยู่\s*/,''))+' เลขประจำตัวผู้เสียภาษี : '+esc(co.taxId||'')+'</div>'+
      (filter?'<div class="filter">('+esc(filter)+')</div>':'')+
      '<table><thead>'+
        '<tr><th colspan="13" class="band">'+esc(title)+'<br>'+esc(month)+'</th></tr>'+
        '<tr><th rowspan="2" style="width:58px">วัน / เดือน / ปี</th><th rowspan="2">รายการ</th><th colspan="5">รายรับ (บาท)</th><th colspan="5">รายจ่าย (บาท)</th><th rowspan="2" style="width:60px">หมายเหตุ</th></tr>'+
        '<tr class="sub">'+sub+sub.replace('vat 7%','vat 7% [1]')+'</tr></thead><tbody>'+
      rows.map(function(r){
        return '<tr><td class="c">'+lgDmy(r.entryDate)+'</td><td>'+esc(r.description)+'</td>'+side(r,'in')+side(r,'out')+'<td class="note">'+esc(lgBookNote(r))+'</td></tr>';
      }).join('')+
      '</tbody><tfoot><tr><td colspan="2" class="lbl">รวม</td>'+tot(t.in)+tot(t.out)+'<td></td></tr></tfoot></table>'+
      '<div class="foot">[1] vat มีอายุ 6 เดือน</div>'+
    '</div></body></html>';
  w.document.open(); w.document.write(html); w.document.close();
}
/** Excel คอลัมน์เดียวกับสมุดที่พิมพ์ + ผู้รับ/ผู้จ่าย วิธีชำระ เลขใบสำคัญ */
function lgBookExcel(){
  if(!window.XLSX){ alert('ตัวสร้างไฟล์ Excel ยังไม่โหลด (ต้องใช้อินเทอร์เน็ต)'); return; }
  var rows=lgBookFiltered(), t=lgBookTotals(rows), ym=lgYm($('lg-b-month')), co=lg.company||{};
  var side=function(r, dir){ return r.direction!==dir ? ['', '', '', '', ''] : [r.amount, r.vat, r.whtType==='pnd3' ? r.wht : 0, r.whtType==='pnd53' ? r.wht : 0, r.net]; };
  var tot=function(s){ return [lgRound(s.amount), lgRound(s.vat), lgRound(s.pnd3), lgRound(s.pnd53), lgRound(s.net)]; };
  var sub=['จำนวนเงิน (ก่อนหักภาษี)', 'vat 7%', 'WHT ภงด. 3', 'WHT ภงด. 53', 'จำนวนเงินสุทธิ'];
  var aoa=[[co.name||''], [String(co.address||'').replace(/^ที่อยู่\s*/,'')+' เลขประจำตัวผู้เสียภาษี : '+(co.taxId||'')], [],
    ['รายการ บัญชีรายรับ-รายจ่าย เดือน '+lgMonthLabel(ym)], [],
    ['วัน / เดือน / ปี', 'รายการ', 'รายรับ (บาท)', '', '', '', '', 'รายจ่าย (บาท)', '', '', '', '', 'หมายเหตุ', 'จ่ายให้แก่ / รับจาก', 'วิธีชำระ', 'เลขที่ใบสำคัญ'],
    ['', ''].concat(sub, sub.map(function(s){ return s==='vat 7%' ? 'vat 7% [1]' : s; }), ['', '', '', ''])];
  var head=aoa.length-1;
  rows.forEach(function(r){
    aoa.push([lgDmy(r.entryDate), r.description].concat(side(r, 'in'), side(r, 'out'), [r.note, r.party, lgPayText(r), r.voucherNo]));
  });
  aoa.push(['รวม', ''].concat(tot(t.in), tot(t.out), ['', '', '', '']));
  aoa.push([], ['[1] vat มีอายุ 6 เดือน']);
  var ws=XLSX.utils.aoa_to_sheet(aoa);
  for(var r=head+1; r<aoa.length; r++) for(var c=2; c<12; c++){
    var cell=ws[XLSX.utils.encode_cell({ r:r, c:c })]; if(cell && cell.t==='n') cell.z='#,##0.00';
  }
  ws['!merges']=[{ s:{ r:head-1, c:2 }, e:{ r:head-1, c:6 } }, { s:{ r:head-1, c:7 }, e:{ r:head-1, c:11 } }];
  ws['!cols']=[12, 42, 15, 11, 11, 11, 15, 15, 11, 11, 11, 15, 22, 26, 16, 14].map(function(w){ return { wch:w }; });
  var wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'บัญชีรับจ่าย '+ym);
  XLSX.writeFile(wb, 'บัญชีรับจ่าย-'+ym+'.xlsx');
}
