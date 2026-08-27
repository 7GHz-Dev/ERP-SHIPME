/**
 * สร้าง/ลบบัญชีชั่วคราวสำหรับ smoke test — ไม่ต้องใช้รหัสผ่านของพนักงานจริง
 *   npx tsx scripts/temp-user.mts create <username> <password> [role]
 *   npx tsx scripts/temp-user.mts drop   <username>
 */
import crypto from 'node:crypto';
import postgres from 'postgres';

process.loadEnvFile?.('.env.local');

const [mode, username, password, role = 'admin'] = process.argv.slice(2);
if (!mode || !username) {
  console.error('ใช้: temp-user.mts create|drop <username> [password] [role]');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

// รูปแบบเดียวกับ src/lib/utils.ts เป๊ะ
const hash = (value: string) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(value, salt, 64).toString('hex')}`;
};

if (mode === 'create') {
  if (!password) { console.error('ต้องมีรหัสผ่าน'); process.exit(1); }
  const now = new Date().toISOString();
  await sql`
    insert into users (username, password_hash, name, role, active, shipping_code, created_at, updated_at)
    values (${username}, ${hash(password)}, ${'ทดสอบชั่วคราว'}, ${role}, true, '', ${now}, ${now})
    on conflict (username) do update set password_hash = excluded.password_hash, role = excluded.role
  `;
  console.log(`สร้างบัญชีชั่วคราว ${username} (${role}) แล้ว`);
} else {
  await sql`delete from sessions where username = ${username}`;
  const deleted = await sql`delete from users where username = ${username}`;
  console.log(`ลบบัญชีชั่วคราว ${username} แล้ว (${deleted.count} แถว)`);
}

await sql.end();
