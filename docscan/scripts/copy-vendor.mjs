// คัดลอกไฟล์ที่ต้องเสิร์ฟเป็น static (OpenCV.js ~10MB, PDF.js worker) ไป public/vendor
// รันตอน postinstall และ prebuild — ไม่ commit ไฟล์ใหญ่เข้า git
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
const out = new URL('../public/vendor/', import.meta.url);
mkdirSync(out, { recursive: true });
const files = [
  ['node_modules/@techstark/opencv-js/dist/opencv.js', 'opencv.js'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs']
];
for (const [from, to] of files) {
  const src = new URL('../' + from, import.meta.url);
  if (!existsSync(src)) { console.error('missing', from); process.exit(1); }
  copyFileSync(src, new URL(to, out));
  console.log('vendor:', to);
}
