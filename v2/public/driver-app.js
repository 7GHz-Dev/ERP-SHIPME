/**
 * หน้าคนขับ (/driver) — เปิดจากปุ่มในข้อความ LINE OA (LIFF) หรือลิงก์ SMS (ช่องทางสำรอง)
 *
 * เข้าใช้งาน: LIFF ID token (ตรวจฝั่งเซิร์ฟเวอร์) / ?link=โค้ดผูก LINE / ?r=รหัสคำขอพิกัด (SMS) / ?s=session (DEMO)
 * ขั้นตอนของคนขับ (ทีละตู้) — ทำแค่ไม่กี่อย่าง:
 *   1) ได้รับข้อความ "คุณได้รับงาน" (LINE) → กดดูงาน
 *   2) รอชิปปิ้งนัดหมายรับการ์ด → นำทาง (แผนที่ในแอป) → "ถึงจุดรับการ์ดแล้ว" (บันทึกเวลา + ตำแหน่ง) → ชิปปิ้งกดแจกการ์ด
 *   3) ถ่ายรูปหน้ารถ / ท้ายรถ / ซีลตู้ → ยืนยันส่งงาน
 *   4) เข้า Fast Scan ภายใน 30 นาที กด "เข้า Fast Scan แล้ว" (ไม่ต้องรอผล X-Ray / เลยกำหนดเตือนทุก 5 นาที)
 *   5) รอชิปปิ้งนัดหมายรับ ER → นำทาง → "ถึงจุดรับ ER แล้ว" → รูปเอกสาร ER + ซีลตะกั่ว → ยืนยันส่งงาน = เสร็จสิ้น
 * ตำแหน่ง: ส่งเฉพาะตอนคนขับกดปุ่มเอง / ติดตามเฉพาะระหว่างเปิดแผนที่นำทางในแอป (ปิดแล้วหยุด) ไม่มีการติดตามเบื้องหลัง
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
  server_busy:'ระบบไม่ว่างชั่วคราว กรุณาลองใหม่อีกครั้ง',
  invite_invalid:'โค้ดผูก LINE ใช้ไม่ได้หรือหมดอายุ — ขอโค้ดใหม่จากชิปปิ้ง', open_in_line:'กรุณาเปิดลิงก์นี้ในแอป LINE',
  line_already_linked:'บัญชี LINE นี้ผูกกับคนขับคนอื่นแล้ว — ติดต่อชิปปิ้ง', not_linked:'บัญชี LINE นี้ยังไม่ได้ผูกกับงาน — ขอโค้ดผูก LINE จากชิปปิ้ง',
  link_invalid:'ลิงก์ไม่ถูกต้อง', link_expired:'ลิงก์หมดอายุแล้ว', session_expired:'หมดเวลา กรุณาเปิดลิงก์จากข้อความอีกครั้ง',
  card_first:'ต้องได้รับการ์ดรับตู้ก่อน', pickup_first:'ต้องกด "ส่งงานรับตู้" ก่อน', xray_first:'ต้องผ่าน X-Ray ก่อน',
  XRAY_BATCH_NOT_READY:'ยังรอตู้อื่นในกลุ่มผ่าน X-Ray', eir_first:'ต้องได้รับ EIR ก่อน', photos_required:'ต้องมีรูปเอกสาร ER และรูปซีลตะกั่ว',
  request_expired:'คำขอนี้หมดอายุแล้ว — รอชิปปิ้งส่งคำขอใหม่', forbidden:'ไม่ใช่งานของคุณ', already_completed:'ตู้นี้ส่งจบงานแล้ว',
  upload_missing:'อัปโหลดรูปไม่สำเร็จ ลองใหม่', file_too_large:'รูปใหญ่เกิน 10MB', line_not_configured:'ระบบ LINE ยังไม่พร้อม',
  invalid_id_token:'ยืนยันตัวตน LINE ไม่สำเร็จ ลองเปิดใหม่', no_credentials:'กรุณาเปิดจากลิงก์ในข้อความ',
  pickup_photos_required:'ต้องมีรูปหน้ารถ ท้ายรถ และซีลตู้ครบก่อน', scan_first:'ต้องกด "เข้า Fast Scan แล้ว" ก่อน',
  arrive_first:'ต้องกด "ถึงจุดรับ ER แล้ว" ก่อน', card_by_staff:'ชิปปิ้งเป็นคนบันทึกแจกการ์ด', meeting_closed:'นัดหมายนี้ปิดแล้ว',
  xray_result_pending:'ชิปปิ้งยังไม่บันทึกผล Fast Scan ของตู้นี้ — ระบบแจ้งชิปปิ้งแล้ว รอสักครู่แล้วกดอีกครั้ง หรือโทรหาชิปปิ้ง', pickup_submitted:'ส่งงานรับตู้แล้ว แก้รูปไม่ได้',
  xray_result_by_staff:'ผล Fast Scan ชิปปิ้งเป็นคนบันทึก — กด "เข้า Fast Scan แล้ว" เมื่อเข้าเสร็จ', bad_location:'ตำแหน่งไม่ถูกต้อง ลองใหม่'
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
      var el=document.querySelector('[data-meet="'+q.get('m')+'"]'); if(el){ el.scrollIntoView({ block:'center' }); el.style.boxShadow='0 0 0 3px #D4A044'; } }
  });
}

// ---------------- ขั้นตอนงาน (5 ขั้น — คนขับทำแค่ไม่กี่อย่าง) ----------------
var STEPS=['ได้รับงาน','รอชิปปิ้งนัดหมายรับการ์ด','ถ่ายรูปรับตู้','เข้า Fast Scan','รอชิปปิ้งนัดหมายรับ ER'];
var SCAN_MIN=30;     // ยืนยันส่งงานรับตู้แล้ว ต้องเข้า Fast Scan ภายในกี่นาที (เลยแล้วระบบเตือนทุก 5 นาที)
var ARRIVE_M=200;    // ห่างจุดนัดไม่เกินกี่เมตร ถึงขึ้นปุ่ม "ถึงจุด…แล้ว"
var GUIDE=[
  ['ได้รับข้อความรับงาน','SHIPME ส่งข้อความ "คุณได้รับงาน" ทาง LINE → กด "ดูงาน"'],
  ['รอชิปปิ้งนัดหมายรับการ์ด','ได้นัดแล้วกด "นำทางไปจุดนัดหมาย" ถึงแล้วกด "ถึงจุดรับการ์ดแล้ว"'],
  ['ถ่ายรูปรับตู้','รับตู้แล้วถ่ายรูปหน้ารถ ท้ายรถ ซีลตู้ → "ยืนยันส่งงาน"'],
  ['เข้า Fast Scan','เข้า Fast Scan ภายใน 30 นาทีหลังยืนยันส่งงาน แล้วกด "เข้า Fast Scan แล้ว"'],
  ['รอชิปปิ้งนัดหมายรับ ER','ได้นัดแล้วนำทางไปจุดนัดหมาย ถึงแล้วกด "ถึงจุดรับ ER แล้ว" → ถ่ายรูป ER + ซีลตะกั่ว → "ยืนยันส่งงาน"']
];
var FAST=['scanned','waiting','passed'];
/** 1 = รอนัดรับการ์ด / 2 = ถ่ายรูปรับตู้ / 3 = เข้า Fast Scan / 4 = รับ ER / 5 = เสร็จสิ้น (ขั้น 0 "ได้รับงาน" เสร็จเสมอ) */
function stepIndex(j){
  if(j.completedAt) return 5;
  if(j.pickedUpAt && FAST.indexOf(j.xrayStatus)>=0) return 4;
  if(j.pickedUpAt) return 3;
  if(j.cardHandedAt||j.cardAckAt) return 2;
  return 1;
}
/** นัดหมายที่ยังเปิดอยู่ของตู้นี้ในรอบนั้น */
function meetingOf(j, phase){
  return ((D.data&&D.data.meetings)||[]).filter(function(m){ return m.phase===phase && m.itemIds.indexOf(j.id)>=0; })[0] || null;
}
function distM(a, b){
  var R=6371000, r=Math.PI/180, dLat=(b.lat-a.lat)*r, dLng=(b.lng-a.lng)*r;
  var h=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dLng/2)*Math.sin(dLng/2);
  return 2*R*Math.asin(Math.sqrt(h));
}
function fmtDist(m){ return m>=1000 ? (m/1000).toFixed(1)+' กม.' : Math.round(m)+' ม.'; }
function cnList(list){ return list.map(function(j){ return j.containerNo||j.bl; }).join(', '); }
function xrayPointFor(j){
  var pts=(D.data&&D.data.xrayPoints)||[], port=String(j.port||'').toUpperCase();
  return pts.filter(function(p){ var pp=String(p.port||'').toUpperCase(); return pp && port && (pp===port || port.indexOf(pp)>=0 || pp.indexOf(port)>=0); })[0] || pts[0] || null;
}
/** ชิปปิ้งที่ดูแลตู้นี้ (ไว้กดโทร) */
function staffOf(j){
  var h=(D.data&&D.data.help)||[], u=String((j&&j.staff)||'').toLowerCase();
  return h.filter(function(s){ return String(s.username||'').toLowerCase()===u; })[0] || h[0] || null;
}
function callBtn(j){
  var s=staffOf(j);
  if(s && s.phone) return '<a class="btn btn-call" href="tel:'+esc(s.phone)+'">📞 โทรหาชิปปิ้ง '+esc(s.name)+' • '+esc(s.phone)+'</a>';
  return '<div class="muted">ติดต่อชิปปิ้ง'+(s?' '+esc(s.name):'')+' (ยังไม่ได้ใส่เบอร์โทรในระบบ)</div>';
}
function scanDeadline(j){ return new Date(Date.parse(j.pickedUpAt)+SCAN_MIN*60000); }
function deadlineText(iso){
  var left=Math.round((Date.parse(iso)-Date.now())/60000);
  return left>=0 ? 'เหลือเวลาอีก '+left+' นาที (ภายใน '+hm(iso)+')' : 'เลยกำหนดมาแล้ว '+(-left)+' นาที — ระบบจะเตือนทุก 5 นาทีจนกว่าจะกด';
}

