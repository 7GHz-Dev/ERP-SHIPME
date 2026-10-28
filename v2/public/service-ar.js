/**
 * ใบแจ้งหนี้ค่าบริการ (IN): บันทึกเข้าระบบ / ใบที่ออกแล้ว / ลูกหนี้คงค้างค่าบริการ / ใบเสร็จรับเงิน (RE)
 *
 * - ปุ่ม "บันทึกเข้าระบบ" ในหน้าออกใบ ส่งเอกสารชุดที่เห็นบนจอ (svcDocuments) ไปเก็บ
 * - ลูกหนี้ = ยอดรวม VAT หลังหัก ณ ที่จ่าย 3% (netTotal) — ตรวจยอดด้วยไฟล์ Excel คอลัมน์ A = เลขใบ, B = ยอดเงิน
 * - ใบเสร็จรับเงิน / ใบกำกับภาษี ใช้ฟอร์มเดียวกับใบแจ้งหนี้ค่าบริการ เลขที่ RE + yyyymm + เลขรัน (แยกจากเลขใบแจ้งหนี้)
 *
 * ใช้ $, api, state, esc, baht, toast, svcDocuments, svcFetchNext, InvoicePDF, ArReport, XLSX จากหน้า admin.html
 */
var svl = { rows:[], ready:false };
var sar = { rows:[], matched:[], today:'', ready:false, company:null, customer:null };

