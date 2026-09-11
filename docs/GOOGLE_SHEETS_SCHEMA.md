# Google Sheets Schema

Four sheets in one spreadsheet. Ready-to-paste header rows and sample data are
in [`sheets-templates/`](../sheets-templates/).

**Golden rule:** one row per *thing*.
One row per conversation in `Conversations`. One row per message in `Messages`.
One row per system event in `Log`. Messages never go in `Conversations` —
that is what makes the conversation view readable by a manager.

---

## Fastest setup: the Apps Script

Instead of creating tabs by hand, paste
[`sheets-templates/SetupSheet.gs`](../sheets-templates/SetupSheet.gs) into
*Extensions -> Apps Script* and run `setupEverything`.

It creates every tab with the right columns, freezes headers, turns
`active`/`available`/`unread` into real checkboxes, adds a status dropdown,
colours rows by status, flags anything unanswered for over an hour in red, and
adds a **WhatsApp Support** menu with:

| Menu item | What it does |
|---|---|
| Reply to selected conversation… | Type a reply in a dialog; sent within a minute |
| Open WhatsApp chat for selected row | Opens the `wa.me` link, with a warning about untracked personal replies |
| Mark selected as CLOSED / Reopen | Bulk status changes with correct timestamps |
| Recalculate agent workload | Repairs `open_conversations` drift from the real data |
| Filter view instructions | The exact recipe for each recommended filter view |

Safe to re-run: it refreshes headers and formatting without deleting rows.

Verify the schema stays consistent across the CSVs, the Apps Script and the
workflows:

```bash
node scripts/validation/check-schema-consistency.js
```

---

## Manual setup

1. Create a new Google Sheet.
2. Create four tabs named exactly: `Agents`, `Conversations`, `Messages`,
   `Log`. Names are case-sensitive and are referenced by the workflows.
3. Paste the header row from the matching file in `sheets-templates/` into
   row 1 of each tab.
4. **Freeze row 1** on every tab: *View → Freeze → 1 row*.
5. Share the spreadsheet with your service account email as **Editor**.
6. Copy the spreadsheet id from the URL into `GOOGLE_SHEET_ID` in `.env`.

```
https://docs.google.com/spreadsheets/d/THIS_PART_IS_THE_ID/edit
```

Column order matters only for human readability — the workflows address columns
by **name**, so inserting a column will not break anything. Renaming or
misspelling one will.

---

## Sheet 1 — `Agents`

The routing configuration. **Agents are never hard-coded in workflows**; adding
an agent means adding a row here.

| Column | Type | Written by | Notes |
|---|---|---|---|
| `agent_id` | text | human | Stable unique key, e.g. `A1`. Never reuse. |
| `name` | text | human | Shown in `Conversations.assigned_agent_name` |
| `phone` | text | human | E.164, no `+`. For contacting the agent, not for routing. |
| `active` | TRUE/FALSE | human | Employed / not employed. Long-term switch. |
| `available` | TRUE/FALSE | human or agent | On shift right now. Short-term switch. |
| `max_open_conversations` | number | human | Capacity. `0` means "cannot take conversations". |
| `open_conversations` | number | **system** | Denormalized counter. Do not edit by hand. |
| `last_assigned_at` | ISO-8601 UTC | **system** | Tie-breaker input. Blank = never assigned. |
| `role` | text | human | Informational, e.g. `agent`, `supervisor` |
| `working_hours` | text | human | Informational in the MVP — **not enforced** |
| `timezone` | text | human | Informational in the MVP — **not enforced** |
| `created_at` | ISO-8601 UTC | human | |
| `updated_at` | ISO-8601 UTC | **system** | |

### `active` vs `available`

Both must be TRUE for routing. They are separate because they change on
different timescales: `active` is "works here", `available` is "is on shift".
Setting `available=FALSE` for a lunch break must not lose the fact that someone
is a permanent employee.

### Accepted boolean spellings

`TRUE`, `true`, `1`, `yes`, `Y`, `نعم` are truthy.
`FALSE`, `false`, `0`, `no`, `لا` are falsy.
**Anything else is treated as FALSE** — the system fails closed and will not
route to an agent whose availability it cannot positively confirm.

