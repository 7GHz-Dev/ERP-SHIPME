export const AUTO_MIN_CONTAINERS = { extra_movement: 2 };
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
];

export const SHEET_FONT_DEFS = [
  { k: 'title', label: 'แถบหัวเรื่อง', v: 31.5 },
  { k: 'info', label: 'แถบวันที่ / ชื่อ SHIPPING / ยอดเบิก', v: 25.2 },
  { k: 'head', label: 'หัวคอลัมน์', v: 21 },
  { k: 'cell', label: 'ตัวอักษรในช่อง (ค่าตั้งต้นของทุกช่อง)', v: 21 },
  { k: 'foot', label: 'ตัวเลขท้ายตาราง', v: 23.1 }
];

export const CLAIM_ITEM_DEFAULTS = [
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
  { key: 'special', label: 'ค่าบริการเพิ่มเติมพิเศษ', perContainer: false, rate: 0,
    reasons: [{ label: 'ยางเกิน', rate: 0 }, { label: 'สำแดงเท็จ', rate: 0 }, { label: KNOCK_LABEL, rate: 0 }] },
  { key: 'other', label: 'ค่าใช้จ่ายอื่นๆ', perContainer: false, rate: 0 }
];

export const SETTLE_COST_COLUMNS = [
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

export const SETTLE_RATE_DEFAULTS = {
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
export const TRANSPORT_SOURCE_STYLE = { TRANSIT: 'transit' };
