# Credentials Checklist — direct links

Everything you need to obtain, in the order to obtain it, with the exact page
for each value.

Run this at any time to see what is still missing (it never prints a secret):

```bash
node scripts/validation/check-env.js
```

Then paste values in safely with:

```bash
node scripts/setup/configure-credentials.js
```

---

## Current status

| Value | Where it goes | Status |
|---|---|---|
| `N8N_ENCRYPTION_KEY` | `.env` | **Done** — generated locally |
| `WEBHOOK_VERIFY_TOKEN` | `.env` + Meta dashboard | **Done** — dev value; keep or replace |
| `META_APP_SECRET` | `.env` | **Dev placeholder — must be replaced** with the real App Secret |
| `META_ACCESS_TOKEN` | `.env` | **Needed** |
| `META_PHONE_NUMBER_ID` | `.env` | **Needed** |
| `GOOGLE_SHEET_ID` | `.env` | **Needed** |
| Google service account | **n8n UI**, not `.env` | **Needed** |
| Meta bearer token credential | **n8n UI**, not `.env` | **Needed** |

---

## Part 1 — Meta (about 20 minutes)

### 1.1 Create the developer app

**<https://developers.facebook.com/apps>**

*Create App* → type **Business** → name it → link your Business account.
On the dashboard find **WhatsApp** → **Set up**.

You now have a WhatsApp Business Account (WABA) and a free test number.

### 1.2 Get the Phone Number ID and a temporary token

**<https://developers.facebook.com/apps>** → your app → **WhatsApp → API Setup**

Direct form once you know your app id:
`https://developers.facebook.com/apps/<APP_ID>/whatsapp-business/wa-dev-console/`

Copy from this page:

| On the page | Variable |
|---|---|
| **Phone number ID** (a long number, *not* the phone number) | `META_PHONE_NUMBER_ID` |
| **WhatsApp Business Account ID** | `META_WABA_ID` (optional) |
| **Temporary access token** | `META_ACCESS_TOKEN` — **only for the first test** |

> The temporary token **dies after 24 hours**. Use it to confirm the pipeline
> works, then replace it in step 1.4. A system that works today and breaks
> tomorrow is almost always this.

### 1.3 Get the App Secret

**<https://developers.facebook.com/apps>** → your app → **App Settings → Basic**

Direct form: `https://developers.facebook.com/apps/<APP_ID>/settings/basic/`

Click **Show** next to *App Secret* → `META_APP_SECRET`.

> Replace the development value currently in `.env`. Until you do, real Meta
> webhooks will be rejected with 401 — which is the system failing safely, not
> a bug.

### 1.4 Create a permanent token — do not skip this

**<https://business.facebook.com/settings>** → **Users → System Users**

1. **Add** → name it (e.g. `whatsapp-automation`) → role **Admin**
2. **Add Assets** → your WhatsApp Business Account → **Full control**
3. **Generate New Token** → select your app
4. Tick these two permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. Expiry: **Never**
6. **Copy it immediately — it is shown only once**

This replaces the temporary token in `META_ACCESS_TOKEN`.

### 1.5 Add test recipients

**WhatsApp → API Setup → To → Manage phone number list**

While the app is in Development mode it can only message numbers you list
here (up to 5). Add your own number to test.

### 1.6 Webhook configuration — after the tunnel is running

**WhatsApp → Configuration → Webhook → Edit**

| Field | Value |
|---|---|
| Callback URL | `https://<your-tunnel-host>/webhook/whatsapp/webhook` |
| Verify token | exactly your `WEBHOOK_VERIFY_TOKEN` |

Subscribe to the field **`messages`** (required). Add **`smb_message_echoes`**
too if you are using Coexistence — see [COEXISTENCE.md](COEXISTENCE.md).

Get a public URL first:

```bash
ngrok http 5678        # ngrok is already installed on this machine
```

---

