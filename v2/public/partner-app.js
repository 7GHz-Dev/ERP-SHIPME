/**
 * หน้า /partner — พาร์ทเนอร์หาคนขับ (role ttn-admin-driver; ผู้ดูแล/ผู้จัดการเข้าได้)
 *   คนขับ: เพิ่ม / แก้ไข / สร้าง QR + ลิงก์ผูก LINE ให้ทีละคน / ยกเลิกการผูก
 *   QR รับสมัคร: QR เดียวใช้ได้หลายคน — คนขับสแกนใน LINE กรอกชื่อ เบอร์ ทะเบียน แล้วผูกทันที
 *   รูปงาน: รูปรับตู้ (หน้ารถ / ท้ายรถ) ซีลตู้ ER ออกท่า ซีลตะกั่ว — ดู / ดาวน์โหลด (ZIP) / ลบรูปที่ผิด
 */
var P = { token:null, user:null, tab:'drivers', drivers:[], q:'', photos:null };
var ALLOWED = { 'ttn-admin-driver':1, admin:1, manager:1 };
var KIND_TH = { TRUCK_FRONT_PHOTO:'รูปรับตู้ • หน้ารถ', TRUCK_REAR_PHOTO:'รูปรับตู้ • ท้ายรถ', PICKUP_SEAL_PHOTO:'ซีลตู้', EIR_CARD_PHOTO:'ER ออกท่า', CONTAINER_SEAL_PHOTO:'ซีลตะกั่ว' };
var KIND_FILE = { TRUCK_FRONT_PHOTO:'truck-front', TRUCK_REAR_PHOTO:'truck-rear', PICKUP_SEAL_PHOTO:'container-seal', EIR_CARD_PHOTO:'ER', CONTAINER_SEAL_PHOTO:'lead-seal' };
var SOURCE_TH = { plan:['จากแพลน',''], partner:['เพิ่มโดยพาร์ทเนอร์','blue'], signup:['สมัครผ่าน QR','warn'] };
var ERR = { invalid_token:'กรุณาเข้าสู่ระบบใหม่', session_expired:'หมดเวลา กรุณาเข้าสู่ระบบใหม่', forbidden:'บัญชีนี้ไม่มีสิทธิ์ใช้หน้านี้',
  missing_name:'กรอกชื่อคนขับ', bad_phone:'เบอร์มือถือไม่ถูกต้อง', phone_exists:'มีคนขับเบอร์นี้อยู่แล้ว', not_found:'ไม่พบข้อมูล',
  server_busy:'ระบบไม่ว่างชั่วคราว กรุณาลองใหม่อีกครั้ง' };

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function errText(r){ return ERR[r && r.error] || (r && (r.message || r.error)) || 'ไม่สำเร็จ'; }
function toast(m, ms){ var t=$('toast'); t.textContent=m; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t=setTimeout(function(){ t.classList.add('hidden'); }, ms||2600); }
var TH_M=['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
function thd(ymd){ var p=String(ymd||'').slice(0,10).split('-'); return p.length===3 ? (+p[2])+' '+TH_M[+p[1]-1]+' '+String(+p[0]+543).slice(2) : ''; }
function thdt(iso){ if(!iso) return ''; var d=new Date(iso); return isNaN(d)?'':d.getDate()+' '+TH_M[d.getMonth()]+' '+String(d.getFullYear()+543).slice(2)+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function today(){ var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function api(p){
  p.token=P.token;
  return fetch('/api',{ method:'POST', headers:{'content-type':'text/plain'}, body:JSON.stringify(p) }).then(function(r){ return r.json(); }).then(function(res){
    if(res && ['invalid_token','session_expired','no_token'].indexOf(res.error)>=0){ toast(errText(res)); setTimeout(function(){ location.href='/?next=partner'; }, 1200); }
    return res;
  });
}
function sheet(html){
  var bg=document.createElement('div'); bg.className='sheet-bg';
  bg.innerHTML='<div class="sheet">'+html+'</div>';
  bg.addEventListener('click', function(e){ if(e.target===bg) bg.remove(); });
  document.body.appendChild(bg); return bg;
}
function copyText(t){ try{ navigator.clipboard.writeText(t); toast('คัดลอกแล้ว'); }catch(e){ prompt('คัดลอกลิงก์นี้', t); } }
function shareLink(title, url){ if(navigator.share) navigator.share({ title:title, text:title, url:url }).catch(function(){}); else copyText(url); }
/** QR เป็นรูป PNG ดาวน์โหลดได้ (มีข้อความใต้ QR) */
function qrInto(el, text, size){ el.innerHTML=''; try{ new QRCode(el, { text:text, width:size||220, height:size||220, correctLevel:QRCode.CorrectLevel.M }); }catch(e){ el.textContent='สร้าง QR ไม่ได้'; } }
function downloadQr(el, name, caption){
  var src=el.querySelector('canvas') || el.querySelector('img'); if(!src) return;
  var c=document.createElement('canvas'), w=src.width||220, pad=24;
  c.width=w+pad*2; c.height=w+pad*2+(caption?56:0);
  var x=c.getContext('2d'); x.fillStyle='#fff'; x.fillRect(0,0,c.width,c.height);
  x.drawImage(src, pad, pad, w, w);
  if(caption){ x.fillStyle='#0B2A52'; x.font='bold 18px sans-serif'; x.textAlign='center'; x.fillText(caption, c.width/2, w+pad+34); }
  var a=document.createElement('a'); a.href=c.toDataURL('image/png'); a.download=name+'.png'; a.click();
}

// ---------------- เริ่มต้น ----------------
(function init(){
  try{ var s=JSON.parse(localStorage.getItem('ci_sess')||'null'); if(s&&s.token){ P.token=s.token; P.user=s.user; } }catch(e){}
  if(!P.token || !P.user){ location.href='/?next=partner'; return; }
  if(!ALLOWED[P.user.role]){ document.querySelector('.wrap').innerHTML='<div class="card center">บัญชีนี้ไม่มีสิทธิ์ใช้หน้าจัดการคนขับ</div>'; return; }
  $('who').textContent=(P.user.name||P.user.username)+' • พาร์ทเนอร์คนขับ';
  $('btn-logout').addEventListener('click', function(){
    try{ localStorage.removeItem('ci_sess'); }catch(e){} location.href='/';
  });
  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function(b){ b.addEventListener('click', function(){ go(b.getAttribute('data-tab')); }); });
  var t=new URLSearchParams(location.search).get('tab');
  go(['drivers','signup','photos'].indexOf(t)>=0 ? t : 'drivers');
})();
function go(tab){
  P.tab=tab;
  ['drivers','signup','photos'].forEach(function(t){ $('v-'+t).classList.toggle('hidden', t!==tab); });
  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function(b){ b.classList.toggle('on', b.getAttribute('data-tab')===tab); });
  if(tab==='drivers') loadDrivers(); if(tab==='signup') loadSignup(); if(tab==='photos') renderPhotosShell();
}

// ---------------- คนขับ ----------------
function loadDrivers(){
  var v=$('v-drivers');
  if(!v.innerHTML) v.innerHTML='<div class="card"><div class="row"><input id="dq" class="grow" placeholder="ค้นหา ชื่อ / เบอร์ / ทะเบียน / ชื่อ LINE">'+
    '<button class="btn btn-green" id="d-add">➕ เพิ่มคนขับ</button></div><div class="muted" style="margin-top:8px" id="d-sum"></div></div><div class="card" id="d-list"><div class="center">กำลังโหลด…</div></div>';
  if(!P.bound){ P.bound=true;
    $('d-add').addEventListener('click', function(){ driverForm(null); });
    var t; $('dq').addEventListener('input', function(){ clearTimeout(t); var v2=this.value; t=setTimeout(function(){ P.q=v2; fetchDrivers(); }, 300); });
  }
  fetchDrivers();
}
function fetchDrivers(){
  api({ action:'partnerDrivers', q:P.q }).then(function(r){
    if(!r.ok){ $('d-list').innerHTML='<div class="center">'+esc(errText(r))+'</div>'; return; }
    P.drivers=r.rows; P.lineMode=r.lineMode; renderDrivers();
  });
}
function renderDrivers(){
  var rows=P.drivers, linked=rows.filter(function(d){ return d.linked; }).length;
  $('d-sum').textContent='คนขับ '+rows.length+' คน • ผูก LINE แล้ว '+linked+' • ยังไม่ผูก '+(rows.length-linked)+(P.lineMode==='demo'?' • (ระบบ LINE อยู่ในโหมดทดลอง)':'');
  if(!rows.length){ $('d-list').innerHTML='<div class="center">ยังไม่มีคนขับ — กด "➕ เพิ่มคนขับ" หรือใช้ QR รับสมัคร</div>'; return; }
  $('d-list').innerHTML='<div style="overflow-x:auto"><table><thead><tr><th>คนขับ</th><th>เบอร์ / ทะเบียน</th><th>LINE</th><th>ที่มา</th><th>งาน</th><th></th></tr></thead><tbody>'+
    rows.map(function(d){
      var src=SOURCE_TH[d.source]||[d.source,''];
      return '<tr><td>'+(d.linePicture?'<img class="pic" src="'+esc(d.linePicture)+'" alt=""> ':'')+'<b>'+esc(d.name||'-')+'</b>'+(d.note?'<div class="muted">'+esc(d.note)+'</div>':'')+'</td>'+
        '<td><a href="tel:'+esc(d.phone)+'">'+esc(d.phone)+'</a><div class="muted">'+esc(d.plate||'-')+'</div></td>'+
        '<td>'+(d.linked?'<span class="chip ok">ผูกแล้ว'+(d.demo?' (ทดลอง)':'')+'</span><div class="muted">'+esc(d.lineName||'')+(d.lineLinkedAt?' • '+thdt(d.lineLinkedAt):'')+'</div>'+(d.friend||d.demo?'':'<div class="muted" style="color:var(--warn)">ยังไม่ได้เพิ่มเพื่อน OA</div>'):'<span class="chip">ยังไม่ผูก</span>')+'</td>'+
        '<td><span class="chip '+src[1]+'">'+esc(src[0])+'</span></td>'+
        '<td>'+(d.jobs?d.jobs+' ตู้<div class="muted">ล่าสุด '+thd(d.lastJob)+'</div>':'<span class="muted">-</span>')+'</td>'+
        '<td style="white-space:nowrap"><button class="btn btn-navy btn-sm" data-inv="'+esc(d.id)+'">'+(d.linked?'QR ผูกใหม่':'QR ผูก LINE')+'</button> '+
          '<button class="btn btn-ghost btn-sm" data-edit="'+esc(d.id)+'">แก้ไข</button>'+(d.linked?' <button class="btn btn-red btn-sm" data-unl="'+esc(d.id)+'">ยกเลิกผูก</button>':'')+'</td></tr>';
    }).join('')+'</tbody></table></div>';
  var find=function(id){ return P.drivers.filter(function(x){ return x.id===id; })[0]; };
  Array.prototype.forEach.call($('d-list').querySelectorAll('[data-inv]'), function(b){ b.addEventListener('click', function(){ inviteSheet(find(b.getAttribute('data-inv'))); }); });
  Array.prototype.forEach.call($('d-list').querySelectorAll('[data-edit]'), function(b){ b.addEventListener('click', function(){ driverForm(find(b.getAttribute('data-edit'))); }); });
  Array.prototype.forEach.call($('d-list').querySelectorAll('[data-unl]'), function(b){ b.addEventListener('click', function(){
    var d=find(b.getAttribute('data-unl')); if(!confirm('ยกเลิกการผูก LINE ของ '+d.name+'? คนขับจะไม่ได้รับงานทาง LINE จนกว่าจะผูกใหม่')) return;
    api({ action:'partnerDriverUnlink', driverId:d.id }).then(function(r){ toast(r.ok?'ยกเลิกการผูกแล้ว':errText(r)); fetchDrivers(); });
  }); });
}
function driverForm(d){
  var bg=sheet('<h3>'+(d?'แก้ไขคนขับ':'➕ เพิ่มคนขับ')+'</h3>'+
    '<label>ชื่อ-นามสกุล</label><input id="f-name" class="full" value="'+esc(d?d.name:'')+'">'+
    '<label>เบอร์มือถือ</label><input id="f-phone" class="full" type="tel" inputmode="tel" value="'+esc(d?d.phone:'')+'" placeholder="08xxxxxxxx">'+
    '<label>ทะเบียนรถ</label><input id="f-plate" class="full" value="'+esc(d?d.plate:'')+'" placeholder="เช่น 70-1234">'+
    '<label>หมายเหตุ (ไม่บังคับ)</label><input id="f-note" class="full" value="'+esc(d?d.note:'')+'" placeholder="เช่น รถหัวลาก 10 ล้อ / ทีม A">'+
    '<div class="row" style="margin-top:14px"><button class="btn btn-ghost grow" id="f-x">ยกเลิก</button><button class="btn btn-green grow" id="f-save">'+(d?'บันทึก':'บันทึกและสร้าง QR ผูก LINE')+'</button></div>');
  bg.querySelector('#f-x').addEventListener('click', function(){ bg.remove(); });
  bg.querySelector('#f-save').addEventListener('click', function(){
    var b=this; b.disabled=true;
    api({ action:'partnerDriverSave', id:d?d.id:'', name:$('f-name').value, phone:$('f-phone').value, plate:$('f-plate').value, note:$('f-note').value }).then(function(r){
      b.disabled=false;
      if(!r.ok){ toast(errText(r), 3500); return; }
      bg.remove(); toast('บันทึกแล้ว');
      api({ action:'partnerDrivers', q:P.q }).then(function(x){ if(x.ok){ P.drivers=x.rows; renderDrivers(); }
        if(!d){ var nd=(x.rows||[]).filter(function(y){ return y.id===r.id; })[0]; if(nd) inviteSheet(nd); } });
    });
  });
}
function inviteSheet(d){
  api({ action:'partnerDriverInvite', driverId:d.id }).then(function(r){
    if(!r.ok){ toast(errText(r)); return; }
    var bg=sheet('<h3>QR ผูก LINE — '+esc(d.name)+'</h3><div class="muted">ให้คนขับสแกนด้วยกล้องมือถือ หรือเปิดลิงก์ในแอป LINE → กดเพิ่มเพื่อน SHIPME → ผูกเสร็จ<br>ใช้ได้ครั้งเดียว ถึง '+thdt(r.expiresAt)+'</div>'+
      '<div class="qrbox"><div class="qr" id="iv-qr"></div><b style="font-size:20px;letter-spacing:3px">'+esc(r.code)+'</b></div>'+
      '<input class="full" readonly value="'+esc(r.link)+'" id="iv-link">'+
      '<div class="row" style="margin-top:10px"><button class="btn btn-ghost grow" id="iv-copy">📋 คัดลอกลิงก์</button><button class="btn btn-ghost grow" id="iv-share">📤 ส่งต่อ</button>'+
      '<button class="btn btn-navy grow" id="iv-dl">⬇️ บันทึกรูป QR</button></div>');
    qrInto(bg.querySelector('#iv-qr'), r.link, 230);
    bg.querySelector('#iv-copy').addEventListener('click', function(){ copyText(r.link); });
    bg.querySelector('#iv-share').addEventListener('click', function(){ shareLink('ผูก LINE คนขับ SHIPME — '+d.name, r.link); });
    bg.querySelector('#iv-dl').addEventListener('click', function(){ downloadQr(bg.querySelector('#iv-qr'), 'QR-SHIPME-'+(d.name||d.phone), 'ผูก LINE: '+(d.name||d.phone)); });
  });
}

// ---------------- QR รับสมัคร ----------------
function loadSignup(renew){
  var v=$('v-signup');
  v.innerHTML='<div class="card center">กำลังโหลด…</div>';
  api({ action:'partnerSignupLink', renew:!!renew }).then(function(r){
    if(!r.ok){ v.innerHTML='<div class="card center">'+esc(errText(r))+'</div>'; return; }
    v.innerHTML='<div class="card"><div class="row" style="align-items:flex-start;gap:18px">'+
      '<div class="qrbox"><div class="qr" id="su-qr"></div></div>'+
      '<div class="grow" style="min-width:240px"><h3 style="margin:4px 0 6px;color:var(--navy)">📱 QR รับสมัครคนขับ</h3>'+
        '<div class="muted" style="line-height:1.7">QR เดียวใช้ได้กับคนขับทุกคน — ให้คนขับสแกนด้วยมือถือ (เปิดในแอป LINE) → เพิ่มเพื่อน SHIPME → กรอกชื่อ เบอร์มือถือ ทะเบียนรถ → ผูกกับระบบทันที<br>'+
        'ถ้าเบอร์นี้มีอยู่แล้วในระบบ (เช่น อยู่ในแพลนงาน) ระบบจะผูก LINE กับคนขับคนเดิม</div>'+
        '<div class="row" style="margin:10px 0"><span class="chip ok">สมัครแล้ว '+r.uses+' ครั้ง</span><span class="muted">สร้างเมื่อ '+thdt(r.createdAt)+'</span></div>'+
        '<input class="full" readonly value="'+esc(r.link)+'">'+
        '<div class="row" style="margin-top:10px"><button class="btn btn-ghost" id="su-copy">📋 คัดลอกลิงก์</button><button class="btn btn-ghost" id="su-share">📤 ส่งต่อ</button>'+
        '<button class="btn btn-navy" id="su-dl">⬇️ บันทึกรูป QR</button><button class="btn btn-red" id="su-renew">🔄 สร้าง QR ใหม่</button></div>'+
        '<div class="muted" style="margin-top:6px">สร้าง QR ใหม่ = QR เดิมใช้ไม่ได้ทันที (ใช้เมื่อ QR หลุดไปถึงคนที่ไม่ใช่คนขับ)</div></div></div></div>'+
      '<div class="card"><b>คนขับที่สมัครผ่าน QR ล่าสุด</b>'+(r.recent.length?'<table style="margin-top:6px"><thead><tr><th>ชื่อ</th><th>เบอร์</th><th>ทะเบียน</th><th>LINE</th><th>สมัครเมื่อ</th></tr></thead><tbody>'+
        r.recent.map(function(d){ return '<tr><td><b>'+esc(d.name)+'</b></td><td>'+esc(d.phone)+'</td><td>'+esc(d.plate||'-')+'</td><td>'+(d.linked?'<span class="chip ok">'+esc(d.lineName||'ผูกแล้ว')+'</span>':'<span class="chip">ยังไม่ผูก</span>')+'</td><td>'+thdt(d.createdAt)+'</td></tr>'; }).join('')+
        '</tbody></table>':'<div class="center">ยังไม่มีคนสมัคร</div>')+'</div>';
    qrInto($('su-qr'), r.link, 260);
    $('su-copy').addEventListener('click', function(){ copyText(r.link); });
    $('su-share').addEventListener('click', function(){ shareLink('สมัครคนขับ SHIPME', r.link); });
    $('su-dl').addEventListener('click', function(){ downloadQr($('su-qr'), 'QR-สมัครคนขับ-SHIPME', 'สแกนเพื่อสมัครคนขับ SHIPME'); });
    $('su-renew').addEventListener('click', function(){ if(confirm('สร้าง QR ใหม่? QR เดิมที่แจกไปแล้วจะใช้ไม่ได้ทันที')) loadSignup(true); });
  });
}

// ---------------- รูปงาน ----------------
function renderPhotosShell(){
  var v=$('v-photos');
  if(!v.innerHTML){
    var t=today();
    v.innerHTML='<div class="card"><div class="row"><label class="muted">ตั้งแต่</label><input type="date" id="ph-from" value="'+t+'"><label class="muted">ถึง</label><input type="date" id="ph-to" value="'+t+'">'+
      '<input id="ph-q" class="grow" placeholder="ค้นหา เลขตู้ / BL / คนขับ / ทะเบียน"><label class="muted"><input type="checkbox" id="ph-all"> แสดงตู้ที่ยังไม่มีรูปด้วย</label>'+
      '<button class="btn btn-navy" id="ph-go">ค้นหา</button><button class="btn btn-ghost" id="ph-zip">⬇️ ZIP ทั้งหมด</button></div>'+
      '<div class="muted" style="margin-top:8px" id="ph-sum"></div></div><div id="ph-list"></div>';
    $('ph-go').addEventListener('click', fetchPhotos);
    $('ph-q').addEventListener('keydown', function(e){ if(e.key==='Enter') fetchPhotos(); });
    $('ph-zip').addEventListener('click', function(){ if(P.photos) zipRows(P.photos.rows, 'SHIPME-photos-'+P.photos.from+(P.photos.to!==P.photos.from?'_'+P.photos.to:'')); });
  }
  fetchPhotos();
}
function fetchPhotos(){
  $('ph-list').innerHTML='<div class="card center">กำลังโหลด…</div>';
  api({ action:'partnerPhotos', from:$('ph-from').value, to:$('ph-to').value, q:$('ph-q').value, onlyWithPhotos:!$('ph-all').checked }).then(function(r){
    if(!r.ok){ $('ph-list').innerHTML='<div class="card center">'+esc(errText(r))+'</div>'; return; }
    P.photos=r; renderPhotos();
  });
}
function renderPhotos(){
  var r=P.photos, rows=r.rows;
  $('ph-sum').textContent=rows.length+' ตู้ • รูปทั้งหมด '+rows.reduce(function(n,x){ return n+x.photos.length; },0)+' รูป';
  if(!rows.length){ $('ph-list').innerHTML='<div class="card center">ไม่พบตู้ที่มีรูปในช่วงนี้</div>'; return; }
  var html='', last='';
  rows.forEach(function(x, xi){
    if(x.inspectDate!==last){ last=x.inspectDate; html+='<div class="date-h">📅 งานวันที่ '+thd(x.inspectDate)+'</div>'; }
    html+='<div class="ctr"><div class="row"><div class="grow"><div class="cn">'+esc(x.containerNo||'-')+'</div>'+
      '<div class="muted">BL '+esc(x.bl)+' • ท่า '+esc(x.port||'-')+' • 👤 '+esc(x.driverName||'-')+(x.plate?' • '+esc(x.plate):'')+' • ชิปปิ้ง '+esc(x.staff)+'</div></div>'+
      (x.completedAt?'<span class="chip ok">จบงาน '+thdt(x.completedAt)+'</span>':'<span class="chip warn">ยังไม่จบงาน</span>')+
      (x.photos.length?' <button class="btn btn-ghost btn-sm" data-zip="'+xi+'">⬇️ ZIP</button>':'')+'</div>'+
      '<div class="kinds">'+r.kinds.map(function(k){
        var ps=x.photos.filter(function(p){ return p.kind===k; });
        return '<div class="kind"><b>'+esc(KIND_TH[k]||k)+'</b><div class="ph">'+(ps.length?ps.map(function(p){
          return '<img src="'+esc(p.url)+'" loading="lazy" alt="'+esc(KIND_TH[k])+'" data-ph="'+esc(p.id)+'" data-x="'+xi+'">'; }).join(''):'<span class="none">ไม่มีรูป</span>')+'</div></div>';
      }).join('')+'</div></div>';
  });
  $('ph-list').innerHTML=html;
  Array.prototype.forEach.call($('ph-list').querySelectorAll('[data-ph]'), function(img){ img.addEventListener('click', function(){
    var x=rows[+img.getAttribute('data-x')], p=x.photos.filter(function(y){ return y.id===img.getAttribute('data-ph'); })[0]; lightbox(x, p);
  }); });
  Array.prototype.forEach.call($('ph-list').querySelectorAll('[data-zip]'), function(b){ b.addEventListener('click', function(){
    var x=rows[+b.getAttribute('data-zip')]; zipRows([x], x.inspectDate+'_'+(x.containerNo||x.bl));
  }); });
}
function fileName(x, p, n){ return x.inspectDate+'_'+(x.containerNo||x.bl).replace(/[^\w-]+/g,'')+'_'+(KIND_FILE[p.kind]||p.kind)+(n>1?'-'+n:'')+'.jpg'; }
function fetchBlob(url){ return fetch(url).then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.blob(); }); }
function saveBlob(blob, name){ var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); }, 4000); }
function lightbox(x, p){
  var v=document.createElement('div'); v.className='lb';
  v.innerHTML='<div class="cap">'+esc(x.containerNo)+' • '+esc(KIND_TH[p.kind]||p.kind)+' • '+thdt(p.at)+'</div><img src="'+esc(p.url)+'" alt="">'+
    '<div class="bar"><button class="btn btn-ghost" id="lb-dl">⬇️ ดาวน์โหลด</button><a class="btn btn-ghost" href="'+esc(p.url)+'" target="_blank" rel="noopener" style="text-decoration:none">เปิดแท็บใหม่</a>'+
    '<button class="btn btn-red" id="lb-del">🗑 ลบรูปนี้</button><button class="btn btn-navy" id="lb-x">ปิด</button></div>';
  document.body.appendChild(v);
  v.addEventListener('click', function(e){ if(e.target===v) v.remove(); });
  v.querySelector('#lb-x').addEventListener('click', function(){ v.remove(); });
  v.querySelector('#lb-dl').addEventListener('click', function(){
    var same=x.photos.filter(function(y){ return y.kind===p.kind; });
    fetchBlob(p.url).then(function(b){ saveBlob(b, fileName(x, p, same.indexOf(p)+1)); }).catch(function(){ window.open(p.url, '_blank'); });
  });
  v.querySelector('#lb-del').addEventListener('click', function(){
    if(!confirm('ลบรูป "'+(KIND_TH[p.kind]||p.kind)+'" ของตู้ '+x.containerNo+'?\nใช้เมื่อรูปผิด — ถ้าตู้ยังไม่จบงาน คนขับต้องถ่ายใหม่')) return;
    api({ action:'partnerPhotoDelete', id:p.id }).then(function(r){ if(!r.ok){ toast(errText(r)); return; } toast('ลบรูปแล้ว'); v.remove(); fetchPhotos(); });
  });
}
/** รวมรูปเป็น ZIP (โฟลเดอร์ตามวันที่ / เลขตู้) */
function zipRows(rows, name){
  var list=[]; rows.forEach(function(x){ var cnt={}; x.photos.forEach(function(p){ cnt[p.kind]=(cnt[p.kind]||0)+1; list.push({ x:x, p:p, n:cnt[p.kind] }); }); });
  if(!list.length){ toast('ไม่มีรูปให้ดาวน์โหลด'); return; }
  if(!window.JSZip){ toast('โหลดตัวสร้าง ZIP ไม่สำเร็จ'); return; }
  var zip=new JSZip(), done=0, failed=0;
  toast('กำลังรวมรูป 0/'+list.length+'…', 60000);
  var next=function(i){
    if(i>=list.length){
      return zip.generateAsync({ type:'blob' }).then(function(b){ saveBlob(b, name+'.zip'); toast('ดาวน์โหลด ZIP แล้ว '+done+' รูป'+(failed?' • โหลดไม่ได้ '+failed+' รูป':''), 4000); });
    }
    var it=list[i];
    return fetchBlob(it.p.url).then(function(b){ zip.folder(it.x.inspectDate+'/'+(it.x.containerNo||it.x.bl)).file(fileName(it.x, it.p, it.n), b); done++; })
      .catch(function(){ failed++; }).then(function(){ toast('กำลังรวมรูป '+(i+1)+'/'+list.length+'…', 60000); return next(i+1); });
  };
  next(0);
}
