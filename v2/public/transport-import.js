/**
 * เมนูแพลนงาน → "📥 รับ Transport Request" — ส่วน 1 ของตารางขนส่งของระบบ (transport_records)
 * ตอนนี้นำเข้าจากไฟล์ Transport Request (ระหว่างรอ ERP KOLA ส่งมาเอง)
 *   วาง Copy/Paste จาก Google Sheet / Excel (รวมแถวหัวตาราง) หรืออัปไฟล์ .xlsx / .csv
 *   คอลัมน์: ETA · SHIPPER · CON · BILL OF LADING · CONTAINER NO. · SHIPLINE · VESSEL · PORT (หาจากหัวตาราง ไม่สนลำดับ)
 *   กด "ตรวจข้อมูล" ดูตัวอย่าง (ใหม่ / อัปเดต / ผิดพลาด + ชิปปิ้งประจำท่า) แล้วจึงกด "นำเข้า"
 * ใช้ $, api, state, esc, toast จาก admin.html • XLSX (SheetJS) ที่ admin.html โหลดไว้
 */
var trState = { ready:false, rows:[], preview:null };

var TR_HEADERS = [
  { k:'transportDate', re:/^\s*(ETA|TRANSPORT|DATE|วันที่)/i },
  { k:'customer', re:/SHIPPER|ชิปเปอร์/i },
  { k:'quantity', re:/^\s*(CON|CONT|QTY)\s*$|จำนวนตู้/i },
  { k:'bl', re:/BILL\s*OF\s*LADING|^\s*B\s*\/?\s*L\b|เลข\s*BL/i },
  { k:'containers', re:/CONTAINER/i },
  { k:'vessel', re:/SHIP\s*LINE|สายเรือ/i },
  { k:'vesselName', re:/^\s*VESSEL/i },
  { k:'port', re:/^\s*PORT|ท่า/i }
];
// ไม่มีแถวหัวตาราง = ใช้ลำดับเดียวกับไฟล์ Transport Request
var TR_ORDER = ['transportDate','customer','quantity','bl','containers','vessel','vesselName','port'];

/** แยกข้อความที่วางมา (TSV จาก Google Sheet/Excel หรือ CSV) — รองรับช่องที่มี "…" และขึ้นบรรทัดใหม่ในช่อง */
function trParseDelimited(text, delim){
  var rows=[], row=[], cell='', q=false, i, c;
  for(i=0;i<text.length;i++){
    c=text[i];
    if(q){
      if(c==='"'){ if(text[i+1]==='"'){ cell+='"'; i++; } else q=false; }
      else cell+=c;
    } else if(c==='"' && cell===''){ q=true; }
    else if(c===delim){ row.push(cell); cell=''; }
    else if(c==='\n'){ row.push(cell); rows.push(row); row=[]; cell=''; }
    else if(c!=='\r'){ cell+=c; }
  }
  if(cell!=='' || row.length){ row.push(cell); rows.push(row); }
  return rows.filter(function(r){ return r.some(function(x){ return String(x).trim(); }); });
}

