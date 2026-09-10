# Meta WhatsApp Cloud API Setup

Everything needed on Meta's side to connect this system to a real WhatsApp
business number.

**Sources.** All API specifics below were verified against Meta's official
documentation on **2026-09-09**:

- [Cloud API webhook components](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components)
- [Webhooks getting started](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)
- [Messages reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages)
- [Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog/)
- [Pricing](https://developers.facebook.com/docs/whatsapp/pricing)

Meta changes this platform regularly. Re-check these pages rather than trusting
a tutorial — including this one.

---

## What you need before starting

| Requirement | Notes |
|---|---|
| A Meta (Facebook) account | Personal account used to access the developer portal |
| A Meta Business account | Created during onboarding if you do not have one |
| A phone number | **Must not currently be registered on WhatsApp** — not on the normal app, not on WhatsApp Business app. If it is, delete that account first and wait |
| A public HTTPS endpoint | Meta will not call `http://` or `localhost`. See [SETUP.md](SETUP.md#step-9--expose-the-webhook-to-meta) |

> **The phone number requirement is the most common blocker.** If the number is
> already on WhatsApp you must delete the existing account from within the app
> (*Settings → Account → Delete my account*) and then wait before registering it
> with the Cloud API. Consider using a dedicated number.

### Which WhatsApp account type do you need?

Three different things are routinely confused:

| | What it is | Role here |
|---|---|---|
| **WhatsApp** | The regular consumer app | Not used. A number on it must be freed first |
| **WhatsApp Business App** | A separate free app for small businesses | Optional — but **required** if you want Coexistence |
| **WhatsApp Business Platform (Cloud API)** | Not an app — the API this project calls | Always required |

**You do not need a "Business account" to use the Cloud API.** You need a phone
number that is not registered on any WhatsApp, plus a Meta *Business* account
(a Business Manager profile — a different thing from the WhatsApp app).

**Two viable paths:**

| | Path A — API only | Path B — Coexistence |
|---|---|---|
| Number must be | Free of any WhatsApp | Registered on the **Business App** (v2.24.17+) |
| Personal WhatsApp account | Must be deleted | **Not eligible at all** |
| Agents reply from | Sheet (workflow 7) or API (workflow 4) | The Business App **and** sheet/API |
| Reply latency | ≤ 60 s via the sheet | **Instant**, with native push notifications |
| App maintenance | None | Open the app every 13 days |

Path B is generally the better experience for a real support team — agents work
in an app they already know and every reply is still tracked. It requires
converting the number to the WhatsApp Business App first (free, in-app, keeps
existing chats). See [COEXISTENCE.md](COEXISTENCE.md).

> **There is no reverse coexistence.** Once a number is API-only, going back
> means abandoning the API. Use a dedicated business number.

Meta provides a **free test number** that can message up to 5 pre-approved
recipients. Use it for the first end-to-end test — it needs no phone number of
your own and costs nothing.

---

## Step 1 — Create the app

1. Go to <https://developers.facebook.com/apps>.
2. **Create App** → app type **Business**.
3. Name it, and link it to your Business account.
4. On the app dashboard, find **WhatsApp** and click **Set up**.

You now have a WhatsApp Business Account (WABA) and a test phone number.

---

## Step 2 — Collect the identifiers

*WhatsApp → API Setup* shows:

| Field | Goes into | Notes |
|---|---|---|
| **Phone number ID** | `META_PHONE_NUMBER_ID` | A long number. **Not** the phone number itself |
| **WhatsApp Business Account ID** | `META_WABA_ID` | |
| **Temporary access token** | `META_ACCESS_TOKEN` (temporarily) | **Expires in 24 hours** |

*App Settings → Basic* shows:

| Field | Goes into |
|---|---|
| **App Secret** (click *Show*) | `META_APP_SECRET` |

---

## Step 3 — Get a token that does not expire

**Do this before you rely on the system.** The temporary token expires in 24
hours, and when it does, every outgoing message fails with error `190`. A system
that "worked yesterday and is broken today" is almost always this.

1. Go to [Business Settings](https://business.facebook.com/settings) →
   **Users → System Users**.
2. **Add** a system user. Role: **Admin**.
3. **Add Assets** → select your WhatsApp Business Account → grant **Full
   control**.
4. **Generate New Token** → select your app.
5. Select these permissions:
   - `whatsapp_business_messaging` — send and receive messages
   - `whatsapp_business_management` — manage the WABA
6. Set expiry to **Never**.
7. Copy the token immediately — **it is shown only once**.

Put it in `META_ACCESS_TOKEN` and in the n8n `Meta WhatsApp Token` credential.

---

## Step 4 — Configure the webhook

You need your public HTTPS URL first (ngrok or Cloudflare Tunnel — see
[SETUP.md](SETUP.md#step-9--expose-the-webhook-to-meta)).

Your callback URL is:

```
https://<your-public-host>/webhook/whatsapp/webhook
```

> Note `/webhook/` — that is n8n's **production** path. n8n also exposes
> `/webhook-test/`, which only responds while the editor is open with "Listen
> for test event" active. Giving Meta the test URL is a common mistake and
> produces intermittent 404s.

**Before configuring in Meta**, make sure:

- Workflow 1 is **published** (a draft workflow returns 404)
- `WEBHOOK_VERIFY_TOKEN` is set in `.env` and n8n has been restarted
- The URL is reachable — test it yourself:

```bash
curl "https://<your-host>/webhook/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test123"
# must print exactly: test123
```

Then in the app dashboard:

1. *WhatsApp → Configuration → Webhook* → **Edit**.
2. **Callback URL**: the URL above.
3. **Verify token**: exactly the value of `WEBHOOK_VERIFY_TOKEN`.
4. **Verify and save**.

Meta immediately sends a `GET` with `hub.mode`, `hub.verify_token` and
`hub.challenge`. Workflow 1 compares the token in constant time and echoes the
challenge. If it fails, Meta shows an error and nothing is saved.

### Subscribe to fields

Still under *Configuration*, click **Manage** next to Webhook fields and
subscribe to:

| Field | Why |
|---|---|
| `messages` | **Required.** Carries both inbound messages *and* delivery statuses |

`messages` is the only field this system needs. Both `messages` and `statuses`
arrive under it — they are distinguished by which array is present in the
payload.

---

## Step 5 — Verify signature checking works

Every POST from Meta carries `X-Hub-Signature-256`, an HMAC-SHA256 of the raw
body using your app secret. Workflow 1 verifies it and rejects mismatches with
401.

Confirm your app secret is correct by sending a real message to your business
number and checking that it produced a successful execution rather than a 401.

If everything returns 401, the app secret is wrong — regenerate/copy it again
from *App Settings → Basic*.

---

## Step 6 — Add test recipients

While your app is in **Development** mode, it can only message numbers you have
explicitly allowed.

*WhatsApp → API Setup → To* → **Manage phone number list** → add up to 5
numbers. Each recipient receives a confirmation prompt on WhatsApp.

---

## Step 7 — Test end to end

1. From an allowed number, send a message to your business number.
2. Check n8n *Executions* — workflow 1 then 2 then 3 should have run.
3. Check the `Conversations` sheet — a row should exist with status
   `UNANSWERED` and an assigned agent.

If nothing arrives, work through
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#no-webhook-events-arriving).

---

## Going live

To message anyone (not just test recipients):

1. **Business verification** — Meta verifies your business exists. Needs
   business registration documents. Takes days to weeks.
2. **Add a real phone number** — *WhatsApp → API Setup → Add phone number*.
   Verify by SMS or call.
3. **Display name review** — Meta reviews the name customers will see.
4. **Switch the app to Live** — toggle at the top of the app dashboard.

---

## The 24-hour customer service window

This rule shapes both cost and operational behaviour, so it matters more than it
first appears.

When a customer messages you, a **24-hour window** opens. Inside it you can send
free-form messages freely. Outside it you can only send **pre-approved template
messages**, which are billable.

| Situation | Allowed | Cost |
|---|---|---|
| Customer messaged 10 minutes ago | Any message | **Free** (service message) |
| Customer messaged 23 hours ago | Any message | **Free** |
| Customer messaged 25 hours ago | Template only | **Paid** |
| You want to start a conversation | Template only | **Paid** |

Attempting a free-form reply after the window fails with error **131047**
(`Re-engagement message`). The system captures this specific code — see the
`status-failed.json` fixture and [ERROR_HANDLING.md](ERROR_HANDLING.md).

**Operational consequence:** replying within 24 hours is not just good service,
it is the difference between free and billable. This is a good reason to watch
the `UNANSWERED` filter in the Conversations sheet.

---

## Costs

Verified from [Meta's pricing documentation](https://developers.facebook.com/docs/whatsapp/pricing)
on 2026-09-09:

| Message category | Billing |
|---|---|
| **Service** (replies inside the 24h window) | **Free** since 1 Nov 2024 |
| **Utility** templates inside an open window | Free |
| **Utility** templates outside the window | Paid |
| **Authentication** templates | Paid |
| **Marketing** templates | Always paid |

There is **no free monthly allowance** — the model is per-message since
1 July 2025 (it was per-conversation before).

**For an inbound support desk where agents reply within 24 hours, messaging
costs nothing.** Costs appear only when re-engaging customers after the window
or sending marketing.

Meta moves additional countries onto standalone rate cards from 1 October 2026;
check current rates for your market if you send templates.

---

## Rate limits

| Limit | Default |
|---|---|
| Messages per second | 80 (business-initiated), higher for user-initiated |
| Messaging tier | Starts at 1,000 unique customers/24h, raises automatically with quality |
| Graph API calls | Standard app-level limits |

Quality rating (visible in WhatsApp Manager) drops if customers block or report
you; sustained low quality reduces your tier.

None of these are near the binding constraint for this system — **Google Sheets'
60 reads/minute is far lower**. See
[GOOGLE_SHEETS_TO_POSTGRES.md](GOOGLE_SHEETS_TO_POSTGRES.md).

---

## Required configuration summary

| Setting | Where | Variable |
|---|---|---|
| Phone Number ID | WhatsApp → API Setup | `META_PHONE_NUMBER_ID` |
| WABA ID | WhatsApp → API Setup | `META_WABA_ID` |
| System User token | Business Settings → System Users | `META_ACCESS_TOKEN` |
| App Secret | App Settings → Basic | `META_APP_SECRET` |
| Verify token | **You invent it**, then paste into Meta | `WEBHOOK_VERIFY_TOKEN` |
| Callback URL | WhatsApp → Configuration | — |
| Subscribed field | WhatsApp → Configuration | `messages` |
| Graph API version | — | `META_GRAPH_API_VERSION` (`v26.0`) |

**Required permissions:** `whatsapp_business_messaging`,
`whatsapp_business_management`.
