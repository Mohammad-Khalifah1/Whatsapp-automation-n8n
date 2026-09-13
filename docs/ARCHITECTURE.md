# Architecture

## Contents

- [System overview](#system-overview)
- [Component responsibilities](#component-responsibilities)
- [Data flow: a customer message end to end](#data-flow-a-customer-message-end-to-end)
- [Conversation state machine](#conversation-state-machine)
- [Conversation identity](#conversation-identity)
- [Phone number normalization](#phone-number-normalization)
- [Idempotency model](#idempotency-model)
- [Agent access model](#agent-access-model)
- [Message type support](#message-type-support)
- [Failure modes](#failure-modes)
- [Security model](#security-model)
- [Designed-for migrations](#designed-for-migrations)

---

## System overview

```
┌─────────────────┐
│ WhatsApp        │  Customer sends a message
│ customer        │
└────────┬────────┘
         │
         v
┌─────────────────────────────┐
│ Meta WhatsApp Cloud API     │  Meta hosts this. We never run WhatsApp
│ (graph.facebook.com)        │  infrastructure ourselves.
└────────┬────────────────────┘
         │ HTTPS POST, HMAC-SHA256 signed
         │ (retried by Meta if not acked)
         v
┌─────────────────────────────────────────────────────────┐
│ n8n (Docker)                                            │
│                                                          │
│  [1] Webhook Receiver                                    │
│      • GET  → verify handshake (hub.challenge)           │
│      • POST → verify X-Hub-Signature-256                 │
│      • ACK 200 IMMEDIATELY, then hand off                │
│               │                                          │
│               v                                          │
│  [2] Message Processor                                   │
│      • parse (all entries/changes, never just the first) │
│      • normalize phone numbers                           │
│      • deduplicate on Meta message id                    │
│      • route: message | status | other                   │
│               │                                          │
│               v                                          │
│  [3] Conversation & Assignment                           │
│      • find or create conversation                       │
│      • select least-loaded eligible agent                │
│      • persist assignment + message + audit              │
│                                                          │
│  [4] Outgoing Agent Message  (agent replies)             │
│  [5] Unassigned Queue Retry  (every 5 min)               │
│  [6] Error Handler           (redacted failure log)      │
└────────┬─────────────────────────────────┬───────────────┘
         │                                 │
         v                                 v
┌──────────────────────┐        ┌──────────────────────────┐
│ Google Sheets        │        │ Meta Cloud API           │
│ • Agents             │        │ POST /{ver}/{id}/messages│
│ • Conversations      │        └──────────────────────────┘
│ • Messages           │
│ • Log (audit)       │
└──────────────────────┘
```

### Why this shape

**Meta hosts the WhatsApp side.** We do not run a WhatsApp gateway, manage
device sessions, or maintain a phone farm. The Cloud API is the integration
point, which is why this system is a *webhook consumer plus an HTTP client*
rather than a messaging server.

**n8n is the orchestration layer, not the database.** It holds workflow logic
and credentials. All durable state lives in Google Sheets (and later
PostgreSQL), so n8n can be restarted, rebuilt, or moved to another host without
losing conversations.

**Business logic is pure and lives outside n8n.** Everything in `scripts/lib/`
is I/O-free and unit-tested. n8n Code nodes receive an inlined copy at build
time. This is what makes the system testable without Meta or Google
credentials, and it is what will make the PostgreSQL migration a change of
*callers* rather than a rewrite.

---

## Component responsibilities

| Component | Owns | Explicitly does NOT own |
|---|---|---|
| Meta Cloud API | Message delivery, delivery receipts, phone number identity | Any business state |
| Workflow 1 (Receiver) | Authenticity (signature), fast acknowledgement | Parsing, persistence, routing |
| Workflow 2 (Processor) | Parsing, normalization, deduplication, event routing | Conversation semantics, assignment |
| Workflow 3 (Conversation) | Conversation lifecycle, agent selection, persistence | HTTP concerns, signature checks |
| Workflow 4 (Outgoing) | Sending replies, recording outbound messages | Deciding *what* to say |
| Workflow 5 (Queue Retry) | Draining `WAITING_FOR_AGENT` | Initial assignment |
| Workflow 6 (Error Handler) | Recording failures with secrets redacted | Recovery decisions |
| Google Sheets | Durable state, manager-facing reporting | Transactions, locking, referential integrity |
| `scripts/lib/` | All decision logic | Any I/O whatsoever |

---

## Data flow: a customer message end to end

Following the specification's worked example — a customer sends
`مرحبا، بدي أعرف السعر.`

| # | Step | Where | Notes |
|---|---|---|---|
| 1 | Customer sends message | WhatsApp | — |
| 2 | Meta POSTs a signed webhook | Meta → WF1 | Retried if we do not ack |
| 3 | Verify `X-Hub-Signature-256` over **raw bytes** | WF1 | Re-serialized JSON would fail; the Webhook node uses `rawBody` |
| 4 | **Respond 200 `EVENT_RECEIVED`** | WF1 | Before any Sheets I/O — slow storage must never trigger a Meta retry |
| 5 | Hand off asynchronously | WF1 → WF2 | `waitForSubWorkflow: false` |
| 6 | Parse every entry/change/message | WF2 | Batched webhooks fan out to one item each |
| 7 | Normalize `962791234567`, build `wa.me` link | WF2 | See [phone normalization](#phone-number-normalization) |
| 8 | Build dedupe key `message:wamid...` and correlation id | WF2 | See [idempotency](#idempotency-model) |
| 9 | Look up the dedupe key in Messages | WF2 → Sheets | Already seen ⇒ stop, do nothing |
| 10 | Find an open conversation for (customer, business number) | WF3 → Sheets | Scoped per business number |
| 11 | None found ⇒ create one, `WAITING_FOR_AGENT` | WF3 | Stable internal id, never the message id |
| 12 | Read Agents, evaluate eligibility | WF3 → Sheets | active ∧ available ∧ under capacity |
| 13 | Select fewest open, tie-break by `last_assigned_at`, then `agent_id` | WF3 | Deterministic |
| 14 | Increment the chosen agent's `open_conversations` | WF3 → Sheets | **Not atomic** — see assignment doc |
| 15 | Write the conversation row, status `UNANSWERED`, `unread=TRUE` | WF3 → Sheets | |
| 16 | Append the message row | WF3 → Sheets | One row per message, never in Conversations |
| 17 | Append an audit event including who was excluded and why | WF3 → Sheets | |

Resulting Conversations row:

| conversation_id | customer_phone | assigned_agent_name | status | last_message | unread | wa_link |
|---|---|---|---|---|---|---|
| CONV-106540352242922-962791234567-1788969600000 | 962791234567 | Mohammad | UNANSWERED | بدي أعرف السعر | TRUE | https://wa.me/962791234567 |

---

## Conversation state machine

### States

The MVP uses **five** states rather than the eight originally sketched. Two
pairs were collapsed deliberately, and the reasoning is recorded in
[DECISIONS.md](DECISIONS.md#d-006-five-conversation-states-not-eight):

| State | Meaning | Counts as open? |
|---|---|---|
| `WAITING_FOR_AGENT` | Created, but no eligible agent existed. In the retry queue. | Yes |
| `UNANSWERED` | Assigned to an agent; the customer's latest message has no reply yet. | Yes |
| `REPLIED` | The agent's message is the most recent one. | Yes |
| `WAITING_FOR_CUSTOMER` | Synonym of `REPLIED` for manager filtering. Reserved; not written by the MVP. | Yes |
| `CLOSED` | Explicitly ended by a human or automation. | No |

`OPEN` is **not** a state — it is the set `status != CLOSED`. Having both would
permit contradictory rows (`OPEN` *and* `UNANSWERED`). `ASSIGNED` is not a
state either: a conversation is assigned and awaiting a first reply in the same
execution, so the state could never be observed.

### Transitions

```
                    customer message
              ┌──────────────────────────┐
              │                          │
              v                          │
      ┌──────────────────┐               │
      │ WAITING_FOR_AGENT│               │
      └────────┬─────────┘               │
               │ agent assigned          │
               v                         │
      ┌──────────────────┐               │
   ┌─>│   UNANSWERED     │───────────────┘
   │  └────────┬─────────┘
   │           │ agent replies
   │           v
   │  ┌──────────────────┐
   │  │     REPLIED      │
   │  └────────┬─────────┘
   │           │ customer replies
   └───────────┘
               │ close
               v
      ┌──────────────────┐
      │      CLOSED      │──── customer message (reopen) ──┐
      └──────────────────┘                                 │
               ^                                            │
               └────────────────────────────────────────────┘
```

| Event | From | To | Notes |
|---|---|---|---|
| Customer message | *(none)* | `UNANSWERED` if an agent was assigned, else `WAITING_FOR_AGENT` | New conversation |
| Customer message | `REPLIED` | `UNANSWERED` | The business owes a reply again |
| Customer message | `UNANSWERED` | `UNANSWERED` | No write — avoids pointless Sheets traffic |
| Customer message | `WAITING_FOR_AGENT` | `WAITING_FOR_AGENT` | Still nobody to route to |
| Customer message | `CLOSED` | `UNANSWERED` / `WAITING_FOR_AGENT` | **Reopens by default**; clears `closed_at` |
| Agent assigned | `WAITING_FOR_AGENT` | `UNANSWERED` | |
| Agent assigned | `CLOSED` | `CLOSED` | Refused — cannot assign a closed conversation |
| Agent message | any non-closed | `REPLIED` | Sets `unread=FALSE` |
| Agent message | `CLOSED` | `REPLIED` | Deliberate re-engagement, reopens |
| Close | any | `CLOSED` | Sets `closed_at` |
| Reopen | `CLOSED` | `UNANSWERED` / `WAITING_FOR_AGENT` | Manual |
| Reopen | non-closed | unchanged | No-op, not an error |

### Answering the specific questions

- **What creates a transition?** Only the six events above. Nothing else writes
  `status`.
- **What reopens a conversation?** A customer message on a `CLOSED`
  conversation (default), an agent message on a `CLOSED` conversation, or an
  explicit reopen. Set `REOPEN_CLOSED_CONVERSATIONS=false` to disable the first.
- **Who can close?** A human, or an explicitly enabled scheduled workflow.
  **Customers never close conversations.**
- **When does `unread` become FALSE?** When an agent sends a message through
  workflow 4. Reading a Google Sheet cannot mark anything read — the system has
  no way to observe that.
- **When does an agent become available again?** When their
  `open_conversations` drops below `max_open_conversations`, which happens when
  a conversation is closed. `available` is a manual on/off switch owned by the
  agent or their manager (e.g. for breaks).
- **What happens after a customer replies to a closed conversation?** It
  reopens with the *same* `conversation_id`, preserving history.
- **Do closed conversations reopen automatically?** Yes, by default, on a
  customer message. This is configurable.
- **Timeout policy?** `CONVERSATION_INACTIVITY_HOURS` (default 24) marks a
  conversation *eligible* for closing. **The MVP does not auto-close.**
  Eligibility is computed and exposed; acting on it is a deliberate, separate
  step. See [DECISIONS.md](DECISIONS.md#d-009-inactivity-does-not-auto-close).

---

## Conversation identity

```
CONV-<business_phone_number_id>-<customer_phone_e164>-<epoch_millis>
```

Example: `CONV-106540352242922-962791234567-1788969600000`

**Never the WhatsApp message id.** A `wamid` identifies one message; using it as
a conversation key would create a new conversation for every message sent.

Three properties matter:

1. **Scoped by business number** — the same customer messaging two of your
   business numbers gets two independent conversations, which is what a
   multi-number WABA requires.
2. **Unique across reopen cycles** — the timestamp suffix means a genuinely new
   conversation (after an old one was closed and a new one created) never
   collides with the old one, so closed history is preserved.
3. **Sanitized** — non-alphanumeric characters are stripped so the id is safe
   as a spreadsheet key and in a URL.

A customer normally maps to **one active conversation per business number**.
The lookup selects the most recently active non-closed row.

---

## Phone number normalization

All phone numbers are stored as **E.164 digits with no leading `+`**, matching
the format Meta uses for `wa_id` and `from`. The `+` form and the `wa.me` link
are derived, never stored.

### Rules, in order

| # | Rule | Example |
|---|---|---|
| 1 | Transliterate Arabic-Indic digits | `٠٧٩١٢٣٤٥٦٧` → `0791234567` |
| 2 | Reject anything containing letters | `07912ABCDE` → rejected |
| 3 | Strip formatting: spaces, `-`, `(`, `)`, `.` | `+962 79-123 4567` → `+962791234567` |
| 4 | Leading `+` → drop it (already E.164) | `+962791234567` → `962791234567` |
| 5 | Leading `00` (IDD prefix) → drop it | `00962791234567` → `962791234567` |
| 6 | Leading `0` (national trunk) → replace with country code | `0791234567` → `962791234567` |
| 7 | Enforce E.164 bounds (8–15 digits) | `12345` → rejected as `TOO_SHORT` |
| 8 | Flag ambiguity rather than guessing | `791234567` → `AMBIGUOUS_MISSING_COUNTRY_CODE` |

All four Jordanian forms converge on `962791234567`:
`0791234567`, `+962791234567`, `962791234567`, `00962791234567`.

### On ambiguity

`791234567` *looks* like a Jordanian mobile missing its trunk zero — but
guessing could message a completely different person in another country. So the
result is returned with `ambiguous: true` and a reason, and the caller decides:

- **Inbound** (`normalizePhone`) — accept the best-effort value, since Meta's
  `wa_id` is already E.164 and ambiguity should never arise.
- **Outbound** (`normalizePhoneStrict`) — treat ambiguity as failure. Never
  send a message to a number we had to guess.

`buildWaLink()` returns `null` rather than a malformed URL, so an
unnormalizable number can never produce `https://wa.me/+962 79 123 4567`.

---

## Idempotency model

Meta retries any webhook it does not receive a timely `200` for, so **the same
event will arrive more than once**. Without protection this produces duplicate
messages, duplicate conversations, and double-counted agent load.

### Layer 1 — deduplication key (reliable)

| Event kind | Key | Why |
|---|---|---|
| Message | `message:<wamid>` | The Meta message id is globally unique and stable across retries |
| Status | `status:<wamid>:<STATUS>` | The **same** message id arrives repeatedly as `sent`→`delivered`→`read`. Keying on the id alone would discard genuine progression as a "duplicate" |
| Other | `other:<sha256 of identifying fields>` | Stops repeated anomalies flooding the audit log |

### Layer 2 — monotonic status ladder

`PENDING < ACCEPTED < SENT < DELIVERED < READ`, with `FAILED` special-cased.

Meta does not guarantee ordering, so a late `delivered` can arrive after `read`.
The ladder refuses to downgrade. `FAILED` overrides an in-flight status and is
then terminal — a late `delivered` cannot resurrect a failed message.

### Layer 3 — fast acknowledgement

Workflow 1 responds `200` *before* any Google Sheets I/O. This removes the most
common cause of retries in the first place: slow downstream storage.

### Layer 4 — serialization (the weak one)

Assignment is not atomic on Google Sheets. This is honestly documented in
[ASSIGNMENT_ALGORITHM.md](ASSIGNMENT_ALGORITHM.md#concurrency-and-race-conditions)
rather than papered over.

---

## Agent access model

Agents can reply four ways. Three of them are tracked; one is not, and the
difference is about **which phone number** sends the message, not which app.

### Four distinct message paths

| | Path | Visible to this system? |
|---|---|---|
| **A** | Customer → Cloud API → webhook | **Yes.** Fully tracked. |
| **B** | Agent → workflow 4 (API) → customer | **Yes.** Tracked, with delivery status. |
| **C** | Manager types in the sheet → workflow 7 → customer | **Yes.** Tracked, `sent_via = google_sheet`. |
| **D** | Agent → **WhatsApp Business App on the business number** → customer | **Yes, if Coexistence is enabled** — `sent_via = whatsapp_business_app`. |
| **E** | Agent → **their own personal WhatsApp** → customer | **No. Invisible.** |

### What changed

This section previously described path D as permanently invisible, on the
grounds that Meta only emits webhooks for API-sent messages. That was true
until Meta shipped **Coexistence** (May 2025), which runs the Business App and
the Cloud API on the same number and mirrors app-sent messages to the webhook
as `smb_message_echoes`.

With Coexistence enabled, an agent replying from the WhatsApp Business App
produces an echo event, and workflow 2 applies it through the same
`buildAgentMessageUpdate()` used for API replies — so the conversation moves to
`REPLIED`, `last_agent_message_at` is set, and `unread` clears. Full detail:
[COEXISTENCE.md](COEXISTENCE.md).

### The path that is still invisible

Path **E** — an agent replying from a *personal* WhatsApp account. Coexistence
tracks the **business number**, not the person. The `wa.me` link in the sheet
opens a chat from whatever account the clicker is signed into, so if that is a
personal account the reply is not recorded. The Apps Script warns about this
whenever someone opens a chat from the sheet.

**What must not be claimed:** that reply tracking is complete while path E is in
use. It is complete for A–D.

### Consequence for the agent inbox

The strongest argument for building the inbox was "we cannot otherwise see
agent replies". Coexistence removes that argument. The inbox remains worth
building for queueing, search, internal notes, SLA timers and analytics — see
[FUTURE_AGENT_INBOX.md](FUTURE_AGENT_INBOX.md) — but it is no longer required
for basic reply tracking.

---

## Message type support

| Type | Parsed | Text extracted | Preview written to Sheets |
|---|---|---|---|
| `text` | Yes | `text.body` | The message text |
| `image` | Yes | caption, if any | `[image] caption` |
| `video` | Yes | caption, if any | `[video] caption` |
| `audio` | Yes | — | `[audio]` |
| `document` | Yes | caption, if any | `[document] filename.pdf` |
| `sticker` | Yes | — | `[sticker]` |
| `location` | Yes | — | `[location] Amman City Center` |
| `contacts` | Yes | — | `[contacts x2]` |
| `interactive` | Yes | button/list reply title | `[interactive] نعم` |
| `button` | Yes | button text | `[button] ...` |
| `reaction` | Yes | emoji | `[reaction] 👍` |
| `order`, `system` | Yes | — | `[order]`, `[system] ...` |
| **anything else** | Yes | — | `[<type name>]`, `supported=false`, `processing_status=unsupported` |

An unknown type **never crashes a workflow**. Meta can introduce a new message
type at any time; when it does, the message is recorded with its type name,
sender, and timestamp so it can be handled later. The media `id` and `mime_type`
are preserved so the file can be fetched if needed.

---

## Failure modes

Summarized here; the full catalogue with handling is in
[ERROR_HANDLING.md](ERROR_HANDLING.md).

| Failure | Effect | Handling |
|---|---|---|
| Meta API outage | Replies fail to send | 3 retries with backoff; status `FAILED`; recorded with the error code |
| n8n restart | In-flight executions lost | Meta retries unacked webhooks; dedupe prevents double-processing on replay |
| Sheets API failure | Cannot read/write state | Nodes use `continueErrorOutput`; error recorded; webhook still acked |
| Sheets quota exceeded | Reads/writes rejected | 60 reads/min/user is the real ceiling — see [the migration doc](GOOGLE_SHEETS_TO_POSTGRES.md) |
| Duplicate webhook | Would double-assign | Dedupe key check before any write |
| Out-of-order status | Would downgrade READ | Monotonic status ladder |
| Status before message row | No row to update | Recorded as `deferred`, not an error |
| Expired access token | All sends fail | Distinct error code in the audit log; see [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| Malformed webhook | Could crash the parser | Parser never throws; returns a reason; still acked `200` |
| Unsupported message type | Could crash the workflow | Recorded with `supported=false` |
| No agent available | Conversation could be dropped | `WAITING_FOR_AGENT` + reason; retried every 5 min |
| Concurrent assignment | Two conversations to one agent | Serialized workflow; documented limitation |
| Manual sheet editing | Corrupt rows break routing | Every field parsed defensively; bad rows excluded individually, never fatally |
| Timezone confusion | Wrong timestamps | All timestamps stored ISO-8601 **UTC**; only display uses Asia/Amman |

---

## Security model

- **Secrets** live only in `.env` (git-ignored) and n8n's encrypted credential
  store. `.env.example` holds placeholders only.
- **Webhook authenticity** — every POST must carry a valid
  `X-Hub-Signature-256` HMAC over the raw body. Verification is
  constant-time and **fails closed** when the app secret is missing.
- **Verification handshake** — the GET handshake fails closed when
  `WEBHOOK_VERIFY_TOKEN` is unset, so nobody can bind their own Meta app to the
  endpoint.
- **Token isolation** — the Meta access token lives in an n8n credential, never
  in workflow JSON, so an exported workflow cannot leak it.
- **Least privilege** — `NODE_FUNCTION_ALLOW_BUILTIN=crypto` (that one module,
  not `*`), and no external npm modules in Code nodes.
- **Redaction** — all structured logging passes through `redact()`, which masks
  tokens, keys, signatures, and passwords while preserving useful context.

Full policy: [SECURITY.md](SECURITY.md).

---

## Designed-for migrations

Two future changes were designed for from the start.

### Google Sheets → PostgreSQL

Business logic is I/O-free, so the store is swapped by changing *callers*, not
decisions. The assignment race disappears because the read-decide-write cycle
becomes one transaction with `SELECT ... FOR UPDATE`. Details:
[GOOGLE_SHEETS_TO_POSTGRES.md](GOOGLE_SHEETS_TO_POSTGRES.md).

### Sheet-based access → agent inbox

Workflow 4 is already a complete reply API: validate, send, record, report
status. A web inbox becomes a UI over that endpoint plus a read API over the
same tables — the WhatsApp integration core does not change. Details:
[FUTURE_AGENT_INBOX.md](FUTURE_AGENT_INBOX.md).

---

## Known limitation: messages arriving at the same instant

**Two or more webhooks that arrive in the same instant can lose one of the
rows they write.** Sequential messages — which is what normal traffic looks
like, even busy traffic — are unaffected. This is measured, not suspected.

### What was measured

Against the Google Sheets API directly, with n8n entirely out of the picture:

| `insertDataOption` | Simultaneous appends | HTTP 200s | Rows that landed |
|---|---|---|---|
| `OVERWRITE` (the default) | 6 | 6 | **3** |
| `INSERT_ROWS` | 6 | 6 | 6 |

`values.append` with the default option picks its target row from the table's
current extent and writes there. Two calls that arrive together compute the
**same** target, and the second overwrites the first. Both are told they
succeeded.

That is the whole explanation for the symptom: a burst of messages, every
execution green in the n8n log, every webhook answered `200`, and fewer rows in
the sheet than messages sent.

### What was fixed

Three contributing causes, all of them a limit that dropped rather than queued:

- The Execute Workflow handoff in workflow 1 ran fire-and-forget, so the parent
  execution ended before the sub-workflow had started. It waits now — the ack
  has already gone out two nodes earlier, so waiting costs Meta nothing.
- `N8N_CONCURRENCY_PRODUCTION_LIMIT=1`, recommended by this project's own
  documentation, discarded the overflow instead of queueing it.
- Eleven Sheets nodes used `continueErrorOutput` with nothing wired to the
  error output, which makes a failed write report as a **successful**
  execution. They fail loudly now, and `validate-workflows.js` rejects that
  shape.

### What remains

The append collision itself. The fix is known and proven — call
`values:append` with `insertDataOption=INSERT_ROWS` — but n8n's Google Sheets
node does not expose that option, so the two appends that would lose a customer
message (`Append Conversation`, `Append Message`) have to go through the Sheets
API directly, the way workflow 3 already mints a token for sorting.

Until then:

- **Normal traffic is unaffected.** Messages a second or more apart all land;
  `verify-live.js` and `verify-archive.js` pass in full.
- **`scripts/testing/verify-burst.js` is the regression test.** It posts a burst
  and insists every message is present. It currently fails, deliberately, and
  is how the fix will be confirmed.
- The Google Sheets quota — 60 reads per minute for one service account — is the
  throughput ceiling either way. A deployment that genuinely receives bursts has
  outgrown the spreadsheet; that is what
  [GOOGLE_SHEETS_TO_POSTGRES.md](GOOGLE_SHEETS_TO_POSTGRES.md) is for.
