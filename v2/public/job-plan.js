/**
 * แพลนงานตรวจปล่อย (ผู้จัดการ / admin) + ตั้งค่าชิปปิ้งประจำท่า + รูปแผนที่นัดหมาย
 *
 * ขั้นตอน: เลือกวันที่ตรวจปล่อย → ระบบดึงงานจากตาราง MAESOT FREEZONE + TRANSIT (1 แถว = 1 ตู้)
 *        → อัปไฟล์ข้อมูลคนขับรถ (Excel / วางข้อความ) จับคู่ด้วยเลขตู้
 *        → ชิปปิ้งถูกเลือกให้ตาม "ชิปปิ้งประจำท่า" ของเดือนนั้น (ไม่เจอ = ชื่อชิปปิ้งในชีต) แก้เองได้
 *        → Confirm Plan → ชิปปิ้งแต่ละคนเห็นงานของตัวเองในเมนู "งานปล่อย" ของหน้าพนักงาน
 *
 * ใช้ $, api, state, esc, toast, guard, errTH, XLSX จากสคริปต์หลักของ admin.html (เรียกตอนเปิดแท็บ)
 */
var plan = { ready:false, date:'', data:null, rows:[], newJobs:[], assign:{}, shippers:[], dirty:false, driverFile:'', loading:false };

var PL_ERR = {
  bad_date:'วันที่ไม่ถูกต้อง', plan_empty:'ยังไม่มีงานในแพลน', too_many_items:'งานในแพลนเกิน 400 แถว',
  plan_unassigned:'ยังมีแถวที่ไม่ได้เลือกชิปปิ้ง', unknown_shipper:'ชิปปิ้งที่เลือกไม่มีในระบบหรือถูกปิดบัญชี',
  bad_period:'เดือนไม่ถูกต้อง', missing_name:'กรุณาตั้งชื่อรูป', bad_key:'ไฟล์ไม่ถูกต้อง', upload_missing:'อัปโหลดรูปไม่สำเร็จ ลองใหม่อีกครั้ง',
  not_found:'ไม่พบข้อมูล'
};
function plErr(code, detail){
  var msg = PL_ERR[code] || (typeof errTH==='function' ? errTH(code) : code);
  return detail ? msg+' ('+detail+')' : msg;
}

