/**
 * รูปเอกสารตรวจปล่อย → ตีกรอบเอกสารอัตโนมัติ + รวมเป็น PDF ไฟล์เดียว (หน้าปิดบัญชี ไม่ต้องผ่านแอป DocScan)
 *
 * 1) อ่านทุกไฟล์เข้าหน่วยความจำทันทีที่เลือก (iOS ลบไฟล์ชั่วคราวของรูปที่เลือกถ้าอ่านช้า — ปัญหาเดียวกับที่เจอใน DocScan)
 * 2) ทีละรูป: หาขอบเอกสาร (detect-worker.js ตัวเดียวกับ DocScan) → ครอบ + ปรับมุมมอง + ทำพื้นกระดาษขาว (scan-worker.js)
 * 3) ให้ดูตัวอย่างก่อน: หมุน / สลับใช้รูปเต็ม (กรณีตีกรอบผิด) / เลื่อนลำดับ / ลบ
 * 4) รวมเป็น PDF (ฝังภาพ JPEG ตรง ๆ ไม่ต้องใช้ไลบรารี) แล้วส่งให้ opts.upload(blob, pages)
 *
 * ใช้: InspScan.open(files, { title, upload:function(blob, pages){ return Promise }, onClose:function(uploaded){} })
 */
(function(){
  'use strict';
  var SRC_MAX = 3000;      // ด้านยาวสุดของรูปต้นฉบับที่นำมาประมวลผล
  var OUT_MAX = 2000;      // ด้านยาวสุดของหน้าเอกสาร (A4 ≈ 170 dpi — อ่านตัวหนังสือชัด ไฟล์ไม่ใหญ่)
  var DETECT_MAX = 640, REFINE_MAX = 1000;
  var PDF_LIMIT = 24*1024*1024;   // เซิร์ฟเวอร์รับไม่เกิน 25MB

  // ---------- workers ----------
  function makeCaller(url){
    var w=null, seq=0, pend={};
    function get(){
      if(w) return w;
      w=new Worker(url);
      w.onmessage=function(e){ var p=pend[e.data.id]; if(!p) return; delete pend[e.data.id]; e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error||'ประมวลผลรูปไม่สำเร็จ')); };
      w.onerror=function(){ Object.keys(pend).forEach(function(k){ pend[k].rej(new Error('โหลดตัวประมวลผลรูปไม่สำเร็จ')); }); pend={}; try{ w.terminate(); }catch(e){} w=null; };
      return w;
    }
    return function(msg, image){
      var id=++seq;
      return new Promise(function(res, rej){ pend[id]={ res:res, rej:rej }; msg.id=id; msg.image=image; get().postMessage(msg, [image.data.buffer]); });
    };
  }
  var detectCall=makeCaller('/detect-worker.js?v=1'), scanCall=makeCaller('/scan-worker.js?v=1');

  // ---------- ภาพ ----------
  function canvas(w, h){ var c=document.createElement('canvas'); c.width=Math.max(1,Math.round(w)); c.height=Math.max(1,Math.round(h)); return c; }
  function ctx(c){ return c.getContext('2d', { willReadFrequently:true }); }
  function scaled(src, max){
    var s=Math.min(1, max/Math.max(src.width, src.height));
    if(s===1 && src.getContext) return src;
    var c=canvas(src.width*s, src.height*s), g=ctx(c);
    g.imageSmoothingQuality='high'; g.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function imageData(c){ return ctx(c).getImageData(0, 0, c.width, c.height); }
  function toBlob(c, q){ return new Promise(function(res, rej){ c.toBlob(function(b){ b ? res(b) : rej(new Error('เข้ารหัสรูปไม่สำเร็จ')); }, 'image/jpeg', q); }); }
  /** decode ด้วย <img> (หมุนตาม EXIF ให้เองทุกเบราว์เซอร์) แล้วย่อไม่เกิน SRC_MAX */
  function decode(item){
    return new Promise(function(res, rej){
      var url=URL.createObjectURL(new Blob([item.buf], { type:item.type||'image/jpeg' })), img=new Image();
      img.onload=function(){
        var s=Math.min(1, SRC_MAX/Math.max(img.naturalWidth, img.naturalHeight)), c=canvas(img.naturalWidth*s, img.naturalHeight*s), g=ctx(c);
        g.imageSmoothingQuality='high'; g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); res(c);
      };
      img.onerror=function(){ URL.revokeObjectURL(url); rej(new Error('เปิดรูปไม่ได้ (รองรับ JPG / PNG — รูป HEIC ให้เลือกจากแอปรูปภาพของ iPhone)')); };
      img.src=url;
    });
  }
  function readAll(files){
    return Promise.all(files.map(function(f){
      var once=function(){ return new Promise(function(res, rej){ var r=new FileReader(); r.onload=function(){ res(r.result); }; r.onerror=function(){ rej(r.error); }; r.readAsArrayBuffer(f); }); };
      return once().catch(once).then(function(buf){ return { name:f.name, type:f.type, buf:buf }; }, function(){ return { name:f.name, error:'อ่านไฟล์ไม่ได้' }; });
    }));
  }

  // ---------- หาขอบ / ครอบ ----------
  function insetQuad(q, k){
    var cx=(q[0].x+q[1].x+q[2].x+q[3].x)/4, cy=(q[0].y+q[1].y+q[2].y+q[3].y)/4;
    return q.map(function(p){ return { x:p.x+(cx-p.x)*k, y:p.y+(cy-p.y)*k }; });
  }
  function fullQuad(w, h){ return [{x:0,y:0},{x:w,y:0},{x:w,y:h},{x:0,y:h}]; }
  function inQuad(q, x, y){
    var sign=0;
    for(var i=0;i<4;i++){
      var a=q[i], b=q[(i+1)%4], c=(b.x-a.x)*(y-a.y)-(b.y-a.y)*(x-a.x);
      if(c!==0){ if(sign && (c>0)!==(sign>0)) return false; sign=c; }
    }
    return true;
  }
  /**
   * กรอบน่าเชื่อถือไหม — ตีกรอบอัตโนมัติโดยไม่มีคนดูทีละเฟรมเหมือน DocScan จึงต้องกันกรอบผิด:
   * เล็กเกินไป / ยาวผิดสัดส่วนเอกสาร / นอกกรอบไม่ได้เข้มกว่าในกรอบ (ถ่ายชิดจนกระดาษเต็มรูป แล้วไปจับแถวตัวหนังสือเป็นขอบ)
   */
  function plausible(q, area, img){
    if(!(area>=0.12)) return false;
    var d=function(a, b){ return Math.hypot(a.x-b.x, a.y-b.y); };
    var w=Math.max(d(q[0],q[1]), d(q[3],q[2])), h=Math.max(d(q[0],q[3]), d(q[1],q[2]));
    if(Math.max(w,h)/Math.max(1,Math.min(w,h))>2.3) return false;
    var D=img.data, W=img.width, H=img.height, si=0, ni=0, so=0, no=0;
    for(var y=1;y<H;y+=3) for(var x=1;x<W;x+=3){
      var o=(y*W+x)*4, L=0.299*D[o]+0.587*D[o+1]+0.114*D[o+2];
      if(inQuad(q, x, y)){ si+=L; ni++; } else { so+=L; no++; }
    }
    if(no < (ni+no)*0.15) return true;      // กรอบเกือบเต็มรูป — นอกกรอบน้อยเกินจะเทียบ
    return so/no < si/ni - 12;
  }
  /** หาขอบบนภาพย่อ แล้วเกลามุมบนภาพละเอียดกว่า — ไม่เจอ = null • เจอแต่ไม่น่าเชื่อ = { quad, doubt:true } */
  function findQuad(src){
    var small=scaled(src, DETECT_MAX), k=src.width/small.width, stats=imageData(small);
    return detectCall({ type:'detect', opts:{ mode:'still', prev:null } }, imageData(small)).then(function(r){
      if(!r || !r.quad) return null;
      var doubt=!plausible(r.quad, r.area, stats);
      var q=r.quad.map(function(p){ return { x:p.x*k, y:p.y*k }; });
      var mid=scaled(src, REFINE_MAX), s=mid.width/src.width;
      return detectCall({ type:'refine', quad:q.map(function(p){ return { x:p.x*s, y:p.y*s }; }), radius:Math.max(3, 2*k*s) }, imageData(mid))
        .then(function(rr){ return rr.quad.map(function(p){ return { x:p.x/s, y:p.y/s }; }); }, function(){ return q; })
        .then(function(qq){ return { quad:insetQuad(qq, 0.005), doubt:doubt }; });
    }).catch(function(){ return null; });
  }
  /** ขนาดหน้าหลังปรับมุมมอง — สัดส่วนใกล้ A4 (±10%) ปรับเป็น 1:1.414 พอดี (เหมือน DocScan) */
  function targetSize(q, max){
    var d=function(a, b){ return Math.hypot(a.x-b.x, a.y-b.y); };
    var w=Math.max(d(q[0],q[1]), d(q[3],q[2])), h=Math.max(d(q[0],q[3]), d(q[1],q[2]));
    var r=Math.max(w,h)/Math.max(1,Math.min(w,h));
    if(Math.abs(r/Math.SQRT2-1)<=0.1){
      if(r<Math.SQRT2){ if(h>=w) h=w*Math.SQRT2; else w=h*Math.SQRT2; }
      else if(h>=w) w=h/Math.SQRT2; else h=w/Math.SQRT2;
    }
    var s=Math.min(1, max/Math.max(w,h));
    return { w:Math.max(1,Math.round(w*s)), h:Math.max(1,Math.round(h*s)) };
  }
  /** ครอบ + ปรับมุมมอง + ฟิลเตอร์เอกสาร → JPEG */
  function render(src, quad, max, quality){
    var size=targetSize(quad, max);
    var xs=quad.map(function(p){ return p.x; }), ys=quad.map(function(p){ return p.y; });
    var x0=Math.max(0, Math.floor(Math.min.apply(null, xs))-2), y0=Math.max(0, Math.floor(Math.min.apply(null, ys))-2);
    var x1=Math.min(src.width, Math.ceil(Math.max.apply(null, xs))+2), y1=Math.min(src.height, Math.ceil(Math.max.apply(null, ys))+2);
    var region=ctx(src).getImageData(x0, y0, Math.max(1,x1-x0), Math.max(1,y1-y0));
    var local=quad.map(function(p){ return { x:p.x-x0, y:p.y-y0 }; });
    return scanCall({ type:'process', quad:local, size:size }, region).then(function(out){
      var c=canvas(out.width, out.height); ctx(c).putImageData(out, 0, 0);
      return toBlob(c, quality).then(function(b){ var r={ blob:b, w:c.width, h:c.height }; c.width=c.height=0; return r; });
    });
  }
  /** สร้างหน้าแบบที่เลือก (ครอบตามขอบที่หาได้ / ใช้รูปเต็ม) — แคชไว้ สลับไปมาไม่ต้องคิดใหม่ */
  function variant(page, crop){
    var key=crop ? 'crop' : 'full';
    if(page[key]) return Promise.resolve(page[key]);
    return decode(page.src).then(function(src){
      var q=crop && page.quad ? page.quad : fullQuad(src.width, src.height);
      return render(src, q, OUT_MAX, 0.82).then(function(r){ src.width=src.height=0; page[key]=r; return r; });
    });
  }

  // ---------- PDF (ภาพ JPEG ทีละหน้า) ----------
  function bytes(blob){ return new Promise(function(res, rej){ var r=new FileReader(); r.onload=function(){ res(new Uint8Array(r.result)); }; r.onerror=function(){ rej(r.error); }; r.readAsArrayBuffer(blob); }); }
  /** หมุนหน้า 90° × n ก่อนใส่ PDF */
  function rotated(v, rot){
    if(!rot) return Promise.resolve(v);
    return new Promise(function(res, rej){
        var url=URL.createObjectURL(v.blob), img=new Image();
        img.onload=function(){
          var swap=rot%2===1, c=canvas(swap?img.naturalHeight:img.naturalWidth, swap?img.naturalWidth:img.naturalHeight), g=ctx(c);
          g.translate(c.width/2, c.height/2); g.rotate(rot*Math.PI/2); g.drawImage(img, -img.naturalWidth/2, -img.naturalHeight/2);
          URL.revokeObjectURL(url);
          toBlob(c, 0.85).then(function(b){ res({ blob:b, w:c.width, h:c.height }); c.width=c.height=0; }, rej);
        };
        img.onerror=function(){ URL.revokeObjectURL(url); rej(new Error('หมุนหน้าไม่สำเร็จ')); };
        img.src=url;
    });
  }
  function buildPdf(pages){
    var enc=new TextEncoder(), chunks=[], offsets=[], pos=0;
    var put=function(x){ var b=typeof x==='string' ? enc.encode(x) : x; chunks.push(b); pos+=b.length; };
    var n=pages.length, kids=[];
    for(var i=0;i<n;i++) kids.push((3+i*3)+' 0 R');
    put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'.replace(/[\u0080-ÿ]/g, '%'));
    offsets[1]=pos; put('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    offsets[2]=pos; put('2 0 obj\n<< /Type /Pages /Kids ['+kids.join(' ')+'] /Count '+n+' >>\nendobj\n');
    pages.forEach(function(p, i){
      var po=3+i*3, co=po+1, io=po+2;
      // หน้ากระดาษขนาดราว A4 (ด้านยาว 842pt) ตามสัดส่วนภาพ
      var s=841.89/Math.max(p.w, p.h), W=(p.w*s).toFixed(2), H=(p.h*s).toFixed(2);
      var content='q '+W+' 0 0 '+H+' 0 0 cm /Im0 Do Q';
      offsets[po]=pos; put(po+' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 '+W+' '+H+'] /Resources << /XObject << /Im0 '+io+' 0 R >> >> /Contents '+co+' 0 R >>\nendobj\n');
      offsets[co]=pos; put(co+' 0 obj\n<< /Length '+content.length+' >>\nstream\n'+content+'\nendstream\nendobj\n');
      offsets[io]=pos; put(io+' 0 obj\n<< /Type /XObject /Subtype /Image /Width '+p.w+' /Height '+p.h+' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '+p.jpeg.length+' >>\nstream\n');
      put(p.jpeg); put('\nendstream\nendobj\n');
    });
    var total=3+n*3, xref=pos, lines=['xref', '0 '+total, '0000000000 65535 f '];
    for(var k=1;k<total;k++) lines.push(String(offsets[k]).padStart(10, '0')+' 00000 n ');
    put(lines.join('\n')+'\ntrailer\n<< /Size '+total+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n');
    return new Blob(chunks, { type:'application/pdf' });
  }

  // ---------- หน้าจอ ----------
  var CSS='.isc-box{background:#fff;border-radius:16px;padding:14px;width:100%;max-width:760px;max-height:94vh;display:flex;flex-direction:column}'+
    '.isc-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}.isc-head h3{margin:0;font-size:17px;flex:1}'+
    '.isc-grid{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;padding:4px;background:#f1f5f9;border-radius:12px;min-height:140px}'+
    '.isc-pg{background:#fff;border-radius:10px;padding:6px;box-shadow:0 1px 2px rgba(0,0,0,.08);display:flex;flex-direction:column;gap:5px}'+
    '.isc-th{position:relative;height:190px;display:flex;align-items:center;justify-content:center;background:#e2e8f0;border-radius:6px;overflow:hidden}'+
    '.isc-th img{max-width:100%;max-height:100%;transition:transform .2s}.isc-no{position:absolute;left:5px;top:5px;background:#0B2A52;color:#fff;font-size:12px;font-weight:700;border-radius:999px;padding:1px 8px}'+
    '.isc-tag{font-size:11.5px;font-weight:700;border-radius:6px;padding:2px 6px;text-align:center}.isc-tag.ok{background:#dcfce7;color:#15803d}.isc-tag.warn{background:#fef3c7;color:#92400e}.isc-tag.err{background:#fee2e2;color:#b91c1c}'+
    '.isc-bar{display:flex;gap:4px}.isc-bar button{flex:1;border:0;background:#e9edf2;border-radius:8px;padding:7px 0;font-size:14px;cursor:pointer}.isc-bar button:disabled{opacity:.35}'+
    '.isc-mode{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:6px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit}'+
    '.isc-msg{font-size:13px;color:#475569;margin:8px 0}.isc-act{display:flex;gap:8px;margin-top:10px}.isc-act .btn{margin:0}'+
    '.isc-spin{width:28px;height:28px;border:3px solid #cbd5e1;border-top-color:#0B2A52;border-radius:50%;animation:iscspin .8s linear infinite}@keyframes iscspin{to{transform:rotate(360deg)}}';
  function el(tag, cls, html){ var e=document.createElement(tag); if(cls) e.className=cls; if(html!=null) e.innerHTML=html; return e; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]; }); }

  function open(files, opts){
    opts=opts||{};
    if(!document.getElementById('isc-css')){ var st=el('style'); st.id='isc-css'; st.textContent=CSS; document.head.appendChild(st); }
    var bg=el('div', 'modal-bg'), box=el('div', 'isc-box');
    box.innerHTML='<div class="isc-head"><h3>📄 '+esc(opts.title||'รวมรูปเอกสารเป็น PDF')+'</h3></div>'+
      '<div class="isc-msg" id="isc-msg">กำลังอ่านรูป…</div><div class="isc-grid" id="isc-grid"></div>'+
      '<div class="isc-act"><button type="button" class="btn btn-ghost" id="isc-x" style="flex:1">ยกเลิก</button>'+
      '<button type="button" class="btn btn-primary" id="isc-go" style="flex:2" disabled>⬆️ อัปโหลดเป็น PDF</button></div>';
    bg.appendChild(box); document.body.appendChild(bg);
    var q=function(s){ return box.querySelector(s); }, pages=[], busy=true, closed=false, uploaded=false;
    var close=function(){ if(closed) return; closed=true; pages.forEach(function(p){ if(p.url) URL.revokeObjectURL(p.url); }); bg.remove(); if(opts.onClose) opts.onClose(uploaded); };
    q('#isc-x').addEventListener('click', function(){ if(busy && !confirm('ยกเลิกการรวมรูปเป็น PDF?')) return; close(); });

    var setThumb=function(p){
      var v=p.useCrop ? p.crop : p.full;
      if(p.url) URL.revokeObjectURL(p.url);
      p.url=v ? URL.createObjectURL(v.blob) : '';
    };
    var draw=function(){
      var ready=pages.filter(function(p){ return !p.error && (p.crop||p.full); });
      q('#isc-go').disabled=busy || !ready.length;
      q('#isc-go').textContent='⬆️ อัปโหลดเป็น PDF ('+ready.length+' หน้า)';
      var grid=q('#isc-grid'); grid.innerHTML='';
      pages.forEach(function(p, i){
        var c=el('div', 'isc-pg'), tag;
        if(p.error) tag='<div class="isc-tag err">'+esc(p.error)+'</div>';
        else if(!p.crop && !p.full) tag='<div class="isc-tag warn">กำลังตีกรอบ…</div>';
        else if(p.useCrop && p.quad) tag='<div class="isc-tag ok">✓ ตีกรอบเอกสารแล้ว</div>';
        else tag='<div class="isc-tag warn">'+(!p.quad ? 'หาขอบไม่เจอ — ใช้รูปเต็ม' : (p.doubt ? 'ไม่แน่ใจขอบเอกสาร — ใช้รูปเต็ม' : 'ใช้รูปเต็ม'))+'</div>';
        c.innerHTML='<div class="isc-th">'+(p.url ? '<img src="'+p.url+'" style="transform:rotate('+(p.rot*90)+'deg)'+(p.rot%2?';max-width:190px;max-height:150px':'')+'">' : (p.error ? '⚠️' : '<div class="isc-spin"></div>'))+
          '<span class="isc-no">'+(i+1)+'</span></div>'+tag+
          (p.quad && !p.error && (p.crop||p.full) ? '<button type="button" class="isc-mode" data-a="mode">'+(p.useCrop ? '↩︎ กรอบไม่ตรง ใช้รูปเต็ม' : '✂️ ใช้แบบตีกรอบ')+'</button>' : '')+
          '<div class="isc-bar"><button type="button" data-a="left" title="เลื่อนไปก่อนหน้า"'+(i===0?' disabled':'')+'>◀</button>'+
          '<button type="button" data-a="rot" title="หมุน"'+(p.error?' disabled':'')+'>↻</button>'+
          '<button type="button" data-a="del" title="ลบหน้านี้">🗑</button>'+
          '<button type="button" data-a="right" title="เลื่อนไปถัดไป"'+(i===pages.length-1?' disabled':'')+'>▶</button></div>';
        c.addEventListener('click', function(e){
          var b=e.target.closest('button[data-a]'); if(!b || b.disabled) return;
          var a=b.getAttribute('data-a'), at=pages.indexOf(p);
          if(a==='left' && at>0){ pages.splice(at,1); pages.splice(at-1,0,p); }
          else if(a==='right' && at<pages.length-1){ pages.splice(at,1); pages.splice(at+1,0,p); }
          else if(a==='rot') p.rot=(p.rot+1)%4;
          else if(a==='del'){ if(p.url) URL.revokeObjectURL(p.url); pages.splice(at,1); }
          else if(a==='mode'){
            p.useCrop=!p.useCrop;
            if(!(p.useCrop ? p.crop : p.full)){
              b.disabled=true; b.textContent='กำลังทำ…';
              return variant(p, p.useCrop).then(function(){ setThumb(p); draw(); }, function(err){ p.useCrop=!p.useCrop; alert(err.message); draw(); });
            }
            setThumb(p);
          }
          draw();
        });
        grid.appendChild(c);
      });
    };

    readAll(files).then(function(items){
      pages=items.map(function(it){ return { src:it, error:it.error||'', quad:null, useCrop:true, rot:0, crop:null, full:null, url:'' }; });
      draw();
      var i=0, found=0;
      var next=function(){
        if(closed) return;
        if(i>=pages.length){
          busy=false;
          var ok=pages.filter(function(p){ return !p.error; }).length, bad=pages.length-ok;
          q('#isc-msg').innerHTML='ตีกรอบได้ <b>'+found+'</b> จาก '+ok+' รูป'+(bad?' • เปิดไม่ได้ '+bad+' รูป':'')+
            ' — ตรวจดูแต่ละหน้า ถ้ากรอบไม่ตรงกด "ใช้รูปเต็ม" • เรียงลำดับด้วย ◀ ▶ แล้วกดอัปโหลด';
          draw(); return;
        }
        var p=pages[i++];
        q('#isc-msg').textContent='กำลังตีกรอบเอกสาร รูปที่ '+i+' / '+pages.length+'…';
        if(p.error) return next();
        decode(p.src).then(function(src){
          return findQuad(src).then(function(f){
            // กรอบที่ไม่แน่ใจ: เก็บไว้ให้กด "ใช้แบบตีกรอบ" เองได้ แต่เริ่มต้นใช้รูปเต็ม
            p.quad=f ? f.quad : null; p.doubt=!!(f && f.doubt); p.useCrop=!!f && !f.doubt; if(p.useCrop) found++;
            return render(src, p.useCrop ? p.quad : fullQuad(src.width, src.height), OUT_MAX, 0.82).then(function(r){
              if(p.useCrop) p.crop=r; else p.full=r;
              src.width=src.height=0;
            });
          });
        }).then(function(){ setThumb(p); }, function(err){ p.error=(err && err.message)||'ประมวลผลรูปไม่สำเร็จ'; })
          .then(function(){ draw(); setTimeout(next, 0); });
      };
      next();
    });

    q('#isc-go').addEventListener('click', function(){
      var list=pages.filter(function(p){ return !p.error && (p.useCrop ? p.crop : p.full); });
      if(!list.length || !opts.upload) return;
      var btn=this; btn.disabled=true; busy=true; q('#isc-x').disabled=true;
      var msg=q('#isc-msg'); msg.textContent='กำลังรวมเป็น PDF…';
      var build=function(max, quality){
        return list.reduce(function(acc, p){
          return acc.then(function(out){
            var base=p.useCrop ? p.crop : p.full;
            return rotated(base, p.rot).then(function(v){
              if(!max) return v;
              return new Promise(function(res, rej){
                var url=URL.createObjectURL(v.blob), img=new Image();
                img.onload=function(){ var c=scaled(img, max); URL.revokeObjectURL(url); toBlob(c, quality).then(function(b){ res({ blob:b, w:c.width, h:c.height }); }, rej); };
                img.onerror=function(){ URL.revokeObjectURL(url); rej(new Error('ย่อรูปไม่สำเร็จ')); };
                img.src=url;
              });
            }).then(function(v){ return bytes(v.blob).then(function(b){ out.push({ jpeg:b, w:v.w, h:v.h }); return out; }); });
          });
        }, Promise.resolve([])).then(buildPdf);
      };
      build(0).then(function(pdf){
        // ใหญ่เกินที่เซิร์ฟเวอร์รับ → ย่อทุกหน้าลงแล้วรวมใหม่
        if(pdf.size<=PDF_LIMIT) return pdf;
        msg.textContent='ไฟล์ใหญ่เกิน 24MB — กำลังย่อรูปลง…';
        return build(1500, 0.7);
      }).then(function(pdf){
        if(pdf.size>PDF_LIMIT) throw new Error('ไฟล์ PDF ยังใหญ่เกิน 25MB — แบ่งอัปโหลดเป็น 2 ครั้ง');
        msg.textContent='กำลังอัปโหลด PDF '+list.length+' หน้า ('+(pdf.size/1048576).toFixed(1)+' MB)…';
        return opts.upload(pdf, list.length);
      }).then(function(){ uploaded=true; busy=false; close(); }, function(err){
        busy=false; btn.disabled=false; q('#isc-x').disabled=false;
        msg.innerHTML='<span style="color:#b91c1c">⚠️ '+esc((err && (err.message||err.error))||'อัปโหลดไม่สำเร็จ')+'</span> — กดอัปโหลดอีกครั้ง';
      });
    });
  }

  window.InspScan={ open:open, _buildPdf:buildPdf };
})();