/** สิ่งที่คนขับต้องทำตอนนี้ (แสดงบนสุด) — ขั้นของตู้ที่ช้าที่สุดในงานวันแรก */
function nextTodo(d){
  if(d.requests.length) return { step:2, title:'ส่งตำแหน่งให้ชิปปิ้ง', text:'กดปุ่มสีเขียว "ส่งตำแหน่งตอนนี้" ครั้งเดียว', target:'[data-req]' };
  var open=d.jobs.filter(function(j){ return !j.completedAt; });
  if(!d.jobs.length) return { wait:true, title:'รอชิปปิ้งส่งงานให้คุณ', text:'เมื่อมีงาน SHIPME จะส่งข้อความ LINE มาให้' };
  if(!open.length) return { done:true, title:'งานของคุณเสร็จสิ้นแล้ว', text:'ส่งงานครบทุกตู้แล้ว ขอบคุณครับ' };
  var date=open[0].inspectDate, list=open.filter(function(j){ return j.inspectDate===date; });
  var idx=Math.min.apply(null, list.map(stepIndex)), on=list.filter(function(j){ return stepIndex(j)===idx; });
  var t, m;
  if(idx===1){ m=meetingOf(on[0], 'CARD_PICKUP');
    t = !m ? { title:'รอชิปปิ้งนัดหมายรับการ์ด', text:'', wait:true }
      : (m.arrivedAt ? { title:'ถึงจุดรับการ์ดแล้ว', text:'รอชิปปิ้งแจกการ์ด', wait:true } : { title:'ไปจุดรับการ์ด', text:'กด "นำทางไปจุดนัดหมาย" ถึงแล้วกด "ถึงจุดรับการ์ดแล้ว"' }); }
  else if(idx===2) t={ title:'ถ่ายรูปรับตู้', text:'ถ่ายรูปหน้ารถ ท้ายรถ และซีลตู้ แล้วกด "ยืนยันส่งงาน"' };
  else if(idx===3){ var dl=scanDeadline(on[0]); t={ title:'เข้า Fast Scan', text:'เข้าแล้วกด "เข้า Fast Scan แล้ว" — '+deadlineText(dl.toISOString()), warn:Date.now()>dl.getTime() }; }
  else { m=meetingOf(on[0], 'EIR_HANDOVER');
    t = (m && m.arrivedAt) || on[0].eirHandedAt ? { title:'ถ่ายรูป ER และซีลตะกั่ว', text:'ถ่ายรูปแล้วกด "ยืนยันส่งงาน"' }
      : (!m ? { title:'รอชิปปิ้งนัดหมายรับ ER', text:'', wait:true } : { title:'ไปจุดรับ ER', text:'กด "นำทางไปจุดนัดหมาย" ถึงแล้วกด "ถึงจุดรับ ER แล้ว"' }); }
  t.step=idx+1; t.cns=cnList(on); t.target='[data-job="'+on[0].id+'"]';
  t.date=date;
  return t;
}
function todoCard(t){
  var cls=t.done?'done':(t.warn?'warn':(t.wait?'wait':''));
  return '<div class="todo '+cls+'"'+(t.target?' data-goto="'+esc(t.target)+'"':'')+'>'+
    (t.step?'<div class="todo-step">ขั้นตอนที่ '+t.step+' จาก 5 • '+esc(STEPS[t.step-1])+'</div>':'<div class="todo-step">สถานะงาน</div>')+
    '<div class="todo-title">'+(t.done?'✅ ':(t.wait?'⏳ ':(t.warn?'⚠️ ':'👉 ')))+esc(t.title)+'</div>'+
    (t.text?'<div class="todo-text">'+esc(t.text)+'</div>':'')+
    (t.cns?'<div class="todo-cn"><span>📅 '+thd(t.date)+'</span><b>'+esc(t.cns)+'</b></div>':'')+
    (t.step?'<div class="todo-bar">'+STEPS.map(function(s,i){ return '<i class="'+(i<t.step-1?'d':(i===t.step-1?'n':''))+'"></i>'; }).join('')+'</div>':'')+'</div>';
}
function guideList(){
  return '<ol class="guide">'+GUIDE.map(function(g){ return '<li><b>'+esc(g[0])+'</b><span>'+esc(g[1])+'</span></li>'; }).join('')+'</ol>';
}

