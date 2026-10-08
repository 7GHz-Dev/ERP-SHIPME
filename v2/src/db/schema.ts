import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
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
  // สลิปโอนเพิ่มตอนแก้ใบ — ยอดเพิ่มหลังโอนไปแล้ว พนักงานโอนแค่ส่วนต่าง จึงเป็นสลิปอีกใบ
  // [{ url, txn, amount, date, status, bank }] สลิปหลักยังอยู่ที่ slip_* เหมือนเดิม
  extraSlipsJson: text('extra_slips_json').notNull().default('[]'),
  // สลิปบริษัทโอนคืนชิปปิ้ง — พนักงานโอนคืนไปแล้ว ภายหลังค่าใช้จ่ายจริงเพิ่ม (หรือคงเหลือติดลบ)
  // ฝ่ายบัญชีโอนส่วนต่างคืนพนักงานแล้วแนบสลิป [{ url, txn, amount, date, status, bank, by, at }]
  companySlipsJson: text('company_slips_json').notNull().default('[]'),
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

/**
 * หลักฐานการตรวจปล่อย (PDF จาก DocScan หรือไฟล์ที่แนบเอง) — ผูกกับพนักงาน + วันที่ตรวจปล่อย
 * ไม่ผูกกับ id ใบปิดบัญชี เพราะต้องแนบได้ก่อนกดบันทึกใบปิดบัญชีครั้งแรก
 */
export const inspectionFiles = pgTable('inspection_files', {
  id: text('id').primaryKey(),
  username: citext('username').notNull()
    .references(() => users.username, { onUpdate: 'cascade', onDelete: 'cascade' }),
  inspectDate: text('inspect_date').notNull(),
  fileName: text('file_name').notNull(),
  storageKey: text('storage_key').notNull(),
  url: text('url').notNull(),
  pages: integer('pages').notNull().default(0),
  size: integer('size').notNull().default(0),
  source: text('source').notNull().default('docscan'),
  createdAt: text('created_at').notNull(),
  createdBy: citext('created_by').notNull().default('')
}, (t) => [index('inspection_files_user_date_idx').on(t.username, t.inspectDate)]);

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

/**
 * ประวัติการ sync ชีตงานขนส่ง — หน้า dashboard ใช้ดูว่ารอบไหนเพิ่ม/ลบอะไรบ้าง
 *
 * transport_jobs เก็บได้แค่สถานะปัจจุบัน เพราะทุกรอบ sync จะลบทั้งแท็บแล้วใส่ใหม่
 * ทุกแถวเลยมี imported_at เดียวกันหมด ดูย้อนหลังไม่ได้ว่าแถวไหนเพิ่งเข้ามา
 * ตารางนี้จึงบันทึกผลของแต่ละรอบไว้แยก พร้อมตัวอย่าง BL ที่เปลี่ยน
 */
