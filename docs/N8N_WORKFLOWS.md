# n8n Workflows

Six workflows with separated responsibilities. All JSON in `n8n/workflows/` is
**generated** by `scripts/setup/build-workflows.js` — do not hand-edit it, and
never edit Code node bodies inside n8n (changes are lost on the next import and
are never tested).

```bash
node scripts/setup/build-workflows.js         # generate
node scripts/validation/validate-workflows.js # 504 checks
node scripts/setup/import-workflows.js        # import (idempotent)
```

---

## Pinned versions

Node type versions were read from the running n8n 2.38.5 image on 2026-09-10 and
are pinned in the builder. Re-verify after an n8n upgrade:

| Node | typeVersion | | Node | typeVersion |
|---|---|---|---|---|
| `webhook` | 2.1 | | `googleSheets` | 4.7 |
| `respondToWebhook` | 1.5 | | `httpRequest` | 4.5 |
| `code` | 2 | | `executeWorkflow` | 1.3 |
| `if` | 2.3 | | `executeWorkflowTrigger` | 1.2 |
| `switch` | 3.4 | | `scheduleTrigger` | 1.4 |
| `set` | 3.5 | | `errorTrigger` | 1 |

## Pinned workflow ids

| Id | Workflow |
|---|---|
| `whatsappRecv0001` | 1 Webhook Receiver |
| `whatsappProc0002` | 2 Incoming Message Processor |
| `whatsappConv0003` | 3 Conversation & Assignment |
| `whatsappSend0004` | 4 Outgoing Agent Message |
| `whatsappQueu0005` | 5 Unassigned Queue Retry |
| `whatsappErrH0006` | 6 Error Handler |
| `whatsappShRp0007` | 7 Reply From Sheet |
| `whatsappArch0008` | 8 Archive Old Conversations |

Ids are fixed so `import:workflow` **updates** rather than creating duplicates,
and so Execute Workflow cross-references are correct at build time.

---

## Workflow 1 — Webhook Receiver

**The only workflow Meta talks to.**

| | |
|---|---|
| **Trigger** | Webhook `GET /webhook/whatsapp/webhook` and `POST` (same path, two nodes) |
| **Input** | Meta verification handshake, or a signed event payload |
| **Output** | HTTP response to Meta; async handoff to workflow 2 |
| **Must be published** | Yes |

**Flow**

```
GET  → Verify Handshake  → Respond Challenge (200 + challenge | 403 | 400 | 500)
POST → Verify Signature  → Signature Valid?
                              ├── true  → Ack 200 → Hand Off To Processor
                              └── false → Reject 401
```

**Two things that are easy to get wrong**

1. **`rawBody: true` is mandatory** on the POST node. The HMAC must be computed
   over the exact bytes Meta sent; n8n puts those base64-encoded in
   `binary.data.data` while `json.body` holds the *parsed* object. Verifying
   against re-serialized JSON rejects every legitimate request.
2. **The 200 is sent before any work.** Meta retries anything it does not get a
   timely 200 for, so doing Sheets I/O first turns a slow spreadsheet into
   duplicate processing.

**Error handling.** Malformed bodies still receive 200 (they are recorded, not
retried). Signature failures receive 401. Nothing here can throw an unhandled
exception — the security helpers return verdicts rather than raising.

**Idempotency.** None at this layer by design — it acks everything valid.
Deduplication happens in workflow 2, after the ack.

**Logs.** `webhook_verification`, `webhook_received` — with the signature
outcome but never the token or signature value.

---

## Workflow 2 — Incoming Message Processor

| | |
|---|---|
| **Trigger** | Execute Workflow (from workflow 1) |
| **Input** | Raw webhook body |
| **Output** | One item per event, routed four ways |
| **Must be published** | Yes — sub-workflows must be published or the caller errors |

**Flow**