// ---------------- งานของฉัน ----------------
function render(){
  var d=D.data, html='';
  // ไม่มีตู้ในหน้าจอ แต่มีคำขอตำแหน่ง/นัดหมาย = ยังต้องแสดงปุ่มให้กด (ห้ามซ่อนด้วยหน้า "ยังไม่มีงาน")
  if(!d.jobs.length && !d.requests.length && !(d.meetings||[]).length){
    html='<div class="todo wait"><div class="todo-step">ตอนนี้</div><div class="todo-title">⏳ รอชิปปิ้งส่งงานให้คุณ</div>'+
      '<div class="todo-text">ยังไม่มีตู้ที่ต้องทำ — เมื่อมีงาน SHIPME จะส่งข้อความ LINE มาให้</div></div>'+
      '<div class="card"><b>ขั้นตอนงาน</b>'+guideList()+
      '<div class="muted">เปิดแจ้งเตือน LINE ของ SHIPME ไว้ จะได้ไม่พลาดข้อความ</div></div>';
    $('main').innerHTML=html; bindCommon(); return;
  }
  html+=todoCard(nextTodo(d));
  d.requests.forEach(function(r){
    var jobs=d.jobs.filter(function(j){ return r.itemIds.indexOf(j.id)>=0; });
    html+='<div class="card req" data-reqcard="'+esc(r.id)+'"><h3>'+(r.phase==='CARD_PICKUP'?'📍 ชิปปิ้งขอตำแหน่ง — นัดแจกการ์ดรับตู้':'📍 ชิปปิ้งขอตำแหน่ง — นัดรับ EIR ออกท่า')+'</h3>'+
      '<div class="muted">'+jobs.length+' ตู้: '+esc(cnList(jobs))+' • ส่งได้ถึง '+hm(r.expiresAt)+'</div>'+
      '<button class="btn btn-green" style="margin-top:10px" data-req="'+esc(r.id)+'">📍 ส่งตำแหน่งตอนนี้</button>'+
      '<div class="loc-st hidden"></div></div>';
  });
  d.jobs.forEach(function(j){
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
    b.disabled=true;
    api({ action:'driverMeeting', meetingId:b.getAttribute('data-mres'), accept:true }).then(function(r){
      b.disabled=false; if(!r.ok){ toast(errText(r)); return; } toast('รับนัดหมายแล้ว ✓'); home();
    });
  }); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'), function(b){ b.addEventListener('click', function(){
    var m=(d.meetings||[]).filter(function(x){ return x.id===b.getAttribute('data-nav'); })[0]; if(!m) return;
    openNav({ lat:m.lat, lng:m.lng, label:m.label, meetingId:m.id, what:m.phase==='CARD_PICKUP'?'จุดรับการ์ด':'จุดรับ ER' });
  }); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-navpt]'), function(b){ b.addEventListener('click', function(){
    var p=(d.xrayPoints||[]).filter(function(x){ return x.id===b.getAttribute('data-navpt'); })[0]; if(!p) return;
    openNav({ lat:p.lat, lng:p.lng, label:'Fast Scan'+(p.name?' • '+p.name:'') });
  }); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-arrive]'), function(b){ b.addEventListener('click', function(){ arrive(b.getAttribute('data-arrive'), D.lastPos, b); }); });
  Array.prototype.forEach.call(document.querySelectorAll('input[data-up]'), function(inp){ inp.addEventListener('change', function(){ upload(inp); }); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-del]'), function(b){ b.addEventListener('click', function(){ delPhoto(b.getAttribute('data-del')); }); });
}
function bindCommon(){
  var t=document.querySelector('[data-goto]');
  if(t) t.addEventListener('click', function(){ var el=document.querySelector(t.getAttribute('data-goto')); if(el){ el.scrollIntoView({ behavior:'smooth', block:'start' }); el.classList.add('flash'); setTimeout(function(){ el.classList.remove('flash'); }, 1600); } });
  if($('go-help')) $('go-help').addEventListener('click', renderHelp);
}
// ชิปปิ้งบันทึกแจกการ์ด / ส่งนัดหมาย → หน้าคนขับเปลี่ยนขั้นเอง (เช็กทุก 30 วินาที วาดใหม่เฉพาะเมื่อสถานะเปลี่ยน
// ไม่วาดระหว่างเปิดแผนที่ / อัปรูป จะได้ไม่ขัดจังหวะ)
function stateKey(d){
  return JSON.stringify([(d.jobs||[]).map(function(j){ return [j.id, stepIndex(j), (j.evidence||[]).length]; }),
    (d.meetings||[]).map(function(m){ return [m.id, m.status, m.arrivedAt]; }), (d.requests||[]).map(function(r){ return r.id; })]);
}
function poll(){
  if(document.hidden || D.nav || D.uploading || !D.session || !D.data) return;
  api({ action:'driverHome' }).then(function(res){
    if(!res.ok || D.nav || D.uploading) return;
    if(stateKey(res)!==stateKey(D.data)){ D.data=res; render(); }
  }).catch(function(){});
}
setInterval(poll, 30000);
document.addEventListener('visibilitychange', function(){ if(!document.hidden) poll(); });

