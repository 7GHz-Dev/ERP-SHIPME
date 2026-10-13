/**
 * หน้าชิปปิ้ง (/staff) — ใช้บนมือถือ เปิดจาก LINE หรือเบราว์เซอร์ก็ได้ (ใช้ล็อกอินเดียวกับหน้าเข้างาน)
 *
 * แผนงาน: งานในแพลนที่ผู้จัดการ Confirm แล้ว + ความคืบหน้า + ปุ่มขั้นถัดไป
 * แผนที่: ขอพิกัดรอบแรก (การ์ดรับตู้) / รอบสอง (EIR — เปิดเมื่อทุกตู้ผ่าน X-Ray) + หมุดคนขับ
 * สถานะงาน: บันทึกแจกการ์ด / ส่งมอบ EIR ทีละตู้ + ติดตามรูป EIR และ Seal
 * เพิ่มเติม: ผูก LINE คนขับ, จำลองแชท LINE (DEMO), กลับหน้าหลัก
 */
var S = { token:null, user:null, data:null, tab:'plan', phase:'CARD_PICKUP', mapMode:'map', date:'', staff:'', gmap:null, markers:[], mapsLoading:false, timer:null };

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function api(p){ p.token=S.token; return fetch('/api',{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify(p)}).then(function(r){ return r.json(); }); }
function toast(m,ms){ var t=$('toast'); t.textContent=m; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t=setTimeout(function(){ t.classList.add('hidden'); }, ms||2600); }
function hm(iso){ if(!iso) return ''; var d=new Date(iso); return isNaN(d)?'':String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
var TH_M=['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
function thd(ymd){ var p=String(ymd||'').split('-'); return p.length===3 ? (+p[2])+' '+TH_M[+p[1]-1]+' '+String(+p[0]+543).slice(2) : ''; }
function ago(min){ return min<1?'เมื่อสักครู่':(min<60?min+' นาทีที่แล้ว':Math.floor(min/60)+' ชม. '+(min%60)+' นาทีที่แล้ว'); }

var ERR = {
  server_busy:'ระบบไม่ว่างชั่วคราว กรุณาลองใหม่อีกครั้ง',
  XRAY_BATCH_NOT_READY:'ยังมีตู้ที่ไม่ผ่าน X-Ray ครบทุกงาน', plan_not_confirmed:'แพลนวันนี้ยังไม่ได้ Confirm', no_recipients:'ไม่มีคนขับที่ส่งได้',
  forbidden:'ไม่มีสิทธิ์', bad_date:'วันที่ไม่ถูกต้อง', demo_only:'ใช้ได้เฉพาะ DEMO MODE', session_expired:'หมดเวลา กรุณาเข้าสู่ระบบใหม่',
  invalid_token:'กรุณาเข้าสู่ระบบใหม่', no_token:'กรุณาเข้าสู่ระบบ', not_scanned:'มีตู้ที่คนขับยังไม่กด "เข้า Fast Scan แล้ว"'
};
function errText(res){ return ERR[res.error]||res.error||'ไม่สำเร็จ'; }

var STAGE = {
  PLANNED:['รอการ์ด',''], CARD_HANDED:['ไปรับตู้','blue'], PICKED_UP:['ไป Fast Scan','blue'], XRAY_SCANNED:['เข้า Fast Scan แล้ว','ok'], XRAY_WAITING:['เข้า Fast Scan แล้ว','ok'],
  XRAY_HOLD:['ติดปัญหา Fast Scan','bad'], XRAY_PASSED:['เข้า Fast Scan แล้ว','ok'], EIR_HANDED:['ส่ง EIR แล้ว • รอคนขับยืนยัน','ok'],
  EIR_RECEIVED:['รอรูปจบงาน','wait'], DONE:['จบงาน ✓','ok']
};
function stageChip(st){ var s=STAGE[st]||[st,'']; return '<span class="stage '+s[1]+'">'+esc(s[0])+'</span>'; }

/** ขั้นของตู้ในมุมชิปปิ้ง (ใช้ทำแถบสรุป + กรอง) */
var BUCKETS=[['card','🎫','รอแจกการ์ด'],['pickup','🚚','ไปรับตู้'],['xray','🛃','ไป Fast Scan'],['eir','📄','รอนัด/ส่ง EIR'],['photo','📷','รอรูป ER'],['done','✅','จบงาน']];
var FAST=['scanned','waiting','passed'];
function scanned(i){ var s=i.step||{}; return !!s.pickedUpAt && FAST.indexOf(s.xrayStatus)>=0; }
function bucket(i){
  var s=i.step||{};
  if(s.completedAt) return 'done';
  if(scanned(i)) return arrivedEir(i) || s.eirHandedAt ? 'photo' : 'eir';
  if(s.pickedUpAt) return 'xray';
  if(s.cardHandedAt||s.cardAckAt) return 'pickup'; return 'card';
}
/** จัดกลุ่มตามเลข BL (เรียงตามลำดับในแพลน) */
function byBl(items){
  var map={}, order=[];
  items.forEach(function(i){ var k=i.bl||'(ไม่มี BL)'; if(!map[k]){ map[k]=[]; order.push(k); } map[k].push(i); });
  return order.map(function(k){ return { bl:k, items:map[k] }; });
}
/** งานที่ชิปปิ้งต้องกดของกลุ่มตู้นี้ */
function staffActions(list){
  return {
    card: list.filter(function(i){ return bucket(i)==='card'; }),
    eir: list.filter(function(i){ return scanned(i) && !(i.step||{}).eirHandedAt && !(i.step||{}).completedAt; })
  };
}
/** คนขับกด "ถึงจุดรับ ER แล้ว" ของตู้นี้หรือยัง */
function arrivedEir(i){
  return (S.data.meetings||[]).some(function(m){ return m.phase==='EIR_HANDOVER' && m.arrivedAt && m.status!=='CANCELLED' && m.itemIds.indexOf(i.id)>=0; });
}

// ---------------- เริ่มต้น ----------------
(function init(){
  try { var s=JSON.parse(localStorage.getItem('ci_sess')||'null'); if(s&&s.token){ S.token=s.token; S.user=s.user; } } catch(e){}
  if(!S.token){ location.href='/?next=staff'; return; }
  var q=new URLSearchParams(location.search);
  S.staff=q.get('staff')||''; S.date=q.get('date')||'';
  if(q.get('phase')==='EIR_HANDOVER') S.phase='EIR_HANDOVER';
  if(['plan','map','status','more'].indexOf(q.get('tab'))>=0) S.tab=q.get('tab');
  Array.prototype.forEach.call(document.querySelectorAll('nav.tabs button'), function(b){ b.addEventListener('click', function(){ go(b.getAttribute('data-tab')); }); });
  Array.prototype.forEach.call(document.querySelectorAll('#phase-seg button'), function(b){ b.addEventListener('click', function(){ S.phase=b.getAttribute('data-phase'); renderMap(); }); });
  Array.prototype.forEach.call(document.querySelectorAll('#mapmode-seg button'), function(b){ b.addEventListener('click', function(){ S.mapMode=b.getAttribute('data-mode'); renderMap(); }); });
  $('btn-refresh').addEventListener('click', function(){ load(); });
  $('dates').addEventListener('click', function(e){ var b=e.target.closest('[data-date]'); if(b){ S.date=b.getAttribute('data-date'); load(); } });
  document.addEventListener('visibilitychange', function(){ if(!document.hidden) load(true); });
  if(S.tab!=='plan') go(S.tab);
  load();
  S.timer=setInterval(function(){ if(!document.hidden && !document.querySelector('.sheet-bg')) load(true); }, 20000);
})();

function go(tab){
  S.tab=tab;
  ['plan','map','status','more'].forEach(function(t){ $('v-'+t).classList.toggle('hidden', t!==tab); });
  Array.prototype.forEach.call(document.querySelectorAll('nav.tabs button'), function(b){ b.classList.toggle('on', b.getAttribute('data-tab')===tab); });
  render(); window.scrollTo(0,0);
}

function load(quiet){
  return api({ action:'coordDashboard', date:S.date, staff:S.staff }).then(function(res){
    if(!res.ok){
      if(['session_expired','invalid_token','no_token'].indexOf(res.error)>=0){ toast(errText(res)); setTimeout(function(){ location.href='/'; }, 1200); return; }
      if(!quiet) $('plan-body').innerHTML='<div class="card center">'+esc(errText(res))+'</div>';
      return;
    }
    S.data=res; S.date=res.date;
    $('demo-bar').classList.toggle('hidden', res.lineMode!=='demo');
    $('hd-sub').textContent='Shipping Staff • '+(S.user&&S.user.name||res.username);
    render();
  }).catch(function(){ if(!quiet) toast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); });
}

function render(){
  if(!S.data) return;
  renderDates();
  if(S.tab==='plan') renderPlan();
  if(S.tab==='map') renderMap();
  if(S.tab==='status') renderStatus();
  if(S.tab==='more') renderMore();
}

function renderDates(){
  var d=S.data;
  $('plan-staff').textContent=thd(d.date);
  $('dates').innerHTML=(d.dates||[]).map(function(x){
    return '<button class="chip'+(x.date===d.date?' on':'')+'" data-date="'+x.date+'">'+(x.date===d.today?'วันนี้':thd(x.date))+'<small>'+x.containers+' ตู้</small></button>';
  }).join('') || '<span class="muted">ยังไม่มีงานที่ผู้จัดการ Confirm มา</span>';
}

// ---------------- ขั้นถัดไป (ปุ่มเด่น) ----------------
function hasRequests(phase){ return S.data.drivers.some(function(d){ return d.phases[phase].request; }); }
function filterTo(f){ S.filter=f; renderPlan(); var el=$('bls'); if(el) el.scrollIntoView({ behavior:'smooth', block:'start' }); }
/** ตู้ที่ยังต้องนัดหมายรอบนี้ (ยังไม่ส่งมอบ และยังไม่มีนัดที่เปิดอยู่) */
function needMeeting(phase){
  var d=S.data, open={};
  (d.meetings||[]).forEach(function(m){ if(m.phase===phase && ['PROPOSED','ACCEPTED','RESCHEDULE_REQUESTED','ARRIVED','MET'].indexOf(m.status)>=0) m.itemIds.forEach(function(i){ open[i]=1; }); });
  return d.items.filter(function(i){ var s=i.step||{};
    if(open[i.id] || !i.driverId) return false;
    return phase==='CARD_PICKUP' ? !(s.cardHandedAt||s.cardAckAt) : (scanned(i) && !s.eirHandedAt && !s.completedAt); });
}
function nextAction(){
  var d=S.data, c=d.counts;
  if(!c.jobs) return null;
  var unNotified=d.drivers.filter(function(x){ return x.itemIds.length && !x.notified; });
  if(unNotified.length) return { label:'📨 แจ้งงานให้คนขับ ('+unNotified.length+' คน)', fn:function(){ notifyJobs(); } };
  var nc=needMeeting('CARD_PICKUP');
  if(nc.length) return { label:'📅 ส่งนัดหมายรับการ์ดรับตู้ ('+nc.length+' ตู้)', fn:function(){ meetSheet('CARD_PICKUP'); } };
  var arr=arrivals();
  if(arr.length) return { label:'📍 คนขับถึงจุดนัดแล้ว '+arr.length+' คน — บันทึกส่งมอบ', fn:function(){ var el=$('arrivals'); if(el) el.scrollIntoView({ behavior:'smooth', block:'start' }); } };
  if(c.cardHanded<c.jobs) return { label:'🎫 บันทึกแจกการ์ดรับตู้ ('+c.cardHanded+'/'+c.jobs+')', fn:function(){ filterTo('card'); }, ghost:needMeeting('CARD_PICKUP').length===0 };
  if(c.pickedUp<c.jobs) return { label:'🚚 รอคนขับส่งรูปรับตู้ ('+c.pickedUp+'/'+c.jobs+')', fn:function(){ filterTo('pickup'); }, ghost:true };
  var ne=needMeeting('EIR_HANDOVER');
  if(ne.length) return { label:'📅 ส่งนัดหมายรับ EIR ออกท่า ('+ne.length+' ตู้)', fn:function(){ meetSheet('EIR_HANDOVER'); } };
  if(c.xrayScanned<c.jobs) return { label:'🛃 รอคนขับเข้า Fast Scan ('+c.xrayScanned+'/'+c.jobs+')', fn:function(){ filterTo('xray'); }, ghost:true };
  if(c.eirHanded<c.jobs) return { label:'📄 บันทึกส่งมอบ EIR ('+c.eirHanded+'/'+c.jobs+')', fn:function(){ filterTo('eir'); } };
  if(c.completed<c.jobs) return { label:'📷 รอคนขับส่งรูป ER ('+c.completed+'/'+c.jobs+')', fn:function(){ filterTo('photo'); }, ghost:true };
  return { label:'✅ จบงานครบทุกตู้แล้ว', fn:function(){ filterTo('all'); }, done:true };
}

// ---------------- แจ้งงานให้คนขับ (ข้อความแรก: "คุณได้รับงาน") ----------------
function notifyJobs(driverIds, resend){
  var d=S.data, targets=d.drivers.filter(function(x){ return x.itemIds.length && (driverIds ? driverIds.indexOf(x.id)>=0 : !x.notified); });
  if(!targets.length){ toast('แจ้งงานคนขับครบทุกคนแล้ว'); return; }
  var noLine=targets.filter(function(x){ return !x.linked; });
  if(!confirm('ส่งข้อความ "คุณได้รับงาน" ให้คนขับ '+targets.length+' คน?'+(noLine.length?'\n\nยังไม่ผูก LINE: '+noLine.map(function(x){ return x.name; }).join(', ')+(d.smsReady?' (ส่งทาง SMS)':' (ส่งไม่ได้ — ผูก LINE ก่อน)'):''))) return;
  api({ action:'coordNotifyJobs', date:d.date, staff:S.staff, driverIds:driverIds||undefined, resend:!!resend }).then(function(r){
    if(!r.ok){ toast(errText(r)); return; }
    toast('แจ้งงานแล้ว '+r.sent+' คน'+(r.failed?' • ส่งไม่ได้ '+r.failed+' คน (ยังไม่ผูก LINE)':''), 4000); load(true);
  });
}

// ---------------- ส่งนัดหมาย (เลือกจุดในระบบ หรือสร้างจุดใหม่) ----------------
function roundTime(min){ var t=new Date(Date.now()+min*60000); t.setMinutes(Math.ceil(t.getMinutes()/5)*5, 0, 0); return t; }
/**
 * ชิปปิ้งเลือกจุดนัดหมาย (จุดที่บันทึกไว้ / สร้างใหม่บนแผนที่) + เวลา + คนขับ → ส่งขอนัดหมายทาง LINE ทีละคน
 * คนขับกด "รับนัดหมาย" หรือไม่สะดวกก็โทรหาชิปปิ้ง
 */
function meetSheet(phase, onlyDriver){
  var d=S.data, eir=phase==='EIR_HANDOVER';
  var pending=needMeeting(phase), mps=(d.meetingPoints||[]).slice();
  var active={};
  (d.meetings||[]).forEach(function(m){ if(m.phase===phase && ['PROPOSED','ACCEPTED','RESCHEDULE_REQUESTED','ARRIVED'].indexOf(m.status)>=0) active[m.driverId]=m; });
  var rows=d.drivers.filter(function(x){ return x.itemIds.length && (!onlyDriver || x.id===onlyDriver); }).map(function(x){
    var items=d.items.filter(function(i){ return x.itemIds.indexOf(i.id)>=0 && (eir ? scanned(i) && !(i.step&&(i.step.eirHandedAt||i.step.completedAt)) : !(i.step&&(i.step.cardHandedAt||i.step.cardAckAt))); });
    return { x:x, items:items, m:active[x.id], pre: onlyDriver ? true : pending.some(function(p){ return x.itemIds.indexOf(p.id)>=0; }) };
  }).filter(function(r){ return r.items.length; });
  if(!rows.length){ toast(eir?'ยังไม่มีตู้ที่เข้า Fast Scan แล้ว (หรือส่งมอบ EIR ครบแล้ว)':'แจกการ์ดครบทุกตู้แล้ว', 3500); return; }
  var bg=sheet('<h3>📅 ส่งนัดหมาย'+(eir?'รับ EIR ออกท่า':'รับการ์ดรับตู้')+'</h3>'+
    '<label class="muted">จุดนัดหมาย</label><select id="ms-point" class="search">'+
      mps.map(function(p){ return '<option value="'+esc(p.id)+'">'+esc(p.name)+(p.port?' ('+esc(p.port)+')':'')+'</option>'; }).join('')+
      '<option value="__new">➕ สร้างจุดนัดหมายใหม่…</option></select>'+
    '<div id="ms-new" class="hidden" style="border:1px dashed var(--line);border-radius:12px;padding:10px;margin-bottom:10px">'+
      '<input id="ms-name" class="search" placeholder="ชื่อจุด เช่น ลานจอดหน้า Gate 3">'+
      '<div id="ms-map" style="height:220px;border-radius:12px;background:#dfe6ee;margin-bottom:8px;display:flex;align-items:center;justify-content:center;color:#64748b;font-size:13px;text-align:center;padding:10px">แตะบนแผนที่เพื่อปักหมุด</div>'+
      '<div class="row" style="gap:6px"><button class="btn btn-ghost btn-sm" id="ms-here" type="button">📍 ใช้ตำแหน่งของฉัน</button><span class="muted grow" id="ms-ll"></span></div>'+
      '<div class="muted" style="margin-top:6px">จุดใหม่จะถูกบันทึกไว้ในระบบ ใช้ซ้ำได้ครั้งหน้า</div></div>'+
    '<label class="muted">ส่งให้คนขับ</label>'+rows.map(function(r, i){
      var st=r.m?MEET_ST[r.m.status]||[r.m.status,'']:null;
      return '<label class="pick"><input type="checkbox" class="ms-drv" data-i="'+i+'"'+(r.pre?' checked':'')+'><div class="grow"><b>'+esc(r.x.name)+'</b>'+(r.x.linked?'':' <span class="stage bad">ยังไม่ผูก LINE</span>')+
        '<div class="muted">'+esc(r.items.map(function(i){ return i.containerNo||i.bl; }).join(', '))+'</div>'+
        (st?'<div class="muted" style="color:var(--warn)">มีนัดอยู่แล้ว ('+esc(st[0])+' • '+esc(r.m.label)+') — ส่งใหม่จะแทนนัดเดิม</div>':'')+'</div></label>';
    }).join('')+
    '<label class="muted">หมายเหตุถึงคนขับ (ไม่บังคับ)</label><input id="ms-note" class="search" placeholder="เช่น จอดหน้าป้อม รปภ.">'+
    '<button class="btn btn-green" id="ms-send">ส่งขอนัดหมายทาง LINE</button>');
  var draft=null, pin=null, gm=null;
  var setDraft=function(lat, lng, pan){
    draft={ lat:lat, lng:lng }; bg.querySelector('#ms-ll').textContent=lat.toFixed(5)+', '+lng.toFixed(5);
    if(gm){ if(!pin) pin=new google.maps.Marker({ map:gm }); pin.setPosition(draft); if(pan){ gm.panTo(draft); gm.setZoom(17); } }
  };
  var showNew=function(){
    var on=bg.querySelector('#ms-point').value==='__new';
    bg.querySelector('#ms-new').classList.toggle('hidden', !on);
    if(on && !gm && d.mapsKey) loadMaps(function(){
      var box=bg.querySelector('#ms-map'); if(!box) return;
      box.innerHTML=''; box.style.display='block';
      var c=mps[0]?{ lat:mps[0].latitude, lng:mps[0].longitude }:{ lat:13.08, lng:100.91 };
      gm=new google.maps.Map(box, { center:c, zoom:15, mapTypeId:'hybrid', streetViewControl:false, mapTypeControl:false, fullscreenControl:false, gestureHandling:'greedy' });
      mps.forEach(function(p){ new google.maps.Marker({ map:gm, position:{ lat:p.latitude, lng:p.longitude }, title:p.name, opacity:.6 }); });
      gm.addListener('click', function(e){ setDraft(e.latLng.lat(), e.latLng.lng(), false); });
      if(draft) setDraft(draft.lat, draft.lng, true);
    });
    if(on && !d.mapsKey) bg.querySelector('#ms-map').textContent='ยังไม่ได้ตั้งค่า Google Maps — กด "ใช้ตำแหน่งของฉัน" ที่จุดนัดหมาย';
  };
  bg.querySelector('#ms-point').addEventListener('change', showNew);
  if(!mps.length){ bg.querySelector('#ms-point').value='__new'; showNew(); }
  bg.querySelector('#ms-here').addEventListener('click', function(){
    if(!navigator.geolocation){ toast('มือถือไม่รองรับตำแหน่ง'); return; }
    navigator.geolocation.getCurrentPosition(function(p){ setDraft(p.coords.latitude, p.coords.longitude, true); },
      function(){ toast('หาตำแหน่งไม่ได้ — แตะบนแผนที่แทน'); }, { enableHighAccuracy:true, timeout:15000 });
  });
  bg.querySelector('#ms-send').addEventListener('click', function(){
    var btn=this, picked=Array.prototype.filter.call(bg.querySelectorAll('.ms-drv'), function(c){ return c.checked; }).map(function(c){ return rows[+c.getAttribute('data-i')]; });
    if(!picked.length){ toast('เลือกคนขับอย่างน้อย 1 คน'); return; }
    var pointSel=bg.querySelector('#ms-point').value, note=bg.querySelector('#ms-note').value;
    var getPoint = pointSel!=='__new' ? Promise.resolve(pointSel) : (function(){
      var name=bg.querySelector('#ms-name').value.trim();
      if(!name){ toast('ตั้งชื่อจุดนัดหมาย'); return null; }
      if(!draft){ toast('ปักหมุดบนแผนที่ หรือกด "ใช้ตำแหน่งของฉัน"'); return null; }
      return api({ action:'coordMeetingPointCreate', name:name, lat:draft.lat, lng:draft.lng }).then(function(r){
        if(!r.ok){ toast(r.error==='bad_location'?'พิกัดไม่ถูกต้อง':errText(r)); return ''; }
        d.meetingPoints=(d.meetingPoints||[]).concat([r.point]); return r.point.id; });
    })();
    if(!getPoint) return;
    btn.disabled=true; btn.textContent='กำลังส่ง…';
    getPoint.then(function(pointId){
      if(!pointId){ btn.disabled=false; btn.textContent='ส่งขอนัดหมายทาง LINE'; return; }
      var ok=0, fails=[], chain=Promise.resolve();
      picked.forEach(function(r){ chain=chain.then(function(){
        return api({ action:'coordMeetingCreate', date:d.date, staff:S.staff, phase:phase, driverId:r.x.id, mode:'DRIVER_TO_STAFF', meetingPointId:pointId,
          itemIds:r.items.map(function(i){ return i.id; }), note:note, replace:true }).then(function(res){
          if(res.ok && res.sent!=='failed') ok++; else fails.push(r.x.name+': '+(res.ok?(res.sent==='none'?'ยังไม่ผูก LINE':'ส่งไม่สำเร็จ'):(MEET_ERR[res.error]||errText(res))));
        });
      }); });
      chain.then(function(){
        bg.remove(); load(true);
        toast('ส่งนัดหมายแล้ว '+ok+' คน'+(fails.length?' • '+fails.join(' • '):''), fails.length?6000:3500);
      });
    });
  });
}

// ---------------- แผนงาน (ภาพรวม รายงาน BL) ----------------
function renderPlan(){
  var d=S.data, c=d.counts;
  if(!c.jobs){
    $('plan-body').innerHTML='<div class="card center">'+(d.planStatus && d.planStatus!=='confirmed' ? 'แพลนวันที่ '+thd(d.date)+' ยังไม่ได้ Confirm' : 'ไม่มีงานของคุณในวันที่ '+thd(d.date))+'</div>';
    return;
  }
  var groups=byBl(d.items), cnt={};
  BUCKETS.forEach(function(b){ cnt[b[0]]=0; }); d.items.forEach(function(i){ cnt[bucket(i)]++; });
  var unlinked=d.drivers.filter(function(x){ return !x.linked; });
  var na=nextAction(), pct=Math.round(c.completed*100/c.jobs);
  var html='<div class="card"><div class="sum-hd"><div><b>'+groups.length+'</b> BL</div><div><b>'+c.jobs+'</b> ตู้</div><div><b>'+c.drivers+'</b> คนขับ</div><div class="grow" style="text-align:right"><b>'+c.completed+'/'+c.jobs+'</b> จบงาน</div></div>'+
    '<div class="track big"><div class="fill" style="width:'+pct+'%"></div></div>'+
    '<div class="pipe">'+BUCKETS.map(function(b){
      return '<button class="pt'+(cnt[b[0]]?'':' zero')+(S.filter===b[0]?' on':'')+(b[0]==='done'?' ok':'')+'" data-filter="'+b[0]+'"><span class="i">'+b[1]+'</span><b>'+cnt[b[0]]+'</b><small>'+b[2]+'</small></button>';
    }).join('')+'</div></div>';
  if(na) html+='<button class="btn cta '+(na.done?'btn-green':(na.ghost?'btn-navy':'btn-amber'))+'" id="cta">'+esc(na.label)+'</button>';
  html+=arrivalsCard();
  var notifiedN=d.drivers.filter(function(x){ return x.itemIds.length && x.notified; }).length;
  html+='<div class="row" style="gap:8px;margin-bottom:12px"><button class="btn btn-ghost btn-sm grow" id="qa-notify">📨 แจ้งงานคนขับ ('+notifiedN+'/'+c.drivers+')</button>'+
    '<button class="btn btn-ghost btn-sm grow" id="qa-meet">📅 ส่งนัดหมาย</button></div>';
  if(unlinked.length){
    html+='<div class="card warnbox"><b>⚠️ ยังไม่ผูก LINE '+unlinked.length+' คน</b><div class="muted" style="margin-top:4px">'+
      esc(unlinked.map(function(x){ return x.name; }).join(', '))+' — ส่งข้อความทาง LINE ไม่ได้ '+(d.smsReady?'(จะส่งทาง SMS แทน)':'')+
      '</div><button class="btn btn-ghost btn-sm" style="margin-top:8px" id="go-link">ผูก LINE คนขับ</button></div>';
  }
  if(d.noDriverPhone.length) html+='<div class="card" style="background:var(--redbg);color:var(--red)">ไม่มีเบอร์มือถือคนขับ: '+esc(d.noDriverPhone.join(', '))+' — ให้ผู้จัดการเพิ่มในแพลน</div>';
  var f=S.filter||'all';
  html+='<div id="bls"><div class="filters">'+[['all','ทั้งหมด'],['todo','ต้องทำ'],['open','ยังไม่จบ']].map(function(x){ return '<button class="chip'+(f===x[0]?' on':'')+'" data-filter="'+x[0]+'">'+x[1]+'</button>'; }).join('')+
    (BUCKETS.some(function(b){ return b[0]===f; })?'<button class="chip on" data-filter="all">'+esc(BUCKETS.filter(function(b){ return b[0]===f; })[0][2])+' ✕</button>':'')+'</div>'+
    '<input class="search" id="q" placeholder="ค้นหา BL / เลขตู้ / คนขับ / ท่า" value="'+esc(S.q||'')+'"><div id="jobs"></div></div>';
  $('plan-body').innerHTML=html;
  if(na) $('cta').addEventListener('click', na.fn);
  $('qa-notify').addEventListener('click', function(){
    var left=d.drivers.filter(function(x){ return x.itemIds.length && !x.notified; });
    if(left.length) notifyJobs(); else if(confirm('แจ้งงานคนขับครบแล้ว — ส่งข้อความ "คุณได้รับงาน" ซ้ำให้ทุกคน?')) notifyJobs(d.drivers.filter(function(x){ return x.itemIds.length; }).map(function(x){ return x.id; }), true);
  });
  $('qa-meet').addEventListener('click', function(){ meetSheet(needMeeting('EIR_HANDOVER').length && !needMeeting('CARD_PICKUP').length ? 'EIR_HANDOVER' : 'CARD_PICKUP'); });
  bindArrivals($('plan-body'));
  if($('go-link')) $('go-link').addEventListener('click', function(){ go('more'); });
  Array.prototype.forEach.call($('plan-body').querySelectorAll('[data-filter]'), function(b){ b.addEventListener('click', function(){
    var v=b.getAttribute('data-filter'); S.filter=(S.filter===v && v!=='all')?'all':v; renderPlan(); }); });
  $('q').addEventListener('input', function(){ S.q=this.value; renderJobs(); });
  renderJobs();
}
function renderJobs(){
  var q=String(S.q||'').toLowerCase(), f=S.filter||'all';
  var groups=byBl(S.data.items).filter(function(g){
    if(q && !g.items.some(function(i){ return (i.bl+' '+i.containerNo+' '+i.driverName+' '+i.port+' '+(i.customer||'')).toLowerCase().indexOf(q)>=0; })) return false;
    var a=staffActions(g.items);
    if(f==='todo') return a.card.length || a.eir.length || g.items.some(function(i){ return i.step && i.step.problem; });
    if(f==='open') return g.items.some(function(i){ return bucket(i)!=='done'; });
    if(f!=='all') return g.items.some(function(i){ return bucket(i)===f; });
    return true;
  });
  $('jobs').innerHTML=groups.map(blCard).join('') || '<div class="center">ไม่พบงาน</div>';
  Array.prototype.forEach.call($('jobs').querySelectorAll('[data-item]'), function(el){ el.addEventListener('click', function(){ openJob(el.getAttribute('data-item')); }); });
  Array.prototype.forEach.call($('jobs').querySelectorAll('[data-blact]'), function(b){ b.addEventListener('click', function(){
    blAction(b.getAttribute('data-blact'), b.getAttribute('data-ids').split(','), b.getAttribute('data-bl'), b);
  }); });
}
function blCard(g){
  var list=g.items, f=S.filter||'all', first=list[0], a=staffActions(list);
  var done=list.filter(function(i){ return bucket(i)==='done'; }).length;
  var problem=list.some(function(i){ return (i.step&&(i.step.problem||i.step.xrayStatus==='hold')); });
  var dests=[]; list.forEach(function(i){ var t=(i.port||'-')+(i.destination?' → '+i.destination:''); if(dests.indexOf(t)<0) dests.push(t); });
  var btn=function(kind, ids, label, cls){ return ids.length ? '<button class="btn btn-sm '+cls+'" data-blact="'+kind+'" data-bl="'+esc(g.bl)+'" data-ids="'+esc(ids.map(function(i){ return i.id; }).join(','))+'">'+label+' ('+ids.length+')</button>' : ''; };
  var acts=btn('card', a.card, '🎫 แจกการ์ดแล้ว', 'btn-amber')+btn('eir', a.eir, '📄 ส่งมอบ EIR แล้ว', 'btn-green');
  return '<div class="bl'+(problem?' problem':'')+(done===list.length?' alldone':'')+'">'+
    '<div class="bl-hd"><div class="grow"><div class="bl-no">BL '+esc(g.bl)+'</div><div class="sub">'+(first.customer?esc(first.customer)+' • ':'')+esc(dests.join(', '))+'</div></div>'+
      '<div class="bl-n"><b>'+done+'/'+list.length+'</b><small>จบงาน</small></div></div>'+
    '<div class="bl-dots">'+list.map(function(i){ var b=bucket(i), k=BUCKETS.map(function(x){ return x[0]; }).indexOf(b); return '<i class="b'+k+'" title="'+esc(i.containerNo)+'"></i>'; }).join('')+'</div>'+
    list.map(function(i){
      var hit=f!=='all'&&f!=='todo'&&f!=='open'&&bucket(i)===f;
      return '<div class="job'+(hit?' hit':'')+'" data-item="'+esc(i.id)+'"><div class="grow"><div class="cn">'+esc(i.containerNo||i.bl)+'</div>'+
        '<div class="sub">👤 '+esc(i.driverName||'-')+(i.plate?' • '+esc(i.plate):'')+(i.step&&i.step.problem?' • <span style="color:var(--red)">⚠️ '+esc(i.step.problem)+'</span>':'')+'</div></div>'+stageChip(i.stage)+'</div>';
    }).join('')+
    (acts?'<div class="bl-act">'+acts+'</div>':'')+'</div>';
}
var BL_ACT={
  card:{ action:'coordCardHanded', ask:'บันทึกว่าแจกการ์ดรับตู้แล้ว', ok:'บันทึกแจกการ์ดแล้ว' },
  passed:{ action:'coordXrayResult', result:'passed', ask:'บันทึกผล X-Ray "ผ่าน"', ok:'บันทึกผล X-Ray ผ่านแล้ว — แจ้งคนขับทาง LINE' },
  hold:{ action:'coordXrayResult', result:'hold', ask:'บันทึกผล X-Ray "ต้องตรวจเพิ่ม"', ok:'บันทึกแล้ว — แจ้งคนขับทาง LINE' },
  reset:{ action:'coordXrayResult', result:'reset', ask:'ยกเลิกผล X-Ray (กลับเป็นรอผล)', ok:'ยกเลิกผลแล้ว' },
  eir:{ action:'coordEirHanded', ask:'บันทึกว่าส่งมอบ EIR ให้คนขับแล้ว (คนขับต้องกดยืนยันรับอีกครั้ง)', ok:'บันทึกส่งมอบ EIR แล้ว' }
};
function blAction(kind, ids, label, btn, done){
  var a=BL_ACT[kind]; if(!a || !ids.length) return;
  var note='';
  if(kind==='hold'){ note=prompt('ต้องตรวจเพิ่มเพราะอะไร / ให้คนขับทำอะไร (ไม่บังคับ)'); if(note===null) return; }
  else if(!confirm(a.ask+'\n'+(label?'BL '+label+' • ':'')+ids.length+' ตู้?')) return;
  if(btn) btn.disabled=true;
  var body={ action:a.action, date:S.data.date, staff:S.staff, itemIds:ids };
  if(a.result){ body.result=a.result; body.note=note; }
  api(body).then(function(res){
    if(btn) btn.disabled=false;
    if(!res.ok){ toast(res.error==='XRAY_BATCH_NOT_READY'?'ยังผ่าน X-Ray ไม่ครบทุกตู้':errText(res), 3500); return; }
    toast(a.ok+' '+res.count+' ตู้'+(res.skipped&&res.skipped.length?' • ข้าม '+res.skipped.length+' ตู้ (ยังไม่รับตู้/ส่ง EIR แล้ว)':''), 3500);
    if(done) done();
    load(true);
  }).catch(function(){ if(btn) btn.disabled=false; toast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); });
}

