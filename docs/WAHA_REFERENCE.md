# WAHA reference — what the official docs say, and where this deployment stands

The working reference for the WAHA side of this project. [WAHA_CONNECTOR.md](WAHA_CONNECTOR.md)
explains *why* the connector exists and how it plugs into workflows 1b, 4 and 7;
this file is what to check before changing anything about WAHA itself.

**Sources.** The official documentation, read from its source repository
[devlikeapro/waha-docs](https://github.com/devlikeapro/waha-docs) at commit
`de44246ce94c`, plus the official
[`docker-compose.yaml`](https://github.com/devlikeapro/waha/blob/core/docker-compose.yaml) and
[`.env.example`](https://github.com/devlikeapro/waha/blob/core/.env.example) from
[devlikeapro/waha](https://github.com/devlikeapro/waha) (`core` branch, commit `aa0663b1870e`).
Read 2026-09-18, against WAHA **2026.8.2** (CORE tier, NOWEB engine) — the version running here.

**Two kinds of statement, kept apart.** Everything is either:

- **Docs** — what the official documentation says, with a link to the page, or
- **Verified here** — what we observed on this machine's running container
  (API responses, logs, WAHA's own source inside the image). Where the two
  disagree, this file says so rather than picking one silently.

Capability gaps (multi-session, media, MCP, Apps) are tracked in
[FUTURE_SESSION_SCOPED_ASSIGNMENT.md §6](FUTURE_SESSION_SCOPED_ASSIGNMENT.md#6-gap-check-against-the-upstream-waha-project)
and not repeated here.

---

## 1. Where this deployment differs from the official setup

The short version, with where each item stands as of 2026-09-18. Each row links
to the section with the detail.

| # | Topic | Official recommendation | Before | Status now |
|---|---|---|---|---|
| 1 | Port binding ([§2](#2-install-and-update)) | `127.0.0.1:3000:3000` — "containers are not exposed to the internet" | `3000:3000` (all interfaces) | **Fixed** — `127.0.0.1:3000:3000`; verified refused on the LAN address |
| 2 | Image ([§2](#2-install-and-update)) | Engine-specific image, version pinned | `devlikeapro/waha:latest` — floating, ships an unused Chromium | **Fixed** — `devlikeapro/waha:noweb-2026.8.2` |
| 3 | API keys ([§3.2](#32-api-key)) | `sha512:` admin key; narrower session keys for clients | n8n held the full admin key | **Fixed for n8n** — send-only session key (`WAHA_SEND_API_KEY`), n8n no longer gets `WAHA_API_KEY`. The admin key stays plain in WAHA's env: `.env` must hold it for the Dashboard and scripts anyway |
| 4 | Chat types ([§4.5](#45-ignore-status-groups-channels-broadcast)) | Filter at the source | Nothing ignored — groups, statuses, channels reached workflow 1b | **Fixed at the source** — `WAHA_SESSION_CONFIG_IGNORE_*=True` and `config.ignore` on `default`; workflow 1b also skips them (`76f7eca`) |
| 5 | QR in logs ([§2](#2-install-and-update)) | `WAHA_PRINT_QR=False` | Every QR printed to `docker logs` | **Fixed** |
| 6 | Log rotation ([§2](#2-install-and-update)) | `json-file`, 100 MB × 10 | Unbounded | **Fixed** |
| 7 | Phone notifications ([§4.7](#47-presence-and-phone-notifications)) | `noweb.markOnline: false` | `true` | **Fixed** on `default` by `configure-waha.js` |
| 8 | Sender IDs ([§5.3](#53-chat-ids-and-lids)) | `@lid` is its own ID type | Workflow 1b turned `<lid>@lid` into a phone number | **Fixed** (`76f7eca`) — workflow 1b resolves it through `_data.key.remoteJidAlt`; an unresolvable LID is logged, never guessed |
| 9 | Send result ([§6.1](#61-sendtext)) | OpenAPI: top-level `id` | NOWEB returns `{ key: { id } }`; every send logged FAILED | **Fixed** — `scripts/lib/send-result.js`, unit-tested |
| 10 | Own-phone replies ([§5.2](#52-message-vs-messageany)) | `message.any` includes your own messages | `message` — 1b's `fromMe` branch never runs | **Decided: stay on `message`.** On a personal number, `message.any` would log everything the owner sends to friends and family |
| 11 | Anti-blocking ([§6.2](#62-anti-blocking-guidance)) | sendSeen → typing → wait → sendText; watch timelock/capping | Sends immediately | **Open** — needs a decision on delays; `reply_to` threading is now sent |
| 12 | Duplicate webhook ([§4.4](#44-session-config)) | Global webhook applies to every session | `default` also had a per-session copy of it, so WAHA registered it twice | **Fixed** — session config carries no webhooks |
| — | Workflow 4 auth ([§3.1](#31-the-threat-model-in-the-docs)) | Nothing should reach `sendText` unauthenticated | `POST /webhook/agent/send` had no auth | **Fixed** — `X-Agent-Key` = `AGENT_SEND_API_KEY`, fails closed; verified 401/401/500 live |

**Applying it.** `docker compose up -d` picks up the compose settings.
`node scripts/setup/configure-waha.js` sets the session config and mints
the send key; run it again any time, it only changes what differs.
`--check` reports without changing anything.

---

## 2. Install and update

**Docs** — [Install & Update](https://waha.devlike.pro/docs/how-to/install/),
[Deploy WAHA on Docker](https://waha.devlike.pro/blog/waha-on-docker/),
[Engines → Docker images](https://waha.devlike.pro/docs/how-to/engines/#docker-images),
[How to Update WAHA](https://waha.devlike.pro/blog/waha-update/).

- `docker run … devlikeapro/waha` is "good for development purposes, but not for production".
- The official compose template binds `127.0.0.1:3000:3000/tcp`, sets `json-file` logging
  (`max-size: 100m`, `max-file: 10`), and optionally `dns: [1.1.1.1, 8.8.8.8]`
  "if you have a problem with resolving web.whatsapp.com". `3000:3000` is described only as
  "temporary external access".
- Credentials: `docker compose run --no-deps -v "$(pwd)":/app/env waha init-waha /app/env`
  writes a `.env` with random `WAHA_API_KEY`, `WAHA_DASHBOARD_PASSWORD`, `WHATSAPP_SWAGGER_PASSWORD`.
  The docs insist on long random values; the
  [security alert](https://waha.devlike.pro/blog/security-alert/) asks for at least 64 characters.
- Image tags follow `devlikeapro/waha:{browser}[-cpu][-version]`. For NOWEB the image is
  `noweb` (no browser). `latest` is the Chromium image. Pin by appending `-{version}`.
- Windows: the docs suggest Docker Desktop's **Hyper-V** backend and say it "might not work
  with WSL2 backend properly".
- Update: `docker compose pull && docker compose up -d`. Sessions survive the update as long as
  `/app/.sessions` is persisted. With a pinned tag, change the tag first.
- Since **2026.6.1** everything formerly in WAHA Plus is in the free Core image
  ([FAQ](https://waha.devlike.pro/docs/overview/faq/)).

**Verified here**

- `devlikeapro/waha:noweb-2026.8.2` exists on Docker Hub, the same release we run, 853 MB
  against 1156 MB for `latest-2026.8.2`. It is the pin to use.
- This machine runs Docker Desktop on WSL2, against the docs' Hyper-V suggestion. The container
  is healthy and reaches WhatsApp, so it works in practice. If odd connection issues appear,
  check this first.
- `waha_sessions` is a named volume mounted at `/app/.sessions`, so updates keep the session.
- Official `.env.example` also sets `WAHA_PRINT_QR=False` and `WAHA_LOG_FORMAT=JSON`. We set
  the first. The log format stays `PRETTY`, which is easier to read with `docker logs`.
- The `noweb` image ships **without `wget`**, so a `wget`-based healthcheck never turns healthy
  there. Ours runs `node -e "fetch(...)"` and reads the key from the container's own
  environment, which also keeps the key out of `docker inspect`'s healthcheck line.

**Namespace — leave it alone.** The docs recommend `WAHA_NAMESPACE=all` "for new setups". It
decides the directory WAHA's main database lives in (`/app/.sessions/{namespace}/waha.sqlite3`).
Ours is the engine default, `noweb`. Changing it on an existing volume points WAHA at a
different, empty database ([Storages → Namespace](https://waha.devlike.pro/docs/how-to/storages/#namespace)).

---

## 3. Security

**Docs** — [Security](https://waha.devlike.pro/docs/how-to/security/),
[Configuration → Security](https://waha.devlike.pro/docs/how-to/config/#security),
[Security alert (2025-04)](https://waha.devlike.pro/blog/security-alert/).

### 3.1 The threat model in the docs

> "Do not expose WhatsApp API on public networks! … Always protect the API with Api Key and
> deny access by using firewalls."

The security alert describes real incidents with exposed, unprotected instances: bots found
them and "used sessions, hijacked WhatsApp accounts, sent spam messages". It adds: "Changing
ports will not save you! … Bots scan all ports."

Whoever can call `sendText`, directly or through something that calls it, *is* the account
owner as far as WhatsApp is concerned. That is why workflow 4's `/webhook/agent/send`, which
was unauthenticated, belongs in this section even though it is n8n, not WAHA. It now requires
`X-Agent-Key`.

### 3.2 API key

- Every request needs `X-Api-Key`. `WAHA_API_KEY` accepts `sha512:{hex}` ("recommended … stores
  only the hash") or a plain key. `WHATSAPP_API_KEY` is the older name and still works.
- The key is also accepted as a lowercase `?x-api-key=` query parameter, meant for things like
  `<img src>`. The docs warn: "Never embed your admin or full-session key in a URL".
- `WAHA_API_KEY_EXCLUDE_PATH=health,ping` removes the key requirement from listed paths.

**Keys API: use narrower keys.** Besides `WAHA_API_KEY` (admin), WAHA issues keys through
`POST /api/keys` or the Dashboard:

| Key | Scope |
|---|---|
| Admin (`isAdmin: true`) | Everything, all sessions |
| Session key (`session: "default"`) | One session; `actions` narrows it further |
| `POST /api/keys/control` | Control only — for opening a QR/screenshot in a browser |
| `POST /api/keys/media` | Media download only |

Session key `actions`: `read`, `send`, `control`, `setting`, `app` (default `true`), `delete`
(default `false`).

**For this project.** n8n only ever calls `sendText`, so it holds a session key for `default`
with only `send: true` (`WAHA_SEND_API_KEY`, minted by `scripts/setup/configure-waha.js`),
not the admin key. Verified here, with that key against the running instance:

| Call | Result |
|---|---|
| `POST /api/sendText` on `default` | Accepted (422 only because the session isn't linked) |
| `POST /api/sendText` on another session | 403 |
| `GET /api/sessions/default`, `GET /api/server/environment`, `POST …/logout` | 403 |
| `GET /api/sessions` | 200, but lists only its own session's name, status and config |

Keys live in WAHA's own database on the `waha_sessions` volume. If that volume is lost, run the
script again for a new one.

**Verified here**

- Every route except `/ping` returns 401 without credentials. `/api/*` and `/health` need the
  key; `/dashboard`, `/` (Swagger) and `/-json` (the OpenAPI spec) need the Basic-auth login.
- `Authorization: Bearer` and Basic auth are **not** accepted on `/api/*`, and `?api_key=` is not
  either. Only the header and `?x-api-key=` work.
- WAHA redacts `x-api-key` in its request log, but not other query names. A wrong
  parameter name therefore writes the key into `docker logs`.
- `GET /api/server/environment` returns `WAHA_DASHBOARD_PASSWORD` and `WHATSAPP_HOOK_HMAC_KEY` in
  plain text to any key holder. The API key itself is shown hashed.
- CORS answers any origin (`Access-Control-Allow-Origin: *`, `x-api-key` allowed). This is
  harmless only while the key stays secret.
- There is no rate limit on failed Basic-auth attempts. The 32/64-character secrets make that moot.

### 3.3 Dashboard and Swagger

- Both are behind Basic auth (`WAHA_DASHBOARD_*`, `WHATSAPP_SWAGGER_*`). The docs stress that the
  Swagger password "does not protect your API".
- Either can be switched off: `WAHA_DASHBOARD_ENABLED=false`, `WHATSAPP_SWAGGER_ENABLED=false`.
  Once pairing is done, the Dashboard is optional.
- **Verified here: the Dashboard fills in unsafe defaults.** When creating a session, "Add webhook"
  inserts `https://httpbin.org/post` (a public third-party echo service) with
  `events: [session.status, message]` and **no HMAC**. The form also enables NOWEB store with
  `fullSync: true`, and fills metadata with `user.id.1: 123`. One session created this way on
  2026-09-18 posted 8 status events to httpbin.org before it was deleted. Create sessions through
  the API with an explicit body (§4.4), or clear those fields before saving.

### 3.4 HTTPS

"That's fine to run it on the local network without HTTPS, but for the production environment,
HTTPS is a must-have." Put a reverse proxy in front (the Docker guide has the nginx config).
Built-in HTTPS (`WAHA_HTTPS_*`) is deprecated.

### 3.5 Webhook HMAC

- The webhook config takes `hmac.key`, or `WHATSAPP_HOOK_HMAC_KEY` globally.
- Each request then carries `X-Webhook-Hmac` (HMAC-SHA512 of the **raw body**, hex) and
  `X-Webhook-Hmac-Algorithm: sha512`.
- Every webhook also carries `X-Webhook-Request-Id` and `X-Webhook-Timestamp` (ms). These
  headers are **not** covered by the HMAC.
- Official test vector: body `{"event":"message","session":"default","engine":"WEBJS"}`, key
  `my-secret-key` → `208f8a55…6153fa89`.

**Verified here**

- Workflow 1b's method (`createHmac('sha512', key).update(rawBody).digest('hex')`) reproduces
  that vector exactly.
- Unsigned and wrongly signed requests to `/webhook/whatsapp/waha-incoming` both get 401.
- For replay protection, use what the HMAC *does* cover: the body's `id` (`evt_…`, unique per
  event) and `timestamp` (ms). Do not use the unsigned headers.

---

## 4. Sessions

**Docs** — [Sessions](https://waha.devlike.pro/docs/how-to/sessions/),
[NOWEB](https://waha.devlike.pro/docs/engines/noweb/),
[Presence](https://waha.devlike.pro/docs/how-to/presence/).

### 4.1 Status values

| Status | Meaning |
|---|---|
| `STOPPED` | Stopped |
| `STARTING` | Starting |
| `SCAN_QR_CODE` | Waiting for QR or pairing code. Re-issued every time the QR changes, so re-fetch the QR on each event |
| `PASSKEY_REQUIRED`, `PASSKEY_CONFIRMATION_REQUIRED` | WebAuthn step during pairing — **GOWS only** |
| `WORKING` | Ready. May carry `reachoutTimelock` / `messageCapping` in `data` (§6.2) |
| `FAILED` | Auth needed again, or device unlinked. Restart; if that fails, logout then start |

### 4.2 Linking: QR and pairing code

- `GET /api/{session}/auth/qr` returns a PNG by default, base64 with `Accept: application/json`,
  or the raw string with `?format=raw`.
- **Expiry:** "The first QR code expires in 60 seconds, then 20 seconds for each subsequent one,
  up to 6 QR codes total. After that, the session moves to the FAILED status." That is about
  2 min 40 s in total. Verified here: `QR refs attempts ended` → `FAILED` after exactly that long.
- Pairing code: `POST /api/{session}/auth/request-code` with `{ "phoneNumber": "…" }` returns
  `{ "code": "ABCD-ABCD" }`. "Always add QR code auth flow … as a fallback". Pairing code "is
  likely to fail if a custom device name is set".

**Verified here: what the QR is and where it goes.** This comes from WAHA's own source in
the image (Baileys `7.0.0-rc14`) and from watching the container's live connections:

- The QR string is
  `https://wa.me/settings/linked_devices#<ref>,<noise pubkey>,<identity pubkey>,<adv secret>,<platform id>`.
  `ref` comes from WhatsApp's server; the keys are generated locally. The image is drawn locally
  by the `qrcode` npm package, with no external QR service. The part after `#` is never sent to
  a server by a browser.
- While the QR was showing, the only external connection was to `31.13.86.51:443`
  (`whatsapp-cdn-shv-01-mxp1.fbcdn.net`, Meta Platforms Ireland). Its TLS certificate is
  `*.whatsapp.net`, issued by DigiCert. Inside that, Baileys checks WhatsApp's Noise certificate
  against the pinned root key `WhatsAppLongTerm1`, so the server cannot be impersonated even
  with DNS tampered.
- No proxy is configured, and WAHA's server code has no telemetry endpoints
  (`OTEL_*_EXPORTER=none`). From the browser, the Dashboard calls `api.github.com` for a
  version check.
- **Operational rule:** only scan a QR you generated on this machine's Dashboard. Scanning a QR
  someone *sends* you links *their* server to *your* account; that is how WhatsApp accounts
  are stolen. A leaked image of *our* QR does not endanger us: scanning it links the
  scanner's own account to our WAHA.

### 4.3 Stop, logout, delete

| Action | Endpoint | Effect |
|---|---|---|
| Stop | `POST /api/sessions/{s}/stop` | Stops; "doesn't Log out or Delete anything" |
| Restart | `POST /api/sessions/{s}/restart` | Stop + start |
| Logout | `POST /api/sessions/{s}/logout` | Removes auth data, keeps config. If `WORKING`, also removes the device from the phone's Linked Devices |
| Delete | `DELETE /api/sessions/{s}` | "Also logs out the session (removes both session configuration and data)" |

Verified here: deleting a session logs `Unpairing the device from account…` and removes its
directory under `/app/.sessions/noweb/`.

### 4.4 Session config

`POST /api/sessions` (or `PUT /api/sessions/{s}` with the **full** config; a running session is
stopped and restarted). The top-level fields are `metadata`, `proxy`, `debug`, `ignore`, `client`,
`noweb`, `gows`, `webjs`, `webhooks` (also confirmed in the running instance's OpenAPI spec).

The config this project uses for `default`, applied by `scripts/setup/configure-waha.js`:

```jsonc
{
  "name": "default",
  "config": {
    "ignore": { "status": true, "groups": true, "channels": true, "broadcast": true },
    "noweb": { "markOnline": false }   // store left off: nothing here reads chat history
    // no "webhooks": the global WHATSAPP_HOOK_* webhook already applies to every session
    // no "client": a custom device name breaks pairing-code login (§4.2)
  }
}
```

Verified here: the previous `default` carried a per-session copy of the global webhook, and
WAHA's log showed it configuring `http://n8n:5678/webhook/whatsapp/waha-incoming` twice for
that session.

**Global vs session webhooks.** `WHATSAPP_HOOK_URL`/`_EVENTS`/`_HMAC_KEY`/`_RETRIES_*`/`_CUSTOM_HEADERS`
apply to **all** sessions and "do not appear in `session.config`". Verified here: a session made
in the Dashboard with its own httpbin webhook sent to **both** httpbin and our n8n endpoint.

### 4.5 Ignore: status, groups, channels, broadcast

`config.ignore` per session, or globally with
`WAHA_SESSION_CONFIG_IGNORE_STATUS|GROUPS|CHANNELS|BROADCAST=true`. The global setting is used
whenever a session has no `config.ignore` of its own.

- **Filtered:** events (so no webhook calls), and what NOWEB/GOWS store.
- **Not filtered:** sending, and the low-level `engine.event`.

For a personal number this is the difference between customer chats and the owner's family
groups and contacts' statuses landing in the team's Sheet. One-to-one personal chats **cannot**
be filtered this way; only a dedicated number solves that.

### 4.6 NOWEB store

- Off by default. NOWEB then keeps no chats, contacts or messages, and
  `/chats`, `/contacts/all` and `…/messages` don't work.
- `store.enabled: true` keeps about 3 months of history. Adding `fullSync: true` keeps about
  1 year, max 100K messages per chat.
- "Do not change the values after you scanned QR, it can lead to the loss of the chat history."
- The store lives at `.sessions/noweb/{session}/store.sqlite3`. "We don't recommend opening it
  manually when the session is running."

This project reads nothing from WAHA's store, so leave it **off**. It only adds personal data at
rest, readable by any key holder.

### 4.7 Presence and phone notifications

- "WhatsApp doesn't send notifications to the device if a web client is active." For NOWEB,
  the Presence FAQ says to set `markOnline: false` when creating the session.
- The NOWEB page's line "markOnline … Required if you want to get notifications in your phone"
  reads backwards next to that; the Presence FAQ is the explicit one.
- After any request to WhatsApp, WAHA marks the session online for
  `WAHA_PRESENCE_AUTO_ONLINE_DURATION_SECONDS` (default 90). `WAHA_PRESENCE_AUTO_ONLINE=False`
  disables that.
- Device label in Linked Devices: `config.client` or `WAHA_CLIENT_DEVICE_NAME` /
  `WAHA_CLIENT_BROWSER_NAME`. Keep a real browser name, or WhatsApp shows "Other device".
  Unset, as today, WAHA announces itself as Chrome on Ubuntu (verified in its connect log).

---

## 5. Events and webhooks

**Docs** — [Events](https://waha.devlike.pro/docs/how-to/events/),
[Receive messages](https://waha.devlike.pro/docs/how-to/receive-messages/),
[Contacts → LIDs](https://waha.devlike.pro/docs/how-to/contacts/#api---lids).

### 5.1 Envelope

```jsonc
{
  "id": "evt_…",            // ULID, unique per event — signed, use for dedup/replay checks
  "timestamp": 1741249702485, // ms — signed
  "event": "message",
  "session": "default",
  "metadata": { … },        // whatever config.metadata holds
  "me": { "id": "…@c.us", "pushName": "…" },  // the linked account's own number
  "payload": { … },
  "environment": { "tier": "CORE", "version": "…" },
  "engine": "NOWEB"
}
```

Retries: `policy` `constant` / `linear` / `exponential` (with jitter), plus `delaySeconds` and
`attempts`. The same message can therefore arrive more than once, so the receiver must stay
idempotent. Workflow 2's message-id dedup already covers this.

### 5.2 `message` vs `message.any`

- `message` — "Incoming message". Your own messages are not included.
- `message.any` — "all message creations, including your own".
  `payload.source` is `api` for messages sent through WAHA and `app` for the phone.

We subscribe to `message` (`WHATSAPP_HOOK_EVENTS=message`), so workflow 1b's `fromMe` branch
never runs. To mirror the owner's replies typed on the phone: subscribe to `message.any` and
treat `fromMe && source === 'app'` as the echo. Drop `source === 'api'`, because workflows 4/7
already record their own sends.

### 5.3 Chat IDs and LIDs

| Suffix | Meaning |
|---|---|
| `@c.us` | Phone-number account — use this form when sending |
| `@s.whatsapp.net` | Internal form inside NOWEB/GOWS `_data`; convert to `@c.us`, never send to it |
| `@lid` | "Hidden user ID" (Linked ID). "You can message anyone using either their LID or their PN" |
| `@g.us` | Group |
| `@newsletter` | Channel |
| `status@broadcast` | Status |

LID ↔ phone mapping: `GET /api/{session}/lids/{lid}` → `{ lid, pn }`, where `pn` may be `null`
if the number isn't in your contacts; `GET /api/{session}/lids/pn/{phone}` goes the other way.
Escape `@` as `%40`.

Verified here: NOWEB 2026.8.2 passes a LID sender through unchanged (`toCusFormat` keeps
`…@lid`). Workflow 1b takes the digits before `@` as a phone number, and workflows 4/7 then
send to `<digits>@c.us`. For a LID sender that is a different, possibly real, number.

The fix is to carry the full `chatId` through and send to it as-is. Map with the LIDs API only
where a phone number is needed for display.

### 5.4 Media

- `hasMedia` plus `media.url`. The URL needs the API key, and files are deleted after
  `WHATSAPP_FILES_LIFETIME` (default 180 s).
- `WAHA_EVENTS_DOWNLOAD_MEDIA=false` stops the download while keeping `mimetype`/`filename`
  (`media.url` becomes `null`).
- Workflow 1b does not process media yet, so `docker-compose.yml` sets
  `WAHA_EVENTS_DOWNLOAD_MEDIA=False`. Turning the download off avoids keeping personal
  photos and voice notes in the container for nothing.

---

## 6. Sending

**Docs** — [Send messages](https://waha.devlike.pro/docs/how-to/send-messages/),
[How to avoid blocking](https://waha.devlike.pro/docs/overview/how-to-avoid-blocking/).

### 6.1 sendText

`POST /api/sendText` takes `{ "session", "chatId", "text", "reply_to"?, "linkPreview"? }`.
`reply_to` gives a threaded reply, so WAHA *does* support what workflow 4's Meta branch does
with `context.message_id`. The gap is in our workflow code, not in WAHA.

**Response — the docs and NOWEB disagree.** The OpenAPI spec (`/-json` on the running
instance) declares `201 → WAMessage`, which has a string `id`. Verified here, in the image's
`dist/api/chatting.controller.js` and `dist/core/engines/noweb/session.noweb.core.js`, NOWEB's
`sendText` returns the Baileys `sock.sendMessage()` result untransformed:
`{ key: { remoteJid, fromMe, id }, message, messageTimestamp, status }`.

Read `typeof r.id === 'string' ? r.id : r.key?.id`.
`scripts/setup/build-workflows.js` (`WHATSAPP_INTERPRET_RESULT_LINES`) reads only `r.id`, so
every successful NOWEB send is recorded as FAILED.

### 6.2 Anti-blocking guidance

What the docs ask for:

- **Only reply, never initiate.** Let the customer open the chat, e.g. with a `wa.me/<number>?text=Hi` link.
- **Per message:** `POST /api/sendSeen`, then `POST /api/startTyping`, a random wait sized to
  the text, `POST /api/stopTyping`, then `sendText`.
- **Rules of thumb:** being reported as spam "a few times (5-10) will get you banned"; use random
  delays, no 24/7 sending, one short first message.

WhatsApp restrictions WAHA surfaces:

| Signal | Error | Check | What to do |
|---|---|---|---|
| Reachout Timelock | `463` sending to new contacts | `GET /api/sessions/{s}/timelock` | Pause new-contact sends until `timeEnforcementEnds`. **Do not** restart, logout or re-pair |
| Message Capping | `475` sending to new contacts | `GET /api/sessions/{s}/capping` | Slow down at `FIRST_WARNING`/`SECOND_WARNING`; stop at `CAPPED` until `cycleEnd`. **Do not** restart, logout or re-pair |

Both also arrive as a `WORKING` `session.status` event with the data. Both count only 1:1
messages to contacts with no existing chat.

This matters here because workflow 7 accepts a hand-typed phone number, which is exactly a cold
contact.

---

## 7. Operations

**Docs** — [Observability](https://waha.devlike.pro/docs/how-to/observability/),
[Dashboard](https://waha.devlike.pro/docs/how-to/dashboard/).

| Endpoint | Auth here | Use |
|---|---|---|
| `GET /ping` | none | Liveness |
| `GET /health` | key | Disk thresholds for media/sessions (`WHATSAPP_HEALTH_*_THRESHOLD_MB`, default 100) |
| `GET /api/server/version` | key | Version, engine, tier |
| `GET /api/server/environment[?all=true]` | key | WAHA env vars — **includes plain secrets**, see §3.2 |
| `GET /api/server/status` | key | Uptime |
| `POST /api/server/stop` | key | Stops the process; Docker's restart policy brings it back |
| `GET /api/sessions/{s}/me` | key | Linked account, `reachoutTimelock`, `messageCapping` |
| `GET /api/screenshot?session=…` | key | Screenshot (not meaningful on NOWEB) |
| `/dashboard/event-monitor` | Basic | Live view of events — the quickest way to see what WAHA would post to n8n |

Logs: `WAHA_LOG_LEVEL` (not `debug`/`trace` in production), `WAHA_HTTP_LOG_LEVEL` for the
per-request lines, `config.debug: true` for one session. Prometheus metrics are opt-in
(`WAHA_PROMETHEUS_ENABLED`).

**The n8n community node.** The docs point to `@devlikeapro/n8n-nodes-waha` (WAHA Actions and a
WAHA Trigger). This project deliberately uses plain HTTP Request nodes and a Code-node
receiver instead, with `N8N_UNVERIFIED_PACKAGES_ENABLED=false`. Keep it that way unless
there is a reason to widen n8n's package surface.

---

## 8. Page index

Official pages this reference was built from, for going deeper:

- Install: [Install & Update](https://waha.devlike.pro/docs/how-to/install/) · [Docker](https://waha.devlike.pro/blog/waha-on-docker/) · [Update](https://waha.devlike.pro/blog/waha-update/)
- Config: [Configuration](https://waha.devlike.pro/docs/how-to/config/) · [Storages](https://waha.devlike.pro/docs/how-to/storages/) · [Proxy](https://waha.devlike.pro/docs/how-to/proxy/)
- Security: [Security](https://waha.devlike.pro/docs/how-to/security/) · [Security alert](https://waha.devlike.pro/blog/security-alert/)
- Engine: [Engines](https://waha.devlike.pro/docs/how-to/engines/) · [NOWEB](https://waha.devlike.pro/docs/engines/noweb/)
- Sessions: [Sessions](https://waha.devlike.pro/docs/how-to/sessions/) · [Presence](https://waha.devlike.pro/docs/how-to/presence/) · [Dashboard](https://waha.devlike.pro/docs/how-to/dashboard/)
- Messages: [Events](https://waha.devlike.pro/docs/how-to/events/) · [Receive](https://waha.devlike.pro/docs/how-to/receive-messages/) · [Send](https://waha.devlike.pro/docs/how-to/send-messages/) · [Contacts / LIDs](https://waha.devlike.pro/docs/how-to/contacts/)
- Policy: [How to avoid blocking](https://waha.devlike.pro/docs/overview/how-to-avoid-blocking/) · [FAQ](https://waha.devlike.pro/docs/overview/faq/)
- Integration: [n8n](https://waha.devlike.pro/docs/integrations/n8n/)

When upgrading WAHA, re-check the rows marked **Verified here**. Most of them are about the
running image, not the docs, and can change with any release.