/** วันที่ → yyyy-MM-dd : d/m/yyyy (พ.ศ. ก็ได้) · yyyy-mm-dd · เลขวันที่ของ Excel */
function trDate(v){
  var s=String(v==null?'':v).trim(), m;
  if(/^\d{5}(\.\d+)?$/.test(s)){ var d=new Date(Date.UTC(1899,11,30)+Math.round(Number(s))*86400000); return d.toISOString().slice(0,10); }
  if((m=/^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');
  if((m=/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/.exec(s))){
    var y=Number(m[3]); if(y<100) y+=2000; if(y>2400) y-=543;
    return y+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
  }
  return s;
}

/** ตาราง (array ของแถว) → แถวที่ส่งให้เซิร์ฟเวอร์ */
function trRowsFromTable(table){
  var headIdx=-1, map={};
  for(var r=0;r<Math.min(table.length,10);r++){
    var cells=table[r].map(function(x){ return String(x||'').replace(/\s+/g,' ').trim(); });
    if(cells.some(function(c){ return TR_HEADERS[3].re.test(c); })){
      headIdx=r;
      cells.forEach(function(c, i){
        // SHIPLINE ต้องจับก่อน VESSEL (หัว "VESSEL" ไม่ใช่สายเรือ)
        for(var h=0;h<TR_HEADERS.length;h++){
          var def=TR_HEADERS[h];
          if(map[def.k]==null && def.re.test(c)){ map[def.k]=i; break; }
        }
      });
      break;
    }
  }
  if(headIdx<0) TR_ORDER.forEach(function(k,i){ map[k]=i; });
  var out=[];
  table.slice(headIdx+1).forEach(function(cells, i){
    var get=function(k){ return map[k]==null ? '' : String(cells[map[k]]==null?'':cells[map[k]]).trim(); };
    if(!get('bl') && !get('containers')) return;
    out.push({ line:headIdx+2+i, transportDate:trDate(get('transportDate')), customer:get('customer'),
      quantity:get('quantity'), bl:get('bl'), containers:get('containers'), vessel:get('vessel'),
      vesselName:get('vesselName'), port:get('port') });
  });
  return { rows:out, header:headIdx>=0, columns:Object.keys(map) };
}

function initTransportImport(){
  if(trState.ready) return;
  trState.ready=true;
  var today=new Date(), ymd=today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0')+'-'+String(today.getDate()).padStart(2,'0');
  $('tab-tr').innerHTML=''
    + '<h2 style="margin:0 0 6px">รับ Transport Request</h2>'
    + '<p class="muted" style="margin:0 0 14px">ส่วนที่ 1 ของตารางขนส่ง (วันที่ · ชิปเปอร์ · สายเรือ · BL · เลขตู้ · จำนวนตู้ · ท่า · ชิปปิ้ง) — '
    + 'ตอนนี้นำเข้าจากไฟล์ Transport Request ระหว่างรอ ERP KOLA ส่งมาเอง • ชิปปิ้ง = ชิปปิ้งประจำท่าของเดือนนั้น (ตั้งค่าระบบ → ชิปปิ้งประจำท่า) • '
    + 'BL + วันที่เดิม นำเข้าซ้ำ = อัปเดตข้อมูลส่วนนี้ (ยอดเงินส่วนอื่นไม่หาย)</p>'
    + '<div class="card" style="margin-bottom:16px">'
    + '<div class="toolbar"><label style="display:flex;align-items:center;gap:6px">ไฟล์งาน <select id="tr-source"><option>MAESOT FREEZONE</option><option>TRANSIT</option></select></label>'
    + '<label class="btn btn-ghost btn-sm" style="cursor:pointer">📎 เลือกไฟล์ .xlsx / .csv<input id="tr-file" type="file" accept=".xlsx,.xls,.csv,.tsv,.txt" hidden></label>'
    + '<span id="tr-file-name" class="muted"></span></div>'
    + '<textarea id="tr-paste" rows="7" style="width:100%;box-sizing:border-box;font-family:ui-monospace,Menlo,monospace;font-size:12px" '
    + 'placeholder="วางข้อมูลที่ Copy จาก Google Sheet / Excel ตรงนี้ (รวมแถวหัวตาราง ETA · SHIPPER · CON · BILL OF LADING · CONTAINER NO. · SHIPLINE · VESSEL · PORT)"></textarea>'
    + '<div class="toolbar" style="margin-top:8px"><button id="tr-check" class="btn btn-primary btn-sm">ตรวจข้อมูล</button>'
    + '<button id="tr-commit" class="btn btn-ok btn-sm" disabled>นำเข้า</button>'
    + '<button id="tr-clear" class="btn btn-ghost btn-sm">ล้าง</button><span id="tr-msg" class="muted"></span></div>'
    + '<div id="tr-preview"></div></div>'
    + '<div class="card"><div class="toolbar"><b>งานที่นำเข้าแล้ว</b><label style="display:flex;align-items:center;gap:6px">วันที่ <input id="tr-day" type="date" value="'+ymd+'"></label>'
    + '<button id="tr-day-load" class="btn btn-ghost btn-sm">ดู</button><span class="grow"></span>'
    + '<button id="tr-del" class="btn btn-danger btn-sm" disabled>ลบที่เลือก</button></div><div id="tr-day-list" class="muted">เลือกวันที่แล้วกด "ดู"</div></div>';

  $('tr-file').addEventListener('change', function(){
    var f=this.files&&this.files[0]; if(!f) return;
    $('tr-file-name').textContent=f.name;
    var reader=new FileReader();
    if(/\.(xlsx|xls)$/i.test(f.name)){
      if(!window.XLSX){ $('tr-msg').textContent='ตัวอ่าน .xlsx ยังไม่โหลด (ต้องใช้อินเทอร์เน็ต) — Copy ข้อมูลมาวางแทนได้'; return; }
      reader.onload=function(){
        var wb=XLSX.read(new Uint8Array(reader.result), { type:'array', cellDates:false });
        var ws=wb.Sheets[wb.SheetNames[0]];
        var table=XLSX.utils.sheet_to_json(ws, { header:1, raw:true, defval:'' });
        trLoadTable(table, f.name+' (ชีต '+wb.SheetNames[0]+')');
      };
      reader.readAsArrayBuffer(f);
    } else {
      reader.onload=function(){
        var t=String(reader.result||''), delim=t.indexOf('\t')>=0?'\t':',';
        trLoadTable(trParseDelimited(t, delim), f.name);
      };
      reader.readAsText(f, 'utf-8');
    }
    this.value='';
  });
  $('tr-check').addEventListener('click', function(){
    var t=$('tr-paste').value;
    if(!t.trim() && !trState.rows.length){ $('tr-msg').textContent='วางข้อมูลหรือเลือกไฟล์ก่อน'; return; }
    if(t.trim()) trLoadTable(trParseDelimited(t, t.indexOf('\t')>=0?'\t':','), 'ข้อมูลที่วาง');
    else trCheck(false);
  });
  $('tr-commit').addEventListener('click', function(){
    var s=trState.preview&&trState.preview.summary; if(!s) return;
    if(!confirm('นำเข้า '+(s.new+s.update)+' BL ('+$('tr-source').value+')?'+String.fromCharCode(10)+'ใหม่ '+s.new+' · อัปเดต '+s.update+(s.error?' · ข้าม (ผิดพลาด) '+s.error:''))) return;
    trCheck(true);
  });
  $('tr-clear').addEventListener('click', function(){
    trState.rows=[]; trState.preview=null; $('tr-paste').value=''; $('tr-file-name').textContent='';
    $('tr-preview').innerHTML=''; $('tr-msg').textContent=''; $('tr-commit').disabled=true;
  });
  $('tr-source').addEventListener('change', function(){ if(trState.rows.length) trCheck(false); });
  $('tr-day-load').addEventListener('click', trLoadDay);
  $('tr-del').addEventListener('click', trDelete);
}

function trLoadTable(table, label){
  var parsed=trRowsFromTable(table);
  trState.rows=parsed.rows;
  if(!parsed.rows.length){ $('tr-msg').textContent='ไม่พบแถวข้อมูลใน '+label+' (ต้องมีคอลัมน์ BILL OF LADING)'; $('tr-commit').disabled=true; return; }
  $('tr-msg').textContent=label+': '+parsed.rows.length+' แถว'+(parsed.header?'':' (ไม่พบหัวตาราง — ใช้ลำดับคอลัมน์ตามไฟล์ Transport Request)');
  trCheck(false);
}

function trCheck(commit){
  $('tr-check').disabled=true; $('tr-commit').disabled=true;
  $('tr-msg').textContent=commit?'กำลังนำเข้า…':'กำลังตรวจ…';
  api({ action:'importTransportRequest', token:state.token, source:$('tr-source').value, rows:trState.rows, commit:!!commit }).then(function(res){
    $('tr-check').disabled=false;
    if(!res.ok){ $('tr-msg').textContent=(commit?'นำเข้า':'ตรวจ')+'ไม่สำเร็จ: '+(res.error==='no_rows'?'ไม่มีแถวข้อมูล':res.error); return; }
    trState.preview=res;
    var s=res.summary;
    $('tr-msg').innerHTML=(res.committed?'<b style="color:#047857">นำเข้าแล้ว</b> ':'')+'ใหม่ <b>'+s.new+'</b> · อัปเดต <b>'+s.update+'</b>'
      +(s.error?' · <span style="color:#b42318">ผิดพลาด '+s.error+' (ไม่นำเข้า)</span>':'')
      +(s.noShipping?' · <span style="color:#b45309">ยังไม่มีชิปปิ้งประจำท่า '+s.noShipping+' BL</span>':'');
    trRenderPreview(res.preview);
    $('tr-commit').disabled=res.committed || !(s.new+s.update);
    if(res.committed){
      var first=(res.preview.filter(function(p){ return p.status!=='error'; })[0]||{}).transportDate;
      if(first){ $('tr-day').value=first; trLoadDay(); }
    }
  }).catch(function(){ $('tr-check').disabled=false; $('tr-msg').textContent='เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'; });
}

function trDmy(v){ var m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v||'')); return m?(+m[3])+'/'+(+m[2])+'/'+m[1]:esc(v); }
var TR_STATUS={ 'new':'<span class="pill approved">ใหม่</span>', update:'<span class="pill pending">อัปเดต</span>', error:'<span class="pill rejected">ผิดพลาด</span>' };

