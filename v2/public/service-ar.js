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
});

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
function svlRender(){
  var q=$('svl-search').value.trim().toLowerCase();
  var rows=svl.rows.filter(function(r){ return !q || (r.number+' '+r.title+' '+(r.receiptNo||'')).toLowerCase().indexOf(q)>=0; });
  var sum=rows.reduce(function(t,r){ return t+Number(r.netTotal); },0);
  $('svl-msg').textContent=rows.length ? ('แสดง '+rows.length+' ใบ • ยอดชำระสุทธิรวม '+baht(sum)+' บาท') : '';
  $('svl-body').innerHTML=rows.length ? rows.map(function(r){
    var status = r.receiptNo ? '<span class="pill approved mono">ใบเสร็จ '+esc(r.receiptNo)+'</span>'
      : (r.outstanding<=0 ? '<span class="pill approved">ชำระครบ</span>'
      : (r.paidAmount>0 ? '<span class="pill pending">ชำระบางส่วน ค้าง '+baht(r.outstanding)+'</span>' : '<span class="pill pending">ค้างชำระ</span>'));
    return '<tr><td><b class="mono">'+esc(r.number)+'</b><div class="sub">'+sarDmy(r.issueDate)+'</div></td>'+
      '<td>'+esc(r.title)+'</td><td>'+sarRange(r)+'</td>'+
      '<td class="num">'+baht(r.total)+'</td><td class="num">'+baht(r.withholding)+'</td><td class="num"><b>'+baht(r.netTotal)+'</b></td>'+
      '<td>'+status+'</td><td class="acts">'+
        '<button class="btn btn-ghost btn-sm" data-act="pdf" data-n="'+esc(r.number)+'">ดู PDF</button>'+
        (r.receiptNo ? '<button class="btn btn-ghost btn-sm" data-act="receipt" data-n="'+esc(r.number)+'">ใบเสร็จ</button>' : '')+
        (!r.receiptNo && !(r.paidAmount>0) ? '<button class="btn btn-ghost btn-sm" data-act="cancel" data-n="'+esc(r.number)+'" style="color:#b91c1c">ยกเลิก</button>' : '')+
      '</td></tr>';
  }).join('') : '<tr><td colspan="8" class="muted" style="padding:20px">ยังไม่มีใบแจ้งหนี้ค่าบริการที่บันทึกในระบบ</td></tr>';
}
function svlOnClick(e){
  var b=e.target.closest('[data-act]'); if(!b) return;
  var n=b.getAttribute('data-n'), act=b.getAttribute('data-act');
  if(act==='pdf') return svcPrintInvoice(n);
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
    return { number:r.number, issueDate:r.issueDate, ref:String(r.title||'').replace(/^ใบแจ้งหนี้/,''), detail:'ตรวจปล่อย '+sarRange(r),
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
      '<td>'+esc(r.title)+'<div class="sub">ตรวจปล่อย '+sarRange(r)+' • รวม VAT '+baht(r.total)+' − หัก 3% '+baht(r.withholding)+'</div></td>'+
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