// ---------------- แผนที่ + ขอพิกัด ----------------
function renderMap(){
  var d=S.data; if(!d) return;
  Array.prototype.forEach.call(document.querySelectorAll('#phase-seg button'), function(b){ b.classList.toggle('on', b.getAttribute('data-phase')===S.phase); });
  Array.prototype.forEach.call(document.querySelectorAll('#mapmode-seg button'), function(b){ b.classList.toggle('on', b.getAttribute('data-mode')===S.mapMode); });
  var ph=S.phase, eir=ph==='EIR_HANDOVER';
  var ds=d.drivers, withJobs=ds.filter(function(x){ return x.itemIds.length; });
  var sent=withJobs.filter(function(x){ var r=x.phases[ph].request; return r && r.status!=='failed'; }).length;
  var failed=withJobs.filter(function(x){ var r=x.phases[ph].request; return r && r.status==='failed'; }).length;
  var got=withJobs.filter(function(x){ return x.phases[ph].location; }).length;
  var expired=withJobs.filter(function(x){ var r=x.phases[ph].request; return r && r.expired && !x.phases[ph].location; }).length;
  var locked=false;
  var html='<div class="row"><b class="grow">'+(eir?'ขอตำแหน่งรอบสอง — นัดส่งมอบ EIR':'ขอตำแหน่งรอบแรก — นัดแจกการ์ดรับตู้')+'</b></div>';
  if(locked){
    html+='<div class="gate closed" style="margin:10px 0 0">🔒 ผ่าน X-Ray แล้ว <b>'+d.gate.passed+'/'+d.gate.total+'</b> ตู้ — รอให้ครบทุกตู้ก่อน<br><span style="font-size:13px">ยังไม่ผ่าน: '+
      esc(d.gate.blockers.map(function(b){ return b.containerNo+' ('+b.driverName+')'; }).join(', '))+'</span></div>';
  }
  html+='<div class="counters"><span class="cnt">ส่งแล้ว '+sent+'/'+withJobs.length+' คน</span><span class="cnt ok">ได้พิกัด '+got+'</span>'+
    (failed?'<span class="cnt bad">ส่งไม่สำเร็จ '+failed+'</span>':'')+(expired?'<span class="cnt bad">หมดอายุ '+expired+'</span>':'')+'</div>';
  html+='<button class="btn '+(eir?'btn-green':'btn-amber')+'" id="req-btn" style="margin-top:10px"'+(locked?' disabled':'')+'>'+
    (sent?'ส่งคำขอซ้ำเฉพาะคนที่ยังไม่ตอบ':(eir?'📄 ส่งคำขอพิกัดรอบสองผ่าน LINE OA':'📍 ส่งคำขอพิกัดผ่าน LINE OA'))+'</button>'+
    '<div class="muted" style="margin-top:6px">ส่ง 1 ข้อความต่อคนขับ 1 คน • ส่งซ้ำคนเดิมได้หลัง '+d.resendCooldownMinutes+' นาที • คำขอหมดอายุใน '+d.requestExpiryMinutes+' นาที</div>';
  // วางแผนนัดหมาย / เส้นทาง (ใช้พิกัดรอบนี้)
  var mps=d.meetingPoints||[];
  html+='<div style="border-top:1px solid #eef1f5;margin:14px -14px 0;padding:14px 14px 0"><b>🧭 วางแผนนัดหมาย / เส้นทาง</b>'+
    '<div class="muted" style="margin:4px 0 8px">ระบบเรียงลำดับและเลือกว่าใครควรไปหาใคร ให้เวลาเดินทาง+รอรวมของทุกคนน้อยที่สุด แล้วส่งการ์ดนัดทาง LINE '+
    (d.routesSource==='GOOGLE_ROUTES_API'?'<span class="stage ok">Google Routes</span>':'<span class="stage wait">ประมาณการจากระยะทาง</span>')+'</div>'+
    '<select id="rt-start" class="search" style="margin-bottom:8px"><option value="gps">📍 เริ่มจากตำแหน่งของฉัน (GPS)</option>'+
      mps.map(function(p){ return '<option value="'+esc(p.id)+'">เริ่มจาก: '+esc(p.name)+(p.port?' ('+esc(p.port)+')':'')+'</option>'; }).join('')+'</select>'+
    '<select id="rt-policy" class="search" style="margin-bottom:8px"><option value="auto">ให้ระบบเลือก (ชิปปิ้งไปหา / คนขับมาที่จุดนัด)</option>'+
      '<option value="STAFF_TO_DRIVER">ชิปปิ้งไปหาคนขับทุกคน</option>'+(mps.length?'<option value="DRIVER_TO_STAFF">ให้คนขับมาที่จุดนัดใกล้ตัว</option>':'')+'</select>'+
    '<button class="btn btn-navy" id="rt-calc"'+(locked?' disabled':'')+'>คำนวณเส้นทาง</button><div id="rt-out"></div></div>';
  $('map-req').innerHTML=html;
  $('rt-calc').addEventListener('click', planRoute);
  if(S.route && S.route.phase===ph) renderRoute();
  $('req-btn').addEventListener('click', function(){ requestLocations(sent ? withJobs.filter(function(x){ return !x.phases[ph].location; }).map(function(x){ return x.id; }) : null); });
  $('map-wrap').classList.toggle('hidden', S.mapMode!=='map');
  $('map-list').classList.toggle('hidden', S.mapMode!=='list');
  renderDriverList();
  if(S.mapMode==='map') drawMap();
}

