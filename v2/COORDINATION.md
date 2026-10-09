# Driver coordination via LINE OA: implementation status

Based on `SHIPME_Driver_Coordination_MASTER_BUILD_PROMPT.md` v2.0, built inside the existing ERP (v2).

## Decisions from the business owner (2026-10-09)

| Topic | Decision |
|---|---|
| Where to build | Inside the existing ERP: staff page `/staff`, driver page `/driver` (LIFF) |
| LINE OA | **Not set up yet.** The system runs in DEMO MODE until the 4 LINE values are configured. |
| Maps | Google Maps (`GOOGLE_MAPS_BROWSER_KEY`) |
| Meeting points | Managers pin them in Settings → จุดนัดพบ (LINE) |
| Job completion | **Closes immediately** once the driver has sent the EIR photo and the seal photo. No staff review step. |
| X-Ray gate | **No bypass.** Every container must pass before EIR. (Updated 2026-10-09: the driver presses "X-Ray แล้ว" and **shipping staff record the result** — passed / needs more inspection.) |
| Photo / location retention | Kept indefinitely |
| SMS | Fallback channel only, for drivers not yet linked to LINE. LINE is the main channel. |

## How the spec maps to this system

- **Staff batch:** rows in a manager-confirmed plan (`job_plans` / `job_plan_items`), for 1 shipping user on 1 inspection date. No re-import is needed.
- **Status tracking:** `job_steps` holds per-container status with 1 row per container. `job_events` keeps the full event history.
- **Location requests:** `location_requests` / `location_reports`, split by `phase` (CARD_PICKUP / EIR_HANDOVER).
- **Drivers:** `drivers` is built automatically from phone numbers in the plan. A LINE account is linked with a one-time code (`driver_link_invites`).
- **LINE messages:** `line_outbox` stores every message before sending, with a retry key to prevent duplicates. `line_webhook_events` prevents duplicate webhook processing.
- **Photos and meeting points:** `evidence_files` holds the EIR and seal photos. `meeting_points` holds the approved meeting points.
- **Access control:** single tenant, no RLS. All authorization is checked server-side:
  - A shipping user sees only their own batch.
  - A driver acts only on their own containers.
  - Admins and managers can see every batch.

## Verified working (tested 2026-10-09 against the real database with temporary data, all deleted afterwards)

- Dashboard: builds the driver registry and status rows. Another staff member gets 0 rows for someone else's batch.
- Round-1 location request:
  - 3 containers / 2 drivers = 2 messages.
  - Unlinked drivers with no SMS available are reported as "failed", not as success.
  - A double tap is skipped (10-minute cooldown).
- Driver auth via request code (fallback / DEMO), session HMAC. A bad session is rejected.
- Location reports:
  - A driver cannot report on another driver's request.
  - When round 2 starts, all round-1 requests close (`request_expired`), and round-1 coordinates are not counted for round 2.
- Steps run in strict order:
  - Pick-up before a card → `card_first`.
  - Driver B acting on driver A's container → `forbidden`.
  - Another staff member recording a card handover → `forbidden`.
- X-Ray gate:
  - At 2/3 passed, round 2, staff EIR handover, and driver EIR receipt are all blocked (`XRAY_BATCH_NOT_READY`, with the blocking containers listed).
  - At 3/3, round 2 opens and creates new requests.
- Completion:
  - Before EIR receipt → `eir_first`.
  - No photos → `photos_required`.
  - EIR photo only → missing seal.
  - A photo key from another container or another type → `bad_key`.
  - With both photos the container closes, and other containers stay open.
- LINE link codes: one use only (a second use → `invite_invalid`). A staff member cannot issue codes for drivers outside their own jobs.
- Meeting points: saving and editing work. A missing name or out-of-range coordinates are rejected.
- Screenshots reviewed: `/staff` (plan / map / status / more) and `/driver` (timeline and photo slots).

## Verified on real LINE OA (2026-10-09)

- The 4 LINE values are set in Vercel and the system is in LIVE mode (LIFF ID 2011938705-XKuNdvJP).
- The business owner tested the whole flow on a real phone and it passed: link LINE + add friend → round-1 location request via LINE → share location in LIFF → steps → EIR + seal photos.

