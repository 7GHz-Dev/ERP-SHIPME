function invoicePeriod(){ return $('inv-issue-date').value.slice(0,7).replace('-',''); }
function invoiceStart(kind){
  var value = $(kind==='V'?'inv-start-v':'inv-start-nv').value.trim().toUpperCase();
  var prefix=kind+invoicePeriod();
  if(value.indexOf(prefix)===0) value=value.slice(prefix.length);
  else if(value.indexOf(invoicePeriod())===0 && value.length>6) value=value.slice(6);
  if(!/^[0-9]{1,6}$/.test(value) || Number(value)<1) return null;
  return Number(value);
}
function fillInvoiceStarts(){
  ['V','NV'].forEach(function(kind){
    var el=$(kind==='V'?'inv-start-v':'inv-start-nv');
    if(!el.value) el.value=(invState.cfg && invState.cfg.period===invoicePeriod() && invState.cfg.next[kind]) || kind+invoicePeriod()+'01';
  });
}
function assignInvoiceNumbers(){
  ['V','NV'].forEach(function(kind){
    var seq=invoiceStart(kind);
    (invState.visible||[]).forEach(function(row,i){
      row.numbers=row.numbers||{};
      if(row.createdPair){ row.numbers[kind]=row.createdPair.find(function(doc){return doc.kind===kind;}).number; }
      else { row.numbers[kind]=seq===null || seq>999999?'':kind+invoicePeriod()+String(seq++).padStart(2,'0'); }
      var el=$('inv-number-'+i+'-'+kind); if(el) el.textContent=row.numbers[kind]||'กรอกเลขเริ่มต้นให้ถูกต้อง';
    });
  });
}
function initInvoiceWorkspace(){
  if(invState.workspaceReady) return; invState.workspaceReady=true;
  // Build the local date explicitly to avoid UTC date changes around midnight.
  var d=new Date(); $('inv-issue-date').value=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  ['inv-start-v','inv-start-nv'].forEach(function(id){ $(id).addEventListener('input',assignInvoiceNumbers); });
  $('inv-issue-date').addEventListener('change',function(){
    $('inv-start-v').value=''; $('inv-start-nv').value=''; fillInvoiceStarts(); assignInvoiceNumbers();
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
function renderInlineInvoiceItems(row,index,kind){
  var locked=row.createdPair?' disabled':'';
  return '<b class="inv-row-number" id="inv-number-'+index+'-'+kind+'"></b><div class="inv-cost-list">'+((row.invoiceItems||{})[kind]||[]).map(function(item,i){
    var attrs=' data-row="'+index+'" data-kind="'+kind+'" data-item="'+i+'"'+locked;
    var id='inv-cost-'+index+'-'+kind+'-'+i;
    return '<div class="inv-cost-row"><input id="'+id+'" type="checkbox" class="inv-cost"'+attrs+(item.selected?' checked':'')+' aria-label="เลือก '+esc(item.label)+'">'
      +(item.custom?'<input type="text" class="inv-cost"'+attrs+' value="'+esc(item.label)+'" placeholder="ชื่อรายการ" aria-label="ชื่อรายการ '+kind+'">':'<label for="'+id+'">'+esc(item.label)+'</label>')
      +'<input type="number" min="0" max="1000000000" step="0.01" class="inv-cost"'+attrs+' value="'+item.amount+'" aria-label="'+esc(item.label)+' ยอดก่อน VAT"></div>';
  }).join('')+'</div><button class="btn btn-ghost btn-sm inv-add-inline" data-row="'+index+'" data-kind="'+kind+'"'+locked+' style="margin-top:10px">+ เพิ่มรายการ '+(kind==='V'?'VAT':'NON VAT')+'</button><div class="inv-cost-total" id="inv-total-'+index+'-'+kind+'"></div>';
}
function updateInlineInvoiceTotal(row,index,kind){
  var subtotal=Math.round(inlineInvoiceItems(row,kind).reduce(function(sum,item){return sum+(Number.isFinite(item.amount)?item.amount:0);},0)*100)/100;
  var vat=kind==='V'?Math.round(subtotal*7)/100:0;
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
      +'<td><div class="inv-row-actions"><button class="btn btn-ghost btn-sm inv-row-preview" data-row="'+i+'">Preview</button><button class="btn btn-primary btn-sm inv-row-create" data-row="'+i+'"'+(row.createdPair?' disabled':'')+'>สร้างใบแจ้งหนี้</button></div></td></tr>';
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
  $('inv-create-picked').disabled=busy||!rows.length||rows.some(function(row){return !!row.createdPair;});
  $('inv-all').checked=!!invState.visible.length&&rows.length===invState.visible.length;
  $('inv-all').indeterminate=rows.length>0&&rows.length<invState.visible.length;
  if(busy){
    $('inv-pane-new').querySelectorAll('input,select,button').forEach(function(el){
      if(!el.disabled){el.setAttribute('data-invoice-busy','');el.disabled=true;}
    });
  }
}
function invoicePairDocuments(rows){
  var customer=invState.cfg.customer,documents=[];
  rows.forEach(function(row){
    if(row.createdPair){documents.push.apply(documents,row.createdPair);return;}
    ['V','NV'].forEach(function(kind){
      var items=inlineInvoiceItems(row,kind),subtotal=Math.round(items.reduce(function(sum,item){return sum+item.amount;},0)*100)/100;
      // BL ที่ไม่มีค่าใช้จ่ายฝั่งนั้น (ส่วนใหญ่คือ NON VAT ที่ยังไม่มีค่าแลก DO)
      // ให้ข้ามใบนั้นไปเลย ออกเฉพาะฝั่งที่มียอดจริง ไม่ใช่บล็อกทั้ง BL
      if(!items.length) return;
      var vat=kind==='V'?Math.round(subtotal*7)/100:0;
      documents.push({number:row.numbers[kind],kind:kind,issueDate:$('inv-issue-date').value,bl:row.bl,settlementId:row.settlementId,items:items,
        subtotal:subtotal,vat:vat,total:Math.round((subtotal+vat)*100)/100,customerName:customer.name,customerAddress:customer.address,customerTaxId:customer.taxId,preparedBy:state.user.name});
    });
  });
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
  if(!$('inv-issue-date').value || rows.some(function(row){return !row.numbers.V||!row.numbers.NV;})){
    $('inv-inline-msg').textContent='กรอกวันที่ออกใบและเลขเริ่มต้น V / NV ให้ถูกต้อง';return;
  }
  if(save&&rows.some(function(row){return !!row.createdPair;}))return;
  var docs=invoicePairDocuments(rows);
  var bad=docs.find(function(doc){return doc.items.some(function(item){return !item.label||item.label.length>200||!Number.isFinite(item.amount)||item.amount<0||item.amount>1e9;});});
  if(bad){$('inv-inline-msg').textContent=bad.bl+' — รายการ '+bad.kind+' ต้องมีชื่อและยอดที่ถูกต้อง';return;}
  // ทุก BL ต้องมีอย่างน้อยฝั่งใดฝั่งหนึ่ง ไม่งั้นไม่มีอะไรให้ออก
  var empty=rows.find(function(row){return !docs.some(function(doc){return doc.settlementId===row.settlementId&&doc.bl===row.bl;});});
  if(empty){$('inv-inline-msg').textContent=empty.bl+' — ต้องเลือกรายการอย่างน้อย 1 รายการ (VAT หรือ NON VAT)';return;}
  if(!docs.length){$('inv-inline-msg').textContent='ไม่มีรายการให้ออกใบ';return;}

  // เตือนตั้งแต่ก่อนยิง — เลขซ้ำกันเองในชุดที่กำลังจะออก
  var dupNumbers=docs.map(function(d){return d.number;})
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
  var clashNumbers=docs.filter(function(d){return used.indexOf(d.number)>=0;}).map(function(d){return d.number;});
  if(clashNumbers.length){
    $('inv-inline-msg').textContent='เลขนี้ถูกใช้ไปแล้ว: '+clashNumbers.join(', ')+' — แก้เลขเริ่มต้นแล้วลองใหม่';
    return;
  }
  // BL ที่เคยออกใบชนิดเดียวกันไปแล้ว — ถามยืนยันก่อน ไม่ได้ห้ามเด็ดขาด
  if(save){
    var dupBl=[];
    rows.forEach(function(row){
      ['V','NV'].forEach(function(k){
        var has=docs.some(function(d){return d.settlementId===row.settlementId&&d.bl===row.bl&&d.kind===k;});
        if(has&&row.issued&&row.issued[k]) dupBl.push(row.bl+' ('+k+' = '+row.issued[k]+')');
      });
    });
    if(dupBl.length&&!confirm('BL เหล่านี้เคยออกใบแจ้งหนี้ไปแล้ว:\n\n'+dupBl.join('\n')+'\n\nต้องการออกใบใหม่เพิ่มอีกใบหรือไม่?')) {
      $('inv-inline-msg').textContent='ยกเลิกการออกใบ';
      return;
    }
    if(dupBl.length) invState.allowDuplicateBl=true;
  }
  var popup=window.open('','_blank','popup,width=1000,height=850');
  if(popup){popup.document.body.textContent='กำลังจัดเตรียม PDF…';popup.document.body.style.margin='0';}
  invState.saving=true;updateInvoicePicked();
  $('inv-inline-msg').textContent=save?'กำลังสร้างใบแจ้งหนี้ V และ NV…':'กำลังสร้าง Preview…';
  var saved=false;
  try{
    // Generate first: failure to load fonts/images never leaves half a saved operation.
    var blob=await InvoicePDF.create(docs,invState.cfg.company);
    if(save){
      var res=await api({action:'saveInvoiceBatch',token:state.token,kind:'BOTH',issueDate:docs[0].issueDate,allowDuplicateBl:!!invState.allowDuplicateBl,targets:rows.map(function(row){
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
      // Use the persisted, normalized values in the final PDF.
      blob=await InvoicePDF.create(res.created,invState.cfg.company);
      ['V','NV'].forEach(function(kind){
        var seqs=res.created.filter(function(doc){return doc.kind===kind;}).map(function(doc){return doc.seq;});
        // ไม่ได้ออกชนิดนี้เลยก็ไม่ต้องขยับเลขเริ่มต้น (Math.max ของ array ว่างได้ -Infinity)
        if(!seqs.length) return;
        var max=Math.max.apply(null,seqs);
        var input=$(kind==='V'?'inv-start-v':'inv-start-nv');input.value=kind+invoicePeriod()+String(Math.max(max+1,invoiceStart(kind)||1)).padStart(2,'0');
      });
      renderInvoiceSources();loadInvoiceList();
    }
    $('inv-inline-msg').textContent=save?'สร้างใบแจ้งหนี้แล้ว '+docs.length+' ใบ รวมใน PDF เดียว':'Preview '+docs.length+' ใบ — ยังไม่ได้บันทึก';
    showInvoicePDF(popup,blob,(save?'Invoices-':'Preview-')+docs[0].number+'-'+docs[docs.length-1].number+'.pdf',save);
  }catch(error){
    var message=(saved?'บันทึกแล้ว แต่แสดง PDF ไม่สำเร็จ กด Preview เพื่อดาวน์โหลดอีกครั้ง: ':'ไม่สำเร็จ: ')+error.message;
    $('inv-inline-msg').textContent=message;if(popup&&!popup.closed)popup.document.body.textContent=message;
    if(saved){renderInvoiceSources();loadInvoiceList();}
  }finally{invState.saving=false;invState.allowDuplicateBl=false;updateInvoicePicked();}
}
