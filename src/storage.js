import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { id } from './utils.js';

const uploadsRoot = path.join(config.dataDir, 'uploads');

function decodeDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(String(dataUrl || ''));
  if (!match) throw new Error('invalid_image_data');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > config.maxBodyBytes) throw new Error('invalid_image_size');
  const ext = /png/i.test(match[1]) ? 'png' : (/webp/i.test(match[1]) ? 'webp' : 'jpg');
  return { buffer, ext };
}

export function saveDataImage(dataUrl, category, baseName = '') {
  const { buffer, ext } = decodeDataUrl(dataUrl);
  const safeCategory = String(category).replace(/[^a-z0-9_-]/gi, '') || 'misc';
  const folder = path.join(uploadsRoot, safeCategory);
  fs.mkdirSync(folder, { recursive: true });
  const safeBase = String(baseName || id('file_')).replace(/[^a-z0-9ก-๙._-]/gi, '_').slice(0, 120);
  const fileName = `${safeBase}.${ext}`;
  fs.writeFileSync(path.join(folder, fileName), buffer, { flag: 'wx' });
  const fileId = `${safeCategory}/${fileName}`;
  return { id: fileId, fileName, path: path.join(folder, fileName), url: `/files/${encodeURIComponent(safeCategory)}/${encodeURIComponent(fileName)}` };
}

export function replaceDataImage(dataUrl, category, baseName) {
  const { buffer, ext } = decodeDataUrl(dataUrl);
  const safeCategory = String(category).replace(/[^a-z0-9_-]/gi, '') || 'misc';
  const folder = path.join(uploadsRoot, safeCategory);
  fs.mkdirSync(folder, { recursive: true });
  const safeBase = String(baseName).replace(/[^a-z0-9ก-๙._-]/gi, '_').slice(0, 120);
  for (const oldExt of ['jpg', 'png', 'webp']) {
    const old = path.join(folder, `${safeBase}.${oldExt}`);
    if (fs.existsSync(old)) fs.rmSync(old);
  }
  const fileName = `${safeBase}.${ext}`;
  fs.writeFileSync(path.join(folder, fileName), buffer);
  return { id: `${safeCategory}/${fileName}`, fileName, path: path.join(folder, fileName), url: `/files/${encodeURIComponent(safeCategory)}/${encodeURIComponent(fileName)}` };
}

export function resolveUpload(category, fileName) {
  const safeCategory = String(category).replace(/[^a-z0-9_-]/gi, '');
  const safeName = path.basename(String(fileName));
  const target = path.resolve(uploadsRoot, safeCategory, safeName);
  const base = path.resolve(uploadsRoot) + path.sep;
  return target.startsWith(base) ? target : null;
}

export function removeUpload(fileId) {
  if (!fileId || !String(fileId).includes('/')) return;
  const [category, ...rest] = String(fileId).split('/');
  const target = resolveUpload(category, rest.join('/'));
  if (target && fs.existsSync(target)) fs.rmSync(target);
}
