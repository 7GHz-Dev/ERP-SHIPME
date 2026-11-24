/**
 * ตารางขนส่ง (อ่านอย่างเดียว) — แสดงชีตงานขนส่งที่ sync เข้าระบบ (API transportTable)
 * ใช้ทั้งแท็บ "ตารางขนส่ง" ในหน้า admin และหน้า /transport (ลิงก์จากหน้าพนักงาน)
 *
 * TransportTable.mount(root, { api: function(payload) → Promise, token: string })
 * - เลือกไฟล์ (MAESOT FREEZONE / TRANSIT) + เดือน (แท็บในชีต) — เปิดมาเป็นเดือนล่าสุด
 * - กรองในเดือนนั้น: ช่องค้นหา + ชิปปิ้ง • ค้นทุกเดือน (BL / ตู้ / ชิปเปอร์ / คนรถ / หมายเหตุ ≥ 3 ตัวอักษร)
 * - รูปแบบตามแท็บ "สำเนาของ พฤศจิกายน69": 1 แถว = 1 BL เลขตู้เรียงในช่องเดียว สีหัวคอลัมน์ตามกลุ่ม
 * - ซ่อนคอลัมน์ที่ว่างทั้งคอลัมน์ได้ • แถวรวมท้ายตาราง • หัวตารางค้างตอนเลื่อน
 */
