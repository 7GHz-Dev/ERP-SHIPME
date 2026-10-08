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
  XRAY_BATCH_NOT_READY:'ยังมีตู้ที่ไม่ผ่าน X-Ray ครบทุกงาน', plan_not_confirmed:'แพลนวันนี้ยังไม่ได้ Confirm', no_recipients:'ไม่มีคนขับที่ส่งได้',
  forbidden:'ไม่มีสิทธิ์', bad_date:'วันที่ไม่ถูกต้อง', demo_only:'ใช้ได้เฉพาะ DEMO MODE', session_expired:'หมดเวลา กรุณาเข้าสู่ระบบใหม่',
  invalid_token:'กรุณาเข้าสู่ระบบใหม่', no_token:'กรุณาเข้าสู่ระบบ'
};
function errText(res){ return ERR[res.error]||res.error||'ไม่สำเร็จ'; }

var STAGE = {
  PLANNED:['รอการ์ด',''], CARD_HANDED:['ได้การ์ดแล้ว','blue'], PICKED_UP:['รับตู้แล้ว','blue'], XRAY_WAITING:['รอ X-Ray','wait'],
  XRAY_HOLD:['ติดปัญหา X-Ray','bad'], XRAY_PASSED:['ผ่าน X-Ray','ok'], EIR_HANDED:['ส่งมอบ EIR แล้ว','ok'],
  EIR_RECEIVED:['รอรูปปิดงาน','wait'], DONE:['จบงาน ✓','ok']
};
function stageChip(st){ var s=STAGE[st]||[st,'']; return '<span class="stage '+s[1]+'">'+esc(s[0])+'</span>'; }