function locState(x, ph){ var l=x.phases[ph].location; return l ? (l.fresh?'fresh':'stale') : 'none'; }
function renderDriverList(){
  var ph=S.phase;
  $('map-list').innerHTML=S.data.drivers.filter(function(x){ return x.itemIds.length; }).map(function(x){
    var l=x.phases[ph].location, r=x.phases[ph].request, st=locState(x, ph);
    var status = l ? ('📍 '+hm(l.at)+' • '+ago(l.ageMin)+(l.accuracy?' • ±'+Math.round(l.accuracy)+' ม.':''))
      : (r ? (r.status==='failed'?'❌ ส่งไม่สำเร็จ'+(r.error?' — '+r.error:''):(r.status==='denied'?'🚫 ไม่อนุญาตตำแหน่ง':(r.expired?'⌛ คำขอหมดอายุ':'⏳ รอคนขับส่งพิกัด'))) : 'ยังไม่ได้ส่งคำขอ');
    return '<div class="drv" data-drv="'+esc(x.id)+'"><span class="dot '+st+'"></span><div class="grow"><b>'+esc(x.name)+'</b> <span class="muted">'+x.itemIds.length+' ตู้</span>'+
      (!x.linked?' <span class="stage bad">ยังไม่ผูก LINE</span>':'')+'<div class="muted">'+esc(status)+'</div></div><span class="muted">›</span></div>';
  }).join('') || '<div class="center">ไม่มีคนขับ</div>';
  Array.prototype.forEach.call($('map-list').querySelectorAll('[data-drv]'), function(el){ el.addEventListener('click', function(){ openDriver(el.getAttribute('data-drv')); }); });
}