// นับเวลาถอยหลัง Fast Scan บนหน้าจอ (อัปเดตเฉพาะตัวเลข ไม่วาดหน้าใหม่ — กันช่องเลือกรูปหลุดระหว่างถ่าย)
setInterval(function(){
  Array.prototype.forEach.call(document.querySelectorAll('[data-deadline]'), function(el){
    var iso=el.getAttribute('data-deadline'), late=Date.now()>Date.parse(iso);
    el.textContent=deadlineText(iso); el.parentNode.className='note '+(late?'err':'wait');
  });
}, 20000);

/** ช่องรูป: กด + เพื่อถ่าย/เลือกรูป */
function photoSlot(j, kind, n, label){
  var list=j.evidence.filter(function(e){ return e.kind===kind; }), id=esc(j.id);
  return '<div class="slot'+(list.length?' has':'')+'"><b>'+n+'. '+label+'</b><div class="ph">'+list.map(function(e){
    return '<div><img src="'+esc(e.url)+'" alt="'+label+'"><button data-del="'+esc(e.id)+'" title="ลบ">✕</button></div>'; }).join('')+'</div>'+
    '<label class="plus" aria-label="เพิ่มรูป '+label+'">'+(list.length?'＋ เพิ่ม':'＋')+'<input type="file" accept="image/*" capture="environment" hidden data-up="'+kind+'" data-id="'+id+'"></label></div>';
}
function hasKinds(j, kinds){ return kinds.every(function(k){ return j.evidence.some(function(e){ return e.kind===k; }); }); }