- Google Maps (`GOOGLE_MAPS_BROWSER_KEY`) is set; a test load of Maps JavaScript API from the production domain succeeded (Thai map tiles, no auth error).

## DEMO only (not real yet)

- ~~LINE OA~~ is now LIVE (see above). The "ผูกแบบทดลอง" (demo link) button only appears in DEMO mode.

## Phase 2 (built and deployed 2026-10-09)

1. **Meetings (card handover / EIR handover)**
   - Staff choose who travels: staff goes to the driver, or the driver comes to a meeting point. They set the time and the containers, then a meeting card goes out by LINE (SMS as fallback).
   - Drivers tap "รับทราบนัด" (accept) or "ขอเลื่อน" (ask to reschedule). A reschedule request notifies staff right away.
   - Rules:
     - Staff cannot have two meetings at different places within 4–5 minutes of each other (`staff_overlap`).
     - Replacing a meeting the driver already accepted requires confirmation (`meeting_confirmed_exists`).
     - The old meeting is cancelled.
     - Once every container in a meeting is handed over, the meeting becomes MET.
     - An EIR meeting can't be scheduled before every container has passed X-Ray.
2. **Staff link their own LINE:** a signed link valid for 30 minutes plus an ID token. Notifications have 3 levels:
   - **Important:** all drivers sent their location, all containers passed X-Ray, a problem reported, a reschedule request, all jobs completed.
   - **All:** each location report, each X-Ray pass, each photo upload, each meeting accepted.
   - **Off.**
3. **Rich Menu:** the "📲 ติดตั้ง Rich Menu" (install Rich Menu) button under Settings → Connection check:
   - Driver menu (default for the OA): งานของฉัน / ส่งตำแหน่ง / ช่วยเหลือ (my jobs / send location / help).
   - Staff menu (linked per person when they link LINE): งานชิปปิ้ง / แผนที่ / สถานะงาน (shipping jobs / map / job status).
