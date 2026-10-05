# DocScan

A web app (PWA) for scanning documents on a phone. It is deployed separately from the ERP. Shipping staff use it to photograph inspection documents and combine the photos into a single PDF. The PDF is attached to the settlement under **"หลักฐานการตรวจปล่อย"**.

- Images, OCR and PDFs are all processed on the device. Documents are stored in IndexedDB in the browser.
- **A file leaves the device only when the user taps "ส่งเข้าใบปิดบัญชี".** Signatures are never uploaded.
- Stack: Next.js 16, React 19, TypeScript, Tailwind v4, Dexie, OpenCV.js (Web Worker), tesseract.js, pdf-lib, pdfjs-dist, fflate.

## Running

```bash
npm install          # also copies opencv.js and pdf.worker into public/vendor
npm run dev          # http://localhost:3000
npm run build && npm start
npm run typecheck
```

To test on a phone over the LAN in dev mode, allow the origin first: `DEV_ORIGINS=192.168.1.20 npm run dev`. The camera needs HTTPS or localhost. In dev mode on a phone, use the "นำเข้ารูป" import button instead of the camera.

## Connecting to the ERP

1. Open the settlement page and choose an inspection date. Under **4) หลักฐานการตรวจปล่อย**, tap **"สแกนเอกสารด้วย DocScan"**.
2. The ERP issues a ticket (signed with HMAC, valid for 2 hours, tied to one employee and one inspection date). It then opens DocScan in a new tab at `?erp=<ticket>`.
3. Take photos of every page, then tap **"ส่งเข้าใบปิดบัญชี"**. The app builds a PDF (150 dpi), uploads it directly to Supabase Storage through a signed URL, and the ERP records it in `inspection_files`.
4. Tap "กลับไปหน้าปิดบัญชี". The tab closes and the settlement page refreshes its file list. A new settlement cannot be saved without this file.

Environment variables:

| Where | Variable | Purpose |
|---|---|---|
| DocScan | `NEXT_PUBLIC_ERP_API` | ERP API URL (default `https://erp-shipme-ovmf-theta.vercel.app/api`) |
| ERP (v2) | `DOCSCAN_URL` | DocScan URL that the settlement page opens |
| ERP (v2) | `SCAN_TICKET_SECRET` | Key for signing tickets (optional; derived from `DATABASE_URL` if unset) |

## Known limitations

- iOS Safari has no flashlight (torch) control, so the torch button only appears on supported devices.
- HEIC files open only in browsers that can decode them (Safari). Elsewhere the app asks for JPG/PNG.
- OCR downloads its language files (Thai/English) the first time it is used, so the first run needs internet.
- Data lives in this browser only. Clearing site data deletes it, so use Settings → backup (.docscan) to keep a copy.
