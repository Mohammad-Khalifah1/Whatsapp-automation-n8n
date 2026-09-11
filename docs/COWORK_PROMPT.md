# Prompt for a browser-capable assistant (cowork)

Give the block below to an assistant that can drive a browser and is signed in
to the Meta Developer account. It is written so the assistant fixes what it
can on Meta's side, and reports back exactly what it could not — in a form
that can be acted on directly.

---

```text
You are finishing the Meta-side configuration for a WhatsApp customer-support
system. The server side is built, deployed and verified. Your job is to fix
what is broken in the Meta dashboard, and to report precisely what you could
not fix.

═══════════════════════════════════════════════════════════════════
WHAT ALREADY WORKS — do not re-do or "improve" any of this
═══════════════════════════════════════════════════════════════════

  - Server deployed, HTTPS with a valid certificate, healthy.
  - Callback URL and verify token registered and CONFIRMED by Meta:
    two GET verification requests from genuine Meta IPs (31.13.127.44 and
    173.252.101.1) both returned HTTP 200.
  - App-level webhook subscription confirmed via the Graph API:
    object = whatsapp_business_account, active = true, field "messages"
    subscribed, callback URL correct.
  - App Secret configured on the server; signature verification tested
    (valid signature accepted, forged and unsigned both rejected 401).
  - Google Sheets connected; conversations, agent assignment and message
    logging all verified working with signed test payloads.

═══════════════════════════════════════════════════════════════════
THE ONE PROBLEM
═══════════════════════════════════════════════════════════════════

Meta has never delivered a single message webhook.

  POST requests from Meta IPs:  0
  GET verification from Meta:   2  (both 200)

Real WhatsApp messages were sent to the test number and produced nothing.
Since the callback URL demonstrably works, the cause is on Meta's side. The
two candidates are listed as tasks 1 and 2 below.

═══════════════════════════════════════════════════════════════════
IDENTIFIERS
═══════════════════════════════════════════════════════════════════

  App ID:             1085722887492140
  App name:           customer support
  Business ID:        1561283925739302
  Test phone number:  +1 555-670-4231
  Phone number ID:    1385581811295002
  Callback URL:       https://72-61-181-1.sslip.io/webhook/whatsapp/webhook
  Number to receive:  +962 78 132 4923

  Start at: https://developers.facebook.com/apps/1085722887492140/

═══════════════════════════════════════════════════════════════════
TASKS — fix what you can, report what you cannot
═══════════════════════════════════════════════════════════════════

TASK 1 — App mode  [most likely cause]
  Meta's own notice on the webhook page says: "No production data, including
  from app admins, developers or testers, will be delivered unless the app
  has been published."
  Find the app's mode (Development or Live), shown near the app name.
  ACTION: if it is in Development, publish it / switch it to Live.
  IF BLOCKED: report the exact list of outstanding requirements Meta shows
  (business verification, privacy policy URL, app icon, category, and so on).
  Do not try to satisfy those yourself — just list them verbatim.

TASK 2 — WABA subscription  [second candidate]
  This is a DIFFERENT subscription from the app-level one already confirmed.
  The WhatsApp Business Account itself must be subscribed to this app.
  Go to WhatsApp -> Configuration.
  ACTION: if the app is not subscribed to the WABA, subscribe it.
  Report what the state was BEFORE you changed anything.

TASK 3 — WABA ID  [needed by the server]
  WhatsApp -> API Setup. Report the "WhatsApp Business Account ID".
  Public identifier, safe to report.

TASK 4 — Permanent access token  [needed to send replies]
  The server can currently RECEIVE but not SEND, because it has no access
  token. A temporary token is useless — it dies in 24 hours and would take
  the system down.
  ACTION: create a System User token at
  https://business.facebook.com/settings -> Users -> System Users
    - add a System User with role Admin (or reuse one)
    - Add Assets -> the WhatsApp Business Account -> Full control
    - Generate New Token -> select app "customer support"
    - permissions: whatsapp_business_messaging AND whatsapp_business_management
    - expiry: Never
  DO NOT paste the token into your reply. Instead:
    - confirm it was created
    - report its length in characters and its first 4 characters only
    - tell the operator to enter it themselves by running, in their terminal:
        ssh root@72.61.181.1 -t "bash /opt/n8n-1/setup-meta.sh"

TASK 5 — Allowed recipients
  WhatsApp -> API Setup -> the "To" field -> Manage phone number list.
  ACTION: ensure +962 78 132 4923 is present and verified; add it if missing.
  Report the resulting list.

TASK 6 — Trigger a test delivery  [the decisive diagnostic]
  WhatsApp -> Configuration -> Webhook fields -> Manage.
  Confirm "messages" shows as Subscribed, and press the Test button beside it
  if one exists.
  Report whether it reported success.

TASK 7 — Phone number health
  In WhatsApp Manager, report the test number's Status and Quality rating,
  and quote any warning, restriction or required action shown anywhere on the
  account or app.

═══════════════════════════════════════════════════════════════════
SECURITY — follow exactly
═══════════════════════════════════════════════════════════════════

  DO NOT report, quote, screenshot or transcribe:
    - the App Secret
    - any access token (see task 4 for the correct handling)
    - any password

  DO NOT regenerate or reset the App Secret. It is configured on the server
  and resetting it breaks the running integration immediately.

  DO NOT change the Callback URL or the Verify token. Both are already
  correct and verified working; changing either takes the system offline.

  DO NOT delete or disconnect any phone number. This cannot be undone.

  Public identifiers are fine to report: App ID, WABA ID, Phone Number ID,
  phone numbers, app mode, subscription states.

═══════════════════════════════════════════════════════════════════
REPORT BACK IN THIS FORMAT
═══════════════════════════════════════════════════════════════════

  1. App mode before / after:          ...
     If publishing was blocked, the exact requirements listed:
       - ...

  2. WABA subscribed to the app?  before: ...   after: ...

  3. WABA ID:                          ...

  4. System User token created?        yes / no
     Length: ... characters, starts with: ....
     (do NOT include the token itself)
     If blocked, the exact reason:     ...

  5. Allowed recipients now:           ...

  6. Test button pressed?              yes / no — result: ...

  7. Phone number status / quality:    ...
     Warnings or required actions, quoted exactly:
       - ...

  8. Anything you changed that is not listed above:
       - ...

Distinguish clearly between what you OBSERVED and what you INFERRED. If a
control was missing, greyed out, or behaved unexpectedly, say so plainly
rather than guessing the reason.
```

---

## What the operator does while this runs

Watch the server. The watcher tags each request by source, so a genuine Meta
delivery cannot be mistaken for a local test:

```bash
bash scripts/testing/watch-live.sh
```

| What appears | Meaning |
|---|---|
| `[META] POST … 200` | Delivery works. Any remaining gap is only the app mode |
| nothing at all | The subscription is not reaching this app — task 2 is the cause |
| `[META] POST … 401` | The app secret on the server does not match this app |

## Current state, for reference

| Piece | State |
|---|---|
| Webhook receive → parse → conversation → assignment → sheet | Working, verified |
| Signature verification | Working, verified |
| Google Sheets read/write | Working, verified |
| `META_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`, `GOOGLE_SHEET_ID`, `META_PHONE_NUMBER_ID` | Set |
| `META_ACCESS_TOKEN` | **Missing** — task 4 |
| `META_WABA_ID` | **Missing** — task 3 |
| Real message delivery from Meta | **Not working** — tasks 1 and 2 |
| Workflows 1, 2, 3, 6 | Published and active |
| Workflows 4, 5, 7, 8 | Built, held back until the access token exists |
