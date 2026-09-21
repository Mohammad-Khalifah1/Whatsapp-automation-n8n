# Google Sheets Schema

Six tabs in one spreadsheet: four a person uses, two the system maintains.
Ready-to-paste header rows and sample data are in
[`sheets-templates/`](../sheets-templates/).

| Tab | Who touches it | What it holds |
|---|---|---|
| `Dashboard` | read only | Live totals, computed by formula from the tabs below |
| `Conversations` | **this is where you work** | One row per customer |
| `Agents` | edited by a manager | The routing configuration, one row per team member |
| `Archive` | read, occasionally | Conversations that have been archived |
| `Messages` | hidden; system | One row per message, and the duplicate check |
| `Log` | hidden; system | System events and errors |

`Messages` and `Log` are hidden by default because nobody edits them. They are
still written and read by the workflows every minute; hiding a tab changes
nothing about how the API sees it. Unhide either from the sheet tab bar.

Every tab carries a note on cell A1 explaining what it is for and how to use it.
Hover A1 to read it.

**Golden rule:** one row per *thing*.
One row per conversation in `Conversations`. One row per message in `Messages`.
One row per system event in `Log`. Messages never go in `Conversations` —
that is what makes the conversation view readable by a manager.

---

## Setting the sheet up

```
node scripts/setup/apply-sheet-layout.js            # show what it would change
node scripts/setup/apply-sheet-layout.js --dry-run
```

One command creates every tab with the right columns, freezes and styles the
header, adds the dropdowns, colours each value, sets column widths, hides the
system columns and the system tabs, writes the note on A1 of each tab, and puts
the tabs in the order they are used.

It is safe to re-run. Existing rows are re-mapped **by column name**, so adding
or reordering a column never shifts a value under the wrong heading, and no row
is dropped. If row 1 does not look like a header it stops rather than migrating,
because mapping by name from a non-header blanks every row — which is exactly
what happened once, and why the guard exists.

It authenticates with the same service account the workflows use, so a new
deployment needs no manual step in the spreadsheet at all.

[`sheets-templates/SheetTools.gs`](../sheets-templates/SheetTools.gs) is still
there for anyone who wants an in-sheet **WhatsApp Support** menu (reply dialog,
open chat, recalculate agent load). It has to be pasted into *Extensions → Apps
Script* and authorised by hand. **Nothing depends on it** — archiving, dropdowns
and colours all work without it.

Verify the schema stays consistent across the CSVs, the Apps Script and the
workflows:

---|---|
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
2. Create the tabs named exactly: `Agents`, `Conversations`, `Messages`,
   `Log`, `Archive`, `Dashboard`. Names are case-sensitive and are referenced by the
   workflows.
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
| `last_assigned_at` | ISO-8601 | **system** | Tie-breaker input. Blank = never assigned. |
| `role` | text | human | Informational, e.g. `agent`, `supervisor` |
| `working_hours` | text | human | Informational — **not enforced** |
| `timezone` | text | human | Informational — **not enforced** |
| `created_at` | ISO-8601 | human | |
| `updated_at` | ISO-8601 | **system** | |

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

One row per customer. This is the tab people actually live in, so the columns
are ordered for reading: who, what they said, what kind of message, which
direction, when — then the controls, then everything the system maintains.

The columns from `conversation_id` onward are hidden by default. They are real
columns with real data; unhide them from the column headers when tracing
something.

