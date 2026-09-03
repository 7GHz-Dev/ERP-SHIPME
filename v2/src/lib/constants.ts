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
 * ค่าแลก DO ไม่อยู่ในนี้เพราะเป็นฝั่ง No VAT และดึงจากชีตงานขนส่งคนละที่กัน
 */
export const INVOICE_VAT_ITEMS = [
  { key: 'lift_on', label: 'ADV - ค่า LIFT ON' },
  { key: 'lift_off', label: 'ADV - ค่า LIFT OFF' },
  { key: 'storage', label: 'ADV - ค่า STORAGE' },
  { key: 'extra_movement', label: 'ADV - ค่า EXTRA MOVEMENT' }
] as const;

/** หัวกระดาษ/ท้ายกระดาษของใบแจ้งหนี้ — ลอกจากชีตต้นฉบับ แก้ที่เดียวแล้วเปลี่ยนทุกใบ */
export const INVOICE_COMPANY = {
  name: 'บริษัท ชิป มี โลจิสติกส์ จำกัด',
  address: 'ที่อยู่ 106/10 หมู่ที่ 9 ตำบลทุ่งสุขลา อำเภอศรีราชา จังหวัดชลบุรี 20230',
  taxId: '0205569011089',
  bankAccountName: 'บจก ชิป มี โลจิสติกส์',
  bankAccountNo: '228-3-81394-3 กสิกรไทย',
  note: 'หัก ณ ที่จ่ายในนาม บริษัท ชิป มี โลจิสติกส์ จำกัด พร้อมส่ง Slip โอนเงินมาที่ E-MAIL. shipme.acc@gmail.com',
  // โลโก้หัวใบแจ้งหนี้ — วางไฟล์ที่ v2/public/logo.png แล้วมันจะขึ้นเอง
  // ถ้ายังไม่มีไฟล์ หน้าพิมพ์จะซ่อนรูปให้อัตโนมัติ (onerror) ไม่ขึ้นเป็นรูปแตก
  logoUrl: '/logo.png',
  // ตราประทับบริษัท มุมขวาล่างของใบ — วางไฟล์ที่ v2/public/stamp.png
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
