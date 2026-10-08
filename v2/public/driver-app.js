/**
 * หน้าคนขับ (/driver) — เปิดจากปุ่มในข้อความ LINE OA (LIFF) หรือลิงก์ SMS (ช่องทางสำรอง)
 *
 * เข้าใช้งาน: LIFF ID token (ตรวจฝั่งเซิร์ฟเวอร์) / ?link=โค้ดผูก LINE / ?r=รหัสคำขอพิกัด (SMS) / ?s=session (DEMO)
 * ทุกอย่างทำทีละตู้: รับการ์ด → รับตู้ → ผ่าน X-Ray → รับ EIR → ถ่ายรูปการ์ด EIR + Seal → ยืนยันจบงาน
 * ตำแหน่งส่งเฉพาะตอนคนขับกดปุ่มเอง ไม่มีการติดตามเบื้องหลัง
 */
var D = { session:'', data:null, cfg:null, q:new URLSearchParams(location.search), busy:{} };

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function api(p){ if(D.session && !p.session) p.session=D.session; return fetch('/api',{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify(p)}).then(function(r){ return r.json(); }); }
function toast(m,ms){ var t=$('toast'); t.textContent=m; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t=setTimeout(function(){ t.classList.add('hidden'); }, ms||2600); }
function hm(iso){ if(!iso) return ''; var d=new Date(iso); return isNaN(d)?'':String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+' น.'; }
var TH_M=['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
function thd(ymd){ var p=String(ymd||'').split('-'); return p.length===3 ? (+p[2])+' '+TH_M[+p[1]-1]+' '+(+p[0]+543) : ''; }
function store(k,v){ try{ if(v==null) localStorage.removeItem(k); else localStorage.setItem(k,v); }catch(e){} }
function read(k){ try{ return localStorage.getItem(k)||''; }catch(e){ return ''; } }

var ERR = {
  invite_invalid:'โค้ดผูก LINE ใช้ไม่ได้หรือหมดอายุ — ขอโค้ดใหม่จากชิปปิ้ง', open_in_line:'กรุณาเปิดลิงก์นี้ในแอป LINE',
  line_already_linked:'บัญชี LINE นี้ผูกกับคนขับคนอื่นแล้ว — ติดต่อชิปปิ้ง', not_linked:'บัญชี LINE นี้ยังไม่ได้ผูกกับงาน — ขอโค้ดผูก LINE จากชิปปิ้ง',
  link_invalid:'ลิงก์ไม่ถูกต้อง', link_expired:'ลิงก์หมดอายุแล้ว', session_expired:'หมดเวลา กรุณาเปิดลิงก์จากข้อความอีกครั้ง',
  card_first:'ต้องได้รับการ์ดรับตู้ก่อน', pickup_first:'ต้องกด "รับตู้แล้ว" ก่อน', xray_first:'ต้องผ่าน X-Ray ก่อน',
  XRAY_BATCH_NOT_READY:'ยังรอตู้อื่นในกลุ่มผ่าน X-Ray', eir_first:'ต้องได้รับ EIR ก่อน', photos_required:'ต้องมีรูปการ์ด EIR และรูป Seal ตู้',
  request_expired:'คำขอนี้หมดอายุแล้ว — รอชิปปิ้งส่งคำขอใหม่', forbidden:'ไม่ใช่งานของคุณ', already_completed:'ตู้นี้ส่งจบงานแล้ว',
  upload_missing:'อัปโหลดรูปไม่สำเร็จ ลองใหม่', file_too_large:'รูปใหญ่เกิน 10MB', line_not_configured:'ระบบ LINE ยังไม่พร้อม',
  invalid_id_token:'ยืนยันตัวตน LINE ไม่สำเร็จ ลองเปิดใหม่', no_credentials:'กรุณาเปิดจากลิงก์ในข้อความ'
};
function errText(res){ return ERR[res && res.error] || (res && res.error) || 'ไม่สำเร็จ'; }

// ---------------- เข้าใช้งาน ----------------
(function start(){
  api({ action:'driverConfig' }).then(function(cfg){
    D.cfg=cfg;
    $('demo-bar').classList.toggle('hidden', cfg.lineMode!=='demo');
    if(D.q.get('s')){ D.session=D.q.get('s'); store('drv_sess', D.session); return home(); }
    if(cfg.lineMode==='live' && cfg.liffId) return liffLogin(cfg.liffId);
    auth({});
  }).catch(function(){ fail('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); });
})();

function liffLogin(liffId){
  var s=document.createElement('script'); s.src='https://static.line-scdn.net/liff/edge/2/sdk.js';
  s.onload=function(){
    liff.init({ liffId:liffId }).then(function(){
      if(!liff.isLoggedIn()){ liff.login({ redirectUri:location.href }); return; }
      auth({ idToken:liff.getIDToken() });
    }).catch(function(){ fail('เปิด LINE ไม่สำเร็จ — ลองเปิดลิงก์ใหม่'); });
  };
  s.onerror=function(){ fail('โหลด LINE ไม่สำเร็จ'); };
  document.head.appendChild(s);
}

/**
 * LINE เปิด LIFF ครั้งแรกเป็น /driver?liff.state=%3Flink%3DXXXX แล้วค่อยพากลับมาที่ query จริง
 * อ่านทั้งสองแบบ จะได้ไม่ทำโค้ดผูก LINE / รหัสคำขอหาย
 */
function params(){
  var q=new URLSearchParams(location.search), st=q.get('liff.state');
  if(st){
    var i=st.indexOf('?'), inner=new URLSearchParams(i>=0 ? st.slice(i+1) : st.replace(/^\//,''));
    inner.forEach(function(v, k){ if(!q.get(k)) q.set(k, v); });
  }
  return q;
}
function auth(extra){
  D.q=params();
  // ลิงก์ผูก LINE ของชิปปิ้ง (เปิดผ่าน LIFF เดียวกัน)
  if(D.q.get('slink')){
    if(!extra.idToken) return fail('กรุณาเปิดลิงก์นี้ในแอป LINE');
    return api({ action:'staffLineRedeem', slink:D.q.get('slink'), idToken:extra.idToken }).then(function(r){
      if(!r.ok) return fail(errText(r));
      $('who').textContent=r.name;
      $('main').innerHTML='<div class="card center"><div class="big">✅</div><h3>ผูก LINE ชิปปิ้งเรียบร้อย</h3><p>'+esc(r.name)+' จะได้รับแจ้งเตือนงานและเมนู "งานชิปปิ้ง" ในแชท SHIPME</p>'+
        '<a class="btn btn-navy" href="/staff?openExternalBrowser=1">เปิดหน้างานชิปปิ้ง</a></div>';
    });
  }
  var p={ action:'driverAuth', link:D.q.get('link')||'', r:D.q.get('r')||'' };
  for(var k in extra) p[k]=extra[k];
  if(!p.link && !p.r && !p.idToken){
    var saved=read('drv_sess');
    if(saved){ D.session=saved; return home(); }
  }
  api(p).then(function(res){
    if(!res.ok){
      if(res.error==='not_linked') return fail(ERR.not_linked, '🔗');
      return fail(errText(res));
    }
    D.session=res.session; store('drv_sess', D.session);
    if(res.linked) toast('เชื่อม LINE กับงานเรียบร้อย ✓', 3000);
    D.openRequest=res.requestId||'';
    home();
  }).catch(function(){ fail('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); });
}
function fail(msg, icon){ $('who').textContent=''; $('main').innerHTML='<div class="card center"><div class="big">'+(icon||'⚠️')+'</div><p>'+esc(msg)+'</p></div>'; }

function home(){
  return api({ action:'driverHome' }).then(function(res){
    if(!res.ok){ if(res.error==='session_expired'){ store('drv_sess', null); } return fail(errText(res)); }
    D.data=res;
    $('who').textContent=res.driver.name+(res.driver.plate?' • '+res.driver.plate:'');
    render();
    // เปิดจากปุ่ม "ส่งตำแหน่ง" ในข้อความ → เด้งไปหน้าส่งตำแหน่งของคำขอนั้นทันที (ถ้ายังไม่หมดอายุ)
    if(D.openRequest && !D.q.get('home')){
      var r=res.requests.filter(function(x){ return x.id===D.openRequest; })[0];
      D.openRequest='';
      if(r) openLocation(r);
    }
    // ทางลัดจาก Rich Menu / ข้อความ: ส่งตำแหน่ง / ช่วยเหลือ / การ์ดนัด
    var q=D.q||new URLSearchParams();
    if(q.get('loc') && !D.shortcutDone){ D.shortcutDone=true;
      if(res.requests.length) openLocation(res.requests[0]); else toast('ยังไม่มีคำขอตำแหน่งจากชิปปิ้งตอนนี้', 3500); }
    if(q.get('help') && !D.shortcutDone){ D.shortcutDone=true; renderHelp(); }
    if(q.get('m') && !D.shortcutDone){ D.shortcutDone=true;
      var el=document.querySelector('[data-meet="'+q.get('m')+'"]'); if(el){ el.scrollIntoView({ block:'center' }); el.style.boxShadow='0 0 0 3px #FFB020'; } }
  });
}

// ---------------- งานของฉัน ----------------
var STEPS=['การ์ด','รับตู้','X-Ray','รับ EIR','ส่งรูป'];
function stepIndex(j){
  if(j.completedAt) return 5; if(j.eirReceivedAt) return 4; if(j.xrayStatus==='passed') return 3; if(j.pickedUpAt) return 2;
  if(j.cardHandedAt||j.cardAckAt) return 1; return 0;
}
function render(){
  var d=D.data, html='';
  d.requests.forEach(function(r){
    var jobs=d.jobs.filter(function(j){ return r.itemIds.indexOf(j.id)>=0; });
    html+='<div class="card req"><h3>'+(r.phase==='CARD_PICKUP'?'📍 ขอพิกัดเพื่อรับการ์ดรับตู้':'📄 ขอพิกัดเพื่อรับ EIR ขาออก')+'</h3>'+
      '<div class="muted">'+jobs.length+' ตู้: '+esc(jobs.map(function(j){ return j.containerNo||j.bl; }).join(', '))+' • ส่งได้ถึง '+hm(r.expiresAt)+'</div>'+
      '<button class="btn btn-green" style="margin-top:10px" data-req="'+esc(r.id)+'">ส่งตำแหน่งตอนนี้</button></div>';
  });
  (d.meetings||[]).forEach(function(m){
    var jobs=d.jobs.filter(function(j){ return m.itemIds.indexOf(j.id)>=0; });
    var acc=m.status==='ACCEPTED', resch=m.status==='RESCHEDULE_REQUESTED';
    html+='<div class="card req" data-meet="'+esc(m.id)+'" style="border-color:'+(acc?'var(--green)':'var(--amber)')+'"><h3>'+(m.phase==='CARD_PICKUP'?'🎫 นัดรับการ์ดรับตู้':'📄 นัดรับ EIR ขาออก')+'</h3>'+
      '<div class="kv"><span>เวลา</span><b>'+hm(m.scheduledAt)+' • '+thd(m.inspectDate)+'</b></div>'+
      '<div class="kv"><span>จุดนัด</span><b>'+esc(m.label)+'</b></div>'+
      '<div class="kv"><span>การเดินทาง</span><b>'+(m.mode==='STAFF_TO_DRIVER'?'ชิปปิ้งจะไปหาคุณ':'กรุณาไปที่จุดนัด')+'</b></div>'+
      '<div class="kv"><span>ตู้</span><b>'+esc(jobs.map(function(j){ return j.containerNo||j.bl; }).join(', '))+'</b></div>'+
      (m.note?'<div class="note wait">'+esc(m.note)+'</div>':'')+
      (acc?'<div class="note ok">รับนัดแล้ว ✓</div>':(resch?'<div class="note err">ส่งคำขอเลื่อน/เปลี่ยนแล้ว — รอชิปปิ้งนัดใหม่</div>':''))+
      (m.lat!=null?'<a class="btn btn-ghost" style="margin-top:8px" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination='+m.lat+','+m.lng+'">🧭 นำทางไปจุดนัด</a>':'')+
      (acc?'':'<button class="btn btn-green" style="margin-top:8px" data-mres="'+esc(m.id)+'" data-acc="1">รับทราบนัด</button>')+
      '<button class="link" data-mres="'+esc(m.id)+'" data-acc="0">ขอเลื่อน / เปลี่ยนจุดนัด</button></div>';
  });
  if(!d.jobs.length) html+='<div class="card center"><div class="big">🚚</div><p>ยังไม่มีงานที่ได้รับมอบหมาย</p></div>';
  var lastDate='';
  d.jobs.forEach(function(j){
    if(j.inspectDate!==lastDate){ lastDate=j.inspectDate; html+='<div class="date">งานวันที่ '+thd(j.inspectDate)+(j.inspectDate===d.today?' (วันนี้)':'')+'</div>'; }
    html+=jobCard(j);
  });
  $('main').innerHTML=html;
  Array.prototype.forEach.call(document.querySelectorAll('[data-req]'), function(b){ b.addEventListener('click', function(){
    openLocation(d.requests.filter(function(r){ return r.id===b.getAttribute('data-req'); })[0]);
  }); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-op]'), function(b){ b.addEventListener('click', function(){ step(b); }); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-mres]'), function(b){ b.addEventListener('click', function(){
    var accept=b.getAttribute('data-acc')==='1', note='';
    if(!accept){ note=prompt('ขอเลื่อนเป็นกี่โมง / สะดวกที่ไหน?'); if(note===null) return; }
    b.disabled=true;
    api({ action:'driverMeeting', meetingId:b.getAttribute('data-mres'), accept:accept, note:note }).then(function(r){
      b.disabled=false; if(!r.ok){ toast(errText(r)); return; } toast(accept?'รับนัดแล้ว ✓':'ส่งคำขอให้ชิปปิ้งแล้ว'); home();
    });
  }); });
  Array.prototype.forEach.call(document.querySelectorAll('input[data-up]'), function(inp){ inp.addEventListener('change', function(){ upload(inp); }); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-del]'), function(b){ b.addEventListener('click', function(){ delPhoto(b.getAttribute('data-del')); }); });
}

function jobCard(j){
  var idx=stepIndex(j);
  var tl='<div class="tl">'+STEPS.map(function(s, i){ return '<div class="s '+(i<idx?'done':(i===idx?'now':''))+'"><i>'+(i<idx?'✓':(i+1))+'</i>'+s+'</div>'; }).join('')+'</div>';
  var body='', id=esc(j.id);
  if(j.completedAt){
    body='<div class="note ok">✅ ส่งข้อมูลจบงานแล้ว '+hm(j.completedAt)+'<br><small>คนขับรายงานตรวจปล่อยเสร็จ (ไม่ใช่การรับรองจากศุลกากร/ท่าเรือ)</small></div>';
  } else if(idx===0){
    body='<div class="note wait">รอรับการ์ดรับตู้จากชิปปิ้ง</div><button class="btn btn-green" data-op="card-ack" data-id="'+id+'">ได้รับการ์ดรับตู้แล้ว</button>';
  } else if(idx===1){
    body='<button class="btn btn-green" data-op="picked-up" data-id="'+id+'">รับตู้แล้ว</button>';
  } else if(idx===2){
    body=(j.xrayStatus==='waiting'?'<div class="note wait">กำลังรอคิว X-Ray ('+hm(j.xrayAt)+')</div>':(j.xrayStatus==='hold'?'<div class="note err">แจ้งติดปัญหา X-Ray แล้ว — ชิปปิ้งรับทราบ</div>':''))+
      '<button class="btn btn-green" data-op="xray" data-status="passed" data-id="'+id+'">ผ่าน X-Ray แล้ว</button>'+
      '<div class="row" style="margin-top:8px"><button class="btn btn-ghost" data-op="xray" data-status="waiting" data-id="'+id+'">ยังรอคิว</button>'+
      '<button class="btn btn-ghost" data-op="xray" data-status="hold" data-id="'+id+'">ติดปัญหา</button></div>';
  } else if(idx===3){
    body = j.eirGateOpen
      ? '<div class="note wait">รอรับ EIR จากชิปปิ้ง'+(j.eirHandedAt?' — ชิปปิ้งบันทึกส่งมอบแล้ว '+hm(j.eirHandedAt):'')+'</div><button class="btn btn-green" data-op="eir-received" data-id="'+id+'">ได้รับ EIR แล้ว</button>'
      : '<div class="note ok">ผ่าน X-Ray แล้ว '+hm(j.xrayAt)+'</div><div class="note wait">รอชิปปิ้งขอตำแหน่งเพื่อแจก EIR (รอตู้อื่นในกลุ่มผ่าน X-Ray ครบ)</div>';
  } else if(idx===4){
    var has=function(k){ return j.evidence.filter(function(e){ return e.kind===k; }); };
    var slot=function(k, label){
      var list=has(k);
      return '<div class="slot'+(list.length?' has':'')+'"><b>'+label+'</b><div class="ph">'+list.map(function(e){
        return '<div><img src="'+esc(e.url)+'" alt="'+label+'"><button data-del="'+esc(e.id)+'" title="ลบ">✕</button></div>'; }).join('')+'</div>'+
        '<label>📷 '+(list.length?'เพิ่มรูป':'ถ่าย / เลือกรูป')+'<input type="file" accept="image/*" capture="environment" hidden data-up="'+k+'" data-id="'+id+'"></label></div>';
    };
    var ready=has('EIR_CARD_PHOTO').length && has('CONTAINER_SEAL_PHOTO').length;
    body='<div class="note ok">ได้รับ EIR แล้ว '+hm(j.eirReceivedAt)+'</div><b>ตรวจปล่อยเสร็จแล้ว? ส่งรูปของตู้นี้</b>'+
      '<div class="slots">'+slot('EIR_CARD_PHOTO','รูปการ์ด EIR')+slot('CONTAINER_SEAL_PHOTO','รูป Seal ตู้')+'</div>'+
      '<button class="btn btn-green" data-op="complete" data-id="'+id+'"'+(ready?'':' disabled')+'>ยืนยันจบงาน</button>'+
      (ready?'':'<div class="muted" style="margin-top:6px">ต้องมีรูปการ์ด EIR และรูป Seal ตู้อย่างน้อยอย่างละ 1 รูป</div>');
  }
  return '<div class="card"><div class="cn">'+esc(j.containerNo||j.bl)+'</div><div class="muted">BL '+esc(j.bl)+' • ท่า '+esc(j.port||'-')+(j.destination?' → '+esc(j.destination):'')+'</div>'+
    tl+body+(j.completedAt?'':'<button class="link" data-op="problem" data-id="'+id+'">แจ้งปัญหา</button>')+'</div>';
}

function step(b){
  var op=b.getAttribute('data-op'), itemId=b.getAttribute('data-id');
  if(D.busy[itemId]) return;
  var payload={ action:'driverStep', op:op, itemId:itemId };
  if(op==='complete') payload={ action:'driverComplete', itemId:itemId };
  if(op==='xray'){ payload.status=b.getAttribute('data-status');
    if(payload.status==='hold'){ var n=prompt('ติดปัญหาอะไร (ไม่บังคับ)'); if(n===null) return; payload.note=n; } }
  if(op==='problem'){ var note=prompt('แจ้งปัญหาให้ชิปปิ้งทราบ'); if(!note) return; payload.note=note; }
  if(op==='complete' && !confirm('ยืนยันว่าตู้นี้ตรวจปล่อยเสร็จแล้ว และรูปถูกต้อง?')) return;
  if(op==='eir-received' && !confirm('ยืนยันว่าได้รับเอกสาร EIR ของตู้นี้แล้ว?')) return;
  D.busy[itemId]=true; b.disabled=true;
  api(payload).then(function(res){
    D.busy[itemId]=false;
    if(!res.ok){ b.disabled=false; toast(errText(res), 3500); return; }
    toast(op==='complete'?'ส่งข้อมูลจบงานแล้ว ✓':'บันทึกแล้ว ✓');
    home();
  }).catch(function(){ D.busy[itemId]=false; b.disabled=false; toast('เชื่อมต่อไม่ได้ ลองใหม่'); });
}

// ---------------- ส่งตำแหน่ง ----------------
function openLocation(r){
  if(!r) return;
  var jobs=D.data.jobs.filter(function(j){ return r.itemIds.indexOf(j.id)>=0; });
  $('main').innerHTML='<div class="card"><h3 style="margin:0 0 6px">'+(r.phase==='CARD_PICKUP'?'📍 แชร์ตำแหน่งเพื่อรับการ์ดรับตู้':'📄 แชร์ตำแหน่งเพื่อรับ EIR')+'</h3>'+
    '<div class="muted">ตู้: '+esc(jobs.map(function(j){ return j.containerNo||j.bl; }).join(', '))+'</div>'+
    '<div class="muted" style="margin-top:8px">ระบบจะขอสิทธิ์ตำแหน่งจากมือถือ <b>ครั้งเดียวตอนกดปุ่ม</b> เพื่อให้ชิปปิ้งนัดจุดพบ — ไม่มีการติดตามตำแหน่งตลอดเวลา</div>'+
    '<div id="loc-st" class="note wait hidden"></div><div id="loc-prev"></div>'+
    '<button class="btn btn-green" id="loc-get" style="margin-top:10px">📍 หาตำแหน่งปัจจุบัน</button>'+
    '<button class="btn btn-ghost" id="loc-back" style="margin-top:8px">กลับ</button></div>';
  $('loc-back').addEventListener('click', render);
  $('loc-get').addEventListener('click', function(){ getPosition(r); });
}
function getPosition(r){
  var st=$('loc-st'), btn=$('loc-get');
  var show=function(cls, t){ st.className='note '+cls; st.innerHTML=t; };
  if(!navigator.geolocation){ show('err','มือถือนี้ไม่รองรับการหาตำแหน่ง'); return; }
  btn.disabled=true; show('wait','กำลังหาตำแหน่ง… กด "อนุญาต" เมื่อมือถือถาม');
  navigator.geolocation.getCurrentPosition(function(p){
    btn.disabled=false;
    var acc=Math.round(p.coords.accuracy||0), lat=p.coords.latitude, lng=p.coords.longitude;
    show(acc>100?'wait':'ok', 'พบตำแหน่งแล้ว • แม่นยำ ±'+acc+' ม.'+(acc>100?' (ค่อนข้างกว้าง ถ้าเป็นไปได้ออกที่โล่งแล้วลองใหม่)':''));
    $('loc-prev').innerHTML='<div class="kv"><span>พิกัด</span><b><a target="_blank" rel="noopener" href="https://www.google.com/maps?q='+lat+','+lng+'">'+lat.toFixed(5)+', '+lng.toFixed(5)+'</a></b></div>'+
      '<button class="btn btn-navy" id="loc-send" style="margin-top:10px">ยืนยันส่งตำแหน่ง</button>';
    btn.textContent='หาตำแหน่งใหม่'; btn.className='btn btn-ghost';
    $('loc-send').addEventListener('click', function(){
      this.disabled=true;
      api({ action:'driverReportLocation', requestId:r.id, lat:lat, lng:lng, accuracy:acc, capturedAt:new Date(p.timestamp||Date.now()).toISOString() }).then(function(res){
        if(!res.ok){ toast(errText(res), 3500); $('loc-send').disabled=false; return; }
        toast('ส่งตำแหน่งให้ชิปปิ้งแล้ว ✓', 3000); home();
      });
    });
  }, function(e){
    btn.disabled=false;
    var denied=e && e.code===1;
    show('err', (denied?'ยังไม่ได้อนุญาตให้ใช้ตำแหน่ง':'หาตำแหน่งไม่ได้ กรุณาเปิด GPS แล้วลองใหม่')+
      '<br><small>iPhone: ตั้งค่า → ความเป็นส่วนตัว → บริการหาตำแหน่ง → LINE → ขณะใช้งาน<br>Android: ตั้งค่า → แอป → LINE → สิทธิ์ → ตำแหน่ง → อนุญาต</small>'+
      '<br><button class="link" id="loc-deny">แจ้งชิปปิ้งว่าหาตำแหน่งไม่ได้</button>');
    $('loc-deny').addEventListener('click', function(){ api({ action:'driverReportLocation', requestId:r.id, denied:true }).then(function(){ toast('แจ้งชิปปิ้งแล้ว — ชิปปิ้งจะโทรหา'); home(); }); });
  }, { enableHighAccuracy:true, timeout:20000, maximumAge:0 });
}

// ---------------- รูปปิดงาน ----------------
function resize(file){
  return new Promise(function(resolve, reject){
    var url=URL.createObjectURL(file), img=new Image();
    img.onload=function(){
      var s=Math.min(1, 1600/Math.max(img.width, img.height)), c=document.createElement('canvas');
      c.width=Math.round(img.width*s); c.height=Math.round(img.height*s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(function(b){ b ? resolve(b) : reject(new Error('แปลงรูปไม่สำเร็จ')); }, 'image/jpeg', 0.85);
    };
    img.onerror=function(){ reject(new Error('เปิดรูปนี้ไม่ได้ — ใช้รูป JPG/PNG')); };
    img.src=url;
  });
}
function upload(inp){
  var file=inp.files && inp.files[0], kind=inp.getAttribute('data-up'), itemId=inp.getAttribute('data-id');
  inp.value='';
  if(!file) return;
  if(file.size>25*1024*1024){ toast('รูปใหญ่เกินไป'); return; }
  toast('กำลังอัปโหลดรูป…', 8000);
  var blob;
  resize(file).then(function(b){ blob=b; if(blob.size>10*1024*1024) throw new Error('รูปใหญ่เกิน 10MB');
    return api({ action:'driverEvidenceSign', itemId:itemId, kind:kind });
  }).then(function(s){
    if(!s.ok) throw new Error(errText(s));
    return fetch(s.uploadUrl, { method:'PUT', headers:{ 'content-type':'image/jpeg' }, body:blob }).then(function(r){
      if(!r.ok) throw new Error('อัปโหลดไม่สำเร็จ ลองใหม่');
      return api({ action:'driverEvidenceCommit', itemId:itemId, kind:kind, key:s.key, size:blob.size });
    });
  }).then(function(c){
    if(!c.ok) throw new Error(errText(c));
    toast('อัปโหลดรูปแล้ว ✓'); home();
  }).catch(function(e){ toast(e.message||'อัปโหลดไม่สำเร็จ', 3500); });
}
function delPhoto(id){
  if(!confirm('ลบรูปนี้?')) return;
  api({ action:'driverEvidenceDelete', id:id }).then(function(res){ if(!res.ok){ toast(errText(res)); return; } home(); });
}


// ---------------- ช่วยเหลือ ----------------
function renderHelp(){
  var d=D.data, staff=(d.help||[]).map(function(s){ return esc(s.name); }).join(', ');
  $('main').innerHTML='<div class="card"><h3 style="margin:0 0 8px">☎️ ช่วยเหลือ</h3>'+
    (staff?'<div class="kv"><span>ชิปปิ้งที่ดูแลงานคุณ</span><b>'+staff+'</b></div>':'')+
    '<p style="font-size:14.5px;line-height:1.7">'+
    '<b>ขั้นตอนงาน</b><br>1) ชิปปิ้งขอตำแหน่ง → กด "ส่งตำแหน่งตอนนี้"<br>2) รับการ์ดรับตู้ตามนัด → กด "ได้รับการ์ดรับตู้แล้ว"<br>'+
    '3) รับตู้ → กด "รับตู้แล้ว"<br>4) ผ่าน X-Ray → กด "ผ่าน X-Ray แล้ว"<br>5) รอชิปปิ้งนัดส่ง EIR (เมื่อตู้ทั้งกลุ่มผ่าน X-Ray) → กด "ได้รับ EIR แล้ว"<br>'+
    '6) ตรวจปล่อยเสร็จ → ถ่ายรูปการ์ด EIR + รูป Seal ของแต่ละตู้ → "ยืนยันจบงาน"</p>'+
    '<p style="font-size:14px"><b>หาตำแหน่งไม่ได้?</b><br>iPhone: ตั้งค่า → ความเป็นส่วนตัว → บริการหาตำแหน่ง → LINE → ขณะใช้งาน<br>Android: ตั้งค่า → แอป → LINE → สิทธิ์ → ตำแหน่ง → อนุญาต</p>'+
    '<p style="font-size:14px">ติดปัญหากับตู้ไหน กด <b>"แจ้งปัญหา"</b> ใต้ตู้นั้น ชิปปิ้งจะได้รับแจ้งทันที</p>'+
    '<button class="btn btn-navy" id="help-back">กลับไปงานของฉัน</button></div>';
  $('help-back').addEventListener('click', render);
}