function trRenderPreview(list){
  $('tr-preview').innerHTML='<div class="tablewrap" style="margin-top:10px;max-height:60vh;overflow:auto"><table class="inv-tbl"><thead><tr>'
    +'<th>แถว</th><th>สถานะ</th><th>ETA</th><th>ชิปเปอร์</th><th>BL</th><th>เลขตู้</th><th class="num">CON</th><th>สายเรือ</th><th>เรือ</th><th>ท่า</th><th>ชิปปิ้ง</th><th>หมายเหตุ</th></tr></thead><tbody>'
    +list.map(function(p){
      return '<tr><td class="num">'+p.line+'</td><td>'+(TR_STATUS[p.status]||'')+'</td><td>'+trDmy(p.transportDate)+'</td><td>'+esc(p.customer)+'</td>'
        +'<td class="mono">'+esc(p.bl)+'</td><td class="mono" style="white-space:pre-line;font-size:12px">'+esc((p.containers||[]).join('\n'))+'</td>'
        +'<td class="num">'+(p.quantity||'')+'</td><td>'+esc(p.vessel)+'</td><td style="font-size:12px">'+esc(p.vesselName)+'</td><td>'+esc(p.port)+'</td>'
        +'<td>'+(p.shipping?esc(p.shipping):(p.status==='error'?'':'<span style="color:#b45309">ไม่มีชิปปิ้งประจำท่า '+esc(p.port)+'</span>'))+'</td>'
        +'<td style="color:'+(p.error?'#b42318':'#b45309')+'">'+esc(p.error||p.warning||'')+'</td></tr>';
    }).join('')+'</tbody></table></div>';
}