/** นัดหมาย: ปุ่มนำทาง (แผนที่ในแอป) → ใกล้จุดนัดแล้วขึ้นปุ่ม "ถึงจุด…แล้ว" (บันทึกเวลา + ตำแหน่ง) */
function arriveLabel(what){ return 'ถึง'+what+(/[A-Za-z]$/.test(what)?' ':'')+'แล้ว'; }
function meetingNav(m, what){
  if(m.arrivedAt) return '<div class="note ok" data-meet="'+esc(m.id)+'">📍 '+arriveLabel(what)+' '+hm(m.arrivedAt)+'</div>';
  var near=D.lastPos && m.lat!=null && distM(D.lastPos, { lat:m.lat, lng:m.lng })<=ARRIVE_M+Math.min(D.lastPos.acc||0, 100);
  return '<div data-meet="'+esc(m.id)+'"><div class="kv"><span>จุดนัดหมาย</span><b>'+esc(m.label)+'</b></div>'+
    (m.note?'<div class="note wait">'+esc(m.note)+'</div>':'')+
    '<button class="btn btn-navy" style="margin-top:8px" data-nav="'+esc(m.id)+'">🧭 นำทางไปจุดนัดหมาย</button>'+
    (near?'<button class="btn btn-green" style="margin-top:8px" data-arrive="'+esc(m.id)+'">📍 '+arriveLabel(what)+'</button>':'')+'</div>';
}
function stepBody(j, idx){
  var id=esc(j.id), m;
  if(idx===1){ m=meetingOf(j, 'CARD_PICKUP'); return m ? meetingNav(m, 'จุดรับการ์ด') : ''; }
  if(idx===2){
    var ready=hasKinds(j, ['TRUCK_FRONT_PHOTO','TRUCK_REAR_PHOTO','PICKUP_SEAL_PHOTO']);
    return '<div class="slots three">'+photoSlot(j,'TRUCK_FRONT_PHOTO',1,'หน้ารถ')+photoSlot(j,'TRUCK_REAR_PHOTO',2,'ท้ายรถ')+photoSlot(j,'PICKUP_SEAL_PHOTO',3,'ซีลตู้')+'</div>'+
      (ready ? '<button class="btn btn-green" data-op="picked-up" data-id="'+id+'">✅ ยืนยันส่งงาน</button><div class="muted" style="margin-top:6px">หลังกดยืนยัน ต้องไปเข้า Fast Scan ภายใน 30 นาที</div>'
             : '<div class="muted">ส่งรูปครบ 3 รูปแล้วจะมีปุ่ม "ยืนยันส่งงาน"</div>');
  }
  if(idx===3){
    var p=xrayPointFor(j), dl=scanDeadline(j).toISOString(), late=Date.now()>Date.parse(dl);
    return '<div class="note '+(late?'err':'wait')+'">⏱️ ต้องเข้า Fast Scan ภายใน 30 นาที — <span data-deadline="'+dl+'">'+esc(deadlineText(dl))+'</span></div>'+
      (p?'<button class="btn btn-navy" data-navpt="'+esc(p.id)+'">🧭 นำทางไป Fast Scan</button>':'')+
      '<button class="btn btn-green" style="margin-top:8px" data-op="xray" data-status="scanned" data-id="'+id+'">🛃 เข้า Fast Scan แล้ว</button>';
  }
  if(idx===4){
    m=meetingOf(j, 'EIR_HANDOVER');
    // ถ่ายรูปได้เมื่อกด "ถึงจุดรับ ER แล้ว" หรือชิปปิ้งบันทึกส่งมอบ ER แล้ว
    var open=(m && m.arrivedAt) || j.eirHandedAt;
    if(!open) return m ? meetingNav(m, 'จุดรับ ER') : '';
    var ok=hasKinds(j, ['EIR_CARD_PHOTO','CONTAINER_SEAL_PHOTO']);
    return (m && m.arrivedAt ? meetingNav(m, 'จุดรับ ER') : '<div class="note ok">📄 ได้รับ ER แล้ว '+hm(j.eirHandedAt)+'</div>')+
      '<div class="slots">'+photoSlot(j,'EIR_CARD_PHOTO',1,'เอกสาร ER')+photoSlot(j,'CONTAINER_SEAL_PHOTO',2,'ซีลตะกั่ว')+'</div>'+
      (ok ? '<button class="btn btn-green" data-op="complete" data-id="'+id+'">✅ ยืนยันส่งงาน</button>'
          : '<div class="muted">ส่งรูปครบ 2 รูปแล้วจะมีปุ่ม "ยืนยันส่งงาน"</div>');
  }
  return '';
}
function stepDone(j, i){
  if(i===0) return 'ได้รับงานแล้ว';
  if(i===1) return j.cardHandedAt?'ได้การ์ดแล้ว '+hm(j.cardHandedAt):'ได้การ์ดแล้ว';
  if(i===2) return 'ส่งรูปแล้ว '+hm(j.pickedUpAt);
  if(i===3) return 'เข้า Fast Scan แล้ว';
  return 'ส่งงานแล้ว '+hm(j.completedAt);
}
function jobCard(j){
  var idx=stepIndex(j), id=esc(j.id);
  // หัวการ์ด: เน้นวันที่งาน + เลขตู้ (ข้อมูลที่คนขับใช้ยืนยันกับชิปปิ้ง / ท่า)
  var head='<div class="jhead"><div class="jdate">📅 งานวันที่ '+thd(j.inspectDate)+(j.inspectDate===(D.data&&D.data.today)?' <em>วันนี้</em>':'')+'</div>'+
    '<div class="jcn"><small>เลขตู้</small>'+esc(j.containerNo||j.bl)+'</div>'+
    '<div class="muted">BL '+esc(j.bl)+' • ท่า '+esc(j.port||'-')+(j.destination?' → '+esc(j.destination):'')+'</div></div>';
  if(idx===5){
    return '<div class="card done-card" data-job="'+id+'">'+head+'<div class="finished">✅ งานของคุณเสร็จสิ้นแล้ว<small>ส่งงานเมื่อ '+hm(j.completedAt)+' • ขอบคุณครับ</small></div></div>';
  }
  var steps=STEPS.map(function(t, i){
    var st=i<idx?'done':(i===idx?'now':'later'), body=i===idx?stepBody(j, idx):'';
    return '<div class="st '+st+'"><div class="st-h"><i>'+(i<idx?'✓':(i+1))+'</i><b>'+esc(t)+'</b>'+(i<idx?'<span>'+esc(stepDone(j,i))+'</span>':'')+'</div>'+
      (body?'<div class="st-b">'+body+'</div>':'')+'</div>';
  }).join('');
  return '<div class="card" data-job="'+id+'">'+head+'<div class="steps">'+steps+'</div><button class="link" data-op="problem" data-id="'+id+'">แจ้งปัญหา</button></div>';
}

