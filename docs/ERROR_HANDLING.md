# Error Handling

Every failure mode from the specification, what the system actually does about
it, and what is deliberately deferred.

**Principle:** a failure must be *visible* and must not corrupt state. Where
something cannot be handled, it is recorded rather than swallowed.

---

## External service failures

### Meta API outage

**Symptom.** Outgoing sends time out or return 5xx.

**Handling.** The HTTP Request node retries 3× with backoff and a 15s timeout.
`neverError: true` means the response is inspected rather than thrown, so the
failure is interpreted: status `FAILED`, error code recorded, conversation and
message rows still written.

**Not handled.** Inbound messages during a Meta outage are lost from our side —
Meta buffers and retries, but if it cannot reach us and eventually gives up,
those events are gone. There is no way to poll for missed messages.

### Google Sheets API failure

**Symptom.** Sheets nodes return 5xx, 403, or time out.

**Handling.** Sheets nodes use `continueErrorOutput` so the branch continues and
the error is captured. The webhook has already returned 200, so Meta does not
retry — meaning a Sheets outage loses the *record* of a message, not the
acknowledgement.

**Trade-off, stated plainly.** Acking before persistence means a persistence
failure cannot be recovered by a Meta retry. The alternative — persist first,
ack second — makes slow Sheets calls cause duplicate deliveries, which is worse
and more common. See [DECISIONS.md](DECISIONS.md#d-008--acknowledge-the-webhook-before-doing-any-work).

**Mitigation.** The n8n execution log retains the full payload, so a message
lost from Sheets is recoverable by hand from the execution record.

### Rate limits

| Service | Limit | Response |
|---|---|---|
| Google Sheets | 60 reads/min/user | 429. Node retries; sustained overload needs Postgres |
| Meta Cloud API | 80 msg/s | 429 with `Retry-After` |

Google Sheets is the binding constraint at roughly **10–15 inbound messages per
minute**, because each message costs several reads. This is the migration
trigger, not storage size.

### Expired access token

**Symptom.** Every send fails with error code `190`.

**Handling.** Recorded as `FAILED` with the code in the Events sheet.

**Cause, almost always.** The temporary dashboard token expired after 24 hours.
Fix by creating a System User token —
[META_WHATSAPP_SETUP.md](META_WHATSAPP_SETUP.md#step-3--get-a-token-that-does-not-expire).

**Not handled.** No automatic token refresh. A System User token with no expiry
makes this unnecessary; adding refresh logic would add a failure mode for no
benefit.

---

## Webhook-level failures

### Invalid / forged webhook

Signature mismatch ⇒ `401`, nothing processed. Verified live.

### Duplicate webhook

**Handling.** `dedupe_key` lookup before any write. A replayed event produces no
new conversation, no new message, and no assignment.

Because status callbacks reuse the message id, their key includes the status —
otherwise `delivered` would be discarded as a duplicate of `sent` and delivery
tracking would silently never work.

### Malformed webhook

**Handling.** The parser never throws. Non-object bodies, missing `entry`,
`null` elements, and wrong-typed arrays all return a structured reason. The
endpoint still returns **200** — a malformed payload will be just as malformed
on retry, so asking Meta to resend achieves nothing but load.

Verified against nine hostile input shapes plus the `malformed-payload.json`
fixture.

### Out-of-order events

**Status arriving before the message row.** Recorded as `deferred` with
`MESSAGE_ROW_NOT_FOUND`. Normal under concurrency, not an error.

**`read` before `delivered`.** The monotonic ladder refuses the downgrade.

**Message record before assignment.** Assignment and message rows are written in
the same execution, so this cannot occur within one message. Across messages,
the conversation lookup handles it.

---

## Data and state failures

### Concurrent incoming messages

The central limitation. Fully documented in
[ASSIGNMENT_ALGORITHM.md](ASSIGNMENT_ALGORITHM.md#concurrency-and-race-conditions).

| Case | Protected |
|---|---|
| Same event twice | Yes — dedupe |
| Same customer, rapid messages | Yes — dedupe + conversation lookup |
| Two customers, one n8n instance | Yes — concurrency 1 |
| Two customers, multiple instances | **No** — needs Postgres |

### Manual editing of the sheet

**Handling.** Every field is parsed defensively:

- Unrecognized booleans ⇒ `false` (fail closed — never route to an agent whose
  availability cannot be confirmed)
- Non-numeric capacity ⇒ documented default, never `NaN`
- Missing `agent_id` ⇒ that row excluded as `MALFORMED_RECORD`, **others still
  work**

**Not handled.** Deleting a row while the system is running shifts every row
below it, and an in-flight update can then write to the wrong row. Google Sheets
provides no way to prevent this. **Close conversations instead of deleting
them.**

### Duplicate records in Sheets

**Not prevented** — Sheets has no uniqueness constraint. The lookup takes the
most recently active match, so duplicates degrade reporting rather than routing.
Postgres fixes this with a primary key.

### Row not found

Lookup nodes use `alwaysOutputData`, so "not found" is an empty item the logic
branches on, not a dead branch. Distinct paths exist for "no conversation" (create
one) and "no message row for this status" (defer).

### Counter drift

`open_conversations` is denormalized and can drift. It is always recomputable:

```
COUNT(Conversations WHERE assigned_agent_id = X AND status != 'CLOSED')
```

---

## Message-level failures

### Unsupported message type

Recorded with `supported=false`, `processing_status=unsupported`, and the type
name preserved. The workflow does not crash. Meta can add a type tomorrow and
the system keeps running.

### Media, voice notes, documents, stickers, location, contacts, interactive

All parsed with a readable preview (`[image] caption`, `[document] invoice.pdf`,
`[location] Amman City Center`). Media `id` and `mime_type` are stored so files
can be fetched later.

**Deferred:** downloading and storing media. The reference is kept, which is
what makes adding it later cheap.

### Rapid consecutive messages

Each message is a separate item with its own dedupe key. Order within a batch is
preserved. The conversation stays `UNANSWERED` — repeated messages do not
produce repeated writes because the state machine reports `changed: false`.

### Multiple business numbers

`business_phone_number_id` is extracted per change and is part of the
conversation key, so two business numbers never share a conversation. Asserted
by the batched fixture.

---

## Infrastructure failures

### n8n restart

`restart: unless-stopped` brings it back. Workflows, credentials and executions
survive in the named volume. In-flight executions are lost; Meta retries any
unacked webhook, and dedupe prevents double-processing.

Verified — the container was restarted many times during development with no
data loss.

### Docker restart / host reboot

Same. Verified.

### Timezone errors

All timestamps stored **ISO-8601 UTC**, always `Z`-suffixed. `TZ` and
`GENERIC_TIMEZONE` affect display and cron only. Storing local time would make
Amman's DST transitions corrupt ordering twice a year.

Unparseable timestamps return `null` rather than `Invalid Date`, and the
inactivity check refuses to act on a row whose date it cannot read — so a bad
cell cannot cause a wrongful close.

---

## The error workflow

Workflow 6 catches failures from workflows 1–5, 7 and 8 and writes a redacted row to
Events.

**Redaction first.** n8n error payloads can include the failing request's
headers, including `Authorization: Bearer …`. Writing that raw into a shared
spreadsheet would leak a live token.

**Its own limitation:** if Sheets is what failed, this cannot log to Sheets
either. n8n's execution log is the fallback.

---

## Deliberately deferred

| Deferred | Why | Consequence |
|---|---|---|
| Media download | Reference is stored; adding it later is cheap | Files stay on Meta's servers (~30 days) |
| Template messages | Needs Meta approval per template | Replies after 24h fail with 131047, visibly |
| Automatic token refresh | System User tokens do not expire | Manual rotation if a short-lived token is used |
| Retry queue for failed Sheets writes | Adds a durable queue and its own failure modes | Failed writes are in the execution log, recoverable by hand |
| Alerting | No channel chosen yet | Failures are recorded, not pushed |
| Auto-close on inactivity | Destructive; needs evidence first | Eligibility computed, action manual |
| Cross-instance locking | Requires Postgres | Single-instance only |

---

## Quick reference

| Symptom | Likely cause | Where to look |
|---|---|---|
| 404 on webhook | Workflow not published | [SETUP.md](SETUP.md#step-7--configure-the-workflows) |
| 401 on every POST | App secret mismatch, or Raw Body off | [SECURITY.md](SECURITY.md) |
| 500, "access to env vars denied" | `N8N_BLOCK_ENV_ACCESS_IN_NODE` | [ENVIRONMENT.md](ENVIRONMENT.md) |
| Sends fail with 190 | Token expired | [META_WHATSAPP_SETUP.md](META_WHATSAPP_SETUP.md#step-3--get-a-token-that-does-not-expire) |
| Sends fail with 131047 | Outside the 24-hour window | [META_WHATSAPP_SETUP.md](META_WHATSAPP_SETUP.md#the-24-hour-customer-service-window) |
| Sheets 403 | Spreadsheet not shared with the service account | [SETUP.md](SETUP.md#5a--google-sheets-credential) |
| "Workflow is not active" | Sub-workflow not published | [N8N_WORKFLOWS.md](N8N_WORKFLOWS.md#publishing) |
| Two conversations to one agent | Concurrency not set to 1 | [ASSIGNMENT_ALGORITHM.md](ASSIGNMENT_ALGORITHM.md) |
| Conversation stuck UNANSWERED | Agent replied from the WhatsApp app | [ARCHITECTURE.md](ARCHITECTURE.md#agent-access-model) |

Step-by-step diagnosis: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
