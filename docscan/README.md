# DocScan

A web app (PWA) for scanning documents on a phone. It is deployed separately from the ERP. Shipping staff use it to photograph inspection documents and combine the photos into a single PDF. The PDF is attached to the settlement under **"หลักฐานการตรวจปล่อย"**.

- Images, OCR and PDFs are all processed on the device. Documents are stored in IndexedDB in the browser.
- **Edge detection** (`public/detect-worker.js`) is plain JavaScript in its own worker, so it works the moment the camera opens without waiting for OpenCV.
  - It finds edges in brightness and in two color channels, then uses Hough lines plus a 4-sided scoring step. This works on backgrounds close to the paper color, such as white paper on a white or cream table or light wood.
  - It costs about 5 ms per frame on a laptop and runs about 16 times per second.
- OpenCV (`public/cv-worker.js`) is used only for perspective correction and filters, in a separate worker. The camera keeps detecting the next page while the previous one is still saving.
- **A file leaves the device only when the user taps "ส่งเข้าใบปิดบัญชี" or "ส่งไปปิดบัญชี".** Signatures are never uploaded.
- Stack: Next.js 16, React 19, TypeScript, Tailwind v4, Dexie, OpenCV.js (Web Worker), tesseract.js, pdf-lib, pdfjs-dist, fflate.

## Running

```bash
npm install          # also copies opencv.js and pdf.worker into public/vendor
npm run dev          # http://localhost:3000
npm run build && npm start
npm run typecheck
```

To test on a phone over the LAN in dev mode, allow the origin first: `DEV_ORIGINS=192.168.1.20 npm run dev`. The camera needs HTTPS or localhost. In dev mode on a phone, use the "นำเข้ารูป" import button instead of the camera.

## Scanning

- **Auto capture** (on by default): once the edges are found and the phone is held still for about 0.45 s, it takes the photo.
- **Confirm frame** (off by default):
  - Off: crops to the detected frame, saves in the background, and waits for the next page straight away. It detects a page change when the document leaves the screen or its contents change, and it won't capture the same page twice. Crops can be fixed later with the "ครอบ" button.
  - On: the crop adjustment screen opens after every photo.
- Both settings can be changed on the camera screen and under Settings → การสแกน. The same setting also applies to importing photos.
- If the ratio is within ±10% of A4, it is corrected to exactly 1:1.414 to compensate for camera tilt.

## Connecting to the ERP

1. Open the settlement page and choose an inspection date. Under **4) หลักฐานการตรวจปล่อย**, tap **"สแกนเอกสารด้วย DocScan"**.
2. The ERP issues a ticket (signed with HMAC, valid for 2 hours, tied to one employee and one inspection date). It then opens DocScan in a new tab at `?erp=<ticket>`.
3. Take photos of every page, then tap **"ส่งเข้าใบปิดบัญชี"**. The app builds a PDF (150 dpi), uploads it directly to Supabase Storage through a signed URL, and the ERP records it in `inspection_files`.
4. Tap "กลับไปหน้าปิดบัญชี". The tab closes and the settlement page refreshes its file list. A new settlement cannot be saved without this file.

**Opening DocScan directly:** on the document page, tap **"ส่งไปปิดบัญชี"**, enter your ERP username and password (required every time), choose a claim from the dropdown, then tap "แนบไฟล์เข้าใบปิดบัญชี".
- The ERP (`scanLogin`) checks the password without creating a login session. It returns the latest 40 claims, each with its own ticket valid for 30 minutes.
- The app remembers only the username, never the password.

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
