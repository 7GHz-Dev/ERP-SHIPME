/**
 * ใบแจ้งหนี้ค่าบริการ (IN) — แท็บแยกในหน้าใบแจ้งหนี้
 *
 * ดึงงานจากชีตงานขนส่งตามช่วงวันที่ตรวจปล่อย แล้วทำเอกสารชุดเดียวกับที่ฝ่ายบัญชีทำมือ:
 *   ต่อไฟล์ชีต (แม่สอดฟรีโซน / TRANSIT): ใบสรุปจำนวนตู้ + ใบแจ้งหนี้ค่าบริการตรวจปล่อย
 *   รวมทุกไฟล์: ใบสรุปค่าบริการเพิ่มเติม + ใบแจ้งหนี้ค่าบริการเพิ่มเติม
 * ทำ PDF อย่างเดียว ไม่บันทึกใบลงระบบ — เลขที่ใบตั้งจากช่อง "เลขที่เริ่มต้น"
 *
 * ใช้ $, api, state, esc, baht จากสคริปต์หลักของ admin.html (เรียกตอนเปิดแท็บ ไม่ใช่ตอนโหลดไฟล์)
 */
var svcState = { ready:false, data:null, extras:[] };
var SVC_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
  'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];

function svcRound2(n){ return Math.round((Number(n)||0)*100)/100; }
function svcMoney(n){ return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function svcLocalYmd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function svcPeriod(){ return $('svc-issue').value.slice(0,7).replace('-',''); }

function initServiceInvoice(){
  if(svcState.ready) return;
  svcState.ready = true;
  // ค่าเริ่มต้น: ครึ่งเดือนล่าสุดที่จบไปแล้ว (1–15 หรือ 16–สิ้นเดือน) และออกใบวันนี้
  var now = new Date(), y = now.getFullYear(), m = now.getMonth();
  var from, to;
  if(now.getDate() > 15){ from = new Date(y, m, 1); to = new Date(y, m, 15); }
  else { from = new Date(y, m-1, 16); to = new Date(y, m, 0); }
  $('svc-from').value = svcLocalYmd(from);
  $('svc-to').value = svcLocalYmd(to);
  $('svc-issue').value = svcLocalYmd(now);
  $('svc-start').value = 'IN'+svcPeriod()+'01';
  // เปลี่ยนช่วงวันที่ = ข้อมูลที่ดึงไว้ไม่ตรงช่วงแล้ว ต้องกด "ดึงข้อมูล" ใหม่
  $('svc-from').addEventListener('change', function(){
    if(this.value && (!$('svc-to').value || $('svc-to').value < this.value)) $('svc-to').value = this.value;
    svcRangeChanged();
  });
  $('svc-to').addEventListener('change', svcRangeChanged);
  $('svc-issue').addEventListener('change', function(){
    // เลขที่ใบผูกกับเดือนที่ออกใบ — เปลี่ยนเดือนแล้วเริ่ม 01 ของเดือนนั้น
    $('svc-start').value = 'IN'+svcPeriod()+'01';
    svcRenderDocs();
  });
  ['svc-start','svc-rate-c','svc-rate-r'].forEach(function(id){
    $(id).addEventListener('input', svcRenderDocs);
  });
  $('svc-load').addEventListener('click', svcLoad);
  $('svc-extra-add').addEventListener('click', function(){
    svcState.extras.push({ date:$('svc-to').value, bl:'', label:'', amount:0, source:'เพิ่มเอง', manual:true });
    svcRenderExtras(); svcRenderDocs();
  });
  $('svc-pdf-all').addEventListener('click', function(){ svcOpenPdf(svcDocuments(), 'ชุดใบแจ้งหนี้ค่าบริการ'); });
}

function svcRangeChanged(){
  var d = svcState.data;
  if(d && (d.from !== $('svc-from').value || d.to !== $('svc-to').value)){
    $('svc-msg').textContent = 'เปลี่ยนช่วงวันที่แล้ว — กด "ดึงข้อมูล" ใหม่ (เอกสารด้านล่างยังเป็นของช่วง '
      + svcDmy(d.from)+' - '+svcDmy(d.to)+')';
  }
}
function svcDmy(ymd){ return String(ymd||'').split('-').reverse().join('/'); }
/** "วันที่ตรวจปล่อย 14/09/2026 - 30/09/2026" (วันเดียว = วันที่เดียว) — ใช้แทนเลขครั้งที่ */
function svcRangeText(from, to){
  return 'วันที่ตรวจปล่อย '+(from===to ? svcDmy(from) : svcDmy(from)+' - '+svcDmy(to));
}

function svcLoad(){
  var from = $('svc-from').value, to = $('svc-to').value;
  if(!from || !to){ $('svc-msg').textContent = 'เลือกช่วงวันที่ตรวจปล่อยก่อน'; return; }
  $('svc-msg').textContent = 'กำลังดึงข้อมูลจากชีตงานขนส่ง…';
  $('svc-load').disabled = true;
  api({ action:'serviceInvoiceData', token:state.token, from:from, to:to }).then(function(res){
    $('svc-load').disabled = false;
    if(!res.ok){ $('svc-msg').textContent = 'ดึงข้อมูลไม่สำเร็จ: '+res.error; return; }
    svcState.data = res;
    svcState.extras = (res.extras||[]).map(function(x){
      return { date:x.date, bl:x.bl, label:x.label, amount:x.amount, source:x.source, segment:x.segment };
    });
    if(!$('svc-rate-c').value) $('svc-rate-c').value = res.rates.container;
    if(!$('svc-rate-r').value) $('svc-rate-r').value = res.rates.roro;
    var parts = res.sources.map(function(s){ return s.label+' '+(s.containers+s.roro)+' ตู้'+(s.roro?(' (RORO '+s.roro+')'):''); });
    $('svc-msg').textContent = parts.length
      ? ('พบ '+parts.join(' • ')+' • ค่าบริการเพิ่มเติม '+svcState.extras.length+' รายการ')
      : 'ไม่พบงานในช่วงวันที่นี้';
    svcRenderExtras(); svcRenderDocs();
  }).catch(function(){
    $('svc-load').disabled = false;
    $('svc-msg').textContent = 'ดึงข้อมูลไม่สำเร็จ ตรวจสอบอินเทอร์เน็ต';
  });
}

/** ตารางค่าบริการเพิ่มเติม — แก้ชื่อ/ยอด/BL ได้ ลบได้ เพิ่มเองได้ ก่อนทำ PDF */
function svcRenderExtras(){
  var list = svcState.extras;
  $('svc-extra-wrap').classList.toggle('hidden', !svcState.data);
  $('svc-extra-body').innerHTML = list.length ? list.map(function(x, i){
    var d = String(x.date||'').split('-').reverse().join('/');
    return '<tr>'
      + '<td class="num">'+(i+1)+'</td>'
      + '<td>'+esc(d)+'<div class="sub">'+esc(x.source||'')+'</div></td>'
      + '<td><input type="text" class="svc-x" data-i="'+i+'" data-k="label" list="svc-labels" value="'+esc(x.label)+'" placeholder="รายการ" style="width:100%"></td>'
      + '<td><input type="text" class="svc-x mono" data-i="'+i+'" data-k="bl" value="'+esc(x.bl)+'" placeholder="BL" style="width:100%"></td>'
      + '<td><input type="number" class="svc-x" data-i="'+i+'" data-k="amount" step="0.01" min="0" value="'+x.amount+'" style="width:110px;text-align:right"></td>'
      + '<td class="muted" style="font-size:12px">'+esc(x.segment||'')+'</td>'
      + '<td><button class="btn btn-ghost btn-sm svc-x-del" data-i="'+i+'">ลบ</button></td></tr>';
  }).join('') : '<tr><td colspan="7" class="muted" style="padding:14px">ไม่มีค่าบริการเพิ่มเติมในช่วงนี้</td></tr>';
  Array.prototype.forEach.call($('svc-extra-body').querySelectorAll('.svc-x'), function(input){
    input.addEventListener('input', function(){
      var x = svcState.extras[Number(input.getAttribute('data-i'))], k = input.getAttribute('data-k');
      x[k] = k==='amount' ? (input.value===''?0:Number(input.value)) : input.value;
      svcRenderDocs();
    });
  });
  Array.prototype.forEach.call($('svc-extra-body').querySelectorAll('.svc-x-del'), function(btn){
    btn.addEventListener('click', function(){
      svcState.extras.splice(Number(btn.getAttribute('data-i')), 1);
      svcRenderExtras(); svcRenderDocs();
    });
  });
}

/** สร้างรายการเอกสารทั้งชุดจากข้อมูลที่ดึงมา + ค่าที่กรอกบนหน้าจอ (ลำดับ = ลำดับใน PDF ทั้งชุด) */
function svcDocuments(){
  var data = svcState.data;
  if(!data) return [];
  // ใช้ช่วงวันที่ของข้อมูลที่ดึงมาจริง ไม่ใช่ค่าในช่องที่อาจแก้ไปแล้วแต่ยังไม่ได้ดึงใหม่
  var from = data.from, to = data.to, range = svcRangeText(from, to);
  var monthName = SVC_MONTHS[Number(to.slice(5,7))-1]||'', year = to.slice(0,4);
  var monthLabel = 'เดือน '+monthName+' ('+range+')';
  var monthLine = 'ประจำเดือน '+monthName+' '+year;
  var rateC = Number($('svc-rate-c').value)||0, rateR = Number($('svc-rate-r').value)||0;
  var issueDate = $('svc-issue').value, period = svcPeriod();
  var m = String($('svc-start').value).trim().toUpperCase().match(/^IN(\d{6})(\d{2,4})$/);
  var seq = m && m[1]===period ? Number(m[2]) : 1;
  var customer = data.customer, preparedBy = (state.user && state.user.name) || '';
  var base = { customerName:customer.name, customerAddress:customer.address, customerTaxId:customer.taxId, preparedBy:preparedBy };
  var docs = [];

  function invoice(title, items){
    var subtotal = svcRound2(items.reduce(function(s, it){ return s+it.amount; }, 0));
    var vat = svcRound2(subtotal*data.vatRate), total = svcRound2(subtotal+vat);
    var withholding = svcRound2(subtotal*data.withholdingRate);
    var doc = Object.assign({ kind:'V', title:title, number:'IN'+period+String(seq++).padStart(2,'0'), issueDate:issueDate, bl:'',
      items:items, subtotal:subtotal, vat:vat, total:total, withholding:withholding,
      netTotal:svcRound2(total-withholding) }, base);
    return doc;
  }

  data.sources.forEach(function(src){
    if(!(src.containers+src.roro)) return;
    docs.push(Object.assign({ kind:'SUMMARY', title:'ใบสรุปจำนวนตู้ ('+src.label+')', subtitle:src.label, monthLabel:monthLabel, date:to,
      headers:['ลำดับ','รายการ (BL)','จำนวน (ตู้)','หมายเหตุ'],
      rows:src.rows.map(function(r){ return { label:r.bl, qty:String(r.containers), note:r.roro?'งาน : RORO':'', highlight:r.roro }; }),
      total:String(src.containers+src.roro), sum:src.containers+src.roro }, base));
    var items = [];
    var head = 'ค่าบริการตรวจปล่อยสินค้าผ่านพิธีการศุลกากร\n';
    if(src.containers) items.push({ no:items.length+1, label:head+monthLine+'\n'+range, qty:src.containers, unitPrice:rateC, amount:svcRound2(src.containers*rateC), note:'', fit:true });
    if(src.roro) items.push({ no:items.length+1, label:head+monthLine+' - งาน : RORO\n'+range, qty:src.roro, unitPrice:rateR, amount:svcRound2(src.roro*rateR), note:'', fit:true });
    docs.push(invoice('ใบแจ้งหนี้ค่าบริการตรวจปล่อย ('+src.label+')', items));
  });

  var extras = svcState.extras.filter(function(x){ return String(x.label||'').trim() && Number(x.amount)>0; });
  if(extras.length){
    var sum = svcRound2(extras.reduce(function(s, x){ return s+Number(x.amount); }, 0));
    docs.push(Object.assign({ kind:'SUMMARY', title:'ใบสรุปค่าบริการเพิ่มเติม', subtitle:'ค่าบริการเพิ่มเติม', monthLabel:monthLabel, date:to,
      headers:['ลำดับ','รายการ (BL)','จำนวน','หมายเหตุ'],
      rows:extras.map(function(x){ return { label:x.label, qty:svcMoney(x.amount), note:x.bl, highlight:false }; }),
      total:svcMoney(sum), sum:sum }, base));
    docs.push(invoice('ใบแจ้งหนี้ค่าบริการเพิ่มเติม',
      [{ no:1, label:'ค่าบริการเพิ่มเติม '+monthLine+'\n'+range, qty:1, unitPrice:sum, amount:sum, note:'', fit:true }]));
  }
  return docs;
}

function svcRenderDocs(){
  if(!svcState.ready) return;
  var docs = svcDocuments();
  $('svc-docs-wrap').classList.toggle('hidden', !docs.length);
  var m = String($('svc-start').value).trim().toUpperCase().match(/^IN(\d{6})(\d{2,4})$/);
  $('svc-start-warn').textContent = (m && m[1]===svcPeriod()) ? '' : 'รูปแบบเลขที่ต้องเป็น IN'+svcPeriod()+'01 (เดือนเดียวกับวันที่ออกใบ) — ตอนนี้ใช้ 01';
  $('svc-docs-body').innerHTML = docs.map(function(doc, i){
    var isInv = doc.kind!=='SUMMARY';
    var amount = isInv
      ? ('<b>'+svcMoney(doc.netTotal)+'</b><div class="sub">ค่าบริการ '+svcMoney(doc.subtotal)+' + VAT '+svcMoney(doc.vat)+' − หัก 3% '+svcMoney(doc.withholding)+'</div>')
      : ('<span class="muted">'+esc(doc.rows.length)+' รายการ • รวม '+esc(doc.total)+'</span>');
    return '<tr><td>'+esc(doc.title)+'</td><td class="mono">'+(isInv?esc(doc.number):'—')+'</td>'
      + '<td class="num">'+amount+'</td>'
      + '<td><button class="btn btn-ghost btn-sm svc-doc-pdf" data-i="'+i+'">ดู PDF</button></td></tr>';
  }).join('');
  Array.prototype.forEach.call($('svc-docs-body').querySelectorAll('.svc-doc-pdf'), function(btn){
    btn.addEventListener('click', function(){
      var doc = svcDocuments()[Number(btn.getAttribute('data-i'))];
      if(doc) svcOpenPdf([doc], doc.kind==='SUMMARY' ? doc.title : doc.number);
    });
  });
}

/** สร้าง PDF แล้วเปิดในหน้าต่าง popup พร้อมลิงก์ดาวน์โหลด (เปิด popup ก่อน ไม่งั้นเบราว์เซอร์บล็อก) */
async function svcOpenPdf(docs, name){
  if(!docs.length){ $('svc-msg').textContent = 'ยังไม่มีเอกสาร — กด "ดึงข้อมูล" ก่อน'; return; }
  var popup = window.open('', '_blank', 'popup,width=1000,height=850');
  if(popup){ popup.document.body.textContent = 'กำลังจัดเตรียม PDF…'; popup.document.body.style.margin = '0'; }
  try{
    var blob = await InvoicePDF.create(docs, svcState.data.company);
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
    $('svc-msg').textContent = msg;
    if(popup && !popup.closed) popup.document.body.textContent = msg;
  }
}
