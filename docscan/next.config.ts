import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // repo นี้มีหลายโปรเจกต์ (ERP อยู่ที่ v2/) — ระบุรากของ DocScan ให้ชัด ไม่ให้ Next ไปจับ lockfile ของโปรเจกต์อื่น
  turbopack: { root: path.join(__dirname) },
  outputFileTracingRoot: path.join(__dirname),
  // Next 16 บล็อกไฟล์ dev จาก origin ที่ไม่ใช่ localhost — เปิดให้ 127.0.0.1
  // ทดสอบกล้องบนมือถือผ่าน IP ในวง LAN: เพิ่ม IP ของเครื่องที่รัน dev ลงตรงนี้ (ดู README)
  allowedDevOrigins: ['127.0.0.1', ...(process.env.DEV_ORIGINS ? process.env.DEV_ORIGINS.split(',') : [])],
  async headers() {
    return [
      // service worker ต้องไม่ถูกแคชค้าง ไม่งั้นผู้ใช้ไม่ได้เวอร์ชันใหม่
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
      { source: '/vendor/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=604800' }] }
    ];
  }
};

export default nextConfig;