function requestLocations(driverIds){
  var d=S.data, ph=S.phase, targets=d.drivers.filter(function(x){ return x.itemIds.length && (!driverIds || driverIds.indexOf(x.id)>=0); });
  if(!targets.length){ toast('ทุกคนส่งพิกัดแล้ว'); return; }
  var cnt=targets.reduce(function(s,x){ return s+x.itemIds.length; },0);
  if(!confirm('จะส่งคำขอพิกัด'+(ph==='EIR_HANDOVER'?'รอบสอง (EIR)':'รอบแรก (การ์ดรับตู้)')+' ไปยังคนขับ '+targets.length+' คน ครอบคลุม '+cnt+' ตู้'+(d.lineMode==='demo'?'\n\n(DEMO MODE — ไม่ได้ส่ง LINE จริง)':''))) return;
  var btn=$('req-btn'); btn.disabled=true;
  api({ action:'coordRequestLocations', date:d.date, staff:S.staff, phase:ph, driverIds:driverIds||undefined }).then(function(res){
    btn.disabled=false;
    if(!res.ok){
      if(res.error==='XRAY_BATCH_NOT_READY') toast('ยังผ่าน X-Ray '+res.passed+'/'+res.total+' ตู้ — รอให้ครบก่อน', 4000); else toast(errText(res), 3500);
      load(true); return;
    }
    toast('ส่งคำขอแล้ว '+res.sent+' คน'+(res.failed?' • ไม่สำเร็จ '+res.failed:'')+(res.cooldown?' • รอส่งซ้ำ '+res.cooldown:''), 3500);
    load(true);
  }).catch(function(){ btn.disabled=false; toast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); });
}

/** Google Maps — ไม่มี key = แสดงรายชื่อแทน ไม่วาดแผนที่ปลอม */
/** โหลด Google Maps ครั้งเดียว ใช้ร่วมกันทั้งแผนที่หลักและแผนที่เลือกจุดนัดหมาย */
function loadMaps(cb, onErr){
  if(window.google && google.maps) return cb();
  (S.mapsCbs=S.mapsCbs||[]).push(cb);
  if(S.mapsLoading) return;
  S.mapsLoading=true;
  window.__gmReady=function(){ (S.mapsCbs||[]).splice(0).forEach(function(f){ try{ f(); }catch(e){} }); };
  var s=document.createElement('script');
  s.src='https://maps.googleapis.com/maps/api/js?key='+encodeURIComponent(S.data.mapsKey)+'&callback=__gmReady&loading=async&libraries=geometry&language=th&region=TH';
  s.async=true; s.onerror=function(){ S.mapsLoading=false; if(onErr) onErr(); };
  document.head.appendChild(s);
}
function drawMap(){
  var d=S.data, box=$('map');
  if(!d.mapsKey){
    box.innerHTML='<div class="map-empty">ยังไม่ได้ตั้งค่า Google Maps (GOOGLE_MAPS_BROWSER_KEY)<br>ดูพิกัดในแท็บ "รายชื่อ" และกดเปิด Google Maps ทีละคนได้</div>';
    return;
  }
  if(!window.google || !google.maps){
    loadMaps(drawMap, function(){ box.innerHTML='<div class="map-empty">โหลด Google Maps ไม่สำเร็จ</div>'; });
    return;
  }
  if(!S.gmap){
    box.innerHTML='';
    S.gmap=new google.maps.Map(box, { center:{lat:13.08,lng:100.91}, zoom:12, mapTypeControl:false, streetViewControl:false, fullscreenControl:false, gestureHandling:'greedy' });
  }
  S.markers.forEach(function(m){ m.setMap(null); }); S.markers=[];
  var bounds=new google.maps.LatLngBounds(), n=0, ph=S.phase;
  var pin=function(color, label){
    return { path:'M12 0C5.4 0 0 5.4 0 12c0 9 12 24 12 24s12-15 12-24C24 5.4 18.6 0 12 0z', fillColor:color, fillOpacity:1, strokeColor:'#fff', strokeWeight:2,
             scale:1.1, anchor:new google.maps.Point(12,36), labelOrigin:new google.maps.Point(12,12) };
  };
  d.drivers.forEach(function(x){
    if(!x.itemIds.length) return;
    var l=x.phases[ph].location;
    // รอบสอง: พิกัดรอบแรกแสดงเป็นหมุดสีเทา (ประวัติ) ไม่นับเป็นคำตอบรอบสอง
    if(!l && ph==='EIR_HANDOVER' && x.phases.CARD_PICKUP.location){
      var o=x.phases.CARD_PICKUP.location;
      var g=new google.maps.Marker({ map:S.gmap, position:{lat:o.lat,lng:o.lng}, icon:pin('#9ca3af'), title:x.name+' (พิกัดรอบแรก)', opacity:.6 });
      g.addListener('click', function(){ openDriver(x.id); }); S.markers.push(g);
      return;
    }
    if(!l) return;
    var m=new google.maps.Marker({ map:S.gmap, position:{lat:l.lat,lng:l.lng}, icon:pin(l.fresh?'#06C755':'#FFB020'),
      label:{ text:String(x.name||'?').slice(0,2), color:'#fff', fontSize:'10px', fontWeight:'700' }, title:x.name });
    m.addListener('click', function(){ openDriver(x.id); });
    S.markers.push(m); bounds.extend(m.getPosition()); n++;
  });
  (d.meetingPoints||[]).forEach(function(p){
    var m=new google.maps.Marker({ map:S.gmap, position:{lat:p.latitude,lng:p.longitude}, title:'จุดนัด: '+p.name,
      icon:{ path:google.maps.SymbolPath.CIRCLE, scale:7, fillColor:'#0B2A52', fillOpacity:1, strokeColor:'#D4A044', strokeWeight:3 } });
    S.markers.push(m);
  });
  var rt=S.route && S.route.phase===ph ? S.route : null;
  if(rt){
    var st=new google.maps.Marker({ map:S.gmap, position:{lat:rt.start.lat,lng:rt.start.lng}, title:'จุดเริ่ม',
      icon:{ path:google.maps.SymbolPath.CIRCLE, scale:8, fillColor:'#1d4ed8', fillOpacity:1, strokeColor:'#fff', strokeWeight:3 } });
    S.markers.push(st); bounds.extend(st.getPosition()); n++;
    rt.stops.forEach(function(s){
      var mk=new google.maps.Marker({ map:S.gmap, position:{lat:s.lat,lng:s.lng}, zIndex:999, title:s.seq+'. '+s.label,
        label:{ text:String(s.seq), color:'#2b1b00', fontWeight:'800' }, icon:{ path:google.maps.SymbolPath.CIRCLE, scale:13, fillColor:'#D4A044', fillOpacity:1, strokeColor:'#0B2A52', strokeWeight:2 } });
      S.markers.push(mk); bounds.extend(mk.getPosition()); n++;
    });
    drawRouteLines(rt);
  }
  if(n===1){ S.gmap.setCenter(bounds.getCenter()); S.gmap.setZoom(15); } else if(n>1) S.gmap.fitBounds(bounds, 40);
}

