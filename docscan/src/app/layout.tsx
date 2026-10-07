import type { Metadata, Viewport } from 'next';
import { Noto_Sans_Thai } from 'next/font/google';
import './globals.css';

// ฟอนต์ถูก self-host ตอน build (ไม่โหลดจาก Google ตอนใช้งาน) — ใช้ออฟไลน์ได้
const thai = Noto_Sans_Thai({ subsets: ['thai', 'latin'], weight: ['400', '500', '600', '700'], variable: '--font-thai', display: 'swap' });

export const metadata: Metadata = {
  title: 'DocScan — ERP SHIPME',
  description: 'สแกนเอกสารด้วยกล้อง ครอบอัตโนมัติ อ่านข้อความไทย/อังกฤษ และส่งออก PDF — เอกสารอยู่ในเครื่องคุณ',
  manifest: '/manifest.webmanifest',
  applicationName: 'DocScan',
  appleWebApp: { capable: true, title: 'DocScan', statusBarStyle: 'default' },
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#ffffff' }, { media: '(prefers-color-scheme: dark)', color: '#111827' }]
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="th" className={thai.variable} suppressHydrationWarning>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
