// No production database is used. Verify atomic writes and validation at the API boundary.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync('src/lib/invoice-pairs.ts', 'utf8');
let committed = [], conflict = false, failSecond = false;
const chain = result => ({ from(){return this;}, where:async()=>result });
const db = {
  select:()=>chain([{id:'settle-1',rowsJson:'[{"bl":"BL-1"}]'}]),
  transaction:async fn=>{
    const pending=[];
    const result=await fn({execute:async()=>{},select:()=>chain(conflict?[{number:'V20260910'}]:[]),
      insert:()=>({values:async row=>{ if(failSecond&&pending.length)throw Object.assign(new Error('duplicate'),{code:'23505'});pending.push(row); }})});
    committed.push(...pending);return result;
  }
};
const exportsObject={};
const sql=()=>{};
const modules={
  'drizzle-orm':{inArray:()=>{},sql},'@/db':{db},'@/db/schema':{invoices:{number:'number'},settlements:{id:'id'}},
  './constants':{INVOICE_CUSTOMER:{name:'Customer',address:'Address',taxId:'123'}},
  './utils':{nowIso:()=>'',validYmd:value=>/^\d{4}-\d{2}-\d{2}$/.test(value)},
  './invoices':{invoiceTotals:(items,kind)=>{const subtotal=items.reduce((s,i)=>s+i.amount,0),vat=kind==='V'?Math.round(subtotal*7)/100:0;return {subtotal,vat,total:subtotal+vat,withholding:0,netTotal:subtotal+vat};}}
};
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
  {exports:exportsObject,require:name=>{assert(name in modules,name);return modules[name];}});
const make=()=>({issueDate:'2026-09-08',targets:[{settlementId:'settle-1',bl:'BL-1',numbers:{V:'V20260910',NV:'NV20260920'},items:{V:[{label:'Lift',amount:1000}],NV:[{label:'DO',amount:200},{label:'Custom',amount:50}]}}]});
(async()=>{
  const actor={username:'tester',name:'Tester'};
  let result=await exportsObject.saveInvoicePairs(make(),actor);
  assert.equal(result.ok,true);assert.equal(committed.length,2);
  assert.equal(committed[0].number,'V20260910');assert.equal(committed[1].number,'NV20260920');
  assert.equal(committed[0].total,1070);assert.equal(committed[1].total,250);
  committed=[];conflict=true;result=await exportsObject.saveInvoicePairs(make(),actor);
  assert.equal(result.error,'invoice_number_used');assert.equal(committed.length,0);
  conflict=false;failSecond=true;result=await exportsObject.saveInvoicePairs(make(),actor);
  assert.equal(result.error,'invoice_number_used');assert.equal(committed.length,0);
  failSecond=false;
  let bad=make();bad.targets[0].items.NV=[];result=await exportsObject.saveInvoicePairs(bad,actor);
  assert.equal(result.error,'no_items');assert.equal(committed.length,0);
  bad=make();bad.targets[0].numbers.V='V20260810';result=await exportsObject.saveInvoicePairs(bad,actor);
  assert.equal(result.error,'bad_invoice_number');assert.equal(committed.length,0);
  bad=make();bad.targets[0].items.V[0].amount=-1;result=await exportsObject.saveInvoicePairs(bad,actor);
  assert.equal(result.error,'bad_item');assert.equal(committed.length,0);
  console.log('PASS: pair creation, custom lines, exact V/NV numbers, VAT, conflicts, rollback, empty groups, period, negative amounts');
})().catch(error=>{console.error(error);process.exitCode=1;});