/**
 * ตีเส้นเชื่อมทุกจุดตามลำดับ: จุดเริ่ม → 1 → 2 → … (หัวลูกศรบอกทิศ + ป้ายเวลาเดินทางแต่ละช่วง)
 *   Google Routes = เส้นถนนจริง (เส้นทึบ) / ประมาณการ = เส้นตรงประ (ไม่ใช่เส้นทางถนนจริง)
 * คนขับที่ "มาหาที่จุดนัด" ตีเส้นประสีเขียวจากตำแหน่งคนขับไปจุดนั้น
 */
function drawRouteLines(rt){
  var NAVY='#0B2A52', GOLD='#D4A044';
  var push=function(o){ S.markers.push(o); return o; };
  var arrow={ path:google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale:3.2, fillColor:GOLD, fillOpacity:1, strokeColor:NAVY, strokeWeight:1.2 };
  var dash={ path:'M 0,-1 0,1', strokeOpacity:1, strokeColor:NAVY, strokeWeight:4, scale:3 };
  var pts=[{lat:rt.start.lat,lng:rt.start.lng}].concat(rt.stops.map(function(s){ return {lat:s.lat,lng:s.lng}; }));
  var road=rt.polyline && google.maps.geometry ? google.maps.geometry.encoding.decodePath(rt.polyline) : null;
  if(road){
    push(new google.maps.Polyline({ map:S.gmap, path:road, strokeColor:NAVY, strokeOpacity:.85, strokeWeight:5,
      icons:[{ icon:arrow, offset:'60px', repeat:'140px' }] }));
  }
  for(var i=1;i<pts.length;i++){
    var a=pts[i-1], b=pts[i];
    if(!road){
      // เส้นตรงประต่อช่วง + ลูกศรกลางช่วง
      push(new google.maps.Polyline({ map:S.gmap, path:[a,b], strokeOpacity:0, geodesic:false,
        icons:[{ icon:dash, offset:'0', repeat:'14px' }, { icon:arrow, offset:'55%' }] }));
    }
    var sec=rt.stops[i-1].legSeconds||0;
    if(sec>0) push(new google.maps.Marker({ map:S.gmap, position:{lat:(a.lat+b.lat)/2,lng:(a.lng+b.lng)/2}, clickable:false, zIndex:500,
      label:{ text:Math.max(1,Math.round(sec/60))+' น.', color:NAVY, fontSize:'11px', fontWeight:'800' },
      icon:{ path:'M -20,-10 H 20 A 4 4 0 0 1 24 -6 V 6 A 4 4 0 0 1 20 10 H -20 A 4 4 0 0 1 -24 6 V -6 A 4 4 0 0 1 -20 -10 Z',
             fillColor:'#fff', fillOpacity:.95, strokeColor:GOLD, strokeWeight:1.5, scale:1, labelOrigin:new google.maps.Point(0,0) } }));
  }
  // คนขับเดินทางมาหาที่จุดนัด: เส้นประสีเขียวจากตำแหน่งคนขับ
  var greenDash={ path:'M 0,-1 0,1', strokeOpacity:1, strokeColor:'#06C755', strokeWeight:3, scale:2.5 };
  rt.stops.forEach(function(s){
    (s.drivers||[]).forEach(function(d){
      if(d.mode!=='DRIVER_TO_STAFF') return;
      var x=S.data.drivers.filter(function(v){ return v.id===d.driverId; })[0];
      var l=x && x.phases[rt.phase] && x.phases[rt.phase].location; if(!l) return;
      push(new google.maps.Polyline({ map:S.gmap, path:[{lat:l.lat,lng:l.lng},{lat:s.lat,lng:s.lng}], strokeOpacity:0,
        icons:[{ icon:greenDash, offset:'0', repeat:'10px' }, { icon:{ path:google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale:2.6, fillColor:'#06C755', fillOpacity:1, strokeColor:'#fff', strokeWeight:1 }, offset:'60%' }] }));
    });
  });
}

// ---------------- แผงล่าง: คนขับ / งาน ----------------
function sheet(html){
  var bg=document.createElement('div'); bg.className='sheet-bg';
  bg.innerHTML='<div class="sheet"><div class="grab"></div>'+html+'</div>';
  bg.addEventListener('click', function(e){ if(e.target===bg) bg.remove(); });
  document.body.appendChild(bg);
  return bg;
}
function openDriver(id){
  var x=S.data.drivers.filter(function(d){ return d.id===id; })[0]; if(!x) return;
  var jobs=S.data.items.filter(function(i){ return x.itemIds.indexOf(i.id)>=0; });
  var html='<h3>👤 '+esc(x.name)+'</h3>'+
    '<div class="kv"><span>โทร</span><b><a href="tel:'+esc(x.phone)+'">'+esc(x.phone)+'</a></b></div>'+
    '<div class="kv"><span>ทะเบียน</span><b>'+esc(x.plate||'-')+'</b></div>'+
    '<div class="kv"><span>แจ้งงาน</span><b>'+(x.notified?'แจ้ง "คุณได้รับงาน" แล้ว':'ยังไม่แจ้ง')+'</b></div>'+
    '<div class="kv"><span>LINE</span><b>'+(x.linked?(x.demoLinked?'ผูกแล้ว (DEMO)':'ผูกแล้ว'+(x.friend?'':' • ยังไม่ได้เพิ่มเพื่อน OA')):'ยังไม่ผูก')+'</b></div>';
  ['CARD_PICKUP','EIR_HANDOVER'].forEach(function(ph){
    var l=x.phases[ph].location, r=x.phases[ph].request;
    html+='<div class="kv"><span>'+(ph==='CARD_PICKUP'?'พิกัดรอบแรก':'พิกัดรอบสอง')+'</span><b>'+
      (l?('<a target="_blank" rel="noopener" href="https://www.google.com/maps?q='+l.lat+','+l.lng+'">'+hm(l.at)+' ('+ago(l.ageMin)+')</a>'+(l.accuracy?'<br><small>±'+Math.round(l.accuracy)+' ม.</small>':''))
        :(r?(r.status==='failed'?'ส่งไม่สำเร็จ':(r.expired?'คำขอหมดอายุ':'รอคำตอบ')):'—'))+'</b></div>';
  });
  html+='<div style="margin:12px 0 4px"><b>ตู้ของคนขับคนนี้</b></div>'+jobs.map(function(i){ return '<div class="job"><div class="grow"><div class="cn">'+esc(i.containerNo||i.bl)+'</div><div class="sub">'+esc(i.port)+'</div></div>'+stageChip(i.stage)+'</div>'; }).join('');
  html+='<div class="row" style="margin-top:12px"><a class="btn btn-ghost" style="text-align:center;text-decoration:none" href="tel:'+esc(x.phone)+'">📞 โทร</a>'+
    '<button class="btn btn-amber" id="sh-req">ขอพิกัดอีกครั้ง</button></div>'+
    '<button class="btn btn-navy" id="sh-meet" style="margin-top:8px">📅 นัดหมาย'+(S.phase==='EIR_HANDOVER'?'ส่งมอบ EIR':'แจกการ์ด')+'</button>';
  var bg=sheet(html);
  bg.querySelector('#sh-req').addEventListener('click', function(){ bg.remove(); requestLocations([x.id]); });
  bg.querySelector('#sh-meet').addEventListener('click', function(){ bg.remove(); meetSheet(S.phase, x.id); });
}
var EVENT_TH={
  LOCATION_CARD_PICKUP_REQUESTED:'ขอตำแหน่ง (แจกการ์ด)', LOCATION_CARD_PICKUP_RECEIVED:'คนขับส่งตำแหน่ง (แจกการ์ด)',
  LOCATION_EIR_HANDOVER_REQUESTED:'ขอตำแหน่ง (ส่ง EIR)', LOCATION_EIR_HANDOVER_RECEIVED:'คนขับส่งตำแหน่ง (ส่ง EIR)',
  PICKUP_CARD_HANDED:'ชิปปิ้งแจกการ์ด', PICKUP_CARD_HANDED_UNDONE:'ยกเลิกแจกการ์ด', PICKUP_CARD_ACKNOWLEDGED:'คนขับยืนยันได้การ์ด',
  CONTAINER_PICKED_UP_REPORTED:'คนขับส่งงานรับตู้ (รูปครบ)', XRAY_SCANNED_REPORTED:'คนขับเข้า Fast Scan แล้ว', XRAY_WAITING_REPORTED:'คนขับรอคิว X-Ray',
  XRAY_HOLD_REPORTED:'คนขับแจ้งติดปัญหา X-Ray', XRAY_PASSED_REPORTED:'คนขับแจ้งผ่าน X-Ray', XRAY_RESULT_PASSED:'ชิปปิ้งบันทึกผล X-Ray ผ่าน',
  XRAY_RESULT_HOLD:'ชิปปิ้งบันทึก X-Ray ตรวจเพิ่ม', XRAY_RESULT_RESET:'ยกเลิกผล X-Ray', EIR_STAFF_HANDED_OVER:'ชิปปิ้งส่งมอบ EIR',
  EIR_STAFF_HANDED_UNDONE:'ยกเลิกส่งมอบ EIR', EIR_DRIVER_RECEIVED:'คนขับยืนยันรับ EIR', DRIVER_RELEASE_COMPLETION_SUBMITTED:'คนขับส่งรูปจบงาน',
  PROBLEM_REPORTED:'คนขับแจ้งปัญหา', DRIVER_REASSIGNED:'เปลี่ยนคนขับ', ARRIVED_CARD_POINT:'คนขับถึงจุดรับการ์ด', ARRIVED_EIR_POINT:'คนขับถึงจุดรับ ER',
  CARD_MEETING_PROPOSED:'ส่งนัดหมายรับการ์ด', EIR_MEETING_PROPOSED:'ส่งนัดหมายรับ EIR', JOB_ASSIGNED_NOTIFIED:'แจ้ง "คุณได้รับงาน"'
};
function openJob(itemId){
  var i=S.data.items.filter(function(x){ return x.id===itemId; })[0]; if(!i) return;
  var s=i.step||{};
  var row=function(label, v){ return '<div class="kv"><span>'+label+'</span><b>'+(v||'—')+'</b></div>'; };
  var xr=FAST.indexOf(s.xrayStatus)>=0?'เข้าแล้ว '+hm(s.xrayAt):(s.xrayStatus==='hold'?'<span style="color:var(--red)">ติดปัญหา</span>'+(s.xrayNote?' — '+esc(s.xrayNote):''):'');
  var html='<h3>📦 '+esc(i.containerNo||i.bl)+' '+stageChip(i.stage)+'</h3>'+row('BL', esc(i.bl))+row('ท่า / ปลายทาง', esc(i.port)+' → '+esc(i.destination||'-'))+
    row('คนขับ', esc(i.driverName)+(i.plate?' • '+esc(i.plate):'')+(i.phone?' • <a href="tel:'+esc(i.phone)+'">'+esc(i.phone)+'</a>':''))+
    row('1. แจกการ์ด', s.cardHandedAt?hm(s.cardHandedAt)+' (ชิปปิ้ง)':(s.cardAckAt?hm(s.cardAckAt)+' (คนขับยืนยัน)':''))+
    row('2. ส่งงานรับตู้', hm(s.pickedUpAt))+evidenceThumbs(i, [['TRUCK_FRONT_PHOTO','หน้ารถ'],['TRUCK_REAR_PHOTO','หลังรถ'],['PICKUP_SEAL_PHOTO','ซีลตู้']])+
    row('3. Fast Scan', xr)+
    row('5. ส่งมอบ EIR', hm(s.eirHandedAt))+row('คนขับรับ EIR', hm(s.eirReceivedAt))+row('6. จบงาน', s.completedAt?hm(s.completedAt)+' <small>(คนขับส่ง)</small>':'')+
    evidenceThumbs(i, [['EIR_CARD_PHOTO','การ์ด EIR'],['CONTAINER_SEAL_PHOTO','Seal']])+
    (s.problem?row('ปัญหา', '<span style="color:var(--red)">'+esc(s.problem)+'</span>'):'')+
    '<div style="margin-top:12px"><b>ประวัติ</b><div id="tl" class="muted">กำลังโหลด…</div></div>';
  var bg=sheet(html);
  Array.prototype.forEach.call(bg.querySelectorAll('[data-jx]'), function(b){ b.addEventListener('click', function(){
    blAction(b.getAttribute('data-jx'), [i.id], '', b, function(){ bg.remove(); });
  }); });
  api({ action:'coordTimeline', itemId:itemId }).then(function(res){
    var el=$('tl'); if(!el) return;
    el.innerHTML=res.ok && res.rows.length ? res.rows.map(function(r){ return '<div class="kv"><span>'+hm(r.createdAt)+'</span><b style="font-weight:600">'+esc(EVENT_TH[r.event]||r.event)+(r.meta&&r.meta.note?' — '+esc(r.meta.note):'')+'</b></div>'; }).join('') : 'ยังไม่มีประวัติ';
  });
}
function evidenceThumbs(i, kinds){
  kinds=kinds||[['EIR_CARD_PHOTO','การ์ด EIR'],['CONTAINER_SEAL_PHOTO','Seal']];
  return '<div class="thumbs">'+kinds.map(function(k){
    var f=(i.evidence||[]).filter(function(e){ return e.kind===k[0]; });
    return f.length ? f.map(function(e){ return '<a class="thumb" href="'+esc(e.url)+'" target="_blank" rel="noopener" title="'+k[1]+'"><img src="'+esc(e.url)+'" alt="'+k[1]+'" loading="lazy"></a>'; }).join('')
      : '<div class="thumb">ยังไม่มี<br>'+k[1]+'</div>';
  }).join('')+'</div>';
}

