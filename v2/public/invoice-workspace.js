/**
 * หัวข้อที่อยู่ในใบ VAT แต่ไม่ต้องคิด VAT — ค่าแลก DO เป็นเงินที่ออกแทนลูกค้า
 * ต้องตรงกับ INVOICE_VAT_EXEMPT_LABELS ฝั่งเซิร์ฟเวอร์ ไม่งั้นยอดหน้าเว็บกับที่บันทึกจะไม่ตรงกัน
 */
var INV_VAT_EXEMPT = ['ADV - ค่าแลก DO (NON VAT)'];
function invVatExempt(label){
  return INV_VAT_EXEMPT.indexOf(String(label==null?'':label).replace(/\s+/g,' ').trim()) >= 0;
}
/** ฐานภาษี = ยอดรวมหักหัวข้อที่ไม่คิด VAT ออก */
function invVatBase(items){
  return Math.round(items.reduce(function(sum,item){
    return sum + (invVatExempt(item.label) ? 0 : (Number(item.amount)||0));
  },0)*100)/100;
}
function invoicePeriod(){ return $('inv-issue-date').value.slice(0,7).replace('-',''); }
/**
 * เลขเริ่มต้นมีชุดเดียว — V กับ NV ใช้ลำดับเดียวกันเสมอ
 * รับได้ทั้ง V20260901 / NV20260901 / 20260901 / 1
 */
function invoiceStart(){
  var value = $('inv-start').value.trim().toUpperCase();
  var period=invoicePeriod();
  if(value.indexOf('NV'+period)===0) value=value.slice(('NV'+period).length);
  else if(value.indexOf('V'+period)===0) value=value.slice(('V'+period).length);
  else if(value.indexOf(period)===0 && value.length>6) value=value.slice(6);
  if(!/^[0-9]{1,6}$/.test(value) || Number(value)<1) return null;
  return Number(value);
}
function fillInvoiceStarts(){
  var el=$('inv-start');
  if(!el.value) el.value=(invState.cfg && invState.cfg.period===invoicePeriod() && invState.cfg.next.V) || 'V'+invoicePeriod()+'01';
}
/**
 * เติมเลขให้ทุกแถวตามเลขเริ่มต้น — หนึ่ง BL กินหนึ่งลำดับ ไม่ว่าจะออกกี่ใบ
 *
 * V กับ NV ของ BL เดียวกันใช้เลขเดียวกันเสมอ เช่น V20260901 คู่กับ NV20260901
 * BL ที่ออกแต่ใบ V เลข NV ของชุดนั้นจะถูกข้ามไปเลย ไม่เอากลับมาใช้กับ BL ถัดไป
 * BL ถัดไปจึงได้ V20260902 + NV20260902 ไม่ใช่ NV20260901
 *
 * แถวที่ผู้ใช้พิมพ์เลขเองไว้ (numberEdited) จะไม่ถูกเขียนทับ แต่ยังกินลำดับตามเดิม
 * เพื่อไม่ให้แถวถัดไปได้เลขซ้ำกับที่พิมพ์ไว้
 */
function assignInvoiceNumbers(){
  var seq=invoiceStart();
  (invState.visible||[]).forEach(function(row,i){
    row.numbers=row.numbers||{};
    // เลขของแถวนี้ตัวเดียว ใช้ร่วมกันทั้ง V และ NV
    var running=seq===null || seq>999999?null:seq++;
    ['V','NV'].forEach(function(kind){
      // BL ที่ออกไปแล้วอาจมีแค่ฝั่งเดียว (เช่น NON VAT ไม่มียอด) — ฝั่งที่ไม่ได้ออกยังต้องได้เลขถัดไปตามปกติ
      var created=row.createdPair&&row.createdPair.find(function(doc){return doc.kind===kind;});
      var auto=running===null?'':kind+invoicePeriod()+String(running).padStart(2,'0');
      if(created) row.numbers[kind]=created.number;
      else if(row.issued&&row.issued[kind]) row.numbers[kind]=row.issued[kind];
      else if(!(row.numberEdited&&row.numberEdited[kind])) row.numbers[kind]=auto;
      var el=$('inv-number-'+i+'-'+kind);
      if(el&&el.value!==row.numbers[kind]&&document.activeElement!==el) el.value=row.numbers[kind]||'';
    });
  });
}
/**
 * จำเงื่อนไขค้นหาไว้ — สลับแท็บแล้วกลับมาต้องได้ค่าเดิม รวมถึงเปิดหน้าใหม่ด้วย
 * เก็บเฉพาะตัวกรอง ไม่เก็บยอดหรือเลขใบ เพราะต้องดึงสดจากเซิร์ฟเวอร์เสมอ
 */