## Part 2 — Google Sheets (about 10 minutes)

### 2.1 Create the spreadsheet

**<https://sheets.new>**

The id is the long string in the URL:

```
https://docs.google.com/spreadsheets/d/1a2B3cD4eF5gH6iJ7kL8mN9oP0qR/edit
                                      └────────── this is GOOGLE_SHEET_ID ──┘
```

Set it up in one step: *Extensions → Apps Script*, paste
[`sheets-templates/SetupSheet.gs`](../sheets-templates/SetupSheet.gs), run
`setupEverything`.

### 2.2 Create a Google Cloud project

**<https://console.cloud.google.com/projectcreate>**

Free. No billing card required for the Sheets API.

### 2.3 Enable the Sheets API

**<https://console.cloud.google.com/apis/library/sheets.googleapis.com>**

Select your project → **Enable**.

### 2.4 Create the service account

**<https://console.cloud.google.com/iam-admin/serviceaccounts>**

1. **Create Service Account** → name it (e.g. `n8n-whatsapp`) → **Done**
   (no roles needed — access is granted by sharing the sheet, not by IAM)
2. Open it → **Keys → Add Key → Create new key → JSON** → download

The JSON contains `client_email` and `private_key`. You need both in n8n.

### 2.5 Share the sheet with the service account — the step everyone forgets

Open your spreadsheet → **Share** → paste the `client_email` from the JSON
(it looks like `n8n-whatsapp@your-project.iam.gserviceaccount.com`) → give it
**Editor** → Send.

> Without this, every Sheets node returns **403**. The service account is a
> separate identity; creating it does not grant it access to your files.

---

## Part 3 — Put the values in

### Into `.env`

```bash
node scripts/setup/configure-credentials.js
```

It prompts for each value, masks secrets as you type them back, validates the
obvious mistakes (a phone number pasted where an ID belongs, a token with
whitespace), and writes `.env` without disturbing anything else.

Or edit `.env` by hand. Then:

```bash
docker compose up -d                       # pick up the new values
node scripts/validation/check-env.js       # confirm, without printing secrets
```

### Into the n8n UI — <http://localhost:5678>

Two credentials cannot live in `.env`, because n8n nodes need credential
objects:

**Google Sheets**
*Credentials → New → Google Sheets → Service Account*
- Service Account Email: `client_email` from the JSON
- Private Key: `private_key` from the JSON, including the
  `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines
- Name it: `Google Sheets — WhatsApp Support`

**Meta token**
*Credentials → New → Header Auth*
- Name: `Authorization`
- Value: `Bearer YOUR_META_ACCESS_TOKEN`
- Name the credential: `Meta WhatsApp Token`

Then open each workflow and attach:
- every **Google Sheets** node → the Sheets credential
- **Send Via Cloud API** (workflow 4) and **Send Reply Via Cloud API**
  (workflow 7) → `Meta WhatsApp Token`

Finally **publish** workflows 4, 5, 7 and 8 — they were left unpublished
precisely because a scheduled workflow with no credential fails on every tick.

---

## Verify it end to end

```bash
node scripts/validation/check-env.js        # all groups [ready]
node scripts/testing/send-fixture.js        # 200 × 10, no credentials needed
```

Then send a real WhatsApp message from a test recipient number and check:

1. n8n *Executions* — workflows 1, 2, 3 ran
2. The `Conversations` tab — a row with status `UNANSWERED` and an assigned agent
3. Reply by typing in `reply_text` — it should send within a minute

---

## Security reminders

- **Never commit `.env`.** It is git-ignored; verify with `git check-ignore -v .env`
- **Never paste a token into a chat, screenshot, or issue.** If you do, rotate it
- The System User token is shown **once** — store it in a password manager
- Losing `N8N_ENCRYPTION_KEY` makes every stored n8n credential unrecoverable;
  back it up with your data

Full policy: [SECURITY.md](SECURITY.md).
