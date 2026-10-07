/* DocScan service worker — ใช้งานออฟไลน์ได้
 * - หน้าแอป: network-first (ได้เวอร์ชันใหม่เมื่อออนไลน์) ตกไปใช้แคชเมื่อออฟไลน์
 * - ไฟล์ static (/_next/static, /vendor = OpenCV/PDF.js, ไอคอน, ฟอนต์): cache-first
 * - สคริปต์ worker (cv-worker.js, detect-worker.js — ชื่อไฟล์คงที่): network-first ได้ตัวใหม่ทันทีที่ออนไลน์
 * - ไฟล์ OCR (tesseract core + ภาษา จาก CDN): cache-first หลังโหลดครั้งแรก → OCR ออฟไลน์ได้
 * เอกสารของผู้ใช้อยู่ใน IndexedDB ไม่ผ่าน service worker และไม่ถูกส่งไปไหน */
const VERSION = 'docscan-v3';
const SHELL = ['/', '/manifest.webmanifest', '/cv-worker.js', '/detect-worker.js', '/vendor/opencv.js', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const cacheFirst = async (req) => {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') (await caches.open(VERSION)).put(req, res.clone());
  return res;
};
const networkFirst = async (req) => {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
    return res;
  } catch {
    return (await caches.match(req)) || (await caches.match('/')) || new Response('ออฟไลน์', { status: 503 });
  }
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (req.mode === 'navigate') { e.respondWith(networkFirst(req)); return; }
    if (/^\/(_next\/static|vendor|icons)\//.test(url.pathname) || /\.(woff2?|png|svg)$/.test(url.pathname)) { e.respondWith(cacheFirst(req)); return; }
    if (/^\/[\w-]+-worker\.js$/.test(url.pathname)) { e.respondWith(networkFirst(req)); return; }
    return;
  }
  // ไฟล์ของ tesseract.js (worker / core wasm / traineddata) จาก CDN
  if (/cdn\.jsdelivr\.net|unpkg\.com|tessdata/.test(url.host + url.pathname)) e.respondWith(cacheFirst(req));
});