/** ชื่อท่าแบบเทียบได้ — ตรงกับ portKey ฝั่งเซิร์ฟเวอร์ (KERRY / kerry / D1-D2 = เดียวกัน) */
function plPortKey(v){ return String(v==null?'':v).toUpperCase().replace(/[^A-Z0-9ก-๙]/g,''); }
function plCntKey(v){ return String(v==null?'':v).toUpperCase().replace(/[^A-Z0-9]/g,''); }
function plBlKey(v){ return String(v==null?'':v).toUpperCase().replace(/[^A-Z0-9]/g,''); }
/** เบอร์มือถือที่ส่ง SMS ได้ — ตรงกับ smsPhone ฝั่งเซิร์ฟเวอร์ */
function plSmsPhone(raw){
  var compact = String(raw==null?'':raw).replace(/[\s\-().]/g,'');
  var m = compact.match(/(?:\+?66|0)\d{8,9}/g) || [];
  for(var i=0;i<m.length;i++){
    var d = m[i].replace(/\D/g,'');
    if(d.indexOf('66')===0 && d.length===11) d='0'+d.slice(2);
    if(/^0[689]\d{8}$/.test(d)) return d;
  }
  return '';
}
function plYmd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function plDmy(ymd){ if(!ymd) return '—'; var p=String(ymd).split('-'); return p[2]+'/'+p[1]+'/'+p[0]; }
function plHm(iso){ if(!iso) return ''; var d=new Date(iso); return isNaN(d) ? '' : String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function plDT(iso){ if(!iso) return ''; var d=new Date(iso); return isNaN(d) ? '' : d.toLocaleString('th-TH-u-ca-gregory',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function plShipperName(u){
  if(!u) return '';
  for(var i=0;i<plan.shippers.length;i++) if(plan.shippers[i].username.toLowerCase()===String(u).toLowerCase()) return plan.shippers[i].name || u;
  return u;
}
var PL_SOURCE = { 'MAESOT FREEZONE':'MSFZ', 'TRANSIT':'TRANSIT', 'DRIVER FILE':'ไฟล์คนขับ', 'MANUAL':'เพิ่มเอง' };
var PL_WHY = { port:'ตามท่า', sheet:'ตามชีต', manual:'แก้เอง' };

// ======================= แท็บแพลนงาน =======================

function initPlanTab(){
  if(plan.ready) return;
  plan.ready = true;
  var tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
  $('tab-plan').innerHTML =
    '<h3 class="sec">แพลนงานตรวจปล่อย</h3>'+
    '<p class="muted" style="margin:0 0 14px">เลือกวันที่ตรวจปล่อย → ระบบดึงงานจากตาราง <b>MAESOT FREEZONE</b> + <b>TRANSIT</b> → อัปไฟล์ข้อมูลคนขับรถ → '+
    'ตรวจชิปปิ้งที่ระบบเลือกให้ (ตาม <a href="#" id="pl-go-assign">ชิปปิ้งประจำท่า</a> ของเดือนนั้น) → กด <b>Confirm Plan</b> งานจะไปขึ้นที่เมนู “งานปล่อย” ของชิปปิ้งแต่ละคน</p>'+
    '<div class="toolbar">'+
      '<label class="muted" style="display:flex;align-items:center;gap:8px;font-weight:600">วันที่ตรวจปล่อย <input type="date" id="pl-date" value="'+plYmd(tomorrow)+'"></label>'+
      '<button id="pl-load" class="btn btn-primary">ดึงงาน</button>'+
      '<button id="pl-today" class="btn btn-ghost btn-sm">วันนี้</button>'+
      '<button id="pl-tomorrow" class="btn btn-ghost btn-sm">พรุ่งนี้</button>'+
    '</div>'+
    '<div id="pl-recent" class="pl-recent"></div>'+
    '<div id="pl-body"><div class="center-load muted">เลือกวันที่ตรวจปล่อย แล้วกด “ดึงงาน”</div></div>'+
    '<input type="file" id="pl-file" accept=".xlsx,.xls,.csv" hidden>';

  $('pl-load').addEventListener('click', function(){ plOpen($('pl-date').value); });
  $('pl-today').addEventListener('click', function(){ $('pl-date').value=plYmd(new Date()); plOpen($('pl-date').value); });
  $('pl-tomorrow').addEventListener('click', function(){ var d=new Date(); d.setDate(d.getDate()+1); $('pl-date').value=plYmd(d); plOpen($('pl-date').value); });
  $('pl-go-assign').addEventListener('click', function(e){ e.preventDefault(); switchTab('settings'); switchSub('portassign'); });
  $('pl-file').addEventListener('change', function(){
    var f=this.files && this.files[0]; this.value='';
    if(f) plReadDriverFile(f);
  });
  $('pl-recent').addEventListener('click', function(e){
    var b=e.target.closest('[data-date]'); if(!b) return;
    $('pl-date').value=b.getAttribute('data-date'); plOpen(b.getAttribute('data-date'));
  });
  var body=$('pl-body');
  body.addEventListener('click', plOnClick);
  body.addEventListener('change', plOnChange);
  body.addEventListener('input', plOnInput);
  window.addEventListener('beforeunload', function(e){ if(plan.dirty){ e.preventDefault(); e.returnValue=''; } });
  plOpen($('pl-date').value);
}

function plOpen(date){
  if(!date){ toast('กรุณาเลือกวันที่ตรวจปล่อย'); return; }
  if(plan.dirty && plan.date && plan.date!==date && !confirm('แพลนวันที่ '+plDmy(plan.date)+' ยังไม่ได้บันทึก — เปลี่ยนวันที่และทิ้งการแก้ไข?')){
    $('pl-date').value=plan.date; return;
  }
  plan.loading=true;
  $('pl-body').innerHTML='<div class="center-load"><span class="spinner"></span> กำลังดึงงาน…</div>';
  api({action:'planLoad', token:state.token, date:date}).then(function(res){
    plan.loading=false;
    if(!guard(res)) return;
    if(!res.ok){ $('pl-body').innerHTML='<div class="err">'+esc(plErr(res.error))+'</div>'; return; }
    plan.date=res.date; plan.data=res; plan.dirty=false; plan.driverFile=(res.plan&&res.plan.driverFile)||'';
    plan.shippers=res.shippers||[];
    plan.assign={};
    (res.assignments||[]).forEach(function(a){ plan.assign[a.portKey]=a.username; });
    plBuildRows(res);
    plRender();
  }).catch(function(){ plan.loading=false; $('pl-body').innerHTML='<div class="err">เชื่อมต่อเซิร์ฟเวอร์ไม่ได้</div>'; });
}

function plJobToRow(job){
  return { id:null, bl:job.bl||'', containerNo:job.containerNo||'', port:job.port||'', destination:'', customer:job.customer||'',
           source:job.source||'', sheetShipping:job.sheetShipping||'', sheetUser:job.sheetUser||'',
           driverName:job.sheetDriver||'', plate:'', phone:'', username:'', assignedBy:'' };
}

function plBuildRows(res){
  var jobs=res.jobs||[];
  var byCnt={};
  jobs.forEach(function(j){ var k=plCntKey(j.containerNo); if(k && !byCnt[k]) byCnt[k]=j; });
  plan.newJobs=[];
  if(res.items && res.items.length){
    var seen={};
    plan.rows=res.items.map(function(it){
      var job=byCnt[plCntKey(it.containerNo)];
      seen[plCntKey(it.containerNo)||('#'+it.id)]=1;
      return { id:it.id, bl:it.bl, containerNo:it.containerNo, port:it.port, destination:it.destination, customer:it.customer,
               source:it.source, sheetShipping:it.sheetShipping, sheetUser:job?job.sheetUser:'',
               driverName:it.driverName, plate:it.plate, phone:it.phone, username:it.username, assignedBy:it.assignedBy };
    });
    // งานที่เพิ่งเข้ามาในตารางหลังบันทึกแพลน — ไม่เติมเอง ให้ผู้จัดการกดเพิ่ม
    plan.newJobs=jobs.filter(function(j){ var k=plCntKey(j.containerNo); return k ? !seen[k] : false; });
  } else {
    plan.rows=jobs.map(plJobToRow);
    plan.rows.forEach(plAuto);
  }
}

/** เลือกชิปปิ้งให้อัตโนมัติ: ชิปปิ้งประจำท่า (ของเดือนนั้น) → ชื่อชิปปิ้งในชีต → ว่าง — แถวที่แก้เองไม่แตะ */
function plAuto(row){
  if(row.assignedBy==='manual') return;
  var byPort=plan.assign[plPortKey(row.port)];
  if(row.port && byPort){ row.username=byPort; row.assignedBy='port'; return; }
  if(row.sheetUser){ row.username=row.sheetUser; row.assignedBy='sheet'; return; }
  row.username=''; row.assignedBy='';
}

function plSmsFor(row){
  if(!row.id || !plan.data) return null;
  var list=plan.data.sms||[];
  for(var i=0;i<list.length;i++){ if((list[i].itemIds||[]).indexOf(row.id)>=0) return list[i]; }
  return null;
}

function plSmsCell(row){
  var s=plSmsFor(row);
  if(!s) return '<span class="muted">—</span>';
  var out=[];
  if(s.status==='failed') out.push('<span class="pl-tag bad" title="'+esc(s.error)+'">ส่งไม่สำเร็จ</span>');
  else if(s.status==='queued') out.push('<span class="pl-tag">กำลังส่ง</span>');
  else out.push('<span class="pl-tag">ส่ง '+plHm(s.sentAt||s.createdAt)+'</span>');
  if(s.openedAt) out.push('<span class="pl-tag ok">เปิดอ่าน '+plHm(s.openedAt)+(s.openCount>1?' ('+s.openCount+')':'')+'</span>');
  else if(s.code && s.status!=='failed') out.push('<span class="pl-tag wait">'+(s.previewAt?'ถึงเครื่องแล้ว':'ยังไม่เปิด')+'</span>');
  if(s.locationStatus==='shared' && s.latitude!=null){
    out.push('<a class="pl-tag ok" target="_blank" rel="noopener" href="https://www.google.com/maps?q='+s.latitude+','+s.longitude+'">📍 '+plHm(s.locationAt)+'</a>');
  } else if(s.locationStatus==='denied') out.push('<span class="pl-tag bad">ไม่ให้ตำแหน่ง</span>');
  return out.join(' ');
}

function plShipperOptions(sel){
  var html='<option value="">— เลือกชิปปิ้ง —</option>';
  plan.shippers.forEach(function(s){
    html+='<option value="'+esc(s.username)+'"'+(String(sel).toLowerCase()===s.username.toLowerCase()?' selected':'')+'>'+esc(s.name||s.username)+'</option>';
  });
  return html;
}

function plRowHtml(row, i){
  var phoneOk = !!plSmsPhone(row.phone);
  var src = PL_SOURCE[row.source] || row.source || '—';
  var extra = row.source==='DRIVER FILE' || row.source==='MANUAL';
  var inp = function(f, cls, ph){ return '<input class="pl-in '+(cls||'')+'" data-f="'+f+'" value="'+esc(row[f])+'"'+(ph?' placeholder="'+esc(ph)+'"':'')+'>'; };
  return '<tr data-i="'+i+'" class="'+(extra?'pl-extra':'')+(row.username?'':' pl-unassigned')+'">'+
    '<td class="no">'+(i+1)+'</td>'+
    '<td><span class="pl-src'+(extra?' extra':'')+'" title="'+esc(row.source)+'">'+esc(src)+'</span></td>'+
    '<td>'+inp('bl','mono','BL')+(row.customer?'<div class="pl-sub" title="'+esc(row.customer)+'">'+esc(row.customer)+'</div>':'')+'</td>'+
    '<td>'+inp('containerNo','mono','เลขตู้')+'</td>'+
    '<td>'+inp('port','short','PORT')+'</td>'+
    '<td>'+inp('destination','short','ปลายทาง')+'</td>'+
    '<td>'+inp('driverName','','ชื่อ พขร')+'</td>'+
    '<td>'+inp('plate','wide','ทะเบียน')+'</td>'+
    '<td>'+inp('phone','mid'+(row.phone && !phoneOk?' bad':''),'โทรศัพท์')+(row.phone && !phoneOk?'<div class="pl-sub bad">ส่ง SMS ไม่ได้</div>':'')+'</td>'+
    '<td><select class="pl-in" data-f="username">'+plShipperOptions(row.username)+'</select>'+
      (row.username && PL_WHY[row.assignedBy]?'<div class="pl-sub">'+PL_WHY[row.assignedBy]+'</div>':'')+
      (!row.username?'<div class="pl-sub bad">ยังไม่กำหนด</div>':'')+'</td>'+
    (plan.data && plan.data.plan ? '<td class="pl-sms">'+plSmsCell(row)+'</td>' : '')+
    '<td><button class="btn btn-ghost btn-sm" data-act="del" title="ลบแถวนี้ออกจากแพลน">✕</button></td>'+
  '</tr>';
}

function plSummaryHtml(){
  var per={}, unassigned=0, noPhone=0, noDriver=0;
  plan.rows.forEach(function(r){
    if(r.username) per[r.username]=(per[r.username]||0)+1; else unassigned++;
    if(!plSmsPhone(r.phone)) noPhone++;
    if(!r.driverName) noDriver++;
  });
  var chips=Object.keys(per).sort().map(function(u){ return '<span class="pl-chip">'+esc(plShipperName(u))+' <b>'+per[u]+'</b> ตู้</span>'; });
  if(unassigned) chips.push('<span class="pl-chip bad">ยังไม่กำหนดชิปปิ้ง <b>'+unassigned+'</b></span>');
  if(noPhone) chips.push('<span class="pl-chip warn">ไม่มีเบอร์มือถือ <b>'+noPhone+'</b></span>');
  return '<div class="pl-summary"><span class="muted">ทั้งหมด <b>'+plan.rows.length+'</b> ตู้ •</span> '+chips.join(' ')+'</div>';
}

function plStatusHtml(){
  var p=plan.data && plan.data.plan;
  if(!p) return '<span class="pill pending">ยังไม่มีแพลน</span> <span class="muted">งานจากตาราง '+((plan.data&&plan.data.jobs)||[]).length+' ตู้</span>';
  if(p.status==='confirmed'){
    return '<span class="pill approved">Confirm แล้ว</span> <span class="muted">ครั้งที่ '+p.confirmCount+' • '+esc(plDT(p.confirmedAt))+' โดย '+esc(p.confirmedBy)+' — ชิปปิ้งเห็นงานแล้ว</span>';
  }
  return '<span class="pill pending">ร่าง</span> <span class="muted">บันทึกล่าสุด '+esc(plDT(p.updatedAt))+' — ชิปปิ้งยังไม่เห็นงาน</span>';
}

function plRender(){
  var d=plan.data; if(!d) return;
  // แถบวันที่ที่มีแพลนช่วงใกล้ ๆ
  $('pl-recent').innerHTML=(d.recent||[]).map(function(r){
    return '<button class="pl-day'+(r.date===plan.date?' on':'')+'" data-date="'+r.date+'">'+plDmy(r.date).slice(0,5)+
      ' <span>'+(r.status==='confirmed'?'✅':'📝')+' '+r.items+'</span></button>';
  }).join('');

  var confirmed = d.plan && d.plan.status==='confirmed';
  var html='<div class="pl-head">'+plStatusHtml()+(plan.dirty?' <span class="pill rejected">มีการแก้ไขที่ยังไม่บันทึก</span>':'')+'</div>';

  html+='<div class="pl-drv">'+
    '<div><b>ข้อมูลคนขับรถ</b> <span class="muted">'+(plan.driverFile?'ไฟล์ล่าสุด: '+esc(plan.driverFile):'ยังไม่ได้อัปไฟล์')+'</span></div>'+
    '<div class="pl-drv-acts">'+
      '<button class="btn btn-primary btn-sm" data-act="file">📥 อัปไฟล์ Excel / CSV</button>'+
      '<button class="btn btn-ghost btn-sm" data-act="paste">📋 วางข้อความ</button>'+
      '<button class="btn btn-ghost btn-sm" data-act="template">⬇ แบบฟอร์มไฟล์คนขับรถ</button>'+
    '</div>'+
    '<div id="pl-drv-msg"></div>'+
    '<details class="pl-map-help"><summary>ตาราง mapping ข้อมูลคนขับรถ (หัวคอลัมน์ที่ระบบอ่านได้)</summary>'+plMappingHelp()+'</details>'+
  '</div>';

  if(plan.newJobs.length){
    html+='<div class="pl-new">มีงานใหม่ในตาราง <b>'+plan.newJobs.length+'</b> ตู้ที่ยังไม่อยู่ในแพลน ('+
      esc(plan.newJobs.slice(0,4).map(function(j){return j.containerNo;}).join(', '))+(plan.newJobs.length>4?' …':'')+') '+
      '<button class="btn btn-primary btn-sm" data-act="addnew">＋ เพิ่มเข้าแพลน</button></div>';
  }

  html+='<div id="pl-summary-wrap">'+plSummaryHtml()+'</div>';

  if(!plan.rows.length){
    html+='<div class="center-load muted">ไม่มีงานในตาราง MAESOT FREEZONE / TRANSIT ของวันที่ '+plDmy(plan.date)+
      ' — อัปไฟล์คนขับรถเพื่อเพิ่มงานจากไฟล์ หรือกด “＋ เพิ่มแถว”</div>';
  } else {
    html+='<div class="tablewrap pl-wrap"><table class="inv-tbl pl-tbl"><thead><tr>'+
      '<th>#</th><th>ที่มา</th><th>BL</th><th>เลขตู้</th><th>PORT</th><th>ปลายทาง</th><th>ชื่อ พขร</th><th>ทะเบียน</th><th>โทรศัพท์</th><th>ชิปปิ้ง</th>'+
      (d.plan?'<th>SMS <button class="btn btn-ghost btn-sm" data-act="track" title="อัปเดตสถานะ SMS">↻</button></th>':'')+'<th></th>'+
      '</tr></thead><tbody>'+plan.rows.map(plRowHtml).join('')+'</tbody></table></div>';
  }

  html+='<div class="pl-actions">'+
    '<button class="btn btn-ghost btn-sm" data-act="addrow">＋ เพิ่มแถว</button>'+
    '<button class="btn btn-ghost btn-sm" data-act="reauto" title="เลือกชิปปิ้งใหม่ตามท่า/ชีต (ยกเว้นแถวที่แก้เอง)">↺ เลือกชิปปิ้งตามท่าอีกครั้ง</button>'+
    '<span class="grow"></span>'+
    (d.plan?'<button class="btn btn-ghost btn-sm" data-act="delete" style="color:#b91c1c">ลบแพลน</button>':'')+
    (confirmed
      ? '<button class="btn btn-ghost" data-act="unconfirm">ยกเลิก Confirm (ซ่อนจากชิปปิ้ง)</button>'+
        '<button class="btn btn-ok" data-act="confirm">✅ บันทึก + Confirm อีกครั้ง</button>'
      : '<button class="btn btn-ghost" data-act="draft">บันทึกร่าง</button>'+
        '<button class="btn btn-ok" data-act="confirm">✅ Confirm Plan → ส่งให้ชิปปิ้ง</button>')+
  '</div>';
  $('pl-body').innerHTML=html;
}

function plMappingHelp(){
  var rows=[
    ['BL','BL, B/L, BL NO, เลข BL','เลข BL — ใช้จับคู่เมื่อแถวนั้นไม่มีเลขตู้','AMP0564621'],
    ['เลขตู้','เลขตู้, ตู้, CONTAINER, CNTR','<b>ตัวจับคู่หลัก</b> กับงานในตาราง (ไม่สนช่องว่าง/ขีด)','SELU4613043'],
    ['PORT','PORT, ท่า, ท่าเรือ','ท่ารับตู้ — ใช้เลือกชิปปิ้งประจำท่าให้อัตโนมัติ','KERRY'],
    ['ปลายทาง','ปลายทาง, DESTINATION','ปลายทางของตู้','MSFZ'],
    ['ชื่อ พขร','ชื่อ พขร, คนขับ, DRIVER','ชื่อคนขับรถ — SMS ใช้ชื่อต้นแทน {ชื่อ}','บุญฤทธิ์ ศรีบุญเรือง'],
    ['ทะเบียน','ทะเบียน, ทะเบียนรถ, PLATE','ทะเบียนหัว - หาง','71-1270 ฉะเชิงเทรา - 71-1271 ฉะเชิงเทรา'],
    ['โทรศัพท์','โทรศัพท์, เบอร์โทร, เบอร์, TEL','เบอร์มือถือที่ส่ง SMS (หลายเบอร์ในช่องเดียวได้ ใช้เบอร์แรก)','093-143-8926']
  ];
  return '<table class="inv-tbl" style="margin-top:8px"><thead><tr><th>หัวคอลัมน์มาตรฐาน</th><th>ชื่อหัวคอลัมน์ที่อ่านได้</th><th>ใช้ทำอะไร</th><th>ตัวอย่าง</th></tr></thead><tbody>'+
    rows.map(function(r){ return '<tr><td><b>'+r[0]+'</b></td><td>'+esc(r[1])+'</td><td>'+r[2]+'</td><td class="mono">'+esc(r[3])+'</td></tr>'; }).join('')+
    '</tbody></table>'+
    '<div class="muted" style="margin-top:8px;line-height:1.6">รับได้ 2 แบบ: <b>(1) ตาราง</b> 1 แถว = 1 ตู้ หัวคอลัมน์ตามด้านบน (ลำดับคอลัมน์สลับได้) • '+
    '<b>(2) ข้อความแบบ “หัวข้อ : ค่า”</b> เรียงลงมาทีละตู้ (เช่นข้อความที่ส่งต่อมาจาก LINE) — แต่ละตู้เริ่มที่บรรทัด BL หรือเลขตู้<br>'+
    'ตู้ที่ไม่มีในตารางงานวันนั้นจะถูกเพิ่มเป็นแถว “ไฟล์คนขับ” (สีส้ม) ให้ตรวจก่อน Confirm</div>';
}

function plMarkDirty(){
  if(!plan.dirty){ plan.dirty=true; var h=document.querySelector('#pl-body .pl-head'); if(h) h.innerHTML=plStatusHtml()+' <span class="pill rejected">มีการแก้ไขที่ยังไม่บันทึก</span>'; }
  var s=$('pl-summary-wrap'); if(s) s.innerHTML=plSummaryHtml();
}

function plOnInput(e){
  var el=e.target; if(!el.classList || !el.classList.contains('pl-in') || el.tagName==='SELECT') return;
  var tr=el.closest('tr[data-i]'); if(!tr) return;
  var row=plan.rows[+tr.getAttribute('data-i')]; if(!row) return;
  row[el.getAttribute('data-f')]=el.value;
  plMarkDirty();
}

function plOnChange(e){
  var el=e.target; if(!el.classList || !el.classList.contains('pl-in')) return;
  var tr=el.closest('tr[data-i]'); if(!tr) return;
  var i=+tr.getAttribute('data-i'), row=plan.rows[i]; if(!row) return;
  var f=el.getAttribute('data-f');
  row[f]=el.value;
  if(f==='username') row.assignedBy = el.value ? 'manual' : '';
  if(f==='port') plAuto(row);
  if(f==='username' || f==='port' || f==='phone'){
    var tmp=document.createElement('tbody'); tmp.innerHTML=plRowHtml(row,i);
    tr.parentNode.replaceChild(tmp.firstChild, tr);
  }
  plMarkDirty();
}

function plOnClick(e){
  var b=e.target.closest('[data-act]'); if(!b) return;
  var act=b.getAttribute('data-act');
  if(act==='file') return $('pl-file').click();
  if(act==='paste') return plPasteDialog();
  if(act==='template') return plDownloadTemplate();
  if(act==='track') return plRefreshTracking(b);
  if(act==='addrow'){
    plan.rows.push({ id:null, bl:'', containerNo:'', port:'', destination:'', customer:'', source:'MANUAL', sheetShipping:'', sheetUser:'',
                     driverName:'', plate:'', phone:'', username:'', assignedBy:'' });
    plan.dirty=true; plRender();
    var ins=document.querySelectorAll('#pl-body tr[data-i] input[data-f="bl"]'); if(ins.length) ins[ins.length-1].focus();
    return;
  }
  if(act==='addnew'){
    plan.newJobs.forEach(function(j){ var r=plJobToRow(j); plAuto(r); plan.rows.push(r); });
    plan.newJobs=[]; plan.dirty=true; plRender(); return;
  }
  if(act==='reauto'){
    plan.rows.forEach(function(r){ if(r.assignedBy!=='manual') plAuto(r); });
    plan.dirty=true; plRender(); toast('เลือกชิปปิ้งตามท่าอีกครั้งแล้ว (แถวที่แก้เองไม่เปลี่ยน)'); return;
  }
  if(act==='del'){
    var tr=b.closest('tr[data-i]'); var i=+tr.getAttribute('data-i');
    plan.rows.splice(i,1); plan.dirty=true; plRender(); return;
  }
  if(act==='draft') return plSave('draft', b);
  if(act==='confirm') return plSave('confirm', b);
  if(act==='unconfirm'){
    if(!confirm('ยกเลิก Confirm แพลนวันที่ '+plDmy(plan.date)+'?\nชิปปิ้งจะไม่เห็นงานของวันนี้จนกว่าจะ Confirm อีกครั้ง')) return;
    return plSave('draft', b);
  }
  if(act==='delete'){
    if(!confirm('ลบแพลนวันที่ '+plDmy(plan.date)+' ทั้งหมด?\n(ประวัติ SMS ที่ส่งไปแล้วยังเก็บไว้)')) return;
    b.disabled=true;
    api({action:'planDelete', token:state.token, date:plan.date}).then(function(res){
      if(!guard(res)) return;
      if(!res.ok){ b.disabled=false; toast(plErr(res.error)); return; }
      plan.dirty=false; toast('ลบแพลนแล้ว'); plOpen(plan.date);
    });
  }
}

function plSave(mode, btn){
  var rows=plan.rows.filter(function(r){ return r.bl || r.containerNo; });
  if(mode==='confirm'){
    if(!rows.length){ toast('ยังไม่มีงานในแพลน'); return; }
    var unassigned=rows.filter(function(r){ return !r.username; }).length;
    if(unassigned){ toast('ยังมี '+unassigned+' แถวที่ไม่ได้เลือกชิปปิ้ง', 3500); return; }
    var per={}; rows.forEach(function(r){ per[r.username]=(per[r.username]||0)+1; });
    var lines=Object.keys(per).map(function(u){ return '• '+plShipperName(u)+' '+per[u]+' ตู้'; }).join('\n');
    var noPhone=rows.filter(function(r){ return !plSmsPhone(r.phone); }).length;
    if(!confirm('Confirm แพลนวันที่ '+plDmy(plan.date)+' และส่งงานให้ชิปปิ้ง?\n\n'+lines+(noPhone?'\n\n⚠️ ไม่มีเบอร์มือถือ '+noPhone+' ตู้ (ชิปปิ้งส่ง SMS หาคนขับไม่ได้)':''))) return;
  }
  btn.disabled=true;
  var items=rows.map(function(r){
    return { id:r.id, bl:r.bl, containerNo:r.containerNo, port:r.port, destination:r.destination, customer:r.customer, source:r.source,
             sheetShipping:r.sheetShipping, driverName:r.driverName, plate:r.plate, phone:r.phone, username:r.username, assignedBy:r.assignedBy };
  });
  api({action:'planSave', token:state.token, date:plan.date, mode:mode, items:items, driverFile:plan.driverFile}).then(function(res){
    btn.disabled=false;
    if(!guard(res)) return;
    if(!res.ok){ toast(plErr(res.error, res.detail), 4000); return; }
    plan.dirty=false;
    toast(mode==='confirm' ? '✅ Confirm แพลนแล้ว — ส่งงานให้ชิปปิ้ง '+Object.keys(res.perShipper||{}).length+' คน' : 'บันทึกแล้ว', 3500);
    plOpen(plan.date);
  }).catch(function(){ btn.disabled=false; toast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); });
}

function plRefreshTracking(btn){
  btn.disabled=true;
  api({action:'smsTracking', token:state.token, date:plan.date}).then(function(res){
    btn.disabled=false;
    if(!guard(res) || !res.ok) return;
    plan.data.sms=res.sms||[];
    document.querySelectorAll('#pl-body tr[data-i]').forEach(function(tr){
      var row=plan.rows[+tr.getAttribute('data-i')]; var td=tr.querySelector('.pl-sms');
      if(row && td) td.innerHTML=plSmsCell(row);
    });
    toast('อัปเดตสถานะ SMS แล้ว');
  });
}

// ---------- อ่านไฟล์ / ข้อความข้อมูลคนขับรถ ----------

var PL_FIELDS = {
  bl:['bl','blno','bl#','เลขbl','เลขที่bl','booking','bookingno','billoflading'],
  container:['เลขตู้','ตู้','หมายเลขตู้','เบอร์ตู้','container','containerno','cntr','cntrno','ctnr','ctn'],
  port:['port','ท่า','ท่าเรือ','ท่ารับตู้','ท่าส่งออก','portname'],
  destination:['ปลายทาง','destination','dest'],
  driver:['ชื่อพขร','พขร','ชื่อคนขับ','คนขับ','ชื่อคนขับรถ','คนขับรถ','driver','drivername','พนักงานขับรถ','ชื่อพนักงานขับรถ'],
  plate:['ทะเบียน','ทะเบียนรถ','plate','licenseplate','ทะเบียนหัวหาง','หัวหาง','truck','truckno'],
  phone:['โทรศัพท์','เบอร์โทร','เบอร์','โทร','เบอร์โทรศัพท์','tel','phone','mobile','เบอร์คนขับ','โทรศัพท์คนขับ','เบอร์มือถือ']
};
function plNormHead(v){ return String(v==null?'':v).toLowerCase().replace(/[\s.:：=\/\\_\-()[\]]+/g,''); }
function plFieldOf(head){
  var h=plNormHead(head); if(!h) return '';
  for(var f in PL_FIELDS){ if(PL_FIELDS[f].indexOf(h)>=0) return f; }
  // หัวคอลัมน์ที่เขียนต่างไปเล็กน้อย — เช็คเลขตู้ก่อนเบอร์โทร ("เบอร์ตู้" ต้องไม่กลายเป็นเบอร์โทร)
  if(/ตู้|container|cntr/.test(h)) return 'container';
  if(/พขร|คนขับ|driver/.test(h)) return 'driver';
  if(/ทะเบียน|plate/.test(h)) return 'plate';
  if(/โทร|เบอร์|phone|mobile|^tel/.test(h)) return 'phone';
  if(/ปลายทาง|destination/.test(h)) return 'destination';
  if(/^port|^ท่า/.test(h)) return 'port';
  if(/^bl|^b\/l|booking/.test(h)) return 'bl';
  return '';
}
function plCell(v){
  if(v==null) return '';
  return String(v).replace(/ /g,' ').trim();
}

/** แถวของชีต (array of arrays) → รายการคนขับรถ — ลองแบบตารางก่อน ไม่เจอหัวคอลัมน์ค่อยอ่านแบบ "หัวข้อ : ค่า" */
function plParseRows(aoa){
  for(var r=0; r<Math.min(aoa.length,15); r++){
    var cols={}, n=0;
    (aoa[r]||[]).forEach(function(cell, c){ var f=plFieldOf(cell); if(f && cols[f]==null){ cols[f]=c; n++; } });
    if(n>=3 && (cols.container!=null || cols.bl!=null)){
      var out=[];
      for(var k=r+1; k<aoa.length; k++){
        var row=aoa[k]||[], rec={};
        Object.keys(cols).forEach(function(f){ rec[f]=plCell(row[cols[f]]); });
        if(rec.container || rec.bl) out.push(rec);
      }
      return out;
    }
  }
  var lines=[];
  aoa.forEach(function(row){
    var cells=(row||[]).map(plCell).filter(Boolean);
    if(!cells.length) return;
    if(cells.some(function(c){ return c.indexOf('\n')>=0; })) cells.forEach(function(c){ c.split(/\r?\n/).forEach(function(l){ lines.push(l); }); });
    else lines.push(cells.join(' : '));
  });
  return plParseLines(lines);
}

function plParseLines(lines){
  var out=[], cur={};
  function flush(){ if(cur.container || cur.bl) out.push(cur); cur={}; }
  lines.forEach(function(line){
    var m=/^\s*([^:：=]{1,40}?)\s*[:：=]+\s*(.*)$/.exec(String(line||''));
    if(!m) return;
    var f=plFieldOf(m[1]); if(!f) return;
    var val=m[2].replace(/^[\s:：=]+/,'').trim();
    // เริ่มตู้ใหม่เมื่อเจอหัวข้อซ้ำ หรือเจอ BL/เลขตู้หลังจากตู้ก่อนหน้ามีข้อมูลคนขับแล้ว
    if(cur[f]!=null || ((f==='bl'||f==='container') && (cur.driver||cur.phone||cur.plate))) flush();
    cur[f]=val;
  });
  flush();
  return out;
}

function plTextToRecords(text){
  var raw=String(text||'').replace(/\r/g,'');
  if(raw.indexOf('\t')>=0) return plParseRows(raw.split('\n').map(function(l){ return l.split('\t'); }));
  return plParseLines(raw.split('\n'));
}

function plReadDriverFile(file){
  var name=file.name||'ไฟล์';
  var done=function(aoa){ plApplyDrivers(plParseRows(aoa), name); };
  var fail=function(msg){ $('pl-drv-msg').innerHTML='<div class="err" style="margin-top:10px">'+esc(msg)+'</div>'; };
  var reader=new FileReader();
  if(/\.csv$/i.test(name)){
    reader.onload=function(){ done(plCsvRows(String(reader.result||''))); };
    reader.readAsText(file, 'utf-8');
    return;
  }
  if(typeof XLSX==='undefined'){ fail('ตัวอ่านไฟล์ Excel ยังไม่โหลด (ต้องใช้อินเทอร์เน็ต) — หรือบันทึกเป็น .csv แล้วอัปใหม่'); return; }
  reader.onload=function(){
    try {
      var wb=XLSX.read(new Uint8Array(reader.result), {type:'array'});
      var all=[];
      // อ่านทุกชีตในไฟล์ แล้วเลือกชีตแรกที่อ่านเจอข้อมูลคนขับ
      for(var i=0;i<wb.SheetNames.length;i++){
        var aoa=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], {header:1, raw:false, defval:''});
        var recs=plParseRows(aoa);
        if(recs.length){ all=recs; break; }
      }
      plApplyDrivers(all, name);
    } catch(e){ fail('อ่านไฟล์ไม่ได้: '+(e && e.message || e)); }
  };
  reader.readAsArrayBuffer(file);
}

