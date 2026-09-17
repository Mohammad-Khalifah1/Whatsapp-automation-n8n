# Future: task board, employee management, and AI agents

**Not built.** A planning document, in the same spirit as
[FUTURE_AI.md](FUTURE_AI.md) and [FUTURE_AGENT_INBOX.md](FUTURE_AGENT_INBOX.md)
— it documents what to add, in what order, and exactly what each step risks
against the system that is already live and verified. Read those two first;
this one extends them rather than repeating them.

Four questions drove this document, asked together:

1. What should be hardened on the WAHA connector, and what is still missing?
2. How can conversations become a per-employee to-do list, task by task?
3. How are employees added/edited, and how are requests — from an employee or
   from AI — tracked?
4. How is an AI agent kept from being detected as a bot, and from answering
   outside the scope of this business?

Every proposal below is graded **Safe** (additive, does not touch a verified
path), **Caution** (touches existing logic, needs re-verification), or
**Structural** (needs the Postgres migration in
[GOOGLE_SHEETS_TO_POSTGRES.md](GOOGLE_SHEETS_TO_POSTGRES.md) first). Nothing
here is sequenced ahead of that grading — build the Safe items first.

---

## 0. Ground truth this plan builds on

Checked directly against the code, not assumed:

| Fact | Where |
|---|---|
| Conversation status is one of `WAITING_FOR_AGENT, UNANSWERED, REPLIED, WAITING_FOR_CUSTOMER, CLOSED` (+ `ARCHIVED`, a separate tab) | `sheets-templates/SetupSheet.gs:85` |
| Agents are rows with `agent_id, name, phone, active, available, max_open_conversations, open_conversations, ...` | `sheets-templates/Agents.csv` |
| There is **no per-agent saved view today** — `createFilterViews_` only applies one generic filter dropdown to the whole Conversations tab; Apps Script cannot create named Filter Views programmatically, and the code says so | `sheets-templates/SetupSheet.gs:334` |
| System-owned columns are protected **warning-only**, not locked, because the service account must still write them | `sheets-templates/SetupSheet.gs:355` |
| AI is explicitly kept out of the routing path, enrichment only, async, after assignment | `docs/FUTURE_AI.md` |
| A full agent inbox (auth, roles, notes, reassignment) is already designed, gated on migrating off Sheets | `docs/FUTURE_AGENT_INBOX.md` |

The task-board and employee-management asks below are, structurally, **Phase 1
of `FUTURE_AGENT_INBOX.md` wearing different labels.** A status is a task
state; a conversation is a task; an agent is an assignee. Building toward that
existing design — rather than a parallel one — is why this document leans on
it instead of inventing new terms.

---

## 1. WAHA connector — hardening punch list

Everything below extends [WAHA_CONNECTOR.md](WAHA_CONNECTOR.md)'s "known gaps"
section with the full picture. Ordered by what would actually break first in
real use.

| Gap | Risk if skipped | Grade |
|---|---|---|
| **Media messages** (image/audio/document/voice) arrive as a placeholder string, not real content | An agent sees `[media via WAHA]` instead of the photo a customer sent — the most common real support message type is unusable | Safe — isolated to workflow 1b's adapter node |
| **No end-to-end proof script** for the WAHA path (unlike `scripts/testing/verify-live.js` for Meta) | Every claim about WAHA working is a claim, not a verified fact, until someone scans and sends for real | Safe — new script, touches nothing |
| **Session-drop has no alerting** — observed directly this session: an unscanned QR silently moves the session to `FAILED` with nothing surfaced anywhere | The number goes dark and nobody notices until a customer complains | Safe — a scheduled workflow polling `GET /api/sessions/default`, alerting the same way `ALTERNATIVES.md` already recommends for the agent notification gap (Telegram, $0) |
| **`.sessions` volume has no backup** | Losing the volume means re-scanning the QR — a real number in active use goes offline until someone is physically present with the phone | Safe — `docker cp` or a scheduled tar of the named volume to the same Backblaze B2 target already priced in `ALTERNATIVES.md` |
| **Group messages are unhandled** — `payload.from` for a group is `...@g.us`, not `...@c.us`; the adapter's phone-parsing (`split('@')[0]`) would silently misinterpret it as a customer phone number | A message from a group chat could create a bogus "conversation" with a garbage phone number | Caution — needs an explicit `if (waId includes '@g.us') → drop or route separately` branch in the workflow 1b adapter before this is safe to expose to a number that might be in any group |
| **HMAC verification unexercised against a real signed request** | The code path is unit-linted, not proven; a mismatched header-name assumption would silently reject every real webhook | Safe — one real scan-and-send closes this |
| **No outbound pacing on the WAHA send path** | Directly feeds into §4 below — sends fire the instant the sheet is polled, with no human-like delay | Safe — see §4 |
| **Multi-session (multiple WAHA-linked numbers) untested** | The adapter derives `business_phone_number_id` from the session name, which should generalize, but nobody has run two sessions at once | Caution — test before relying on more than one WAHA number |
| **No `reply_to` / quoted-message support on the WAHA outbound path** | Meta's path can thread a reply to a specific message (`context.message_id`); WAHA's does not yet, so an agent's reply always appears as a fresh message | Safe — WAHA's `sendText` supports a `reply_to` field; wire it the same way `reply_to_message_id` already flows through workflow 4 |