// ---------------- สถานะงาน (บันทึกทีละตู้ / ทั้ง BL) ----------------
function renderStatus(){
  var d=S.data, items=d.items;
  if(!items.length){ $('status-body').innerHTML='<div class="card center">ไม่มีงาน</div>'; return; }
  var html=d.gate.ready
    ? '<div class="gate open">✅ เข้า Fast Scan ครบ <b>'+d.gate.total+'/'+d.gate.total+'</b> ตู้</div>'
    : '<div class="gate closed">🛃 เข้า Fast Scan แล้ว <b>'+d.gate.passed+'/'+d.gate.total+'</b> ตู้ — ตู้ที่เข้าแล้วส่งนัดหมายรับ EIR ได้เลย</div>';
  html+=meetingList();
  var a=staffActions(items);
  html+=pickCard('card', '🎫 แจกการ์ดรับตู้', 'ติ๊กตู้ที่แจกการ์ดแล้ว — ติ๊กที่ BL เพื่อเลือกทั้ง BL', a.card, [['card','บันทึกแจกการ์ดแล้ว','btn-amber']]);
  html+=pickCard('eir', '📄 ส่งมอบ EIR (ชิปปิ้ง → คนขับ)', 'ตู้ที่เข้า Fast Scan แล้ว — ติ๊กตู้ที่ส่งมอบ EIR แล้ว', a.eir, [['eir','บันทึกส่งมอบ EIR แล้ว','btn-green']]);
  var done=items.filter(function(i){ return i.step&&i.step.completedAt; }).length;
  html+='<div class="card group"><h4>📷 รูปจากคนขับ — จบงาน '+done+'/'+items.length+' ตู้</h4>'+byBl(items).map(function(g){
    return '<div class="blsub">BL '+esc(g.bl)+'</div>'+g.items.map(function(i){
      return '<div class="pick" style="display:block" data-item="'+esc(i.id)+'"><div class="row"><b class="grow">'+esc(i.containerNo||i.bl)+'</b>'+stageChip(i.stage)+'</div><div class="muted">👤 '+esc(i.driverName)+'</div>'+
        '<div class="muted" style="margin-top:4px">รับตู้</div>'+evidenceThumbs(i, [['TRUCK_FRONT_PHOTO','หน้ารถ'],['TRUCK_REAR_PHOTO','หลังรถ'],['PICKUP_SEAL_PHOTO','ซีลตู้']])+
        '<div class="muted" style="margin-top:4px">จบงาน</div>'+evidenceThumbs(i)+'</div>';
    }).join('');
  }).join('')+'</div>';
  $('status-body').innerHTML=html;
  bindPick('card'); bindPick('eir'); bindArrivals($('status-body'));
  Array.prototype.forEach.call($('status-body').querySelectorAll('[data-mcancel]'), function(b){ b.addEventListener('click', function(e){
    e.stopPropagation(); if(!confirm('ยกเลิกนัดนี้? คนขับจะได้รับแจ้งทาง LINE')) return;
    api({ action:'coordMeetingCancel', id:b.getAttribute('data-mcancel') }).then(function(r){ if(!r.ok){ toast(errText(r)); return; } toast('ยกเลิกนัดแล้ว'); load(true); });
  }); });
  Array.prototype.forEach.call($('status-body').querySelectorAll('div[data-item]'), function(el){ el.addEventListener('click', function(e){ if(e.target.closest('a')) return; openJob(el.getAttribute('data-item')); }); });
}
function pickCard(kind, title, hint, list, buttons){
  if(!list.length) return '<div class="card"><h4 style="margin:0;color:var(--ok)">'+title+' — ไม่มีตู้ค้าง ✓</h4></div>';
  return '<div class="card group"><h4>'+title+' ('+list.length+' ตู้)</h4><div class="muted" style="margin-bottom:6px">'+hint+'</div>'+
    byBl(list).map(function(g, gi){
      return '<label class="pick blpick"><input type="checkbox" class="pkb-'+kind+'" data-g="'+gi+'"><div class="grow"><b>BL '+esc(g.bl)+'</b> <span class="muted">'+g.items.length+' ตู้</span></div></label>'+
        g.items.map(function(i){
          return '<label class="pick" style="padding-left:24px"><input type="checkbox" class="pk-'+kind+'" data-g="'+gi+'" value="'+esc(i.id)+'"><div class="grow"><b>'+esc(i.containerNo||i.bl)+'</b>'+
            '<div class="muted">👤 '+esc(i.driverName)+' • '+esc(i.port)+'</div></div>'+stageChip(i.stage)+'</label>';
        }).join('');
    }).join('')+
    '<div class="row" style="margin-top:10px">'+buttons.map(function(b){ return '<button class="btn '+b[2]+'" data-pkact="'+b[0]+'" data-kind="'+kind+'" data-label="'+esc(b[1])+'" disabled>'+b[1]+'</button>'; }).join('')+'</div></div>';
}
function bindPick(kind){
  var btns=document.querySelectorAll('[data-kind="'+kind+'"][data-pkact]'); if(!btns.length) return;
  var upd=function(){
    var n=document.querySelectorAll('.pk-'+kind+':checked').length;
    Array.prototype.forEach.call(btns, function(b){ b.disabled=!n; b.textContent=b.getAttribute('data-label')+(n?' ('+n+')':''); });
    Array.prototype.forEach.call(document.querySelectorAll('.pkb-'+kind), function(g){
      var kids=document.querySelectorAll('.pk-'+kind+'[data-g="'+g.getAttribute('data-g')+'"]'), on=Array.prototype.filter.call(kids, function(k){ return k.checked; }).length;
      g.checked=on===kids.length; g.indeterminate=on>0 && on<kids.length;
    });
  };
  Array.prototype.forEach.call(document.querySelectorAll('.pk-'+kind), function(b){ b.addEventListener('change', upd); });
  Array.prototype.forEach.call(document.querySelectorAll('.pkb-'+kind), function(g){ g.addEventListener('change', function(){
    Array.prototype.forEach.call(document.querySelectorAll('.pk-'+kind+'[data-g="'+g.getAttribute('data-g')+'"]'), function(k){ k.checked=g.checked; }); upd();
  }); });
  Array.prototype.forEach.call(btns, function(b){ b.addEventListener('click', function(){
    var ids=Array.prototype.map.call(document.querySelectorAll('.pk-'+kind+':checked'), function(x){ return x.value; });
    blAction(b.getAttribute('data-pkact'), ids, '', b);
  }); });
}

