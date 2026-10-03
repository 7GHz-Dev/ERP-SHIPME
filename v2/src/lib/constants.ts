export const AUTO_MIN_CONTAINERS: Record<string, number> = { extra_movement: 2 };
export const KNOCK_LABEL = 'ค่าน็อคตู้';
export const CLAIM_MAX_EDITS = 5;

export const SHEET_COL_DEFS = [
  { k: 'no', label: 'ลำดับ', w: 81, align: 'center' },
  { k: 'port', label: 'ท่า', w: 119, align: 'center' },
  { k: 'bl', label: 'เลข BL.', w: 234, align: 'center' },
  { k: 'containers', label: 'จำนวนตู้', w: 76, align: 'center' },
  { k: 'lift_on', label: 'ค่า LIFT ON', w: 120, align: 'right' },
  { k: 'lift_off', label: 'ค่า LIFT OFF', w: 120, align: 'right' },
  { k: 'storage', label: 'ค่า STORAGE', w: 120, align: 'right' },
  { k: 'extra_movement', label: 'ค่า EXTRA MOVEMENT', w: 120, align: 'right' },
  { k: 'extra_service', label: 'ค่าบริการเพิ่มเติม (ฟรีโซน)', w: 150, align: 'right' },
  { k: 'extra_service_transit', label: 'ค่าบริการเพิ่มเติม (ผ่านแดน)', w: 150, align: 'right' },
  { k: 'overtime', label: 'ค่าล่วงเวลา (มีใบเสร็จ)', w: 120, align: 'right' },
  { k: 'order_form', label: 'ค่า ORDER FORM', w: 150, align: 'right' },
  { k: 'seal', label: 'ค่าตะกั่ว', w: 120, align: 'right' },
  { k: '__special', label: 'ค่าบริการเพิ่มเติมพิเศษ', w: 150, align: 'left' },
  { k: 'otherDetail', label: 'รายละเอียดค่าใช้จ่ายอื่นๆ', w: 225, align: 'left' },
  { k: 'total', label: 'รวม', w: 120, align: 'right' }
] as const;

export const SHEET_FONT_DEFS = [
  { k: 'title', label: 'แถบหัวเรื่อง', v: 31.5 },
  { k: 'info', label: 'แถบวันที่ / ชื่อ SHIPPING / ยอดเบิก', v: 25.2 },
  { k: 'head', label: 'หัวคอลัมน์', v: 21 },
  { k: 'cell', label: 'ตัวอักษรในช่อง (ค่าตั้งต้นของทุกช่อง)', v: 21 },
  { k: 'foot', label: 'ตัวเลขท้ายตาราง', v: 23.1 }
] as const;

export type ClaimItemDefault = {
  key: string;
  label: string;
  perContainer: boolean;
  rate: number;
  primary?: boolean;
  ownQty?: boolean;
  input?: 'sets' | 'select';
  optionKey?: string;
  reasons?: { label: string; rate: number }[];
};

export const CLAIM_ITEM_DEFAULTS: ClaimItemDefault[] = [
  { key: 'lift_on', label: 'LIFT ON', perContainer: true, rate: 0, primary: true },
  { key: 'extra_service', label: 'ค่าบริการเพิ่มเติม(ฟรีโซน)', perContainer: true, rate: 0, primary: true, ownQty: true },
  { key: 'extra_movement', label: 'EXTRA MOVEMENT', perContainer: true, rate: 0, primary: true, ownQty: true },
  { key: 'lift_off', label: 'LIFT OFF', perContainer: false, rate: 0, primary: true },
  { key: 'reserve', label: 'เงินสำรอง', perContainer: false, rate: 0, primary: true },
  { key: 'extra_service_transit', label: 'ค่าบริการเพิ่มเติม(ผ่านแดน)', perContainer: true, rate: 0, ownQty: true },
  { key: 'storage', label: 'STORAGE', perContainer: false, rate: 0 },
  { key: 'order_form', label: 'ORDER FORM', perContainer: true, rate: 0, ownQty: true },
  { key: 'overtime', label: 'ค่าล่วงเวลา', perContainer: false, rate: 0, input: 'sets' },
  { key: 'seal', label: 'ค่าตะกั่ว', perContainer: false, rate: 0, input: 'select', optionKey: 'seal' },
  {
    key: 'special', label: 'ค่าบริการเพิ่มเติมพิเศษ', perContainer: false, rate: 0,
    reasons: [{ label: 'ยางเกิน', rate: 0 }, { label: 'สำแดงเท็จ', rate: 0 }, { label: KNOCK_LABEL, rate: 0 }]
  },
  { key: 'other', label: 'ค่าใช้จ่ายอื่นๆ', perContainer: false, rate: 0 }
];