function plCsvRows(text){
  var rows=[], row=[], cell='', q=false;
  text=text.replace(/^﻿/,'');
  for(var i=0;i<text.length;i++){
    var ch=text[i];
    if(q){ if(ch==='"'){ if(text[i+1]==='"'){ cell+='"'; i++; } else q=false; } else cell+=ch; continue; }
    if(ch==='"') q=true;
    else if(ch===','){ row.push(cell); cell=''; }
    else if(ch==='\n'){ row.push(cell); rows.push(row); row=[]; cell=''; }
    else if(ch!=='\r') cell+=ch;
  }
  if(cell || row.length){ row.push(cell); rows.push(row); }
  return rows;
}

/** จับคู่ข้อมูลคนขับกับแถวงาน: เลขตู้ก่อน → ไม่มีเลขตู้ใช้ BL (แถวแรกที่ยังไม่มีคนขับ) → ไม่เจอ = เพิ่มแถวใหม่ */
function plApplyDrivers(records, fileName){
  var msg=$('pl-drv-msg');
  if(!records.length){
    msg.innerHTML='<div class="err" style="margin-top:10px">ไม่พบข้อมูลคนขับรถใน '+esc(fileName)+' — ตรวจหัวคอลัมน์ตามตาราง mapping ด้านล่าง</div>';
    return;
  }
  var matched=0, added=0, filled={};
  records.forEach(function(rec){
    var ck=plCntKey(rec.container), row=null, idx=-1;
    if(ck){ for(var i=0;i<plan.rows.length;i++){ if(plCntKey(plan.rows[i].containerNo)===ck){ row=plan.rows[i]; idx=i; break; } } }
    else if(rec.bl){
      var bk=plBlKey(rec.bl);
      for(var j=0;j<plan.rows.length;j++){ if(!filled[j] && plBlKey(plan.rows[j].bl)===bk){ row=plan.rows[j]; idx=j; break; } }
    }
    if(!row){
      row={ id:null, bl:rec.bl||'', containerNo:(rec.container||'').toUpperCase(), port:'', destination:'', customer:'', source:'DRIVER FILE',
            sheetShipping:'', sheetUser:'', driverName:'', plate:'', phone:'', username:'', assignedBy:'' };
      plan.rows.push(row); idx=plan.rows.length-1; added++;
    } else matched++;
    filled[idx]=1;
    if(rec.bl && !row.bl) row.bl=rec.bl;
    if(rec.port) row.port=rec.port;
    if(rec.destination) row.destination=rec.destination;
    if(rec.driver) row.driverName=rec.driver;
    if(rec.plate) row.plate=rec.plate.replace(/\s+/g,' ');
    if(rec.phone) row.phone=rec.phone;
    plAuto(row);
  });
  plan.driverFile=fileName; plan.dirty=true;
  plRender();
  var withoutDriver=plan.rows.filter(function(r,i){ return !filled[i]; }).length;
  $('pl-drv-msg').innerHTML='<div class="pl-ok">อ่าน <b>'+esc(fileName)+'</b>: '+records.length+' ตู้ • จับคู่กับงานในตารางได้ <b>'+matched+'</b>'+
    (added?' • <span style="color:#c2410c">ไม่อยู่ในตาราง เพิ่มเป็นแถวใหม่ '+added+'</span>':'')+
    (withoutDriver?' • งานที่ยังไม่มีข้อมูลคนขับ '+withoutDriver:'')+'</div>';
}

