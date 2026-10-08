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
| X-Ray gate | **No bypass.** Staff wait until drivers report in LINE that every container has passed X-Ray. |
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

## Not built yet (next phase)

- Meeting records (meetings / meeting_jobs): staff goes to the driver or the driver comes to staff, with a meeting time and LINE meeting messages to drivers.
- Route planner for EIR delivery (Google Routes API) and the meeting sequence.
- Scheduled reminders (needs Vercel Cron Pro or Supabase pg_cron; Vercel Hobby runs only once a day).
- Staff logging in through LINE (Rich Menu "งานชิปปิ้ง"). For now staff log in with their ERP username/password.
- Notifying staff via LINE when a driver passes X-Ray or sends photos. For now the page refreshes every 20 seconds.
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
