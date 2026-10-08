/**
 * งานปล่อย (พนักงานจัดส่ง) — งานจากแพลนที่ผู้จัดการ Confirm แล้ว + ส่ง SMS หาคนขับรถผ่าน ThaiBulkSMS
 *
 * SMS ไม่มีสถานะ "อ่านแล้ว" จริง — ระบบแนบลิงก์ของเราไว้แล้วนับว่า "เปิดอ่าน" เมื่อคนขับกดลิงก์
 * ลิงก์ขอตำแหน่งคนขับได้ และใส่รูปแผนที่นัดหมายเป็นรูปตัวอย่าง (thumbnail) ของลิงก์
 *
 * ใช้ $, api, state, esc, toast, show, resumeCheckin, stopCamera จากสคริปต์หลักของ index.html
 */
var rl = { date:'', data:null, picked:{}, kind:'appoint', texts:{}, timer:null, sending:false };

var RL_ERR = {
  sms_not_configured:'ระบบยังไม่ได้ตั้งค่า ThaiBulkSMS — ใช้ปุ่ม “📱 ส่งจากเครื่อง” แทน',
  no_valid_phone:'แถวที่เลือกไม่มีเบอร์มือถือที่ส่ง SMS ได้', plan_not_confirmed:'แพลนวันนี้ถูกยกเลิก Confirm แล้ว',
  no_items:'ยังไม่ได้เลือกคนขับ', missing_message:'กรุณาพิมพ์ข้อความ', too_many_recipients:'ส่งได้ครั้งละไม่เกิน 60 เบอร์',
  device_one_at_a_time:'ส่งจากเครื่องได้ครั้งละ 1 เบอร์', forbidden:'ไม่มีสิทธิ์ส่ง SMS ของงานนี้', bad_date:'วันที่ไม่ถูกต้อง'
};
function rlErr(code){ return RL_ERR[code] || (typeof errTH==='function' ? errTH(code) : code); }