function plPasteDialog(){
  var bg=document.createElement('div');
  bg.className='modal-bg';
  bg.innerHTML='<div class="modal" style="max-width:620px"><h3>วางข้อมูลคนขับรถ</h3>'+
    '<p class="muted" style="margin:-6px 0 10px">วางข้อความแบบ “หัวข้อ : ค่า” ทีละตู้ (เช่นที่ส่งต่อมาจาก LINE) หรือก๊อปทั้งตารางจาก Excel มาวางก็ได้</p>'+
    '<textarea id="pl-paste-text" rows="12" style="width:100%;font-family:ui-monospace,Menlo,monospace;font-size:13px" placeholder="BL : AMP0564621\nเลขตู้ : SELU4613043\nPORT : KERRY\nปลายทาง : MSFZ\nชื่อ พขร : บุญฤทธิ์ ศรีบุญเรือง\nทะเบียน : 71-1270 ฉะเชิงเทรา - 71-1271 ฉะเชิงเทรา\nโทรศัพท์ : 093-143-8926"></textarea>'+
    '<div class="actions" style="margin-top:12px"><button class="btn btn-ghost btn-sm" data-x>ยกเลิก</button><button class="btn btn-primary btn-sm" data-ok>อ่านข้อมูล</button></div></div>';
  document.body.appendChild(bg);
  var close=function(){ bg.remove(); };
  bg.querySelector('[data-x]').onclick=close;
  bg.addEventListener('click', function(e){ if(e.target===bg) close(); });
  bg.querySelector('[data-ok]').onclick=function(){
    var recs=plTextToRecords($('pl-paste-text').value);
    if(!recs.length){ toast('อ่านข้อมูลไม่ได้ — ต้องมีบรรทัด BL หรือ เลขตู้'); return; }
    close(); plApplyDrivers(recs, 'ข้อความที่วาง');
  };
  setTimeout(function(){ $('pl-paste-text').focus(); }, 50);
}