export type SettleCostColumn = {
  key: string; label: string; input?: 'check' | 'select'; optionKey?: string; primary?: boolean;
};

export const SETTLE_COST_COLUMNS: SettleCostColumn[] = [
  { key: 'lift_on', label: 'ค่า LIFT ON' },
  { key: 'lift_off', label: 'ค่า LIFT OFF' },
  { key: 'storage', label: 'ค่า STORAGE' },
  { key: 'extra_movement', label: 'ค่า EXTRA MOVEMENT' },
  { key: 'extra_service', label: 'ค่าบริการเพิ่มเติม(ฟรีโซน)' },
  { key: 'extra_service_transit', label: 'ค่าบริการเพิ่มเติม(ผ่านแดน)' },
  { key: 'overtime', label: 'ค่าล่วงเวลา (มีใบเสร็จ)', input: 'check' },
  { key: 'order_form', label: 'ค่า ORDER FORM (ค่าธรรมเนียม)' },
  { key: 'seal', label: 'ค่าตะกั่ว', input: 'select', optionKey: 'seal', primary: true }
];

export const SETTLE_RATE_DEFAULTS: Record<string, number> = {
  lift_on: 1040,
  lift_off: 0,
  storage: 0,
  extra_movement: 530.4,
  extra_service: 500,
  extra_service_transit: 0,
  overtime: 0,
  order_form: 0,
  seal: 0
};

export const TRANSPORT_SOURCE_ORDER = ['MAESOT FREEZONE', 'TRANSIT'];
export const TRANSPORT_SOURCE_STYLE: Record<string, string> = { TRANSIT: 'transit' };

// ============ ใบแจ้งหนี้ ============

/** VAT 7% ตามกฎหมาย — แยกเป็นค่าคงที่เพราะใช้ทั้งตอนคิดยอดและตอนแสดงหัวข้อในฟอร์ม */
export const VAT_RATE = 0.07;

/**
 * ยอดในใบปิดบัญชีเป็นราคาที่รวมค่าบริการ 4% มาแล้ว ใบแจ้งหนี้จึงต้อง **หาร** 1.04
 * เพื่อถอดกลับเป็นยอดก่อนบวก แล้วค่อยคิด VAT 7% จากยอดที่ถอดแล้ว
 * (เคยเข้าใจผิดว่าเป็นการคูณเพิ่ม — ที่ถูกคือใบปิดบัญชีบวกมาให้แล้ว)
 */
export const INVOICE_DIVISOR = 1.04;

/**
 * ค่าใช้จ่ายที่ขึ้นใบแจ้งหนี้แบบมี VAT — คีย์ต้องตรงกับ costs ใน settlements.rows_json
 * หัวข้อที่ยังไม่มีช่องในใบปิดบัญชีให้เลือกและกรอกยอดในฟอร์มใบแจ้งหนี้ได้
 */
/**
 * หัวข้อในใบ VAT ที่ "ไม่ต้องคิด VAT" — อยู่ในใบเดียวกันแต่ไม่เข้าฐานภาษี
 * ค่าแลก DO เป็นเงินที่ออกแทนลูกค้า ไม่ใช่ค่าบริการของบริษัท จึงไม่มี VAT
 * เทียบจาก label เพราะรายการที่ผู้ใช้กรอกเองส่งมาแค่ชื่อกับยอด ไม่มี key
 */
export const INVOICE_VAT_EXEMPT_LABELS = ['ADV - ค่าแลก DO (NON VAT)'] as const;

export const INVOICE_VAT_ITEMS = [
  { key: 'do_non_vat', code: 'Dnv', label: 'ADV - ค่าแลก DO (NON VAT)' },
  { key: 'do_vat', code: 'Dv', label: 'ADV - ค่าแลก DO (VAT)' },
  { key: 'lift_on', code: 'Lo', label: 'ADV - ค่า LIFT ON' },
  { key: 'extra_movement', code: 'Em', label: 'ADV - ค่า EXTRA MOVEMENT' },
  { key: 'storage', code: 'St', label: 'ADV - ค่า STORAGE' },
  { key: 'insurance', code: 'Ins', label: 'ADV - ค่าพรบ.' }
] as const;