// ---------------- แผนที่นำทางในแอป (ไม่ต้องออกไป Google Maps) ----------------
function loadMaps(cb){
  if(window.google && google.maps && google.maps.geometry) return cb();
  (D.mapsCbs=D.mapsCbs||[]).push(cb);
  if(D.mapsLoading) return;
  D.mapsLoading=true;
  window.__drvMaps=function(){ (D.mapsCbs||[]).splice(0).forEach(function(f){ try{ f(); }catch(e){} }); };
  var sc=document.createElement('script');
  sc.src='https://maps.googleapis.com/maps/api/js?key='+encodeURIComponent((D.cfg&&D.cfg.mapsKey)||'')+'&callback=__drvMaps&loading=async&libraries=geometry&language=th&region=TH';
  sc.async=true; sc.onerror=function(){ D.mapsLoading=false; var n=$('nav-msg'); if(n) n.textContent='โหลดแผนที่ไม่สำเร็จ — เช็กอินเทอร์เน็ต'; };
  document.head.appendChild(sc);
}
/**
 * o = { lat, lng, label, meetingId?, what? } — meetingId = นัดหมาย (มีปุ่ม "ถึงจุด…แล้ว" เมื่อเข้าใกล้)
 * ติดตามตำแหน่งเฉพาะตอนเปิดหน้านี้ ปิดแล้วหยุดทันที
 */
