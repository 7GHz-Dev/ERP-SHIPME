/**
 * หน้าคนขับ (/driver) — เปิดจากปุ่มในข้อความ LINE OA (LIFF) หรือลิงก์ SMS (ช่องทางสำรอง)
 *
 * เข้าใช้งาน: LIFF ID token (ตรวจฝั่งเซิร์ฟเวอร์) / ?link=โค้ดผูก LINE / ?r=รหัสคำขอพิกัด (SMS) / ?s=session (DEMO)
 * ทุกอย่างทำทีละตู้: รับการ์ด → รับตู้ + รูปหน้ารถ/หลังรถ/ซีลตู้ → นำทางไปเครื่อง X-Ray กด "X-Ray แล้ว" → รอผล (ชิปปิ้งบันทึก)
 *   → รับ EIR ตามนัด → ถ่ายรูปการ์ด EIR + Seal → ยืนยันจบงาน
 * ตำแหน่งส่งเฉพาะตอนคนขับกดปุ่มเอง (กดครั้งเดียวส่งเลย) ไม่มีการติดตามเบื้องหลัง
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
  card_first:'ต้องได้รับการ์ดรับตู้ก่อน', pickup_first:'ต้องกด "ส่งงานรับตู้" ก่อน', xray_first:'ต้องผ่าน X-Ray ก่อน',
  XRAY_BATCH_NOT_READY:'ยังรอตู้อื่นในกลุ่มผ่าน X-Ray', eir_first:'ต้องได้รับ EIR ก่อน', photos_required:'ต้องมีรูปการ์ด EIR และรูป Seal ตู้',
  request_expired:'คำขอนี้หมดอายุแล้ว — รอชิปปิ้งส่งคำขอใหม่', forbidden:'ไม่ใช่งานของคุณ', already_completed:'ตู้นี้ส่งจบงานแล้ว',
  upload_missing:'อัปโหลดรูปไม่สำเร็จ ลองใหม่', file_too_large:'รูปใหญ่เกิน 10MB', line_not_configured:'ระบบ LINE ยังไม่พร้อม',
  invalid_id_token:'ยืนยันตัวตน LINE ไม่สำเร็จ ลองเปิดใหม่', no_credentials:'กรุณาเปิดจากลิงก์ในข้อความ',
  pickup_photos_required:'ต้องมีรูปหน้ารถ หลังรถ และซีลตู้ครบก่อน', pickup_submitted:'ส่งงานรับตู้แล้ว แก้รูปไม่ได้',
  xray_result_by_staff:'ผล X-Ray ชิปปิ้งเป็นคนบันทึก — กด "X-Ray แล้ว" เมื่อเข้าเครื่องเสร็จ', bad_location:'ตำแหน่งไม่ถูกต้อง ลองใหม่'
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
    // เปิดจากปุ่ม "ส่งตำแหน่งตอนนี้" ในข้อความ = กดแล้ว 1 ครั้ง → ส่งตำแหน่งทันที ไม่ต้องกดซ้ำ
    if(D.openRequest && !D.q.get('home')){
      var r=res.requests.filter(function(x){ return x.id===D.openRequest; })[0];
      D.openRequest='';
      if(r) sendLocation([r]); else toast('คำขอตำแหน่งนี้ส่งไปแล้วหรือหมดอายุ', 3500);
    }
    // ทางลัดจาก Rich Menu / ข้อความ: ส่งตำแหน่ง / ช่วยเหลือ / การ์ดนัด
    var q=D.q||new URLSearchParams();
    if(q.get('loc') && !D.shortcutDone){ D.shortcutDone=true;
      if(res.requests.length) sendLocation(res.requests); else toast('ตอนนี้ชิปปิ้งยังไม่ได้ขอตำแหน่ง', 3500); }
    if(q.get('help') && !D.shortcutDone){ D.shortcutDone=true; renderHelp(); }
    if(q.get('m') && !D.shortcutDone){ D.shortcutDone=true;
      var el=document.querySelector('[data-meet="'+q.get('m')+'"]'); if(el){ el.scrollIntoView({ block:'center' }); el.style.boxShadow='0 0 0 3px #FFB020'; } }
  });
}

// ---------------- ขั้นตอนงาน ----------------
var STEPS=['การ์ด','รับตู้','X-Ray','ผล X-Ray','รับ EIR','ส่งรูป'];
var GUIDE=[
  ['ส่งตำแหน่ง + รับการ์ดรับตู้','ชิปปิ้งขอตำแหน่งทาง LINE → กด "ส่งตำแหน่งตอนนี้" แล้วรับการ์ดตามนัด'],
  ['ไปรับตู้ + ถ่ายรูป','ถ่ายรูปหน้ารถ หลังรถ และซีลตู้ แล้วกด "ส่งงานรับตู้"'],
  ['ไปเครื่อง X-Ray','กด "นำทางไปเครื่อง X-Ray" เข้าเครื่องแล้วกด "X-Ray แล้ว"'],
  ['รอผล X-Ray','ชิปปิ้งเช็กผล X-Ray แล้วแจ้งทาง LINE'],
  ['รับ EIR ออกท่า','ชิปปิ้งนัดส่งมอบ EIR → ได้รับแล้วกด "ได้รับ EIR แล้ว"'],
  ['ส่งรูปจบงาน','ถ่ายรูปการ์ด EIR + รูป Seal ตู้ → "ยืนยันจบงาน"']
];
function stepIndex(j){
  if(j.completedAt) return 6; if(j.eirReceivedAt) return 5; if(j.xrayStatus==='passed') return 4;
  if(j.pickedUpAt && j.xrayStatus!=='pending') return 3; if(j.pickedUpAt) return 2;
  if(j.cardHandedAt||j.cardAckAt) return 1; return 0;
}
function cnList(list){ return list.map(function(j){ return j.containerNo||j.bl; }).join(', '); }
function xrayPointFor(j){
  var pts=(D.data&&D.data.xrayPoints)||[], port=String(j.port||'').toUpperCase();
  return pts.filter(function(p){ var pp=String(p.port||'').toUpperCase(); return pp && port && (pp===port || port.indexOf(pp)>=0 || pp.indexOf(port)>=0); })[0] || pts[0] || null;
}

/** สิ่งที่คนขับต้องทำตอนนี้ (แสดงบนสุดเสมอ) — เรียง: คำขอตำแหน่ง > นัดที่ยังไม่รับ > ขั้นของตู้ที่ช้าที่สุดในงานวันแรก */
function nextTodo(d){
  if(d.requests.length){
    var r=d.requests[0], card=r.phase==='CARD_PICKUP';
    return { step:card?1:5, title:'ส่งตำแหน่งให้ชิปปิ้ง', text:'กดปุ่มสีเขียว "ส่งตำแหน่งตอนนี้" ครั้งเดียว ระบบจะส่งตำแหน่งให้เลย — ชิปปิ้งจะนัด'+(card?'แจกการ์ดรับตู้':'ส่งมอบ EIR'), target:'[data-req]' };
  }
  var pm=(d.meetings||[]).filter(function(m){ return m.status==='PROPOSED'; })[0];
  if(pm) return { step:pm.phase==='CARD_PICKUP'?1:5, title:'รับทราบนัดหมาย', text:'ชิปปิ้งนัด'+(pm.phase==='CARD_PICKUP'?'แจกการ์ดรับตู้':'ส่งมอบ EIR')+' เวลา '+hm(pm.scheduledAt)+' ที่ '+pm.label+' — กด "รับทราบนัด"', target:'[data-meet="'+pm.id+'"]' };
  var open=d.jobs.filter(function(j){ return !j.completedAt; });
  if(!open.length) return { done:true, title:'ส่งงานครบทุกตู้แล้ว', text:'ตอนนี้ไม่มีอะไรต้องทำ ขอบคุณครับ — งานใหม่จะแจ้งทาง LINE' };
  var date=open[0].inspectDate, list=open.filter(function(j){ return j.inspectDate===date; });
  var idx=Math.min.apply(null, list.map(stepIndex)), on=list.filter(function(j){ return stepIndex(j)===idx; }), cns=cnList(on);
  var am=(d.meetings||[]).filter(function(m){ return m.status==='ACCEPTED'; })[0];
  var t;
  if(idx===0) t={ title:'รับการ์ดรับตู้', text: am && am.phase==='CARD_PICKUP' ? 'ไปตามนัด '+hm(am.scheduledAt)+' ที่ '+am.label+' แล้วกด "ได้รับการ์ดรับตู้แล้ว"'
                 : 'รอชิปปิ้งขอตำแหน่ง / นัดแจกการ์ด — ได้การ์ดแล้วกด "ได้รับการ์ดรับตู้แล้ว"' };
  else if(idx===1) t={ title:'ไปรับตู้ แล้วถ่ายรูป', text:'รับตู้ที่ท่า '+(on[0].port||'-')+' → ถ่ายรูปหน้ารถ หลังรถ และซีลตู้ แล้วกด "ส่งงานรับตู้"' };
  else if(idx===2) t={ title:'ไปเครื่อง X-Ray', text:'กด "นำทางไปเครื่อง X-Ray" เข้าเครื่องเสร็จแล้วกด "X-Ray แล้ว"' };
  else if(idx===3) t= on.some(function(j){ return j.xrayStatus==='hold'; })
      ? { title:'X-Ray ต้องตรวจเพิ่ม', text:'รอคำแนะนำจากชิปปิ้ง หรือโทรสอบถาม', warn:true }
      : { title:'รอผล X-Ray', text:'ไม่ต้องกดอะไร — ชิปปิ้งกำลังเช็กผล จะแจ้งทาง LINE เมื่อผ่าน', wait:true };
  else if(idx===4){
    var handed=on.filter(function(j){ return j.eirHandedAt; });
    t= handed.length ? { title:'ยืนยันรับ EIR', text:'ชิปปิ้งบันทึกส่งมอบ EIR แล้ว — ได้รับแล้วกด "ได้รับ EIR แล้ว"' }
      : (am && am.phase==='EIR_HANDOVER' ? { title:'ไปรับ EIR ตามนัด', text:'นัด '+hm(am.scheduledAt)+' ที่ '+am.label+' — ได้รับแล้วกด "ได้รับ EIR แล้ว"' }
      : { title:'X-Ray ผ่านแล้ว — รอนัดรับ EIR', text: on[0].eirGateOpen ? 'รอชิปปิ้งขอตำแหน่ง / นัดส่งมอบ EIR ออกท่าทาง LINE' : 'รอตู้อื่นในกลุ่มผ่าน X-Ray ครบ แล้วชิปปิ้งจะนัดส่งมอบ EIR', wait:true });
  }
  else t={ title:'ส่งรูปจบงาน', text:'ตรวจปล่อยเสร็จแล้ว ถ่ายรูปการ์ด EIR และรูป Seal ตู้ แล้วกด "ยืนยันจบงาน"' };
  t.step=idx+1; t.cns=cns; t.target='[data-job="'+on[0].id+'"]';
  if(date!==d.today) t.date=date;
  return t;
}
function todoCard(t){
  var cls=t.done?'done':(t.warn?'warn':(t.wait?'wait':''));
  return '<div class="todo '+cls+'"'+(t.target?' data-goto="'+esc(t.target)+'"':'')+'>'+
    (t.step?'<div class="todo-step">ขั้นตอนที่ '+t.step+' จาก 6 • '+esc(GUIDE[t.step-1][0])+'</div>':'<div class="todo-step">สถานะงาน</div>')+
    '<div class="todo-title">'+(t.done?'✅ ':(t.wait?'⏳ ':(t.warn?'⚠️ ':'👉 ')))+esc(t.title)+'</div>'+
    '<div class="todo-text">'+esc(t.text)+'</div>'+
    (t.cns?'<div class="todo-cn">ตู้: '+esc(t.cns)+(t.date?' • งานวันที่ '+thd(t.date):'')+'</div>':'')+
    (t.step?'<div class="todo-bar">'+STEPS.map(function(s,i){ return '<i class="'+(i<t.step-1?'d':(i===t.step-1?'n':''))+'"></i>'; }).join('')+'</div>':'')+'</div>';
}
function guideList(){
  return '<ol class="guide">'+GUIDE.map(function(g){ return '<li><b>'+esc(g[0])+'</b><span>'+esc(g[1])+'</span></li>'; }).join('')+'</ol>';
}

