# Prompt for a browser-capable assistant

Copy everything in the block below and give it to an assistant that can drive
a browser and is already signed in to the Meta Developer account.

It is written to be self-contained: it states the goal, the exact evidence that
the problem exists, what has already been ruled out, and — importantly — what
it must **not** do with credentials.

---

```text
You are operating the Meta Developer dashboard for a WhatsApp Cloud API
integration. I need you to finish the configuration and report back precisely.

## Context

A WhatsApp support-routing system is deployed and working. Incoming webhooks
are processed correctly end to end — verified by sending signed test payloads
that produced conversations, agent assignment and sheet rows.

The ONE thing that does not work: Meta has never delivered a real message
webhook. Evidence from the server's nginx access log:

  - 2 GET verification requests from genuine Meta IPs (31.13.127.44,
    173.252.101.1) -> both returned HTTP 200, so the callback URL and verify
    token are correct and Meta can reach the server.
  - 0 POST requests from any Meta IP, despite real WhatsApp messages being
    sent to the test number.

Already confirmed correct via the Graph API, so do NOT re-do these:
  - App-level webhook subscription exists, object = whatsapp_business_account,
    active = true, field "messages" subscribed, callback URL correct.

## Identifiers

  App ID:            1085722887492140
  App name:          customer support
  Business ID:       1561283925739302
  Test phone number: +1 555-670-4231
  Phone number ID:   1385581811295002
  Callback URL:      https://72-61-181-1.sslip.io/webhook/whatsapp/webhook
  Recipient to test: +962 78 132 4923

Start here:
https://developers.facebook.com/apps/1085722887492140/

## Tasks, in order

1. APP MODE
   Find whether the app is in Development or Live mode (top of the dashboard,
   near the app name).
   Meta's own warning on the webhook configuration page states: "No production
   data, including from app admins, developers or testers, will be delivered
   unless the app has been published."
   If it is in Development, try to switch it to Live / publish it.
   If publishing is blocked, report EXACTLY which requirements Meta lists as
   outstanding (business verification, privacy policy URL, app icon, etc.).
   Do not attempt to satisfy those requirements yourself — just report them.

2. WABA ID
   Go to WhatsApp -> API Setup. Report the "WhatsApp Business Account ID"
   shown there. This is a public identifier, safe to report.

3. WABA SUBSCRIPTION
   This is a SEPARATE subscription from the app-level one, and is the second
   candidate cause. In WhatsApp -> Configuration, confirm the app is
   subscribed to this WhatsApp Business Account. If there is a "Subscribe" or
   "Manage" control that is not enabled, enable it. Report what you found
   before changing anything.

4. WEBHOOK FIELDS
   In WhatsApp -> Configuration -> Webhook fields -> Manage, confirm the
   "messages" field shows as Subscribed. Report its exact state. If there is a
   "Test" button beside it, press it — this sends a sample payload and is the
   single most useful diagnostic. Report whether pressing it appeared to
   succeed.

5. ALLOWED RECIPIENTS
   In WhatsApp -> API Setup, in the "To" field, open "Manage phone number
   list" and confirm +962 78 132 4923 is present and verified. Add it if it is
   missing. Report the list's contents.

6. PHONE NUMBER STATE
   In WhatsApp Manager, report the test number's Status and Quality rating,
   and whether any warning or restriction is shown on the account.

## Security rules — follow these strictly

- Do NOT copy, quote, screenshot or report the App Secret, any access token,
  or any password. They are already configured on the server.
- Public identifiers (App ID, WABA ID, Phone Number ID, phone numbers) are
  fine to report.
- Do NOT regenerate or reset the App Secret. Doing so would break the running
  integration.
- Do NOT delete or disconnect any phone number.
- Do NOT change the callback URL or the verify token — both are already
  correct and verified working.

## What to report back

  1. App mode before and after (Development / Live), and if it could not be
     published, the exact list of blockers Meta showed.
  2. The WABA ID.
  3. Whether the WABA was already subscribed to the app, and whether you
     changed it.
  4. The exact state of the "messages" webhook field.
  5. Whether you pressed Test, and what happened.
  6. The allowed-recipient list.
  7. The test number's status and quality rating.
  8. Anything Meta displayed that looked like a warning, restriction or
     required action — quoted exactly.

Be precise about what you observed versus what you inferred. If a control was
missing or greyed out, say so rather than guessing why.
```

---

## While that runs

Watch the server from your own terminal. It labels each request by source, so
a real Meta delivery cannot be confused with a local test:

```bash
bash scripts/testing/watch-live.sh
```

A `[META] POST` line is the proof that the integration delivers. Everything
recorded before now came from `[SIMULATED]` requests.

## What each outcome means

| Result of the Test button | Conclusion |
|---|---|
| `[META] POST … 200` appears | Delivery works — the only remaining issue is that real messages need the app published |
| Nothing appears at all | The subscription is not actually reaching this app — task 3 is the cause |
| `[META] POST … 401` | The app secret on the server does not match this app |

## The values worth sending back to me

Only these, and none of them are secret:

- WABA ID
- App mode (Development or Live), plus any publishing blockers
- Whether the Test button produced a `[META]` line