var INV_FILTER_KEY='invoiceFilters';
var INV_FILTER_IDS=['inv-search','inv-from','inv-to','inv-filter'];
function saveInvoiceFilters(){
  var data={};
  INV_FILTER_IDS.forEach(function(id){ data[id]=$(id).value; });
  try{ localStorage.setItem(INV_FILTER_KEY,JSON.stringify(data)); }catch(e){ /* โหมดส่วนตัวเขียนไม่ได้ ไม่ใช่เรื่องคอขาดบาดตาย */ }
}
function restoreInvoiceFilters(){
  var data=null;
  try{ data=JSON.parse(localStorage.getItem(INV_FILTER_KEY)||'null'); }catch(e){ data=null; }
  if(!data) return;
  INV_FILTER_IDS.forEach(function(id){ if(typeof data[id]==='string') $(id).value=data[id]; });
}
function initInvoiceWorkspace(){
  if(invState.workspaceReady) return; invState.workspaceReady=true;
  // Build the local date explicitly to avoid UTC date changes around midnight.
  var d=new Date(); $('inv-issue-date').value=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  restoreInvoiceFilters();
  // เลือกวันที่เริ่มต้น = ตั้งวันที่สิ้นสุดให้ตรงกัน แต่แก้เองทีหลังได้
  $('inv-from').addEventListener('change',function(){
    if(this.value && (!$('inv-to').value || $('inv-to').value < this.value)) $('inv-to').value=this.value;
    saveInvoiceFilters(); loadInvoiceSources();
  });
  $('inv-to').addEventListener('change',function(){ saveInvoiceFilters(); loadInvoiceSources(); });
  // inv-from / inv-to จัดการบันทึกเองแล้วด้านบน เหลือแค่ช่องค้นหากับตัวกรอง
  $('inv-search').addEventListener('input',saveInvoiceFilters);
  $('inv-filter').addEventListener('change',saveInvoiceFilters);
  $('inv-start').addEventListener('input',assignInvoiceNumbers);
  $('inv-issue-date').addEventListener('change',function(){
    $('inv-start').value=''; fillInvoiceStarts(); assignInvoiceNumbers();
  });
  $('inv-all').addEventListener('change',function(){
    var checked=this.checked;
    (invState.visible||[]).forEach(function(row){row.picked=checked;});
    $('inv-src-body').querySelectorAll('.inv-pick').forEach(function(cb){cb.checked=checked;}); updateInvoicePicked();
  });
  $('inv-preview-picked').addEventListener('click',function(){runInvoicePair(false,pickedInvoiceRows());});
  $('inv-create-picked').addEventListener('click',function(){runInvoicePair(true,pickedInvoiceRows());});
}
function inlineInvoiceItems(row,kind){
  return ((row.invoiceItems||{})[kind]||[]).filter(function(item){return item.selected;}).map(function(item,i){
    return {no:i+1,label:item.label.trim(),amount:Math.round(Number(item.amount)*100)/100,qty:0,unitPrice:0,note:''};
  });
}
function invoiceRowIssued(row){
  return !!(row.createdPair || (row.issued && (row.issued.V || row.issued.NV)));
}
function renderInlineInvoiceItems(row,index,kind){
  // ออกใบไปแล้วห้ามแก้ยอดหรือเลข — ต้องให้ admin ยกเลิกใบเดิมก่อน
  var locked=invoiceRowIssued(row)?' disabled':'';
  return '<input type="text" class="inv-row-number inv-number-edit" id="inv-number-'+index+'-'+kind+'" data-row="'+index+'" data-kind="'+kind+'"'+locked+' aria-label="เลขที่ใบแจ้งหนี้ '+kind+'" placeholder="เลขที่ใบแจ้งหนี้"><div class="inv-cost-list">'+((row.invoiceItems||{})[kind]||[]).map(function(item,i){
    var attrs=' data-row="'+index+'" data-kind="'+kind+'" data-item="'+i+'"'+locked;
    var id='inv-cost-'+index+'-'+kind+'-'+i;
    return '<div class="inv-cost-row"><input id="'+id+'" type="checkbox" class="inv-cost"'+attrs+(item.selected?' checked':'')+' aria-label="เลือก '+esc(item.label)+'">'
      +(item.custom?'<input type="text" class="inv-cost"'+attrs+' value="'+esc(item.label)+'" placeholder="ชื่อรายการ" aria-label="ชื่อรายการ '+kind+'">':'<label for="'+id+'">'+esc(item.label)+'</label>')
      +'<input type="number" min="0" max="1000000000" step="0.01" class="inv-cost"'+attrs+' value="'+item.amount+'" aria-label="'+esc(item.label)+' ยอดก่อน VAT"></div>';
  }).join('')+'</div><button class="btn btn-ghost btn-sm inv-add-inline" data-row="'+index+'" data-kind="'+kind+'"'+locked+' style="margin-top:10px">+ เพิ่มรายการ '+(kind==='V'?'VAT':'NON VAT')+'</button><div class="inv-cost-total" id="inv-total-'+index+'-'+kind+'"></div>';
}
function updateInlineInvoiceTotal(row,index,kind){
  var list=inlineInvoiceItems(row,kind);
  var subtotal=Math.round(list.reduce(function(sum,item){return sum+(Number.isFinite(item.amount)?item.amount:0);},0)*100)/100;
  var vat=kind==='V'?Math.round(invVatBase(list)*7)/100:0;
  $('inv-total-'+index+'-'+kind).innerHTML='<span>ก่อน VAT '+baht(subtotal)+'</span><b>รวม '+baht(Math.round((subtotal+vat)*100)/100)+'</b>';
}
function loadInvoiceSources(){
  $('inv-src-body').innerHTML='<tr><td colspan="9" class="muted">กำลังโหลด…</td></tr>';
  api({action:'invoiceSources',token:state.token,from:$('inv-from').value,to:$('inv-to').value}).then(function(res){
    if(!res.ok){$('inv-inline-msg').textContent='โหลดไม่สำเร็จ: '+res.error;return;}
    invState.sources=(res.rows||[]).sort(function(a,b){return a.inspectDate.localeCompare(b.inspectDate)||a.bl.localeCompare(b.bl)||a.settlementId.localeCompare(b.settlementId);});
    renderInvoiceSources();
  }).catch(function(){ $('inv-inline-msg').textContent='โหลดรายการไม่สำเร็จ โปรดลองใหม่'; });
}
function renderInvoiceSources(){
  var q=$('inv-search').value.trim().toLowerCase(),mode=$('inv-filter').value;
  var rows=invState.sources.filter(function(row){
    var done=!!(row.issued&&(row.issued.V||row.issued.NV));
    return !(mode==='open'&&done) && !(mode==='done'&&!done) && (!q||[row.bl,row.name,row.username].join(' ').toLowerCase().indexOf(q)>=0);
  });
  invState.visible=rows;
  $('inv-src-body').innerHTML=rows.map(function(row,i){
    var issued=['V','NV'].map(function(kind){return row.issued&&row.issued[kind]?'<span class="pill approved">'+esc(row.issued[kind])+'</span>':'';}).join('');
    return '<tr><td><input type="checkbox" class="inv-pick" data-row="'+i+'"'+(row.picked?' checked':'')+'></td><td>'+esc(row.inspectDate)+'</td><td>'+esc(row.name||row.username)+'</td><td><b>'+esc(row.bl)+'</b></td><td class="right">'+(row.containers||0)+'</td>'
      +'<td>'+renderInlineInvoiceItems(row,i,'V')+'</td><td>'+renderInlineInvoiceItems(row,i,'NV')+'</td><td>'+(issued||'<span class="muted">ยังไม่ออก</span>')+'</td>'
      +'<td><div class="inv-row-actions"><button class="btn btn-ghost btn-sm inv-row-preview" data-row="'+i+'">Preview</button><button class="btn btn-primary btn-sm inv-row-create" data-row="'+i+'"'+(invoiceRowIssued(row)?' disabled':'')+'>สร้างใบแจ้งหนี้</button></div></td></tr>';
  }).join('')||'<tr><td colspan="9" class="muted">ไม่มีรายการ</td></tr>';
  $('inv-src-body').querySelectorAll('.inv-pick').forEach(function(cb){cb.onchange=function(){rows[Number(cb.dataset.row)].picked=cb.checked;updateInvoicePicked();};});
  $('inv-src-body').querySelectorAll('.inv-cost').forEach(function(input){
    input.addEventListener(input.type==='checkbox'?'change':'input',function(){
      var row=rows[Number(input.dataset.row)],item=row.invoiceItems[input.dataset.kind][Number(input.dataset.item)];
      if(input.type==='checkbox') item.selected=input.checked;
      else if(input.type==='text') item.label=input.value;
      else item.amount=input.value===''?NaN:Number(input.value);
      updateInlineInvoiceTotal(row,Number(input.dataset.row),input.dataset.kind);
    });
  });
  // แก้เลขที่ใบแจ้งหนี้เองได้รายแถว — normalize ให้เป็นรูปแบบเดียวกับที่เซิร์ฟเวอร์รับ
  $('inv-src-body').querySelectorAll('.inv-number-edit').forEach(function(input){
    input.addEventListener('input',function(){
      var row=rows[Number(input.dataset.row)],kind=input.dataset.kind;
      row.numbers=row.numbers||{};row.numberEdited=row.numberEdited||{};
      row.numbers[kind]=input.value.trim().toUpperCase();
      row.numberEdited[kind]=true;
      updateInvoicePicked();
    });
    // ช่องว่าง = กลับไปใช้เลขรันอัตโนมัติ
    input.addEventListener('blur',function(){
      var row=rows[Number(input.dataset.row)],kind=input.dataset.kind;
      if(!input.value.trim()){ if(row.numberEdited) row.numberEdited[kind]=false; assignInvoiceNumbers(); }
      updateInvoicePicked();
    });
  });
  $('inv-src-body').querySelectorAll('.inv-add-inline').forEach(function(btn){btn.onclick=function(){
    var row=rows[Number(btn.dataset.row)],items=row.invoiceItems[btn.dataset.kind];
    if(items.length>=100){$('inv-inline-msg').textContent='เพิ่มได้ไม่เกิน 100 รายการต่อใบ';return;}
    items.push({label:'',amount:0,selected:true,custom:true});renderInvoiceSources();
    var fields=$('inv-src-body').querySelectorAll('input[type=text][data-row="'+btn.dataset.row+'"][data-kind="'+btn.dataset.kind+'"]');
    if(fields.length) fields[fields.length-1].focus();
  };});
  ['preview','create'].forEach(function(action){$('inv-src-body').querySelectorAll('.inv-row-'+action).forEach(function(btn){btn.onclick=function(){runInvoicePair(action==='create',[rows[Number(btn.dataset.row)]]);};});});
  rows.forEach(function(row,i){['V','NV'].forEach(function(kind){updateInlineInvoiceTotal(row,i,kind);});});
  assignInvoiceNumbers();updateInvoicePicked();
}
function pickedInvoiceRows(){return (invState.visible||[]).filter(function(row){return row.picked;});}
function updateInvoicePicked(){
  var rows=pickedInvoiceRows(),busy=!!invState.saving;
  if(!busy){
    $('inv-pane-new').querySelectorAll('[data-invoice-busy]').forEach(function(el){el.disabled=false;el.removeAttribute('data-invoice-busy');});
  }
  $('inv-picked').textContent='เลือกไว้ '+rows.length+' รายการ';
  $('inv-preview-picked').disabled=busy||!rows.length;
  $('inv-create-picked').disabled=busy||!rows.length||rows.some(invoiceRowIssued);
  $('inv-all').checked=!!invState.visible.length&&rows.length===invState.visible.length;
  $('inv-all').indeterminate=rows.length>0&&rows.length<invState.visible.length;
  if(busy){
    $('inv-pane-new').querySelectorAll('input,select,button').forEach(function(el){
      if(!el.disabled){el.setAttribute('data-invoice-busy','');el.disabled=true;}
    });
  }
}
/**
 * ดึงใบที่บันทึกไว้แล้วจากเซิร์ฟเวอร์ เพื่อให้ Preview ใช้เลขและยอดที่บันทึกจริง
 * ไม่ใช่เลขที่รันใหม่จากช่อง "เลขเริ่มต้น" — ใช้ได้แม้รีโหลดหน้าไปแล้ว
 */