/**
 * ใบแจ้งหนี้ค่าบริการ (IN) — ออกจากชีตงานขนส่งตามช่วงวันที่ ไม่ใช่จากใบปิดบัญชี
 * ค่าบริการตรวจปล่อยคิดต่อตู้: ตู้ทั่วไป 2,200 / RORO 1,700 (CONTAINER NO. = RORO)
 * มี VAT 7% และหัก ณ ที่จ่าย 3% ทั้งสองแบบ
 */
export const SERVICE_RATES = { container: 2200, roro: 1700 } as const;
export const SERVICE_WITHHOLDING_RATE = 0.03;
// ใบค่าบริการรับเงินเข้าคนละบัญชีกับใบ ADV (ตามใบแจ้งหนี้ค่าบริการตัวอย่างของฝ่ายบัญชี)
export const SERVICE_BANK_ACCOUNT_NO = '229-3-14850-6 กสิกรไทย';

/**
 * ค่าบริการเพิ่มเติม — ดึงจากช่อง "หมายเหตุ" ของชีต (คั่นแต่ละรายการด้วย //)
 * เช่น "สำแดงเท็จ 2000 // ค่าน๊อคประตูออกจากท่า 100"
 * รายการที่ไม่ได้เขียนยอดไว้ (เช่น "ยางเกิน") ใช้ยอดจากช่อง คชจ. อื่นๆ แทน
 * "ค่าพรบ 401.25" (ไม่มีคำว่า ค่าบริการ) เป็นเงินสำรองจ่าย ไม่ใช่ค่าบริการ — ไม่คิด
 */
export const SERVICE_EXTRA_RULES: { pattern: RegExp; label: string }[] = [
  { pattern: /ค่าบริการ\s*พ\.?\s*ร\.?\s*บ/, label: 'ค่าบริการ พรบ.' },
  { pattern: /ยางเกิน/, label: 'ยางเกิน' },
  { pattern: /สำแดงเท็จ/, label: 'สำแดงเท็จ' },
  { pattern: /น[็๊]?อค/, label: 'ค่าน๊อคประตูออกจากท่า' },
  { pattern: /แลก\s*E\s*R/i, label: 'ค่าแลก ER' }
];
export const SERVICE_RORO_INSPECTOR_LABEL = 'ค่าบริการนายตรวจ (RORO)';
/**
 * งาน TRANSIT ที่หมายเหตุเขียน "NO CAR" = ไม่ได้ตรวจปล่อยรถ คิดแค่ค่านายตรวจข้ามสะพาน
 * BL นั้นไม่นับในใบสรุปจำนวนตู้และใบแจ้งหนี้ค่าบริการตรวจปล่อย TRANSIT
 */
export const SERVICE_BRIDGE_INSPECTOR_LABEL = 'ค่าบริการนายตรวจ (ข้ามสะพาน)';
export const SERVICE_BRIDGE_INSPECTOR_FEE = 100;
export const SERVICE_NO_CAR_PATTERN = /NO\s*-?\s*CAR/i;

/**
 * ใบหัก ณ ที่จ่าย (กระทำการแทน) — นับจากชีตงานขนส่งตามช่วงวันที่ตรวจปล่อย
 * DO นับเฉพาะสายเรือ (ช่อง VESSEL) ที่ออกใบหักให้ — ในชีตเขียนว่า K-NOT / SEALS / M+R
 */
export const WHT_DO_VESSELS: { label: string; pattern: RegExp }[] = [
  { label: 'KNOT GLOBAL', pattern: /K\s*-?\s*NOT/i },
  { label: 'SEAL', pattern: /^\s*SEALS?\b/i },
  { label: 'M+R', pattern: /M\s*\+\s*R/i }
];
/**
 * ยอดในชีตเป็นยอดที่จ่ายจริงหลังหัก ณ ที่จ่ายแล้ว: ฐาน + VAT 7% − หัก 3% = ฐาน × 1.04
 * (LIFT ON 1,040 = 1,000 + 70 − 30) ยอดหัก = ยอดในชีต ÷ 1.04 × 3% — หน้าเว็บแก้ตัวหาร/อัตราได้
 */
export const WHT_DEFAULT = { divisor: 1.04, rate: 0.03 } as const;
/**
 * ชีต "ค่าแลกดีโอ" — บันทึกวันที่จ่ายค่า DO จริง (แท็บละเดือน: ก.ย 69, ต.ค 69, …)
 * ใบหักค่า DO นับตามวันที่ในชีตนี้ ไม่ใช่วันที่ตรวจปล่อย — ต้องแชร์แบบใครมีลิงก์ก็ดูได้
 */
export const DO_SHEET_ID = '1WC1-0ilraByB5FTfrrTAykDpWiG4UIKhhGoQ5HgLz4c';