function openNav(o){
  closeNav();
  var v=document.createElement('div'); v.id='nav'; v.className='nav-view';
  v.innerHTML='<div class="nav-top"><button id="nav-x" aria-label="ปิด">✕</button><div class="grow"><b>'+esc(o.label||'จุดหมาย')+'</b><span id="nav-eta"></span></div></div>'+
    '<div id="nav-map" class="nav-map"><div class="center" style="color:#475569">กำลังโหลดแผนที่…</div></div>'+
    '<div class="nav-panel"><div id="nav-msg" class="nav-msg">กำลังหาตำแหน่งของคุณ…</div>'+
    (o.meetingId?'<button class="btn btn-green hidden" id="nav-arrive">📍 '+esc(arriveLabel(o.what))+'</button>':'')+'</div>';
  document.body.appendChild(v); document.body.style.overflow='hidden';
  $('nav-x').addEventListener('click', function(){ closeNav(); render(); });
  var dest={ lat:o.lat, lng:o.lng }, st={ me:null, acc:null, line:null, routeAt:0, routeFrom:null, map:null, fitted:false, pos:null };
  D.nav=st;
  if(o.meetingId) $('nav-arrive').addEventListener('click', function(){ arrive(o.meetingId, st.pos, this); });
  var msg=function(t){ var n=$('nav-msg'); if(n) n.textContent=t; };
  var draw=function(){
    if(!st.map || !st.pos) return;
    var p={ lat:st.pos.lat, lng:st.pos.lng };
    if(!st.me){
      st.me=new google.maps.Marker({ map:st.map, position:p, zIndex:9, icon:{ path:google.maps.SymbolPath.CIRCLE, scale:9, fillColor:'#1a73e8', fillOpacity:1, strokeColor:'#fff', strokeWeight:3 } });
      st.acc=new google.maps.Circle({ map:st.map, center:p, radius:st.pos.acc||0, fillColor:'#1a73e8', fillOpacity:.12, strokeWeight:0, clickable:false });
    } else { st.me.setPosition(p); st.acc.setCenter(p); st.acc.setRadius(st.pos.acc||0); }
    if(!st.fitted){ var b=new google.maps.LatLngBounds(); b.extend(p); b.extend(dest); st.map.fitBounds(b, 60); st.fitted=true; }
    // เส้นทางจริงจาก Google Routes — ขอใหม่เมื่อขยับไกลกว่า 300 ม. และห่างครั้งก่อน 1 นาที
    if(!st.routeFrom || (distM(st.routeFrom, p)>300 && Date.now()-st.routeAt>60000)){
      st.routeFrom=p; st.routeAt=Date.now();
      api({ action:'driverRoute', fromLat:p.lat, fromLng:p.lng, toLat:dest.lat, toLng:dest.lng }).then(function(r){
        if(!st.map || !r || !r.ok) return;
        if(st.line) st.line.setMap(null);
        var path=r.polyline ? google.maps.geometry.encoding.decodePath(r.polyline) : [p, dest];
        st.line=new google.maps.Polyline({ map:st.map, path:path, strokeColor:r.polyline?'#1a73e8':'#64748b', strokeOpacity:r.polyline?.9:.6, strokeWeight:r.polyline?6:3 });
        var eta=$('nav-eta'); if(eta) eta.textContent=r.durationSec ? ' • ขับรถ ~'+Math.max(1, Math.round(r.durationSec/60))+' นาที ('+fmtDist(r.distanceM)+')' : '';
      }).catch(function(){});
    }
  };
  var onPos=function(g){
    st.pos={ lat:g.coords.latitude, lng:g.coords.longitude, acc:Math.round(g.coords.accuracy||0) };
    D.lastPos=st.pos;
    var d=distM(st.pos, dest), near=d<=ARRIVE_M+Math.min(st.pos.acc||0, 100);
    msg(near ? 'ถึงจุดหมายแล้ว'+(o.meetingId?' — กดปุ่มด้านล่าง':'') : 'อีก '+fmtDist(d)+' ถึงจุดหมาย');
    var btn=$('nav-arrive'); if(btn) btn.classList.toggle('hidden', !near);
    draw();
  };
  var onErr=function(e){
    msg(e && e.code===1 ? 'ไม่ได้อนุญาตให้ใช้ตำแหน่ง — เปิดสิทธิ์ตำแหน่งของ LINE แล้วลองใหม่' : 'หาตำแหน่งไม่ได้ — เปิด GPS แล้วลองใหม่');
    // หาตำแหน่งไม่ได้จริง ๆ ก็ยังกดถึงจุดได้ (บันทึกเวลา ไม่มีตำแหน่ง) จะได้ไม่ติดอยู่ขั้นนี้
    var btn=$('nav-arrive'); if(btn) btn.classList.remove('hidden');
  };
  if(navigator.geolocation) st.watch=navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy:true, maximumAge:5000, timeout:20000 });
  else onErr();
  if(!(D.cfg&&D.cfg.mapsKey)){ $('nav-map').innerHTML='<div class="center">ยังไม่ได้ตั้งค่าแผนที่ — เดินทางไปที่ '+esc(o.label||'')+'</div>'; return; }
  loadMaps(function(){
    if(D.nav!==st) return;
    var box=$('nav-map'); box.innerHTML='';
    st.map=new google.maps.Map(box, { center:dest, zoom:15, disableDefaultUI:true, zoomControl:true, gestureHandling:'greedy', clickableIcons:false });
    new google.maps.Marker({ map:st.map, position:dest, title:o.label });
    draw();
  });
}
function closeNav(){
  var st=D.nav; D.nav=null;
  if(st && st.watch!=null && navigator.geolocation) navigator.geolocation.clearWatch(st.watch);
  var v=$('nav'); if(v) v.remove();
  document.body.style.overflow='';
}
function arrive(meetingId, pos, btn){
  if(btn) btn.disabled=true;
  var send=function(p){
    api({ action:'driverArrive', meetingId:meetingId, lat:p?p.lat:null, lng:p?p.lng:null, accuracy:p?p.acc:null }).then(function(r){
      if(!r.ok){ if(btn) btn.disabled=false; toast(errText(r), 3500); return; }
      toast('บันทึกเวลาถึงจุดนัดหมายแล้ว ✓', 3000); closeNav(); home();
    }).catch(function(){ if(btn) btn.disabled=false; toast('เชื่อมต่อไม่ได้ ลองใหม่'); });
  };
  if(pos) return send(pos);
  // กดจากหน้างาน (ไม่ได้เปิดแผนที่) — ขอตำแหน่งครั้งเดียวก่อนบันทึก
  if(!navigator.geolocation) return send(null);
  navigator.geolocation.getCurrentPosition(function(g){ send({ lat:g.coords.latitude, lng:g.coords.longitude, acc:Math.round(g.coords.accuracy||0) }); },
    function(){ send(null); }, { enableHighAccuracy:true, timeout:12000, maximumAge:30000 });
}