| # | Column | Type | Written by | Notes |
|---|---|---|---|---|
| 1 | `customer_name` | text | system | WhatsApp profile name; may be blank |
| 2 | `customer_phone` | text | system | E.164, no `+`. Primary key in practice. |
| 3 | `assigned_agent_name` | dropdown | **human** or system | Dropdown fed from the `Agents` tab. Change it to hand the conversation over. |
| 4 | `status` | dropdown | **human** or system | See below. Set `ARCHIVED` to move the row out. |
| 5 | `unanswered_count` | number | system | How many messages are still waiting for a reply |
| 6 | `unanswered_messages` | text | system | **Every message nobody has answered yet**, newest first — see below |
| 7 | `last_message` | text | system | What was said last |
| 8 | `last_message_type` | dropdown | system | `text`, `image`, `audio`, … A row reading `image` with no text is a customer who sent a photo, not one who sent nothing. |
| 9 | `last_message_direction` | dropdown | system | `inbound` = the customer sent it, `outbound` = your team did |
| 10 | `product` | text | **human** | Never touched by the system |
| 11 | `quantity` | text | **human** | Never touched by the system |
| 12 | `first_message_at` | ISO-8601 | system | First contact. Written once, never updated — response time is measured from here. |
| 13 | `last_activity_at` | ISO-8601 | system | Drives inactivity and archiving |
| 14 | `reply_text` | text | **human** | **Type here to send a WhatsApp message** — see below |
| 15 | `reply_status` | dropdown | system | `SENT` or `FAILED`, written by the system |
| 16 | `unread` | TRUE/FALSE | system | TRUE when the customer spoke last |
| 17 | `wa_link` | URL | system | `https://wa.me/<e164>` |
| 18 | `conversation_id` | text | system | `CONV-<biz>-<customer>-<epoch>` |
| 19 | `assigned_agent_id` | text | system | Blank while `WAITING_FOR_AGENT` |
| 20 | `business_phone_number_id` | text | system | Which of your numbers received it |
| 21 | `last_message_id` | text | system | `wamid...` |
| 22 | `last_customer_message_at` | ISO-8601 | system | |
| 23 | `last_agent_message_at` | ISO-8601 | system | Blank until a reply is sent |
| 24 | `created_at` | ISO-8601 | system | |
| 25 | `updated_at` | ISO-8601 | system | |
| 26 | `closed_at` | ISO-8601 | system | Blank unless `CLOSED`; cleared on reopen |
| 27 | `unassigned_reason` | text | system | Why nobody was assigned; blank when assigned |
| 28 | `reply_error` | text | system | Why a reply failed |
| 29 | `reply_sent_at` | ISO-8601 | system | When it was sent |

Timestamps are ISO-8601 **with an explicit UTC offset**, in the timezone set by
`TZ` (`Asia/Amman` here), so the sheet shows the time the team actually saw.
The offset travels with the value, so no timestamp is ambiguous and every one
of them sorts correctly.

### The messages nobody has answered

`last_message` holds one value, so a customer who writes three times before
anyone replies leaves only the third visible in that column. The other two are
not lost — they are in `Messages` — but they are invisible on the tab people
actually work in, which is where "have we answered them" gets decided.

`unanswered_messages` is everything still owed a reply, newest first, in one
cell:

```
19:18  في حدا؟
19:17  بدي أستفسر عن السعر
19:17  السلام عليكم
```

It grows with every inbound message and is cleared the moment a reply goes out.
Nothing else clears it — in particular, a reply that **failed** leaves it alone,
because the customer is still waiting. `unanswered_count` is the same thing as a
number, so a filter view can sort by who has been waiting longest and the
dashboard can count it.

It keeps the newest 10 messages. A customer who sends forty should not make the
row unreadable.

### Replying from the sheet

Type a message into **`reply_text`**. Within a minute, workflow 7 sends it over
the Cloud API, **clears the cell**, and writes the outcome into `reply_status`:
`SENT`, or `FAILED` with the reason in `reply_error`.

**`reply_text` being non-empty is the instruction to send.** Nothing else needs
setting. `reply_status` is an *outcome*, not a command — an earlier version
treated it as a guard, which meant anyone who set it to `SENT` themselves, the
obvious way to say "send this", had their message silently dropped.

Double-sending is prevented by the clear, not by a status: the cell is emptied
the moment the message goes out, so text sitting in `reply_text` always means
"not sent yet".

