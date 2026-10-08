/**
 * สรุปยอด + รายงานลูกหนี้คงค้าง (ใช้ร่วมกันทั้ง ADV และค่าบริการ)
 *
 * - summary(): การ์ดสรุปบนหน้าเมนู — จำนวนใบ ยอดคงค้าง ชำระบางส่วน และอายุหนี้ 4 ช่วง
 * - open(): รายงานสำหรับส่งติดตามลูกค้า เปิดหน้าต่างใหม่ จัดหน้า A4 พร้อมพิมพ์ / บันทึกเป็น PDF
 * - excel(): ไฟล์ Excel รายการเดียวกับรายงาน (ใช้ SheetJS ที่หน้า admin โหลดไว้แล้ว)
 *
 * แถวที่ส่งเข้ามา: { number, issueDate, ref, detail, total, withholding?, net, paid, outstanding }
 */
(function(global){
  'use strict';
  var BUCKETS = [
    { label:'ไม่เกิน 30 วัน', max:30 },
    { label:'31 – 60 วัน', max:60 },
    { label:'61 – 90 วัน', max:90 },
    { label:'เกิน 90 วัน', max:Infinity }
  ];
  var MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  var MONTHS_FULL = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function money(n){ return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function dmy(ymd){ return ymd ? String(ymd).split('-').reverse().join('/') : '—'; }
  function thaiLong(ymd){ var p=String(ymd||'').split('-'); return p.length===3 ? (+p[2])+' '+MONTHS_FULL[+p[1]-1]+' '+(+p[0]+543) : ''; }
  function days(from, to){
    var a=Date.UTC(+from.slice(0,4), +from.slice(5,7)-1, +from.slice(8,10)), b=Date.UTC(+to.slice(0,4), +to.slice(5,7)-1, +to.slice(8,10));
    return Math.max(0, Math.round((b-a)/86400000));
  }
  function bucketOf(age){ for(var i=0;i<BUCKETS.length;i++) if(age<=BUCKETS[i].max) return i; return BUCKETS.length-1; }

  /** ตัวเลขสรุป — นับเฉพาะใบที่ยังค้าง (outstanding > 0) */
  function summary(rows, today){
    var out={ count:0, outstanding:0, total:0, partial:0, buckets:BUCKETS.map(function(b){ return { label:b.label, count:0, amount:0 }; }) };
    rows.forEach(function(r){
      if(!(Number(r.outstanding)>0)) return;
      out.count++; out.outstanding+=Number(r.outstanding); out.total+=Number(r.net);
      if(Number(r.paid)>0) out.partial++;
      var b=out.buckets[bucketOf(days(r.issueDate, today))]; b.count++; b.amount+=Number(r.outstanding);
    });
    out.outstanding=Math.round(out.outstanding*100)/100;
    return out;
  }

  /** การ์ดสรุปบนหน้าเมนู */
  function summaryHtml(rows, today, rangeText){
    var s=summary(rows, today);
    var html='<div class="ar-sum">'+
      '<div class="ar-card main"><div class="l">ยอดคงค้างรวม</div><div class="n">'+money(s.outstanding)+'</div><div class="s">'+s.count+' ใบ'+(s.partial?' • ชำระบางส่วน '+s.partial+' ใบ':'')+'</div></div>';
    s.buckets.forEach(function(b, i){
      html+='<div class="ar-card'+(i===3&&b.count?' late':'')+'"><div class="l">อายุหนี้ '+b.label+'</div><div class="n">'+money(b.amount)+'</div><div class="s">'+b.count+' ใบ</div></div>';
    });
    html+='</div><div class="muted" style="margin:-4px 2px 12px">'+esc(rangeText)+' • อายุหนี้นับจากวันที่ออกใบแจ้งหนี้ถึงวันนี้ ('+dmy(today)+')</div>';
    return html;
  }

  function rangeText(from, to){
    if(from && to) return 'วันที่ใบแจ้งหนี้ '+dmy(from)+' – '+dmy(to);
    if(from) return 'วันที่ใบแจ้งหนี้ตั้งแต่ '+dmy(from);
    if(to) return 'วันที่ใบแจ้งหนี้ถึง '+dmy(to);
    return 'ใบแจ้งหนี้ทุกวันที่';
  }

  /**
   * รายงานติดตามลูกหนี้ — opts:
   *   title, subtitle, rows, from, to, today, company{name,address,taxId,logoUrl,bankAccountName,bankAccountNo},
   *   customer{name,address,taxId}, refLabel ('B/L' / 'รายการ'), withholding (true = มีคอลัมน์หัก ณ ที่จ่าย)
   */
  function open(opts){
    var rows=opts.rows.filter(function(r){ return Number(r.outstanding)>0; });
    var w=window.open('', '_blank');
    if(!w){ alert('เบราว์เซอร์บล็อกหน้าต่างใหม่ — อนุญาต popup ก่อน'); return; }
    var co=opts.company||{}, cu=opts.customer||{}, today=opts.today, s=summary(rows, today);
    var wh=!!opts.withholding;
    var head='<tr><th class="c">ลำดับ</th><th>เลขที่ใบแจ้งหนี้</th><th class="c">วันที่</th><th>'+esc(opts.refLabel||'รายการ')+'</th>'+
      '<th class="r">ยอดตามใบแจ้งหนี้</th>'+(wh?'<th class="r">หัก ณ ที่จ่าย</th><th class="r">ยอดที่ต้องชำระ</th>':'')+
      '<th class="r">ชำระแล้ว</th><th class="r">คงค้าง</th><th class="c">อายุ (วัน)</th></tr>';
    var body=rows.map(function(r, i){
      var age=days(r.issueDate, today);
      return '<tr'+(age>90?' class="late"':'')+'><td class="c">'+(i+1)+'</td><td class="mono">'+esc(r.number)+'</td><td class="c">'+dmy(r.issueDate)+'</td>'+
        '<td class="ref">'+esc(r.ref||'')+(r.detail?'<div class="sub">'+esc(r.detail)+'</div>':'')+'</td>'+
        '<td class="r">'+money(r.total)+'</td>'+(wh?'<td class="r">'+money(r.withholding)+'</td><td class="r">'+money(r.net)+'</td>':'')+
        '<td class="r">'+(Number(r.paid)>0?money(r.paid):'-')+'</td><td class="r b">'+money(r.outstanding)+'</td><td class="c">'+age+'</td></tr>';
    }).join('');
    var sum=function(k){ return rows.reduce(function(t,r){ return t+Number(r[k]||0); },0); };
    var foot='<tr class="tot"><td colspan="4" class="r">รวม '+rows.length+' ใบ</td><td class="r">'+money(sum('total'))+'</td>'+
      (wh?'<td class="r">'+money(sum('withholding'))+'</td><td class="r">'+money(sum('net'))+'</td>':'')+
      '<td class="r">'+money(sum('paid'))+'</td><td class="r">'+money(s.outstanding)+'</td><td></td></tr>';
    var aging=s.buckets.map(function(b){ return '<td><div class="al">'+b.label+'</div><div class="an">'+money(b.amount)+'</div><div class="ac">'+b.count+' ใบ</div></td>'; }).join('');

    var html='<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><title>'+esc(opts.title)+' '+dmy(today)+'</title>'+
      '<style>'+
      '@font-face{font-family:Sarabun;src:url("/fonts/Sarabun-Regular.ttf");font-weight:400}'+
      '@font-face{font-family:Sarabun;src:url("/fonts/Sarabun-SemiBold.ttf");font-weight:600}'+
      '@font-face{font-family:Sarabun;src:url("/fonts/Sarabun-Bold.ttf");font-weight:700}'+
      '@page{size:A4 '+(wh?'landscape':'portrait')+';margin:12mm 10mm 14mm}'+
      '*{box-sizing:border-box}body{margin:0;font-family:Sarabun,sans-serif;color:#111;font-size:12.5px;background:#eef1f5}'+
      '.page{background:#fff;max-width:'+(wh?'297mm':'210mm')+';margin:16px auto;padding:14mm 12mm;box-shadow:0 2px 12px rgba(0,0,0,.12)}'+
      '.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid #002967;padding-bottom:10px}'+
      '.co{display:flex;gap:12px;align-items:center}.co img{height:54px}.co b{font-size:15px}.co div{line-height:1.45}'+
      '.doc{text-align:right;max-width:52%}.doc h1{margin:0;font-size:18px;color:#002967;line-height:1.3}.doc .sub{color:#475569;margin-top:2px}'+
      '.meta{display:grid;grid-template-columns:1.4fr 1fr;gap:12px;margin:12px 0}'+
      '.box{border:1px solid #cbd5e1;border-radius:8px;padding:9px 12px;line-height:1.55}.box .k{color:#64748b;font-size:11.5px}'+
      '.aging{width:100%;border-collapse:separate;border-spacing:6px 0;margin:4px -6px 12px;table-layout:fixed}'+
      '.aging td{border:1px solid #cbd5e1;border-radius:8px;padding:7px 9px;vertical-align:top}'+
      '.aging td.main{background:#002967;color:#fff;border-color:#002967}.aging .al{font-size:11px;opacity:.8}.aging .an{font-size:15px;font-weight:700}.aging .ac{font-size:11px;opacity:.8}'+
      'table.list{width:100%;border-collapse:collapse}table.list th{background:#002967;color:#fff;font-weight:600;padding:6px 6px;font-size:11.5px;text-align:left;white-space:nowrap}'+
      'table.list .ref{min-width:170px}table.list .sub{white-space:nowrap}'+
      'table.list td{border-bottom:1px solid #e2e8f0;padding:5px 6px;vertical-align:top}table.list tr:nth-child(even) td{background:#f8fafc}'+
      'table.list tr.late td{background:#fff1f2}table.list .tot td{background:#e8eefb!important;font-weight:700;border-top:2px solid #002967}'+
      '.c{text-align:center}.r{text-align:right;white-space:nowrap}.b{font-weight:700}.mono{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;white-space:nowrap}.sub{color:#64748b;font-size:11px}'+
      'thead{display:table-header-group}tr{page-break-inside:avoid}'+
      '.pay{margin-top:14px;display:grid;grid-template-columns:1.4fr 1fr;gap:12px}.sign{text-align:center;padding-top:28px}'+
      '.bar{position:sticky;top:0;background:#002967;color:#fff;padding:10px 16px;display:flex;gap:10px;align-items:center;z-index:2}'+
      '.bar button{border:0;border-radius:8px;padding:8px 14px;font:600 14px Sarabun,sans-serif;cursor:pointer}'+
      '@media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;padding:0}.bar{display:none}}'+
      '</style></head><body>'+
      '<div class="bar"><b style="flex:1">'+esc(opts.title)+'</b><button onclick="window.print()">🖨 พิมพ์ / บันทึก PDF</button></div>'+
      '<div class="page">'+
        '<div class="top"><div class="co">'+(co.logoUrl?'<img src="'+esc(co.logoUrl)+'" onerror="this.remove()">':'')+
          '<div><b>'+esc(co.name)+'</b><br>'+esc(co.address)+'<br>เลขประจำตัวผู้เสียภาษี '+esc(co.taxId)+'</div></div>'+
          '<div class="doc"><h1>'+esc(opts.title)+'</h1><div class="sub">'+esc(opts.subtitle||'')+'</div><div class="sub">ข้อมูล ณ วันที่ '+thaiLong(today)+'</div></div></div>'+
        '<div class="meta"><div class="box"><div class="k">เรียน</div><b>'+esc(cu.name)+'</b><br>'+esc(cu.address)+'<br>เลขประจำตัวผู้เสียภาษี '+esc(cu.taxId)+'</div>'+
          '<div class="box"><div class="k">ช่วงที่แสดง</div>'+esc(rangeText(opts.from, opts.to))+
          '<div class="k" style="margin-top:4px">ยอดคงค้างทั้งสิ้น</div><b style="font-size:16px;color:#b91c1c">'+money(s.outstanding)+' บาท</b> ('+s.count+' ใบ)</div></div>'+
        '<table class="aging"><tr><td class="main"><div class="al">ยอดคงค้างรวม</div><div class="an">'+money(s.outstanding)+'</div><div class="ac">'+s.count+' ใบ</div></td>'+aging+'</tr></table>'+
        (rows.length ? '<table class="list"><thead>'+head+'</thead><tbody>'+body+foot+'</tbody></table>'
                     : '<div class="box" style="text-align:center;padding:24px">ไม่มียอดคงค้างในช่วงนี้</div>')+
        '<div class="pay"><div class="box"><div class="k">ช่องทางการชำระเงิน</div>ชื่อบัญชี : '+esc(co.bankAccountName)+'<br>เลขที่บัญชี : '+esc(co.bankAccountNo)+
          (co.note?'<div class="sub" style="margin-top:4px">'+esc(co.note)+'</div>':'')+'</div>'+
          '<div class="sign">..............................................<br>ผู้จัดทำ '+esc(opts.preparedBy||'')+'<br><span class="sub">'+thaiLong(today)+'</span></div></div>'+
        '<div class="sub" style="margin-top:10px">หากท่านชำระแล้ว กรุณาส่งหลักฐานการโอนเงินพร้อมหนังสือรับรองการหัก ณ ที่จ่าย (ถ้ามี) เพื่อให้บริษัทฯ ตัดยอดได้ถูกต้อง ขอบคุณครับ/ค่ะ</div>'+
      '</div></body></html>';
    w.document.open(); w.document.write(html); w.document.close();
  }

  /** Excel รายการเดียวกับรายงาน */
  function excel(opts){
    if(!global.XLSX){ alert('ตัวสร้างไฟล์ Excel ยังไม่โหลด (ต้องใช้อินเทอร์เน็ต)'); return; }
    var rows=opts.rows.filter(function(r){ return Number(r.outstanding)>0; }), wh=!!opts.withholding;
    var head=['ลำดับ','เลขที่ใบแจ้งหนี้','วันที่','อายุ (วัน)',opts.refLabel||'รายการ','ยอดตามใบแจ้งหนี้'].concat(wh?['หัก ณ ที่จ่าย','ยอดที่ต้องชำระ']:[]).concat(['ชำระแล้ว','คงค้าง']);
    var aoa=[[opts.title+' — ข้อมูล ณ วันที่ '+dmy(opts.today)],[rangeText(opts.from, opts.to)],[],head];
    rows.forEach(function(r, i){
      aoa.push([i+1, r.number, dmy(r.issueDate), days(r.issueDate, opts.today), [r.ref, r.detail].filter(Boolean).join(' — '), Number(r.total)]
        .concat(wh?[Number(r.withholding), Number(r.net)]:[]).concat([Number(r.paid)||0, Number(r.outstanding)]));
    });
    var ws=XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols']=[{wch:7},{wch:16},{wch:11},{wch:9},{wch:40},{wch:15}].concat(wh?[{wch:13},{wch:15}]:[]).concat([{wch:13},{wch:15}]);
    var wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'ลูกหนี้คงค้าง');
    XLSX.writeFile(wb, opts.fileName || 'ลูกหนี้คงค้าง.xlsx');
  }

  global.ArReport = { summary:summary, summaryHtml:summaryHtml, open:open, excel:excel, rangeText:rangeText, days:days, dmy:dmy };
})(window);
