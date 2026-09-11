# Operating Guide — replying fast

Every way a team can answer customers with this system, how fast each one is,
and what it costs to set up. Written for the person choosing how the company
will actually work day to day.

---

## The three reply paths — all now tracked

Originally only one of these was visible to the system. With **Coexistence**
([COEXISTENCE.md](COEXISTENCE.md)) enabled, all three are recorded, and the
`sent_via` column tells you which was used.

| Path | Latency | Setup | Best for |
|---|---|---|---|
| **WhatsApp Business App** | **Instant** | Coexistence onboarding | Agents doing volume — real chat UI, voice notes, media |
| **Google Sheet `reply_text`** | **≤ 60 s** | None — it is already there | Managers, supervisors, occasional responders |
| **API `/webhook/agent/send`** | **Instant** | Needs a caller | The future inbox, automations, bots |

### A realistic setup for a small team

- **Agents** work in the **WhatsApp Business App** on the business number.
  It is the fastest and needs no training — it is just WhatsApp. Every reply
  produces a `smb_message_echoes` webhook, so the conversation advances to
  `REPLIED` automatically.
- **Supervisors** watch the **Conversations sheet**, filtered to
  `UNANSWERED` sorted oldest-first, and reply from there when something is
  aging.
- **The API** stays reserved for the inbox when you build it.

Nobody has to change tools to get tracking. That was the whole problem before.

### The one path that is still invisible

Clicking `wa.me` and replying from a **personal** WhatsApp account. Coexistence
tracks the *business number*, not the person. The optional in-sheet menu warns about this
whenever someone opens a chat from the sheet.

---

## Replying from the sheet

**Type the message into `reply_text` and press Enter.** That is the whole
instruction. Within a minute it is sent over the Cloud API, the cell is cleared,
and the outcome appears in `reply_status`.

Do not set `reply_status` yourself — it is what the system writes back, not a
command. (It used to be treated as a guard, which meant setting it to `SENT`,
the obvious way to say "send this", silently dropped the message. It no longer
does anything of the sort.)

### Messaging a number that is not in the sheet

Add a row, fill in `customer_phone` and `reply_text`, leave everything else
blank. The message goes out the same way and the row becomes a real conversation.

Meta's 24-hour rule applies: a free-form message only reaches someone who wrote
to you within the last 24 hours. Outside that window Meta rejects it and the row
reads `FAILED` with error `131047`. Reaching an older contact needs an approved
template, which this system does not send — see
[CLIENT_ONBOARDING.md](CLIENT_ONBOARDING.md).

### What you see afterwards

| `reply_status` | Meaning |
|---|---|
| *(blank)* with text present | Queued — will send within a minute |
| `SENT` | Accepted by the Cloud API; `reply_text` cleared |
| `FAILED` | Not sent. `reply_error` says why; the row is otherwise untouched |

Nothing is ever sent twice: the cell is emptied the moment the message goes out,
so text sitting in `reply_text` always means "not sent yet".

### Handing a conversation to someone else

Pick a different name in `assigned_agent_name`. The dropdown is fed from the
`Agents` tab, so names cannot be mistyped — which matters, because routing and
the dashboard both key on it.

The system does **not** reassign a conversation on its own once it has an owner.
Follow-up messages from the same customer stay with the same agent; only the
status returns to `UNANSWERED` so it reappears in the queue.

### Archiving

Set `status` to `ARCHIVED`. Within a minute the row is copied to the `Archive`
tab with an `archived_at` timestamp and removed from `Conversations`. Nothing is
deleted — the copy happens before the removal.

Conversations left `CLOSED` longer than `ARCHIVE_AFTER_DAYS` are swept the same
way automatically.

### Why one minute, not instant

Polling faster burns the Google Sheets read quota (60 reads/minute/user) for no
perceptible benefit. If you need true instant replies from a UI, that is what
the agent inbox is for — or use the Business App, which is already instant.

---

## Filtering — what managers actually need

Run `node scripts/setup/apply-sheet-layout.js` and the Conversations tab arrives
already colour-coded:

