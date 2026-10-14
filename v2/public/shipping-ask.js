/**
 * ถามชิปปิ้งทาง LINE OA: "งานตรวจปล่อยวันนี้เสร็จครบแล้วหรือยัง" (ผู้จัดการ / admin)
 *
 * เลือกวันที่ → ติ๊กชิปปิ้ง (ค่าเริ่มต้น = คนที่มีตู้ในแพลนวันนั้น ผูก LINE แล้ว และยังไม่ตอบว่าเสร็จ) → ส่ง
 * ชิปปิ้งกดปุ่ม ✅ เสร็จครบแล้ว / ⏳ ยังไม่เสร็จ ในแชท LINE → คำตอบขึ้นตารางนี้ (รีเฟรชเองทุก 30 วินาที)
 * และแจ้งผู้จัดการคนที่ถามทาง LINE ถ้าผูก LINE ไว้ที่หน้า /staff
 *
 * ใช้ $, api, state, esc, toast, guard, errTH จากสคริปต์หลักของ admin.html (เรียกตอนเปิดแท็บ)
 */
var sa = { ready:false, date:'', data:null, picked:{}, pickedFor:'', timer:null, busy:false };

var SA_ERR = { group_not_found:'ไม่พบกลุ่มนี้ — กดรีเฟรชแล้วเลือกใหม่',
  bad_date:'วันที่ไม่ถูกต้อง', no_recipients:'ยังไม่ได้เลือกชิปปิ้ง', too_many_recipients:'เลือกได้ไม่เกิน 50 คนต่อครั้ง'
};
var SA_ANSWER = { DONE:'✅ เสร็จครบแล้ว', NOT_DONE:'⏳ ยังไม่เสร็จ' };
var SA_SEND = { queued:'กำลังส่ง', sent:'ส่งแล้ว', demo:'โหมดทดลอง (ไม่ได้ส่งจริง)', failed:'ส่งไม่สำเร็จ' };

function saErr(code){ return SA_ERR[code] || (typeof errTH==='function' ? errTH(code) : code); }
function saYmd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function saDmy(ymd){ if(!ymd) return '—'; var p=String(ymd).split('-'); return p[2]+'/'+p[1]+'/'+p[0]; }
function saTime(iso){
  if(!iso) return '';
  var d=new Date(iso); if(isNaN(d)) return '';
  var hm=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  return saYmd(d)===saYmd(new Date()) ? hm : d.toLocaleDateString('th-TH-u-ca-gregory',{day:'2-digit',month:'2-digit'})+' '+hm;
}

function initShipAsk(){
  if(!sa.ready){
    sa.ready=true;
    $('tab-shipask').innerHTML =
      '<h3 class="sec">ถามชิปปิ้งทาง LINE — งานตรวจปล่อยเสร็จครบหรือยัง</h3>'+
      '<p class="muted" style="margin:0 0 14px">ส่งการ์ดคำถามเข้า LINE ของชิปปิ้ง ชิปปิ้งกดตอบ <b>✅ เสร็จครบแล้ว</b> / <b>⏳ ยังไม่เสร็จ</b> ในแชทได้เลย '+
      '(ตอบว่ายังไม่เสร็จแล้วพิมพ์บอกได้ว่ายังค้างอะไร) — คำตอบขึ้นในตารางนี้ทันที และส่งเข้า LINE ของคุณด้วยถ้าผูก LINE ไว้</p>'+
      '<div class="toolbar">'+
        '<label class="muted" style="display:flex;align-items:center;gap:8px;font-weight:600">วันที่ตรวจปล่อย <input type="date" id="sa-date"></label>'+
        '<button id="sa-today" class="btn btn-ghost btn-sm">วันนี้</button>'+
        '<button id="sa-refresh" class="btn btn-ghost btn-sm">↻ รีเฟรช</button>'+
      '</div>'+
      '<div id="sa-body"><div class="center-load"><span class="spinner"></span> กำลังโหลด…</div></div>';
    $('sa-date').value=saYmd(new Date());
    $('sa-date').addEventListener('change', function(){ saLoad(); });
    $('sa-today').addEventListener('click', function(){ $('sa-date').value=saYmd(new Date()); saLoad(); });
    $('sa-refresh').addEventListener('click', function(){ saLoad(); });
    $('sa-body').addEventListener('click', saOnClick);
    $('sa-body').addEventListener('change', saOnChange);
  }
  saLoad();
  // คำตอบเข้ามาทาง webhook — รีเฟรชเองเฉพาะตอนเปิดแท็บนี้อยู่
  clearInterval(sa.timer);
  sa.timer=setInterval(function(){
    if($('tab-shipask').classList.contains('hidden')){ clearInterval(sa.timer); sa.timer=null; return; }
    if(!document.hidden && !sa.busy && document.activeElement!==$('sa-msg')) saLoad(true);
  }, 30000);
}

