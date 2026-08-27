import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import postgres from 'postgres';

/**
 * ย้ายข้อมูลจาก data/checkin.sqlite (ระบบ Fastify เดิม) เข้า Supabase Postgres
 *
 *   npx tsx scripts/import-sqlite.mts [path/to/checkin.sqlite]
 *
 * - ข้าม sessions โดยตั้งใจ ทุกคนต้องล็อกอินใหม่หลังย้าย
 * - hash รหัสผ่านเป็น scrypt รูปแบบเดียวกัน ย้ายมาใช้ต่อได้เลย ไม่ต้องตั้งรหัสใหม่
 * - รันซ้ำได้ ถ้ามีแถวนั้นอยู่แล้วจะข้าม (ON CONFLICT DO NOTHING)
 * - รูปเก่ายังเป็นลิงก์ Google Drive ตามข้อมูลเดิม ไม่ได้ย้ายไฟล์
 */

process.loadEnvFile?.('.env.local');

const sqlitePath = process.argv[2] || path.resolve('..', 'data', 'checkin.sqlite');
const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

const bool = (value: unknown) => Boolean(Number(value));
const CHUNK = 200;

type Table = {
  name: string;
  columns: string[];
  conflict: string;                       // คอลัมน์ที่ใช้ตัดสินว่าซ้ำ
  map?: (row: any) => any;
};

// เรียงตามลำดับ foreign key: users ต้องมาก่อนทุกตารางที่อ้างถึง username
const TABLES: Table[] = [
  {
    name: 'users',
    columns: ['username', 'password_hash', 'name', 'role', 'active', 'shipping_code', 'created_at', 'updated_at'],
    conflict: 'username',
    map: (row) => ({ ...row, active: bool(row.active) })
  },
  {
    name: 'app_options',
    columns: ['key', 'value_json', 'updated_at'],
    conflict: 'key'
  },
  {
    name: 'claim_rates',
    columns: ['key', 'rate', 'reasons_json', 'updated_at'],
    conflict: 'key'
  },
  {
    name: 'settle_rates',
    columns: ['key', 'rate', 'updated_at'],
    conflict: 'key'
  },
  {
    name: 'checkins',
    columns: ['id', 'server_time', 'local_date', 'device_time', 'username', 'name', 'type',
      'latitude', 'longitude', 'accuracy_m', 'address', 'map_link', 'photo_url', 'photo_id'],
    conflict: 'id'
  },
  {
    name: 'leaves',
    columns: ['id', 'created_at', 'username', 'name', 'leave_type', 'start_date', 'end_date',
      'days', 'reason', 'status', 'decided_by', 'decided_at', 'note'],
    conflict: 'id'
  },
  {
    name: 'claims',
    columns: ['id', 'created_at', 'updated_at', 'username', 'name', 'inspect_date', 'containers',
      'total', 'edit_count', 'items_json', 'detail', 'detail_all', 'detail_first', 'edit_details_json'],
    conflict: 'id'
  },
  {
    name: 'receipts',
    columns: ['id', 'server_time', 'device_time', 'username', 'name', 'note', 'latitude', 'longitude',
      'accuracy_m', 'address', 'map_link', 'photo_url', 'photo_id', 'inspect_date', 'retake_count'],
    conflict: 'id'
  },
  {
    name: 'slips',
    columns: ['id', 'username', 'uploaded_at', 'file_name', 'url', 'info_json'],
    conflict: 'id'
  },
  {
    name: 'settlements',
    columns: ['id', 'created_at', 'updated_at', 'username', 'name', 'inspect_date', 'claim_total',
      'total_expense', 'balance', 'edit_count', 'returned_date', 'company_returned_date', 'rows_json',
      'detail', 'image_url', 'slip_url', 'slip_txn', 'slip_amount', 'slip_date', 'slip_status',
      'slip_bank', 'legacy_duplicate'],
    conflict: 'id',
    map: (row) => ({ ...row, legacy_duplicate: bool(row.legacy_duplicate) })
  },
  {
    // id เป็น identity ฝั่ง Postgres จึงไม่ย้าย id เดิมมา (ไม่มีตารางไหนอ้างถึง)
    name: 'transport_jobs',
    columns: ['transport_date', 'shipping', 'bl', 'container_no', 'quantity', 'port', 'customer',
      'source_file', 'source_sheet', 'source_name', 'imported_at'],
    conflict: ''
  },
  {
    name: 'geocode_cache',
    columns: ['point', 'address', 'updated_at'],
    conflict: 'point'
  }
];

let grandTotal = 0;
for (const table of TABLES) {
  const rows = sqlite.prepare(`SELECT ${table.columns.map((c) => `"${c}"`).join(',')} FROM "${table.name}"`).all();
  if (!rows.length) {
    console.log(`${table.name.padEnd(16)} ไม่มีข้อมูล`);
    continue;
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((row) => table.map ? table.map(row) : row);
    const result = table.conflict
      ? await sql`insert into ${sql(table.name)} ${sql(chunk as any, table.columns)}
                  on conflict (${sql(table.conflict)}) do nothing`
      : await sql`insert into ${sql(table.name)} ${sql(chunk as any, table.columns)}`;
    inserted += result.count;
  }

  grandTotal += inserted;
  const skipped = rows.length - inserted;
  console.log(`${table.name.padEnd(16)} ${String(inserted).padStart(5)} แถว${skipped ? `  (ข้ามซ้ำ ${skipped})` : ''}`);
}

console.log(`\nรวม ${grandTotal} แถว`);
console.log('ข้าม sessions โดยตั้งใจ — ทุกคนต้องล็อกอินใหม่');

sqlite.close();
await sql.end();
