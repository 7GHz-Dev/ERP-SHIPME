/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // หน้าเว็บพนักงาน/ผู้ดูแลเป็น HTML ล้วนใน public/ — เสิร์ฟที่ / และ /admin ให้เหมือน URL เดิม
  // ผู้ใช้ที่บุ๊กมาร์กไว้จึงไม่ต้องเปลี่ยนลิงก์หลังย้ายมา Next.js
  async rewrites() {
    return [
      { source: '/', destination: '/index.html' },
      { source: '/admin', destination: '/admin.html' },
      // ประสานงานคนขับ: หน้าชิปปิ้ง (มือถือ) และหน้าคนขับ (เปิดใน LINE / LIFF)
      { source: '/staff', destination: '/staff.html' },
      { source: '/partner', destination: '/partner.html' },
      { source: '/driver', destination: '/driver.html' },
      // ตารางขนส่ง (อ่านอย่างเดียว) — เปิดจากหน้าพนักงาน
      { source: '/transport', destination: '/transport.html' }
    ];
  },
  async headers() {
    return [
      // หน้าเว็บต้องไม่ถูก cache ค้าง ไม่งั้นแก้ฟอร์มแล้วพนักงานยังเห็นของเก่า
      { source: '/:page(index|admin|staff|driver|partner|transport).html', headers: [{ key: 'cache-control', value: 'no-cache' }] }
    ];
  }
};

export default nextConfig;