export const transportSyncLogs = pgTable('transport_sync_logs', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  syncedAt: text('synced_at').notNull(),
  sourceFile: text('source_file').notNull().default(''),
  sourceSheet: text('source_sheet').notNull().default(''),
  rowsBefore: integer('rows_before').notNull().default(0),
  rowsAfter: integer('rows_after').notNull().default(0),
  added: integer('added').notNull().default(0),
  removed: integer('removed').notNull().default(0),
  // ตัวอย่าง BL ที่เพิ่ม/หายไปในรอบนั้น เก็บเป็น JSON สั้น ๆ ไม่เกิน 20 รายการ
  addedBls: text('added_bls').notNull().default('[]'),
  removedBls: text('removed_bls').notNull().default('[]'),
  // จำนวนแถวที่ "แก้ค่าเดิม" (BL+ตู้ เดิม แต่คอลัมน์อื่นเปลี่ยน)
  changed: integer('changed').notNull().default(0),
  /**
   * รายละเอียดว่าคอลัมน์ไหนเปลี่ยนเป็นค่าอะไร — JSON ไม่เกิน 30 รายการ
   * [{ bl, container, kind:'added'|'changed', fields:[{ column, label, from, to }] }]
   * เก็บไว้ให้หน้า dashboard แสดงชื่อคอลัมน์กับค่าที่เพิ่งเข้ามาได้
   */
  details: text('details').notNull().default('[]')
}, (t) => [index('transport_sync_logs_idx').on(t.syncedAt)]);

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
  // ---- ชุดเอกสารที่ฝากส่ง KOLA ----
  // batchNo = เลขชุดในเดือนนั้น (นับใหม่ทุกเดือน) เช่น 1 → "ชุดที่ 01/09"
  batchNo: integer('batch_no'),
  batchPeriod: text('batch_period').notNull().default(''),   // yyyymm ของชุด
  batchSentDate: text('batch_sent_date').notNull().default(''), // วันที่ฝากส่ง yyyy-MM-dd
  // ชื่อชุดที่แสดง — ปกติเป็น "ชุดที่ 03/09" ที่ระบบออกให้ แก้เองได้ถ้าต้องใช้ชื่ออื่น
  batchName: text('batch_name').notNull().default(''),
  sentToKola: boolean('sent_to_kola').notNull().default(false),
  // ---- รอลูกค้ารับเอกสาร ----
  // ส่ง KOLA แล้วจะมาอยู่สถานะ 'waiting' จนกว่าลูกค้าจะตอบกลับ
  //   waiting  = รอลูกค้ารับเอกสาร
  //   accepted = เอกสารถูกต้อง → ไปโผล่ที่ลูกหนี้สำรองจ่ายคงค้าง
  // ใบที่ต้องแก้ยังค้างอยู่ที่ waiting แต่ติดธง needsFix ไว้พร้อมเหตุผล
  docStatus: text('doc_status').notNull().default(''),
  needsFix: boolean('needs_fix').notNull().default(false),
  fixNote: text('fix_note').notNull().default(''),
  fixedBy: citext('fixed_by').notNull().default(''),
  fixedAt: text('fixed_at').notNull().default(''),
  // ---- ลูกหนี้สำรองจ่ายคงค้าง ----
  paidAmount: doublePrecision('paid_amount').notNull().default(0),
  paidAt: text('paid_at').notNull().default(''),
  receiptNo: text('receipt_no').notNull().default(''),
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

// ============ แพลนงานตรวจปล่อย + SMS คนขับรถ ============

/**
 * ชิปปิ้งประจำท่า รายเดือน — ผู้จัดการตั้งไว้ในเมนูตั้งค่าระบบ แพลนงานใช้เลือกชิปปิ้งให้อัตโนมัติ
 * 1 ท่าต่อเดือน = ชิปปิ้ง 1 คน (เลือกให้อัตโนมัติได้ไม่กำกวม) — แถวที่ต้องแยกคนค่อยเปลี่ยนในแพลน
 */
export const portAssignments = pgTable('port_assignments', {
  period: text('period').notNull(),                   // yyyymm
  portKey: text('port_key').notNull(),                // ชื่อท่าแบบตัดช่องว่าง/ขีด ตัวใหญ่ (KERRY, D1D2)
  port: text('port').notNull(),                       // ชื่อท่าตามที่ตั้งไว้ (แสดงผล)
  username: citext('username').notNull()
    .references(() => users.username, { onUpdate: 'cascade', onDelete: 'cascade' }),
  updatedBy: citext('updated_by').notNull().default(''),
  updatedAt: text('updated_at').notNull()
}, (t) => [primaryKey({ columns: [t.period, t.portKey] })]);

/** แพลนงานของวันที่ตรวจปล่อย 1 วัน = 1 แพลน — ชิปปิ้งเห็นงานเมื่อผู้จัดการกด Confirm Plan แล้วเท่านั้น */
export const jobPlans = pgTable('job_plans', {
  inspectDate: text('inspect_date').primaryKey(),
  status: text('status').notNull().default('draft'),  // draft | confirmed
  driverFile: text('driver_file').notNull().default(''),  // ชื่อไฟล์ข้อมูลคนขับรถที่ใช้ล่าสุด
  confirmCount: integer('confirm_count').notNull().default(0),
  createdBy: citext('created_by').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedBy: citext('updated_by').notNull().default(''),
  updatedAt: text('updated_at').notNull(),
  confirmedBy: citext('confirmed_by').notNull().default(''),
  confirmedAt: text('confirmed_at').notNull().default('')
});

/**
 * งานในแพลน 1 แถว = 1 ตู้ — งานจากตาราง MAESOT FREEZONE / TRANSIT จับคู่กับไฟล์คนขับรถด้วยเลขตู้
 * เก็บสำเนาค่าไว้ทั้งแถว (ไม่อ้าง transport_jobs) เพราะ sync ชีตลบแล้วใส่ใหม่ทั้งแท็บทุกรอบ id เปลี่ยนตลอด
 */
