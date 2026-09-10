# n8n Workflows

Six workflows with separated responsibilities. All JSON in `n8n/workflows/` is
**generated** by `scripts/setup/build-workflows.js` — do not hand-edit it, and
never edit Code node bodies inside n8n (changes are lost on the next import and
are never tested).

```bash
node scripts/setup/build-workflows.js         # generate
node scripts/validation/validate-workflows.js # 303 checks
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
| **Output** | One item per event, routed three ways |
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
        └── other_event      → Log Unhandled Event
```

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
           ├── yes → Read Agents → Select Agent → Increment Agent Load
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
chain. Every excluded agent and the reason is written to the Events sheet.

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
| **Output** | A row in the Events sheet |

Set this as the **Error Workflow** in workflows 1–5 (*Settings → Error
Workflow*).

**Redacts before writing anything.** n8n error payloads can contain the failing
request's headers — including `Authorization: Bearer …`. Writing that raw into a
spreadsheet would put a live token in a document people share.

**Known limitation.** If Google Sheets is the failing dependency, this handler
cannot log to Sheets either. n8n's execution log is then the source of truth.
This is stated rather than pretended away.

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
