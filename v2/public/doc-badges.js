/**
 * ป้ายความพร้อมเอกสารต่อ BL — DO · ใบขน · E-Office (แพลนงานของผู้จัดการ + งานปล่อยของชิปปิ้ง)
 * ข้อมูลจาก res.docs ของ planLoad / myReleaseJobs (src/lib/doc-status.ts) คีย์ = BL ตัวใหญ่เหลือแค่ A-Z0-9
 * DO ถาม ERP-KOLA สด: ? = ถาม KOLA ไม่ได้ (ไม่เดาว่าพร้อมหรือไม่) · ใบขน / E-Office = ไฟล์ที่ KOLA ส่งมา กดเปิดได้
 */
function docBadgeKey(bl){ return String(bl==null?'':bl).toUpperCase().replace(/[^A-Z0-9]/g,''); }
function docBadges(docs, bl){
  var d = docs && docs[docBadgeKey(bl)];
  if(!d) return '';
  var e = function(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
  var css = 'display:inline-block;font-size:11px;line-height:1.5;padding:0 6px;border-radius:999px;margin:2px 4px 0 0;white-space:nowrap;text-decoration:none;';
  var ok = css+'background:#dcfce7;color:#166534;', no = css+'background:#fee2e2;color:#b91c1c;', gray = css+'background:#e5e7eb;color:#4b5563;';
  var DO = { yes:['✓ DO', ok, 'ANN ส่งแลก DO แล้ว (ERP-KOLA)'], no:['✗ DO', no, 'ยังไม่ได้ส่งแลก DO (ERP-KOLA)'],
             notfound:['DO ไม่พบใน KOLA', gray, 'ไม่มี BL นี้ใน ERP-KOLA'], unknown:['? DO', gray, 'ตรวจกับ ERP-KOLA ไม่ได้ตอนนี้'] }[d.do] || ['? DO', gray, ''];
  var file = function(f, label){
    if(!f) return '<span style="'+no+'" title="ยังไม่มีไฟล์">✗ '+label+'</span>';
    return f.url ? '<a style="'+ok+'" href="'+e(f.url)+'" target="_blank" rel="noopener" title="'+e(f.fileName)+'">✓ '+label+'</a>'
                 : '<span style="'+ok+'" title="'+e(f.fileName)+'">✓ '+label+'</span>';
  };
  return '<div class="doc-badges"><span style="'+DO[1]+'" title="'+e(DO[2])+'">'+DO[0]+'</span>'+file(d.decl,'ใบขน')+file(d.eoffice,'E-Office')+'</div>';
}