// ---------------- เริ่มต้น ----------------
(function init(){
  try { var s=JSON.parse(localStorage.getItem('ci_sess')||'null'); if(s&&s.token){ S.token=s.token; S.user=s.user; } } catch(e){}
  if(!S.token){ location.href='/?next=staff'; return; }
  var q=new URLSearchParams(location.search);
  S.staff=q.get('staff')||''; S.date=q.get('date')||'';
  Array.prototype.forEach.call(document.querySelectorAll('nav.tabs button'), function(b){ b.addEventListener('click', function(){ go(b.getAttribute('data-tab')); }); });
  Array.prototype.forEach.call(document.querySelectorAll('#phase-seg button'), function(b){ b.addEventListener('click', function(){ S.phase=b.getAttribute('data-phase'); renderMap(); }); });
  Array.prototype.forEach.call(document.querySelectorAll('#mapmode-seg button'), function(b){ b.addEventListener('click', function(){ S.mapMode=b.getAttribute('data-mode'); renderMap(); }); });
  $('btn-refresh').addEventListener('click', function(){ load(); });
  $('dates').addEventListener('click', function(e){ var b=e.target.closest('[data-date]'); if(b){ S.date=b.getAttribute('data-date'); load(); } });
  document.addEventListener('visibilitychange', function(){ if(!document.hidden) load(true); });
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
function nextAction(){
  var d=S.data, c=d.counts;
  if(!c.jobs) return null;
  if(!hasRequests('CARD_PICKUP')) return { label:'📍 ขอตำแหน่งรอบแรก', fn:function(){ S.phase='CARD_PICKUP'; go('map'); } };
  if(c.cardHanded<c.jobs) return { label:'🎫 บันทึกแจกการ์ด ('+c.cardHanded+'/'+c.jobs+')', fn:function(){ go('status'); } };
  if(!d.gate.ready) return { label:'⏳ ดูความคืบหน้า X-Ray ('+d.gate.passed+'/'+d.gate.total+')', fn:function(){ go('status'); }, ghost:true };
  if(!hasRequests('EIR_HANDOVER')) return { label:'📍 ขอตำแหน่งรอบสอง (EIR)', fn:function(){ S.phase='EIR_HANDOVER'; go('map'); } };
  if(c.eirHanded<c.jobs) return { label:'📄 ยืนยันแจก EIR ('+c.eirHanded+'/'+c.jobs+')', fn:function(){ go('status'); } };
  if(c.completed<c.jobs) return { label:'📷 ติดตามรูป EIR + Seal ('+c.completed+'/'+c.jobs+')', fn:function(){ go('status'); }, ghost:true };
  return { label:'✅ จบงานครบทุกตู้แล้ว', fn:function(){ go('status'); }, done:true };
}

// ---------------- แผนงาน ----------------
function renderPlan(){
  var d=S.data, c=d.counts;
  if(!c.jobs){
    $('plan-body').innerHTML='<div class="card center">'+(d.planStatus && d.planStatus!=='confirmed' ? 'แพลนวันที่ '+thd(d.date)+' ยังไม่ได้ Confirm' : 'ไม่มีงานของคุณในวันที่ '+thd(d.date))+'</div>';
    return;
  }
  var waitGps=d.drivers.filter(function(x){ var r=x.phases.CARD_PICKUP.request; return r && !x.phases.CARD_PICKUP.location; }).length;
  var unlinked=d.drivers.filter(function(x){ return !x.linked; });
  var bar=function(label, n, total){ var p=total?Math.round(n*100/total):0;
    return '<div class="bar'+(n>=total&&total?' done':'')+'"><div class="lbl"><span>'+label+'</span><b>'+n+'/'+total+'</b></div><div class="track"><div class="fill" style="width:'+p+'%"></div></div></div>'; };
  var na=nextAction();
  var html='<div class="card"><div class="kpis">'+
      '<div class="kpi"><div class="n">'+c.jobs+'</div><div class="l">งาน / ตู้</div></div>'+
      '<div class="kpi"><div class="n">'+c.drivers+'</div><div class="l">คนขับ</div></div>'+
      '<div class="kpi"><div class="n">'+waitGps+'</div><div class="l">รอ GPS</div></div></div>'+
    '<div class="bars">'+bar('แจกการ์ดรับตู้', c.cardHanded, c.jobs)+bar('รับตู้แล้ว', c.pickedUp, c.jobs)+bar('ผ่าน X-Ray', c.xrayPassed, c.jobs)+
      bar('แจก EIR แล้ว', c.eirHanded, c.jobs)+bar('ส่งรูปจบงาน', c.completed, c.jobs)+'</div></div>';
  if(na) html+='<button class="btn cta '+(na.done?'btn-green':(na.ghost?'btn-navy':'btn-amber'))+'" id="cta">'+esc(na.label)+'</button>';
  if(unlinked.length){
    html+='<div class="card" style="background:#fff7ed"><b style="color:#9a3412">⚠️ ยังไม่ผูก LINE '+unlinked.length+' คน</b><div class="muted" style="margin-top:4px">'+
      esc(unlinked.map(function(x){ return x.name; }).join(', '))+' — ส่งข้อความทาง LINE ไม่ได้ '+(d.smsReady?'(จะส่งทาง SMS แทน)':'')+
      '</div><button class="btn btn-ghost btn-sm" style="margin-top:8px" id="go-link">ผูก LINE คนขับ</button></div>';
  }
  if(d.noDriverPhone.length) html+='<div class="card" style="background:var(--redbg);color:var(--red)">ไม่มีเบอร์มือถือคนขับ: '+esc(d.noDriverPhone.join(', '))+' — ให้ผู้จัดการเพิ่มในแพลน</div>';
  html+='<div class="card"><input class="search" id="q" placeholder="ค้นหา เลขตู้ / BL / คนขับ / ท่า" value="'+esc(S.q||'')+'"><div id="jobs"></div></div>';
  $('plan-body').innerHTML=html;
  if(na) $('cta').addEventListener('click', na.fn);
  if($('go-link')) $('go-link').addEventListener('click', function(){ go('more'); });
  $('q').addEventListener('input', function(){ S.q=this.value; renderJobs(); });
  renderJobs();
}
function renderJobs(){
  var q=String(S.q||'').toLowerCase();
  var list=S.data.items.filter(function(i){ return !q || (i.containerNo+' '+i.bl+' '+i.driverName+' '+i.port).toLowerCase().indexOf(q)>=0; });
  $('jobs').innerHTML=list.map(function(i, k){
    return '<div class="job" data-item="'+esc(i.id)+'"><div class="no">'+(k+1)+'</div><div class="grow"><div class="cn">'+esc(i.containerNo||i.bl)+'</div>'+
      '<div class="sub">'+esc(i.port||'-')+(i.destination?' → '+esc(i.destination):'')+' • 👤 '+esc(i.driverName||'-')+'</div></div>'+stageChip(i.stage)+'</div>';
  }).join('') || '<div class="center">ไม่พบงาน</div>';
  Array.prototype.forEach.call($('jobs').querySelectorAll('[data-item]'), function(el){ el.addEventListener('click', function(){ openJob(el.getAttribute('data-item')); }); });
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
  var locked=eir && !d.gate.ready;
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
  $('map-req').innerHTML=html;
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
function drawMap(){
  var d=S.data, box=$('map');
  if(!d.mapsKey){
    box.innerHTML='<div class="map-empty">ยังไม่ได้ตั้งค่า Google Maps (GOOGLE_MAPS_BROWSER_KEY)<br>ดูพิกัดในแท็บ "รายชื่อ" และกดเปิด Google Maps ทีละคนได้</div>';
    return;
  }
  if(!window.google || !google.maps){
    if(!S.mapsLoading){
      S.mapsLoading=true;
      window.__gmReady=function(){ drawMap(); };
      var s=document.createElement('script');
      s.src='https://maps.googleapis.com/maps/api/js?key='+encodeURIComponent(d.mapsKey)+'&callback=__gmReady&loading=async&language=th&region=TH';
      s.async=true; s.onerror=function(){ box.innerHTML='<div class="map-empty">โหลด Google Maps ไม่สำเร็จ</div>'; };
      document.head.appendChild(s);
    }
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
      icon:{ path:google.maps.SymbolPath.CIRCLE, scale:7, fillColor:'#0D2748', fillOpacity:1, strokeColor:'#FFB020', strokeWeight:3 } });
    S.markers.push(m);
  });
  if(n===1){ S.gmap.setCenter(bounds.getCenter()); S.gmap.setZoom(15); } else if(n>1) S.gmap.fitBounds(bounds, 40);
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
    '<div class="kv"><span>LINE</span><b>'+(x.linked?(x.demoLinked?'ผูกแล้ว (DEMO)':'ผูกแล้ว'+(x.friend?'':' • ยังไม่ได้เพิ่มเพื่อน OA')):'ยังไม่ผูก')+'</b></div>';
  ['CARD_PICKUP','EIR_HANDOVER'].forEach(function(ph){
    var l=x.phases[ph].location, r=x.phases[ph].request;
    html+='<div class="kv"><span>'+(ph==='CARD_PICKUP'?'พิกัดรอบแรก':'พิกัดรอบสอง')+'</span><b>'+
      (l?('<a target="_blank" rel="noopener" href="https://www.google.com/maps?q='+l.lat+','+l.lng+'">'+hm(l.at)+' ('+ago(l.ageMin)+')</a>'+(l.accuracy?'<br><small>±'+Math.round(l.accuracy)+' ม.</small>':''))
        :(r?(r.status==='failed'?'ส่งไม่สำเร็จ':(r.expired?'คำขอหมดอายุ':'รอคำตอบ')):'—'))+'</b></div>';
  });
  html+='<div style="margin:12px 0 4px"><b>ตู้ของคนขับคนนี้</b></div>'+jobs.map(function(i){ return '<div class="job"><div class="grow"><div class="cn">'+esc(i.containerNo||i.bl)+'</div><div class="sub">'+esc(i.port)+'</div></div>'+stageChip(i.stage)+'</div>'; }).join('');
  html+='<div class="row" style="margin-top:12px"><a class="btn btn-ghost" style="text-align:center;text-decoration:none" href="tel:'+esc(x.phone)+'">📞 โทร</a>'+
    '<button class="btn btn-amber" id="sh-req">ขอพิกัดอีกครั้ง</button></div>';
  var bg=sheet(html);
  bg.querySelector('#sh-req').addEventListener('click', function(){ bg.remove(); requestLocations([x.id]); });
}
function openJob(itemId){
  var i=S.data.items.filter(function(x){ return x.id===itemId; })[0]; if(!i) return;
  var s=i.step||{};
  var row=function(label, v){ return '<div class="kv"><span>'+label+'</span><b>'+(v||'—')+'</b></div>'; };
  var html='<h3>📦 '+esc(i.containerNo||i.bl)+'</h3>'+row('BL', esc(i.bl))+row('ท่า / ปลายทาง', esc(i.port)+' → '+esc(i.destination||'-'))+
    row('คนขับ', esc(i.driverName)+' • '+esc(i.plate||''))+
    row('แจกการ์ด', s.cardHandedAt?hm(s.cardHandedAt)+' (ชิปปิ้ง)':(s.cardAckAt?hm(s.cardAckAt)+' (คนขับยืนยัน)':''))+
    row('รับตู้', hm(s.pickedUpAt))+row('X-Ray', s.xrayStatus==='passed'?'ผ่าน '+hm(s.xrayAt)+' <small>(คนขับรายงาน)</small>':(s.xrayStatus==='hold'?'ติดปัญหา':(s.xrayStatus==='waiting'?'รอคิว':'')))+
    row('ส่งมอบ EIR', hm(s.eirHandedAt))+row('คนขับรับ EIR', hm(s.eirReceivedAt))+row('จบงาน', s.completedAt?hm(s.completedAt)+' <small>(คนขับส่ง)</small>':'')+
    (s.problem?row('ปัญหา', esc(s.problem)):'')+evidenceThumbs(i)+
    '<div style="margin-top:12px"><b>ประวัติ</b><div id="tl" class="muted">กำลังโหลด…</div></div>';
  sheet(html);
  api({ action:'coordTimeline', itemId:itemId }).then(function(res){
    var el=$('tl'); if(!el) return;
    el.innerHTML=res.ok && res.rows.length ? res.rows.map(function(r){ return '<div class="kv"><span>'+hm(r.createdAt)+' • '+esc(r.actorType)+'</span><b style="font-weight:600">'+esc(r.event)+'</b></div>'; }).join('') : 'ยังไม่มีประวัติ';
  });
}
function evidenceThumbs(i){
  var one=function(kind, label){
    var f=(i.evidence||[]).filter(function(e){ return e.kind===kind; });
    return f.length ? f.map(function(e){ return '<a class="thumb" href="'+esc(e.url)+'" target="_blank" rel="noopener"><img src="'+esc(e.url)+'" alt="'+label+'" loading="lazy"></a>'; }).join('')
      : '<div class="thumb">ยังไม่มี<br>'+label+'</div>';
  };
  return '<div class="thumbs">'+one('EIR_CARD_PHOTO','การ์ด EIR')+one('CONTAINER_SEAL_PHOTO','Seal')+'</div>';
}