**Suggested order:** alerting → backup → group-message guard → media parsing →
proof script → pacing (§4) → multi-session test.

---

## 2. Conversations as a to-do list, per employee

### What already exists

The status field is already, structurally, a task-board column. No new data
is required — this is a **view** problem, not a schema problem:

| Status | To-do framing |
|---|---|
| `WAITING_FOR_AGENT` | Backlog — unassigned, needs a human to pick it up |
| `UNANSWERED` | **To Do** — assigned, customer is waiting on this agent |
| `REPLIED` / `WAITING_FOR_CUSTOMER` | Waiting — ball is in the customer's court |
| `CLOSED` | Done |

### Phase A (Safe) — inside the existing Sheet, no new infrastructure

1. **A real per-agent tab, not a shared filter.** `createFilterViews_` cannot
   make named Filter Views by API, but `QUERY`/`FILTER` formulas can build a
   **live, read-only tab per agent** (`Ahmed — My Tasks`, `Sara — My Tasks`,
   …) that shows only their `UNANSWERED` and `WAITING_FOR_AGENT`-eligible
   rows, newest-first, with a `reply_text` cell that still writes back to the
   real Conversations row (Sheets supports this via `IMPORTRANGE` /
   cross-tab formulas, or simply linking each cell). This is the same
   generated-on-every-run pattern the Dashboard tab already uses
   (`buildDashboard_` in `SetupSheet.gs`) — safe to add the same way, by
   extending `setupEverything()` with a new `buildAgentTaskTabs_()` function.
2. **A "my open count" badge** next to each agent's name in the Agents tab —
   already computable from existing columns (`recalculateAgentLoad` already
   exists and does something adjacent — extend it, do not duplicate it).
3. **A checkbox-driven "mark done" column** on each per-agent tab, which
   writes `CLOSED` back to the source row through the same mechanism
   `closeSelected()` already uses from the menu — this reuses tested code
   instead of adding a second way to close a conversation.

None of this touches workflows 1–8, n8n, or WAHA. It is entirely a
`SetupSheet.gs` extension, tested the way the Dashboard tab already is.

### Phase B (Structural) — a real task board UI

This is `FUTURE_AGENT_INBOX.md` Phase 1 exactly: a web view where
`GET /api/conversations?status=UNANSWERED&agent_id=me` renders as a Kanban
board with the same four columns above. It needs the Postgres migration
first, for the reason already stated there: Sheets cannot serve an indexed,
multi-agent, real-time board at any real conversation volume.

**Do Phase A before Phase B.** Phase A proves the task-board framing is what
the team actually wants to use daily, on infrastructure that costs nothing
extra and risks nothing, before spending the migration effort.

---

## 3. Employee management, and logging requests

### Adding / editing employees

**Today:** an employee is a row in the Agents tab. Adding one means adding a
row with a fresh `agent_id`; editing means editing cells. `active` and
`available` already gate whether someone receives new assignments — an
employee going on leave is already just flipping `active` to `FALSE`, no
special path needed. `protectSystemColumns_` already warns before anyone
overwrites a column the automation owns (`open_conversations`,
`last_assigned_at`).

**What is missing is validation, not capability:**

| Gap | Fix | Grade |
|---|---|---|
| Nothing stops a duplicate `agent_id` or a malformed phone number | A Sheets `onEdit` trigger validating the Agents tab, mirroring the `requireValueInList` pattern already used for `CONVERSATION_STATUSES` | Safe |
| No audit of who changed an agent's `max_open_conversations` or deactivated them | An `Agent_Changes` log tab, written by the same `onEdit` trigger, capturing old value → new value → editor email (`Session.getActiveUser()`) → timestamp | Safe |
| Adding an agent means knowing the schema by heart | A menu item ("Add employee…") that prompts for name/phone/role and inserts a correctly-shaped row, generating the `agent_id` | Safe — same `onOpen()` menu `SetupSheet.gs` already extends |

None of this requires n8n changes. It is entirely a `SetupSheet.gs`
extension.

### Logging requests — from an employee, or from AI