/**
 * ผู้รับโอนที่ถูกต้องในสลิปโอนคืนบริษัท (ปิดบัญชีชิปปิ้ง)
 * สลิปจริงเขียนว่า "บจก. ชิป มี โลจิสติกส์" — เทียบแบบตัดช่องว่างทิ้ง
 * และรับ OCR อ่านเพี้ยนที่พบบ่อย (ชิป/ชิพ/ซิป) กับชื่อภาษาอังกฤษ
 */
export const SLIP_PAYEE_LABEL = 'บจก. ชิป มี โลจิสติกส์';
export const SLIP_PAYEE_PATTERNS = [/[ชซ]ิ[ปพ]มีโลจ?ิสติ/, /shipmelogistic/i];

/**
 * ใบแจ้งหนี้ค่ามัดจำตู้ — ชนิด D ใช้เลขรันเดียวกับ NV ของ BL นั้นแล้วต่อท้าย -D (NV20261005-D)
 * มีรายการเดียวเสมอ และไม่คิด VAT
 */
export const INVOICE_DEPOSIT_LABEL = 'ADV - ค่ามัดจำตู้';

export const INVOICE_NO_VAT_ITEMS = [
  { key: 'do_fee', code: 'Dv', label: 'ADV - ค่าแลก DO' },
  { key: 'order_form', code: 'Of', label: 'ADV - ค่า ORDER FORM' }
] as const;

/** หัวกระดาษ/ท้ายกระดาษของใบแจ้งหนี้ — ลอกจากชีตต้นฉบับ แก้ที่เดียวแล้วเปลี่ยนทุกใบ */
export const INVOICE_COMPANY = {
  name: 'บริษัท ชิป มี โลจิสติกส์ จำกัด',
  address: 'ที่อยู่ 106/10 หมู่ที่ 9 ตำบลทุ่งสุขลา อำเภอศรีราชา จังหวัดชลบุรี 20230',
  taxId: '0205569011089',
  bankAccountName: 'บจก ชิป มี โลจิสติกส์',
  bankAccountNo: '228-3-81394-3 กสิกรไทย',
  note: 'หัก ณ ที่จ่ายในนาม บริษัท ชิป มี โลจิสติกส์ จำกัด พร้อมส่ง Slip โอนเงินมาที่ E-MAIL. shipme.acc@gmail.com',
  // โลโก้หัวใบแจ้งหนี้ (v2/public/logo.jpg) — เป็น JPEG เพราะไม่ต้องโปร่งใส ไฟล์เล็กกว่า PNG ครึ่งหนึ่ง
  // ถ้าไฟล์หาย หน้าพิมพ์จะซ่อนรูปให้เอง (onerror) ไม่ขึ้นเป็นรูปแตก
  logoUrl: '/logo.jpg',
  // ตราประทับมุมขวาล่าง (v2/public/stamp.png) — ต้องเป็น PNG เพราะครอปจากรูปถ่ายกระดาษ
  // แล้วลบพื้นหลังออกให้โปร่งใส ไม่งั้นจะเป็นกล่องเทาทับใบแจ้งหนี้
  stampUrl: '/stamp.png'
} as const;

/**
 * ลูกค้าประจำที่ใช้กับ **ทุกใบแจ้งหนี้** — เติมให้อัตโนมัติตั้งแต่เปิดฟอร์ม
 * ยังแก้รายใบได้ถ้าวันหนึ่งต้องออกให้เจ้าอื่น แต่ค่าเริ่มต้นคือรายนี้เสมอ
 */
export const INVOICE_CUSTOMER = {
  name: 'บริษัท โก่หล้าชิปปิ้ง จำกัด (สำนักงานใหญ่)',
  address: '567 หมู่ 7 ตำบลท่าสายลวด อำเภอแม่สอด จังหวัดตาก 63110',
  taxId: '0635561000980'
} as const;

/**
 * ใครเข้าเมนูใบแจ้งหนี้ได้บ้าง — admin/manager เดิมยังเข้าได้เพื่อดูแลระบบ
 * อยู่ที่นี่เพราะทั้ง dispatch (ด่านสิทธิ์) และ invoices (canApprove ส่งให้หน้าเว็บ) ใช้ชุดเดียวกัน
 * ถ้าปล่อยไว้ใน dispatch แล้วให้ invoices นำเข้า จะกลายเป็น import วนกัน
 */
export const ACCOUNT_ROLES = ['admin', 'manager', 'manager-account', 'employee-account'];