// ---------------- สถานะงาน ----------------
function renderStatus(){
  var d=S.data, items=d.items;
  if(!items.length){ $('status-body').innerHTML='<div class="card center">ไม่มีงาน</div>'; return; }
  var html=d.gate.ready
    ? '<div class="gate open">✅ ผ่าน X-Ray ครบ <b>'+d.gate.total+'/'+d.gate.total+'</b> ตู้ — ขอพิกัดรอบสองและแจก EIR ได้</div>'
    : '<div class="gate closed">⏳ ผ่าน X-Ray <b>'+d.gate.passed+'/'+d.gate.total+'</b> ตู้<br><span style="font-size:13px">ยังไม่ผ่าน: '+
      esc(d.gate.blockers.map(function(b){ return b.containerNo+' ('+b.driverName+(b.pickedUp?'':' • ยังไม่รับตู้')+')'; }).join(', '))+'</span></div>';

  var needCard=items.filter(function(i){ return !(i.step&&(i.step.cardHandedAt||i.step.cardAckAt)); });
  html+=pickCard('card', '🎫 แจกการ์ดรับตู้', 'ติ๊กตู้ที่แจกการ์ดแล้ว (บันทึกแยกทีละตู้ คนขับคนเดียวหลายใบติ๊กทุกตู้)', needCard, 'บันทึกแจกการ์ดแล้ว', false);

  var groups=[['ยังไม่รับตู้', function(i){ return !(i.step&&i.step.pickedUpAt); }], ['รับตู้แล้ว / รอ X-Ray', function(i){ return i.step&&i.step.pickedUpAt&&i.step.xrayStatus!=='passed'&&i.step.xrayStatus!=='hold'; }],
    ['มีปัญหา', function(i){ return i.step&&(i.step.xrayStatus==='hold'||i.step.problem); }], ['ผ่าน X-Ray แล้ว', function(i){ return i.step&&i.step.xrayStatus==='passed'; }]];
  html+='<div class="card group"><h4>📦 สถานะจากคนขับ</h4>'+groups.map(function(g){
    var list=items.filter(g[1]); if(!list.length) return '';
    return '<div class="muted" style="margin:8px 0 2px;font-weight:700">'+g[0]+' ('+list.length+')</div>'+list.map(jobLine).join('');
  }).join('')+'</div>';

  var needEir=items.filter(function(i){ return !(i.step&&i.step.eirHandedAt); });
  html+=pickCard('eir', '📄 ส่งมอบ EIR (ชิปปิ้ง → คนขับ)', d.gate.ready ? 'ติ๊กตู้ที่ส่งมอบ EIR ให้คนขับแล้ว — คนขับต้องกดยืนยันรับเองอีกครั้ง' : 'เปิดเมื่อทุกตู้ผ่าน X-Ray', needEir, 'บันทึกส่งมอบ EIR แล้ว', !d.gate.ready);

  var done=items.filter(function(i){ return i.step&&i.step.completedAt; }).length;
  html+='<div class="card group"><h4>📷 รูปปิดงาน (การ์ด EIR + Seal) — คนขับส่งครบ '+done+'/'+items.length+' ตู้</h4>'+items.map(function(i){
    var s=i.step||{};
    var st = s.completedAt ? '<span class="stage ok">จบงาน '+hm(s.completedAt)+'</span>' : (s.eirReceivedAt?'<span class="stage wait">รอรูป</span>':'<span class="stage">ยังไม่ถึงขั้นนี้</span>');
    return '<div class="pick" style="display:block"><div class="row"><b class="grow">'+esc(i.containerNo||i.bl)+'</b>'+st+'</div><div class="muted">👤 '+esc(i.driverName)+'</div>'+evidenceThumbs(i)+'</div>';
  }).join('')+'</div>';
  $('status-body').innerHTML=html;
  bindPick('card'); bindPick('eir');
  Array.prototype.forEach.call($('status-body').querySelectorAll('[data-item]'), function(el){ el.addEventListener('click', function(){ openJob(el.getAttribute('data-item')); }); });
}
function jobLine(i){
  return '<div class="job" data-item="'+esc(i.id)+'"><div class="grow"><div class="cn">'+esc(i.containerNo||i.bl)+'</div><div class="sub">👤 '+esc(i.driverName)+
    (i.step&&i.step.problem?' • ⚠️ '+esc(i.step.problem):'')+'</div></div>'+stageChip(i.stage)+'</div>';
}
function pickCard(kind, title, hint, list, btn, locked){
  if(!list.length) return '<div class="card"><h4 style="margin:0;color:var(--ok)">'+title+' — ครบทุกตู้แล้ว ✓</h4></div>';
  return '<div class="card group"><h4>'+title+' ('+list.length+' ตู้ค้าง)</h4><div class="muted" style="margin-bottom:6px">'+hint+'</div>'+
    list.map(function(i){
      return '<label class="pick"><input type="checkbox" class="pk-'+kind+'" value="'+esc(i.id)+'"'+(locked?' disabled':'')+'><div class="grow"><b>'+esc(i.containerNo||i.bl)+'</b>'+
        '<div class="muted">👤 '+esc(i.driverName)+' • '+esc(i.port)+'</div></div>'+stageChip(i.stage)+'</label>';
    }).join('')+'<button class="btn '+(kind==='eir'?'btn-green':'btn-amber')+'" id="pk-'+kind+'-btn" style="margin-top:10px" disabled>'+btn+'</button></div>';
}
function bindPick(kind){
  var btn=$('pk-'+kind+'-btn'); if(!btn) return;
  var boxes=document.querySelectorAll('.pk-'+kind);
  var upd=function(){ var n=document.querySelectorAll('.pk-'+kind+':checked').length; btn.disabled=!n; btn.textContent=(kind==='card'?'บันทึกแจกการ์ดแล้ว':'บันทึกส่งมอบ EIR แล้ว')+(n?' ('+n+' ตู้)':''); };
  Array.prototype.forEach.call(boxes, function(b){ b.addEventListener('change', upd); });
  btn.addEventListener('click', function(){
    var ids=Array.prototype.map.call(document.querySelectorAll('.pk-'+kind+':checked'), function(b){ return b.value; });
    if(!ids.length) return;
    btn.disabled=true;
    api({ action: kind==='card'?'coordCardHanded':'coordEirHanded', date:S.data.date, staff:S.staff, itemIds:ids }).then(function(res){
      if(!res.ok){ btn.disabled=false; toast(res.error==='XRAY_BATCH_NOT_READY'?'ยังผ่าน X-Ray ไม่ครบทุกตู้':errText(res), 3500); return; }
      toast('บันทึกแล้ว '+res.count+' ตู้'); load(true);
    });
  });
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
      return '<div class="msg"><div class="h"><small>ถึง '+esc(names[r.driverId]||r.driverId)+'</small>'+esc((h[1]||{}).text||m.altText||'')+'</div>'+
        '<div class="b">'+bd.map(function(t){ return esc(t.text); }).join('<br>')+'</div>'+
        '<div class="f">'+ft.map(function(x){ var a=x.action||{}; return '<a class="'+(x.style==='primary'?'p':'')+'" href="'+esc(a.uri)+'" target="_blank" rel="noopener">'+esc(a.label)+'</a>'; }).join('')+'</div>'+
        '<div class="meta">'+hm(r.createdAt)+' • '+(r.state==='demo'?'DEMO (ไม่ได้ส่งจริง)':(r.state==='sent'?'ส่งถึง LINE แล้ว':(r.state==='failed'?'ส่งไม่สำเร็จ: '+esc(r.error):r.state)))+'</div></div>';
    }).join('')+'</div>' : 'ยังไม่มีข้อความ';
  });
}