function step(b){
  var op=b.getAttribute('data-op'), itemId=b.getAttribute('data-id');
  if(D.busy[itemId]) return;
  var payload={ action:'driverStep', op:op, itemId:itemId };
  if(op==='complete') payload={ action:'driverComplete', itemId:itemId };
  if(op==='xray'){ payload.status=b.getAttribute('data-status');
    if(payload.status==='hold'){ var n=prompt('ติดปัญหาอะไรที่ Fast Scan (ไม่บังคับ)'); if(n===null) return; payload.note=n; } }
  if(op==='problem'){ var note=prompt('แจ้งปัญหาให้ชิปปิ้งทราบ'); if(!note) return; payload.note=note; }
  if(op==='picked-up' && !confirm('ยืนยันส่งงานรับตู้?\nหลังยืนยัน ต้องไปเข้า Fast Scan ภายใน 30 นาที (ส่งแล้วแก้รูปไม่ได้)')) return;
  if(op==='complete' && !confirm('ยืนยันส่งงาน? ได้รับ ER และรูปเอกสาร ER + ซีลตะกั่วถูกต้องแล้ว')) return;
  D.busy[itemId]=true; b.disabled=true;
  api(payload).then(function(res){
    D.busy[itemId]=false;
    if(!res.ok){ b.disabled=false; toast(errText(res), 4500); return; }
    toast(op==='complete'?'งานของคุณเสร็จสิ้นแล้ว ✓':(op==='picked-up'?'ส่งงานรับตู้แล้ว ✓ ไปเข้า Fast Scan ภายใน 30 นาที':(op==='xray'&&payload.status==='scanned'?'บันทึกแล้ว ✓ ต่อไป: รอชิปปิ้งนัดหมายรับ ER':'บันทึกแล้ว ✓')), 3500);
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
  D.uploading=true;
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
    D.uploading=false; toast('อัปโหลดรูปแล้ว ✓'); home();
  }).catch(function(e){ D.uploading=false; toast(e.message||'อัปโหลดไม่สำเร็จ', 3500); });
}
function delPhoto(id){
  if(!confirm('ลบรูปนี้?')) return;
  api({ action:'driverEvidenceDelete', id:id }).then(function(res){ if(!res.ok){ toast(errText(res)); return; } home(); });
}


// ---------------- ช่วยเหลือ ----------------
function renderHelp(){
  var d=D.data, staff=(d.help||[]).map(function(s){ return esc(s.name)+(s.phone?' <a href="tel:'+esc(s.phone)+'">📞 '+esc(s.phone)+'</a>':''); }).join('<br>');
  $('main').innerHTML='<div class="card"><h3 style="margin:0 0 8px">☎️ ช่วยเหลือ</h3>'+
    (staff?'<div class="kv"><span>ชิปปิ้งที่ดูแลงานคุณ</span><b>'+staff+'</b></div>':'')+
    '<p style="font-size:14.5px;line-height:1.7">'+
    '<b>ขั้นตอนงาน</b></p>'+guideList()+
    '<p style="font-size:14px"><b>หาตำแหน่งไม่ได้?</b><br>iPhone: ตั้งค่า → ความเป็นส่วนตัว → บริการหาตำแหน่ง → LINE → ขณะใช้งาน<br>Android: ตั้งค่า → แอป → LINE → สิทธิ์ → ตำแหน่ง → อนุญาต</p>'+
    '<p style="font-size:14px">ติดปัญหากับตู้ไหน กด <b>"แจ้งปัญหา"</b> ใต้ตู้นั้น ชิปปิ้งจะได้รับแจ้งทันที</p>'+
    '<button class="btn btn-navy" id="help-back">กลับไปงานของฉัน</button></div>';
  $('help-back').addEventListener('click', render);
}