function trLoadDay(){
  var date=$('tr-day').value; if(!date) return;
  $('tr-day-list').textContent='กำลังโหลด…';
  api({ action:'transportRecordsDay', token:state.token, date:date }).then(function(res){
    if(!res.ok){ $('tr-day-list').textContent='โหลดไม่สำเร็จ: '+res.error; return; }
    $('tr-del').disabled=true;
    if(!res.rows.length){ $('tr-day-list').textContent='ไม่มีงานที่นำเข้าของวันที่ '+trDmy(date); return; }
    $('tr-day-list').innerHTML='<div class="tablewrap" style="margin-top:8px"><table class="inv-tbl"><thead><tr><th><input type="checkbox" id="tr-all" aria-label="เลือกทั้งหมด"></th>'
      +'<th>ไฟล์งาน</th><th>ชิปเปอร์</th><th>BL</th><th>เลขตู้</th><th class="num">ตู้</th><th>สายเรือ</th><th>ท่า</th><th>ชิปปิ้ง</th></tr></thead><tbody>'
      +res.rows.map(function(r){
        return '<tr><td><input type="checkbox" class="tr-pick" value="'+esc(r.id)+'"></td><td style="font-size:12px">'+esc(r.source)+'</td><td>'+esc(r.customer)+'</td>'
          +'<td class="mono">'+esc(r.bl)+'</td><td class="mono" style="white-space:pre-line;font-size:12px">'+esc(r.containers.join('\n'))+'</td>'
          +'<td class="num">'+r.quantity+'</td><td>'+esc(r.vessel)+'</td><td>'+esc(r.port)+'</td><td>'+esc(r.shipping||'—')+'</td></tr>';
      }).join('')+'</tbody></table></div><div class="muted" style="margin-top:6px">'+res.rows.length+' BL · '
      +res.rows.reduce(function(n,r){ return n+r.quantity; },0)+' ตู้</div>';
    var sync=function(){ $('tr-del').disabled=!$('tr-day-list').querySelector('.tr-pick:checked'); };
    $('tr-all').addEventListener('change', function(){ var on=this.checked; $('tr-day-list').querySelectorAll('.tr-pick').forEach(function(c){ c.checked=on; }); sync(); });
    $('tr-day-list').querySelectorAll('.tr-pick').forEach(function(c){ c.addEventListener('change', sync); });
  });
}

function trDelete(){
  var ids=Array.prototype.map.call($('tr-day-list').querySelectorAll('.tr-pick:checked'), function(c){ return c.value; });
  if(!ids.length || !confirm('ลบ '+ids.length+' BL ออกจากตารางขนส่งของระบบ?')) return;
  api({ action:'deleteTransportRecord', token:state.token, ids:ids }).then(function(res){
    if(!res.ok){ alert('ลบไม่สำเร็จ: '+res.error); return; }
    trLoadDay();
  });
}
