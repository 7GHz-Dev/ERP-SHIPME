/* Letter PDF export matching V20260904.pdf. Bundled Sarabun fonts render Thai consistently.
   Each page is a 2x JPEG; no external service receives invoice data. */
(function(global){
  'use strict';
  var fontPromise;
  function loadSarabun(){
    if(!fontPromise){
      fontPromise=Promise.all([[400,'Regular'],[600,'SemiBold'],[700,'Bold'],[800,'ExtraBold']].map(function(entry){
        var face=new FontFace('Sarabun','url(/fonts/Sarabun-'+entry[1]+'.ttf)',{weight:String(entry[0])});
        return face.load().then(function(font){document.fonts.add(font);});
      })).catch(function(){fontPromise=null;throw new Error('โหลดฟอนต์ Sarabun ไม่สำเร็จ กรุณาลองใหม่');});
    }
    return fontPromise;
  }
  function loadImage(url){
    if(!url) return Promise.resolve(null);
    return new Promise(function(resolve, reject){
      var img = new Image();
      img.onload = function(){ resolve(img); };
      img.onerror = function(){ reject(new Error('โหลดโลโก้หรือตราประทับไม่สำเร็จ')); };
      img.src = url;
    });
  }
  function pdfBytes(pages){
    var encoder = new TextEncoder(), chunks = [], offsets = [0], length = 0;
    function write(data){ var bytes = typeof data === 'string' ? encoder.encode(data) : data; chunks.push(bytes); length += bytes.length; }
    function object(id, data){ offsets[id] = length; write(id+' 0 obj\n'); write(data); write('\nendobj\n'); }
    write('%PDF-1.4\n');
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(2, '<< /Type /Pages /Count '+pages.length+' /Kids ['+pages.map(function(_,i){ return (3+i*3)+' 0 R'; }).join(' ')+'] >>');
    pages.forEach(function(page,i){
      var id = 3+i*3;
      object(id, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im '+(id+1)+' 0 R >> >> /Contents '+(id+2)+' 0 R >>');
      offsets[id+1] = length;
      write((id+1)+' 0 obj\n<< /Type /XObject /Subtype /Image /Width '+page.width+' /Height '+page.height+' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '+page.bytes.length+' >>\nstream\n');
      write(page.bytes); write('\nendstream\nendobj\n');
      var content = 'q 612 0 0 792 0 0 cm /Im Do Q';
      object(id+2, '<< /Length '+content.length+' >>\nstream\n'+content+'\nendstream');
    });
    var xref = length;
    write('xref\n0 '+offsets.length+'\n0000000000 65535 f \n');
    offsets.slice(1).forEach(function(offset){ write(String(offset).padStart(10,'0')+' 00000 n \n'); });
    write('trailer\n<< /Size '+offsets.length+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF');
    return new Blob(chunks, {type:'application/pdf'});
  }
  function wrapLines(ctx,value,width){
    var words=typeof Intl.Segmenter==='function'?Array.from(new Intl.Segmenter('th',{granularity:'word'}).segment(String(value||'')),function(s){return s.segment;}):Array.from(String(value||''));
    var lines=[],line='';
    words.forEach(function(word){
      if(ctx.measureText(line+word).width>width && line){lines.push(line);line='';}
      Array.from(word).forEach(function(char){
        if(ctx.measureText(line+char).width>width){lines.push(line);line='';}
        line+=char;
      });
    });
    if(line)lines.push(line);return lines;
  }
  function paginate(items){
    if(!items||!items.length) return [[]];
    var ctx=document.createElement('canvas').getContext('2d');
    ctx.font='13px "Sarabun", sans-serif';
    var pages=[],page=[],height=0;
    items.forEach(function(item,index){
      var h=Math.max(28,Math.max(wrapLines(ctx,item.label,231).length,wrapLines(ctx,item.note,111).length)*17+10);
      if(height+h>420&&page.length){pages.push(page);page=[];height=0;}
      page.push({item:item,height:h,no:index+1});height+=h;
    });
    if(page.length||!pages.length)pages.push(page);return pages;
  }
  function drawPage(invoice, company, images, items, pageIndex, pageCount, options){
    var canvas = document.createElement('canvas'); canvas.width = 1632; canvas.height = 2112;
    var ctx = canvas.getContext('2d'); ctx.scale(2,2);
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,816,1056); ctx.fillStyle = '#111';
    function text(value,x,y,size,bold,align,maxWidth){
      ctx.font = (typeof bold==='number'?bold+' ':(bold?'700 ':''))+(size||13)+'px "Sarabun", sans-serif';
      ctx.textAlign = align||'left';
      ctx.fillText(String(value == null?'':value),x,y,maxWidth||720);
    }
    function wrapped(value,x,y,width,lineHeight,size){
      ctx.font = (size||13)+'px "Sarabun", sans-serif';
      var lines=wrapLines(ctx,value,width);
      lines.forEach(function(v,i){ text(v,x,y+i*lineHeight,size); });
      return lines.length*lineHeight;
    }
    function rule(x,y,w,h,fill){
      if(fill){ ctx.fillStyle=fill; ctx.fillRect(x,y,w,h); ctx.fillStyle='#111'; }
      ctx.strokeStyle='#444'; ctx.lineWidth=.7; ctx.strokeRect(x,y,w,h);
    }
    function money(n){ return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
    var cover=invoice.kind==='COVER';
    if(cover){
      // หน้าปกชุด — มีแค่ข้อความส่งชุดตัวใหญ่
      // ไม่มีหัวบริษัท ไม่มีตราประทับ ไม่มีตารางรายการหรือช่องยอด
      // ขนาดตัวอักษรใหญ่ขึ้น 3 เท่าจากของเดิม (หัวเรื่อง 19→57, ข้อความ 22→66)
      text('หน้าปกชุดเอกสาร',408,150,57,true,'center',740);
      wrapped(invoice.coverMessage||'',38,300,740,90,66);
      var raw0=atob(canvas.toDataURL('image/jpeg',.94).split(',')[1]);
      return {width:canvas.width,height:canvas.height,bytes:Uint8Array.from(raw0,function(char){return char.charCodeAt(0);})};
    }
    // Coordinates measured from the supplied Letter reference at 96 CSS pixels/inch.
    if(images[0]){ var ratio=Math.min(200/images[0].width,78/images[0].height); ctx.drawImage(images[0],408-images[0].width*ratio/2,38,images[0].width*ratio,images[0].height*ratio); }
    text(company.name,408,138,15,true,'center');
    text(company.address,408,155,13,false,'center');
    text('เลขประจำตัวผู้เสียภาษี '+company.taxId,408,172,13,false,'center');
    text((options&&options.title)||'ใบแจ้งหนี้ / INVOICE',408,209,19,true,'center');
    text('ชื่อลูกค้า : '+invoice.customerName,38,243,13,false,'left',453);
    text('ที่อยู่ : '+invoice.customerAddress,38,264,13,false,'left',453);
    text('เลขประจำตัวผู้เสียภาษี : '+invoice.customerTaxId,38,285,13,false,'left',453);
    text('วันที่',612,243,13,false,'right');
    text(String(invoice.issueDate).split('-').reverse().join('/'),619,243,13);
    text('ใบแจ้งหนี้เลขที่',612,264,13,false,'right');
    text(invoice.number,619,264,13,true,'left',158);
    text('B/L',612,285,13,false,'right');
    text(invoice.bl,619,285,13,false,'left',158);
    var y=307, widths=[65,245,75,105,125,125], xs=[38,103,348,423,528,653];
    var heads=['ลำดับ','รายการ','จำนวน','ราคา/หน่วย','จำนวนเงิน','หมายเหตุ'];
    widths.forEach(function(w,i){ rule(xs[i],y,w,28,'#d9d9d9'); text(heads[i],xs[i]+w/2,y+20,13,true,'center',w-8); });
    y+=28;
    var rowIndex=0, tableEnd=y+420;
    while(y<tableEnd){
      var entry=items[rowIndex++], item=entry&&entry.item, h=entry?entry.height:Math.min(28,tableEnd-y);
      widths.forEach(function(w,j){ rule(xs[j],y,w,h); });
      if(item){
        text(entry.no,70.5,y+20,13,false,'center');
        wrapped(item.label,110,y+20,231,17,13);
        text(item.qty||'',385.5,y+20,13,false,'center');
        text(item.unitPrice?money(item.unitPrice):'',521,y+20,13,false,'right');
        text(money(item.amount),646,y+20,13,false,'right');
        wrapped(item.note||'',660,y+20,111,17,13);
      } else if(h===28){
        text((items.length?items[items.length-1].no-items.length+rowIndex:rowIndex),70.5,y+20,13,false,'center');
      }
      y+=h;
    }
    if(pageIndex===pageCount-1){
      var totalRows=[['ค่าบริการรวม',invoice.subtotal],['ภาษีมูลค่าเพิ่ม 7%',invoice.kind==='V'?invoice.vat:null],['รวมเงินทั้งสิ้น',invoice.total],['หักภาษี ณ ที่จ่าย 3%',null],['รวมเงินที่ต้องชำระ',invoice.total]];
      totalRows.forEach(function(row,i){
        var emphasized=i===2||i===4;
        rule(38,y,490,28,'#d9d9d9'); rule(528,y,125,28,'#d9d9d9'); rule(653,y,125,28,'#d9d9d9');
        text(row[0],521,y+20,13,emphasized?800:600,'right');
        // ช่องที่ไม่มียอด (ใบ NON VAT ไม่มี VAT, ไม่ได้หัก ณ ที่จ่าย) ใส่ "-" ไม่ปล่อยว่าง
        text(row[1]===null?'-':money(row[1]),646,y+20,13,emphasized,'right'); y+=28;
      });
    } else { text('รายการต่อในหน้าถัดไป',778,y+28,13,true,'right'); }
    text('ช่องทางการชำระเงิน',38,922,13,true);
    text('ชื่อบัญชี : '+company.bankAccountName,38,939,13);
    text('เลขที่บัญชี : '+company.bankAccountNo,38,956,13);
    // Keep the email on its own line, as in the reference, rather than splitting it.
    // ป้ายกำกับที่นำหน้าอีเมล (เช่น "E-MAIL.") ต้องลงมาอยู่บรรทัดเดียวกับอีเมลด้วย
    // ไม่งั้นจะค้างอยู่ท้ายบรรทัดบนแล้วอ่านขาดตอน
    var note='หมายเหตุ '+company.note;
    var email=note.match(/(\S*(?:E-?MAIL|อีเมล)\S*\s+)?[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if(email){
      var noteHeight=wrapped(note.replace(email[0],'').trim(),38,981,518,17,13);
      text(email[0].replace(/\s+/g,' ').trim(),38,981+noteHeight,13);
    } else wrapped(note,38,981,518,17,13);
    text('ผู้จัดทำใบแจ้งหนี้',38,1037,13);
    text(invoice.preparedBy||'',143,1037,13);
    if(images[1]){
      var scale=Math.min(177/images[1].width,116/images[1].height)*1.05;
      ctx.save(); ctx.translate(659,996); ctx.rotate(-10*Math.PI/180);
      ctx.drawImage(images[1],-images[1].width*scale/2,-images[1].height*scale/2,images[1].width*scale,images[1].height*scale); ctx.restore();
    }
    if(pageCount>1) text((pageIndex+1)+' / '+pageCount,778,1045,10,false,'right');
    var raw=atob(canvas.toDataURL('image/jpeg',.94).split(',')[1]);
    return {width:canvas.width,height:canvas.height,bytes:Uint8Array.from(raw,function(char){return char.charCodeAt(0);})};
  }
  global.InvoicePDF = {
    create: async function(invoices,company,options){
      if(!invoices.length) throw new Error('ไม่มีใบแจ้งหนี้');
      await loadSarabun();
      var images=await Promise.all([loadImage(company.logoUrl),loadImage(company.stampUrl)]), pages=[];
      invoices.forEach(function(invoice){
        var groups=paginate(invoice.items);
        for(var i=0;i<groups.length;i++) pages.push(drawPage(invoice,company,images,groups[i],i,groups.length,options));
      });
      return pdfBytes(pages);
    }
  };
})(window);
