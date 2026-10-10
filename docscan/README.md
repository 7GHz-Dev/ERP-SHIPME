# DocScan

A web app (PWA) for scanning documents on a phone. It is deployed separately from the ERP. Shipping staff use it to photograph inspection documents and combine the photos into a single PDF. The PDF is attached to the settlement under **"หลักฐานการตรวจปล่อย"**.

- Images, OCR and PDFs are all processed on the device. Documents are stored in IndexedDB in the browser, or on the ERP's storage when the user picks **"ให้ระบบเก็บ"** (see [Storage location](#storage-location)).
- **Edge detection** (`public/detect-worker.js`) is plain JavaScript in its own worker, so it works the moment the camera opens without waiting for OpenCV.
  - It finds edges in brightness and in two color channels, then uses Hough lines plus a 4-sided scoring step. This works on backgrounds close to the paper color, such as white paper on a white or cream table or light wood.
  - It costs about 5 ms per frame on a laptop and runs about 16 times per second.
- OpenCV (`public/cv-worker.js`) is used only for perspective correction and filters, in a separate worker. The camera keeps detecting the next page while the previous one is still saving.
- **In "เก็บในเครื่องนี้" mode, a file leaves the device only when the user taps "ส่งเข้าใบปิดบัญชี" or "ส่งไปปิดบัญชี".** Signatures are never uploaded.
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

## Storage location

Settings → **ที่เก็บเอกสาร** has two options. The choice applies to new documents. Existing documents can be moved one at a time from their menu, or all at once from Settings.

- **เก็บในเครื่องนี้** (default): everything stays in IndexedDB, as before.
- **ให้ระบบเก็บ**: for phones that are short on space.
  - The user signs in once with their ERP username and password. The ERP returns a storage key, an HMAC token valid for 180 days.
  - The key only gives access to `docscan/<username>/` in Supabase Storage. It is not an ERP session.
  - Changing the password or disabling the account invalidates the key immediately.

How "ให้ระบบเก็บ" works (`src/lib/cloud.ts`, server side in `v2/src/lib/docscan-cloud.ts`):

- Each page has 4 images: original, cropped, final and thumbnail. They upload in the background straight to Supabase through signed URLs.
  - Every upload gets a new file name, so a stale CDN copy is never served.
  - Once all pages are uploaded, `doc.json` is uploaded, files no longer in use are deleted, and the original, cropped and final images are removed from the phone. Only the thumbnail and metadata stay.
- Opening a document downloads the final images while it is open. The original and cropped images download only when the user taps crop, filter or markup.
  - After the document is closed, the next sync removes them from the phone again.
  - The document being scanned or opened is never cleaned up mid-use.
- Scanning works offline. Pages wait in the phone and upload once the internet is back.
- New phone, or browser data cleared: sign in again and the app pulls the document list back from `doc.json` (Settings → ดึงรายการจากระบบ).
- Deleting a document permanently, or moving it back to the phone, deletes its files from the server.
- On the phone, each page's server file references live in the `cloudRefs` table, kept apart from the images.
  - Reason: Safari copies every Blob in a row to temporary files on each write. On a full phone, writing a page row that holds full-size images fails with "Error preparing Blob/File data to be stored in object store".
  - Removing images from the phone sets those fields to `null`, so the row written back holds only the thumbnail.
- When the phone is full:
  - An image downloaded from the system that can't be saved is kept in memory while the document is open.
  - A new page that can't be saved uploads to the system right away (`storeRemotely`).
- No database table is needed on the server. Everything lives in Storage:
  - `docscan/<user>/<docId>/<random>.jpg`
  - `docscan/<user>/<docId>/doc.json`
  - `docscan/<user>/_meta/folders.json`

Test the whole path: `cd v2 && npx tsx scripts/smoke-docscan-cloud.mts <url> <user> <pass>` (create a temporary account with `scripts/temp-user.mts`).

## Known limitations

- iOS Safari has no flashlight (torch) control, so the torch button only appears on supported devices.
- HEIC (iPhone photos): picking from the photo library makes iOS convert to JPG automatically (`accept="image/*"`). If the browser still can't open a HEIC file (Chrome, Android), the app loads the `heic-to` decoder (libheif, ~3 MB). It loads only when a HEIC file shows up, and the service worker caches it after the first time.
- OCR downloads its language files (Thai/English) the first time it is used, so the first run needs internet.
- In "เก็บในเครื่องนี้" mode, data lives in this browser only. Clearing site data deletes it, so use Settings → backup (.docscan) to keep a copy. In "ให้ระบบเก็บ" mode, documents can be pulled back from the server.
- Documents stored on the server need internet to open (except the one currently open). Designed for one phone per account: using the same documents on two phones at once can make the last sync overwrite the other's changes.