// ---------------- เพิ่มเติม ----------------
function renderMore(){
  var d=S.data;
  var html='<div class="card"><b>คนขับในงานวันที่ '+thd(d.date)+'</b><div class="muted" style="margin:4px 0 8px">ผูก LINE ครั้งเดียว ใช้ได้ทุกวัน — ส่งลิงก์ทาง SMS หรือให้คนขับสแกน QR ต่อหน้า</div>'+
    d.drivers.filter(function(x){ return x.itemIds.length; }).map(function(x){
      return '<div class="drv"><div class="grow"><b>'+esc(x.name)+'</b> <span class="muted">'+esc(x.phone)+'</span><div class="muted">'+
        (x.linked?('✅ ผูก LINE แล้ว'+(x.demoLinked?' (DEMO)':'')+(x.lineName&&!x.demoLinked?' • '+esc(x.lineName):'')):'⚪ ยังไม่ผูก LINE')+'</div></div>'+
        '<button class="btn btn-ghost btn-sm" data-inv="'+esc(x.id)+'">'+(x.linked?'ผูกใหม่':'ผูก LINE')+'</button></div>'+
        (d.lineMode==='demo'?'<div class="row" style="gap:6px;margin:-4px 0 8px 0"><button class="btn btn-ghost btn-sm" data-demo-link="'+esc(x.id)+'">'+(x.linked?'ยกเลิกผูก (DEMO)':'ผูกแบบทดลอง')+'</button>'+
          '<button class="btn btn-ghost btn-sm" data-demo-open="'+esc(x.id)+'">เปิดหน้าคนขับ (DEMO)</button></div>':'');
    }).join('')+'</div>';
  var me=d.me||{};
  html+='<div class="card"><b>📞 เบอร์มือถือของฉัน</b><div class="muted" style="margin:4px 0 8px">คนขับกดโทรหาคุณได้จากหน้างานใน LINE (ขั้นรับการ์ด / รับ EIR)</div>'+
    '<div class="row"><input id="my-phone" class="search grow" type="tel" inputmode="tel" style="margin:0" placeholder="เช่น 0812345678" value="'+esc(me.phone||'')+'">'+
    '<button class="btn btn-navy btn-sm" id="my-phone-save">บันทึก</button></div>'+(me.phone?'':'<div class="muted" style="color:var(--red);margin-top:6px">ยังไม่ได้ใส่เบอร์ — คนขับจะไม่มีปุ่มโทรหาคุณ</div>')+'</div>';
  html+='<div class="card"><b>🔔 LINE ของฉัน (แจ้งเตือนงาน)</b><div class="muted" style="margin:4px 0 8px">'+
    (me.linked?'ผูกแล้ว'+(me.lineName?' • '+esc(me.lineName):'')+' — ได้ข้อความเมื่อคนขับส่งพิกัด / ผ่าน X-Ray ครบ / ขอเลื่อนนัด / จบงาน':'ผูก LINE เพื่อรับแจ้งเตือนและเมนู "งานชิปปิ้ง" ในแชท SHIPME')+'</div>'+
    (me.linked
      ? '<select id="nt-level" class="search"><option value="important">แจ้งเฉพาะเรื่องสำคัญ (แนะนำ)</option><option value="all">แจ้งทุกความเคลื่อนไหว (ใช้โควตาข้อความมาก)</option><option value="off">ปิดแจ้งเตือน</option></select>'+
        '<button class="btn btn-ghost btn-sm" id="nt-unlink">ยกเลิกการผูก LINE</button>'
      : '<button class="btn btn-green" id="nt-link"'+(d.lineMode!=='live'?' disabled':'')+'>ผูก LINE ของฉัน</button>')+'</div>';
  html+='<div class="card"><div class="row"><b class="grow">💬 '+(d.lineMode==='demo'?'จำลองแชท LINE (DEMO)':'ข้อความ LINE ที่ส่ง')+'</b><button class="btn btn-ghost btn-sm" id="ob-load">โหลด</button></div><div id="outbox" class="muted" style="margin-top:8px">กด "โหลด" เพื่อดูข้อความ</div></div>';
  html+='<div class="card"><a href="/#release" class="btn btn-ghost" style="display:block;text-align:center;text-decoration:none;margin-bottom:8px">✉️ ส่ง SMS นัดหมาย / แผนที่ (ช่องทางสำรอง)</a>'+
    '<a href="/" class="btn btn-ghost" style="display:block;text-align:center;text-decoration:none">← กลับหน้าหลัก (เข้างาน / เบิก / ปิดบัญชี)</a></div>';
  $('more-body').innerHTML=html;
  Array.prototype.forEach.call($('more-body').querySelectorAll('[data-inv]'), function(b){ b.addEventListener('click', function(){ invite(b.getAttribute('data-inv')); }); });
  Array.prototype.forEach.call($('more-body').querySelectorAll('[data-demo-link]'), function(b){ b.addEventListener('click', function(){
    var x=d.drivers.filter(function(y){ return y.id===b.getAttribute('data-demo-link'); })[0];
    api({ action:'coordDemo', op:x.linked?'unlink':'link', driverId:x.id }).then(function(res){ if(!res.ok){ toast(errText(res)); return; } toast(x.linked?'ยกเลิกผูกแล้ว':'ผูก LINE แบบทดลองแล้ว'); load(); });
  }); });
  Array.prototype.forEach.call($('more-body').querySelectorAll('[data-demo-open]'), function(b){ b.addEventListener('click', function(){
    var w=window.open('', '_blank');
    api({ action:'coordDemo', driverId:b.getAttribute('data-demo-open') }).then(function(res){
      if(!res.ok){ if(w) w.close(); toast(errText(res)); return; }
      var url='/driver?s='+encodeURIComponent(res.session); if(w) w.location=url; else location.href=url;
    });
  }); });
  $('ob-load').addEventListener('click', loadOutbox);
  $('my-phone-save').addEventListener('click', function(){
    api({ action:'coordStaffNotify', phone:$('my-phone').value.trim() }).then(function(r){ toast(r.ok?'บันทึกเบอร์แล้ว':(r.error==='bad_phone'?'เบอร์ไม่ถูกต้อง':errText(r))); if(r.ok) load(true); });
  });
  if($('nt-level')){ $('nt-level').value=me.notify||'important';
    $('nt-level').addEventListener('change', function(){ api({ action:'coordStaffNotify', level:this.value }).then(function(r){ toast(r.ok?'บันทึกแล้ว':errText(r)); load(true); }); }); }
  if($('nt-unlink')) $('nt-unlink').addEventListener('click', function(){ if(!confirm('ยกเลิกการผูก LINE ของคุณ?')) return;
    api({ action:'coordStaffNotify', unlink:true }).then(function(){ toast('ยกเลิกแล้ว'); load(); }); });
  if($('nt-link')) $('nt-link').addEventListener('click', function(){
    api({ action:'coordStaffLineLink' }).then(function(r){
      if(!r.ok){ toast(errText(r)); return; }
      var bg=sheet('<h3>ผูก LINE ของฉัน</h3><div class="muted">เปิดลิงก์นี้ในมือถือที่ใช้ LINE (สแกน QR) ภายใน '+r.expiresInMinutes+' นาที แล้วกดเพิ่มเพื่อน SHIPME OA</div><div id="qr"></div>'+
        '<a class="btn btn-green" href="'+esc(r.link)+'" style="margin-top:8px">เปิดใน LINE (ถ้าใช้มือถือเครื่องนี้)</a>');
      try { new QRCode(bg.querySelector('#qr'), { text:r.link, width:200, height:200 }); } catch(e){}
    });
  });
}
function invite(driverId){
  var x=S.data.drivers.filter(function(y){ return y.id===driverId; })[0];
  api({ action:'coordDriverInvite', driverId:driverId }).then(function(res){
    if(!res.ok){ toast(errText(res)); return; }
    var bg=sheet('<h3>ผูก LINE: '+esc(x.name)+'</h3><div class="muted">ให้คนขับสแกน QR หรือเปิดลิงก์ใน LINE (ใช้ได้ถึง '+thd(res.expiresAt.slice(0,10))+') — '+
      (res.addFriendHint?'คนขับต้อง "เพิ่มเพื่อน" SHIPME OA ด้วย ถึงจะรับข้อความได้':'DEMO: เปิดลิงก์แล้วผูกแบบจำลองได้เลย')+'</div><div id="qr"></div>'+
      '<div class="kv"><span>โค้ด</span><b style="font-size:20px;letter-spacing:2px">'+esc(res.code)+'</b></div>'+
      '<input class="search" readonly value="'+esc(res.link)+'" id="inv-link" style="margin-top:8px">'+
      '<div class="row"><button class="btn btn-ghost" id="inv-copy">คัดลอกลิงก์</button>'+(S.data.smsReady?'<button class="btn btn-amber" id="inv-sms">ส่งทาง SMS</button>':'')+'</div>');
    try { new QRCode(bg.querySelector('#qr'), { text:res.link, width:200, height:200 }); } catch(e){}
    bg.querySelector('#inv-copy').addEventListener('click', function(){ var i=bg.querySelector('#inv-link'); i.select(); try{ navigator.clipboard.writeText(i.value); }catch(e){ document.execCommand('copy'); } toast('คัดลอกแล้ว'); });
    if(bg.querySelector('#inv-sms')) bg.querySelector('#inv-sms').addEventListener('click', function(){
      api({ action:'coordDriverInvite', driverId:driverId, sendSms:true }).then(function(r2){ toast(r2.ok && r2.sms==='sent'?'ส่ง SMS แล้ว (ลิงก์ใหม่)':'ส่ง SMS ไม่สำเร็จ'); });
    });
  });
}
function loadOutbox(){
  api({ action:'coordOutbox', date:S.data.date, staff:S.staff }).then(function(res){
    if(!res.ok){ $('outbox').textContent=errText(res); return; }
    var names={}; S.data.drivers.forEach(function(x){ names[x.id]=x.name; });
    $('outbox').innerHTML=res.rows.length ? '<div class="chat">'+res.rows.map(function(r){
      var m=(r.payload||[])[0]||{}, b=(m.contents||{}), h=(b.header&&b.header.contents||[]), bd=(b.body&&b.body.contents||[]), ft=(b.footer&&b.footer.contents||[]);
      var facts=((h[2]||{}).contents||[]).map(function(t, k){ return '<div style="font-size:'+(k===0&&/งานวันที่/.test(t.text)?'14px;color:#D4A044':'19px;letter-spacing:.5px')+';font-weight:800;margin-top:2px">'+esc(t.text)+'</div>'; }).join('');
      return '<div class="msg"><div class="h"><small>ถึง '+esc(names[r.driverId]||r.driverId)+'</small>'+esc((h[1]||{}).text||m.altText||'')+
        (facts?'<div style="background:#16365F;border-radius:8px;padding:8px 10px;margin-top:6px">'+facts+'</div>':'')+'</div>'+
        '<div class="b">'+bd.map(function(t){ return esc(t.text); }).join('<br>')+'</div>'+
        '<div class="f">'+ft.map(function(x){ var a=x.action||{}; return '<a class="'+(x.style==='primary'?'p':'')+'" href="'+esc(a.uri)+'" target="_blank" rel="noopener">'+esc(a.label)+'</a>'; }).join('')+'</div>'+
        '<div class="meta">'+hm(r.createdAt)+' • '+(r.state==='demo'?'DEMO (ไม่ได้ส่งจริง)':(r.state==='sent'?'ส่งถึง LINE แล้ว':(r.state==='failed'?'ส่งไม่สำเร็จ: '+esc(r.error):r.state)))+'</div></div>';
    }).join('')+'</div>' : 'ยังไม่มีข้อความ';
  });
}