function saLoad(quiet){
  var date=$('sa-date').value;
  if(!date){ toast('กรุณาเลือกวันที่'); return; }
  if(!quiet) $('sa-body').innerHTML='<div class="center-load"><span class="spinner"></span> กำลังโหลด…</div>';
  api({action:'shipAskList', token:state.token, date:date}).then(function(res){
    if(!guard(res)) return;
    if(!res.ok){ if(!quiet) $('sa-body').innerHTML='<div class="err">'+esc(saErr(res.error))+'</div>'; return; }
    sa.data=res; sa.date=res.date;
    saRender();
  }).catch(function(){ if(!quiet) $('sa-body').innerHTML='<div class="err">เชื่อมต่อเซิร์ฟเวอร์ไม่ได้</div>'; });
}

/** คำถามล่าสุดที่ส่งถึงจริงของชิปปิ้งแต่ละคน (ส่งไม่สำเร็จไม่นับเป็นคำถาม) */
function saLatest(){
  var out={};
  (sa.data.asks||[]).forEach(function(a){
    var k=a.username.toLowerCase();
    if(a.sendState==='failed') return;
    if(!out[k]) out[k]=a;
  });
  return out;
}

function saRender(){
  var d=sa.data, latest=saLatest();
  // เลือกค่าเริ่มต้นครั้งแรกของแต่ละวันที่ — รีเฟรชอัตโนมัติไม่ล้างที่ติ๊กไว้
  if(sa.pickedFor!==d.date){
    sa.picked={}; sa.pickedFor=d.date;
    d.shippers.forEach(function(s){
      var a=latest[s.username.toLowerCase()];
      if(s.linked && s.containers>0 && !(a && a.answer==='DONE')) sa.picked[s.username]=true;
    });
  }
  var asked=0, done=0, notDone=0;
  Object.keys(latest).forEach(function(k){ asked++; if(latest[k].answer==='DONE') done++; else if(latest[k].answer==='NOT_DONE') notDone++; });

  var notes='';
  if(d.lineMode!=='live') notes+='<div class="pl-new">⚠️ LINE OA ยังไม่ได้ตั้งค่า (โหมดทดลอง) — ระบบจะบันทึกคำถามไว้ แต่ไม่ได้ส่งเข้า LINE จริง</div>';
  if(!d.me.linked) notes+='<div class="pl-new">คุณยังไม่ได้ผูก LINE — ผูกที่ <a href="/staff?tab=more" target="_blank">หน้างานชิปปิ้ง → เพิ่มเติม → ผูก LINE</a> เพื่อรับคำตอบของชิปปิ้งทาง LINE ด้วย (ไม่ผูกก็ดูคำตอบในหน้านี้ได้)</div>';
  if(d.planStatus!=='confirmed') notes+='<div class="pl-new">แพลนวันที่ '+esc(saDmy(d.date))+(d.planStatus ? ' ยังไม่ได้ Confirm' : ' ยังไม่มี')+' — จำนวนตู้ด้านล่างอาจยังไม่ครบ</div>';

  var rows=d.shippers.map(function(s){
    var a=latest[s.username.toLowerCase()];
    var ans = !a ? '<span class="muted">ยังไม่ได้ถาม</span>'
      : a.answer ? '<b style="color:'+(a.answer==='DONE'?'#166534':'#9a3412')+'">'+SA_ANSWER[a.answer]+'</b><div class="muted">'+esc(saTime(a.answeredAt))+'</div>'
      : '<span class="pl-chip warn">รอตอบ</span>'+(a.sendState==='demo'?'<div class="muted">'+SA_SEND.demo+'</div>':'');
    var prog = s.containers ? s.completed+'/'+s.containers+(s.completed>=s.containers?' ✓':'') : '<span class="muted">—</span>';
    return '<tr>'+
      '<td><input type="checkbox" data-pick="'+esc(s.username)+'"'+(sa.picked[s.username]?' checked':'')+(s.linked?'':' disabled')+'></td>'+
      '<td class="name" style="text-align:left">'+esc(s.name)+'</td>'+
      '<td>'+(s.containers||'<span class="muted">0</span>')+'</td>'+
      '<td>'+prog+'</td>'+
      '<td>'+(s.linked ? '<span class="pl-chip">ผูกแล้ว</span>' : '<span class="pl-chip bad">ยังไม่ผูก</span>')+'</td>'+
      '<td>'+ans+'</td>'+
      '<td class="muted">'+(a ? esc(saTime(a.askedAt))+'<div>โดย '+esc(a.askedByName)+'</div>' : '')+'</td>'+
      '<td style="text-align:left;min-width:180px">'+(a && a.answerNote ? esc(a.answerNote) : '')+'</td>'+
    '</tr>';
  }).join('');
  var nPicked=Object.keys(sa.picked).filter(function(k){ return sa.picked[k]; }).length;

  var history=(d.asks||[]).map(function(a){
    var s=d.shippers.filter(function(x){ return x.username.toLowerCase()===a.username.toLowerCase(); })[0];
    return '<tr><td>'+esc(saTime(a.askedAt))+'</td><td class="name" style="text-align:left">'+esc(s?s.name:a.username)+'</td>'+
      '<td>'+esc(a.askedByName)+'</td><td>'+esc(SA_SEND[a.sendState]||a.sendState)+(a.sendError?'<div class="muted">'+esc(a.sendError)+'</div>':'')+'</td>'+
      '<td>'+(a.answer ? SA_ANSWER[a.answer]+' <span class="muted">'+esc(saTime(a.answeredAt))+'</span>' : '—')+'</td>'+
      '<td style="text-align:left">'+esc(a.message)+'</td><td style="text-align:left">'+esc(a.answerNote)+'</td></tr>';
  }).join('');

  // กลุ่ม LINE ที่รับคำตอบ (ส่งคำตอบทุกครั้งเข้ากลุ่มนี้ด้วย)
  var lg=d.lineGroup||{ groups:[], groupId:'' }, active=lg.groups.filter(function(g){ return g.active || g.id===lg.groupId; });
  var groupBox='<div class="pl-drv" style="margin-bottom:14px"><label class="muted" style="font-weight:600;display:block;margin-bottom:6px">💬 แจ้งคำตอบเข้ากลุ่ม LINE</label>'+
    (active.length
      ? '<select id="sa-group" style="min-width:260px"><option value="">— ไม่ส่งเข้ากลุ่ม —</option>'+active.map(function(g){
          return '<option value="'+esc(g.id)+'"'+(g.id===lg.groupId?' selected':'')+'>'+esc(g.name||('กลุ่มไม่มีชื่อ ('+g.id.slice(0,8)+'…)'))+(g.active?'':' — OA ออกจากกลุ่มแล้ว')+'</option>'; }).join('')+'</select>'+
        ' <span class="muted">ชิปปิ้งตอบเมื่อไหร่ ส่งการ์ดคำตอบเข้ากลุ่มที่เลือกด้วย</span>'
      : '<span class="muted">ยังไม่มีกลุ่ม — เชิญ LINE OA "SHIPME" เข้ากลุ่มที่ต้องการ (หรือพิมพ์ข้อความอะไรก็ได้ในกลุ่มที่มี OA อยู่แล้ว) แล้วกด ↻ รีเฟรช</span>')+
    '</div>';
  $('sa-body').innerHTML = notes+groupBox+
    '<div class="pl-summary">'+
      '<span class="pl-chip">วันที่ '+esc(saDmy(d.date))+(d.date===d.today?' (วันนี้)':'')+'</span>'+
      '<span class="pl-chip">ถามแล้ว '+asked+' คน</span>'+
      '<span class="pl-chip" style="background:#dcfce7;color:#166534">เสร็จ '+done+'</span>'+
      '<span class="pl-chip warn">ยังไม่เสร็จ '+notDone+'</span>'+
      '<span class="pl-chip">รอตอบ '+(asked-done-notDone)+'</span>'+
    '</div>'+
    '<div class="tbl-wrap" style="margin-bottom:14px"><table class="grid"><thead><tr>'+
      '<th><input type="checkbox" id="sa-all" title="เลือกทุกคนที่ผูก LINE"></th><th>ชิปปิ้ง</th><th>ตู้ในแพลน</th><th>ปิดงานในระบบ</th><th>LINE</th><th>คำตอบล่าสุด</th><th>ถามเมื่อ</th><th>ที่ยังค้าง</th>'+
    '</tr></thead><tbody>'+(rows||'<tr><td colspan="8" class="muted">ยังไม่มีชิปปิ้งในระบบ</td></tr>')+'</tbody></table></div>'+
    '<div class="pl-drv">'+
      '<label class="muted" style="font-weight:600;display:block;margin-bottom:6px">ข้อความเพิ่มเติม (ไม่บังคับ)</label>'+
      '<textarea id="sa-msg" rows="2" maxlength="300" style="width:100%;box-sizing:border-box" placeholder="เช่น ถ้ายังไม่เสร็จ แจ้งเวลาที่คาดว่าจะเสร็จด้วย">'+esc(sa.msg||'')+'</textarea>'+
      '<div class="pl-drv-acts"><button id="sa-send" class="btn btn-primary"'+(nPicked?'':' disabled')+'>📨 ส่งคำถามทาง LINE ('+nPicked+' คน)</button>'+
      '<span class="muted" style="align-self:center">การ์ดมีปุ่มตอบ + ความคืบหน้าในระบบของชิปปิ้งคนนั้น · ถามคนเดิมซ้ำได้หลัง 10 นาที</span></div>'+
    '</div>'+
    (history ? '<details id="sa-hist" style="margin-top:6px"'+(sa.histOpen?' open':'')+'><summary style="cursor:pointer;color:var(--blue2);font-weight:600">ประวัติการถามทั้งหมดของวันที่นี้ ('+d.asks.length+')</summary>'+
      '<div class="tbl-wrap" style="margin-top:8px"><table class="grid"><thead><tr><th>ถามเมื่อ</th><th>ชิปปิ้ง</th><th>ผู้ถาม</th><th>ส่ง</th><th>คำตอบ</th><th>ข้อความ</th><th>ที่ยังค้าง</th></tr></thead>'+
      '<tbody>'+history+'</tbody></table></div></details>' : '');
  $('sa-msg').addEventListener('input', function(){ sa.msg=this.value; });
  // รีเฟรชอัตโนมัติวาดใหม่ทั้งก้อน — จำไว้ว่าเปิดประวัติค้างไว้หรือไม่
  if($('sa-hist')) $('sa-hist').addEventListener('toggle', function(){ sa.histOpen=this.open; });
}

