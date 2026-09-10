# Troubleshooting

Symptom → cause → fix. Start with the diagnostic commands, then find your
symptom.

---

## Diagnostics

```bash
# Is n8n alive?
curl http://localhost:5678/healthz              # {"status":"ok"}
docker ps --filter name=n8n-whatsapp

# What does it say?
docker logs --tail 50 n8n-whatsapp

# Is configuration complete? (never prints secret values)
node scripts/validation/check-env.js

# Is the code sound?
node tests/run-tests.js                         # 169 passed
node scripts/validation/validate-workflows.js   # 414 passed

# Are the workflows imported?
node scripts/setup/import-workflows.js --list   # 6/6 [ok]

# Does the webhook respond?
node scripts/testing/send-fixture.js text-message.json
```

The n8n **Executions** list at <http://localhost:5678> shows each run node by
node and is usually the fastest way to see where something stopped. Code node
`console.log` output appears there, not in `docker logs`.

---

## n8n will not start

### `Error: Mismatching encryption keys`

**Cause.** `N8N_ENCRYPTION_KEY` in `.env` differs from the key stored inside the
Docker volume. n8n refuses to start rather than risk undecryptable credentials.

**Fix — pick one:**

- **Restore the original key** into `.env` (best, if you have it).
- **Use a fresh volume** if the old one holds nothing you need. Change the
  volume name in `docker-compose.yml`; the old volume stays on disk untouched so
  you can inspect it, and you can remove it later with
  `docker volume rm <name>`.
- **Remove the stale config file** from the volume (destroys stored credentials
  in that volume, not workflows):
  `docker run --rm -v <volume>:/data alpine rm -f /data/config`

Do **not** delete the volume without checking what is in it.

### Container restarts in a loop

```bash
docker logs --tail 60 n8n-whatsapp
```

Usually the encryption key, a malformed `.env` line, or a port conflict.

### Port 5678 already in use

```bash
# Windows
Get-NetTCPConnection -LocalPort 5678 -State Listen
# Linux/macOS
lsof -i :5678
```

Stop the other process, or change the published port in `docker-compose.yml`.

### `.env` values are ignored

A **UTF-8 BOM** on the first line makes Docker Compose fail to parse the first
variable — the name silently becomes `﻿N8N_ENCRYPTION_KEY`. This happens
when the file is written by PowerShell's `Set-Content -Encoding utf8`.

```powershell
$b=[System.IO.File]::ReadAllBytes(".env")
if($b[0] -eq 0xEF){[System.IO.File]::WriteAllBytes(".env",$b[3..($b.Length-1)])}
```

---

## No webhook events arriving

Work down this list in order.

### 1. Is the workflow published?

An unpublished (draft) workflow returns **404**. n8n 2.x separates draft from
published.

Publish workflow 1 in the UI, or:

```bash
docker exec n8n-whatsapp n8n publish:workflow --id=whatsappRecv0001
docker compose restart n8n
```

> Do **not** pipe that command into `head` — the pipe closing sends SIGPIPE and
> the CLI hangs indefinitely.

### 2. Are you using the right path?

```
https://<host>/webhook/whatsapp/webhook        ← production, give this to Meta
https://<host>/webhook-test/whatsapp/webhook   ← only live while the editor is open
```

### 3. Is the tunnel up and pointing at the current URL?

ngrok's free tier issues a **new URL on every restart**. If it restarted, Meta
is calling a dead address. Update both `N8N_WEBHOOK_URL` and the Meta dashboard.

### 4. Can Meta reach you at all?

```bash
curl "https://<host>/webhook/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test123"
# must print exactly: test123
```

If this fails from outside your network, Meta cannot reach it either.

### 5. Is the subscription configured?

*WhatsApp → Configuration → Webhook fields* must include **`messages`**.

### 6. Is the sender allowed?

In Development mode, only numbers on the allowed list can message you.

---

## Webhook returns an error

### 401 `invalid signature`

| Cause | Check |
|---|---|
| Wrong `META_APP_SECRET` | Re-copy from *App Settings → Basic* |
| Raw Body disabled | The POST node needs `rawBody: true`; rebuild and re-import |
| Testing with an unsigned request | Expected — use `scripts/testing/send-fixture.js`, which signs correctly |

The signature is computed over the **raw bytes**. If a proxy rewrites the body
(reformatting JSON, changing encoding), every signature will fail. Do not put a
body-modifying middlebox in front of this endpoint.

### 500 — logs say `access to env vars denied`

n8n 2.x blocks `$env` in nodes by default.

```yaml
- N8N_BLOCK_ENV_ACCESS_IN_NODE=false
```

Already set in `docker-compose.yml`; if you see this, the container is running
an older config — `docker compose up -d`.

### 500 — logs say `Error in workflow`

Open Executions and find the red node. Common causes: a missing credential, a
sheet tab name that does not match, or `$env` access as above.

### 403 on the verification handshake

`hub.verify_token` does not match `WEBHOOK_VERIFY_TOKEN`. Check for trailing
whitespace on either side, and restart n8n after changing `.env`.

If `WEBHOOK_VERIFY_TOKEN` is unset the handshake returns **500** by design —
the system fails closed rather than accepting any token.

---

## Google Sheets problems

### 403 `The caller does not have permission`

**The spreadsheet is not shared with the service account.** This is the most
common Sheets error by a wide margin.