```
Parse & Normalize Events
   → Route By Event Kind
        ├── customer_message → Lookup Existing Message → Is Duplicate?
        │                        ├── new       → Resolve Conversation (WF3)
        │                        └── duplicate → Skip Duplicate
        ├── status_update    → Find Outbound Message → Apply Status Ladder
        │                        ├── apply → Update Message Status
        │                        └── stale → Skip Stale Status
        ├── app_reply_echo   → Find Conversation For Echo → Apply App Reply
        │                        ├── update → Update Conversation From App Reply
        │                        │             → Record App Reply Message
        │                        └── skip   → Record App Reply Message
        └── other_event      → Log Unhandled Event
```

**The echo branch** handles `smb_message_echoes` — replies an agent typed in
the WhatsApp Business App, available when Coexistence is enabled. It applies
them through the same `buildAgentMessageUpdate()` used for API replies, so an
app reply advances the conversation to `REPLIED` exactly like a workflow-4
reply would.

Two things this branch gets right and a naive implementation would not:

- **Direction is reversed.** In an echo, `from` is the **business** and `to` is
  the **customer**. Reading `from` as the customer would file the agent's own
  reply under the business number and flip the real conversation to
  `UNANSWERED`.
- **`revoke` and `edit` do not advance state.** Deleting a message is not
  answering a customer, so control events are recorded without moving the
  conversation.

See [COEXISTENCE.md](COEXISTENCE.md).

**Parsing.** Iterates **every** `entry` × `change` × `message`/`status`. A
single POST can legitimately contain many messages across multiple business
numbers; a naive `entry[0].changes[0].value.messages[0]` silently drops the
rest, which looks exactly like losing customer messages under load. The
`batched-multiple-messages.json` fixture asserts all four are processed.

