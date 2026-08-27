import { env } from './env';
import { supabaseAdmin } from './supabase';
import { id } from './utils';

/**
 * ระบบเดิมเขียนรูปลงดิสก์ที่ data/uploads/<category>/<name> แล้วเก็บ URL "/files/<category>/<name>"
 * ลงฐานข้อมูล — Vercel ไม่มีดิสก์ถาวร จึงย้ายไฟล์ไป Supabase Storage แทน
 *
 * แต่ยัง**เก็บ URL รูปแบบเดิมลงฐานข้อมูล** ("/files/<category>/<name>") โดยตั้งใจ
 * แล้วให้ route /files/[...path] เป็นตัว redirect ไป signed URL ของ Supabase ตอนเปิดดู
 * เหตุผล: signed URL หมดอายุ ถ้าเก็บลงฐานข้อมูลตรง ๆ รูปเก่าจะเปิดไม่ได้ในไม่กี่ชั่วโมง
 * และวิธีนี้ทำให้ทั้ง index.html / admin.html / ข้อมูลเดิมที่ย้ายมา ใช้ต่อได้โดยไม่ต้องแก้
 */

const bucket = env.bucket;
const SIGNED_URL_SECONDS = 60 * 60;          // 1 ชั่วโมง พอสำหรับเปิดดู/ดาวน์โหลด

type Decoded = { buffer: Buffer; ext: string; contentType: string };

function decodeDataUrl(dataUrl: unknown): Decoded {
  const match = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i
    .exec(String(dataUrl || ''));
  if (!match) throw new Error('invalid_image_data');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw new Error('invalid_image_size');
  const contentType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const ext = /png/i.test(contentType) ? 'png' : (/webp/i.test(contentType) ? 'webp' : 'jpg');
  return { buffer, ext, contentType };
}

const safeCategory = (value: unknown) => String(value).replace(/[^a-z0-9_-]/gi, '') || 'misc';
const safeBase = (value: unknown, fallback: string) =>
  String(value || fallback).replace(/[^a-z0-9ก-๙._-]/gi, '_').slice(0, 120);

export type StoredFile = { id: string; fileName: string; key: string; url: string };

function stored(category: string, fileName: string): StoredFile {
  const key = `${category}/${fileName}`;
  return {
    id: key,
    fileName,
    key,
    url: `/files/${encodeURIComponent(category)}/${encodeURIComponent(fileName)}`
  };
}

/** อัปโหลดรูปที่ส่งมาเป็น data URL (ใช้กับรูปเล็ก เช่น รูปเช็กอิน ที่ยังส่งผ่าน API ได้) */
export async function saveDataImage(dataUrl: unknown, category: string, baseName = ''): Promise<StoredFile> {
  const { buffer, ext, contentType } = decodeDataUrl(dataUrl);
  const folder = safeCategory(category);
  const fileName = `${safeBase(baseName, id('file_'))}.${ext}`;
  const { error } = await supabaseAdmin.storage.from(bucket)
    .upload(`${folder}/${fileName}`, buffer, { contentType, upsert: false });
  if (error) throw new Error(`upload_failed: ${error.message}`);
  return stored(folder, fileName);
}

/** เขียนทับรูปเดิมของชื่อเดียวกัน (ถ่ายใบเสร็จใหม่) — ลบไฟล์นามสกุลอื่นทิ้งกันค้าง */
export async function replaceDataImage(dataUrl: unknown, category: string, baseName: string): Promise<StoredFile> {
  const { buffer, ext, contentType } = decodeDataUrl(dataUrl);
  const folder = safeCategory(category);
  const base = safeBase(baseName, id('file_'));
  const stale = ['jpg', 'png', 'webp'].filter((old) => old !== ext).map((old) => `${folder}/${base}.${old}`);
  if (stale.length) await supabaseAdmin.storage.from(bucket).remove(stale);

  const fileName = `${base}.${ext}`;
  const { error } = await supabaseAdmin.storage.from(bucket)
    .upload(`${folder}/${fileName}`, buffer, { contentType, upsert: true });
  if (error) throw new Error(`upload_failed: ${error.message}`);
  return stored(folder, fileName);
}

/**
 * ขอ URL สำหรับให้ "เบราว์เซอร์อัปโหลดตรงไป Supabase" — ใช้กับรูปใหญ่
 * (รูปใบปิดบัญชีเป็น PNG ~4,000px ซึ่งเกินลิมิต body 4.5 MB ของ Vercel Functions
 *  ถ้าส่งผ่าน API จะโดน FUNCTION_PAYLOAD_TOO_LARGE)
 */
export async function createSignedUpload(category: string, baseName: string, ext = 'png') {
  const folder = safeCategory(category);
  const fileName = `${safeBase(baseName, id('file_'))}.${String(ext).replace(/[^a-z0-9]/gi, '') || 'png'}`;
  const { data, error } = await supabaseAdmin.storage.from(bucket)
    .createSignedUploadUrl(`${folder}/${fileName}`, { upsert: true });
  if (error || !data) throw new Error(`signed_upload_failed: ${error?.message || 'unknown'}`);
  return { ...stored(folder, fileName), uploadUrl: data.signedUrl, uploadToken: data.token };
}

/** ไฟล์นี้มีอยู่จริงไหม — ใช้ยืนยันหลังเบราว์เซอร์อัปโหลดตรง ก่อนบันทึกลงฐานข้อมูล */
export async function fileExists(key: string) {
  const slash = key.lastIndexOf('/');
  if (slash < 0) return false;
  const { data, error } = await supabaseAdmin.storage.from(bucket)
    .list(key.slice(0, slash), { search: key.slice(slash + 1), limit: 1 });
  return !error && Array.isArray(data) && data.length > 0;
}

/**
 * ดึงไฟล์กลับมาเป็น data URL — ใช้ตอนกด "อ่านสลิปใหม่" ซึ่งต้องส่งรูปเข้า OCR อีกรอบ
 * (ระบบเดิมอ่านจากดิสก์ด้วย fs.readFileSync ตรงนี้ต้องโหลดจาก Storage แทน)
 */
export async function downloadAsDataUrl(key: string) {
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(key);
  if (error || !data) return '';
  const buffer = Buffer.from(await data.arrayBuffer());
  const contentType = data.type || 'image/jpeg';
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

/** สร้าง URL ชั่วคราวสำหรับเปิดดูไฟล์ (route /files/... เรียกใช้ตัวนี้) */
export async function signedUrlFor(key: string) {
  const { data, error } = await supabaseAdmin.storage.from(bucket)
    .createSignedUrl(key, SIGNED_URL_SECONDS);
  if (error || !data) return null;
  return data.signedUrl;
}