Open the spreadsheet → Share → add the service account email (from the JSON key,
ends in `.iam.gserviceaccount.com`) → **Editor**.

### 404 `Requested entity was not found`

`GOOGLE_SHEET_ID` is wrong, or the tab name does not match. Tab names are
case-sensitive and must be exactly `Agents`, `Conversations`, `Messages`,
`Events`.

### 429 `Quota exceeded`

You are above **60 reads/minute per user**. Each inbound message costs several
reads, so this appears at roughly 10–15 messages/minute.

Short term: reduce the queue-retry frequency. Real fix:
[GOOGLE_SHEETS_TO_POSTGRES.md](GOOGLE_SHEETS_TO_POSTGRES.md).

### Rows written to the wrong place

Almost always caused by **deleting rows** while the system is running — deleting
shifts everything below, and an in-flight update then targets the wrong row.
Close conversations instead of deleting them.

---

## Assignment problems

### Two conversations went to the same agent at once

**Concurrency is not set to 1** on workflow 3. Set it in *Settings →
Concurrency*, or `N8N_CONCURRENCY_PRODUCTION_LIMIT=1`.

Then correct the counter:

```
open_conversations = COUNT(Conversations
                           WHERE assigned_agent_id = X
                             AND status != 'CLOSED')
```

Background: [ASSIGNMENT_ALGORITHM.md](ASSIGNMENT_ALGORITHM.md#concurrency-and-race-conditions).

### Everything goes to WAITING_FOR_AGENT

Check `unassigned_reason` in the Conversations row:

| Reason | Meaning |
|---|---|
| `NO_AGENTS_CONFIGURED` | Agents sheet empty or unreadable |
| `NO_ELIGIBLE_AGENT` | Agents exist but none qualify |

For `NO_ELIGIBLE_AGENT`, the Events row lists every agent and why each was
excluded. Usual causes: `active`/`available` not spelled in an accepted form
(anything unrecognized is treated as `FALSE` by design), or everyone at
capacity.

### One agent gets everything

Expected if their `open_conversations` is genuinely lowest. If the counter has
drifted, recompute it as above. Or switch to `ASSIGNMENT_STRATEGY=ROUND_ROBIN`.

### An agent is skipped

Check the Events audit for that conversation — it names the reason
(`INACTIVE`, `UNAVAILABLE`, `AT_CAPACITY`, `MALFORMED_RECORD`).

---

## Conversation problems

### Stuck on UNANSWERED even though the agent replied

**The agent replied from the WhatsApp app on their phone.**

Meta only emits webhooks for messages sent through the Cloud API. A reply sent
from the app is invisible to this system, so `last_agent_message_at` is never
set and the status never advances.

This is a platform constraint, not a bug —
[ARCHITECTURE.md](ARCHITECTURE.md#agent-access-model). Replies must go through
workflow 4.

### Duplicate conversations for one customer

Check whether `customer_phone` differs between the rows (e.g. `962791234567`
vs `0791234567`). Normalization should prevent this; if you see it, the rows
predate normalization or were added by hand.

Also check `business_phone_number_id` — two rows are **correct** if the customer
messaged two different business numbers.

### A closed conversation reopened unexpectedly

That is the default. Set `REOPEN_CLOSED_CONVERSATIONS=false` to change it.

---

## Outgoing message problems

### Error 190 — token expired

The temporary dashboard token lasts 24 hours. Create a System User token —
[META_WHATSAPP_SETUP.md](META_WHATSAPP_SETUP.md#step-3--get-a-token-that-does-not-expire).

### Error 131047 — re-engagement message

More than 24 hours have passed since the customer's last message. Only an
approved **template** can be sent now, and it is billable.

Not a fault — it is the platform's rule. It is also why answering within 24
hours matters financially, not just for service quality.

### Error 131030 — recipient not in allowed list

Development mode. Add the number, or take the app live.

### `SENT` but the customer never received it

`SENT` means **the Cloud API accepted the request**, not that it was delivered.
Wait for the status webhook to move it to `DELIVERED`. If it becomes `FAILED`,
the error code is recorded.

---

## Workflow / import problems

### Every import creates duplicate workflows

Fixed by pinned ids. If you see it, the JSON lacks its `id` field — rebuild:

```bash
node scripts/setup/build-workflows.js
```

Existing duplicates must be deleted in the UI; the n8n CLI has no delete command.

### `Workflow is not active and cannot be executed`

A sub-workflow called by Execute Workflow is not published. Publish workflows 2
and 3 and restart.

### A Code node throws a syntax error

```bash
node scripts/validation/validate-workflows.js
```

It compiles every Code node body and names the offending node. If it passes but
n8n still fails, the workflow in n8n is stale — re-import.

### `import:workflow --activeState=fromJson` fails

That flag needs queue or multi-main mode. In a regular deployment, publish
instead.

---

## Still stuck

Collect this before asking for help:

```bash
docker logs --tail 100 n8n-whatsapp > n8n-logs.txt
node scripts/validation/check-env.js > env-check.txt      # safe: no values
node tests/run-tests.js > test-results.txt
node scripts/validation/validate-workflows.js > workflow-validation.txt
docker compose config > compose-resolved.txt              # REVIEW: may contain secrets
```

**Redact before sharing.** `check-env.js` output is safe by construction;
`docker compose config` resolves `.env` and will contain real values.