function saOnChange(e){
  var t=e.target;
  if(t.id==='sa-group'){
    api({action:'shipAskGroupSet', token:state.token, groupId:t.value}).then(function(res){
      if(!guard(res)) return;
      toast(res.ok ? (t.value?'ตั้งกลุ่มรับคำตอบแล้ว':'ปิดการส่งเข้ากลุ่มแล้ว') : saErr(res.error));
      saLoad(true);
    });
    return;
  }
  if(t.id==='sa-all'){
    sa.picked={};
    if(t.checked) sa.data.shippers.forEach(function(s){ if(s.linked) sa.picked[s.username]=true; });
    saRender(); return;
  }
  var u=t.getAttribute && t.getAttribute('data-pick');
  if(u!=null){ sa.picked[u]=t.checked; saRender(); }
}

function saOnClick(e){
  var b=e.target.closest('#sa-send'); if(!b) return;
  var usernames=Object.keys(sa.picked).filter(function(k){ return sa.picked[k]; });
  if(!usernames.length){ toast('ยังไม่ได้เลือกชิปปิ้ง'); return; }
  if(!confirm('ส่งคำถาม "งานตรวจปล่อยวันที่ '+saDmy(sa.date)+' เสร็จครบหรือยัง" ทาง LINE ถึงชิปปิ้ง '+usernames.length+' คน?')) return;
  sa.busy=true; b.disabled=true; b.textContent='กำลังส่ง…';
  api({action:'shipAskSend', token:state.token, date:sa.date, usernames:usernames, message:(sa.msg||'').trim()}).then(function(res){
    sa.busy=false;
    if(!guard(res)) return;
    if(!res.ok){ toast(saErr(res.error)); saRender(); return; }
    var c={}; (res.results||[]).forEach(function(r){ c[r.state]=(c[r.state]||0)+1; });
    var parts=[];
    if(c.sent) parts.push('ส่งแล้ว '+c.sent+' คน');
    if(c.demo) parts.push('บันทึกแบบทดลอง '+c.demo+' คน (ไม่ได้ส่งจริง)');
    if(c.cooldown) parts.push('เพิ่งถามไป '+c.cooldown+' คน (รอ 10 นาที)');
    if(c.not_linked) parts.push('ยังไม่ผูก LINE '+c.not_linked+' คน');
    if(c.failed) parts.push('ส่งไม่สำเร็จ '+c.failed+' คน');
    if(c.unknown_shipper) parts.push('ไม่พบชิปปิ้ง '+c.unknown_shipper+' คน');
    toast(parts.join(' · ') || 'ไม่มีข้อความที่ส่ง', 5000);
    if(c.sent || c.demo){ sa.msg=''; }
    saLoad(true);
  }).catch(function(){ sa.busy=false; toast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); saRender(); });
}
