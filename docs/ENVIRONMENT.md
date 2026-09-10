# Environment Variables

Every variable, what reads it, and what happens if it is wrong.

Configuration lives in `.env` (git-ignored). `.env.example` documents the same
set with placeholders and is the only one committed.

---

## Where configuration actually lives

There are **three** distinct places, and confusing them is the most common
setup mistake:

| Location | Holds | Read by |
|---|---|---|
| **`.env`** | Tokens, ids, tuning values | Docker Compose → container env → Code nodes via `$env` |
| **n8n Credentials** (UI, encrypted DB) | Google service account, Meta bearer header | Google Sheets and HTTP Request nodes |
| **Meta App Dashboard** (Meta's site) | Callback URL, verify token | Meta, when it calls us |

The verify token appears in **two** of these — `.env` and the Meta dashboard —
and the two values must match exactly.

---

## n8n core

### `N8N_ENCRYPTION_KEY` — **required**

64-character hex string. Encrypts credentials in n8n's database.

```bash
openssl rand -hex 32
```

- **If unset:** n8n generates one into the Docker volume. Works until the volume
  is lost or moved, then every stored credential is unrecoverable.
- **If changed:** n8n refuses to start —
  `Error: Mismatching encryption keys`.
- **Back this up** alongside your data. Losing it means re-entering every
  credential.

### `TZ` / `GENERIC_TIMEZONE`

Default `Asia/Amman`. Controls schedule triggers and how n8n displays times.

All timestamps are **stored in UTC** regardless of this setting — this variable
affects display and cron scheduling only. Storing local time would make DST
transitions corrupt ordering.

### `N8N_HOST`, `N8N_PROTOCOL`, `N8N_WEBHOOK_URL`

What n8n believes its own public address is, used to display webhook URLs.

`N8N_WEBHOOK_URL` is the externally reachable base URL. Set it to your tunnel
URL during development:

```bash
N8N_WEBHOOK_URL=https://your-id.ngrok-free.app/
```

> In n8n 2.x this variable was renamed from `WEBHOOK_URL`. The old name still
> works but logs a deprecation warning on every start.

Getting this wrong does not break request handling — it only means the URL shown
in the editor is not the one Meta should call.

### Set in `docker-compose.yml`, not `.env`

| Variable | Value | Why |
|---|---|---|
| `NODE_FUNCTION_ALLOW_BUILTIN` | `crypto` | Code nodes need `crypto` for HMAC. Scoped to one module, not `*` |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | `false` | n8n 2.x blocks `$env` in nodes by default; the workflows read config from the environment |
| `N8N_UNVERIFIED_PACKAGES_ENABLED` | `false` | No community packages — smaller supply-chain surface |
| `N8N_RUNNERS_TASK_TIMEOUT` | `60` | A hung Code node fails fast and visibly |
| `N8N_COMPRESSION_NODE_MAX_*` | tightened | This system never processes archives |
| `N8N_DIAGNOSTICS_ENABLED` | `false` | Handling customer data |

`NODE_FUNCTION_ALLOW_EXTERNAL` is deliberately **not** set — no npm packages in
Code nodes at all.

---

## Meta WhatsApp Cloud API

### `META_GRAPH_API_VERSION`

Default `v26.0` (current stable as of 2026-09-09).

Never hard-coded in workflows — the send URL is built as
`https://graph.facebook.com/{{ $env.META_GRAPH_API_VERSION }}/...`, so upgrading
is a one-line change here.

Check the current version and sunset dates at the
[Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog/).
Versions are supported for roughly two years.

### `META_ACCESS_TOKEN` — required to send

Bearer token with `whatsapp_business_messaging` and
`whatsapp_business_management`.

> **The temporary token from the Meta dashboard expires in 24 hours.** A system
> that works today and dies tomorrow is almost always this. Create a **System
> User token** for anything beyond a first test — see
> [META_WHATSAPP_SETUP.md](META_WHATSAPP_SETUP.md).

Also stored as an n8n Header Auth credential (`Meta WhatsApp Token`) so the
HTTP Request node never contains it inline.

- **If expired:** every send fails with a `190` error code, recorded in Events.

### `META_PHONE_NUMBER_ID` — required to send

The **Phone Number ID**, not the phone number. A numeric id from the WhatsApp
Manager. Used in the send path: `POST /{version}/{phone-number-id}/messages`.

### `META_WABA_ID`

WhatsApp Business Account id. Not required by the current workflows; recorded
for management API calls and for verifying which WABA a webhook came from.

### `META_APP_SECRET` — required for security

App secret from the Meta App Dashboard. Verifies the `X-Hub-Signature-256` HMAC
on every incoming webhook.

- **If unset:** signature verification **fails closed** — all POSTs are
  rejected. This is deliberate. Silently accepting unsigned webhooks because
  someone forgot a variable would let anyone post fake customer messages.

### `WEBHOOK_VERIFY_TOKEN` — required

A string **you invent**. Meta echoes it during the GET verification handshake.

Must be identical in `.env` and in the Meta dashboard's webhook configuration.

- **If unset:** the handshake fails closed with HTTP 500, so nobody can bind
  their own Meta app to your endpoint.
- **If mismatched:** Meta's verification fails with 403 and the webhook cannot
  be registered.

---

## Google Sheets

### `GOOGLE_SHEET_ID` — required

The spreadsheet id from its URL:

```
https://docs.google.com/spreadsheets/d/THIS_PART/edit
```

### `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

Documented in `.env` for completeness, but the Sheets node reads them from an
**n8n credential**, not from the environment. Create the credential in the UI —
see [SETUP.md](SETUP.md#5a--google-sheets-credential).

**The spreadsheet must be shared with the service account email as an Editor.**
This is the single most common cause of 403 errors.

---

## Business logic

### `CONVERSATION_INACTIVITY_HOURS`

Default `24`. Hours of inactivity after which a conversation becomes *eligible*
for closing.

**Nothing auto-closes in the MVP.** This computes eligibility only. Setting it
to `0` or leaving it blank disables the calculation entirely.

### `DEFAULT_COUNTRY_CODE`

Default `962` (Jordan). Used to expand national-format numbers: `0791234567`
becomes `962791234567`.

Only applies to numbers with a leading `0`. Numbers already in E.164 (with `+`
or a country code) pass through untouched, so international customers work
regardless of this setting.

### `ASSIGNMENT_STRATEGY`

Default `LEAST_OPEN_CONVERSATIONS`. Also accepts `ROUND_ROBIN`.

An unrecognized value falls back to the default rather than failing — a
configuration typo must not stop customers being routed.

### `REOPEN_CLOSED_CONVERSATIONS`

Default `true`. When a customer messages a `CLOSED` conversation, it reopens
with the same `conversation_id`. Set to `false` to keep closed conversations
closed and create a new one instead.

### `N8N_CONCURRENCY_PRODUCTION_LIMIT`

**Set to `1`** if you cannot set per-workflow concurrency in the UI. This is
what serializes assignment and prevents two simultaneous conversations going to
the same agent. See
[ASSIGNMENT_ALGORITHM.md](ASSIGNMENT_ALGORITHM.md#concurrency-and-race-conditions).

---

## Local testing only

### `.env.test.local`

Read by `scripts/testing/send-fixture.js` so fixtures can be signed exactly as
Meta signs them, without touching real configuration. Git-ignored via the
`.env.*` rule.

```
WEBHOOK_VERIFY_TOKEN=devverify_...
META_APP_SECRET=...
```

---

## Validation

```bash
node scripts/validation/check-env.js
```

Reports which variables are set, which are missing, and which are only needed
for features you have not enabled yet. **It never prints values** — only
`<set>` / `<empty>` and a length.

---

## Rules

1. **Never commit `.env`.** It is in `.gitignore`; verify with
   `git check-ignore -v .env`.
2. **Never put real values in `.env.example`.**
3. **Rotate anything that leaks.** A token in a screenshot, a chat message, or a
   commit is compromised — rotate it in the Meta dashboard, do not just delete
   the message.
4. **Different secrets per environment.** Never reuse a production encryption
   key or app secret in development.
5. **Back up `N8N_ENCRYPTION_KEY`** with your data — it is the one secret that
   cannot be regenerated without data loss.
