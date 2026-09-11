# Setup

Local development setup, start to finish. Assumes Docker Desktop and Node.js
are installed.

Estimated time: **15 minutes** without Meta/Google credentials (everything up to
step 6), **45 minutes** with them.

---

## Step 1 — Configure the environment

```bash
cp .env.example .env
```

Now generate the n8n encryption key and put it in `.env`:

```bash
# macOS / Linux / Git Bash
openssl rand -hex 32
```

```powershell
# Windows PowerShell
$b = New-Object byte[] 32
([System.Security.Cryptography.RNGCryptoServiceProvider]::new()).GetBytes($b)
-join ($b | ForEach-Object { $_.ToString("x2") })
```

Set it as `N8N_ENCRYPTION_KEY`.

> **This key is not optional.** If n8n generates its own, the key exists only
> inside the Docker volume — restore that volume somewhere else and every stored
> credential becomes undecryptable. Back this value up with your data.
>
> If you later change it, n8n will refuse to start with
> `Mismatching encryption keys`. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

Also choose a `WEBHOOK_VERIFY_TOKEN` — any random string you invent. You will
paste the same value into the Meta dashboard later.

Everything else can stay empty for now.

---

## Step 2 — Start n8n

```bash
docker compose up -d
docker compose logs -f n8n     # Ctrl-C once you see "Editor is now accessible"
```

Verify:

```bash
curl http://localhost:5678/healthz
# {"status":"ok"}
```

Open <http://localhost:5678> and create the owner account when prompted. This is
local — it is not exposed to the internet.

**Data persistence.** n8n's database lives in the named Docker volume
`n8n_whatsapp_data`. `docker compose down` does **not** delete it; only
`docker compose down -v` would. To verify persistence, restart and confirm your
workflows are still there:

```bash
docker compose restart n8n
```

---

## Step 3 — Run the tests

These need no credentials and prove the core logic works:

```bash
node tests/run-tests.js
# 169 passed, 0 failed
```

---

## Step 4 — Build and import the workflows

```bash
node scripts/setup/build-workflows.js       # generates n8n/workflows/*.json
node scripts/validation/validate-workflows.js   # 414 checks
node scripts/setup/import-workflows.js      # imports into the container
```

The import is idempotent — workflow ids are pinned, so running it repeatedly
updates the same eight workflows instead of creating duplicates.

---

## Step 5 — Create the credentials

n8n stores credentials **encrypted in its own database**, separately from
`.env`. This trips people up, so to be explicit:

| What | Where it goes | Why |
|---|---|---|
| `META_ACCESS_TOKEN`, `META_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`, `GOOGLE_SHEET_ID` | **`.env`** | Read by Code nodes via `$env` |
| Google Sheets service account | **n8n UI → Credentials** | The Sheets node needs a credential object, not a variable |
| Meta bearer token for HTTP requests | **n8n UI → Credentials** | Keeps the token out of exported workflow JSON |

### 5a — Google Sheets credential