// ---------------- นัดหมาย ----------------
var MEET_ST={ PROPOSED:['ส่งนัดแล้ว','wait'], ARRIVED:['คนขับถึงจุดแล้ว','ok'], ACCEPTED:['คนขับรับนัดแล้ว','ok'], RESCHEDULE_REQUESTED:['ขอเลื่อน/เปลี่ยน','bad'], MET:['ส่งมอบแล้ว','ok'], CANCELLED:['ยกเลิก',''] };
function fmtLocal(d){ var p=function(n){ return String(n).padStart(2,'0'); }; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes()); }
function meetingList(){
  var ms=(S.data.meetings||[]).filter(function(m){ return m.status!=='CANCELLED'; });
  if(!ms.length) return '';
  var names={}; S.data.drivers.forEach(function(x){ names[x.id]=x.name; });
  return '<div class="card group"><h4>📅 นัดหมาย</h4>'+ms.map(function(m){
    var st=MEET_ST[m.status]||[m.status,''];
    return '<div class="pick" style="display:block"><div class="row"><b class="grow">'+esc(names[m.driverId]||'')+' • '+(m.phase==='CARD_PICKUP'?'รับการ์ด':'รับ EIR')+'</b><span class="stage '+st[1]+'">'+st[0]+'</span></div>'+
      '<div class="muted">📍 '+esc(m.label)+'</div>'+
      (m.arrivedAt?'<div class="muted" style="color:var(--ok)">ถึงจุดแล้ว '+hm(m.arrivedAt)+(m.arrivedDistanceM!=null?' • ห่างจุดนัด ~'+Math.round(m.arrivedDistanceM)+' ม.':'')+'</div>':'')+
      (['PROPOSED','ACCEPTED','RESCHEDULE_REQUESTED','ARRIVED'].indexOf(m.status)>=0?'<div class="row" style="gap:6px;margin-top:6px">'+handoverBtn(m)+
        '<button class="btn btn-ghost btn-sm" data-mcancel="'+esc(m.id)+'">ยกเลิกนัด</button></div>':'')+'</div>';
  }).join('')+'</div>';
}
/** ปุ่มบันทึกส่งมอบของนัดนั้น (แจกการ์ด / ส่งมอบ EIR) — ตู้ในนัดที่ยังไม่ได้บันทึก */
function handoverBtn(m){
  var card=m.phase==='CARD_PICKUP';
  var ids=m.itemIds.filter(function(id){ var i=S.data.items.filter(function(x){ return x.id===id; })[0]; var s=(i&&i.step)||{}; return i && (card ? !(s.cardHandedAt||s.cardAckAt) : !s.eirHandedAt && !s.completedAt); });
  return ids.length ? '<button class="btn '+(card?'btn-amber':'btn-green')+' btn-sm grow" data-handover="'+(card?'card':'eir')+'" data-ids="'+esc(ids.join(','))+'">'+(card?'🎫 แจกการ์ดแล้ว':'📄 ส่งมอบ EIR แล้ว')+' ('+ids.length+')</button>' : '';
}
/** คนขับที่กด "ถึงจุดนัดหมายแล้ว" แต่ชิปปิ้งยังไม่บันทึกส่งมอบ */
function arrivals(){
  return (S.data.meetings||[]).filter(function(m){ return m.status==='ARRIVED' && handoverBtn(m); });
}
function arrivalsCard(){
  var list=arrivals(); if(!list.length) return '';
  var names={}; S.data.drivers.forEach(function(x){ names[x.id]=x.name; });
  return '<div class="card" id="arrivals" style="border:2px solid var(--green)"><h4 style="margin:0 0 6px;color:var(--ok)">📍 คนขับถึงจุดนัดแล้ว</h4>'+list.map(function(m){
    return '<div class="pick" style="display:block"><b>'+esc(names[m.driverId]||'')+'</b> <span class="muted">• '+(m.phase==='CARD_PICKUP'?'รอรับการ์ด':'รอรับ EIR')+' • ถึง '+hm(m.arrivedAt)+'</span>'+
      '<div class="muted">📍 '+esc(m.label)+'</div><div class="row" style="margin-top:6px">'+handoverBtn(m)+'</div></div>';
  }).join('')+'</div>';
}
function bindArrivals(root){
  Array.prototype.forEach.call(root.querySelectorAll('[data-handover]'), function(b){ b.addEventListener('click', function(e){
    e.stopPropagation();
    blAction(b.getAttribute('data-handover'), b.getAttribute('data-ids').split(','), '', b);
  }); });
}
function meetingForm(driverId, replace){
  var d=S.data, x=d.drivers.filter(function(y){ return y.id===driverId; })[0]; if(!x) return;
  var loc=x.phases[S.phase].location, mps=(d.meetingPoints||[]).slice();
  var dist=function(p){ if(!loc) return 0; var dx=(p.latitude-loc.lat)*111, dy=(p.longitude-loc.lng)*111*Math.cos(loc.lat*Math.PI/180); return Math.sqrt(dx*dx+dy*dy); };
  mps.sort(function(a,b){ return dist(a)-dist(b); });
  var t=new Date(Date.now()+15*60000); t.setMinutes(Math.ceil(t.getMinutes()/5)*5);
  var jobs=d.items.filter(function(i){ return x.itemIds.indexOf(i.id)>=0; });
  var bg=sheet('<h3>📅 นัด'+(S.phase==='EIR_HANDOVER'?'ส่งมอบ EIR':'แจกการ์ดรับตู้')+' — '+esc(x.name)+'</h3>'+
    '<div class="seg" id="mf-mode"><button data-v="STAFF_TO_DRIVER" class="on">ชิปปิ้งไปหา</button><button data-v="DRIVER_TO_STAFF">คนขับมาหา</button></div>'+
    '<label class="muted">จุดนัด</label><select id="mf-point" class="search">'+(loc?'<option value="">ตำแหน่งที่คนขับส่งมา ('+hm(loc.at)+')</option>':'')+
      mps.map(function(p){ return '<option value="'+esc(p.id)+'">'+esc(p.name)+(p.port?' ('+esc(p.port)+')':'')+(loc?' • '+dist(p).toFixed(1)+' กม.':'')+'</option>'; }).join('')+'</select>'+
    '<label class="muted">เวลานัด</label><input id="mf-time" type="datetime-local" class="search" value="'+fmtLocal(t)+'">'+
    '<label class="muted">ตู้ในนัดนี้</label>'+jobs.map(function(i){ return '<label class="pick"><input type="checkbox" class="mf-item" value="'+esc(i.id)+'" checked><div class="grow"><b>'+esc(i.containerNo||i.bl)+'</b></div>'+stageChip(i.stage)+'</label>'; }).join('')+
    '<label class="muted">หมายเหตุถึงคนขับ (ไม่บังคับ)</label><input id="mf-note" class="search" placeholder="เช่น จอดหน้าป้อม รปภ.">'+
    '<button class="btn btn-green" id="mf-send">ส่งการ์ดนัดทาง LINE</button>');
  var mode='STAFF_TO_DRIVER';
  Array.prototype.forEach.call(bg.querySelectorAll('#mf-mode button'), function(b){ b.addEventListener('click', function(){
    mode=b.getAttribute('data-v'); Array.prototype.forEach.call(bg.querySelectorAll('#mf-mode button'), function(o){ o.classList.toggle('on', o===b); });
  }); });
  bg.querySelector('#mf-send').addEventListener('click', function(){
    var point=bg.querySelector('#mf-point').value;
    if(!point && !loc){ toast('เลือกจุดนัด'); return; }
    if(mode==='DRIVER_TO_STAFF' && !point){ toast('คนขับมาหา ต้องเลือกจุดนัดที่ผู้จัดการปักไว้'); return; }
    var ids=Array.prototype.map.call(bg.querySelectorAll('.mf-item:checked'), function(c){ return c.value; });
    if(!ids.length){ toast('เลือกตู้อย่างน้อย 1 ตู้'); return; }
    var btn=this; btn.disabled=true;
    api({ action:'coordMeetingCreate', date:d.date, staff:S.staff, phase:S.phase, driverId:x.id, mode:mode, meetingPointId:point,
          scheduledAt:new Date(bg.querySelector('#mf-time').value).toISOString(), itemIds:ids, note:bg.querySelector('#mf-note').value, replace:!!replace }).then(function(r){
      btn.disabled=false;
      if(!r.ok){
        if(r.error==='meeting_confirmed_exists'){ if(confirm(x.name+' รับนัดเดิมไว้แล้ว — ส่งนัดใหม่แทน? (คนขับจะได้ข้อความใหม่)')){ bg.remove(); meetingForm(driverId, true); } return; }
        toast(r.error==='staff_overlap'?'ชนกับนัดอื่นที่คุณต้องไปตอน '+hm(r.at)+' ('+r.label+')':(MEET_ERR[r.error]||errText(r)), 4000); return;
      }
      bg.remove(); toast(r.sent==='sent'||r.sent==='demo'?'ส่งการ์ดนัดทาง LINE แล้ว':(r.sent==='sms'?'ส่งนัดทาง SMS แล้ว':'บันทึกนัดแล้ว (คนขับยังไม่ผูก LINE — โทรแจ้ง)'), 3500); load(true);
    });
  });
}
var MEET_ERR={ not_scanned:'ตู้นี้คนขับยังไม่กด "เข้า Fast Scan แล้ว"', no_location:'คนขับยังไม่ส่งพิกัดรอบนี้ — เลือกจุดนัดแทน', point_not_found:'ไม่พบจุดนัด', no_items:'ไม่มีตู้ที่ต้องส่งมอบ', bad_time:'เวลาไม่ถูกต้อง',
  start_required:'เลือกจุดเริ่ม', no_locations:'ยังไม่มีคนขับส่งพิกัดรอบนี้', no_meeting_points:'ยังไม่มีจุดนัดพบ — ให้ผู้จัดการปักในตั้งค่าระบบ',
  INFEASIBLE:'หาเส้นทางที่ไปได้ไม่พบ', routes_failed:'Google Routes คำนวณไม่ได้', already_confirmed:'แผนนี้ยืนยันไปแล้ว', route_expired:'แผนนี้เก่าเกิน 30 นาที คำนวณใหม่' };

// ---------------- วางเส้นทาง ----------------
function planRoute(allowEstimate){
  var d=S.data, sv=$('rt-start').value, btn=$('rt-calc');
  var go2=function(start){
    btn.disabled=true; $('rt-out').innerHTML='<div class="muted" style="margin-top:8px">กำลังคำนวณ…</div>';
    api({ action:'coordRoutePlan', date:d.date, staff:S.staff, phase:S.phase, start:start, policy:$('rt-policy').value, allowEstimate:allowEstimate===true }).then(function(r){
      btn.disabled=false;
      if(!r.ok){
        if(r.error==='routes_failed'){ $('rt-out').innerHTML='<div class="gate closed" style="margin-top:8px">คำนวณเส้นทางไม่ได้: '+esc(r.detail||'')+'<br><button class="btn btn-ghost btn-sm" id="rt-est" style="margin-top:6px">ใช้เวลาประมาณการจากระยะทางแทน</button></div>';
          $('rt-est').addEventListener('click', function(){ planRoute(true); }); return; }
        $('rt-out').innerHTML='<div class="gate closed" style="margin-top:8px">'+esc(MEET_ERR[r.error]||errText(r))+(r.missing&&r.missing.length?'<br>ยังไม่ส่งพิกัด: '+esc(r.missing.map(function(m){ return m.name; }).join(', ')):'')+'</div>'; return;
      }
      S.route=r; renderRoute(); if(S.mapMode==='map') drawMap();
    }).catch(function(){ btn.disabled=false; toast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); });
  };
  if(sv==='gps'){
    if(!navigator.geolocation){ toast('เบราว์เซอร์ไม่รองรับตำแหน่ง'); return; }
    btn.disabled=true; $('rt-out').innerHTML='<div class="muted" style="margin-top:8px">กำลังหาตำแหน่งของคุณ…</div>';
    navigator.geolocation.getCurrentPosition(function(p){ go2({ lat:p.coords.latitude, lng:p.coords.longitude }); },
      function(){ btn.disabled=false; $('rt-out').innerHTML='<div class="gate closed" style="margin-top:8px">หาตำแหน่งของคุณไม่ได้ — เลือกจุดเริ่มเป็นจุดนัดพบแทน</div>'; }, { enableHighAccuracy:true, timeout:15000 });
  } else {
    var p=(d.meetingPoints||[]).filter(function(x){ return x.id===sv; })[0];
    go2({ lat:p.latitude, lng:p.longitude });
  }
}
function mins(sec){ return Math.round((sec||0)/60); }
function renderRoute(){
  var r=S.route, el=$('rt-out'); if(!el || !r) return;
  var t=r.totals||{};
  el.innerHTML='<div style="margin-top:10px">'+(r.source==='ESTIMATE'?'<div class="gate closed" style="font-size:13px">⚠️ เวลาเป็นค่าประมาณจากระยะทาง ไม่ใช่ผลจาก Google Routes — ใช้ดูลำดับเป็นหลัก</div>':'<span class="stage ok">ผลจาก Google Routes</span>')+
    '<div class="counters"><span class="cnt">ชิปปิ้งเดินทาง ~'+mins(t.staffTravelSeconds)+' นาที</span><span class="cnt">คนขับเดินทาง ~'+mins(t.driverIncrementalTravelSeconds)+' นาที</span>'+
    '<span class="cnt">รอรวม ~'+mins((t.staffWaitingSeconds||0)+(t.driverWaitingSeconds||0))+' นาที</span></div>'+
    '<div class="muted" style="margin:6px 0 4px;font-size:12px">แผนที่: '+(r.polyline?'เส้นทึบ = เส้นทางถนนจริง':'เส้นประ = เส้นตรงเชื่อมจุด (ไม่ใช่เส้นถนน)')+' • ลูกศรบอกลำดับ • ป้ายบนเส้น = นาทีของช่วงนั้น • เส้นประเขียว = คนขับมาหาที่จุดนัด</div>'+
    r.stops.map(function(s){
      return '<div class="pick" style="display:block"><div class="row"><b class="grow">'+s.seq+'. '+esc(s.label)+'</b><span class="stage blue">'+hm(s.eta)+' น.</span></div>'+
        s.drivers.map(function(x){ return '<div class="muted">👤 '+esc(x.name)+' • '+(x.mode==='STAFF_TO_DRIVER'?'ชิปปิ้งไปหา':'คนขับมาหา ~'+mins(x.travelSeconds)+' นาที')+' • '+esc(x.containers.join(', '))+'</div>'; }).join('')+'</div>';
    }).join('')+
    (r.missing&&r.missing.length?'<div class="muted" style="margin-top:6px">ยังไม่ส่งพิกัด (ไม่ได้อยู่ในแผน): '+esc(r.missing.map(function(m){ return m.name; }).join(', '))+'</div>':'')+
    '<button class="btn btn-green" id="rt-confirm" style="margin-top:10px">✅ ยืนยันแผนและส่งการ์ดนัดทาง LINE</button></div>';
  $('rt-confirm').addEventListener('click', function(){
    if(!confirm('ส่งการ์ดนัดให้คนขับ '+r.stops.reduce(function(n,s){ return n+s.drivers.length; },0)+' คน ตามลำดับนี้?')) return;
    var b=this; b.disabled=true;
    api({ action:'coordRouteConfirm', staff:S.staff, runId:r.runId }).then(function(res){
      b.disabled=false;
      if(!res.ok){ toast(MEET_ERR[res.error]||errText(res), 3500); return; }
      toast('ส่งนัดแล้ว '+res.made.length+' คน'+(res.skipped.length?' • ข้าม '+res.skipped.length+' คน (รับนัดเดิมแล้ว)':''), 4000);
      S.route=null; load(true); go('status');
    });
  });
}