**To message a number that is not in the sheet**, add a row and fill in
`customer_phone` and `reply_text`. The rest is filled in for you. Note Meta's
24-hour rule: a free-form message can only reach someone who wrote to you in the
last 24 hours. Outside that window Meta rejects it and the row reads `FAILED`
with error `131047`. See [CLIENT_ONBOARDING.md](CLIENT_ONBOARDING.md).

Every reply sent this way is recorded in `Messages` with
`sent_via = google_sheet`.

### Archiving

Set `status` to `ARCHIVED`. Within a minute the row is copied to `Archive` with
an `archived_at` timestamp and removed from `Conversations`. The copy happens
before the delete, so an interruption leaves a duplicate rather than a hole.

Conversations left `CLOSED` for longer than `ARCHIVE_AFTER_DAYS` are swept the
same way automatically.

`Archive` has exactly the same columns as `Conversations`, plus `archived_at` —
enforced by `scripts/validation/check-schema-consistency.js`, so the two tabs
cannot drift apart.

### Status values

| Status | Meaning | Manager action |
|---|---|---|
| `WAITING_FOR_AGENT` | Nobody could take it | **Staffing problem — look now** |
| `UNANSWERED` | Assigned, customer waiting | **Response-time clock is running** |
| `REPLIED` | Agent answered last | Waiting on customer |
| `WAITING_FOR_CUSTOMER` | Reserved synonym of `REPLIED` | Not written by the system |
| `CLOSED` | Finished | — |

"Open" is not a status; it is `status != CLOSED`.

### Recommended filter views

Create these once (*Data → Create a filter view*) and managers can switch
between them:

| View | Filter | Purpose |
|---|---|---|
| **Newest first** | none; sorted by `last_activity_at` descending. **Created by `apply-sheet-layout.js`** | What just moved, at the top. Replaces the old automatic sort of the tab, which moved rows under the system's own writes |
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

**Who is who.** Three columns answer it, and none of them needs you to know the
direction first:

| Column | Always holds |
|---|---|
| `customer_phone` | **The customer**, whichever way the message went |
| `direction` | `inbound` = they sent it to your business number. `outbound` = your business number sent it to them |
| `sender_phone` | Whoever sent this one — your business number when `outbound` |
| `recipient_phone` | Whoever received it — your business number when `inbound` |
| `status` | The delivery state of **this message**: `RECEIVED` for one that arrived, then `SENT`, `DELIVERED`, `READ` or `FAILED` for one you sent. Not a conversation state. |

`customer_phone` exists because `sender_phone` alone is ambiguous: reading a row
meant checking `direction` first to work out whose number you were looking at.

The customer's **name** is optional — WhatsApp only supplies it if the customer
has set a profile name. The **number** is not: it is how a conversation is found
and how a reply is addressed.


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
| `timestamp` | ISO-8601 | When Meta says it happened |
| `status` | enum | `RECEIVED` \| `SENT` \| `DELIVERED` \| `READ` \| `FAILED` |
| `status_updated_at` | ISO-8601 | Last status change |
| `agent_id` | text | For outbound: who sent it |
| `sent_via` | text | `cloud_api` \| `whatsapp_business_app` \| `google_sheet` |
| `supported` | TRUE/FALSE | FALSE for message types we do not yet handle |
| `processing_status` | text | `parsed` \| `unsupported` \| `deferred` |
| `correlation_id` | text | Traces one webhook across all sheets and logs |
| `raw_event_reference` | text | Media id, so the file can be fetched later |
| `created_at` | ISO-8601 | When we wrote the row |
| `category` | text | This message's own classification. The conversation's `category` is the latest message that actually matched — per-message values let you see a thread that started as a price enquiry and became a complaint |

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
| `timestamp` | ISO-8601 | |
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
| Cells per spreadsheet | 10,000,000 | ~520k message rows at 19 columns |
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

**Never sort the tab itself** (*Data → Sort range*, or the sort in a plain
filter) while the system is running. A sort moves rows exactly the way a delete
does. Sort inside a **filter view** instead: it orders what you see and moves
nothing. The system no longer sorts the tab either; `Newest first` is a filter
view created by `apply-sheet-layout.js`.