export const jobPlanItems = pgTable('job_plan_items', {
  id: text('id').primaryKey(),
  inspectDate: text('inspect_date').notNull()
    .references(() => jobPlans.inspectDate, { onDelete: 'cascade' }),
  seq: integer('seq').notNull().default(0),
  bl: text('bl').notNull().default(''),
  containerNo: text('container_no').notNull().default(''),
  port: text('port').notNull().default(''),
  destination: text('destination').notNull().default(''),
  customer: text('customer').notNull().default(''),
  source: text('source').notNull().default(''),       // MAESOT FREEZONE | TRANSIT | DRIVER FILE (มีในไฟล์คนขับ แต่ไม่มีในตาราง)
  sheetShipping: text('sheet_shipping').notNull().default(''),
  driverName: text('driver_name').notNull().default(''),
  plate: text('plate').notNull().default(''),
  phone: text('phone').notNull().default(''),
  username: citext('username').notNull().default(''),  // ชิปปิ้งที่รับผิดชอบ ('' = ยังไม่กำหนด)
  assignedBy: text('assigned_by').notNull().default(''),  // port | sheet | manual
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (t) => [
  index('job_plan_items_date_idx').on(t.inspectDate, t.seq),
  index('job_plan_items_user_idx').on(t.username, t.inspectDate)
]);

/** รูปแผนที่นัดหมายคนขับรถ (แผนที่ + รูปหน้างานจริง รวมเป็นไฟล์เดียว) — ผูกท่าไว้เพื่อเลือกให้อัตโนมัติ */
export const meetingMaps = pgTable('meeting_maps', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  port: text('port').notNull().default(''),
  portKey: text('port_key').notNull().default(''),
  storageKey: text('storage_key').notNull(),
  url: text('url').notNull(),
  width: integer('width').notNull().default(0),
  height: integer('height').notNull().default(0),
  size: integer('size').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdBy: citext('created_by').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

/**
 * SMS ที่ชิปปิ้งส่งหาคนขับรถ — 1 แถว = 1 เบอร์ต่อการกดส่ง 1 ครั้ง (คนขับคนเดียวลากหลายตู้ = SMS เดียว)
 * SMS ไม่มีสถานะ "อ่านแล้ว" จริง ๆ จึงนับจากการกดลิงก์ในข้อความ (/d/<code>) แทน
 */
export const smsMessages = pgTable('sms_messages', {
  id: text('id').primaryKey(),
  code: text('code').notNull().default(''),           // รหัสลิงก์สั้น ('' = ข้อความไม่มีลิงก์)
  inspectDate: text('inspect_date').notNull(),
  itemIdsJson: text('item_ids_json').notNull().default('[]'),
  username: citext('username').notNull().default(''),  // ชิปปิ้งเจ้าของงาน
  sentBy: citext('sent_by').notNull().default(''),     // คนที่กดส่งจริง (ผู้จัดการส่งแทนได้)
  phone: text('phone').notNull(),
  driverName: text('driver_name').notNull().default(''),
  plate: text('plate').notNull().default(''),
  containers: text('containers').notNull().default(''),
  kind: text('kind').notNull().default('appoint'),     // appoint | ask | custom
  body: text('body').notNull().default(''),            // ข้อความที่พิมพ์ (ไม่รวมลิงก์) — หน้าลิงก์แสดงข้อความนี้
  message: text('message').notNull().default(''),      // ข้อความที่ส่งจริงทั้งก้อน
  withLocation: boolean('with_location').notNull().default(false),
  mapId: text('map_id').notNull().default(''),
  mapKey: text('map_key').notNull().default(''),       // storage key ของรูปแผนที่ ณ ตอนส่ง
  provider: text('provider').notNull().default('thaibulksms'),  // thaibulksms | device | dry-run
  status: text('status').notNull().default('queued'),  // queued | sent | failed
  providerId: text('provider_id').notNull().default(''),
  credit: doublePrecision('credit').notNull().default(0),
  error: text('error').notNull().default(''),
  sentAt: text('sent_at').notNull().default(''),
  previewAt: text('preview_at').notNull().default(''),  // แอปข้อความของคนขับโหลดตัวอย่างลิงก์ (thumbnail)
  openedAt: text('opened_at').notNull().default(''),
  lastOpenedAt: text('last_opened_at').notNull().default(''),
  openCount: integer('open_count').notNull().default(0),
  locationStatus: text('location_status').notNull().default(''),  // shared | denied | unavailable
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),
  accuracyM: doublePrecision('accuracy_m'),
  locationAt: text('location_at').notNull().default(''),
  createdAt: text('created_at').notNull()
}, (t) => [
  uniqueIndex('sms_messages_code_idx').on(t.code).where(sql`${t.code} <> ''`),
  index('sms_messages_date_idx').on(t.inspectDate, t.username)
]);

/** ตำแหน่งคนขับรถทุกครั้งที่กดลิงก์แล้วอนุญาต — เก็บประวัติไว้ใช้งานส่วนอื่นต่อ (sms_messages เก็บแค่ล่าสุด) */
export const driverLocations = pgTable('driver_locations', {
  id: text('id').primaryKey(),
  smsId: text('sms_id').notNull().references(() => smsMessages.id, { onDelete: 'cascade' }),
  inspectDate: text('inspect_date').notNull(),
  phone: text('phone').notNull(),
  driverName: text('driver_name').notNull().default(''),
  plate: text('plate').notNull().default(''),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  accuracyM: doublePrecision('accuracy_m').notNull().default(0),
  userAgent: text('user_agent').notNull().default(''),
  createdAt: text('created_at').notNull()
}, (t) => [index('driver_locations_phone_idx').on(t.phone, t.createdAt)]);

/**
 * ใบแจ้งหนี้ค่าบริการ (IN) — เดิมทำเป็น PDF อย่างเดียว ตอนนี้บันทึกลงระบบเพื่อตามลูกหนี้ค่าบริการและออกใบเสร็จ
 *
 * 1 แถว = ใบแจ้งหนี้ 1 ใบ (ค่าบริการตรวจปล่อยต่อไฟล์ชีต หรือค่าบริการเพิ่มเติม)
 * summaryJson เก็บใบสรุปที่แนบคู่กัน (ใบสรุปจำนวนตู้ / ใบสรุปค่าบริการเพิ่มเติม) ไว้พิมพ์ซ้ำได้หน้าตาเดิม
 * ลูกค้าจ่ายยอดหลังหัก ณ ที่จ่าย 3% — ลูกหนี้จึงนับจาก netTotal ไม่ใช่ total
 */
export const serviceInvoices = pgTable('service_invoices', {
  number: text('number').primaryKey(),                // IN + yyyymm + เลขรัน
  period: text('period').notNull(),
  seq: integer('seq').notNull(),
  issueDate: text('issue_date').notNull(),
  title: text('title').notNull(),
  category: text('category').notNull().default('inspect'),   // inspect | extra
  source: text('source').notNull().default(''),               // MAESOT FREEZONE | TRANSIT | '' (ค่าบริการเพิ่มเติมรวมทุกไฟล์)
  rangeFrom: text('range_from').notNull().default(''),        // ช่วงวันที่ตรวจปล่อยของงานในใบ
  rangeTo: text('range_to').notNull().default(''),
  customerName: text('customer_name').notNull().default(''),
  customerAddress: text('customer_address').notNull().default(''),
  customerTaxId: text('customer_tax_id').notNull().default(''),
  itemsJson: text('items_json').notNull(),
  summaryJson: text('summary_json').notNull().default(''),
  subtotal: doublePrecision('subtotal').notNull().default(0),
  vat: doublePrecision('vat').notNull().default(0),
  total: doublePrecision('total').notNull().default(0),
  withholding: doublePrecision('withholding').notNull().default(0),
  netTotal: doublePrecision('net_total').notNull().default(0),
  preparedBy: text('prepared_by').notNull().default(''),
  // ---- ลูกหนี้คงค้างค่าบริการ ----
  paidAmount: doublePrecision('paid_amount').notNull().default(0),
  paidAt: text('paid_at').notNull().default(''),
  // ---- ใบเสร็จรับเงิน / ใบกำกับภาษี (RE + yyyymm + เลขรัน แยกจากเลขใบแจ้งหนี้) ----
  receiptNo: text('receipt_no').notNull().default(''),
  receiptDate: text('receipt_date').notNull().default(''),
  createdBy: citext('created_by').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (t) => [
  index('service_invoices_issue_idx').on(t.issueDate),
  uniqueIndex('service_invoices_receipt_idx').on(t.receiptNo).where(sql`${t.receiptNo} <> ''`)
]);