1. In [Google Cloud Console](https://console.cloud.google.com), create (or pick)
   a project.
2. Enable the **Google Sheets API**.
3. *IAM & Admin → Service Accounts → Create service account*.
4. Create a **JSON key** and download it.
5. Open your spreadsheet and **share it with the service account's email address
   as an Editor**. This step is the one people forget — without it every Sheets
   node returns 403.
6. In n8n: *Credentials → New → Google Sheets → Service Account*. Paste the
   service account email and the private key from the JSON (including the
   `-----BEGIN PRIVATE KEY-----` lines).
7. Name it exactly **`Google Sheets — WhatsApp Support`**.

### 5b — Meta token credential

1. In n8n: *Credentials → New → **Header Auth***.
2. Name: `Authorization`
3. Value: `Bearer YOUR_META_ACCESS_TOKEN`
4. Name the credential exactly **`Meta WhatsApp Token`**.

Using a credential rather than putting the token in the node means an exported
workflow cannot leak it.

### 5c — Attach the credentials

Open each workflow and assign:

- every **Google Sheets** node → the Sheets credential
- the **Send Via Cloud API** node in workflow 4 → `Meta WhatsApp Token`

---

## Step 6 — Set up the spreadsheet

Follow [GOOGLE_SHEETS_SCHEMA.md](GOOGLE_SHEETS_SCHEMA.md): create four tabs
named `Agents`, `Conversations`, `Messages`, `Log`, paste the header rows
from [`sheets-templates/`](../sheets-templates/), freeze row 1, and put the
spreadsheet id in `GOOGLE_SHEET_ID`.

Add your real agents to the `Agents` tab. Set `open_conversations` to `0` and
leave `last_assigned_at` blank.

Restart so the new `.env` values are picked up:

```bash
docker compose up -d
```

---

## Step 7 — Configure the workflows

In the n8n UI:

1. **Error workflow** — open workflows 1–5, 7 and 8, *Settings → Error Workflow* →
   `WhatsApp — 6 Error Handler`.
2. **Concurrency** — open `WhatsApp — 3 Conversation & Assignment`,
   *Settings → Concurrency* → **1**.
   This is what prevents two simultaneous conversations being assigned to the
   same agent. Do not skip it —
   [ASSIGNMENT_ALGORITHM.md](ASSIGNMENT_ALGORITHM.md#concurrency-and-race-conditions)
   explains why.
3. **Publish** workflows 1, 2 and 3 (always required). Publish 4, 5, 7 and 8
   only once their credentials are configured — a scheduled workflow with no
   credential fails on every tick and fills the execution log with noise.

> **n8n 2.x uses a draft/published model.** A workflow only runs once
> *published*, and a sub-workflow called by Execute Workflow must be published
> too — otherwise the caller fails with
> `Workflow is not active and cannot be executed`.
>
> Publishing from the UI is instant. The CLI equivalent
> (`n8n publish:workflow --id=<id>`) works but is slow and requires an n8n
> restart afterwards. `import:workflow --activeState=fromJson` only works in
> queue or multi-main mode, not in this single-instance deployment.

---

## Step 8 — Test locally, without Meta

This exercises the real workflows without contacting Meta and without sending a
message to anyone.

```bash
# Verification handshake (use your own WEBHOOK_VERIFY_TOKEN)
curl "http://localhost:5678/webhook/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test123"
# -> test123

# Signed event delivery
node scripts/testing/send-fixture.js text-message.json
# -> HTTP 200 "EVENT_RECEIVED"

# Rejection paths
node scripts/testing/send-fixture.js text-message.json --bad-signature   # -> 401
node scripts/testing/send-fixture.js text-message.json --no-signature    # -> 401

# Duplicate handling
node scripts/testing/send-fixture.js text-message.json --twice
```

Then check *Executions* in the n8n UI to see what each workflow did.

Full test procedures: [TESTING.md](TESTING.md).

---

## Step 9 — Expose the webhook to Meta

Meta must reach your machine over **public HTTPS**. `localhost` will not work.

### Option A — ngrok

```bash
ngrok http 5678
```

Copy the `https://….ngrok-free.app` URL, then set it in `.env` and restart:

```bash
N8N_WEBHOOK_URL=https://your-id.ngrok-free.app/
```

```bash
docker compose up -d
```

> The free tier gives a **new URL every restart**, and you must update the Meta
> dashboard each time. A paid static domain avoids this.

### Option B — Cloudflare Tunnel

Longer-lived and free for a domain you own:

```bash
cloudflared tunnel --url http://localhost:5678
```

For a persistent named tunnel, follow Cloudflare's current documentation —
`cloudflared` is not installed on this machine by default.

### Your webhook URL

```
https://<your-tunnel-host>/webhook/whatsapp/webhook
```

Note `/webhook/` (production). n8n also exposes `/webhook-test/` which only
fires while you have the editor open with "Listen for test event" active — do
not give that URL to Meta.

---

## Step 10 — Connect Meta

Follow [META_WHATSAPP_SETUP.md](META_WHATSAPP_SETUP.md) to create the app, get
the phone number id and token, and register the callback URL and verify token.

---

## Verifying the whole thing works

| Check | Command | Expected |
|---|---|---|
| n8n healthy | `curl localhost:5678/healthz` | `{"status":"ok"}` |
| Unit tests | `node tests/run-tests.js` | 169 passed |
| Workflows valid | `node scripts/validation/validate-workflows.js` | 414 passed |
| Workflows imported | `node scripts/setup/import-workflows.js --list` | 6/6 `[ok]` |
| Verification handshake | curl in step 8 | challenge echoed |
| Signed delivery | `node scripts/testing/send-fixture.js` | `200 EVENT_RECEIVED` |
| Data survives restart | `docker compose restart n8n` | workflows still present |

---

## Common first-run problems

| Symptom | Cause | Fix |
|---|---|---|
| `Mismatching encryption keys` | `N8N_ENCRYPTION_KEY` differs from the one in the volume | Restore the original key, or use a fresh volume |
| Webhook returns 404 | Workflow not published | Publish workflow 1, then restart n8n |
| Webhook returns 500, log says `access to env vars denied` | `N8N_BLOCK_ENV_ACCESS_IN_NODE` not set to `false` | Already set in `docker-compose.yml`; restart |
| Signed request returns 401 | `META_APP_SECRET` mismatch, or Raw Body disabled | Check `.env`; the Webhook node needs `rawBody: true` |
| Sheets nodes return 403 | Spreadsheet not shared with the service account | Share it as Editor |
| `Workflow is not active and cannot be executed` | Sub-workflow not published | Publish workflows 2 and 3 |

More: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
