import fs from 'node:fs';
import path from 'node:path';
import { db, transaction } from '../src/db.js';
import { nowIso } from '../src/utils.js';
import { pick, readObjects, toYmd } from './csv.mjs';

const input = process.argv[2];
if (!input) {
  console.error('Usage: npm run import:transport -- <transport.csv | directory>');
  process.exit(1);
}

const target = path.resolve(input);
const files = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).filter((name) => name.toLowerCase().endsWith('.csv')).map((name) => path.join(target, name))
  : [target];

const aliases = {
  shipping: ['ชิปปิ้ง', 'ชิบปิ้ง', 'ชื่อชิปปิ้ง', 'shipping', 'shippingname', 'พนักงานชิปปิ้ง'],
  date: ['transport', 'วันที่transport', 'วันtransport', 'transportdate', 'วันที่ตรวจปล่อย', 'วันตรวจปล่อย'],
  bl: ['เลขbl', 'bl', 'blno', 'blnumber', 'เลขที่bl', 'hbl', 'mbl', 'housebl'],
  container: ['containerno', 'เบอร์ตู้', 'หมายเลขตู้', 'เลขตู้', 'container', 'containernumber', 'cntrno', 'ตู้'],
  quantity: ['จำนวนตู้', 'จำนวน', 'จน.ตู้', 'qty', 'quantity'],
  port: ['ท่า', 'ท่าเรือ', 'ท่าส่งออก', 'port', 'terminal'],
  customer: ['ชื่อลูกค้า', 'ลูกค้า', 'ชิปเปอร์', 'ชิพเปอร์', 'shipper', 'customer', 'customername', 'consignee']
};

const insert = db.prepare(`INSERT INTO transport_jobs
  (transport_date,shipping,bl,container_no,quantity,port,customer,source_file,source_sheet,source_name,imported_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
let total = 0;

for (const file of files) {
  const sourceFile = path.basename(file);
  const sourceUpper = sourceFile.toUpperCase();
  const sourceName = sourceUpper.includes('TRANSIT') ? 'TRANSIT' : (sourceUpper.includes('MAESOT') || sourceUpper.includes('FREEZONE') ? 'MAESOT FREEZONE' : '');
  const rows = readObjects(file);
  let context = null;
  let imported = 0;
  transaction(() => {
    db.prepare('DELETE FROM transport_jobs WHERE source_file = ?').run(sourceFile);
    for (const row of rows) {
      let bl = String(pick(row, aliases.bl)).trim();
      let shipping = String(pick(row, aliases.shipping)).trim();
      let date = toYmd(pick(row, aliases.date));
      let port = String(pick(row, aliases.port)).trim();
      let customer = String(pick(row, aliases.customer)).trim();
      if (bl) context = { bl, shipping, date, port, customer };
      else if (context) {
        bl = context.bl;
        shipping ||= context.shipping;
        date ||= context.date;
        port ||= context.port;
        customer ||= context.customer;
      }
      if (!date || (!bl && !shipping)) continue;
      const container = String(pick(row, aliases.container)).trim();
      const quantity = Number(String(pick(row, aliases.quantity)).replace(/,/g, '')) || 0;
      insert.run(date, shipping, bl, container, quantity, port, customer, sourceFile, path.parse(sourceFile).name, sourceName, nowIso());
      imported++;
    }
  });
  console.log(`${sourceFile}: ${imported} rows`);
  total += imported;
}

console.log(`Imported ${total} transport rows into ${files.length} source(s).`);
db.close();
