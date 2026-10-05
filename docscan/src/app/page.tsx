'use client';
import dynamic from 'next/dynamic';

// ทั้งแอปทำงานฝั่งเบราว์เซอร์ (IndexedDB / กล้อง / Web Worker) — ไม่ render ฝั่งเซิร์ฟเวอร์
const App = dynamic(() => import('@/components/App'), {
  ssr: false,
  loading: () => <div className="flex min-h-dvh items-center justify-center text-muted">กำลังเปิด DocScan…</div>
});

export default function Page() { return <App />; }