// ---------------- งานของฉัน ----------------
function render(){
  var d=D.data, html='';
  if(!d.jobs.length){
    html='<div class="todo wait"><div class="todo-step">ตอนนี้</div><div class="todo-title">⏳ รอชิปปิ้งส่งงานให้คุณ</div>'+
      '<div class="todo-text">ยังไม่มีตู้ที่ต้องทำ — เมื่อมีงาน SHIPME จะส่งข้อความ LINE ขอตำแหน่งของคุณ ให้กด "ส่งตำแหน่งตอนนี้" ในข้อความนั้นครั้งเดียว</div></div>'+
      '<div class="card"><b>ขั้นตอนงานเมื่อได้รับงาน</b>'+guideList()+
      '<div class="muted">เปิดแจ้งเตือน LINE ของ SHIPME ไว้ จะได้ไม่พลาดข้อความ</div></div>';
    $('main').innerHTML=html; bindCommon(); return;
  }
  html+=todoCard(nextTodo(d));
  d.requests.forEach(function(r){
    var jobs=d.jobs.filter(function(j){ return r.itemIds.indexOf(j.id)>=0; });
    html+='<div class="card req" data-reqcard="'+esc(r.id)+'"><h3>'+(r.phase==='CARD_PICKUP'?'📍 ชิปปิ้งขอตำแหน่ง — นัดแจกการ์ดรับตู้':'📍 ชิปปิ้งขอตำแหน่ง — นัดส่งมอบ EIR')+'</h3>'+
      '<div class="muted">'+jobs.length+' ตู้: '+esc(cnList(jobs))+' • ส่งได้ถึง '+hm(r.expiresAt)+'</div>'+
      '<button class="btn btn-green" style="margin-top:10px" data-req="'+esc(r.id)+'">📍 ส่งตำแหน่งตอนนี้</button>'+
      '<div class="loc-st hidden"></div></div>';
  });
  (d.meetings||[]).forEach(function(m){
    var jobs=d.jobs.filter(function(j){ return m.itemIds.indexOf(j.id)>=0; });
    var acc=m.status==='ACCEPTED', resch=m.status==='RESCHEDULE_REQUESTED';
    html+='<div class="card req" data-meet="'+esc(m.id)+'" style="border-color:'+(acc?'var(--green)':'var(--amber)')+'"><h3>'+(m.phase==='CARD_PICKUP'?'🎫 นัดรับการ์ดรับตู้':'📄 นัดรับ EIR ออกท่า')+'</h3>'+
      '<div class="kv"><span>เวลา</span><b>'+hm(m.scheduledAt)+' • '+thd(m.inspectDate)+'</b></div>'+
      '<div class="kv"><span>จุดนัด</span><b>'+esc(m.label)+'</b></div>'+
      '<div class="kv"><span>การเดินทาง</span><b>'+(m.mode==='STAFF_TO_DRIVER'?'ชิปปิ้งจะไปหาคุณ':'กรุณาไปที่จุดนัด')+'</b></div>'+
      '<div class="kv"><span>ตู้</span><b>'+esc(cnList(jobs))+'</b></div>'+
      (m.note?'<div class="note wait">'+esc(m.note)+'</div>':'')+
      (acc?'<div class="note ok">รับนัดแล้ว ✓</div>':(resch?'<div class="note err">ส่งคำขอเลื่อน/เปลี่ยนแล้ว — รอชิปปิ้งนัดใหม่</div>':''))+
      (m.lat!=null?'<a class="btn btn-ghost" style="margin-top:8px" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination='+m.lat+','+m.lng+'">🧭 นำทางไปจุดนัด</a>':'')+
      (acc?'':'<button class="btn btn-green" style="margin-top:8px" data-mres="'+esc(m.id)+'" data-acc="1">รับทราบนัด</button>')+
      '<button class="link" data-mres="'+esc(m.id)+'" data-acc="0">ขอเลื่อน / เปลี่ยนจุดนัด</button></div>';
  });
  var lastDate='';
  d.jobs.forEach(function(j){
    if(j.inspectDate!==lastDate){ lastDate=j.inspectDate; html+='<div class="date">งานวันที่ '+thd(j.inspectDate)+(j.inspectDate===d.today?' (วันนี้)':'')+'</div>'; }
    html+=jobCard(j);
  });
  html+='<button class="link" id="go-help" style="display:block;margin:6px auto 0">ดูขั้นตอนงานทั้งหมด / ช่วยเหลือ</button>';
  $('main').innerHTML=html;
  bindCommon();
  Array.prototype.forEach.call(document.querySelectorAll('[data-req]'), function(b){ b.addEventListener('click', function(){
    sendLocation(d.requests.filter(function(r){ return r.id===b.getAttribute('data-req'); }));
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
function bindCommon(){
  var t=document.querySelector('[data-goto]');
  if(t) t.addEventListener('click', function(){ var el=document.querySelector(t.getAttribute('data-goto')); if(el){ el.scrollIntoView({ behavior:'smooth', block:'start' }); el.classList.add('flash'); setTimeout(function(){ el.classList.remove('flash'); }, 1600); } });
  if($('go-help')) $('go-help').addEventListener('click', renderHelp);
}

function photoSlot(j, kind, label, locked){
  var list=j.evidence.filter(function(e){ return e.kind===kind; }), id=esc(j.id);
  return '<div class="slot'+(list.length?' has':'')+'"><b>'+label+'</b><div class="ph">'+list.map(function(e){
    return '<div><img src="'+esc(e.url)+'" alt="'+label+'">'+(locked?'':'<button data-del="'+esc(e.id)+'" title="ลบ">✕</button>')+'</div>'; }).join('')+'</div>'+
    (locked?'':'<label>📷 '+(list.length?'เพิ่มรูป':'ถ่ายรูป')+'<input type="file" accept="image/*" capture="environment" hidden data-up="'+kind+'" data-id="'+id+'"></label>')+'</div>';
}
function hasKinds(j, kinds){ return kinds.every(function(k){ return j.evidence.some(function(e){ return e.kind===k; }); }); }

function jobCard(j){
  var idx=stepIndex(j);
  var tl='<div class="tl">'+STEPS.map(function(s, i){ return '<div class="s '+(i<idx?'done':(i===idx?'now':''))+'"><i>'+(i<idx?'✓':(i+1))+'</i>'+s+'</div>'; }).join('')+'</div>';
  var body='', id=esc(j.id);
  if(j.completedAt){
    body='<div class="note ok">✅ ส่งข้อมูลจบงานแล้ว '+hm(j.completedAt)+'<br><small>คนขับรายงานตรวจปล่อยเสร็จ (ไม่ใช่การรับรองจากศุลกากร/ท่าเรือ)</small></div>';
  } else if(idx===0){
    body='<div class="note wait">รอรับการ์ดรับตู้จากชิปปิ้ง</div><button class="btn btn-green" data-op="card-ack" data-id="'+id+'">ได้รับการ์ดรับตู้แล้ว</button>';
  } else if(idx===1){
    var pk=['TRUCK_FRONT_PHOTO','TRUCK_REAR_PHOTO','PICKUP_SEAL_PHOTO'], ok1=hasKinds(j, pk);
    body='<div class="note ok">ได้การ์ดรับตู้แล้ว — ไปรับตู้ที่ท่า '+esc(j.port||'-')+'</div><b>รับตู้แล้ว ถ่ายรูป 3 อย่าง</b>'+
      '<div class="slots three">'+photoSlot(j,'TRUCK_FRONT_PHOTO','หน้ารถ')+photoSlot(j,'TRUCK_REAR_PHOTO','หลังรถ')+photoSlot(j,'PICKUP_SEAL_PHOTO','ซีลตู้')+'</div>'+
      '<button class="btn btn-green" data-op="picked-up" data-id="'+id+'"'+(ok1?'':' disabled')+'>🚚 ส่งงานรับตู้</button>'+
      (ok1?'':'<div class="muted" style="margin-top:6px">ต้องมีรูปหน้ารถ หลังรถ และซีลตู้ อย่างละ 1 รูป</div>');
  } else if(idx===2){
    var p=xrayPointFor(j);
    body='<div class="note ok">ส่งงานรับตู้แล้ว '+hm(j.pickedUpAt)+'</div>'+
      (p?'<a class="btn btn-navy" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&travelmode=driving&destination='+p.lat+','+p.lng+'">🧭 นำทางไปเครื่อง X-Ray'+(p.name?' • '+esc(p.name):'')+'</a>'+(p.note?'<div class="muted" style="margin-top:4px">'+esc(p.note)+'</div>':'')
        :'<div class="note wait">ยังไม่ได้ปักตำแหน่งเครื่อง X-Ray ในระบบ — สอบถามชิปปิ้ง</div>')+
      '<button class="btn btn-green" style="margin-top:8px" data-op="xray" data-status="scanned" data-id="'+id+'">🛃 X-Ray แล้ว</button>'+
      '<button class="link" data-op="xray" data-status="hold" data-id="'+id+'">ติดปัญหาที่ X-Ray</button>';
  } else if(idx===3){
    body= j.xrayStatus==='hold'
      ? '<div class="note err">⚠️ X-Ray ต้องตรวจเพิ่ม / ติดปัญหา — รอคำแนะนำจากชิปปิ้ง</div>'
      : '<div class="note ok">เข้าเครื่อง X-Ray แล้ว '+hm(j.xrayAt)+'</div><div class="note wait">⏳ รอผล X-Ray — ชิปปิ้งจะแจ้งทาง LINE และนัดส่งมอบ EIR ออกท่า</div>';
  } else if(idx===4){
    body='<div class="note ok">✅ ผล X-Ray ผ่านแล้ว</div>'+(j.eirGateOpen
      ? '<div class="note wait">'+(j.eirHandedAt?'ชิปปิ้งบันทึกส่งมอบ EIR แล้ว '+hm(j.eirHandedAt):'รอชิปปิ้งนัดส่งมอบ EIR ออกท่า')+'</div><button class="btn btn-green" data-op="eir-received" data-id="'+id+'">ได้รับ EIR แล้ว</button>'
      : '<div class="note wait">รอตู้อื่นในกลุ่มผ่าน X-Ray ครบ แล้วชิปปิ้งจะนัดส่งมอบ EIR</div>');
  } else if(idx===5){
    var ready=hasKinds(j, ['EIR_CARD_PHOTO','CONTAINER_SEAL_PHOTO']);
    body='<div class="note ok">ได้รับ EIR แล้ว '+hm(j.eirReceivedAt)+'</div><b>ตรวจปล่อยเสร็จแล้ว? ส่งรูปของตู้นี้</b>'+
      '<div class="slots">'+photoSlot(j,'EIR_CARD_PHOTO','รูปการ์ด EIR')+photoSlot(j,'CONTAINER_SEAL_PHOTO','รูป Seal ตู้')+'</div>'+
      '<button class="btn btn-green" data-op="complete" data-id="'+id+'"'+(ready?'':' disabled')+'>ยืนยันจบงาน</button>'+
      (ready?'':'<div class="muted" style="margin-top:6px">ต้องมีรูปการ์ด EIR และรูป Seal ตู้อย่างน้อยอย่างละ 1 รูป</div>');
  }
  return '<div class="card" data-job="'+id+'"><div class="cn">'+esc(j.containerNo||j.bl)+'</div><div class="muted">BL '+esc(j.bl)+' • ท่า '+esc(j.port||'-')+(j.destination?' → '+esc(j.destination):'')+'</div>'+
    tl+body+(j.completedAt?'':'<button class="link" data-op="problem" data-id="'+id+'">แจ้งปัญหา</button>')+'</div>';
}

function step(b){
  var op=b.getAttribute('data-op'), itemId=b.getAttribute('data-id');
  if(D.busy[itemId]) return;
  var payload={ action:'driverStep', op:op, itemId:itemId };
  if(op==='complete') payload={ action:'driverComplete', itemId:itemId };
  if(op==='xray'){ payload.status=b.getAttribute('data-status');
    if(payload.status==='hold'){ var n=prompt('ติดปัญหาอะไรที่ X-Ray (ไม่บังคับ)'); if(n===null) return; payload.note=n; } }
  if(op==='problem'){ var note=prompt('แจ้งปัญหาให้ชิปปิ้งทราบ'); if(!note) return; payload.note=note; }
  if(op==='picked-up' && !confirm('ยืนยันส่งงานรับตู้? (ส่งแล้วแก้รูปไม่ได้)')) return;
  if(op==='complete' && !confirm('ยืนยันว่าตู้นี้ตรวจปล่อยเสร็จแล้ว และรูปถูกต้อง?')) return;
  if(op==='eir-received' && !confirm('ยืนยันว่าได้รับเอกสาร EIR ของตู้นี้แล้ว?')) return;
  D.busy[itemId]=true; b.disabled=true;
  api(payload).then(function(res){
    D.busy[itemId]=false;
    if(!res.ok){ b.disabled=false; toast(errText(res), 3500); return; }
    toast(op==='complete'?'ส่งข้อมูลจบงานแล้ว ✓':(op==='picked-up'?'ส่งงานรับตู้แล้ว ✓ ต่อไป: ไปเครื่อง X-Ray':(op==='xray'&&payload.status==='scanned'?'บันทึกแล้ว ✓ รอผล X-Ray จากชิปปิ้ง':'บันทึกแล้ว ✓')), 3000);
    home();
  }).catch(function(){ D.busy[itemId]=false; b.disabled=false; toast('เชื่อมต่อไม่ได้ ลองใหม่'); });
}

// ---------------- ส่งตำแหน่ง (กดครั้งเดียว) ----------------
/**
 * กดปุ่มเดียว → ขอพิกัดจากมือถือ → ส่งให้ชิปปิ้งทันที (ไม่มีหน้ายืนยันซ้ำ)
 * หาแบบแม่นยำก่อน ถ้าช้าเกินค่อยใช้แบบเร็ว / ส่งให้ทุกคำขอที่ระบุ (ปกติ 1 คำขอ)
 */
function sendLocation(reqs){
  if(!reqs || !reqs.length) return;
  if(D.locBusy) return;
  var card=document.querySelector('[data-reqcard="'+reqs[0].id+'"]');
  var btn=card && card.querySelector('[data-req]'), st=card && card.querySelector('.loc-st');
  var show=function(cls, html){ if(st){ st.className='loc-st note '+cls; st.innerHTML=html; } else if(cls!=='wait') toast(html.replace(/<[^>]+>/g,' '), 4000); };
  if(card) card.scrollIntoView({ block:'center' });
  if(!navigator.geolocation){ show('err','มือถือนี้ไม่รองรับการหาตำแหน่ง — โทรแจ้งชิปปิ้ง'); return; }
  D.locBusy=true; if(btn){ btn.disabled=true; btn.textContent='กำลังส่งตำแหน่ง…'; }
  show('wait','กำลังหาตำแหน่ง… ถ้ามือถือถาม ให้กด "อนุญาต"');
  var done=function(){ D.locBusy=false; if(btn){ btn.disabled=false; btn.textContent='📍 ลองส่งอีกครั้ง'; } };
  var got=function(p){
    var acc=Math.round(p.coords.accuracy||0), lat=p.coords.latitude, lng=p.coords.longitude;
    show('wait','พบตำแหน่งแล้ว (±'+acc+' ม.) กำลังส่ง…');
    var at=new Date(p.timestamp||Date.now()).toISOString(), okCount=0, lastErr=null;
    var chain=Promise.resolve();
    reqs.forEach(function(r){ chain=chain.then(function(){
      return api({ action:'driverReportLocation', requestId:r.id, lat:lat, lng:lng, accuracy:acc, capturedAt:at }).then(function(res){ if(res.ok) okCount++; else lastErr=res; });
    }); });
    chain.then(function(){
      if(!okCount){ done(); show('err', esc(errText(lastErr))); return; }
      D.locBusy=false;
      if(card) card.innerHTML='<div class="center" style="padding:16px 8px"><div class="big">✅</div><b>ส่งตำแหน่งให้ชิปปิ้งแล้ว</b><div class="muted">แม่นยำ ±'+acc+' ม. • รอชิปปิ้งส่งนัดหมายทาง LINE</div></div>';
      toast('ส่งตำแหน่งให้ชิปปิ้งแล้ว ✓', 3000);
      setTimeout(home, 2200);
    }).catch(function(){ done(); show('err','ส่งไม่สำเร็จ — เช็กอินเทอร์เน็ตแล้วกดอีกครั้ง'); });
  };
  var fail=function(e){
    done();
    var denied=e && e.code===1;
    show('err', (denied?'ยังไม่ได้อนุญาตให้ใช้ตำแหน่ง':'หาตำแหน่งไม่ได้ กรุณาเปิด GPS แล้วกดอีกครั้ง')+
      '<br><small>iPhone: ตั้งค่า → ความเป็นส่วนตัว → บริการหาตำแหน่ง → LINE → ขณะใช้งาน<br>Android: ตั้งค่า → แอป → LINE → สิทธิ์ → ตำแหน่ง → อนุญาต</small>'+
      '<br><button class="link" data-deny="1">แจ้งชิปปิ้งว่าหาตำแหน่งไม่ได้</button>');
    var dn=st && st.querySelector('[data-deny]');
    if(dn) dn.addEventListener('click', function(){ api({ action:'driverReportLocation', requestId:reqs[0].id, denied:true }).then(function(){ toast('แจ้งชิปปิ้งแล้ว — ชิปปิ้งจะโทรหา'); home(); }); });
  };
  navigator.geolocation.getCurrentPosition(got, function(e){
    if(e && e.code===1) return fail(e);
    // แม่นยำหาไม่ทัน → ลองแบบเร็ว (เสาสัญญาณ / Wi-Fi)
    navigator.geolocation.getCurrentPosition(got, fail, { enableHighAccuracy:false, timeout:12000, maximumAge:120000 });
  }, { enableHighAccuracy:true, timeout:12000, maximumAge:30000 });
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
    '<b>ขั้นตอนงาน</b></p>'+guideList()+
    '<p style="font-size:14px"><b>หาตำแหน่งไม่ได้?</b><br>iPhone: ตั้งค่า → ความเป็นส่วนตัว → บริการหาตำแหน่ง → LINE → ขณะใช้งาน<br>Android: ตั้งค่า → แอป → LINE → สิทธิ์ → ตำแหน่ง → อนุญาต</p>'+
    '<p style="font-size:14px">ติดปัญหากับตู้ไหน กด <b>"แจ้งปัญหา"</b> ใต้ตู้นั้น ชิปปิ้งจะได้รับแจ้งทันที</p>'+
    '<button class="btn btn-navy" id="help-back">กลับไปงานของฉัน</button></div>';
  $('help-back').addEventListener('click', render);
}