### `open_conversations` drift

This is a denormalized counter, so it can drift. The true value is always:

```
COUNT(Conversations WHERE assigned_agent_id = <agent> AND status != 'CLOSED')
```

Recompute it from that if the numbers ever look wrong. See
[ASSIGNMENT_ALGORITHM.md](ASSIGNMENT_ALGORITHM.md#recovering-from-counter-drift).

### Example

| agent_id | name | phone | active | available | max_open_conversations | open_conversations | last_assigned_at | role |
|---|---|---|---|---|---|---|---|---|
| A1 | Ahmed | 962790000001 | TRUE | TRUE | 5 | 4 | 2026-09-10T09:15:00.000Z | agent |
| A2 | Mohammad | 962790000002 | TRUE | TRUE | 5 | 3 | 2026-09-10T09:12:00.000Z | agent |
| A3 | Sara | 962790000003 | TRUE | TRUE | 5 | 3 | 2026-09-10T08:55:00.000Z | agent |

With this data the next conversation goes to **Sara** — she ties with Mohammad
at 3 open, and her `last_assigned_at` is older.

---

## Sheet 2 — `Conversations`

One row per conversation. This is the sheet managers actually live in.

| Column | Type | Written by | Notes |
|---|---|---|---|
| `conversation_id` | text | system | `CONV-<biz>-<customer>-<epoch>`. Primary key. |
| `customer_phone` | text | system | E.164, no `+` |
| `customer_name` | text | system | WhatsApp profile name; may be blank |
| `business_phone_number_id` | text | system | Which of your numbers received it |
| `assigned_agent_id` | text | system | Blank while `WAITING_FOR_AGENT` |
| `assigned_agent_name` | text | system | Denormalized for readability |
| `status` | enum | system | See below |
| `last_message` | text | system | Preview of the most recent message |
| `last_message_id` | text | system | `wamid...` |
| `last_message_direction` | `inbound`/`outbound` | system | Who spoke last |
| `last_customer_message_at` | ISO-8601 UTC | system | |
| `last_agent_message_at` | ISO-8601 UTC | system | Blank until a reply is sent **via the API** |
| `last_activity_at` | ISO-8601 UTC | system | Max of the two above. Drives inactivity. |
| `unread` | TRUE/FALSE | system | TRUE when the customer spoke last |
| `created_at` | ISO-8601 UTC | system | |
| `updated_at` | ISO-8601 UTC | system | |
| `closed_at` | ISO-8601 UTC | system | Blank unless `CLOSED`; cleared on reopen |
| `wa_link` | URL | system | `https://wa.me/<e164>` |
| `unassigned_reason` | text | system | Why nobody was assigned; blank when assigned |
| `reply_text` | text | **human** | **Type here to send a WhatsApp reply** — see below |
| `reply_status` | text | system | Blank = pending, then `SENT` or `FAILED` |
| `reply_error` | text | system | Why a reply failed |
| `reply_sent_at` | ISO-8601 UTC | system | When it was sent |

### Replying from the sheet

Type a message into **`reply_text`** and leave `reply_status` blank. Within a
minute, workflow 7 sends it over the Cloud API, clears the cell, and sets
`reply_status` to `SENT`.

`reply_status` is the interlock that prevents double-sending: once it says
`SENT`, `SENDING` or `FAILED`, that text is never sent again. Without it every
poll would resend the same message until someone cleared the cell.

On failure the text is **deliberately left in place** so the author can see and
correct it; `reply_error` says what went wrong.

Every reply sent this way is recorded in `Messages` with
`sent_via = google_sheet`.

### Status values

| Status | Meaning | Manager action |
|---|---|---|
| `WAITING_FOR_AGENT` | Nobody could take it | **Staffing problem — look now** |
| `UNANSWERED` | Assigned, customer waiting | **Response-time clock is running** |
| `REPLIED` | Agent answered last | Waiting on customer |
| `WAITING_FOR_CUSTOMER` | Reserved synonym of `REPLIED` | Not written by the MVP |
| `CLOSED` | Finished | — |

"Open" is not a status; it is `status != CLOSED`.

### Recommended filter views

Create these once (*Data → Create a filter view*) and managers can switch
between them:

| View | Filter | Purpose |
|---|---|---|
| **Needs attention** | `status` is `UNANSWERED` or `WAITING_FOR_AGENT` | The daily working queue |
| **Unassigned** | `status` = `WAITING_FOR_AGENT` | Staffing gaps |
| **Unanswered** | `status` = `UNANSWERED` | SLA risk |
| **Open** | `status` ≠ `CLOSED` | Everything live |
| **Closed** | `status` = `CLOSED` | History |
| **Waiting for customer** | `status` = `REPLIED` | Follow-up candidates |
| **By agent** | `assigned_agent_name` = *(pick)* | One agent's workload |
| **Today** | `last_activity_at` ≥ today | Today's activity |
| **Unread** | `unread` = `TRUE` | Not yet answered |

Sort **Needs attention** by `last_customer_message_at` ascending — oldest
unanswered first is the order a support team should work in.

### Suggested conditional formatting

- `status = WAITING_FOR_AGENT` → red background (nobody owns this)
- `status = UNANSWERED` → amber
- `status = CLOSED` → grey text
- `last_customer_message_at` older than 1 hour while `UNANSWERED` → bold red

---

## Sheet 3 — `Messages`

One row per WhatsApp message, inbound and outbound. This is the audit trail and
the deduplication store.

| Column | Type | Notes |
|---|---|---|
| `message_id` | text | Meta `wamid`. Unique per message. |
| `dedupe_key` | text | **Idempotency key.** `message:<wamid>` or `status:<wamid>:<STATUS>` |
| `conversation_id` | text | Foreign key to `Conversations` (not enforced) |
| `direction` | `inbound`/`outbound` | |
| `sender_phone` | text | |
| `recipient_phone` | text | |
| `message_type` | text | `text`, `image`, `location`, … |
| `text` | text | Preview/caption. `[image]`, `[location] …` for media |
| `timestamp` | ISO-8601 UTC | When Meta says it happened |
| `status` | enum | `RECEIVED` \| `SENT` \| `DELIVERED` \| `READ` \| `FAILED` |
| `status_updated_at` | ISO-8601 UTC | Last status change |
| `agent_id` | text | For outbound: who sent it |
| `sent_via` | text | `cloud_api` \| `whatsapp_business_app` \| `google_sheet` |
| `supported` | TRUE/FALSE | FALSE for message types we do not yet handle |
| `processing_status` | text | `parsed` \| `unsupported` \| `deferred` |
| `correlation_id` | text | Traces one webhook across all sheets and logs |
| `raw_event_reference` | text | Media id, so the file can be fetched later |
| `created_at` | ISO-8601 UTC | When we wrote the row |

### Why `dedupe_key` and not just `message_id`

Status callbacks reuse the same `message_id` for `sent` → `delivered` → `read`.
Deduplicating on `message_id` alone would discard genuine delivery progression
as duplicates. See
[DECISIONS.md](DECISIONS.md#d-007--idempotency-keys-differ-for-messages-and-statuses).

### Status meanings — read this carefully

| Status | What it actually means |
|---|---|
| `RECEIVED` | An inbound customer message we stored |
| `SENT` | **The Cloud API accepted our request.** The customer has *not* necessarily received anything |
| `DELIVERED` | Meta confirms it reached the customer's device |
| `READ` | The customer opened it (if they have read receipts on) |
| `FAILED` | Delivery failed. Check the Log sheet for the error code |

`SENT` ≠ delivered. This distinction is the whole reason status webhooks exist.

---

## Sheet 4 — `Log`

The audit and operations log. One row per system event.

| Column | Type | Notes |
|---|---|---|
| `event_id` | text | Usually the correlation id |
| `event_type` | text | `AGENT_ASSIGNED`, `WAITING_FOR_AGENT`, `WORKFLOW_ERROR`, … |
| `conversation_id` | text | When applicable |
| `message_id` | text | When applicable |
| `source` | text | `meta_webhook`, `assignment_engine`, workflow name |
| `timestamp` | ISO-8601 UTC | |
| `status` | text | `ASSIGNED`, `WAITING_FOR_AGENT`, `FAILED` |
| `error` | text | Error message or unassigned reason, truncated to 500 chars |
| `details` | text | Compact JSON — see the audit strategy below |

### Audit strategy — why raw payloads are NOT stored

Dumping whole webhook payloads into cells would bloat the spreadsheet, slow
every read, and push it toward the cell limit — while making the sheet unusable
for the humans it exists for. Google also caps a cell at 50,000 characters, so a
large payload would be truncated mid-JSON and become unparseable anyway.

Instead:

1. **Identifiers are stored** — `message_id`, `conversation_id`,
   `correlation_id` — which is enough to trace anything.
2. **Decision context is stored** — for assignment, the `details` column holds
   a compact array of every agent considered with their eligibility and reason.
   That is what you need at 3am, and it is a few hundred bytes.
3. **The full payload lives in n8n's execution log**, which is built for it and
   is reachable by execution id.
4. **Media is referenced, not copied** — `raw_event_reference` holds the Meta
   media id.

So the answer to "what happened to this message?" is: `correlation_id` → Events
row → decision context → n8n execution for the raw bytes if truly needed.

### Example assignment audit row

| event_id | event_type | conversation_id | source | status | details |
|---|---|---|---|---|---|
| corr-a1b2c3d4e5f60718 | AGENT_ASSIGNED | CONV-1065…-9627…-1788969600000 | assignment_engine | ASSIGNED | `[{"agent_id":"A1","eligible":false,"reasons":["AT_CAPACITY"],"open":5,"max":5},{"agent_id":"A2","eligible":true,"reasons":[],"open":3,"max":5}]` |

That row answers "why did A2 get it and not A1" without any guesswork.

---

## Archiving

Workflow 8 runs nightly at 03:00 and moves conversations that have been
`CLOSED` for longer than `ARCHIVE_AFTER_DAYS` (default 30) into
`Archive`, keeping the working sheet small and responsive.

Three safety rules make this non-destructive in practice:

1. **Only `CLOSED` rows are touched.** An open conversation is live work.
2. **Copy before delete.** The archive-append node stops the workflow on error,
   so a failed copy can never be followed by a delete.
3. **Delete bottom-up.** Rows are processed in descending `row_number` order,
   because deleting a row shifts every row beneath it — deleting top-down would
   corrupt the indices of rows still queued.

A row whose `closed_at` cannot be parsed is skipped rather than archived on a
guess.

Set `ARCHIVE_AFTER_DAYS=0` to disable. Tune `ARCHIVE_BATCH_SIZE` (default 200)
to stay within the write quota on a first, large run.

**Rough sizing.** At 100 conversations/day with a 30-day window, the working
sheet holds roughly 3,000 rows — fast to load and filter — while history
accumulates in the archive tab.

---

## Growth limits

| Limit | Value | When it bites |
|---|---|---|
| Cells per spreadsheet | 10,000,000 | ~350k message rows at 28 columns |
| Read requests | 300/min/project, **60/min/user** | **This is the real ceiling** |
| Write requests | 300/min/project, **60/min/user** | |
| Cell character limit | 50,000 | Why raw payloads are not stored |

The binding constraint is **60 reads per minute per user**, not storage. One
inbound message costs several reads (dedupe check, conversation lookup, agent
list), so sustained throughput is roughly **10–15 messages per minute** before
quota errors appear.

That is the trigger for migrating to PostgreSQL — not the cell count. See
[GOOGLE_SHEETS_TO_POSTGRES.md](GOOGLE_SHEETS_TO_POSTGRES.md).

---

## Safe manual editing

The sheet is meant to be edited by humans — that is much of its value — but some
columns are system-owned.

**Safe to edit:**
`Agents`: `name`, `phone`, `active`, `available`, `max_open_conversations`,
`role`, `working_hours`, `timezone`.
`Conversations`: `status` (to close/reopen), `customer_name`.

**Do not edit:**
Any `*_id` column, `open_conversations`, `last_assigned_at`, `dedupe_key`, any
`*_at` timestamp, `unread`.

**Never delete a row** while the system is running — deleting shifts every row
below it, and an in-flight update addressing a row can then write to the wrong
one. Close conversations instead of deleting them.