function rlPhone(raw){
  var compact=String(raw==null?'':raw).replace(/[\s\-().]/g,'');
  var m=compact.match(/(?:\+?66|0)\d{8,9}/g)||[];
  for(var i=0;i<m.length;i++){
    var d=m[i].replace(/\D/g,'');
    if(d.indexOf('66')===0 && d.length===11) d='0'+d.slice(2);
    if(/^0[689]\d{8}$/.test(d)) return d;
  }
  return '';
}
function rlFmtPhone(p){ return p && p.length===10 ? p.slice(0,3)+'-'+p.slice(3,6)+'-'+p.slice(6) : p; }
function rlHm(iso){ if(!iso) return ''; var d=new Date(iso); return isNaN(d)?'':String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
var RL_TH_MONTH=['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
var RL_TH_DAY=['อา.','จ.','อ.','พ.','พฤ.','ศ.','ส.'];
function rlShort(ymd){ var p=String(ymd).split('-'); return (+p[2])+' '+RL_TH_MONTH[+p[1]-1]; }
function rlDow(ymd){ var p=String(ymd).split('-'); return RL_TH_DAY[new Date(+p[0], +p[1]-1, +p[2]).getDay()]; }
function rlFirstName(n){ return String(n||'').trim().replace(/^(นาย|นาง(สาว)?|น\.ส\.|คุณ)\s*/,'').split(/\s+/)[0]||''; }
function rlUniq(a){ var o=[]; a.forEach(function(v){ v=String(v||'').trim(); if(v && o.indexOf(v)<0) o.push(v); }); return o; }
/** ประมาณเครดิตเหมือนฝั่งเซิร์ฟเวอร์ — ภาษาไทย 70 ตัว/ข้อความ, ยาวกว่านั้น 67 ตัว/ส่วน */
function rlParts(msg){
  var uni=/[^\x00-\x7F]/.test(msg), len=Array.from(msg).length;
  var one=uni?70:160, multi=uni?67:153;
  return { len:len, parts: len<=one ? 1 : Math.ceil(len/multi) };
}

// ปุ่ม "งานปล่อย" เปิดหน้าประสานงานคนขับ (/staff) — หน้าส่ง SMS แบบเดิมยังเปิดได้จาก /#release (ช่องทางสำรอง)
$('btn-gorelease').addEventListener('click', function(){ location.href='/staff'; });
$('btn-release-back').addEventListener('click', function(){ rlStopTimer(); resumeCheckin(); });
$('rl-date').addEventListener('change', function(){ if(this.value) openRelease(this.value); });
$('rl-dates').addEventListener('click', function(e){ var b=e.target.closest('[data-date]'); if(b) openRelease(b.getAttribute('data-date')); });
$('rl-list').addEventListener('change', function(e){
  var cb=e.target.closest('input[data-id]'); if(!cb) return;
  if(cb.checked) rl.picked[cb.getAttribute('data-id')]=1; else delete rl.picked[cb.getAttribute('data-id')];
  cb.closest('.rl-item').classList.toggle('on', cb.checked);
  rlCompose();
});
$('rl-list').addEventListener('click', function(e){
  var b=e.target.closest('[data-act]'); if(!b) return;
  var act=b.getAttribute('data-act');
  if(act==='device') return rlSendDevice(b.getAttribute('data-id'), b);
  var items=(rl.data&&rl.data.items)||[];
  rl.picked={};
  if(act==='all') items.forEach(function(it){ if(rlPhone(it.phone)) rl.picked[it.id]=1; });
  if(act==='unsent') items.forEach(function(it){ if(rlPhone(it.phone) && !rlSmsFor(it)) rl.picked[it.id]=1; });
  if(act==='unread') items.forEach(function(it){ var s=rlSmsFor(it); if(rlPhone(it.phone) && s && !s.openedAt) rl.picked[it.id]=1; });
  rlRenderList(); rlCompose();
});
$('rl-kinds').addEventListener('click', function(e){
  var b=e.target.closest('[data-kind]'); if(!b) return;
  rl.texts[rl.kind]=$('rl-text').value;
  rl.kind=b.getAttribute('data-kind');
  Array.prototype.forEach.call(document.querySelectorAll('#rl-kinds button'), function(x){ x.classList.toggle('on', x===b); });
  var cfg=(rl.data&&rl.data.smsConfig)||{};
  $('rl-text').value = rl.texts[rl.kind]!=null ? rl.texts[rl.kind] : ((cfg.templates||{})[rl.kind]||'');
  rlCompose();
});
$('rl-ph').addEventListener('click', function(e){
  var b=e.target.closest('[data-ph]'); if(!b) return;
  var t=$('rl-text'), ph=b.getAttribute('data-ph'), at=t.selectionStart==null?t.value.length:t.selectionStart;
  t.value=t.value.slice(0,at)+ph+t.value.slice(t.selectionEnd==null?at:t.selectionEnd);
  t.focus(); t.selectionStart=t.selectionEnd=at+ph.length; rlCompose();
});
$('rl-text').addEventListener('input', rlCompose);
$('rl-loc').addEventListener('change', rlCompose);
$('rl-map').addEventListener('change', rlCompose);
$('rl-send').addEventListener('click', rlSend);

/** ป้ายจำนวนงานบนปุ่ม "งานปล่อย" — นับตู้ของวันนี้เป็นต้นไป */
function releaseBadge(){
  api({action:'myReleaseJobs', token:state.token}).then(function(res){
    if(!res || !res.ok) return;
    var n=(res.dates||[]).filter(function(d){ return d.date>=res.today; }).reduce(function(s,d){ return s+d.containers; },0);
    var b=$('rl-badge'); b.textContent=n; b.classList.toggle('hidden', !n);
  }).catch(function(){});
}

function openRelease(date){
  show('release');
  window.scrollTo(0,0);
  if(typeof stopCamera==='function') stopCamera();
  if(date!==rl.date){ rl.picked={}; }
  $('rl-result').innerHTML='';
  $('rl-list').innerHTML='<div class="center-load"><span class="spinner"></span> กำลังโหลด…</div>';
  api({action:'myReleaseJobs', token:state.token, date:date||''}).then(function(res){
    if(res && !res.ok && (res.error==='session_expired'||res.error==='invalid_token')){ toast('หมดเวลา กรุณาเข้าสู่ระบบใหม่'); return; }
    if(!res.ok){ $('rl-list').innerHTML='<div class="status err">'+esc(rlErr(res.error))+'</div>'; return; }
    var changed = res.date!==rl.date;
    rl.date=res.date; rl.data=res;
    $('rl-date').value=res.date;
    if(changed){ rl.picked={}; (res.items||[]).forEach(function(it){ if(rlPhone(it.phone) && !rlSmsFor(it)) rl.picked[it.id]=1; }); }
    rlRenderDates(); rlRenderList(); rlSetupCompose(); rlCompose();
    rlStartTimer();
    var n=(res.dates||[]).filter(function(d){ return d.date>=res.today; }).reduce(function(s,d){ return s+d.containers; },0);
    $('rl-badge').textContent=n; $('rl-badge').classList.toggle('hidden', !n);
  }).catch(function(){ $('rl-list').innerHTML='<div class="status err">เชื่อมต่อเซิร์ฟเวอร์ไม่ได้</div>'; });
}

function rlRenderDates(){
  var d=rl.data, html='';
  (d.dates||[]).forEach(function(x){
    html+='<button class="rl-day'+(x.date===rl.date?' on':'')+(x.date===d.today?' today':'')+'" data-date="'+x.date+'">'+
      rlDow(x.date)+' '+rlShort(x.date)+'<small>'+(x.date===d.today?'วันนี้ • ':'')+x.containers+' ตู้</small></button>';
  });
  $('rl-dates').innerHTML = html || '<div class="muted">ยังไม่มีงานที่ผู้จัดการส่งมา</div>';
}

function rlSmsFor(item){
  var list=(rl.data&&rl.data.sms)||[];
  for(var i=0;i<list.length;i++) if((list[i].itemIds||[]).indexOf(item.id)>=0) return list[i];
  return null;
}

function rlTrackHtml(s){
  if(!s) return '<span class="rl-tag">ยังไม่ได้ส่ง SMS</span>';
  var out=[];
  if(s.status==='failed') out.push('<span class="rl-tag bad">ส่งไม่สำเร็จ'+(s.error?': '+esc(s.error):'')+'</span>');
  else if(s.status==='queued') out.push('<span class="rl-tag">กำลังส่ง…</span>');
  else out.push('<span class="rl-tag">'+(s.provider==='device'?'📱 ส่งจากเครื่อง ':'✉️ ส่ง ')+rlHm(s.sentAt||s.createdAt)+'</span>');
  if(s.status!=='failed' && s.code){
    if(s.openedAt) out.push('<span class="rl-tag ok">👀 เปิดอ่าน '+rlHm(s.openedAt)+(s.openCount>1?' ('+s.openCount+' ครั้ง)':'')+'</span>');
    else out.push('<span class="rl-tag wait">'+(s.previewAt?'ถึงเครื่องแล้ว • ยังไม่เปิดลิงก์':'ยังไม่เปิดอ่าน')+'</span>');
  }
  if(s.locationStatus==='shared' && s.latitude!=null){
    out.push('<a class="rl-tag ok" target="_blank" rel="noopener" href="https://www.google.com/maps?q='+s.latitude+','+s.longitude+'">📍 ตำแหน่ง '+rlHm(s.locationAt)+(s.accuracyM?' ±'+Math.round(s.accuracyM)+' ม.':'')+'</a>');
  } else if(s.locationStatus==='denied') out.push('<span class="rl-tag bad">ไม่อนุญาตตำแหน่ง</span>');
  else if(s.locationStatus==='unavailable') out.push('<span class="rl-tag bad">หาตำแหน่งไม่ได้</span>');
  return out.join('');
}

function rlRenderList(){
  var d=rl.data, items=d.items||[];
  if(!d.plan || d.plan.status!=='confirmed' || !items.length){
    $('rl-list').innerHTML='<div class="card"><div class="center-load" style="padding:24px 0">'+
      (d.plan && d.plan.status!=='confirmed' ? 'แพลนวันที่ '+rlShort(rl.date)+' ยังไม่ได้ Confirm' : 'ไม่มีงานของคุณในวันที่ '+rlShort(rl.date))+'</div></div>';
    $('rl-compose').classList.add('hidden');
    return;
  }
  var ready=d.smsConfig && d.smsConfig.ready;
  var html='<div class="rl-tools"><button data-act="all">เลือกทุกคน</button><button data-act="unsent">เฉพาะที่ยังไม่ส่ง</button>'+
    '<button data-act="unread">ส่งแล้วแต่ยังไม่เปิด</button><button data-act="none">ไม่เลือก</button></div>';
  items.forEach(function(it){
    var phone=rlPhone(it.phone), on=!!rl.picked[it.id];
    html+='<div class="rl-item'+(on?' on':'')+'">'+
      '<label class="rl-top"><input type="checkbox" data-id="'+esc(it.id)+'"'+(on?' checked':'')+(phone?'':' disabled')+'>'+
        '<div><span class="cnt">'+esc(it.containerNo||'(ไม่มีเลขตู้)')+'</span>'+
        (it.port||it.destination?'<span class="rl-port">'+esc(it.port||'?')+(it.destination?' → '+esc(it.destination):'')+'</span>':'')+
        '<div class="muted">BL '+esc(it.bl||'-')+(it.customer?' • '+esc(it.customer):'')+'</div></div></label>'+
      '<div class="rl-drv">👤 '+esc(it.driverName||'ไม่มีชื่อคนขับ')+(it.plate?'<br>🚚 '+esc(it.plate):'')+'<br>'+
        (phone ? '📞 <a href="tel:'+phone+'">'+rlFmtPhone(phone)+'</a>' : '<span class="rl-nophone">📞 '+(it.phone?esc(it.phone)+' — ส่ง SMS ไม่ได้':'ไม่มีเบอร์มือถือ')+'</span>')+'</div>'+
      '<div class="rl-track">'+rlTrackHtml(rlSmsFor(it))+'</div>'+
      (phone && !ready ? '<button class="rl-dev" data-act="device" data-id="'+esc(it.id)+'">📱 ส่งจากเครื่อง (แอป SMS)</button>' : '')+
    '</div>';
  });
  $('rl-list').innerHTML=html;
  $('rl-compose').classList.remove('hidden');
}

function rlSetupCompose(){
  var d=rl.data, cfg=d.smsConfig||{};
  if($('rl-text').value==='' || rl.texts.__date!==rl.date){
    rl.texts={ __date:rl.date };
    $('rl-text').value=(cfg.templates||{})[rl.kind]||'';
  }
  $('rl-ph').innerHTML=(cfg.placeholders||[]).map(function(p){ return '<button type="button" data-ph="'+esc(p)+'">'+esc(p)+'</button>'; }).join('');
  var cur=$('rl-map').value;
  var maps=d.maps||[];
  $('rl-map').innerHTML='<option value="">ไม่แนบรูปแผนที่</option>'+(maps.length?'<option value="auto">อัตโนมัติตามท่า</option>':'')+
    maps.map(function(m){ return '<option value="'+esc(m.id)+'">'+esc(m.name)+(m.port?' ('+esc(m.port)+')':'')+'</option>'; }).join('');
  $('rl-map').value = cur && $('rl-map').querySelector('option[value="'+cur+'"]') ? cur : (maps.length?'auto':'');
  var off=$('rl-sms-off');
  if(cfg.dryRun){ off.textContent='🧪 โหมดทดสอบ: ระบบบันทึกเหมือนส่งแล้ว แต่ยังไม่ส่ง SMS จริง'; off.classList.remove('hidden'); }
  else if(!cfg.ready){ off.textContent='ระบบยังไม่ได้ตั้งค่า ThaiBulkSMS — กด “📱 ส่งจากเครื่อง” ที่คนขับแต่ละคน ระบบยังติดตามการเปิดลิงก์/ตำแหน่งให้เหมือนเดิม'; off.classList.remove('hidden'); }
  else off.classList.add('hidden');
}

function rlPickedItems(){ return ((rl.data&&rl.data.items)||[]).filter(function(it){ return rl.picked[it.id] && rlPhone(it.phone); }); }

function rlMapFor(items){
  var v=$('rl-map').value, maps=(rl.data&&rl.data.maps)||[];
  if(!v) return null;
  if(v!=='auto') return maps.filter(function(m){ return m.id===v; })[0]||null;
  for(var i=0;i<items.length;i++){
    var k=String(items[i].port||'').toUpperCase().replace(/[^A-Z0-9ก-๙]/g,'');
    for(var j=0;j<maps.length;j++) if(maps[j].portKey && maps[j].portKey===k) return maps[j];
  }
  return null;
}

/** กลุ่มตามเบอร์ — เหมือนฝั่งเซิร์ฟเวอร์ (คนขับเบอร์เดียวกันหลายตู้ = SMS เดียว) */
function rlGroups(items){
  var g={}, order=[];
  items.forEach(function(it){ var p=rlPhone(it.phone); if(!g[p]){ g[p]=[]; order.push(p); } g[p].push(it); });
  return order.map(function(p){ return { phone:p, items:g[p] }; });
}

function rlFill(text, items){
  var f=items[0];
  var ctx={ 'ชื่อ':rlFirstName(f.driverName), 'ทะเบียน':String(f.plate||'').split(/\s+-\s+/)[0]||f.plate||'',
    'ตู้':rlUniq(items.map(function(i){return i.containerNo;})).join(', ')||f.bl, 'BL':rlUniq(items.map(function(i){return i.bl;})).join(', '),
    'ท่า':rlUniq(items.map(function(i){return i.port;})).join(', '), 'ปลายทาง':rlUniq(items.map(function(i){return i.destination;})).join(', '),
    'วันที่':rlShort(rl.date), 'ชิปปิ้ง':(state.user&&state.user.name)||'' };
  return text.replace(/\{(ชื่อ|ทะเบียน|ตู้|BL|ท่า|ปลายทาง|วันที่|ชิปปิ้ง)\}/g, function(_, k){ return ctx[k]||''; }).replace(/[ \t]{2,}/g,' ').trim();
}

function rlCompose(){
  if(!rl.data) return;
  var items=rlPickedItems(), groups=rlGroups(items), text=$('rl-text').value.trim();
  var withLoc=$('rl-loc').checked;
  var cfg=rl.data.smsConfig||{}, base=(cfg.linkBase||location.origin).replace(/\/+$/,'');
  $('rl-pick-count').textContent = groups.length ? '— เลือก '+items.length+' ตู้ ('+groups.length+' เบอร์)' : '';
  var firstMap = groups.length ? rlMapFor(groups[0].items) : rlMapFor((rl.data.items||[]));
  $('rl-map-prev').innerHTML = firstMap ? '<img src="'+esc(firstMap.url)+'" alt="'+esc(firstMap.name)+'">' : '';

  var total=0, sample='';
  groups.forEach(function(g, i){
    var map=rlMapFor(g.items), link=(withLoc||map) ? '\n'+base+'/d/xxxxxxxx' : '';
    var msg=rlFill(text, g.items)+link;
    total+=rlParts(msg).parts;
    if(i===0) sample=msg;
  });
  if(!groups.length){
    $('rl-preview').innerHTML='<span class="muted">เลือกคนขับที่ต้องการส่งด้านบน</span>';
  } else {
    var p=rlParts(sample);
    var html=esc(sample).replace(/(https?:\/\/\S+)/, '<span class="lnk">$1</span>');
    $('rl-preview').innerHTML='<b>ตัวอย่าง SMS ถึง '+esc(groups[0].items[0].driverName||rlFmtPhone(groups[0].phone))+'</b>'+
      '<div class="rl-bubble">'+html+'</div>'+
      '<div class="muted">'+p.len+' ตัวอักษร ≈ '+p.parts+' เครดิต/ข้อความ • รวม '+groups.length+' ข้อความ ≈ '+total+' เครดิต'+
      ((withLoc||firstMap)?' • ลิงก์จริงสร้างตอนกดส่ง':'')+'</div>';
  }
  var btn=$('rl-send');
  btn.disabled = rl.sending || !groups.length || !text || !cfg.ready;
  btn.textContent = rl.sending ? 'กำลังส่ง…' : (cfg.ready ? 'ส่ง SMS ถึง '+groups.length+' คน' : 'ส่ง SMS (ยังไม่ได้ตั้งค่าระบบ)');
}

function rlSend(){
  var items=rlPickedItems(), groups=rlGroups(items), text=$('rl-text').value.trim();
  if(!groups.length || !text) return;
  var resent=items.filter(function(it){ return rlSmsFor(it); }).length;
  if(!confirm('ส่ง SMS ถึงคนขับ '+groups.length+' คน ('+items.length+' ตู้)?'+(resent?'\n\n'+resent+' ตู้เคยส่งไปแล้ว จะส่งซ้ำอีกครั้ง':''))) return;
  rl.sending=true; rlCompose();
  $('rl-result').innerHTML='';
  api({ action:'sendDriverSms', token:state.token, date:rl.date, itemIds:items.map(function(i){ return i.id; }),
        kind:rl.kind, text:text, withLocation:$('rl-loc').checked, mapId:$('rl-map').value }).then(function(res){
    rl.sending=false;
    if(!res.ok){ $('rl-result').innerHTML='<div class="status err">'+esc(rlErr(res.error))+'</div>'; rlCompose(); return; }
    var html='<div class="rl-res '+(res.failed?'status wait':'status ok')+'">'+(res.dryRun?'🧪 (ทดสอบ) ':'')+'ส่งสำเร็จ <b>'+res.sent+'</b> เบอร์'+
      (res.failed?' • ไม่สำเร็จ <b>'+res.failed+'</b>':'')+' • ใช้ '+res.credit+' เครดิต'+(res.remaining!=null?' • คงเหลือ '+Number(res.remaining).toLocaleString('th-TH'):'')+'</div>';
    (res.results||[]).filter(function(r){ return !r.ok; }).forEach(function(r){
      html+='<div class="rl-res status err">'+esc(r.driverName||r.phone)+' ('+esc(rlFmtPhone(r.phone))+'): '+esc(r.error)+'</div>';
    });
    if(res.noPhone && res.noPhone.length) html+='<div class="rl-res status wait">ไม่มีเบอร์มือถือ: '+esc(res.noPhone.join(', '))+'</div>';
    rl.picked={};
    openRelease(rl.date);
    setTimeout(function(){ $('rl-result').innerHTML=html; }, 400);
  }).catch(function(){ rl.sending=false; rlCompose(); $('rl-result').innerHTML='<div class="status err">เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจสถานะในรายการก่อนส่งซ้ำ</div>'; });
}

/** ส่งจากแอป SMS ในมือถือของชิปปิ้งเอง (ตอนยังไม่ได้ตั้งค่า ThaiBulkSMS) — ระบบยังออกลิงก์ติดตามให้ */
function rlSendDevice(itemId, btn){
  var items=(rl.data&&rl.data.items)||[], it=items.filter(function(x){ return x.id===itemId; })[0];
  if(!it) return;
  var text=$('rl-text').value.trim();
  if(!text){ toast('พิมพ์ข้อความในช่องด้านล่างก่อน'); $('rl-text').focus(); return; }
  var phone=rlPhone(it.phone);
  var same=items.filter(function(x){ return rlPhone(x.phone)===phone; }).map(function(x){ return x.id; });
  btn.disabled=true;
  api({ action:'sendDriverSms', token:state.token, date:rl.date, itemIds:same, via:'device',
        kind:rl.kind, text:text, withLocation:$('rl-loc').checked, mapId:$('rl-map').value }).then(function(res){
    btn.disabled=false;
    if(!res.ok){ toast(rlErr(res.error), 3500); return; }
    // iOS ใช้ sms:เบอร์&body= ส่วน Android ใช้ ?body= — แบบ ?&body= ใช้ได้ทั้งสองระบบ
    location.href='sms:'+res.phone+'?&body='+encodeURIComponent(res.message);
    setTimeout(function(){ openRelease(rl.date); }, 1500);
  }).catch(function(){ btn.disabled=false; toast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); });
}

// อัปเดตสถานะเปิดอ่าน / ตำแหน่งทุก 20 วินาทีระหว่างเปิดหน้านี้
function rlStartTimer(){
  rlStopTimer();
  if(!rl.data || !(rl.data.sms||[]).length) return;
  rl.timer=setInterval(function(){
    if($('screen-release').classList.contains('hidden') || document.hidden){ return; }
    api({action:'smsTracking', token:state.token, date:rl.date}).then(function(res){
      if(!res || !res.ok || res.date!==rl.date) return;
      rl.data.sms=res.sms||[];
      var tracks=document.querySelectorAll('#rl-list .rl-item');
      (rl.data.items||[]).forEach(function(it, i){ var el=tracks[i] && tracks[i].querySelector('.rl-track'); if(el) el.innerHTML=rlTrackHtml(rlSmsFor(it)); });
    }).catch(function(){});
  }, 20000);
}
function rlStopTimer(){ if(rl.timer){ clearInterval(rl.timer); rl.timer=null; } }

// สคริปต์หลักเข้าแอปให้ก่อนไฟล์นี้โหลด (กรณีจำ session ไว้) — ตั้งป้ายจำนวนงานตามมาทีหลัง
if(state.user && state.user.role==='employee-shipping'){
  releaseBadge();
  if(location.hash==='#release') openRelease('');
}
