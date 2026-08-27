import postgres from 'postgres';

process.loadEnvFile?.('.env.local');

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

const tables = await sql<{ table_name: string; n: number }[]>`
  select c.relname as table_name, coalesce(s.n_live_tup, 0)::int as n
  from pg_class c
  join pg_namespace ns on ns.oid = c.relnamespace
  left join pg_stat_user_tables s on s.relid = c.oid
  where ns.nspname = 'public' and c.relkind = 'r'
  order by c.relname
`;
console.log(`ตารางใน public: ${tables.length}`);
for (const row of tables) console.log(`  ${row.table_name.padEnd(20)} ${row.n} แถว`);

const [{ citext }] = await sql<{ citext: boolean }[]>`
  select exists(select 1 from pg_extension where extname = 'citext') as citext
`;
console.log(`\ncitext extension: ${citext ? 'เปิดแล้ว ✓' : 'ยังไม่ได้เปิด ✗'}`);

console.log('\nindex ทั้งหมด:');
const idx = await sql<{ tablename: string; indexname: string; indexdef: string }[]>`
  select tablename, indexname, indexdef from pg_indexes
  where schemaname = 'public' order by tablename, indexname
`;
for (const row of idx) {
  const kind = row.indexdef.includes('UNIQUE') ? 'UNIQUE' : '      ';
  const where = /WHERE (.+)$/.exec(row.indexdef)?.[1] ?? '';
  console.log(`  [${row.tablename}] ${kind} ${row.indexname}${where ? `  WHERE ${where}` : ''}`);
}

await sql.end();
