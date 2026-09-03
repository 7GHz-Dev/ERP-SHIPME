import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex
} from 'drizzle-orm/pg-core';

/**
 * ชื่อผู้ใช้เดิมใน SQLite เป็น `TEXT COLLATE NOCASE` — เทียบแบบไม่สนตัวพิมพ์
 * Postgres ไม่มี NOCASE จึงใช้ citext (ต้องเปิด extension ก่อน ดู drizzle/0000_extensions.sql)
 * ทำแบบนี้แทนการเติม `lower()` ทุกจุด เพราะโค้ดเดิมพึ่ง COLLATE ไว้ 37 จุด
 */
const citext = customType<{ data: string }>({ dataType: () => 'citext' });

/**
 * วันที่/เวลาทั้งระบบเก็บเป็น TEXT ('YYYY-MM-DD' และ ISO string) เหมือนเดิมโดยตั้งใจ
 * โค้ดทั้งระบบเทียบวันที่แบบ string (BETWEEN, <, >) ถ้าเปลี่ยนเป็น timestamp
 * จะเจอปัญหา timezone ทันที เพราะเซิร์ฟเวอร์อยู่ UTC แต่ผู้ใช้ทำงานตามเวลาไทย
 */

export const users = pgTable('users', {
  username: citext('username').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  active: boolean('active').notNull().default(true),
  shippingCode: text('shipping_code').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const sessions = pgTable('sessions', {
  token: text('token').primaryKey(),
  username: citext('username').notNull()
    .references(() => users.username, { onUpdate: 'cascade', onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  device: text('device').notNull().default('')
}, (t) => [index('sessions_user_idx').on(t.username, t.expiresAt)]);

export const checkins = pgTable('checkins', {
  id: text('id').primaryKey(),
  serverTime: text('server_time').notNull(),
  localDate: text('local_date').notNull(),
  deviceTime: text('device_time').notNull().default(''),
  username: citext('username').notNull()
    .references(() => users.username, { onUpdate: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  accuracyM: doublePrecision('accuracy_m').notNull().default(0),
  address: text('address').notNull().default(''),
  mapLink: text('map_link').notNull().default(''),
  photoUrl: text('photo_url').notNull().default(''),
  photoId: text('photo_id').notNull().default('')
}, (t) => [
  // เช็กอินได้วันละครั้งต่อคน — กันกดซ้ำระดับฐานข้อมูล ไม่ใช่แค่เช็กในโค้ด
  uniqueIndex('checkins_user_date_idx').on(t.username, t.localDate),
  index('checkins_time_idx').on(t.serverTime.desc())
]);

export const leaves = pgTable('leaves', {
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull(),
  username: citext('username').notNull()
    .references(() => users.username, { onUpdate: 'cascade' }),
  name: text('name').notNull(),
  leaveType: text('leave_type').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  days: integer('days').notNull(),
  reason: text('reason').notNull().default(''),
  status: text('status').notNull().default('pending'),
  decidedBy: text('decided_by').notNull().default(''),
  decidedAt: text('decided_at').notNull().default(''),
  note: text('note').notNull().default('')
}, (t) => [index('leaves_user_idx').on(t.username, t.createdAt.desc())]);

export const appOptions = pgTable('app_options', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const claimRates = pgTable('claim_rates', {
  key: text('key').primaryKey(),
  rate: doublePrecision('rate').notNull().default(0),
  reasonsJson: text('reasons_json').notNull().default('[]'),
  updatedAt: text('updated_at').notNull()
});

export const claims = pgTable('claims', {
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  username: citext('username').notNull()
    .references(() => users.username, { onUpdate: 'cascade' }),
  name: text('name').notNull(),
  inspectDate: text('inspect_date').notNull(),
  containers: integer('containers').notNull(),
  total: doublePrecision('total').notNull(),
  editCount: integer('edit_count').notNull().default(0),
  itemsJson: text('items_json').notNull(),
  detail: text('detail').notNull(),
  detailAll: text('detail_all').notNull(),
  detailFirst: text('detail_first').notNull(),
  editDetailsJson: text('edit_details_json').notNull().default('[]')
}, (t) => [
  // เบิกได้วันละ 1 ใบต่อคน
  uniqueIndex('claims_user_date_idx').on(t.username, t.inspectDate),
  index('claims_user_idx').on(t.username, t.inspectDate.desc())
]);

export const settleRates = pgTable('settle_rates', {
  key: text('key').primaryKey(),
  rate: doublePrecision('rate').notNull().default(0),
  updatedAt: text('updated_at').notNull()
});

export const slips = pgTable('slips', {
  id: text('id').primaryKey(),
  username: citext('username').notNull()
    .references(() => users.username, { onUpdate: 'cascade' }),
  uploadedAt: text('uploaded_at').notNull(),
  fileName: text('file_name').notNull(),
  url: text('url').notNull(),
  infoJson: text('info_json').notNull()
});

export const settlements = pgTable('settlements', {
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  username: citext('username').notNull()
    .references(() => users.username, { onUpdate: 'cascade' }),
  name: text('name').notNull(),
  inspectDate: text('inspect_date').notNull(),
  claimTotal: doublePrecision('claim_total').notNull(),
  totalExpense: doublePrecision('total_expense').notNull(),
  balance: doublePrecision('balance').notNull(),
  editCount: integer('edit_count').notNull().default(0),
  returnedDate: text('returned_date').notNull().default(''),
  companyReturnedDate: text('company_returned_date').notNull().default(''),
  rowsJson: text('rows_json').notNull(),
  detail: text('detail').notNull(),
  imageUrl: text('image_url').notNull().default(''),
  slipUrl: text('slip_url').notNull().default(''),
  slipTxn: text('slip_txn').notNull().default(''),
  slipAmount: doublePrecision('slip_amount').notNull().default(0),
  slipDate: text('slip_date').notNull().default(''),
  slipStatus: text('slip_status').notNull().default(''),
  slipBank: text('slip_bank').notNull().default(''),
  // ข้อมูลที่ย้ายมาจากชีตเดิมมีบางวันที่ปิดบัญชีซ้ำคนละใบ ต้องเก็บไว้ทั้งหมด
  // ใบที่สร้างใหม่ยังถูกกันซ้ำด้วย partial unique index ด้านล่างตามเดิม
  legacyDuplicate: boolean('legacy_duplicate').notNull().default(false)
}, (t) => [
  // ปิดบัญชีได้วันละ 1 ใบต่อคน — ยกเว้นใบที่ย้ายมาจากชีตเดิมซึ่งมีซ้ำอยู่ก่อนแล้ว
  uniqueIndex('settlements_new_date_idx')
    .on(t.username, t.inspectDate)
    .where(sql`${t.legacyDuplicate} = false`),
  // เลขที่รายการสลิปห้ามซ้ำทั้งระบบ กันเอาสลิปใบเดียวไปใช้ปิดหลายวัน
  uniqueIndex('settlements_slip_txn_idx')
    .on(sql`upper(${t.slipTxn})`)
    .where(sql`${t.slipTxn} <> ''`)
]);

export const receipts = pgTable('receipts', {
  id: text('id').primaryKey(),
  serverTime: text('server_time').notNull(),
  deviceTime: text('device_time').notNull().default(''),
  username: citext('username').notNull()
    .references(() => users.username, { onUpdate: 'cascade' }),
  name: text('name').notNull(),
  note: text('note').notNull().default(''),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  accuracyM: doublePrecision('accuracy_m').notNull().default(0),
  address: text('address').notNull().default(''),
  mapLink: text('map_link').notNull().default(''),
  photoUrl: text('photo_url').notNull(),
  photoId: text('photo_id').notNull(),
  inspectDate: text('inspect_date').notNull(),
  retakeCount: integer('retake_count').notNull().default(0)
}, (t) => [
  uniqueIndex('receipts_user_date_idx').on(t.username, t.inspectDate),
  index('receipts_time_idx').on(t.serverTime.desc())
]);

export const transportJobs = pgTable('transport_jobs', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  transportDate: text('transport_date').notNull(),
  shipping: text('shipping').notNull().default(''),
  bl: text('bl').notNull().default(''),
  containerNo: text('container_no').notNull().default(''),
  quantity: doublePrecision('quantity').notNull().default(0),
  port: text('port').notNull().default(''),
  customer: text('customer').notNull().default(''),
  // ---- คอลัมน์ที่เหลือจากชีตงานขนส่ง ----
  // ดึงมาทั้งแผ่นเพื่อให้ v2 มีข้อมูลชุดเดียวกับชีต ไม่ต้องเปิดชีตควบไปมา
  // ตัวเลขทั้งหมดเก็บเป็น double ตัดลูกน้ำออกแล้ว ช่องที่เป็น #REF!/ว่าง = 0
  vessel: text('vessel').notNull().default(''),
  // ค่าแลก DO อยู่ในชีตงานขนส่ง ไม่ได้อยู่ในใบปิดบัญชี — ใบแจ้งหนี้แบบ No VAT ใช้ยอดนี้
  doFee: doublePrecision('do_fee').notNull().default(0),
  dem: doublePrecision('dem').notNull().default(0),
  extraMovement: doublePrecision('extra_movement').notNull().default(0),
  storage: doublePrecision('storage').notNull().default(0),
  liftOn: doublePrecision('lift_on').notNull().default(0),
  liftOff: doublePrecision('lift_off').notNull().default(0),
  orderForm: doublePrecision('order_form').notNull().default(0),
  inspectorFee: doublePrecision('inspector_fee').notNull().default(0),
  overtime: doublePrecision('overtime').notNull().default(0),
  sealFee: doublePrecision('seal_fee').notNull().default(0),
  otherFee: doublePrecision('other_fee').notNull().default(0),
  detention: doublePrecision('detention').notNull().default(0),
  repairFee: doublePrecision('repair_fee').notNull().default(0),
  note: text('note').notNull().default(''),
  driver: text('driver').notNull().default(''),
  // ชีตติ๊ก TRUE ไว้เมื่อปิดบัญชีแล้ว (มีเฉพาะไฟล์ TRANSIT)
  settled: boolean('settled').notNull().default(false),
  // วันที่ส่งเอกสารไปแม่สอด — ชื่อคอลัมน์ต่างกันสองไฟล์ แต่ความหมายเดียวกัน
  docSentDate: text('doc_sent_date').notNull().default(''),
  // เลขที่ใบแจ้งหนี้ที่ทีมบัญชีเคยกรอกไว้ในชีตเอง (ของเดิมก่อนมีเมนูใบแจ้งหนี้ใน v2)
  invoiceNo: text('invoice_no').notNull().default(''),
  sourceFile: text('source_file').notNull().default(''),
  sourceSheet: text('source_sheet').notNull().default(''),
  sourceName: text('source_name').notNull().default(''),
  importedAt: text('imported_at').notNull()
}, (t) => [index('transport_lookup_idx').on(t.transportDate, t.shipping)]);

export const geocodeCache = pgTable('geocode_cache', {
  point: text('point').primaryKey(),
  address: text('address').notNull(),
  updatedAt: text('updated_at').notNull()
});

/**
 * ใบแจ้งหนี้ที่ฝ่ายบัญชีออกให้ลูกค้า
 *
 * เลขที่ใบแจ้งหนี้เป็น primary key ตรง ๆ (V/NV + yyyymm + เลขรัน 2 หลัก) เพราะเป็นเลข
 * ที่ต้องไม่ซ้ำอยู่แล้วตามกฎหมาย และเป็นสิ่งที่คนอ้างถึงเวลาคุยกัน — ไม่ต้องมี id ซ้อนอีกชั้น
 *
 * itemsJson เก็บรายการในตารางทั้งชุด (เหมือน settlements.rows_json) เพราะจำนวนบรรทัด
 * ไม่คงที่และไม่เคยต้อง query รายบรรทัด — ดึงทั้งใบมาแสดงเสมอ
 */
export const invoices = pgTable('invoices', {
  number: text('number').primaryKey(),
  kind: text('kind').notNull(),                       // 'V' = มี VAT | 'NV' = ไม่มี VAT
  period: text('period').notNull(),                   // yyyymm — ใช้หาเลขรันถัดไปของเดือนนั้น
  seq: integer('seq').notNull(),                      // เลขรันในเดือน (1-99)
  issueDate: text('issue_date').notNull(),            // yyyy-MM-dd
  customerName: text('customer_name').notNull().default(''),
  customerAddress: text('customer_address').notNull().default(''),
  customerTaxId: text('customer_tax_id').notNull().default(''),
  bl: text('bl').notNull().default(''),
  itemsJson: text('items_json').notNull(),
  subtotal: doublePrecision('subtotal').notNull().default(0),
  vat: doublePrecision('vat').notNull().default(0),
  total: doublePrecision('total').notNull().default(0),
  withholding: doublePrecision('withholding').notNull().default(0),
  netTotal: doublePrecision('net_total').notNull().default(0),
  note: text('note').notNull().default(''),
  preparedBy: text('prepared_by').notNull().default(''),
  status: text('status').notNull().default('draft'),  // draft | approved | cancelled
  approvedBy: text('approved_by').notNull().default(''),
  approvedAt: text('approved_at').notNull().default(''),
  // ใบปิดบัญชีที่เอามาออกใบนี้ — กันออกซ้ำและตามกลับไปดูที่มาได้
  settlementId: text('settlement_id').notNull().default(''),
  createdBy: citext('created_by').notNull()
    .references(() => users.username, { onUpdate: 'cascade' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (t) => [
  // หาเลขรันถัดไปของเดือน + ไล่ดูใบตามช่วงเวลา
  index('invoices_period_idx').on(t.kind, t.period, t.seq),
  index('invoices_created_idx').on(t.createdBy, t.issueDate)
]);