async function fetchIssuedDocuments(row){
  var numbers=['V','NV'].map(function(kind){return row.issued&&row.issued[kind];}).filter(Boolean);
  var loaded=[];
  for(var i=0;i<numbers.length;i++){
    var res=await api({action:'getInvoice',token:state.token,number:numbers[i]});
    if(!res.ok) throw new Error('ดึงใบที่บันทึกไว้ไม่สำเร็จ ('+numbers[i]+'): '+res.error);
    var inv=res.invoice;
    loaded.push({number:inv.number,kind:inv.kind,issueDate:inv.issueDate,bl:inv.bl,settlementId:inv.settlementId,
      items:inv.items,subtotal:Number(inv.subtotal),vat:Number(inv.vat),total:Number(inv.total),
      customerName:inv.customerName,customerAddress:inv.customerAddress,customerTaxId:inv.customerTaxId,preparedBy:inv.preparedBy});
  }
  return loaded;
}
async function invoicePairDocuments(rows){
  var customer=invState.cfg.customer,documents=[];
  for(var r=0;r<rows.length;r++){
    var row=rows[r];
    // ออกใบไปแล้ว — ใช้ค่าที่บันทึกไว้เสมอ (createdPair คือชุดที่เพิ่งบันทึกในรอบนี้)
    if(row.createdPair){documents.push.apply(documents,row.createdPair);continue;}
    if(row.issued&&(row.issued.V||row.issued.NV)){
      documents.push.apply(documents,await fetchIssuedDocuments(row));continue;
    }
    ['V','NV'].forEach(function(kind){
      var items=inlineInvoiceItems(row,kind),subtotal=Math.round(items.reduce(function(sum,item){return sum+item.amount;},0)*100)/100;
      // BL ที่ไม่มีค่าใช้จ่ายฝั่งนั้น (ส่วนใหญ่คือ NON VAT ที่ยังไม่มีค่าแลก DO)
      // ให้ข้ามใบนั้นไปเลย ออกเฉพาะฝั่งที่มียอดจริง ไม่ใช่บล็อกทั้ง BL
      if(!items.length) return;
      var vat=kind==='V'?Math.round(invVatBase(items)*7)/100:0;
      documents.push({number:row.numbers[kind],kind:kind,issueDate:$('inv-issue-date').value,bl:row.bl,settlementId:row.settlementId,items:items,
        subtotal:subtotal,vat:vat,total:Math.round((subtotal+vat)*100)/100,customerName:customer.name,customerAddress:customer.address,customerTaxId:customer.taxId,preparedBy:state.user.name});
    });
  }
  return documents;
}
function showInvoicePDF(popup,blob,filename,download){
  var url=URL.createObjectURL(blob);
  // Keep the URL alive while either the preview or the main page is open.
  invState.pdfUrls=invState.pdfUrls||[];invState.pdfUrls.push(url);
  if(popup&&!popup.closed){
    popup.document.body.innerHTML='';popup.document.title=filename;
    var link=popup.document.createElement('a');link.href=url;link.download=filename;link.textContent='ดาวน์โหลด PDF รวม V + NV';link.style.cssText='display:block;padding:12px;background:#edf2ff;font:14px Tahoma';popup.document.body.appendChild(link);
    var frame=popup.document.createElement('iframe');frame.src=url;frame.title='ใบแจ้งหนี้รวม VAT และ NON VAT';frame.style.cssText='width:100%;height:calc(100vh - 50px);border:0';popup.document.body.appendChild(frame);
  }
  var fallback=document.createElement('a');fallback.href=url;fallback.download=filename;fallback.textContent='ดาวน์โหลด PDF รวม V + NV';
  $('inv-inline-msg').appendChild(document.createElement('br'));$('inv-inline-msg').appendChild(fallback);
  if(download) fallback.click();
}
async function runInvoicePair(save,rows){
  if(invState.saving||!rows.length) return;
  if(!invState.cfg){$('inv-inline-msg').textContent='กำลังโหลดข้อมูลบริษัท โปรดลองอีกครั้ง';return;}
  assignInvoiceNumbers();
  if(rows.length>50){$('inv-inline-msg').textContent='เลือกได้สูงสุดครั้งละ 50 งาน';return;}
  if(!$('inv-issue-date').value){
    $('inv-inline-msg').textContent='กรอกวันที่ออกใบแจ้งหนี้';return;
  }
  if(save&&rows.some(invoiceRowIssued)){
    $('inv-inline-msg').textContent='BL ที่เลือกมีใบที่ออกไปแล้ว — ต้องให้ผู้ดูแลยกเลิกใบเดิมก่อนจึงจะออกใหม่ได้';return;
  }
  var docs;
  try{ docs=await invoicePairDocuments(rows); }
  catch(error){ $('inv-inline-msg').textContent='ไม่สำเร็จ: '+error.message; return; }
  var bad=docs.find(function(doc){return doc.items.some(function(item){return !item.label||item.label.length>200||!Number.isFinite(item.amount)||item.amount<0||item.amount>1e9;});});
  if(bad){$('inv-inline-msg').textContent=bad.bl+' — รายการ '+bad.kind+' ต้องมีชื่อและยอดที่ถูกต้อง';return;}
  // เลขที่แก้เองต้องอยู่ในรูปแบบเดียวกับที่เซิร์ฟเวอร์รับ (เช่น V20260901) ไม่งั้นบันทึกไม่ผ่าน
  // เช็คเฉพาะตอนบันทึก — Preview ของใบเก่าอาจเป็นคนละเดือนกับวันที่ออกใบที่ตั้งอยู่ตอนนี้
  var badNumber=save&&docs.find(function(doc){
    return !new RegExp('^'+doc.kind+invoicePeriod()+'[0-9]{2,6}$').test(String(doc.number||''));
  });
  if(badNumber){
    $('inv-inline-msg').textContent=badNumber.bl+' — เลขที่ใบ '+badNumber.kind+' ไม่ถูกต้อง ต้องเป็นรูปแบบ '+badNumber.kind+invoicePeriod()+'01';return;
  }
  // ใบคู่ V/NV ของ BL เดียวกันต้องใช้เลขลำดับเดียวกัน (กติกาเดิมฝั่งเซิร์ฟเวอร์)
  if(save){
    var seqOf=function(doc){ return String(doc.number).slice((doc.kind+invoicePeriod()).length); };
    var mismatch=rows.find(function(row){
      var pair=docs.filter(function(doc){return doc.settlementId===row.settlementId&&doc.bl===row.bl;});
      return pair.length===2 && Number(seqOf(pair[0]))!==Number(seqOf(pair[1]));
    });
    if(mismatch){
      $('inv-inline-msg').textContent=mismatch.bl+' — เลขใบ V และ NV ของ BL เดียวกันต้องเป็นลำดับเดียวกัน';return;
    }
  }
  // ทุก BL ต้องมีอย่างน้อยฝั่งใดฝั่งหนึ่ง ไม่งั้นไม่มีอะไรให้ออก
  var empty=rows.find(function(row){return !docs.some(function(doc){return doc.settlementId===row.settlementId&&doc.bl===row.bl;});});
  if(empty){$('inv-inline-msg').textContent=empty.bl+' — ต้องเลือกรายการอย่างน้อย 1 รายการ (VAT หรือ NON VAT)';return;}
  if(!docs.length){$('inv-inline-msg').textContent='ไม่มีรายการให้ออกใบ';return;}

  // เตือนตั้งแต่ก่อนยิง — เลขซ้ำกันเองในชุดที่กำลังจะออก
  // Preview ของใบที่บันทึกไว้แล้วไม่ต้องเช็ค เพราะเลขพวกนั้นถูกจองไว้อยู่แล้วโดยตั้งใจ
  var dupNumbers=!save?[]:docs.map(function(d){return d.number;})
    .filter(function(n,i,arr){return arr.indexOf(n)!==i;})
    .filter(function(n,i,arr){return arr.indexOf(n)===i;});
  if(dupNumbers.length){
    $('inv-inline-msg').textContent='เลขใบแจ้งหนี้ซ้ำกันเองในชุดนี้: '+dupNumbers.join(', ')+' — แก้เลขเริ่มต้นแล้วลองใหม่';
    return;
  }
  // เตือนเลขที่ออกไปแล้วในระบบ (ดูจากรายการที่โหลดมา)
  var used=[];
  (invState.sources||[]).forEach(function(r){
    ['V','NV'].forEach(function(k){ if(r.issued&&r.issued[k]) used.push(r.issued[k]); });
  });
  var clashNumbers=!save?[]:docs.filter(function(d){return used.indexOf(d.number)>=0;}).map(function(d){return d.number;});
  if(clashNumbers.length){
    $('inv-inline-msg').textContent='เลขนี้ถูกใช้ไปแล้ว: '+clashNumbers.join(', ')+' — แก้เลขเริ่มต้นแล้วลองใหม่';
    return;
  }
  // BL ที่เคยออกใบชนิดเดียวกันไปแล้ว — ห้ามออกซ้ำเด็ดขาด
  // ถ้าต้องใช้เลขเดิมหรือออกใหม่ ต้องให้ผู้ดูแลยกเลิกใบเดิมก่อน (ยกเลิก = ลบ คืนเลขให้ว่าง)
  if(save){
    var dupBl=[];
    rows.forEach(function(row){
      ['V','NV'].forEach(function(k){
        var has=docs.some(function(d){return d.settlementId===row.settlementId&&d.bl===row.bl&&d.kind===k;});
        if(has&&row.issued&&row.issued[k]) dupBl.push(row.bl+' ('+k+' = '+row.issued[k]+')');
      });
    });
    if(dupBl.length){
      $('inv-inline-msg').textContent='BL เหล่านี้ออกใบแจ้งหนี้ไปแล้ว: '+dupBl.join(', ')+' — ต้องให้ผู้ดูแลยกเลิกใบเดิมก่อนจึงจะออกใหม่ได้';
      return;
    }
  }
  // สร้างใบแจ้งหนี้ = บันทึกและจองเลขอย่างเดียว ไม่แตะ PDF
  // Preview เท่านั้นที่เปิดหน้าต่างและสร้างไฟล์
  var popup=null;
  if(!save){
    popup=window.open('','_blank','popup,width=1000,height=850');
    if(popup){popup.document.body.textContent='กำลังจัดเตรียม PDF…';popup.document.body.style.margin='0';}
  }
  invState.saving=true;updateInvoicePicked();
  $('inv-inline-msg').textContent=save?'กำลังบันทึกใบแจ้งหนี้ V และ NV…':'กำลังสร้าง Preview…';
  var saved=false;
  try{
    if(save){
      var res=await api({action:'saveInvoiceBatch',token:state.token,kind:'BOTH',issueDate:docs[0].issueDate,targets:rows.map(function(row){
        var pair=docs.filter(function(doc){return doc.settlementId===row.settlementId&&doc.bl===row.bl;});
        // ส่งเฉพาะฝั่งที่มีจริง — BL ที่ไม่มีค่า NON VAT จะมีแค่ใบ V
        var numbers={},items={};
        pair.forEach(function(doc){numbers[doc.kind]=doc.number;items[doc.kind]=doc.items;});
        return {settlementId:row.settlementId,bl:row.bl,numbers:numbers,items:items};
      })});
      if(!res.ok){
        if(res.error==='invoice_number_used') throw new Error('เลขใบแจ้งหนี้ซ้ำ: '+(res.numbers||[]).join(', ')+' — กด "โหลดใหม่" แล้วเปลี่ยนเลขเริ่มต้น');
        if(res.error==='bl_already_invoiced') throw new Error('BL นี้ออกใบไปแล้ว: '+(res.duplicates||[]).map(function(d){return d.bl+' ('+d.kind+' = '+d.number+')';}).join(', '));
        throw new Error(res.error);
      }
      saved=true;
      rows.forEach(function(row){row.createdPair=res.created.filter(function(doc){return doc.settlementId===row.settlementId&&doc.bl===row.bl;});row.issued=row.issued||{};row.createdPair.forEach(function(doc){row.issued[doc.kind]=doc.number;});});
      // ขยับเลขเริ่มต้นไปหลังลำดับสูงสุดที่เพิ่งออก — นับรวมทั้ง V และ NV เพราะใช้ชุดเดียวกัน
      var seqs=res.created.map(function(doc){return Number(doc.seq);}).filter(function(n){return n>0;});
      if(seqs.length){
        var max=Math.max.apply(null,seqs);
        $('inv-start').value='V'+invoicePeriod()+String(Math.max(max+1,invoiceStart()||1)).padStart(2,'0');
      }
      renderInvoiceSources();loadInvoiceList();
      $('inv-inline-msg').textContent='บันทึกใบแจ้งหนี้แล้ว '+res.created.length+' ใบ — เลขที่ '+res.created.map(function(doc){return doc.number;}).join(', ')+' (กด Preview เพื่อดูไฟล์)';
      return;
    }
    var blob=await InvoicePDF.create(docs,invState.cfg.company);
    $('inv-inline-msg').textContent='Preview '+docs.length+' ใบ'+(rows.every(function(row){return !!row.createdPair;})?' — เลขที่บันทึกไว้แล้ว':' — ยังไม่ได้บันทึก');
    showInvoicePDF(popup,blob,'Preview-'+docs[0].number+'-'+docs[docs.length-1].number+'.pdf',false);
  }catch(error){
    var message=(saved?'บันทึกแล้ว แต่ปรับหน้าจอไม่สำเร็จ กด "โหลดใหม่" อีกครั้ง: ':'ไม่สำเร็จ: ')+error.message;
    $('inv-inline-msg').textContent=message;if(popup&&!popup.closed)popup.document.body.textContent=message;
    if(saved){renderInvoiceSources();loadInvoiceList();}
  }finally{invState.saving=false;updateInvoicePicked();}
}