(function(global){
  'use strict';
  // ลำดับ/สีหัวคอลัมน์ตามแท็บ "สำเนาของ พฤศจิกายน69" ในชีต (1 แถว = 1 BL)
  // g = สีกลุ่มหัวคอลัมน์ • hr = หัวคอลัมน์ตัวแดง • red = ตัวเลขสีแดง
  var B='#a4c2f4', Y='#ffd966', P='#ffc7ce', O='#ff9900';
  var COLS = [
    { k:'transportDate', h:'TRANSPORT', t:'date', g:B },
    { k:'customer', h:'ชิปเปอร์', t:'wrap', g:B },
    { k:'vessel', h:'VESSEL', g:B },
    { k:'bl', h:'เลข BL', g:B },
    { k:'containerNo', h:'CONTAINER NO.', t:'stack', g:B },
    { k:'quantity', h:'จำนวนตู้', t:'qty', g:Y },
    { k:'doFee', h:'แลก DO', t:'money', g:Y, red:1 },
    { k:'dem', h:'DEM', t:'money', g:Y, hr:1 },
    { k:'extraMovement', h:'EXTRA MOVEMENT', t:'money', g:Y, hr:1, red:1 },
    { k:'storage', h:'STORAGE', t:'money', g:Y, hr:1 },
    { k:'liftOn', h:'LIFT ON', t:'money', g:Y },
    { k:'liftOff', h:'LIFT OFF', t:'money', g:Y },
    { k:'orderForm', h:'ORDER FORM', t:'money', g:Y },
    { k:'overtime', h:'ค่าล่วงเวลา', t:'money', g:P },
    { k:'sealFee', h:'ค่าตะกั่ว', t:'money', g:P },
    { k:'prb', h:'พรบ.', t:'money', g:P },
    { k:'prbService', h:'ค่าบริการ พรบ.', t:'money', g:O },
    { k:'inspectorFee', h:'ค่านายตรวจ', t:'money', g:O },
    { k:'er', h:'ค่าแลก ER', t:'money', g:O },
    { k:'knock', h:'น็อคตู้', t:'money', g:O },
    { k:'tire', h:'ยางเกิน', t:'money', g:O },
    { k:'falseDecl', h:'สำแดงเท็จ', t:'money', g:O },
    { k:'detention', h:'ค่า Detention', t:'money', g:B },
    { k:'repairFee', h:'ค่าซ่อมตู้', t:'money', g:B },
    { k:'otherFee', h:'คชจ. อื่นๆ', t:'money', g:B },
    { k:'note', h:'หมายเหตุ', t:'wide', g:B },
    { k:'port', h:'ท่าส่งออก', g:B },
    { k:'docSentDate', h:'ส่งแม่สอด', t:'date', g:B },
    { k:'shipping', h:'ชิปปิ้ง', g:B },
    { k:'invoiceNo', h:'เลขที่ใบแจ้งหนี้', g:B },
    { k:'driver', h:'รายชื่อคนรถ', g:B },
    { k:'settled', h:'ปิดบัญชีแล้ว', t:'bool', g:B }
  ];
  var SOURCE_COL = { k:'_where', h:'ไฟล์ / เดือน', g:B };
  var LINE = '#9aa3ad';
  var CSS = ''
    + '.tt{font-size:14px;color:#0f172a}'
    + '.tt-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}'
    + '.tt-seg{display:inline-flex;border:1px solid #cbd5e1;border-radius:10px;overflow:hidden}'
    + '.tt-seg button{border:0;background:#fff;padding:8px 14px;font:inherit;font-weight:600;color:#334155;cursor:pointer;min-height:38px}'
    + '.tt-seg button+button{border-left:1px solid #cbd5e1}'
    + '.tt-seg button.on{background:#1f3a5f;color:#fff}'
    + '.tt select,.tt input[type=search]{padding:8px 10px;border:1px solid #cbd5e1;border-radius:10px;font:inherit;background:#fff;min-height:38px;max-width:100%}'
    + '.tt input[type=search]{flex:1 1 220px;min-width:0}'
    + '.tt-btn{border:1px solid #cbd5e1;background:#fff;border-radius:10px;padding:8px 12px;font:inherit;font-weight:600;color:#1f3a5f;cursor:pointer;min-height:38px}'
    + '.tt-btn:disabled{opacity:.5;cursor:default}'
    + '.tt-chk{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:#475569}'
    + '.tt-info{font-size:13px;color:#64748b;margin:0 2px 8px}'
    + '.tt-info b{color:#0f172a}'
    + '.tt-wrap{overflow:auto;max-height:calc(100vh - 230px);min-height:240px;border:1px solid '+LINE+';background:#fff}'
    + '.tt table{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%;font-family:Sarabun,"Noto Sans Thai",Tahoma,sans-serif;font-size:13px;color:#000}'
    + '.tt th{position:sticky;top:0;z-index:2;color:#000;font-weight:700;text-align:center;vertical-align:middle;padding:8px 8px;line-height:1.25;'
    +   'border-right:1px solid '+LINE+';border-bottom:2px solid #333;white-space:normal;min-width:72px;max-width:130px}'
    + '.tt th.hr{color:#e00000}'
    + '.tt td{padding:3px 8px;border-right:1px solid '+LINE+';border-bottom:1px solid '+LINE+';white-space:nowrap;vertical-align:middle;text-align:center;background:#fff}'
    + '.tt tbody tr:hover td{background:#eef6ff}'
    + '.tt .n{font-variant-numeric:tabular-nums}'
    + '.tt .red{color:#e00000}'
    + '.tt .st{white-space:pre-line;line-height:1.3}'
    + '.tt .w{white-space:normal;min-width:160px;max-width:300px;text-align:left}'
    + '.tt .r{white-space:normal;min-width:140px;max-width:230px}'
    + '.tt .ix{color:#64748b;background:#f8fafc}'
    + '.tt tfoot td{position:sticky;bottom:0;background:#e3eaf4;font-weight:700;color:#1f3a5f;border-top:2px solid #333}'
    + '.tt-empty{padding:28px;text-align:center;color:#64748b}'
    + '.tt-where{font-size:12px;color:#475569}'
    + '@media (max-width:640px){.tt-wrap{max-height:calc(100vh - 290px)}.tt table{font-size:12.5px}}';

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function money(n){ return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function dmy(v){ var m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v||'')); return m ? (+m[3])+'/'+(+m[2])+'/'+m[1] : String(v||''); }
  function stamp(iso){
    var d=new Date(iso); if(isNaN(d)) return '';
    return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  }
  function isEmpty(col, v){
    if(col.t==='money'||col.t==='qty') return !(Number(v)>0);
    if(col.t==='bool') return !v;
    return !String(v==null?'':v).trim();
  }
  function cell(col, row){
    var v=row[col.k];
    if(col.k==='_where') return '<td class="tt-where">'+esc(row.source)+'<br>'+esc(row.sheet)+'</td>';
    if(col.t==='money') return '<td class="n'+(col.red?' red':'')+'">'+(Number(v)>0?money(v):'')+'</td>';
    if(col.t==='qty') return '<td class="n">'+(Number(v)>0?money(v):'')+'</td>';
    if(col.t==='date') return '<td>'+esc(dmy(v))+'</td>';
    if(col.t==='bool') return '<td>'+(v?'✓':'')+'</td>';
    if(col.t==='stack') return '<td class="st">'+esc(v)+'</td>';
    if(col.t==='wide') return '<td class="w">'+esc(v)+'</td>';
    if(col.t==='wrap') return '<td class="r">'+esc(v)+'</td>';
    return '<td>'+esc(v)+'</td>';
  }
  function injectCss(){
    if(document.getElementById('tt-css')) return;
    var s=document.createElement('style'); s.id='tt-css'; s.textContent=CSS; document.head.appendChild(s);
  }

  function mount(root, opts){
    injectCss();
    var st={ tabs:[], source:'', sheet:'', rows:[], q:'', searching:false, loading:false, hideEmpty:false, ship:'' };
    root.classList.add('tt');
    root.innerHTML = ''
      + '<div class="tt-bar"><div class="tt-seg" role="group" aria-label="ไฟล์"></div>'
      + '<select class="tt-sheet" aria-label="เดือน (แท็บในชีต)"></select>'
      + '<select class="tt-ship" aria-label="ชิปปิ้ง"><option value="">ทุกชิปปิ้ง</option></select>'
      + '<button type="button" class="tt-btn tt-reload" title="โหลดข้อมูลล่าสุดจากระบบ">โหลดใหม่</button></div>'
      + '<div class="tt-bar"><input type="search" class="tt-q" placeholder="ค้นหา BL / ตู้ / ชิปเปอร์ / คนรถ / หมายเหตุ" aria-label="ค้นหา">'
      + '<button type="button" class="tt-btn tt-all" title="ค้นหาทุกเดือนทุกไฟล์ (อย่างน้อย 3 ตัวอักษร)">🔎 ค้นทุกเดือน</button>'
      + '<label class="tt-chk"><input type="checkbox" class="tt-hide"> ซ่อนคอลัมน์ว่าง</label></div>'
      + '<div class="tt-info"></div><div class="tt-wrap"></div>';
    var $ = function(sel){ return root.querySelector(sel); };

    function load(params){
      st.loading=true; info('กำลังโหลด…');
      var payload={ action:'transportTable', token:opts.token };
      for(var k in params) payload[k]=params[k];
      return opts.api(payload).then(function(res){
        st.loading=false;
        if(!res || !res.ok){
          var e=res&&res.error;
          info(e==='search_too_short' ? 'พิมพ์อย่างน้อย 3 ตัวอักษรเพื่อค้นทุกเดือน'
            : (e==='session_expired'||e==='invalid_token'||e==='no_token') ? 'หมดเวลาเข้าสู่ระบบ — กรุณาเข้าสู่ระบบใหม่'
            : e==='forbidden' ? 'บัญชีนี้ไม่มีสิทธิ์ดูตารางขนส่ง' : 'โหลดไม่สำเร็จ: '+(e||'ไม่ทราบสาเหตุ'));
          return;
        }
        st.tabs=res.tabs||[]; st.rows=res.rows||[];
        if(res.q){ st.searching=true; st.q=res.q; st.truncated=!!res.truncated; }
        else { st.searching=false; st.q=''; st.source=res.source; st.sheet=res.sheet; st.system=!!res.system; }
        st.ship='';
        renderBar(); render();
      }).catch(function(){ st.loading=false; info('โหลดไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วกด "โหลดใหม่"'); });
    }
    function info(html){ $('.tt-info').innerHTML=html; }

    function renderBar(){
      var sources=[]; st.tabs.forEach(function(t){ if(sources.indexOf(t.source)<0) sources.push(t.source); });
      $('.tt-seg').innerHTML=sources.map(function(s){
        return '<button type="button" data-s="'+esc(s)+'" class="'+(!st.searching&&s===st.source?'on':'')+'" aria-pressed="'+(!st.searching&&s===st.source)+'">'+esc(s)+'</button>';
      }).join('');
      var mine=st.tabs.filter(function(t){ return t.source===st.source; });
      $('.tt-sheet').innerHTML=mine.map(function(t){
        return '<option value="'+esc(t.sheet)+'"'+(t.sheet===st.sheet?' selected':'')+'>'+esc(t.sheet)+' ('+(t.bls||t.rows)+' BL)</option>';
      }).join('');
      $('.tt-sheet').disabled=st.searching;
      var ships={}; st.rows.forEach(function(r){ var s=String(r.shipping||'').trim(); if(s) ships[s]=(ships[s]||0)+1; });
      $('.tt-ship').innerHTML='<option value="">ทุกชิปปิ้ง</option>'+Object.keys(ships).sort().map(function(s){
        return '<option value="'+esc(s)+'"'+(s===st.ship?' selected':'')+'>'+esc(s)+' ('+ships[s]+')</option>';
      }).join('');
    }

    function visibleRows(){
      var q=$('.tt-q').value.trim().toLowerCase();
      return st.rows.filter(function(r){
        if(st.ship && String(r.shipping||'').trim()!==st.ship) return false;
        if(!q || st.searching) return true;
        return [r.bl,r.containerNo,r.customer,r.shipping,r.driver,r.note,r.vessel,r.port,r.invoiceNo].join(' ').toLowerCase().indexOf(q)>=0;
      });
    }

    function render(){
      var rows=visibleRows();
      var cols=(st.searching?[SOURCE_COL]:[]).concat(COLS.filter(function(c){
        if(!st.hideEmpty) return true;
        return rows.some(function(r){ return !isEmpty(c, r[c.k]); });
      }));
      if(!rows.length) cols=(st.searching?[SOURCE_COL]:[]).concat(COLS.slice(0,8));
      var tab=st.tabs.filter(function(t){ return t.source===st.source && t.sheet===st.sheet; })[0];
      var boxes=rows.reduce(function(n,r){ return n+(Number(r.quantity)||0); },0);
      var head = st.searching
        ? 'ผลค้นหา "<b>'+esc(st.q)+'</b>" ทุกเดือน • '+rows.length+' BL'+(st.truncated?' (แสดง 300 BL แรก — พิมพ์ให้เจาะจงขึ้น)':'')+' • <a href="#" class="tt-back">กลับไปดูรายเดือน</a>'
        : '<b>'+esc(st.source)+' — '+esc(st.sheet)+'</b> • '+rows.length+(rows.length!==st.rows.length?' จาก '+st.rows.length:'')+' BL • '+boxes.toLocaleString('en-US')+' ตู้'
          +(tab&&tab.from?' • วันที่ '+dmy(tab.from)+' – '+dmy(tab.to):'')
          +(st.system?' • <b style="color:#047857">ข้อมูลจากระบบ</b> (Transport Request + ใบปิดบัญชี + ใบแจ้งหนี้)':'')
          +(tab&&tab.syncedAt?(st.system?' • อัปเดตล่าสุด ':' • อัปเดตจากชีตล่าสุด ')+stamp(tab.syncedAt):'');
      info(head);
      var back=$('.tt-back'); if(back) back.addEventListener('click',function(e){ e.preventDefault(); $('.tt-q').value=''; load({ source:st.source, sheet:st.sheet }); });
      if(!rows.length){
        $('.tt-wrap').innerHTML='<div class="tt-empty">'+(st.rows.length?'ไม่มีแถวที่ตรงกับตัวกรอง':'ไม่มีข้อมูล')+'</div>';
        return;
      }
      var totals={}; cols.forEach(function(c){ if(c.t==='money'||c.t==='qty') totals[c.k]=rows.reduce(function(s,r){ return s+(Number(r[c.k])||0); },0); });
      var html='<table><thead><tr><th style="background:#e2e8f0;min-width:36px">#</th>'+cols.map(function(c){
        return '<th'+(c.hr?' class="hr"':'')+' style="background:'+c.g+'">'+esc(c.h)+'</th>';
      }).join('')+'</tr></thead><tbody>';
      rows.forEach(function(r,i){ html+='<tr><td class="ix">'+(i+1)+'</td>'+cols.map(function(c){ return cell(c,r); }).join('')+'</tr>'; });
      html+='</tbody><tfoot><tr><td></td>'+cols.map(function(c,i){
        if(c.k in totals) return '<td class="n">'+money(totals[c.k])+'</td>';
        return i===0?'<td>รวม '+rows.length+' BL</td>':'<td></td>';
      }).join('')+'</tr></tfoot></table>';
      $('.tt-wrap').innerHTML=html;
    }

    root.addEventListener('click',function(e){
      var b=e.target.closest&&e.target.closest('.tt-seg button');
      if(b){ $('.tt-q').value=''; load({ source:b.getAttribute('data-s') }); }
    });
    $('.tt-sheet').addEventListener('change',function(){ $('.tt-q').value=''; load({ source:st.source, sheet:this.value }); });
    $('.tt-ship').addEventListener('change',function(){ st.ship=this.value; render(); });
    $('.tt-hide').addEventListener('change',function(){ st.hideEmpty=this.checked; render(); });
    $('.tt-reload').addEventListener('click',function(){ st.searching ? load({ q:st.q }) : load({ source:st.source, sheet:st.sheet }); });
    var timer;
    $('.tt-q').addEventListener('input',function(){
      if(st.searching) return;
      clearTimeout(timer); timer=setTimeout(render,150);
    });
    $('.tt-q').addEventListener('keydown',function(e){ if(e.key==='Enter' && this.value.trim().length>=3) load({ q:this.value.trim() }); });
    $('.tt-all').addEventListener('click',function(){
      var q=$('.tt-q').value.trim();
      if(q.length<3){ info('พิมพ์อย่างน้อย 3 ตัวอักษรในช่องค้นหา แล้วกด "ค้นทุกเดือน"'); $('.tt-q').focus(); return; }
      load({ q:q });
    });
    load({});
    return { reload:function(){ load({ source:st.source, sheet:st.sheet }); } };
  }

  global.TransportTable = { mount:mount };
})(window);