"Request" here means: an agent asking for something (a reassignment, a
supervisor's attention, more capacity) or an AI enrichment producing a
suggestion that needs a human decision. Both are **events**, and this system
already has an events concept (`Log` tab, referenced throughout the
architecture) — the honest move is one unified log, not two:

```
Requests / Events tab
  request_id | source (agent|ai) | requester_id | conversation_id |
  kind (reassign|escalate|capacity|ai_suggestion|ai_flag) |
  payload | status (open|actioned|dismissed) | created_at | actioned_by | actioned_at
```

- An **agent** request is a row a Sheets menu item or a small form writes.
- An **AI** request is a row the enrichment workflow in `FUTURE_AI.md` writes
  instead of (or in addition to) its existing "record an Events row" step —
  no new workflow shape, just a specific `kind` value.
- A supervisor view is a filter on this one tab: `status = open`, exactly the
  same to-do framing as §2.

**Grade: Safe.** New tab, new columns, written by existing or additive code
paths. Nothing already verified is touched.

---

## 4. Keeping WhatsApp from flagging agents as bots

Two completely different risk models apply, and conflating them is the most
common mistake in this space:

### On WAHA (unofficial — the real risk)

WAHA automates the WhatsApp Web protocol, which the WhatsApp Terms of Service
do not permit at all. "Looking automated" is exactly the behavioural
fingerprint WhatsApp's abuse detection watches for. There is no setting that
removes this risk — only mitigations that reduce its probability:

| Signal WhatsApp watches for | Mitigation |
|---|---|
| Replies sent instantly, with mechanical regularity | Add jitter before a WAHA send — a random 3–15s delay, not a fixed one. Wire this into workflow 4/7's WAHA branch, not the Meta branch (Meta has no such requirement) |
| No typing indicator before a message appears | Call WAHA's `POST /api/startTyping` before `sendText`, `stopTyping` after — a real human client always does this |
| No read receipt on inbound messages | Call WAHA's `POST /api/sendSeen` on the inbound webhook, before replying — mirrors real client behaviour |
| Sudden high volume, or messaging many **new** contacts in a burst | A rate cap: N sends/minute, enforced the same way `N8N_RUNNERS_TASK_TIMEOUT` already caps runaway Code nodes — a Code node checking a rolling counter before allowing a WAHA send |
| A brand-new session sending at full volume immediately | A warm-up period: cap sends artificially low for the session's first 48–72 hours, exactly as `WAHA_CONNECTOR.md`'s ban-risk warning already implies should be considered |
| Identical text sent to many different numbers | Only relevant if AI auto-replies with templated text at volume — see below. Human agents typing individually do not trigger this |
| Odd hours / 24-7 activity from a number a human "owns" | Respect `working_hours` from the Agents tab — do not send WAHA replies outside it programmatically, even if a human could |

None of this is optional if an **AI** is the one drafting and sending replies
through WAHA — that is precisely the automated-volume, templated-text pattern
detection targets. If AI ever sends through WAHA, **all** of the above must
be in place first, not some of them. If AI only ever produces a *draft* a
human sends (per `FUTURE_AI.md`'s explicit recommendation), most of this
section is moot — a human hitting "send" is not automation from WhatsApp's
point of view, whichever connector carries it.

### On the Meta Cloud API (official — a different risk entirely)

There is no "bot detection" ban risk here — the Cloud API exists specifically
for automated business messaging, and using it as intended is not a Terms of
Service violation. The real, analogous mechanism is Meta's **quality
rating** per phone number (Low/Medium/High), driven by block rate and user
reports, which throttles the messaging tier rather than banning outright. An
AI that answers badly enough to get blocked degrades throughput; it does not
get "detected as a bot" in the WAHA sense.

**Verify before relying on either path:** Meta's Business Messaging Policy on
disclosure of automated/AI responses changes without much notice — the
project's own convention throughout `COSTS.md` and `ALTERNATIVES.md` is to
mark anything not confirmable on Meta's own current page as unconfirmed
rather than assert it. Re-check
<https://developers.facebook.com/docs/whatsapp/overview/getting-started/messaging-policies>
at build time, not from this document.

**Recommendation, matching `FUTURE_AI.md`'s existing stance:** keep AI in
draft-only mode. It removes essentially all of this section's risk for free,
on either connector, and is already the documented recommended path.

---

## 5. Teaching an AI agent the project, so it stays in scope

This is the mechanism `FUTURE_AI.md` assumes but does not detail — how the
model actually gets grounded in *this* business's facts, and how it is kept
from confidently answering outside them.

### The knowledge source

Add one new Sheet tab, `Knowledge`, matching this project's existing
pattern of "the business already knows how to edit a spreadsheet":

```
Knowledge tab
  entry_id | topic | question_pattern | approved_answer | scope_tags | updated_by | updated_at
```

A non-technical person maintains this the same way they already maintain
`Agents`. This is deliberately **not** a general-purpose document dump — a
closed set of approved Q&A pairs, matching `FUTURE_AI.md`'s own guardrail:
*"Restrict to a closed set of approved answers, not free generation."*

### Retrieval, sized to this project

At the scale this system targets (2–20 employees, tens to low hundreds of
conversations/day), a full vector database is over-engineering. Two
options, cheapest first:

1. **Keyword/substring match over the Knowledge tab**, read fresh on every
   enrichment call (it is small enough to fit in one prompt entirely, in
   fact — see below).
2. **Embed the Knowledge tab rows once**, cache the vectors, cosine-similarity
   rank in the enrichment Code node itself — no new infrastructure, since the
   comparison math is a few dozen lines of JavaScript over a few hundred
   rows at most. Re-embed only rows whose `updated_at` changed.

**Only reach for a real vector store (pgvector, once Postgres is in place
per `GOOGLE_SHEETS_TO_POSTGRES.md`) past a few thousand Knowledge rows.**
Below that, it is unneeded complexity this project's own cost-consciousness
argues against.

### The prompt contract that keeps answers in scope

The system prompt for any AI enrichment or draft-reply call should encode,
explicitly, not implicitly:

1. **Identity and boundary.** "You answer only questions covered by the
   Knowledge entries provided below. You do not have — and must not imply
   you have — any other information about this business."
2. **Grounded answering only.** "Answer using only the Knowledge entries
   given in this prompt. If none match, say so explicitly and do not guess."
   This is the single highest-leverage line against hallucination — it turns
   "no matching entry" into an expected, handled case instead of an
   invitation to improvise.
3. **A mandatory escalation phrase**, output as a structured field
   (`in_scope: true/false`), not prose the caller has to parse — matching
   this project's existing convention (`ok`, `reason`, structured fields
   everywhere in `scripts/lib/`) of never inferring success from freeform
   text.
4. **No persona beyond what is configured.** State the business name, the
   language(s) it operates in, and nothing else invented.

### Wiring it into the existing enrichment shape

`FUTURE_AI.md`'s sketch already has the right shape
(`Build Context → Call model API → Parse & validate`). Add one step between
the first two: **Retrieve matching Knowledge rows, inject into the prompt.**
Nothing else in that diagram changes. The confidence threshold and shadow-mode
recommendations already in `FUTURE_AI.md` apply unchanged — this section only
supplies *what* grounds the answer, not a new policy about *when* to trust it.

**Grade: Safe**, with the same condition `FUTURE_AI.md` already states: this
lives in the enrichment path, after assignment, never in the routing path,
and a retrieval failure must degrade to "no suggestion," never to a stalled
webhook.

---

## 6. Suggested build order (nothing here breaks anything already verified)

```
1. WAHA alerting + backup + group-message guard         (Safe, §1)
2. Per-agent task tabs + "mark done" in the Sheet        (Safe, §2 Phase A)
3. Employee add/edit menu + validation + change log      (Safe, §3)
4. Unified Requests/Events log (agent + AI)               (Safe, §3)
5. Knowledge tab + retrieval-augmented enrichment          (Safe, §5 — draft-only, per FUTURE_AI.md)
6. WAHA anti-detection pacing, IF AI is ever allowed to
   send (not just draft) through WAHA                      (Caution, §4)
7. WAHA media parsing + proof script + multi-session test  (Safe→Caution, §1)
8. Postgres migration                                      (Structural — gates everything below)
9. Real task-board web UI (FUTURE_AGENT_INBOX.md Phase 1)  (Structural)
```

Steps 1–5 need no new infrastructure, no credential changes, and touch no
file inside `n8n/workflows/` except additively (new tabs, new menu items, one
new prompt-construction step in an *already-async, already-optional*
enrichment path). Steps 6–7 touch the WAHA connector added this session and
should be re-verified with the same rigor (`node tests/run-tests.js`,
`node scripts/validation/validate-workflows.js`, a real scan-and-send) before
merging. Step 8 is the one hard gate: nothing in "Phase B" of §2 or Phase 1
of `FUTURE_AGENT_INBOX.md` is possible on Google Sheets at any real scale.

## What must not change, restated

Same list `FUTURE_AI.md` already commits to, extended by one line for this
document's scope:

- The webhook must still ack in under 100 ms.
- Conversation creation and assignment must not depend on any AI call.
- An AI outage must degrade to "no suggestions," never to "no routing."
- Every AI-generated action must be attributable and reviewable.
- A customer must always be able to reach a human.
- **An AI draft becomes a sent message only when a human chooses to send
  it, unless every mitigation in §4 is implemented and verified first —
  not planned, verified.**