| Colour | Meaning |
|---|---|
| **Red row** | `WAITING_FOR_AGENT` — nobody owns this |
| **Amber row** | `UNANSWERED` — customer is waiting |
| **Bright red + white text** | `UNANSWERED` for **over an hour** — this is the SLA risk |
| **Green row** | `REPLIED` — ball is in the customer's court |
| **Grey row** | `CLOSED` |
| **Blue `reply_text` cell** | A reply is queued to send |
| **Red `reply_status`** | A reply failed |

You can see the state of the whole desk without reading a single word.

### Recommended filter views

Create these once (*Data → Filter views → Create new*). The menu item
*Filter view instructions* prints the exact recipe.

| View | Filter | Use |
|---|---|---|
| **Needs attention** | `status` is `UNANSWERED` or `WAITING_FOR_AGENT`, sorted by `last_customer_message_at` **ascending** | The working queue. Oldest waiting first |
| **Unassigned** | `status = WAITING_FOR_AGENT` | Staffing gaps — nobody could take these |
| **By agent** | `assigned_agent_name = …` | One person's workload |
| **Unread** | `unread` checked | Not yet answered |
| **Failed replies** | `reply_status = FAILED` | Things that did not send |
| **Today** | `last_activity_at ≥ today` | Today's activity |
| **Closed** | `status = CLOSED` | History |

> **Filter *views* are per-person.** Yours does not change what colleagues see.
> A plain filter does — which is why views are the right tool for a shared
> sheet.

**Any column can be filtered**, including ones not listed here — customer name,
phone, business number, message text, dates. Nothing about the design restricts
which columns are filterable.

---

## Speed: what actually determines response time

| Stage | Time | Controlled by |
|---|---|---|
| Customer sends → Meta | < 1 s | Meta |
| Meta → our webhook | < 1 s | Meta, your network |
| Webhook acknowledged | **< 100 ms** | Us — we ack before doing any work |
| Conversation created + agent assigned | 2–5 s | Google Sheets round-trips |
| Row visible in the sheet | 2–5 s | Same |
| **Agent notices** | **seconds to hours** | **Your process — this is the real variable** |
| Reply sent | instant (app) / ≤ 60 s (sheet) | Path chosen |

The technical pipeline is a few seconds end to end. **Response time is almost
entirely a function of whether an agent is looking.** That is a staffing and
notification question, not an engineering one.

### Making agents notice

| Option | Effort | Effect |
|---|---|---|
| WhatsApp Business App on agents' phones | None | **Push notification per message** — by far the most effective |
| Sheet open on a second monitor, "Needs attention" view | None | Passive but works for a supervisor |
| Add an n8n notification step (email/Telegram/Slack on assignment) | Small | Alerts the specific assigned agent |
| Agent inbox with WebSocket | Large | Real-time, plus queueing and search |

The first line is worth emphasising: with Coexistence, agents get **native
WhatsApp push notifications** and reply in the app they already know. That is
the fastest possible loop, and it needs no software from us.

### And a financial reason to be fast