4. **Route planning (card + EIR):**
   - Chooses per driver whether staff goes to them or they come to the nearest meeting point, then orders the stops (nearest neighbour + 2-opt) to minimise total travel plus waiting time for everyone.
   - Reports FEASIBLE; it never claims the result is optimal.
   - Confirming the plan creates meetings in order and sends them by LINE.
   - Uses Google Routes API if `GOOGLE_ROUTES_SERVER_KEY` is set (and draws the real road polyline). Without it, times are estimated from distance (straight line × 1.35 at 30 km/h), labelled "ประมาณการ" (estimate), and no polyline is drawn.
   - If a key is set but the call fails, it shows "คำนวณไม่ได้" (can't calculate) and lets staff choose the estimate instead.

Tested against the real DB with temporary data in DEMO mode (deleted afterwards):
- Meetings: overlap check, permissions, accept/reschedule, replacement, MET.
- Routes: auto mode / staff goes to everyone, X-Ray gate, confirm once only.
- All 8 notification types arrive.

Screenshots taken on the real domain (Google Maps rendered with the real key): route plan + map, meeting form, the More tab, and the driver meeting card.

## Automatic reminders (2026-10-09)

- Supabase `pg_cron` + `pg_net`: job `shipme-coord-reminders` runs every 5 minutes and calls `POST /api/cron/coord-reminders` with `Authorization: Bearer <CRON_SECRET>`.
  - First run verified: 03:00 UTC, HTTP 200.
- Reminds drivers by LINE, once per item, 06:00–21:00 Bangkok time only:
  - location requests: at 10 / 20 minutes
  - meetings not yet accepted
  - X-Ray: 90 minutes after pick-up
  - EIR receipt: 15 minutes after staff handover
  - closing photos: 60 minutes after EIR receipt
- When a request expires without a reply, staff get a notification.
- Check runs with: `select * from cron.job_run_details order by start_time desc limit 5;`
- Stop with: `select cron.unschedule('shipme-coord-reminders');`
- `GOOGLE_ROUTES_SERVER_KEY` is set in Vercel. Verify with the "ตรวจ LINE OA + Google Routes" button in Settings.

## Flow update (2026-10-09, round 3)

Per-container steps on the driver page (6 steps):

| # | Driver does | Who records |
|---|---|---|
| 1 | Send location (**one tap**, sent immediately) + get the pickup card | Staff records card handover / driver confirms |
| 2 | Pick up the container + photograph **truck front, truck rear, container seal** → "ส่งงานรับตู้" (submit pickup) | Driver (all 3 photos required; locked after submit) |
| 3 | "นำทางไปเครื่อง X-Ray" (navigate to X-Ray machine) → after the scan, "X-Ray แล้ว" | Driver (`xrayStatus = scanned`) |
| 4 | Wait for the X-Ray result | **Staff** record passed / needs more inspection per container or per BL (`coordXrayResult`); the driver gets a LINE message |
| 5 | Receive the outbound EIR per the meeting → "ได้รับ EIR แล้ว" (EIR received) | Staff record the handover, then the driver confirms |
| 6 | EIR card + seal photos → "ยืนยันจบงาน" (confirm completion) | Driver |

- **One-tap location:**
  - Tapping "ส่งตำแหน่งตอนนี้" (send location now) in the LINE message, the Rich Menu, or on the page gets the coordinates and sends them immediately.
  - It tries high accuracy for 12 s first, then falls back to the fast method.
  - If location access is refused, it shows how to allow it and offers a button to notify staff.
- **X-Ray machine:** pinned in Settings → จุดนัดพบ / X-Ray, type "เครื่อง X-Ray".
  - The driver page picks the point whose "ท่า" (port) matches the container's port; otherwise it uses the first point.
  - `meeting_points.kind` = MEETING | XRAY. Meetings and route planning use MEETING points only.
- **Driver page:** a "ทำอะไรตอนนี้" (what to do now) card is always on top, showing the step number and what to tap. It is clickable and scrolls to the container.
  - With no jobs, it explains what to wait for, plus all 6 steps.
- **Staff dashboard:**
  - Pipeline of 7 steps, each with a count. Tapping a step filters the list.
  - Each BL card shows its containers with action buttons for that BL: แจกการ์ดแล้ว (card handed) / ผล X-Ray ผ่าน (X-Ray passed) / ตรวจเพิ่ม (needs more inspection) / ส่งมอบ EIR แล้ว (EIR handed over).
  - Filters: ต้องทำ (to do) / ยังไม่จบ (not finished).
  - The status tab records items per container or a whole BL at once (BL checkbox).
  - Event history is shown in Thai.
- **Reminders:**
  - Card received but pickup not submitted (90 min).
  - Pickup submitted but "X-Ray แล้ว" not pressed (90 min).
- **Tested:** 31 checks against the real DB with temporary 2099 data (all deleted), plus screenshots of both pages.

## Not built yet

- Reports / CSV for this flow.

## LINE OA setup (when the account is ready)

1. At https://developers.line.biz, create one Provider.
2. Under that Provider, create a **Messaging API channel** linked to the company OA:
   - Copy the Channel secret → `LINE_CHANNEL_SECRET`.
   - Issue a Channel access token (long-lived) → `LINE_CHANNEL_ACCESS_TOKEN`.
   - Webhook URL = `https://<domain>/api/line/webhook`. Turn on "Use webhook" and press Verify.
3. Under the **same Provider**, create a **LINE Login channel**:
   - Channel ID → `LINE_LOGIN_CHANNEL_ID`.
   - Add a LIFF app: Endpoint URL = `https://<domain>/driver`, Scope = `openid profile`, Size = Full, and set Add friend option = **On (Aggressive)** so drivers add the OA as a friend.
   - LIFF ID → `LIFF_ID`.
4. Google Cloud: enable the Maps JavaScript API, create an API key restricted by HTTP referrer to the domain → `GOOGLE_MAPS_BROWSER_KEY`.
5. Set these in Vercel (Production), redeploy, then test with one real phone:
   - Link LINE.
   - Round-1 request.
   - Share location.
   - Steps through to photos.