**Deduplication.** `dedupe_key` is `message:<wamid>` for messages and
`status:<wamid>:<STATUS>` for statuses — see
[DECISIONS.md](DECISIONS.md#d-007--idempotency-keys-differ-for-messages-and-statuses).

**Status ladder.** `PENDING < ACCEPTED < SENT < DELIVERED < READ`, with `FAILED`
overriding and then terminal. A late `delivered` cannot downgrade `read` or
resurrect a `failed`.

**Status before message row.** If a status arrives for a message we have not
recorded yet, it is marked `deferred` rather than treated as an error — this is
normal, not a fault.

**Retries.** None. The event was already acked; a failure here is recorded in
Events and n8n's execution log.

**Logs.** `webhook_parsed`, `dedupe_check`, `status_ladder`,
`status_before_message_record`.

---

## Workflow 3 — Conversation & Assignment

**The heart of the system.**

| | |
|---|---|
| **Trigger** | Execute Workflow (from workflow 2) |
| **Input** | A parsed, deduplicated customer message |
| **Output** | Persisted conversation, message, and audit rows |
| **Must be published** | Yes |
| **Concurrency** | **Set to 1** |

**Flow**

```
Find Existing Conversation
  → Decide Create Or Update
      → Needs Assignment?
           ├── yes → Read Agents → Select Agent → Agent Assigned? → Increment Agent Load
           │                                    ↘
           └── no ──────────────────────────────→ Build Conversation Row
                                                    → Create Or Update Row?
                                                         ├── Append Conversation
                                                         └── Update Conversation
                                                    → Append Message
                                                    → Audit Assignment
```

**Conversation lookup** is scoped by `business_phone_number_id`, so one customer
messaging two of your numbers gets two independent conversations. The active
conversation is the most recently updated non-closed row; if only closed ones
exist, the most recent reopens (configurable).

**Assignment** is `LEAST_OPEN_CONVERSATIONS` with the documented tie-breaker
chain. Every excluded agent and the reason is written to the Log sheet.

**When nobody is eligible** (everyone at capacity or away), Select Agent returns
`WAITING_FOR_AGENT` with no agent. `Agent Assigned?` then skips the Agents-row
update — Sheets refuses an update whose match value is empty — and the
conversation is still written by `Build Conversation Row`, for workflow 5 to
assign later. Without that gate the failed update stopped the run and the
message was never written. `Read Agents` runs once (`executeOnce`), not once per
conversation row it receives.

> **Concurrency 1 is not optional.** Google Sheets has no atomic
> compare-and-set, so two parallel executions can both read "Mohammad has 3
> open" and both assign him. Serializing removes the race on a single instance.
> [ASSIGNMENT_ALGORITHM.md](ASSIGNMENT_ALGORITHM.md#concurrency-and-race-conditions)

**Error handling.** Sheets nodes use `continueErrorOutput`, so a Sheets failure
is captured rather than silently ending the branch. `alwaysOutputData` on lookup
nodes means "no match" yields an empty item instead of terminating the flow.

**Logs.** `conversation_found`, `conversation_created`, `conversation_reopened`,
`agent_selection` (with eligible/evaluated counts).

---

## Workflow 4 — Outgoing Agent Message

**The only supported reply path.**

| | |
|---|---|
| **Trigger** | Webhook `POST /webhook/agent/send` |
| **Input** | `{ to, text, conversation_id, agent_id, reply_to_message_id? }` |
| **Output** | `{ ok, message_id, status, ... }` |
| **Must be published** | Yes |

**Flow**

```
Validate Send Request → Request Valid?
   ├── true  → Send Via Cloud API → Interpret Send Result
   │            → Store Outbound Message → Update Conversation → Respond
   └── false → Respond 400 with the validation errors
```

**Validation** uses `normalizePhoneStrict` — ambiguous numbers are **rejected**,
not guessed, because guessing means messaging a stranger. Also enforces
non-empty text, the 4096-character limit, and the presence of
`conversation_id` and `agent_id`.

**Request.** `POST https://graph.facebook.com/{version}/{phone_number_id}/messages`
with `messaging_product: whatsapp`. The version comes from
`META_GRAPH_API_VERSION`, never hard-coded. 15s timeout, 3 retries with backoff.

**The token** lives in the `Meta WhatsApp Token` header-auth credential, never
in the node — so an exported workflow cannot leak it.

**`SENT` means accepted, not delivered.** The response gives a `wamid` and
`message_status: accepted`. Real delivery is only known when a status webhook
arrives at workflow 2. Conflating these is the single most common error in
WhatsApp integrations.

> **Do not expose this endpoint publicly in production.** It can send messages
> as your business. Restrict it at the reverse proxy —
> [DEPLOYMENT_HOSTINGER.md](DEPLOYMENT_HOSTINGER.md).

**Logs.** `send_request_rejected`, `send_accepted`, `send_failed` — with the
text **length**, never the text.

---

## Workflow 5 — Unassigned Queue Retry

| | |
|---|---|
| **Trigger** | Schedule, every 5 minutes |
| **Input** | Conversations with `status = WAITING_FOR_AGENT` |
| **Output** | Assignments for whatever can now be assigned |

Processes **oldest first** so nobody starves at the back of the queue, and
tracks each assignment in a local copy of agent load as it goes — otherwise one
run would hand the entire backlog to whichever agent started out least loaded.

Stops as soon as no agent is eligible, rather than looping pointlessly.

**Logs.** `queue_retry` (waiting/assigned counts), `queue_retry_exhausted`.

---

## Workflow 6 — Error Handler

| | |
|---|---|
| **Trigger** | Error Trigger |
| **Input** | n8n's error payload |
| **Output** | A row in the Log sheet |

Set this as the **Error Workflow** in workflows 1–5, 7 and 8 (*Settings → Error
Workflow*).

**Redacts before writing anything.** n8n error payloads can contain the failing
request's headers — including `Authorization: Bearer …`. Writing that raw into a
spreadsheet would put a live token in a document people share.

**Known limitation.** If Google Sheets is the failing dependency, this handler
cannot log to Sheets either. n8n's execution log is then the source of truth.
This is stated rather than pretended away.

---

## Workflow 7 — Reply From Sheet

**Trigger:** Schedule, every 1 minute.
**Purpose:** Let a human send a WhatsApp reply by typing into the sheet.

| | |
|---|---|
| **Input** | The `Conversations` tab |
| **Output** | A sent WhatsApp message; `Messages` row with `sent_via = google_sheet` |
| **Selects** | Rows where `reply_text` is non-empty, and the 24-hour window is open. Nothing else is a guard (see *Idempotency*) |

### Flow

```
Every Minute
   └─> Read Conversations
        └─> Find Pending Replies        (phone, length, 24-hour window)
             └─> Sendable?
                  ├─ yes ─> Send Reply Via Cloud API
                  │           └─> Interpret Sheet Send      (every reply of the poll)
                  │                └─> Row Had An Id?
                  │                     ├─ yes ─> Clear Cell And Record Outcome   (by conversation_id)
                  │                     └─ no  ─> Claim Row And Record Outcome    (by row_number)
                  │                          └─> Record Sent Reply
                  └─ no  ─> Invalid Row Had An Id?
                             ├─ yes ─> Mark Invalid Reply            (by conversation_id)
                             └─ no  ─> Claim Row And Mark Invalid    (by row_number)
```

### Idempotency

**Clearing the cell is the interlock.** The moment a message goes out,
`reply_text` is emptied, so text sitting in that cell always means "not sent
yet" and the next poll finds nothing to do.

`reply_status` is deliberately **not** a guard. It is an outcome the system
writes. Treating it as a guard meant that anyone who set it to `SENT`
themselves — the obvious way for a person to say "send this" — had their
message silently dropped. A non-empty `reply_text` is now the only instruction
needed.

On success `reply_text` is cleared and `reply_status` becomes `SENT`.
When Meta refuses the send, the cell is also cleared (so it is not retried
every minute), `reply_status` becomes `FAILED`, `reply_error` says why, and
the rest of the row is left exactly as it was, including the backlog of
unanswered messages, because nothing was answered. An **invalid** value (a
phone that cannot be normalised, text over 4096 characters) never reaches
Meta, and its `reply_text` is **kept** so the author can correct it.

Every reply sent in one poll gets its own outcome. Until V2-04 only the first
did: the others were sent, kept their text, and were sent again the next
minute.

### Keeping the agent name and the agent id in step

The name is what a person reads, filters and hands a conversation over with;
the id is what the load count and the dashboard use. Each poll compares the
two against the Agents tab and repairs whichever is stale: the name wins when
someone hands a conversation over, the id wins when a name was cleared or an
agent was renamed. A name that matches no agent, on a row with no id, is left
alone — guessing there would hand a customer to whoever is nearby in the list.
Nothing is written when they already agree.

### The 24-hour window

Meta only delivers a free-form message inside 24 hours of the **customer's**
last message; a reply from the business never extends that. Workflow 7 checks
it before sending (`scripts/lib/window.js`), so a reply that cannot arrive is
never sent: the row reads `WINDOW_CLOSED`, the text stays where the person
typed it, and `reply_error` says why. A row typed by hand for a number that
never wrote to you has no open window either, so reaching a new contact needs
an approved template.

A blocked reply keeps its text, which would make the next poll rewrite the same
failure a minute later, for as long as it sits there. So the row remembers a
short hash of that text and that reason (`reply_blocked_hash`) and is skipped
while both are unchanged. Edit the text, or let the customer write again, and it
is picked up at once.

### Sending an approved template

A template is the only thing that reaches a customer outside the window, and it
costs money, so nothing sends one on its own. A person types the marker into
the reply cell:

```
[TEMPLATE] followup_general
[قالب] followup_general
```

The name must be in `WHATSAPP_TEMPLATES` in `.env`, which lists the templates
Meta approved, their language, and the columns that fill `{{1}}`, `{{2}}` … So
a typo, a template that was never approved, or an empty parameter cell is
refused **before** any call is made, and the row says which. A template on the
WAHA connector is refused too: it has none.

The send goes to the Cloud API as a `template` message, and is recorded in
Messages with `sent_via = template` and `message_type = template`, so the
billing figures can separate a paid template from a free reply.

### Which row the outcome is written to

A row that has a `conversation_id` is written back **by that id**. A row
number goes stale the moment anything above it moves, and the write then
lands on another customer's row. Only a hand-typed row, which has no id yet,
is written by row number, and that write gives it its id and the normalised
phone. `validate-workflows.js` rejects any other row-number write to
Conversations.

### Error handling

| Failure | Handling |
|---|---|
| Unnormalizable phone | `reply_status = FAILED`, never sent — strict normalization refuses ambiguous numbers |
| Text over 4096 chars | `FAILED` before any API call |
| **24-hour window closed** | `reply_status = WINDOW_CLOSED`, **no API call**, and the text is kept. Reaching that customer needs an approved template |
| Meta refuses a closed window (131047) | The same: `WINDOW_CLOSED`, text kept, remembered so the next poll does not try again |
| Meta API error | 3 retries with backoff, then `FAILED` with the Meta error code |
| Sheets read fails | `continueRegularOutput`; the next tick retries |

### Why one minute

Polling faster burns the Google Sheets read quota (60/min/user) for no
perceptible benefit. Instant replies come from the WhatsApp Business App or the
API, not from a poller.

---

## Workflow 8 — Archive Conversations

**Trigger:** Schedule, every minute at second 30 (half a minute behind
workflow 7).
**Purpose:** Keep the working sheet small and fast. It is the only thing in the
system that deletes a row.

| | |
|---|---|
| **Input** | The `Conversations` tab |
| **Output** | Rows moved to `Archive`; an audit row per move |
| **Selects** | `status = ARCHIVED`; `status = CLOSED` **and** closed longer ago than `ARCHIVE_AFTER_DAYS`; duplicate open conversations of one customer (the newer ones) |

### Flow

```
Every Minute
   └─> Read Conversations
        └─> Select Archivable
             └─> Copy To Archive              (API append, INSERT_ROWS; stops the run if it fails)
                  └─> Delete Via API?          (is there a Sheets token?)
                       ├─ yes ─> Plan Deletes
                       │          └─> Read Conversations Before Delete
                       │               └─> Build Delete Request    (planDeletes: by id, bottom-up)
                       │                    └─> Delete Archived Rows       (one batchUpdate)
                       │                         └─> Read Conversations After Delete
                       │                              └─> Check Deletes    (checkDeletes)
                       │                                   └─> Lost Row?
                       │                                        ├─ yes ─> Restore Lost Row ─> Audit Archive
                       │                                        └─ no  ─> Audit Archive
                       └─ no  ─> Remove From Conversations   (per row, by row_number)
                                  └─> Audit Archive After Row Delete
```

### The safety rules

1. **Only archived, long-closed or duplicate rows.** An open conversation is
   live work; archiving one would hide a waiting customer.
2. **Copy before delete, and halt if the copy fails.** A copy that fails on
   the API and on its Sheets fallback stops the run, so a row that was not
   copied is never deleted.
3. **Delete by id, from a fresh read, in one batch.** The rows are found by
   `conversation_id` in a read taken right before the delete, never by the
   `row_number` read at the start of the run, and removed in one
   `batchUpdate` from the bottom up, so each delete only shifts rows that were
   already handled.
4. **Check afterwards.** The tab is read again. An archived id still present is
   logged (`archive_delete_missed`). A row that vanished without being
   archived is appended back from the read taken just before, and logged as
   `ARCHIVE_ROW_RESTORED`. A row is only restored when it is matched by an
   archived row that is still present, which is what a misplaced delete looks
   like; an empty or odd second read restores nothing.
5. **Without a service account** the old per-row Sheets delete runs, exactly as
   before, so such a deployment keeps archiving instead of copying the same
   rows every minute.

The logic lives in `scripts/lib/rows.js` and is unit-tested; the sheet's own
Apps Script no longer deletes anything, it only marks rows `ARCHIVED`.

A row whose `closed_at` cannot be parsed is **skipped**, not archived on a
guess.

### Configuration

| Variable | Default | Effect |
|---|---|---|
| `ARCHIVE_AFTER_DAYS` | `30` | Age after closing. `0` disables the workflow entirely |
| `ARCHIVE_BATCH_SIZE` | `200` | Rows per run — keeps a first large run inside the write quota |

---

## Publishing

n8n 2.x uses a **draft/published** model. A workflow only runs when published,
and a sub-workflow invoked by Execute Workflow must be published too — otherwise
the caller fails with `Workflow is not active and cannot be executed`.

**From the UI** (recommended): open the workflow, click Publish. Instant.

**From the CLI:**

```bash
docker exec n8n-whatsapp n8n publish:workflow --id=whatsappRecv0001
docker compose restart n8n     # required for changes to take effect
```

> Two CLI gotchas found the hard way:
>
> - **Never pipe the output** (`| head`). The pipe closing sends SIGPIPE and the
>   command hangs indefinitely — observed running for 6 minutes before being
>   killed.
> - **`import:workflow --activeState=fromJson` does not work here.** It requires
>   queue or multi-main mode; in a regular single-instance deployment it errors
>   out.

---

## The language the sheet is kept in

A cell holds a word a person reads. `status` on an Arabic sheet says
`مغلقة`, not `CLOSED`. No workflow ever compares that word.

`scripts/lib/labels.js` converts at the two boundaries, and only there:

| Where | What happens |
|---|---|
| Every read of a Conversations row | `normalizeConversationRow(row)` turns labels into codes |
| Every Code node that builds what is written | `conversationRowToSheet(row, lang)` or `toLabel(field, code, lang)` turns codes back into labels |

The read points are `Apply App Reply` (2), `Decide Create Or Update` and
`Select Agent` (3), `Assign Waiting Queue` (5), `Find Pending Replies` (7)
and `Select Archivable` (8). The write points are `Apply App Reply` (2),
`Build Conversation Row` (3), `Interpret Send Result` (4), `Assign Waiting
Queue` (5) and `Interpret Sheet Send` (7). The validator checks all of them,
and checks that no labelled column is written as a literal.

Reading accepts a code or a label in any language, so a sheet part-way
through a change of language still reads correctly, and a value in neither
is left exactly as it was found.

Two consequences worth knowing:

- **A Sheets lookup cannot filter on a status.** The node compares the text
  in the cell, so `lookupValue: WAITING_FOR_AGENT` matches nothing on an
  Arabic sheet. Workflow 5 reads the rows and filters on the normalised
  value instead — at no extra cost, since the node fetches the tab and
  filters in memory either way.
- **Messages, Log and the API answers stay in codes.** They are read by
  machines, not by people: workflow 4 answers `SENT`/`FAILED` to the app
  whatever the sheet is set to, and only the Conversations columns a person
  reads are labelled.

Set with `SHEET_LANGUAGE` ([ENVIRONMENT.md](ENVIRONMENT.md#sheet_language)).

---

## Conventions

| Convention | Rationale |
|---|---|
| Descriptive node names (`Verify Signature`, not `Code1`) | Names appear in error messages and `$('…')` references |
| Sticky notes on every workflow | The "why" belongs next to the nodes, not only in docs |
| `alwaysOutputData` on lookups | "No match" must produce an empty item, not end the branch |
| `continueErrorOutput` on Sheets writes | Failures are captured, not silent |
| `onError: continueRegularOutput` on audit writes | Failing to log must not fail the operation being logged |
| `$env` for all configuration | Nothing environment-specific in the JSON |
| snake_case for sheet columns, camelCase in code | Matches each side's conventions |

---

## Modifying a workflow

1. Edit `scripts/setup/build-workflows.js` (structure) or `scripts/lib/*.js`
   (logic).
2. If you changed logic, add or update tests, then `node tests/run-tests.js`.
3. `node scripts/setup/build-workflows.js`
4. `node scripts/validation/validate-workflows.js`
5. `node scripts/setup/import-workflows.js`
6. Re-publish the changed workflows and restart n8n.

Editing inside the n8n UI is fine for **experimenting**, but the change must be
moved back into the builder or it will be overwritten and will never be covered
by tests.