Replies within the customer's 24-hour window are **free**. After it, only a paid
template message can be sent. Slow responses convert free conversations into
billable ones — see
[META_WHATSAPP_SETUP.md](META_WHATSAPP_SETUP.md#the-24-hour-customer-service-window).

---

## Archiving — keeping the sheet fast

Workflow 8 runs nightly at 03:00 and moves conversations `CLOSED` for longer
than `ARCHIVE_AFTER_DAYS` (default 30) into `Archive`.

| Setting | Default | Effect |
|---|---|---|
| `ARCHIVE_AFTER_DAYS` | `30` | Age after closing before archiving. `0` disables |
| `ARCHIVE_BATCH_SIZE` | `200` | Rows per run — keeps a first large run inside quota |

**Sizing.** At 100 conversations/day with a 30-day window, the working sheet
holds roughly 3,000 rows: fast to open, filter and scroll. History accumulates
in the archive tab, which nobody opens daily so its size does not matter.

### Three safety rules

1. **Only `CLOSED` rows** are ever archived. An open conversation is live work —
   archiving it would hide a waiting customer.
2. **Copy before delete.** The archive-append node halts the workflow on error,
   so a failed copy can never be followed by a delete.
3. **Delete bottom-up.** Rows are processed in descending `row_number`, because
   deleting a row shifts every row beneath it. Top-down deletion would corrupt
   the indices of rows still queued — this is the classic way to lose data in a
   spreadsheet.

A row whose `closed_at` cannot be parsed is **skipped**, not archived on a
guess.

### Manual archiving

The same effect without waiting for the schedule: filter to `CLOSED`, select the
rows, cut, and paste into `Archive`. The workflow is a convenience,
not a lock-in.

---

## Changing things

### Agents — no code, no restart

Edit the **Agents** tab. Add a row to add an agent. Untick `available` for a
break. Change `max_open_conversations` to change capacity. Routing picks up the
change on the next message.

`active` and `available` are real checkboxes, which matters: the assignment
engine **fails closed** on any value it does not recognise, so a typed "yes" or
"maybe" would silently take an agent out of rotation. A checkbox makes that
impossible.

### Settings — edit `.env`, restart

```bash
nano .env
docker compose up -d
node scripts/validation/check-env.js    # confirms what is set; never prints values
```

Common changes:

| Want to | Set |
|---|---|
| Switch to round-robin | `ASSIGNMENT_STRATEGY=ROUND_ROBIN` |
| Stop closed conversations reopening | `REOPEN_CLOSED_CONVERSATIONS=false` |
| Archive after 60 days | `ARCHIVE_AFTER_DAYS=60` |
| Turn archiving off | `ARCHIVE_AFTER_DAYS=0` |
| Upgrade Graph API version | `META_GRAPH_API_VERSION=v27.0` |
| Change inactivity threshold | `CONVERSATION_INACTIVITY_HOURS=48` |

### Credentials — in the n8n UI

*Credentials* → open → edit → save. Rotating a Meta token is one field. Nothing
is redeployed and no workflow changes.

Credentials are stored encrypted with `N8N_ENCRYPTION_KEY` and are never written
into workflow JSON, so exporting a workflow cannot leak a token.

### Workflows — edit the builder, not the UI

Workflow JSON is **generated**. Editing in the n8n UI works for experimenting,
but the next import overwrites it and the change is never tested.

```bash
# logic  -> scripts/lib/*.js        (then add a test)
# shape  -> scripts/setup/build-workflows.js

node tests/run-tests.js
node scripts/setup/build-workflows.js
node scripts/validation/validate-workflows.js
node scripts/setup/import-workflows.js
# republish the changed workflows, restart n8n
```

This is deliberate. A fix typed into the UI is untested and disappears on the
next deploy; a fix in `scripts/lib/` is tested and permanent. See
[DECISIONS.md](DECISIONS.md#d-004--business-logic-lives-outside-n8n-and-is-inlined-at-build-time).

### Checking nothing drifted

```bash
node scripts/validation/check-schema-consistency.js
```

Column names exist in three places — the CSV templates, the Apps Script, and the
workflow JSON. If they disagree, a workflow writes to a column that does not
exist, **Google Sheets accepts it, nothing errors, and the data lands nowhere**.
This catches that.

---

## Choosing a setup

**Smallest — one or two people, low volume.** Sheet only. Reply via the
`reply_text` column and the menu. No Coexistence, no app. Works today.

**Recommended — a real support team.** Coexistence on, agents in the WhatsApp
Business App with push notifications, supervisor on the sheet. Instant replies,
full tracking, native mobile UX, nothing to build.

**Larger — many agents, high volume.** Migrate to PostgreSQL
([GOOGLE_SHEETS_TO_POSTGRES.md](GOOGLE_SHEETS_TO_POSTGRES.md)) and build the
inbox ([FUTURE_AGENT_INBOX.md](FUTURE_AGENT_INBOX.md)). The trigger is
throughput — around 10–15 messages/minute is where Sheets' quota binds — not
number of conversations stored.

---

## Limits worth knowing before you commit

| Limit | Value | What it means |
|---|---|---|
| Sheets reads | 60/min/user | ~10–15 inbound messages/minute sustained |
| Sheet reply latency | ~60 s | Use the Business App if you need instant |
| Concurrency | 1 assignment at a time | Required for correctness on Sheets |
| Business App inactivity | Open it every 13 days | Or Coexistence stops working |
| 24-hour window | Free replies inside it only | After that, paid templates |
| Personal-account replies | Not tracked | Use the business number |
