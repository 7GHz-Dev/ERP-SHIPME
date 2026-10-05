/** ชนิดข้อมูลหลักของ DocScan — เก็บใน IndexedDB ทั้งหมด (ไม่ส่งขึ้นเซิร์ฟเวอร์) */

export type FilterName = 'original' | 'photo' | 'document' | 'clear' | 'bw' | 'gray';

export interface Point { x: number; y: number }
/** มุมเอกสาร เรียง บนซ้าย → บนขวา → ล่างขวา → ล่างซ้าย (พิกัดพิกเซลของภาพต้นฉบับ) */
export type Quad = [Point, Point, Point, Point];

/** ค่าปรับภาพ — brightness/contrast/saturation −100..100, sharpness 0..100 */
export interface Adjustments { brightness: number; contrast: number; saturation: number; sharpness: number }
export const DEFAULT_ADJUST: Adjustments = { brightness: 0, contrast: 0, saturation: 0, sharpness: 0 };

/** วัตถุบนชั้น markup — พิกัดเป็นสัดส่วน 0..1 ของหน้า จะได้ไม่ผูกกับความละเอียดภาพ */
export type MarkupObject =
  | { id: string; kind: 'stroke'; tool: 'pen' | 'highlighter'; color: string; width: number; points: Point[] }
  | { id: string; kind: 'erase'; color: string; width: number; points: Point[] }
  | { id: string; kind: 'rect'; color: string; width: number; x: number; y: number; w: number; h: number }
  | { id: string; kind: 'text'; color: string; size: number; font: string; align: CanvasTextAlign; text: string; x: number; y: number }
  | { id: string; kind: 'image'; src: string; x: number; y: number; w: number; h: number; rotation: number };

export interface Folder { id: string; name: string; parentFolderId: string | null; createdAt: number; deletedAt: number }

export interface DocRecord {
  id: string;
  name: string;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  thumbnail: Blob | null;
  ocrText: string;
  pageCount: number;
  /** ขนาดรวมของรูปทุกหน้า (ไบต์) */
  size: number;
  tags: string[];
  /** 0 = ยังไม่ลบ, อื่น ๆ = เวลาที่ย้ายลงถังขยะ */
  deletedAt: number;
}

export interface PageRecord {
  id: string;
  documentId: string;
  order: number;
  /** ภาพต้นฉบับ (ย่อด้านยาวสุดไม่เกิน 4000px) */
  originalImage: Blob;
  /** หลังครอบ/ปรับมุมมองแล้ว ก่อนใส่ฟิลเตอร์ — แก้ฟิลเตอร์ใหม่ได้โดยไม่ต้องครอบซ้ำ */
  croppedImage: Blob;
  /** ภาพสุดท้ายที่ใช้แสดงผล/ส่งออก (ฟิลเตอร์ + ปรับแสง + หมุน + markup) */
  processedImage: Blob;
  thumbnail: Blob;
  cropCoordinates: Quad | null;
  rotation: number;
  flip: boolean;
  filter: FilterName;
  adjustments: Adjustments;
  markup: MarkupObject[];
  ocrText: string;
  width: number;
  height: number;
}

export interface SignatureRecord { id: string; image: Blob; createdAt: number }

export type SortKey = 'name' | 'createdAt' | 'updatedAt' | 'size';