var SAR_ERR = {
  bad_number:'เลขที่ใบไม่ถูกต้อง (ต้องเป็น IN + ปีเดือนของวันออกใบ + เลขรัน)', duplicate_number:'เลขที่ใบซ้ำกันในชุด',
  number_used:'เลขที่ใบนี้ถูกใช้ไปแล้ว', no_items:'ใบนี้ไม่มีรายการ', no_documents:'ยังไม่มีเอกสาร — กด "ดึงข้อมูล" ก่อน',
  already_paid:'ใบที่รับชำระหรือออกใบเสร็จแล้วยกเลิกไม่ได้', not_fully_paid:'ยังรับชำระไม่ครบ', has_receipt:'ออกใบเสร็จไปแล้ว',
  nothing_updated:'ไม่มีรายการที่บันทึกได้', no_rows:'ไม่พบข้อมูลในไฟล์', no_invoice_numbers:'ไม่พบเลขใบแจ้งหนี้ในคอลัมน์ A'
};
function sarErr(res){ return (SAR_ERR[res.error]||res.error)+(res.numbers?' ('+res.numbers.join(', ')+')':(res.number?' ('+res.number+')':'')); }
function sarDmy(ymd){ return ymd ? String(ymd).split('-').reverse().join('/') : '—'; }
function sarToday(){ var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function sarRange(r){ return r.rangeFrom ? (r.rangeFrom===r.rangeTo ? sarDmy(r.rangeFrom) : sarDmy(r.rangeFrom)+' – '+sarDmy(r.rangeTo)) : '—'; }
/** ที่มาของใบ — ตรวจปล่อยช่วงไหน / สร้างเองในระบบ */
function sarSource(r){ return r.category==='manual' ? 'สร้างเอง' : 'ตรวจปล่อย '+sarRange(r); }
function sarMoney(n){ return Math.round((Number(n)||0)*100)/100; }

/** เปิด PDF ในหน้าต่างใหม่ (เปิดหน้าต่างก่อน ไม่งั้นเบราว์เซอร์บล็อก) */
function sarPdf(promiseDocs, name, options){
  var popup=window.open('', '_blank', 'popup,width=1000,height=850');
  if(popup){ popup.document.body.textContent='กำลังเตรียม PDF…'; popup.document.body.style.margin='0'; }
  return promiseDocs.then(function(pack){
    if(!pack) { if(popup) popup.close(); return; }
    return InvoicePDF.create(pack.docs, pack.company, options).then(function(blob){
      var url=URL.createObjectURL(blob), file=name.replace(/[\\/:*?"<>|]/g,'-')+'.pdf';
      if(popup && !popup.closed){
        popup.document.title=file;
        popup.document.body.innerHTML='<a href="'+url+'" download="'+esc(file)+'" style="display:block;padding:12px;background:#edf2ff;font:14px Tahoma">ดาวน์โหลด '+esc(file)+'</a>'+
          '<iframe src="'+url+'" style="width:100%;height:calc(100vh - 50px);border:0"></iframe>';
      } else window.open(url, '_blank');
    });
  }).catch(function(e){
    var msg='สร้าง PDF ไม่สำเร็จ: '+(e && e.message || e);
    if(popup && !popup.closed) popup.document.body.textContent=msg; else alert(msg);
  });
}

// ---------------- บันทึกจากหน้าออกใบ ----------------
// ไฟล์นี้โหลดใน <head> ก่อนตัวหน้าเว็บ — ผูกปุ่มหลังหน้าโหลดเสร็จ
document.addEventListener('DOMContentLoaded', function(){
  $('svc-save').addEventListener('click', function(){ svcSave(false); });
  $('svc-manual').addEventListener('click', svcManualOpen);
  $('svc-excel-all').addEventListener('click', function(){
    var docs=svcDocuments().filter(function(d){ return d.kind!=='SUMMARY'; });
    if(!docs.length){ $('svc-msg').textContent='ยังไม่มีเอกสาร — กด "ดึงข้อมูล" ก่อน'; return; }
    svcExcel(docs, { draft:true, range:'ตรวจปล่อย '+sarRange(docs[0])+' • ยังไม่บันทึกเข้าระบบ',
      fileName:'ใบแจ้งหนี้ค่าบริการ-'+docs[0].number+(docs.length>1?'-'+docs[docs.length-1].number:'')+'.xlsx' });
  });
});

// ---------------- สร้างใบแจ้งหนี้ค่าบริการเอง (ไม่ดึงจากวันที่ตรวจปล่อย) ----------------
var SVC_VAT=0.07, SVC_WHT=0.03;   // ตรงกับ VAT_RATE / SERVICE_WITHHOLDING_RATE ฝั่งเซิร์ฟเวอร์ (เซิร์ฟเวอร์คิดซ้ำเองตอนบันทึก)
function svcManualOpen(){
  var bg=document.createElement('div'); bg.className='modal-bg';
  bg.innerHTML='<div class="modal" style="max-width:860px;width:97%;max-height:92vh;overflow:auto">'+
    '<h3 style="margin-top:0">✍️ สร้างใบแจ้งหนี้ค่าบริการเอง</h3>'+
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px 12px">'+
      '<div><label>วันที่ออกใบแจ้งหนี้</label><input type="date" id="svm-date" value="'+sarToday()+'" style="width:100%"></div>'+
      '<div><label>เลขที่ใบแจ้งหนี้</label><input type="text" id="svm-no" class="mono" style="width:100%" placeholder="กำลังหาเลขถัดไป…"></div>'+
      '<div style="grid-column:1/-1"><label>หัวเรื่อง</label><input type="text" id="svm-title" value="ใบแจ้งหนี้ค่าบริการ" maxlength="200" style="width:100%"></div>'+
      '<div style="grid-column:1/-1"><label>ชื่อลูกค้า</label><input type="text" id="svm-cname" maxlength="200" style="width:100%"></div>'+
      '<div style="grid-column:1/-1"><label>ที่อยู่ลูกค้า</label><input type="text" id="svm-caddr" maxlength="300" style="width:100%"></div>'+
      '<div><label>เลขผู้เสียภาษีลูกค้า</label><input type="text" id="svm-ctax" maxlength="30" style="width:100%"></div>'+
    '</div>'+
    '<div class="tablewrap" style="margin-top:12px"><table class="inv-tbl"><thead><tr><th style="width:34px">#</th><th>รายการ</th><th class="num" style="width:80px">จำนวน</th><th class="num" style="width:120px">ราคา/หน่วย</th><th class="num" style="width:120px">จำนวนเงิน</th><th style="width:150px">หมายเหตุ</th><th style="width:36px"></th></tr></thead>'+
      '<tbody id="svm-items"></tbody></table></div>'+
    '<button class="btn btn-ghost btn-sm" id="svm-add" style="margin-top:6px">➕ เพิ่มรายการ</button>'+
    '<div id="svm-sum" style="margin:12px 0 0;text-align:right;line-height:1.8"></div>'+
    '<div id="svm-err" class="err hidden" style="margin:8px 0"></div>'+
    '<div class="toolbar" style="justify-content:flex-end;margin-top:12px"><button class="btn btn-ghost" id="svm-x">ยกเลิก</button>'+
      '<button class="btn btn-ghost" id="svm-pdf">📄 ดูตัวอย่าง PDF</button><button class="btn btn-primary" id="svm-save">💾 บันทึกเข้าระบบ (ลูกหนี้ค่าบริการ)</button></div></div>';
  document.body.appendChild(bg);
  var q=function(sel){ return bg.querySelector(sel); }, company=null;
  var close=function(){ bg.remove(); };
  q('#svm-x').addEventListener('click', close);
  // ลูกค้า / หัวกระดาษบริษัท = ค่าเดียวกับใบที่ดึงจากระบบ
  api({ action:'listServiceInvoices', token:state.token, from:sarToday(), to:sarToday() }).then(function(res){
    if(!res.ok) return;
    company=res.company; var c=res.customer||{};
    if(!q('#svm-cname').value) q('#svm-cname').value=c.name||'';
    if(!q('#svm-caddr').value) q('#svm-caddr').value=c.address||'';
    if(!q('#svm-ctax').value) q('#svm-ctax').value=c.taxId||'';
  });
  var nextNo=function(){
    api({ action:'serviceInvoiceNext', token:state.token, issueDate:q('#svm-date').value }).then(function(res){ if(res.ok) q('#svm-no').value=res.number; });
  };
  q('#svm-date').addEventListener('change', nextNo); nextNo();
  var addRow=function(it){
    it=it||{};
    var tr=document.createElement('tr');
    tr.innerHTML='<td class="no"></td><td><input type="text" class="svm-label" maxlength="400" style="width:100%" placeholder="เช่น ค่าบริการตรวจปล่อยตู้ (เพิ่มเติม)" value="'+esc(it.label||'')+'"></td>'+
      '<td><input type="number" class="svm-qty" min="0" step="any" value="'+(it.qty!=null?it.qty:1)+'" style="width:100%;text-align:right"></td>'+
      '<td><input type="number" class="svm-price" min="0" step="0.01" value="'+(it.unitPrice!=null?it.unitPrice:'')+'" style="width:100%;text-align:right"></td>'+
      '<td class="num svm-amt">0.00</td><td><input type="text" class="svm-note" maxlength="200" style="width:100%" value="'+esc(it.note||'')+'"></td>'+
      '<td><button class="btn btn-ghost btn-sm svm-del" title="ลบรายการ">✕</button></td>';
    q('#svm-items').appendChild(tr);
    tr.querySelector('.svm-del').addEventListener('click', function(){ tr.remove(); calc(); });
    Array.prototype.forEach.call(tr.querySelectorAll('input'), function(x){ x.addEventListener('input', calc); });
    calc();
  };
  var items=function(){
    return Array.prototype.map.call(q('#svm-items').querySelectorAll('tr'), function(tr){
      var qty=Number(tr.querySelector('.svm-qty').value)||0, price=sarMoney(tr.querySelector('.svm-price').value);
      return { label:tr.querySelector('.svm-label').value.trim(), qty:qty, unitPrice:price, amount:sarMoney(qty*price), note:tr.querySelector('.svm-note').value.trim() };
    });
  };
  var totals=function(list){
    var sub=sarMoney(list.reduce(function(t,it){ return t+(it.label&&it.amount>0?it.amount:0); },0)), vat=sarMoney(sub*SVC_VAT), total=sarMoney(sub+vat), wht=sarMoney(sub*SVC_WHT);
    return { subtotal:sub, vat:vat, total:total, withholding:wht, netTotal:sarMoney(total-wht) };
  };
  var calc=function(){
    var list=items();
    Array.prototype.forEach.call(q('#svm-items').querySelectorAll('tr'), function(tr, i){ tr.querySelector('.no').textContent=i+1; tr.querySelector('.svm-amt').textContent=baht(list[i].amount); });
    var t=totals(list);
    q('#svm-sum').innerHTML='รวมเงิน <b>'+baht(t.subtotal)+'</b><br>VAT 7% <b>'+baht(t.vat)+'</b><br>รวมทั้งสิ้น <b>'+baht(t.total)+'</b><br>'+
      '<span class="muted">หัก ณ ที่จ่าย 3% '+baht(t.withholding)+'</span><br><span style="font-size:17px">ยอดชำระสุทธิ <b>'+baht(t.netTotal)+'</b> บาท</span>';
  };
  q('#svm-add').addEventListener('click', function(){ if(q('#svm-items').children.length<30) addRow(); });
  addRow();
  var check=function(){
    var err=q('#svm-err'); err.classList.add('hidden');
    var list=items().filter(function(it){ return it.label || it.amount>0; });
    var bad=list.filter(function(it){ return !it.label || !(it.amount>0); });
    var msg = !q('#svm-date').value ? 'เลือกวันที่ออกใบแจ้งหนี้'
      : !/^IN\d{8,10}$/i.test(q('#svm-no').value.trim()) ? 'เลขที่ใบต้องเป็น IN + ปีเดือนของวันออกใบ + เลขรัน (เช่น IN20261001)'
      : !list.length ? 'ใส่รายการอย่างน้อย 1 รายการ'
      : bad.length ? 'ทุกรายการต้องมีชื่อรายการ และจำนวนเงินมากกว่า 0' : '';
    if(msg){ err.textContent=msg; err.classList.remove('hidden'); return null; }
    var t=totals(list);
    return { number:q('#svm-no').value.trim().toUpperCase(), title:q('#svm-title').value.trim()||'ใบแจ้งหนี้ค่าบริการ', category:'manual', source:'',
      items:list.map(function(it, i){ return { no:i+1, label:it.label, qty:it.qty, unitPrice:it.unitPrice, amount:it.amount, note:it.note }; }),
      customerName:q('#svm-cname').value.trim(), customerAddress:q('#svm-caddr').value.trim(), customerTaxId:q('#svm-ctax').value.trim(), totals:t };
  };
  q('#svm-pdf').addEventListener('click', function(){
    var d=check(); if(!d) return;
    sarPdf(Promise.resolve({ company:company||{}, docs:[{ kind:'V', title:d.title, number:d.number, issueDate:q('#svm-date').value, bl:'', items:d.items,
      subtotal:d.totals.subtotal, vat:d.totals.vat, total:d.totals.total, withholding:d.totals.withholding, netTotal:d.totals.netTotal,
      customerName:d.customerName, customerAddress:d.customerAddress, customerTaxId:d.customerTaxId, preparedBy:(state.user&&state.user.name)||'' }] }), d.number);
  });
  q('#svm-save').addEventListener('click', function(){
    var d=check(); if(!d) return;
    if(!confirm('บันทึกใบแจ้งหนี้ค่าบริการ '+d.number+'\n'+d.title+'\nยอดชำระสุทธิ '+baht(d.totals.netTotal)+' บาท\n\nใบจะเข้า "ลูกหนี้คงค้างค่าบริการ"')) return;
    var btn=this; btn.disabled=true;
    api({ action:'saveServiceInvoices', token:state.token, issueDate:q('#svm-date').value, docs:[d] }).then(function(res){
      btn.disabled=false;
      if(!res.ok){
        var e=q('#svm-err'); e.textContent='บันทึกไม่สำเร็จ: '+sarErr(res); e.classList.remove('hidden');
        if(res.error==='number_used') nextNo();
        return;
      }
      close();
      toast('บันทึกใบแจ้งหนี้ค่าบริการ '+res.numbers.join(', ')+' แล้ว', 3500);
      if($('svc-msg')) $('svc-msg').textContent='✅ สร้างใบแจ้งหนี้ค่าบริการเองแล้ว: '+res.numbers.join(', ')+' — ดูได้ที่ "ใบที่ออกแล้ว" และ "ลูกหนี้คงค้างค่าบริการ"';
      svl.ready=false; sar.ready=false;
      if(typeof svcFetchNext==='function') svcFetchNext();
      if(confirm('เปิด PDF ใบแจ้งหนี้ '+res.numbers[0]+' เลยไหม?')) svcPrintInvoice(res.numbers[0]);
    }).catch(function(){ btn.disabled=false; alert('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); });
  });
}

function svcSave(force){
  var docs=svcDocuments().filter(function(d){ return d.kind!=='SUMMARY'; });
  if(!docs.length){ toast('ยังไม่มีเอกสาร — กด "ดึงข้อมูล" ก่อน'); return; }
  if(!force && !confirm('บันทึกใบแจ้งหนี้ค่าบริการ '+docs.length+' ใบเข้าระบบ?\n\n'+
    docs.map(function(d){ return '• '+d.number+'  '+d.title+'  '+baht(d.netTotal); }).join('\n')+
    '\n\nใบจะเข้า "ลูกหนี้คงค้างค่าบริการ"')) return;
  var btn=$('svc-save'); btn.disabled=true;
  var payload=docs.map(function(d){
    return { number:d.number, title:d.title, category:d.category, source:d.source, rangeFrom:d.rangeFrom, rangeTo:d.rangeTo,
      items:d.items, customerName:d.customerName, customerAddress:d.customerAddress, customerTaxId:d.customerTaxId, summary:d.summary||null };
  });
  api({ action:'saveServiceInvoices', token:state.token, issueDate:$('svc-issue').value, docs:payload, force:!!force }).then(function(res){
    btn.disabled=false;
    if(!res.ok){
      if(res.error==='range_overlap'){
        var list=res.overlaps.map(function(o){ return '• '+o.number+'  '+o.title+'  ('+sarDmy(o.rangeFrom)+' – '+sarDmy(o.rangeTo)+')'; }).join('\n');
        if(confirm('ช่วงวันที่ตรวจปล่อยซ้อนกับใบที่บันทึกไว้แล้ว อาจเป็นการออกซ้ำ:\n\n'+list+'\n\nยืนยันบันทึกต่อ?')) svcSave(true);
        return;
      }
      alert('บันทึกไม่สำเร็จ: '+sarErr(res)); return;
    }
    $('svc-msg').textContent='✅ บันทึกแล้ว '+res.count+' ใบ: '+res.numbers.join(', ')+' — ดูได้ที่ "ใบที่ออกแล้ว" และ "ลูกหนี้คงค้างค่าบริการ"';
    toast('บันทึกใบแจ้งหนี้ค่าบริการแล้ว '+res.count+' ใบ', 3500);
    svl.ready=false; sar.ready=false;
    svcFetchNext();
  }).catch(function(){ btn.disabled=false; alert('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); });
}

// ---------------- ใบที่ออกแล้ว ----------------
function svcListOpen(){
  if(svl.ready) return;
  svl.ready=true;
  if(!svl.bound){
    svl.bound=true;
    $('svl-reload').addEventListener('click', svlLoad);
    $('svl-search').addEventListener('input', svlRender);
    ['svl-from','svl-to'].forEach(function(id){ $(id).addEventListener('change', svlLoad); });
    $('svl-body').addEventListener('click', svlOnClick);
    $('svl-excel').addEventListener('click', svlExcel);
  }
  svlLoad();
}
function svlLoad(){
  $('svl-body').innerHTML='<tr><td colspan="8" class="muted">กำลังโหลด…</td></tr>';
  api({ action:'listServiceInvoices', token:state.token, from:$('svl-from').value, to:$('svl-to').value }).then(function(res){
    if(!res.ok){ $('svl-body').innerHTML='<tr><td colspan="8" class="muted">โหลดไม่สำเร็จ: '+esc(res.error)+'</td></tr>'; return; }
    svl.rows=(res.rows||[]).slice().reverse();   // ใหม่สุดก่อน
    svlRender();
  });
}
function svlFiltered(){
  var q=$('svl-search').value.trim().toLowerCase();
  return svl.rows.filter(function(r){ return !q || (r.number+' '+r.title+' '+(r.receiptNo||'')).toLowerCase().indexOf(q)>=0; });
}
function svlRender(){
  var rows=svlFiltered();
  var sum=rows.reduce(function(t,r){ return t+Number(r.netTotal); },0);
  $('svl-msg').textContent=rows.length ? ('แสดง '+rows.length+' ใบ • ยอดชำระสุทธิรวม '+baht(sum)+' บาท') : '';
  $('svl-body').innerHTML=rows.length ? rows.map(function(r){
    var status = r.receiptNo ? '<span class="pill approved mono">ใบเสร็จ '+esc(r.receiptNo)+'</span>'
      : (r.outstanding<=0 ? '<span class="pill approved">ชำระครบ</span>'
      : (r.paidAmount>0 ? '<span class="pill pending">ชำระบางส่วน ค้าง '+baht(r.outstanding)+'</span>' : '<span class="pill pending">ค้างชำระ</span>'));
    return '<tr><td><b class="mono">'+esc(r.number)+'</b><div class="sub">'+sarDmy(r.issueDate)+'</div></td>'+
      '<td>'+esc(r.title)+'</td><td>'+(r.category==='manual'?'<span class="pill">สร้างเอง</span>':sarRange(r))+'</td>'+
      '<td class="num">'+baht(r.total)+'</td><td class="num">'+baht(r.withholding)+'</td><td class="num"><b>'+baht(r.netTotal)+'</b></td>'+
      '<td>'+status+'</td><td class="acts">'+
        '<button class="btn btn-ghost btn-sm" data-act="pdf" data-n="'+esc(r.number)+'">ดู PDF</button>'+
        '<button class="btn btn-ghost btn-sm" data-act="excel" data-n="'+esc(r.number)+'" title="ใบนี้ + รายละเอียดราย BL เป็นไฟล์ Excel">Excel</button>'+
        (r.receiptNo ? '<button class="btn btn-ghost btn-sm" data-act="receipt" data-n="'+esc(r.number)+'">ใบเสร็จ</button>' : '')+
        (!r.receiptNo && !(r.paidAmount>0) ? '<button class="btn btn-ghost btn-sm" data-act="cancel" data-n="'+esc(r.number)+'" style="color:#b91c1c">ยกเลิก</button>' : '')+
      '</td></tr>';
  }).join('') : '<tr><td colspan="8" class="muted" style="padding:20px">ยังไม่มีใบแจ้งหนี้ค่าบริการที่บันทึกในระบบ</td></tr>';
}
function svlOnClick(e){
  var b=e.target.closest('[data-act]'); if(!b) return;
  var n=b.getAttribute('data-n'), act=b.getAttribute('data-act');
  if(act==='pdf') return svcPrintInvoice(n);
  if(act==='excel') return svlExcelOne(n, b);
  if(act==='receipt') return sarPrintReceipts([n], '');
  if(act==='cancel'){
    if(!confirm('ยกเลิกใบ '+n+' ?\n\nใบจะถูกลบออกจากระบบและลูกหนี้')) return;
    b.disabled=true;
    api({ action:'cancelServiceInvoices', token:state.token, numbers:[n] }).then(function(res){
      if(!res.ok){ b.disabled=false; alert('ยกเลิกไม่สำเร็จ: '+sarErr(res)); return; }
      toast('ยกเลิกใบ '+n+' แล้ว'); sar.ready=false; svlLoad(); svcFetchNext();
    });
  }
}
/** พิมพ์ใบแจ้งหนี้ที่บันทึกไว้ — ใบสรุปที่แนบคู่ + ใบแจ้งหนี้ หน้าตาเดียวกับตอนออก */
function svcPrintInvoice(number){
  sarPdf(api({ action:'getServiceInvoice', token:state.token, number:number }).then(function(res){
    if(!res.ok){ alert('เปิดใบไม่สำเร็จ: '+sarErr(res)); return null; }
    var inv=res.invoice, docs=[];
    if(inv.summary) docs.push(inv.summary);
    docs.push({ kind:'V', number:inv.number, issueDate:inv.issueDate, bl:'', items:inv.items,
      subtotal:inv.subtotal, vat:inv.vat, total:inv.total, withholding:inv.withholding, netTotal:inv.netTotal,
      customerName:inv.customerName, customerAddress:inv.customerAddress, customerTaxId:inv.customerTaxId, preparedBy:inv.preparedBy });
    return { docs:docs, company:res.company };
  }), number);
}

// ---------------- Excel: ใบแจ้งหนี้ค่าบริการ + รายละเอียด ----------------
/**
 * รายละเอียดของใบ (ก่อน VAT) — ใบที่มีใบสรุปแนบใช้แถวในใบสรุป:
 *   ตรวจปล่อย = ราย BL × ค่าบริการ/ตู้ (RORO ใช้ราคาของรายการ RORO ในใบ) • ค่าบริการเพิ่มเติม = รายการ + BL + ยอด
 * ใบที่ไม่มีใบสรุป (สร้างเอง) ใช้รายการในใบ
 */
function svcDetailRows(inv){
  var items=inv.items||[], rows=inv.summaryRows || (inv.summary && inv.summary.rows) || null;
  var oneLine=function(t){ return String(t||'').replace(/\s*\n\s*/g,' ').trim(); };
  if(rows && rows.length && inv.category==='inspect'){
    return rows.map(function(r){
      var roro=!!r.highlight, qty=Number(r.qty)||0;
      var item=items.filter(function(it){ return /RORO/i.test(it.label)===roro; })[0];
      var price=item ? Number(item.unitPrice)||0 : 0;
      return { bl:r.label, label:'ค่าบริการตรวจปล่อย'+(roro?' (RORO)':''), qty:qty, unitPrice:price, amount:sarMoney(qty*price), note:r.note||'' };
    });
  }
  if(rows && rows.length && inv.category==='extra'){
    return rows.map(function(r){
      return { bl:r.note||'', label:r.label, qty:'', unitPrice:'', amount:sarMoney(String(r.qty).replace(/,/g,'')), note:'' };
    });
  }
  return items.map(function(it){
    return { bl:'', label:oneLine(it.label), qty:Number(it.qty)||0, unitPrice:Number(it.unitPrice)||0, amount:Number(it.amount)||0, note:it.note||'' };
  });
}
function svcStatus(r){
  return r.receiptNo ? 'ออกใบเสร็จแล้ว' : (r.outstanding<=0 ? 'ชำระครบ' : (r.paidAmount>0 ? 'ชำระบางส่วน' : 'ค้างชำระ'));
}
/** ไฟล์ Excel 2 ชีต: ใบแจ้งหนี้ค่าบริการ (ใบละแถว) + รายละเอียด (ราย BL / รายการ) • opts.draft = ยังไม่บันทึก ไม่มีคอลัมน์รับชำระ */
function svcExcel(invoices, opts){
  if(!window.XLSX){ alert('ตัวสร้างไฟล์ Excel ยังไม่โหลด (ต้องใช้อินเทอร์เน็ต)'); return; }
  var MONEY='#,##0.00', draft=!!opts.draft, sum=function(list, k){ return sarMoney(list.reduce(function(t, x){ return t+(Number(x[k])||0); }, 0)); };
  // ใส่รูปแบบตัวเลขให้คอลัมน์เงิน ตั้งแต่แถวหัวตาราง+1 ถึงแถวสุดท้าย
  function sheet(aoa, headRow, moneyCols, widths){
    var ws=XLSX.utils.aoa_to_sheet(aoa);
    for(var r=headRow+1; r<aoa.length; r++) moneyCols.forEach(function(c){
      var cell=ws[XLSX.utils.encode_cell({ r:r, c:c })]; if(cell && cell.t==='n') cell.z=MONEY;
    });
    ws['!cols']=widths.map(function(w){ return { wch:w }; });
    return ws;
  }

  var head=['ลำดับ','เลขที่ใบแจ้งหนี้','วันที่','รายการ','ที่มา','ค่าบริการ (ก่อน VAT)','VAT 7%','รวม VAT','หัก ณ ที่จ่าย 3%','ยอดชำระสุทธิ']
    .concat(draft ? [] : ['ชำระแล้ว','วันที่รับชำระ','ค้างชำระ','สถานะ','เลขที่ใบเสร็จ','วันที่ใบเสร็จ']);
  var aoa=[['ใบแจ้งหนี้ค่าบริการ'+(opts.range?' — '+opts.range:'')], [], head];
  invoices.forEach(function(r, i){
    aoa.push([i+1, r.number, sarDmy(r.issueDate), r.title, sarSource(r), Number(r.subtotal), Number(r.vat), Number(r.total), Number(r.withholding), Number(r.netTotal)]
      .concat(draft ? [] : [Number(r.paidAmount)||0, r.paidAt?sarDmy(r.paidAt):'', Number(r.outstanding)||0, svcStatus(r), r.receiptNo||'', r.receiptDate?sarDmy(r.receiptDate):'']));
  });
  if(invoices.length > 1) aoa.push(['', 'รวม '+invoices.length+' ใบ', '', '', '', sum(invoices,'subtotal'), sum(invoices,'vat'), sum(invoices,'total'), sum(invoices,'withholding'), sum(invoices,'netTotal')]
    .concat(draft ? [] : [sum(invoices,'paidAmount'), '', sum(invoices,'outstanding')]));
  var ws1=sheet(aoa, 2, draft ? [5,6,7,8,9] : [5,6,7,8,9,10,12], [7,15,11,40,26,16,13,15,15,16].concat(draft ? [] : [14,13,14,15,15,12]));

  var detail=[['รายละเอียดใบแจ้งหนี้ค่าบริการ'+(opts.range?' — '+opts.range:'')], ['จำนวนเงินเป็นยอดก่อน VAT (รวมทุกแถวของใบ = ค่าบริการก่อน VAT ของใบนั้น)'],
    ['ลำดับ','เลขที่ใบแจ้งหนี้','วันที่ใบแจ้งหนี้','ใบแจ้งหนี้','BL','รายการ','จำนวน','ราคาต่อหน่วย','จำนวนเงิน','หมายเหตุ']];
  var n=0, total=0;
  invoices.forEach(function(r){
    svcDetailRows(r).forEach(function(d){
      total+=Number(d.amount)||0;
      detail.push([++n, r.number, sarDmy(r.issueDate), r.title, d.bl, d.label, d.qty, d.unitPrice, d.amount, d.note]);
    });
  });
  if(n) detail.push(['', 'รวม '+n+' รายการ', '', '', '', '', '', '', sarMoney(total), '']);
  var ws2=sheet(detail, 2, [7,8], [7,15,13,36,20,40,9,13,15,18]);

  var wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, 'ใบแจ้งหนี้ค่าบริการ');
  XLSX.utils.book_append_sheet(wb, ws2, 'รายละเอียดใบแจ้งหนี้ค่าบริการ');
  XLSX.writeFile(wb, opts.fileName.replace(/[\\/:*?"<>|]/g,'-'));
}
/** ใบที่ออกแล้ว — ใบตามช่วงวันที่ + คำค้นที่เห็นบนจอ */
function svlExcel(){
  var shown=svlFiltered();
  if(!shown.length){ alert('ไม่มีใบให้ส่งออก'); return; }
  var btn=$('svl-excel'), want={};
  shown.forEach(function(r){ want[r.number]=true; });
  btn.disabled=true;
  api({ action:'listServiceInvoices', token:state.token, from:$('svl-from').value, to:$('svl-to').value, details:true }).then(function(res){
    btn.disabled=false;
    if(!res.ok){ alert('โหลดข้อมูลไม่สำเร็จ: '+sarErr(res)); return; }
    var rows=(res.rows||[]).filter(function(r){ return want[r.number]; });
    var from=$('svl-from').value, to=$('svl-to').value;
    svcExcel(rows, { range:ArReport.rangeText(from, to)+($('svl-search').value.trim()?' • ค้นหา "'+$('svl-search').value.trim()+'"':''),
      fileName:'ใบแจ้งหนี้ค่าบริการ-'+(from||to ? (from||'')+'_'+(to||'') : sarToday())+'.xlsx' });
  }).catch(function(e){ btn.disabled=false; alert('ส่งออก Excel ไม่สำเร็จ: '+(e && e.message || e)); });
}
function svlExcelOne(number, btn){
  btn.disabled=true;
  api({ action:'getServiceInvoice', token:state.token, number:number }).then(function(res){
    btn.disabled=false;
    if(!res.ok){ alert('เปิดใบไม่สำเร็จ: '+sarErr(res)); return; }
    svcExcel([res.invoice], { range:res.invoice.number, fileName:res.invoice.number+'.xlsx' });
  }).catch(function(e){ btn.disabled=false; alert('ส่งออก Excel ไม่สำเร็จ: '+(e && e.message || e)); });
}

// ---------------- ลูกหนี้คงค้างค่าบริการ ----------------
function svcArOpen(){
  if(!sar.bound){
    sar.bound=true;
    $('sar-receipt-date').value=sarToday();
    $('sar-reload').addEventListener('click', sarLoad);
    $('sar-show-paid').addEventListener('change', sarLoad);
    ['sar-from','sar-to'].forEach(function(id){ $(id).addEventListener('change', sarLoad); });
    $('sar-all').addEventListener('change', function(){
      var on=this.checked;
      Array.prototype.forEach.call($('sar-body').querySelectorAll('.sar-pick'), function(cb){ cb.checked=on; });
      sarUpdatePicked();
    });
    $('sar-body').addEventListener('change', function(e){ if(e.target.classList.contains('sar-pick')) sarUpdatePicked(); });
    $('sar-file').addEventListener('change', function(){ var f=this.files&&this.files[0]; this.value=''; if(f) sarReadFile(f); });
    $('sar-report').addEventListener('click', function(){ ArReport.open(sarReportOpts()); });
    $('sar-excel').addEventListener('click', function(){ ArReport.excel(sarReportOpts()); });
    $('sar-unsettle').addEventListener('click', sarUnsettle);
    $('sar-pay').addEventListener('click', sarPayManual);
    $('sar-receipt').addEventListener('click', function(){
      var picked=sarPicked(); if(!picked.length) return;
      sarPrintReceipts(picked.map(function(r){ return r.number; }), $('sar-receipt-date').value, true);
    });
  }
  if(sar.ready) return;
  sar.ready=true;
  sarLoad();
}
function sarLoad(){
  $('sar-body').innerHTML='<tr><td colspan="8" class="muted">กำลังโหลด…</td></tr>';
  api({ action:'listServiceInvoices', token:state.token, from:$('sar-from').value, to:$('sar-to').value, outstandingOnly:!$('sar-show-paid').checked })
    .then(function(res){
      if(!res.ok){ $('sar-body').innerHTML='<tr><td colspan="8" class="muted">โหลดไม่สำเร็จ: '+esc(res.error)+'</td></tr>'; return; }
      sar.rows=res.rows||[]; sar.today=res.today; sar.company=res.company; sar.customer=res.customer;
      sarRender();
    });
}
function sarReportRows(){
  return sar.rows.map(function(r){
    // ตัดคำว่า "ใบแจ้งหนี้" ออก — ในรายงานทุกแถวเป็นใบแจ้งหนี้อยู่แล้ว เหลือแค่ว่าค่าอะไร
    return { number:r.number, issueDate:r.issueDate, ref:String(r.title||'').replace(/^ใบแจ้งหนี้/,''), detail:sarSource(r),
      total:r.total, withholding:r.withholding, net:r.netTotal, paid:r.paidAmount, outstanding:r.outstanding };
  });
}
function sarReportOpts(){
  return { title:'รายงานลูกหนี้คงค้าง — ใบแจ้งหนี้ค่าบริการ', subtitle:'ค่าบริการตรวจปล่อย / ค่าบริการเพิ่มเติม', rows:sarReportRows(),
    from:$('sar-from').value, to:$('sar-to').value, today:sar.today, company:sar.company||{}, customer:sar.customer||{},
    refLabel:'รายการ', withholding:true, preparedBy:(state.user&&state.user.name)||'', fileName:'ลูกหนี้คงค้าง-ค่าบริการ-'+sar.today+'.xlsx' };
}
function sarRender(){
  $('sar-summary').innerHTML=ArReport.summaryHtml(sarReportRows(), sar.today, ArReport.rangeText($('sar-from').value, $('sar-to').value));
  var rows=sar.rows;
  $('sar-body').innerHTML=rows.length ? rows.map(function(r, i){
    var done=r.outstanding<=0, partial=r.paidAmount>0 && !done;
    return '<tr'+(done?' style="opacity:.6"':'')+'><td><input type="checkbox" class="sar-pick" data-i="'+i+'"></td><td class="no">'+(i+1)+'</td>'+
      '<td><b class="mono">'+esc(r.number)+'</b><div class="sub">'+sarDmy(r.issueDate)+' • อายุ '+ArReport.days(r.issueDate, sar.today)+' วัน</div></td>'+
      '<td>'+esc(r.title)+'<div class="sub">'+esc(sarSource(r))+' • รวม VAT '+baht(r.total)+' − หัก 3% '+baht(r.withholding)+'</div></td>'+
      '<td class="num">'+baht(r.netTotal)+'</td>'+
      '<td class="num">'+(done?'<span class="pill approved">ครบแล้ว</span>':'<b>'+baht(r.outstanding)+'</b>'+(partial?'<div class="sub">จ่ายบางส่วน</div>':''))+'</td>'+
      '<td class="num">'+baht(r.paidAmount)+(r.paidAt?'<div class="sub">'+sarDmy(r.paidAt)+'</div>':'')+'</td>'+
      '<td>'+(r.receiptNo?'<span class="pill approved mono">'+esc(r.receiptNo)+'</span>':'<span class="muted">—</span>')+'</td></tr>';
  }).join('') : '<tr><td colspan="8" class="muted" style="padding:20px">ไม่มีรายการคงค้าง</td></tr>';
  $('sar-all').checked=false;
  sarUpdatePicked();
}
function sarPicked(){
  return Array.prototype.map.call($('sar-body').querySelectorAll('.sar-pick:checked'), function(cb){ return sar.rows[+cb.getAttribute('data-i')]; }).filter(Boolean);
}
function sarUpdatePicked(){
  var p=sarPicked();
  $('sar-picked').textContent='เลือกไว้ '+p.length+' รายการ';
  // ออกใบเสร็จได้เฉพาะที่รับชำระครบแล้ว (ใบที่ออกไปแล้วพิมพ์ซ้ำได้)
  $('sar-receipt').disabled=!p.length || p.some(function(r){ return r.outstanding>0; });
  $('sar-unsettle').disabled=!p.length || !p.some(function(r){ return r.paidAmount>0; });
  $('sar-pay').disabled=!p.length || p.some(function(r){ return !(r.outstanding>0); });
}

/**
 * รับชำระแบบ manual — ยอดเริ่มต้น = ยอดค้างสุทธิ (หลังหัก ณ ที่จ่าย 3%)
 * ลูกค้าบางรายโอนเต็มจำนวนไม่หัก ณ ที่จ่าย = ใส่เกินยอดค้างได้ไม่เกินยอดรวม VAT ที่เหลือ (ถามยืนยันก่อน)
 */
function sarPayManual(){
  var picked=sarPicked().filter(function(r){ return r.outstanding>0; });
  if(!picked.length) return;
  var bg=document.createElement('div'); bg.className='modal-bg';
  bg.innerHTML='<div class="modal" style="max-width:720px;width:96%">'+
    '<h3 style="margin-top:0">💵 รับชำระค่าบริการ (manual) — '+picked.length+' ใบ</h3>'+
    '<label>วันที่รับชำระ</label><input type="date" id="sap-date" value="'+sarToday()+'" style="margin-bottom:10px">'+
    '<div class="tablewrap" style="max-height:52vh;overflow:auto"><table class="inv-tbl"><thead><tr><th>เลขใบ</th><th>รายการ</th><th class="num">ค้างสุทธิ</th><th class="num">ยอดที่รับ</th></tr></thead><tbody>'+
    picked.map(function(r, i){
      return '<tr><td class="mono"><b>'+esc(r.number)+'</b></td><td>'+esc(r.title)+'<div class="sub">'+esc(sarSource(r))+'</div></td>'+
        '<td class="num">'+baht(r.outstanding)+'<div class="sub">ไม่หัก 3% = '+baht(sarMoney(r.total-r.paidAmount))+'</div></td>'+
        '<td class="num"><input type="number" class="sap-amt" data-i="'+i+'" min="0" step="0.01" value="'+r.outstanding.toFixed(2)+'" style="width:130px;text-align:right"></td></tr>';
    }).join('')+'</tbody></table></div>'+
    '<div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0 4px"><span class="muted">ยอดน้อยกว่ายอดค้าง = รับบางส่วน</span><b id="sap-total"></b></div>'+
    '<div id="sap-err" class="err hidden" style="margin:6px 0"></div>'+
    '<div class="toolbar" style="justify-content:flex-end;margin-top:10px"><button class="btn btn-ghost" id="sap-x">ยกเลิก</button><button class="btn btn-primary" id="sap-save">บันทึกรับชำระ</button></div></div>';
  document.body.appendChild(bg);
  var inputs=bg.querySelectorAll('.sap-amt');
  var sum=function(){ var t=0; Array.prototype.forEach.call(inputs, function(x){ t+=Number(x.value)||0; }); bg.querySelector('#sap-total').textContent='รวมรับชำระ '+baht(sarMoney(t))+' บาท'; };
  Array.prototype.forEach.call(inputs, function(x){ x.addEventListener('input', sum); }); sum();
  var close=function(){ bg.remove(); };
  bg.addEventListener('click', function(e){ if(e.target===bg) close(); });
  bg.querySelector('#sap-x').addEventListener('click', close);
  bg.querySelector('#sap-save').addEventListener('click', function(){
    var err=bg.querySelector('#sap-err'), date=bg.querySelector('#sap-date').value, rows=[], tooMuch=[], noWht=[];
    err.classList.add('hidden');
    if(!date){ err.textContent='เลือกวันที่รับชำระ'; err.classList.remove('hidden'); return; }
    Array.prototype.forEach.call(inputs, function(x){
      var r=picked[+x.getAttribute('data-i')], amt=sarMoney(x.value);
      if(!(amt>0)) return;
      var maxGross=sarMoney(r.total-r.paidAmount);
      if(amt>maxGross+0.009) tooMuch.push(r.number+' (สูงสุด '+baht(maxGross)+')');
      else if(amt>r.outstanding+0.009) noWht.push(r.number);
      rows.push({ number:r.number, amount:amt });
    });
    if(tooMuch.length){ err.textContent='ยอดที่รับเกินยอดรวม VAT ที่ค้าง: '+tooMuch.join(', '); err.classList.remove('hidden'); return; }
    if(!rows.length){ err.textContent='ใส่ยอดที่รับอย่างน้อย 1 ใบ'; err.classList.remove('hidden'); return; }
    if(noWht.length && !confirm('ยอดที่รับมากกว่ายอดค้างสุทธิ: '+noWht.join(', ')+'\n\nลูกค้าโอนเต็มจำนวนโดยไม่หัก ณ ที่จ่าย 3% ใช่ไหม?')) return;
    var btn=this; btn.disabled=true; btn.textContent='กำลังบันทึก…';
    api({ action:'settleServiceReceivables', token:state.token, paidAt:date, rows:rows }).then(function(res){
      btn.disabled=false; btn.textContent='บันทึกรับชำระ';
      if(!res.ok){ err.textContent='บันทึกไม่สำเร็จ: '+sarErr(res); err.classList.remove('hidden'); return; }
      close();
      var full=(res.updated||[]).filter(function(u){ return u.outstanding<=0.009; }).length;
      $('sar-msg').textContent='รับชำระแล้ว '+res.count+' ใบ (ครบ '+full+' • บางส่วน '+(res.count-full)+') วันที่ '+sarDmy(date);
      toast('รับชำระแล้ว '+res.count+' ใบ', 3000);
      svl.ready=false; sarLoad();
    }).catch(function(){ btn.disabled=false; btn.textContent='บันทึกรับชำระ'; err.textContent='เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'; err.classList.remove('hidden'); });
  });
}

/** อ่านไฟล์ตรวจยอด: คอลัมน์ A = เลขใบแจ้งหนี้ค่าบริการ, B = ยอดเงิน */
function sarReadFile(file){
  $('sar-msg').textContent='กำลังอ่านไฟล์ '+file.name+' …';
  var reader=new FileReader(), isCsv=/\.csv$/i.test(file.name);
  reader.onload=function(){
    var out=[];
    try{
      if(isCsv){
        String(reader.result).replace(/^﻿/,'').split(/\r?\n/).forEach(function(line){
          var c=line.split(','); out.push({ number:String(c[0]||'').replace(/"/g,'').trim(), amount:Number(String(c[1]||'').replace(/[",\s]/g,'')) });
        });
      } else {
        if(!window.XLSX) throw new Error('ไฟล์ .xlsx ต้องใช้อินเทอร์เน็ตเพื่อโหลดตัวอ่าน — หรือบันทึกเป็น .csv');
        var wb=XLSX.read(new Uint8Array(reader.result), { type:'array' });
        XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header:1 }).forEach(function(c){
          out.push({ number:String(c[0]==null?'':c[0]).trim(), amount:Number(String(c[1]==null?'':c[1]).replace(/[,\s]/g,'')) });
        });
      }
    }catch(e){ $('sar-msg').textContent='อ่านไฟล์ไม่สำเร็จ: '+(e.message||e); return; }
    // ตัดหัวตาราง / แถวว่าง (ยอดไม่ใช่ตัวเลข)
    out=out.filter(function(r){ return r.number && Number.isFinite(r.amount) && r.amount>0; });
    if(!out.length){ $('sar-msg').textContent='ไม่พบข้อมูลในไฟล์ (คอลัมน์ A = เลขใบแจ้งหนี้, B = ยอดเงิน)'; return; }
    api({ action:'matchServiceReceivables', token:state.token, rows:out }).then(function(res){
      if(!res.ok){ $('sar-msg').textContent='ตรวจไม่สำเร็จ: '+sarErr(res); return; }
      sar.matched=res.matched||[]; sarRenderMatch(res);
    });
  };
  if(isCsv) reader.readAsText(file, 'utf-8'); else reader.readAsArrayBuffer(file);
}
function sarRenderMatch(res){
  var box=$('sar-match');
  var html='<div class="card" style="padding:12px;background:#fff;border:1px solid var(--line);border-radius:12px"><b>ตรวจแล้ว: ตรงกับใบในระบบ '+res.matched.length+' รายการ'+
    (res.problems.length?' / มีปัญหา '+res.problems.length+' รายการ':'')+'</b>';
  if(res.matched.length){
    html+='<table class="inv-tbl" style="margin-top:8px"><thead><tr><th>เลขใบ</th><th>รายการ</th><th class="num">ยอดในไฟล์</th><th class="num">ค้างชำระ</th><th>ผลตรวจ</th></tr></thead><tbody>'+
      res.matched.map(function(m){
        var note=m.diff===0?'<span class="pill approved">ตรงพอดี</span>'
          :(Math.abs(m.diff-(m.total-m.netTotal))<0.01?'<span class="pill pending">โอนเต็มจำนวน (ไม่หัก ณ ที่จ่าย)</span>'
          :(m.diff<0?'<span class="pill pending">จ่ายไม่ครบ ขาด '+baht(-m.diff)+'</span>':'<span class="pill pending">จ่ายเกิน '+baht(m.diff)+'</span>'));
        return '<tr><td class="mono">'+esc(m.number)+'</td><td>'+esc(m.title)+'</td><td class="num">'+baht(m.amount)+'</td><td class="num">'+baht(m.outstanding)+'</td><td>'+note+'</td></tr>';
      }).join('')+'</tbody></table>';
  }
  if(res.problems.length){
    html+='<div style="margin-top:8px"><b>ตรวจไม่ผ่าน</b><ul style="margin:6px 0 0 18px">'+
      res.problems.map(function(p){ return '<li>'+esc(p.number||'(ไม่มีเลขใบ)')+' — '+esc(p.reason)+'</li>'; }).join('')+'</ul></div>';
  }
  if(res.matched.length){
    html+='<div class="toolbar" style="margin-top:10px"><label style="display:flex;align-items:center;gap:6px">วันที่รับชำระ <input type="date" id="sar-paid-at" value="'+sarToday()+'"></label>'+
      '<span class="grow"></span><button id="sar-settle" class="btn btn-primary btn-sm">รับชำระ '+res.matched.length+' รายการ</button></div>';
  }
  box.innerHTML=html+'</div>'; box.classList.remove('hidden');
  $('sar-msg').textContent='ตรวจไฟล์เสร็จแล้ว — กด "รับชำระ" เพื่อบันทึกยอด';
  if($('sar-settle')) $('sar-settle').addEventListener('click', function(){
    if(!confirm('บันทึกรับชำระ '+sar.matched.length+' รายการ?')) return;
    this.disabled=true;
    api({ action:'settleServiceReceivables', token:state.token, paidAt:$('sar-paid-at').value,
      rows:sar.matched.map(function(m){ return { number:m.number, amount:m.amount }; }) }).then(function(r2){
      if(!r2.ok){ alert('บันทึกไม่สำเร็จ: '+sarErr(r2)); return; }
      toast('รับชำระแล้ว '+r2.count+' รายการ', 3000);
      box.classList.add('hidden'); sar.matched=[]; svl.ready=false; sarLoad();
    });
  });
}
function sarUnsettle(){
  var picked=sarPicked().filter(function(r){ return r.paidAmount>0; });
  if(!picked.length) return;
  var withReceipt=picked.filter(function(r){ return r.receiptNo; });
  if(!confirm('ยกเลิกการชำระ '+picked.length+' รายการ? ยอดที่รับมาแล้วจะถูกล้าง'+
    (withReceipt.length?'\n\nใบเสร็จที่ออกไปแล้วจะถูกล้างเลขด้วย: '+withReceipt.map(function(r){ return r.receiptNo; }).join(', '):''))) return;
  api({ action:'unsettleServiceReceivables', token:state.token, numbers:picked.map(function(r){ return r.number; }), alsoClearReceipt:withReceipt.length>0 })
    .then(function(res){ if(!res.ok){ alert('ไม่สำเร็จ: '+sarErr(res)); return; } toast('ยกเลิกการชำระแล้ว'); svl.ready=false; sarLoad(); });
}

/**
 * ใบเสร็จรับเงิน / ใบกำกับภาษี — ฟอร์มเดียวกับใบแจ้งหนี้ค่าบริการ เปลี่ยนหัวเอกสารและเลขที่เป็น RE
 * ใบที่เคยออกเลขแล้วจะได้เลขเดิม (พิมพ์ซ้ำ)
 */
function sarPrintReceipts(numbers, receiptDate, reload){
  sarPdf(api({ action:'issueServiceReceipts', token:state.token, numbers:numbers, receiptDate:receiptDate }).then(function(res){
    if(!res.ok){ alert('ออกใบเสร็จไม่สำเร็จ: '+sarErr(res)); return null; }
    if(reload){ svl.ready=false; sarLoad(); }
    var fresh=res.issued.filter(function(r){ return !r.reused; }).length;
    if(fresh) toast('ออกใบเสร็จแล้ว '+fresh+' ใบ: '+res.issued.filter(function(r){ return !r.reused; }).map(function(r){ return r.receiptNo; }).join(', '), 4000);
    return { company:res.company, docs:res.issued.map(function(r){
      return { kind:'V', number:r.receiptNo, numberLabel:'เลขที่', issueDate:r.receiptDate, bl:'', ref:r.number, refLabel:'อ้างอิงใบแจ้งหนี้',
        items:r.items, subtotal:r.subtotal, vat:r.vat, total:r.total, withholding:r.withholding, netTotal:r.netTotal,
        payLabel:'รวมเงินที่รับชำระ', preparedLabel:'ผู้รับเงิน', preparedBy:(state.user&&state.user.name)||'',
        customerName:r.customerName, customerAddress:r.customerAddress, customerTaxId:r.customerTaxId };
    }) };
  }), 'ใบเสร็จ '+numbers.join(','), { title:'ใบเสร็จรับเงิน / ใบกำกับภาษี' });
}
