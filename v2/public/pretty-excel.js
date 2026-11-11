/**
 * Excel รายงานแบบจัดรูปแบบ (หัวรายงาน หัวตารางสี เส้นตาราง สลับสีแถว แถวรวม ตรึงหัวตาราง ตั้งหน้า A4)
 * ใช้ ExcelJS — โหลดจาก cdnjs ตอนกด Export ครั้งแรกเท่านั้น (SheetJS ที่หน้า admin โหลดไว้ใส่สีไม่ได้)
 *
 * PrettyExcel.download({
 *   fileName, company,
 *   sheets: [{ name, title, subtitle: [บรรทัด…], columns: [{ header, key, width, type: text|money|int|date|center }],
 *              rows: [{key: value}], totals: {key: value} | null, totalLabel, totalLabelKey }]
 * })
 * date = 'yyyy-MM-dd' (เขียนเป็นวันที่จริงของ Excel แสดง dd/mm/yyyy)
 */
(function(global){
  'use strict';
  var SRC = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
  var NAVY = 'FF1F3A5F', ZEBRA = 'FFF4F7FB', LINE = 'FFD5DCE6', TOTAL = 'FFE3EAF4', MUTED = 'FF5B6B7F';
  var FONT = 'Tahoma';
  var loading = null;

  function load(){
    if(global.ExcelJS) return Promise.resolve(global.ExcelJS);
    if(loading) return loading;
    loading = new Promise(function(resolve, reject){
      var s = document.createElement('script');
      s.src = SRC; s.async = true;
      s.onload = function(){ global.ExcelJS ? resolve(global.ExcelJS) : reject(new Error('โหลดตัวสร้าง Excel ไม่สำเร็จ')); };
      s.onerror = function(){ loading = null; reject(new Error('โหลดตัวสร้าง Excel ไม่ได้ (ต้องใช้อินเทอร์เน็ต)')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function toDate(ymd){
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    return m ? new Date(Date.UTC(+m[1], +m[2]-1, +m[3])) : (ymd || '');
  }
  function thin(color){ return { style:'thin', color:{ argb: color || LINE } }; }

  function addSheet(wb, def, company){
    var cols = def.columns, n = cols.length;
    var ws = wb.addWorksheet(String(def.name || 'Sheet').slice(0, 31), {
      views: [{ state:'frozen', ySplit: 0 }],
      pageSetup: { paperSize: 9, orientation: def.portrait ? 'portrait' : 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        margins: { left:0.4, right:0.4, top:0.5, bottom:0.5, header:0.3, footer:0.3 } },
      headerFooter: { oddFooter: '&L&8' + (def.title || '') + '&R&8หน้า &P / &N' }
    });
    ws.columns = cols.map(function(c){ return { key: c.key, width: c.width || 14 }; });

    var r = 1;
    // หัวรายงาน
    ws.mergeCells(r, 1, r, n);
    var t = ws.getCell(r, 1);
    t.value = def.title || '';
    t.font = { name: FONT, size: 15, bold: true, color: { argb: NAVY } };
    t.alignment = { vertical:'middle' };
    ws.getRow(r).height = 26;
    r++;
    [company].concat(def.subtitle || []).filter(Boolean).forEach(function(line){
      ws.mergeCells(r, 1, r, n);
      var c = ws.getCell(r, 1);
      c.value = line;
      c.font = { name: FONT, size: 10, color: { argb: MUTED } };
      r++;
    });
    r++; // เว้น 1 บรรทัด

    // หัวตาราง
    var headRow = ws.getRow(r);
    cols.forEach(function(c, i){
      var cell = headRow.getCell(i + 1);
      cell.value = c.header;
      cell.font = { name: FONT, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: NAVY } };
      cell.alignment = { vertical:'middle', horizontal: c.type === 'money' || c.type === 'int' ? 'right' : 'center', wrapText: true };
      cell.border = { top: thin(NAVY), bottom: thin(NAVY), left: thin(NAVY), right: thin(NAVY) };
    });
    headRow.height = 30;
    var headIndex = r;
    ws.views = [{ state:'frozen', ySplit: headIndex }];
    r++;

    // ข้อมูล
    (def.rows || []).forEach(function(row, k){
      var xr = ws.getRow(r);
      cols.forEach(function(c, i){
        var cell = xr.getCell(i + 1), v = row[c.key];
        if(c.type === 'date') { cell.value = toDate(v); cell.numFmt = 'dd/mm/yyyy'; }
        else if(c.type === 'money') { cell.value = v === '' || v == null ? null : Number(v) || 0; cell.numFmt = '#,##0.00'; }
        else if(c.type === 'int') { cell.value = v === '' || v == null ? null : Number(v) || 0; cell.numFmt = '#,##0'; }
        else cell.value = v == null ? '' : String(v);
        cell.font = { name: FONT, size: 10 };
        cell.alignment = { vertical:'top', wrapText: c.type === 'text' || !c.type,
          horizontal: c.type === 'money' || c.type === 'int' ? 'right' : (c.type === 'date' || c.type === 'center' ? 'center' : 'left') };
        cell.border = { top: thin(), bottom: thin(), left: thin(), right: thin() };
        if(k % 2 === 1) cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: ZEBRA } };
      });
      r++;
    });
    if(!(def.rows || []).length){
      ws.mergeCells(r, 1, r, n);
      var e = ws.getCell(r, 1);
      e.value = 'ไม่มีรายการ'; e.font = { name: FONT, size: 10, italic: true, color: { argb: MUTED } };
      e.alignment = { horizontal:'center' };
      r++;
    }

    // แถวรวม
    if(def.totals){
      var tr = ws.getRow(r);
      var labelKey = def.totalLabelKey || cols[0].key;
      cols.forEach(function(c, i){
        var cell = tr.getCell(i + 1);
        if(c.key === labelKey) cell.value = def.totalLabel || 'รวม';
        else if(def.totals[c.key] != null){
          cell.value = Number(def.totals[c.key]) || 0;
          cell.numFmt = c.type === 'int' ? '#,##0' : '#,##0.00';
        }
        cell.font = { name: FONT, size: 10, bold: true, color: { argb: NAVY } };
        cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: TOTAL } };
        cell.alignment = { vertical:'middle', horizontal: c.type === 'money' || c.type === 'int' ? 'right' : 'left' };
        cell.border = { top: { style:'medium', color:{ argb: NAVY } }, bottom: { style:'double', color:{ argb: NAVY } }, left: thin(), right: thin() };
      });
      tr.height = 20;
      r++;
    }
    if((def.rows || []).length) ws.autoFilter = { from: { row: headIndex, column: 1 }, to: { row: headIndex, column: n } };
    ws.pageSetup.printTitlesRow = headIndex + ':' + headIndex;
    return ws;
  }

  function download(opts){
    return load().then(function(ExcelJS){
      var wb = new ExcelJS.Workbook();
      wb.creator = 'ERP SHIPME';
      wb.created = new Date();
      (opts.sheets || []).forEach(function(def){ addSheet(wb, def, opts.company || ''); });
      return wb.xlsx.writeBuffer();
    }).then(function(buf){
      var blob = new Blob([buf], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = opts.fileName || 'report.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
    });
  }

  global.PrettyExcel = { download: download, load: load };
})(window);