function plDownloadTemplate(){
  var head=['BL','เลขตู้','PORT','ปลายทาง','ชื่อ พขร','ทะเบียน','โทรศัพท์'];
  var sample=['AMP0564621','SELU4613043','KERRY','MSFZ','บุญฤทธิ์ ศรีบุญเรือง','71-1270 ฉะเชิงเทรา - 71-1271 ฉะเชิงเทรา','093-143-8926'];
  if(typeof XLSX==='undefined'){
    var csv='﻿'+[head,sample].map(function(r){ return r.map(function(c){ return '"'+String(c).replace(/"/g,'""')+'"'; }).join(','); }).join('\n');
    var a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='แบบฟอร์มข้อมูลคนขับรถ.csv'; a.click();
    return;
  }
  var ws=XLSX.utils.aoa_to_sheet([head, sample]);
  ws['!cols']=[{wch:16},{wch:16},{wch:10},{wch:10},{wch:24},{wch:40},{wch:16}];
  var wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'คนขับรถ');
  XLSX.writeFile(wb, 'แบบฟอร์มข้อมูลคนขับรถ.xlsx');
}

// ======================= ตั้งค่า: ชิปปิ้งประจำท่า (รายเดือน) =======================

var pa = { ready:false, period:'', ports:[], shippers:[], map:{}, prev:null, extra:[] };

function initPortAssign(){
  if(pa.ready) return;
  pa.ready=true;
  var now=new Date();
  $('pa-month').value=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
  $('pa-month').addEventListener('change', function(){ paLoad(); });
  $('pa-copy').addEventListener('click', function(){
    if(!pa.prev || !pa.prev.rows.length){ toast('ยังไม่มีเดือนก่อนหน้าที่ตั้งไว้'); return; }
    pa.prev.rows.forEach(function(r){ pa.map[r.portKey]={ port:r.port, username:r.username }; if(paPortIndex(r.port)<0) pa.extra.push(r.port); });
    paRender(); $('pa-hint').textContent='คัดลอกจากเดือน '+paMonthTh(pa.prev.period)+' แล้ว — กดบันทึกเพื่อใช้';
  });
  $('pa-add').addEventListener('click', function(){
    var p=prompt('ชื่อท่าที่ต้องการเพิ่ม (เช่น A5, SiamCSP)'); p=String(p||'').trim();
    if(!p) return;
    if(paPortIndex(p)>=0){ toast('มีท่านี้อยู่แล้ว'); return; }
    pa.extra.push(p); paRender();
  });
  $('pa-save').addEventListener('click', paSave);
  $('pa-body').addEventListener('change', function(e){
    var sel=e.target.closest('select[data-pk]'); if(!sel) return;
    var key=sel.getAttribute('data-pk');
    pa.map[key]={ port:sel.getAttribute('data-port'), username:sel.value };
    paSummary(); $('pa-hint').textContent='ยังไม่ได้บันทึก';
  });
  paLoad();
}

function paMonthTh(period){
  var m=['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return m[+String(period).slice(4,6)-1]+' '+(+String(period).slice(0,4)+543);
}
function paAllPorts(){ return pa.ports.concat(pa.extra); }
function paPortIndex(p){ var k=plPortKey(p); var all=paAllPorts(); for(var i=0;i<all.length;i++) if(plPortKey(all[i])===k) return i; return -1; }

function paLoad(){
  var period=String($('pa-month').value||'').replace('-','');
  $('pa-body').innerHTML='<tr><td colspan="3"><div class="center-load"><span class="spinner"></span> กำลังโหลด…</div></td></tr>';
  api({action:'portAssignmentData', token:state.token, period:period}).then(function(res){
    if(!guard(res)) return;
    if(!res.ok){ $('pa-body').innerHTML='<tr><td colspan="3"><div class="err">'+esc(plErr(res.error))+'</div></td></tr>'; return; }
    pa.period=res.period; pa.ports=res.ports||[]; pa.shippers=res.shippers||[]; pa.prev=res.prev; pa.extra=[]; pa.map={};
    (res.rows||[]).forEach(function(r){ pa.map[r.portKey]={ port:r.port, username:r.username }; if(paPortIndex(r.port)<0) pa.extra.push(r.port); });
    $('pa-copy').textContent = pa.prev ? 'คัดลอกจากเดือน '+paMonthTh(pa.prev.period) : 'คัดลอกจากเดือนก่อน';
    $('pa-hint').textContent = res.rows && res.rows.length ? '' : 'เดือนนี้ยังไม่ได้ตั้ง';
    paRender();
  });
}

function paRender(){
  var all=paAllPorts();
  $('pa-body').innerHTML=all.map(function(p, i){
    var key=plPortKey(p), cur=(pa.map[key]||{}).username||'';
    var opts='<option value="">— ไม่กำหนด —</option>'+pa.shippers.map(function(s){
      return '<option value="'+esc(s.username)+'"'+(cur.toLowerCase()===s.username.toLowerCase()?' selected':'')+'>'+esc(s.name||s.username)+(s.shippingCode?' ('+esc(s.shippingCode)+')':'')+'</option>';
    }).join('');
    return '<tr><td>'+(i+1)+'</td><td class="name">'+esc(p)+'</td><td><select data-pk="'+esc(key)+'" data-port="'+esc(p)+'" style="min-width:200px">'+opts+'</select></td></tr>';
  }).join('') || '<tr><td colspan="3" class="muted">ยังไม่มีรายการท่า — เพิ่มได้ที่ ตั้งค่าระบบ → รายการเบิก → ท่า</td></tr>';
  paSummary();
}

function paSummary(){
  var by={};
  Object.keys(pa.map).forEach(function(k){ var r=pa.map[k]; if(r.username) (by[r.username]=by[r.username]||[]).push(r.port); });
  var names={}; pa.shippers.forEach(function(s){ names[s.username.toLowerCase()]=s.name||s.username; });
  var keys=Object.keys(by);
  $('pa-summary').innerHTML = keys.length
    ? keys.sort().map(function(u){ return '<div class="pa-sum"><b>'+esc(names[u.toLowerCase()]||u)+'</b> <span>'+by[u].map(esc).join(', ')+'</span></div>'; }).join('')
    : '<div class="muted">ยังไม่ได้กำหนดชิปปิ้งให้ท่าไหนในเดือน '+esc(paMonthTh(pa.period||''))+'</div>';
}

function paSave(){
  var btn=$('pa-save');
  var rows=Object.keys(pa.map).map(function(k){ return pa.map[k]; }).filter(function(r){ return r.username; });
  btn.disabled=true;
  api({action:'savePortAssignments', token:state.token, period:pa.period, rows:rows}).then(function(res){
    btn.disabled=false;
    if(!guard(res)) return;
    if(!res.ok){ toast(plErr(res.error, res.detail)); return; }
    $('pa-hint').textContent='บันทึกแล้ว ('+res.saved+' ท่า) • '+new Date().toLocaleTimeString('th-TH');
    toast('บันทึกชิปปิ้งประจำท่าเดือน '+paMonthTh(pa.period)+' แล้ว');
    if(plan.data && plan.data.period===pa.period){ plan.assign={}; rows.forEach(function(r){ plan.assign[plPortKey(r.port)]=r.username; }); }
  }).catch(function(){ btn.disabled=false; toast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); });
}

// ======================= ตั้งค่า: รูปแผนที่นัดหมาย =======================

var mm = { ready:false, list:[], ports:[], mapImg:null, photoImg:null, blob:null, w:0, h:0 };

function initMaps(){
  if(mm.ready) return;
  mm.ready=true;
  $('mm-map').addEventListener('change', function(){ mmLoadImg(this.files[0], 'mapImg'); });
  $('mm-photo').addEventListener('change', function(){ mmLoadImg(this.files[0], 'photoImg'); });
  $('mm-upload').addEventListener('click', mmUpload);
  $('mm-list').addEventListener('click', mmOnListClick);
  mmLoad();
}

function mmLoad(){
  api({action:'meetingMaps', token:state.token}).then(function(res){
    if(!guard(res) || !res.ok) return;
    mm.list=res.maps||[]; mm.ports=res.ports||[];
    $('mm-port').innerHTML='<option value="">— ไม่ผูกท่า —</option>'+mm.ports.map(function(p){ return '<option>'+esc(p)+'</option>'; }).join('');
    var c=res.smsConfig||{};
    $('mm-sms').innerHTML = c.dryRun
      ? '<div class="pill pending" style="display:inline-block">🧪 SMS โหมดทดสอบ (SMS_DRY_RUN) — บันทึกเหมือนส่งแล้ว แต่ไม่ส่งจริง</div>'
      : (c.ready ? '<div class="pill approved" style="display:inline-block">✅ ThaiBulkSMS พร้อมส่ง</div>'
                 : '<div class="pill rejected" style="display:inline-block">⚠️ ยังไม่ได้ตั้ง THAIBULKSMS_API_KEY / THAIBULKSMS_API_SECRET ใน Vercel — ชิปปิ้งยังส่งผ่านแอป SMS ในมือถือตัวเองได้</div>');
    mmRenderList();
  });
}

function mmRenderList(){
  if(!mm.list.length){ $('mm-list').innerHTML='<div class="muted">ยังไม่มีรูปแผนที่</div>'; return; }
  $('mm-list').innerHTML=mm.list.map(function(m){
    return '<div class="mm-card'+(m.active?'':' off')+'" data-id="'+esc(m.id)+'">'+
      '<a href="'+esc(m.url)+'" target="_blank" rel="noopener"><img src="'+esc(m.url)+'" alt="'+esc(m.name)+'" loading="lazy"></a>'+
      '<div class="mm-meta"><b>'+esc(m.name)+'</b><div class="muted">'+(m.port?'ท่า '+esc(m.port):'ไม่ผูกท่า')+' • '+m.width+'×'+m.height+(m.active?'':' • <b>ปิดใช้งาน</b>')+'</div></div>'+
      '<div class="mm-acts"><button class="btn btn-ghost btn-sm" data-act="edit">แก้ชื่อ/ท่า</button>'+
      '<button class="btn btn-ghost btn-sm" data-act="toggle">'+(m.active?'ปิดใช้งาน':'เปิดใช้งาน')+'</button></div>'+
    '</div>';
  }).join('');
}

function mmOnListClick(e){
  var b=e.target.closest('[data-act]'); if(!b) return;
  var card=b.closest('[data-id]'); var id=card.getAttribute('data-id');
  var m=mm.list.filter(function(x){ return x.id===id; })[0]; if(!m) return;
  var payload={ action:'saveMeetingMap', token:state.token, id:id, name:m.name, port:m.port };
  if(b.getAttribute('data-act')==='toggle') payload.active=!m.active;
  else {
    var name=prompt('ชื่อรูป', m.name); if(name==null) return;
    var port=prompt('ผูกกับท่า (เว้นว่าง = ไม่ผูกท่า)\nท่าที่มี: '+mm.ports.join(', '), m.port); if(port==null) return;
    payload.name=name.trim()||m.name; payload.port=port.trim();
  }
  b.disabled=true;
  api(payload).then(function(res){ b.disabled=false; if(!guard(res)) return; if(!res.ok){ toast(plErr(res.error)); return; } mmLoad(); });
}

function mmLoadImg(file, slot){
  mm[slot]=null; mm.blob=null;
  if(!file){ mmCompose(); return; }
  var url=URL.createObjectURL(file), img=new Image();
  img.onload=function(){ mm[slot]=img; if(slot==='mapImg' && !$('mm-name').value) $('mm-name').value=file.name.replace(/\.[^.]+$/,''); mmCompose(); };
  img.onerror=function(){ toast('เปิดรูปนี้ไม่ได้ — ใช้ไฟล์ JPG/PNG'); };
  img.src=url;
}

/** รวมแผนที่ + รูปหน้างานจริงเป็นภาพเดียว (เรียงบน-ล่าง มีแถบหัวข้อ) — มีแค่แผนที่ก็ย่อขนาดอย่างเดียว */
function mmCompose(){
  var prev=$('mm-preview');
  if(!mm.mapImg){ prev.innerHTML=''; $('mm-upload').disabled=true; return; }
  var a=mm.mapImg, b=mm.photoImg, c=document.createElement('canvas'), g=c.getContext('2d');
  var W=Math.min(1400, Math.max(a.naturalWidth, b?b.naturalWidth:0));
  var ha=Math.round(a.naturalHeight*W/a.naturalWidth), hb=b?Math.round(b.naturalHeight*W/b.naturalWidth):0;
  var bar=b?Math.round(W*0.045):0;
  var H=ha+hb+bar*2;
  if(H>4200){ var s=4200/H; W=Math.round(W*s); ha=Math.round(ha*s); hb=Math.round(hb*s); bar=Math.round(bar*s); H=ha+hb+bar*2; }
  c.width=W; c.height=H;
  g.fillStyle='#fff'; g.fillRect(0,0,W,H);
  var label=function(y, text, color){
    g.fillStyle=color; g.fillRect(0,y,W,bar);
    g.fillStyle='#fff'; g.font='bold '+Math.round(bar*0.55)+'px "Noto Sans Thai", sans-serif'; g.textBaseline='middle';
    g.fillText(text, Math.round(bar*0.4), y+bar/2);
  };
  if(b) label(0, 'แผนที่จุดนัด', '#002967');
  g.drawImage(a, 0, bar, W, ha);
  if(b){ label(bar+ha, 'หน้างานจริง', '#e08a00'); g.drawImage(b, 0, bar*2+ha, W, hb); }
  mm.w=W; mm.h=H;
  c.toBlob(function(blob){
    mm.blob=blob;
    prev.innerHTML='<img src="'+URL.createObjectURL(blob)+'" alt="ตัวอย่าง"><div class="muted">'+W+'×'+H+' px • '+Math.round(blob.size/1024)+' KB</div>';
    $('mm-upload').disabled=false;
  }, 'image/jpeg', 0.85);
}

function mmUpload(){
  var name=$('mm-name').value.trim();
  if(!mm.blob){ toast('เลือกรูปแผนที่ก่อน'); return; }
  if(!name){ toast('ตั้งชื่อรูปก่อน'); $('mm-name').focus(); return; }
  var btn=$('mm-upload'); btn.disabled=true; btn.textContent='กำลังอัปโหลด…';
  var reset=function(){ btn.disabled=false; btn.textContent='⬆ อัปโหลดรูป'; };
  api({action:'signMapUpload', token:state.token}).then(function(up){
    if(!guard(up)) return;
    if(!up.ok) throw new Error(up.error);
    return fetch(up.uploadUrl, { method:'PUT', headers:{'Content-Type':'image/jpeg'}, body:mm.blob }).then(function(r){
      if(!r.ok) throw new Error('upload_failed');
      return api({ action:'saveMeetingMap', token:state.token, key:up.key, name:name, port:$('mm-port').value, width:mm.w, height:mm.h, size:mm.blob.size });
    });
  }).then(function(res){
    reset();
    if(!res) return;
    if(!res.ok){ toast(plErr(res.error)); return; }
    toast('อัปโหลดรูปแผนที่แล้ว');
    $('mm-name').value=''; $('mm-map').value=''; $('mm-photo').value=''; mm.mapImg=mm.photoImg=mm.blob=null; mmCompose();
    mmLoad();
  }).catch(function(e){ reset(); toast('อัปโหลดไม่สำเร็จ: '+plErr(String(e && e.message || e))); });
}
