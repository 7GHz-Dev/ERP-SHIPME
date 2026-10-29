/* ใบสำคัญจ่าย (PV) / ใบสำคัญรับ (RV) — PDF ขนาด A4 หน้าตาเดียวกับใบสำคัญจ่ายที่ฝ่ายบัญชีทำใน Excel (PV20260937)
   วาดบน canvas ด้วยฟอนต์ Sarabun (ไฟล์ในเว็บเอง) หน้าละ 1 รูป JPEG แบบเดียวกับ invoice-pdf.js — ข้อมูลไม่ออกนอกเครื่อง
   ใบละ 14 บรรทัดต่อหน้า เกินนั้นขึ้นหน้าใหม่ ยอดรวมอยู่หน้าสุดท้าย */
(function(global){
  'use strict';
  var W=794, H=1123, ROWS=14, BLUE='#1E56A8';
  var TITLE={ PV:['ใบสำคัญจ่าย','PAYMENT VOUCHER','จ่ายให้แก่'], RV:['ใบสำคัญรับ','RECEIPT VOUCHER','ได้รับเงินจาก'] };

  function loadFonts(){
    return Promise.all(['400','600','700'].map(function(w){ return document.fonts.load(w+' 16px Sarabun'); }))
      .catch(function(){ throw new Error('โหลดฟอนต์ Sarabun ไม่สำเร็จ กรุณาลองใหม่'); });
  }
  function money(n){ return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function qtyText(n){ return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function dmy(ymd){ return String(ymd||'').split('-').reverse().join('/'); }

  /** จำนวนเงินเป็นตัวหนังสือ เช่น 260 → สองร้อยหกสิบบาทถ้วน, 1,000,001.25 → หนึ่งล้านเอ็ดบาทยี่สิบห้าสตางค์ */
  function bahtText(value){
    var n=Math.round(Math.abs(Number(value)||0)*100), baht=Math.floor(n/100), satang=n%100;
    var DIGIT=['','หนึ่ง','สอง','สาม','สี่','ห้า','หก','เจ็ด','แปด','เก้า'], UNIT=['','สิบ','ร้อย','พัน','หมื่น','แสน'];
    function under1m(num, hasHigher){
      var s=String(num), out='';
      for(var i=0;i<s.length;i++){
        var d=+s[i], pos=s.length-i-1;
        if(!d) continue;
        if(pos===1 && d===1) out+='สิบ';
        else if(pos===1 && d===2) out+='ยี่สิบ';
        else if(pos===0 && d===1 && (s.length>1 || hasHigher)) out+='เอ็ด';
        else out+=DIGIT[d]+UNIT[pos];
      }
      return out;
    }
    function read(num){
      if(num<1e6) return under1m(num, false);
      var high=Math.floor(num/1e6), rest=num%1e6;
      return read(high)+'ล้าน'+(rest ? under1m(rest, true) : '');
    }
    if(!baht && !satang) return 'ศูนย์บาทถ้วน';
    return (Number(value)<0?'ลบ':'')+(baht ? read(baht)+'บาท' : '')+(satang ? read(satang)+'สตางค์' : 'ถ้วน');
  }

  function wrap(ctx, value, width){
    var parts=typeof Intl.Segmenter==='function'
      ? Array.from(new Intl.Segmenter('th',{granularity:'word'}).segment(String(value||'')), function(s){ return s.segment; })
      : Array.from(String(value||''));
    var lines=[], line='';
    parts.forEach(function(p){
      if(ctx.measureText(line+p).width>width && line){ lines.push(line); line=p.replace(/^\s+/,''); }
      else line+=p;
    });
    if(line) lines.push(line);
    return lines;
  }

  function drawPage(v, company, rows, startNo, pageIndex, pageCount){
    var canvas=document.createElement('canvas'); canvas.width=W*2; canvas.height=H*2;
    var ctx=canvas.getContext('2d'); ctx.scale(2,2);
    ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H); ctx.fillStyle='#111'; ctx.textBaseline='alphabetic';
    function text(value,x,y,size,weight,align,color,maxWidth){
      ctx.font=(weight||400)+' '+(size||13)+'px Sarabun, sans-serif';
      ctx.textAlign=align||'left'; ctx.fillStyle=color||'#111';
      ctx.fillText(String(value==null?'':value), x, y, maxWidth||W);
      ctx.fillStyle='#111';
    }
    function line(x1,y1,x2,y2,width,dash){
      ctx.save(); ctx.strokeStyle='#333'; ctx.lineWidth=width||.8; if(dash) ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); ctx.restore();
    }
    function box(x,y,w,h,fill){
      if(fill){ ctx.fillStyle=fill; ctx.fillRect(x,y,w,h); ctx.fillStyle='#111'; }
      ctx.strokeStyle='#555'; ctx.lineWidth=.8; ctx.strokeRect(x,y,w,h);
    }
    function checkbox(x,y,on,label){
      ctx.strokeStyle='#111'; ctx.lineWidth=1.3; ctx.strokeRect(x,y-11,12,12);
      if(on){
        ctx.fillStyle='#111'; ctx.fillRect(x,y-11,12,12);
        ctx.strokeStyle='#fff'; ctx.lineWidth=1.8; ctx.beginPath(); ctx.moveTo(x+2.5,y-5); ctx.lineTo(x+5,y-2.3); ctx.lineTo(x+9.8,y-8.5); ctx.stroke();
      }
      text(label, x+24, y, 13, 700);
    }
    var L=56, R=W-56, title=TITLE[v.kind]||TITLE.PV;

    // หัวบริษัท
    text(company.name||'', W/2, 92, 27, 700, 'center');
    text(company.address||'', W/2, 116, 11.5, 600, 'center');
    text('เลขประจำตัวผู้เสียภาษี '+(company.taxId||''), W/2, 132, 11.5, 600, 'center');

    // ชื่อเอกสาร + วันที่ / เลขที่
    text(title[0], L, 196, 25, 700, 'left', BLUE);
    text(title[1], L, 220, 13.5, 700, 'left', BLUE);
    line(L, 228, L+250, 228, 1);
    text('วันที่', 600, 196, 13, 700); text(dmy(v.voucherDate), R, 196, 13, 700, 'right');
    text('เลขที่', 600, 218, 13, 700); text(v.number, R, 218, 13, 700, 'right');

    // จ่ายให้แก่ / ได้รับเงินจาก + วิธีชำระ
    ctx.font='700 13.5px Sarabun, sans-serif';
    var labelW=ctx.measureText(title[2]+' ').width;
    text(title[2], L, 282, 13.5, 700);
    line(L+labelW+4, 285, L+470, 285, 1, [1.5,2.5]);
    text(v.party||'', L+labelW+18, 280, 13.5, 700, 'left', '#111', 440-labelW);
    checkbox(L+14, 310, v.payMethod==='cash', 'เงินสด');
    checkbox(L+134, 310, v.payMethod==='transfer', 'เงินโอน'+(v.payMethod==='transfer' && v.payRef ? ' '+v.payRef : ''));
    checkbox(L+294, 310, v.payMethod==='cheque', 'เช็คธนาคาร'+(v.payMethod==='cheque' && v.payRef ? ' '+v.payRef : '............'));

    // ตารางรายการ
    var cols=[[L,'ลำดับ',54],[0,'รายการ',318],[0,'จำนวน',56],[0,'ราคา/ หน่วย',82],[0,'จำนวนเงิน',92],[0,'หมายเหตุ',0]];
    var x=L; cols.forEach(function(c, i){ c[0]=x; if(i===cols.length-1) c[2]=R-x; x+=c[2]; });
    var top=345, headH=46, rowH=30;
    cols.forEach(function(c){ box(c[0], top, c[2], headH, '#d4d4d4'); text(c[1], c[0]+c[2]/2, top+28, 13, 700, 'center'); });
    for(var r=0;r<ROWS;r++){
      var y=top+headH+r*rowH, e=rows[r];
      cols.forEach(function(c){ box(c[0], y, c[2], rowH); });
      text(startNo+r, cols[0][0]+cols[0][2]/2, y+20, 12.5, 400, 'center');
      if(!e) continue;
      ctx.font='400 12.5px Sarabun, sans-serif';
      var desc=wrap(ctx, e.description, cols[1][2]-10);
      if(desc.length>1){
        ctx.font='400 11px Sarabun, sans-serif';
        desc=wrap(ctx, e.description, cols[1][2]-10);
        text(desc[0], cols[1][0]+5, y+13, 11, 400, 'left', '#111', cols[1][2]-10);
        text(desc.slice(1).join(''), cols[1][0]+5, y+25, 11, 400, 'left', '#111', cols[1][2]-10);
      } else text(desc[0]||'', cols[1][0]+5, y+20, 12.5, 400, 'left', '#111', cols[1][2]-10);
      var qty=Number(e.qty)||1;
      text(qtyText(qty), cols[2][0]+cols[2][2]-6, y+20, 12.5, 400, 'right');
      text(money(e.amount/qty), cols[3][0]+cols[3][2]-6, y+20, 12.5, 400, 'right');
      text(money(e.amount), cols[4][0]+cols[4][2]-6, y+20, 12.5, 400, 'right');
      text(e.note||'', cols[5][0]+4, y+20, 10.5, 400, 'left', '#111', cols[5][2]-8);
    }
    var bandTop=top+headH+ROWS*rowH, last=pageIndex===pageCount-1;

    if(last){
      // แถบยอดรวม (พื้นเทาเต็มความกว้างเหมือนต้นฉบับ)
      ctx.fillStyle='#d4d4d4'; ctx.fillRect(L, bandTop, R-L, 116); ctx.fillStyle='#111';
      var rates=[]; v.entries.forEach(function(e){ if(e.whtType && e.whtRate && rates.indexOf(e.whtRate)<0) rates.push(e.whtRate); });
      var labelX=cols[2][0]-2, valueX=cols[4][0]+cols[4][2]-6, ly=bandTop+20, lh=20.5;
      var lines=[['จำนวนเงินรวม', v.amount], ['ภาษีมูลค่าเพิ่ม 7%', v.vat], ['รวมเงินทั้งสิ้น', v.amount+v.vat],
        ['หักภาษี ณ ที่จ่าย'+(rates.length===1 ? ' '+rates[0]+'%' : ''), v.wht], ['คงเหลือสุทธิ', v.net]];
      lines.forEach(function(row, i){
        text(row[0], labelX, ly+i*lh, 13, 700);
        text(money(row[1]), valueX, ly+i*lh, 13, 700, 'right');
      });
      line(valueX-100, ly+3*lh+5, valueX+2, ly+3*lh+5, 1);
      line(valueX-100, ly+4*lh+4, valueX+2, ly+4*lh+4, 1);
      text('จำนวนเงิน', L+4, ly+4*lh, 13, 700);
      text('('+bahtText(v.net)+')', cols[1][0]+cols[1][2]/2-20, ly+4*lh, 13, 700, 'center', '#111', cols[1][2]);
    } else {
      text('มีต่อหน้าถัดไป', R, bandTop+22, 12, 600, 'right', '#555');
    }

    // ลายเซ็น
    var sy=bandTop+215, names=[[v.preparedBy||'', 'ผู้จัดทำ'], ['', 'ผู้ตรวจสอบ'], ['', v.kind==='RV' ? 'ผู้รับเงิน' : 'ผู้อนุมัติ']];
    [L+70, W/2, R-70].forEach(function(cx, i){
      if(names[i][0]) text(names[i][0], cx, sy-5, 12.5, 600, 'center');
      line(cx-70, sy, cx+70, sy, .8, [1,2]);
      text(names[i][1], cx, sy+17, 12.5, 400, 'center');
    });
    if(pageCount>1) text('หน้า '+(pageIndex+1)+'/'+pageCount, R, H-40, 11, 400, 'right', '#555');

    var raw=atob(canvas.toDataURL('image/jpeg', .92).split(',')[1]);
    return { width:canvas.width, height:canvas.height, bytes:Uint8Array.from(raw, function(ch){ return ch.charCodeAt(0); }) };
  }

  /** PDF หลายหน้า (A4 595.28×841.89 pt) — หน้าละรูป JPEG */
  function pdfBytes(pages){
    var encoder=new TextEncoder(), chunks=[], offsets=[0], length=0;
    function write(data){ var bytes=typeof data==='string' ? encoder.encode(data) : data; chunks.push(bytes); length+=bytes.length; }
    function object(id, data){ offsets[id]=length; write(id+' 0 obj\n'); write(data); write('\nendobj\n'); }
    write('%PDF-1.4\n');
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(2, '<< /Type /Pages /Count '+pages.length+' /Kids ['+pages.map(function(_, i){ return (3+i*3)+' 0 R'; }).join(' ')+'] >>');
    pages.forEach(function(page, i){
      var id=3+i*3, content='q 595.28 0 0 841.89 0 0 cm /Im Do Q';
      object(id, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im '+(id+1)+' 0 R >> >> /Contents '+(id+2)+' 0 R >>');
      offsets[id+1]=length;
      write((id+1)+' 0 obj\n<< /Type /XObject /Subtype /Image /Width '+page.width+' /Height '+page.height+' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '+page.bytes.length+' >>\nstream\n');
      write(page.bytes); write('\nendstream\nendobj\n');
      object(id+2, '<< /Length '+content.length+' >>\nstream\n'+content+'\nendstream');
    });
    var xref=length;
    write('xref\n0 '+offsets.length+'\n0000000000 65535 f \n');
    offsets.slice(1).forEach(function(offset){ write(String(offset).padStart(10,'0')+' 00000 n \n'); });
    write('trailer\n<< /Size '+offsets.length+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF');
    return new Blob(chunks, { type:'application/pdf' });
  }

  global.VoucherPDF = {
    bahtText: bahtText,
    create: async function(vouchers, company){
      if(!vouchers.length) throw new Error('ไม่มีใบสำคัญ');
      await loadFonts();
      var pages=[];
      vouchers.forEach(function(v){
        var list=v.entries||[], count=Math.max(1, Math.ceil(list.length/ROWS));
        for(var p=0;p<count;p++) pages.push(drawPage(v, company||{}, list.slice(p*ROWS, (p+1)*ROWS), p*ROWS+1, p, count));
      });
      return pdfBytes(pages);
    }
  };
})(window);
