# Version 2 — Plan

Status: **plan only — nothing in this document is built yet.**
Written: 21 September 2026. Baseline: `main` at `1c409b2`.

Version 2 turns the sheet into a real inbox that an Arabic-speaking merchant can
run without training. It also gets the product ready for Meta's billing change
on **1 October 2026**. The plan reuses what already works (the webhook path,
assignment, reply from the sheet, archiving, the tests and validators). It also
records every conflict found between the V2 design and the existing code, and
how each one is resolved before any code is written.

Contents

1. [Where V2 comes from](#1-where-v2-comes-from)
2. [Starting point and reuse map](#2-starting-point-and-reuse-map)
3. [Design principles that resolve the conflicts](#3-design-principles-that-resolve-the-conflicts)
4. [Target design](#4-target-design)
5. [Conflict and risk register](#5-conflict-and-risk-register)
6. [What is verified and what needs a spike](#6-what-is-verified-and-what-needs-a-spike)
7. [Implementation tasks](#7-implementation-tasks)
8. [Verification](#8-verification)
9. [Upgrading an existing deployment](#9-upgrading-an-existing-deployment)
10. [Out of scope for V2](#10-out-of-scope-for-v2)
11. [Decisions the owner still has to make](#11-decisions-the-owner-still-has-to-make)

---

## 1. Where V2 comes from

V2 comes from a separate planning conversation that ended with three
artifacts: a sheet prototype (`Sheet.v2.gs`), a flows document (entities, state
machine, tabs, flows F1–F11, edge cases C1–C13, seven rules), and a plan update
written for the 1 October billing change. The final result of that conversation
is summarised here. Where this plan disagrees with the prototype, the reason is
given in [section 5](#5-conflict-and-risk-register).

### 1.1 Product and business decisions (adopted as-is)

| Decision | Detail |
|---|---|
| Connection | Meta WhatsApp Cloud API, direct. Coexistence keeps the WhatsApp Business app working on the same number |
| Inbox | Google Sheets remains the working surface. No web inbox in V2 |
| Automation | n8n, installed **on the client's own VPS** (the n8n licence does not allow hosting clients' workflows on our server) |
| WAHA | **Not in the paid product.** It is unofficial and carries a ban risk. The `add-waha-connector` branch stays separate R&D and is not merged by this plan |
| Default reply path | The WhatsApp Business app (the "open" link). The sheet's reply column is the fallback for desktop users |
| Templates | Never sent automatically. A human chooses to send one, because it costs the client money |
| Meta invoice | Paid by the client. The WABA is in the client's name. Stated in the contract |
| Price | 350 JD installation + 25 JD/month support. The server and the Meta invoice are billed to the client |

### 1.2 Meta pricing facts the design depends on (from 1 October 2026)

| Item | Value | Used by |
|---|---|---|
| Inbound messages and webhooks | Free | — |
| Service message, Jordan (Rest of Middle East) | $0.0091 | Dashboard cost estimate |
| Utility template | $0.0091 | Dashboard cost estimate |
| Marketing template | $0.0392 | Dashboard cost estimate |
| Free tier | 1,000 service messages per business number per month, not carried over | Dashboard "free messages left" |
| Customer service window | 24 hours from the **customer's** last message | Send guard, window column |
| Click-to-WhatsApp entry point | 72 hours free, instead of 24 (pricing only; see S6) | Cost estimate only |
| Replies sent from the Business app | **Probably free — unconfirmed.** Must be tested (task O1) | Cost estimate, sales pitch |

Rates live in one place, the Lists tab ([section 4.1](#41-tabs)). They are
never written into formulas or code, because Meta changes them.

### 1.3 What V2 takes from the prototype

| Prototype element | V2 verdict | Why |
|---|---|---|
| Separate "last customer message" column | **Adopted — it already exists** (`last_customer_message_at`) | Only the display is missing |
| Window column (open N hours / closed, needs template) | Adopted, as a derived formula column | Time-based values must not be rewritten by n8n every minute |
| Reply method column (app / sheet / template) | Adopted as `last_reply_via` | Needed for the billing split |
| Guard on the reply cell when the window is closed | Adopted, but **the authority is n8n**, not `onEdit` | `onEdit` does not fire on mobile (prototype edge case C13) |
| Status vs stage | Adopted | Status is what the system tracks; stage is the sales pipeline |
| Outcome on close (bought / lost / no reply) | Adopted | Feeds the sales section of the dashboard |
| Instant archive on close | **Adapted**: hidden instantly, moved physically at night | Deleting rows during the day corrupts concurrent writes (C-03) |
| Newest conversation at the top (`moveRowToTop`) | **Rejected as a physical move**; replaced by sorted filter views | Same reason (C-01) |
| `ingestMessage`, `pickAgent`, `nextCaseId`, `doPost` in Apps Script | **Rejected** | They duplicate workflows 2 and 3 with a second, untested writer (C-05) |
| Human case number (`C-1042`) | Adapted: display-only case code, not sequential | No atomic counter exists without a database (C-12) |
| Positional column map in Apps Script | Rejected | Columns are resolved by header name (C-06) |
| Follow-up template menu item | Adopted, with a cost confirmation | Humans decide spending |
| Dashboard with 24h window and billing sections | Adopted | |
| Arabic headers, tabs and values | Adopted through a label layer | Code keeps English codes (C-08) |

---

## 2. Starting point and reuse map

### 2.1 Baseline on `main` (all green)

| Check | Result on `1c409b2` |
|---|---|
| `node tests/run-tests.js` | 192 passing, 0 failing |
| `node scripts/validation/validate-workflows.js` | 504 workflow checks pass |
| `node scripts/validation/check-schema-consistency.js` | 9 schema checks pass |
| `node scripts/validation/check-docs.js` | 26 documentation checks pass |
| `node scripts/setup/build-workflows.js --check` | every workflow file is current |

Every V2 task must leave all five green. See [section 8](#8-verification).

### 2.2 What is reused, and how it changes

| Existing asset | V2 use | Change |
|---|---|---|
| `scripts/lib/webhook-parser.js` | Unchanged core. It already extracts `pricing_category`, `billable` and `has_referral` | None, apart from new tests |
| `scripts/lib/conversation.js` | State machine, row builders | Add `normalizeConversationRow`, case code, previous-case link |
| `scripts/lib/assignment.js` | Live load counting, selection | None |
| `scripts/lib/idempotency.js`, `security.js`, `phone.js` | Unchanged | None. Apps Script never normalises phones itself |
| `scripts/lib/time.js` | `localIso` stays the machine format | None. Dates are derived by formulas, not rewritten |
| New `scripts/lib/labels.js` | Codes to Arabic/English labels, tab names | New |
| New `scripts/lib/window.js` | The 24-hour rule, in one place | New |
| New `scripts/lib/rows.js` | Safe delete planning for the archive | New |
| `scripts/setup/build-workflows.js` | The only way workflow JSON is produced | Extended per task. JSON is never edited by hand |
| `scripts/setup/apply-sheet-layout.js` | Headers, validation, colours | Extended: label row, Lists, views, protections |
| `scripts/setup/build-dashboard.js` | Dashboard formulas | Rewritten formulas (text-date bug), new sections |
| `sheets-templates/SetupSheet.gs` + `SheetTools.gs` | Apps Script | Merged into one project with no duplicate names (C-09) |
| `scripts/testing/*` (verify-live, verify-burst, verify-archive, scenario-multi-agent, send-fixture) | Live verification | Reused, extended with V2 scenarios |
| `scripts/validation/*` | Build-time gates | New rules per task |

### 2.3 Changes per workflow

| Workflow | V2 change |
|---|---|
| 01 webhook receiver | None |
| 01b WAHA receiver | None. It stays buildable but is not part of the paid product |
| 02 message processor | Write pricing fields on status updates. Set `last_reply_via=app` on Business-app echoes |
| 03 conversation and assignment | Capacity fix, remove the full-tab sort, normalise on read, labels on write, case code, previous-case lookup |
| 04 outgoing agent message | Window guard, `last_reply_via=api` |
| 05 unassigned retry | `executeOnce` on Read Agents, normalise on read |
| 06 error handler | None |
| 07 reply from sheet | Writes keyed by `conversation_id`, window guard, templates, no retry loop on blocked replies, `closed_at` stamping, restore scan |
| 08 archive | Nightly archive of every closed row, fresh-index deletes with verification, `Customers` upsert, fold duplicates first |

---

## 3. Design principles that resolve the conflicts

Each principle exists because of a specific conflict in [section 5](#5-conflict-and-risk-register).

- **P1 — One structural writer.** Only n8n inserts, deletes or moves rows.
  Apps Script may write only into the row a human just edited, only into
  human-owned columns plus the `closed_at` stamp.
- **P2 — During the day, rows only get appended.** Nothing sorts, moves or
  deletes rows in the active tabs between the nightly runs. A sort or delete
  shifts row indexes under every write that is in flight. That includes n8n's
  own update-by-key, which reads the index and then writes to it.
- **P3 — Rows are addressed by `conversation_id`.** `row_number` is used in one
  place only: claiming a hand-typed row, which gets an id before anything else.
- **P4 — Codes inside, labels at the boundary.** Code compares `CLOSED`, never
  an Arabic string. The sheet shows labels. One module converts in both
  directions. Reads accept a code or any known label, so a V1 sheet keeps working.
- **P5 — Derive, do not rewrite.** Time-dependent values (window state, hours
  waiting) and date values for formulas are spreadsheet formulas over the
  machine columns. n8n never rewrites a cell just because time passed.
- **P6 — The server guard is the authority.** The sheet warns. n8n refuses. A
  warning that did not fire, on mobile for example, cannot cause a wrong send.
- **P7 — No money is spent without a human.** Templates are only sent from an
  explicit marker a person typed or inserted.
- **P8 — One source of truth per kind.** Column names: the CSV templates.
  Labels and tab names: `labels.js`, from which the Apps Script label block is
  generated. Rates: the Lists tab. Secrets and template definitions: `.env`.
- **P9 — No new moving parts.** No Apps Script web app, no new database, no new
  service. V2 is the same four components with better behaviour.

---

## 4. Target design

### 4.1 Tabs

Tab titles come from `labels.js` for the chosen `SHEET_LANGUAGE` (`en` default
for existing installs, `ar` for new Arabic clients). The key is what the code
uses.

| Key | Arabic title | Visible | Who writes | Purpose |
|---|---|---|---|---|
| `Start` | ابدأ من هنا | yes | setup only | How to work, and the seven rules |
| `Dashboard` | لوحة التحكم | yes | formulas only | Now, team, 24h window, billing, follow-ups, sales |
| `Conversations` | المحادثات | yes | n8n (structure); humans (their columns) | The inbox |
| `FollowUps` | متابعات اليوم | yes | formulas only | Read-only list of due follow-ups, with links to the rows |
| `Archive` | الأرشيف | yes | n8n (append only); humans (restore tick) | Closed cases |
| `Agents` | الموظفين | yes | humans; n8n (load) | Team, capacity, availability |
| `Lists` | القوائم | yes | setup; owner (rates, stages) | Dropdown sources, rate card, template names |
| `System` | النظام — لا تلمسه | yes, protected | n8n (heartbeat) | Version, last sweep time, health |
| `Customers` | — | hidden | n8n (nightly) | One row per customer: last case, count of cases |
| `Messages` | — | hidden | n8n | Unchanged, plus pricing columns |
| `Log` | — | hidden | n8n | Unchanged |

### 4.2 Conversations columns

Row 1 holds the machine keys, which n8n and Apps Script use. Row 2 holds the
labels a person reads. Row 1 is hidden and both rows are frozen. Whether n8n
supports this is spike S1. The fallback is in [section 6](#6-what-is-verified-and-what-needs-a-spike).

The physical order below becomes the CSV order. Appends are positional
(`appendViaApi` writes a row array in CSV order), so CSV order and sheet order
must always match. Updates are by name and do not care about order.

**Visible block** (what an agent works in):

| Key | Arabic label | Owner | New in V2 |
|---|---|---|---|
| `case_code` | رقم الحالة | n8n | yes |
| `customer_name` | اسم الزبون | n8n, human may correct | |
| `customer_phone` | الهاتف | n8n | |
| `window_state` | النافذة | formula | yes (derived) |
| `waiting_hours` | ساعات الانتظار | formula | yes (derived) |
| `last_message` | آخر رسالة | n8n | |
| `assigned_agent_name` | الموظف | n8n, human may reassign | |
| `status` | الحالة | n8n + human (close / reopen) | |
| `stage` | المرحلة | human | yes |
| `reply_text` | اكتب ردك هنا | human | |
| `reply_status` | حالة الرد | n8n | |
| `notes` | ملاحظات | human | yes |
| `follow_up_at` | موعد المتابعة | human (date picker) | yes |
| `deal_value` | القيمة | human | yes |
| `order_ref` | رقم الطلب | human | yes |
| `outcome` | النتيجة | human, on close | yes |
| `last_reply_via` | طريقة الرد | n8n | yes |
| `wa_link` | فتح | n8n | |

**System block** (grouped and collapsed, warning-only protection): every other
existing column (`conversation_id`, `assigned_agent_id`,
`business_phone_number_id`, `unanswered_count`, `unanswered_messages`,
`last_message_type`, `last_message_direction`, `last_message_id`,
`first_message_at`, `last_activity_at`, `last_customer_message_at`,
`last_agent_message_at`, `created_at`, `updated_at`, `closed_at`,
`unassigned_reason`, `reply_error`, `reply_sent_at`, `unread`, `product`,
`quantity`), plus new system columns:

| Key | Purpose |
|---|---|
| `previous_case_code` | Set when a returning customer opens a new case |
| `reply_blocked_hash` | Stops a blocked reply from being re-processed every minute (V2-20) |
| `last_customer_dt`, `first_message_dt`, `last_activity_dt` | Derived real date values for formulas (formula columns) |

Derived (formula) columns are declared in a `DERIVED_COLUMNS` list. n8n never
writes them: appends send `null` in their positions (spike S2), and the schema
checker fails the build if any workflow maps a derived column.

### 4.3 Value labels

Stored values are labels in the chosen language. Code converts them with
`labels.js`. Reads accept the code, the English label or the Arabic label.

```
status   WAITING_FOR_AGENT     -> بانتظار موظف
         UNANSWERED            -> بانتظار الرد
         REPLIED               -> تم الرد
         WAITING_FOR_CUSTOMER  -> بانتظار الزبون
         CLOSED                -> مغلقة
outcome  BOUGHT -> اشترى      LOST -> ضايع      NO_REPLY -> بدون رد
via      APP -> تطبيق (مجاني)   SHEET -> شيت (API)   TEMPLATE -> قالب (مدفوع)   API -> API
window   OPEN -> مفتوحة       CLOSED -> مسكّرة — بدك قالب
stage    NEW -> جديد   INQUIRY -> استفسار   QUOTED -> عرض سعر   ORDERED -> طلب مؤكد   DELIVERED -> تم التوصيل
```

The stage list is a proposal; the owner edits it in `labels.js` (decision D4).
`ARCHIVED` is **not** a status. Being archived is a location, not a state (C-10).

### 4.4 Case lifecycle

```
customer message ──> row appended (bottom) ──> assigned ──> replies ...
                                                           │
                         human sets status = CLOSED (+ outcome)
                                                           │
            closed_at stamped (onEdit on desktop; n8n within 1 min on mobile)
                                                           │
                row hidden from the main view immediately (filter re-applied)
                                                           │
     nightly run: fold duplicates -> copy to Archive -> upsert Customers
                  -> delete the rows (fresh indexes, verified)
```

- **Customer returns before the nightly run**: the closed row is still in the
  tab, so the existing reopen logic applies (`REOPEN_CLOSED_CONVERSATIONS`,
  default `true`). The same case reopens and becomes visible again.
- **Customer returns after the nightly run**: a new case is created. Its
  `previous_case_code` is filled from the `Customers` tab, and a note
  (returned after case X) is added. That is the prototype's behaviour, without
  reading the whole Archive on every new conversation.
- **Restore from Archive**: a human ticks `restore_requested` on the archive
  row. Within a minute, n8n appends the row back to Conversations and stamps
  `restored_at`. The archive row is **kept**: the Archive is append-only.
- **Duplicates** (two simultaneous first messages from one customer): still
  possible, because Sheets has no compare-and-set. They are shown on the
  dashboard during the day and folded at night, as today.

### 4.5 The 24-hour window

- Input: `last_customer_message_at` only. An agent's message never extends the
  window.
- `window.js` → `windowState({ last_customer_message_at, now })` returns
  `{ open, hours_left, closes_at }`. A missing or unparseable timestamp counts
  as **closed**, so an unknown state fails safe.
- The sheet shows it through a derived formula that mirrors the same rule. A
  test fixture pins the two to the same answer at the boundaries.
- The spreadsheet recalculates every minute (`autoRecalc: MINUTE`), and its time
  zone must equal `GENERIC_TIMEZONE` (Asia/Amman). The layout tool asserts both.
- The 72-hour Click-to-WhatsApp window affects **pricing**, not the right to
  send free-form text. The send guard stays at 24 hours unless spike S6 proves
  otherwise.

### 4.6 Reply paths and what each costs

| Path | How | Guard | Recorded as |
|---|---|---|---|
| Business app (default) | "Open" link, reply in the app | Meta's own | `last_reply_via=APP` (echo webhook) |
| Sheet | Type in the reply column | n8n refuses when the window is closed, and keeps the text | `SHEET` |
| Template | `[TEMPLATE] followup_general` in the reply column, or the menu item | Name must be in the allow-list. Allowed with the window closed | `TEMPLATE` |
| API (workflow 4) | Programmatic | Same window guard | `API` |

The marker also accepts the Arabic alias `[قالب] name`, so a person on a phone
can type it without the menu.

### 4.7 Dashboard

| Section | Contents | Source |
|---|---|---|
| Filters | Agent, from-date, to-date | cells at the top |
| Now | Waiting for us, longest wait (fixed), unassigned, possible duplicates | Conversations derived columns |
| Team | Per agent: open, waiting, replied today, closed today | Conversations + Archive |
| 24h window | Waiting with a closed window (needs a template), closing within 4 hours, follow-ups due after the window closes | derived `window_state`, `follow_up_at` |
| Billing (month to date) | Service messages sent, free messages left (1,000 minus used), templates by category, estimated cost at the Lists rates, share by reply path | Messages (`pricing_category`, `billable`, `sent_via`) |
| Follow-ups | Due today, overdue | `follow_up_at` |
| Sales | Closed by outcome, sum of `deal_value`, conversion rate | Archive + Conversations |

The "longest wait = 0" bug comes from `MINIFS` over ISO text. It is fixed by
pointing every date formula at the derived date columns. Month filters on the
Messages tab can stay on text (`TEXT(TODAY(),"yyyy-mm")&"*"`), because the ISO
prefix sorts and matches correctly.

### 4.8 Follow-ups

`follow_up_at` is a date picker. The FollowUps tab is a read-only `FILTER` with
a `HYPERLINK` to each row, found by `MATCH` on `conversation_id`, so it never
depends on row numbers. A follow-up that falls after the window closes is
flagged: it will need a template. Setting a follow-up does not change the
status. A daily digest is deferred ([section 10](#10-out-of-scope-for-v2)).

### 4.9 Apps Script: one project, clear limits

The two current files are merged into one project with unique function names.
Tab and column lookups go through row-1 keys and a generated label block.

| Function | Trigger | May write |
|---|---|---|
| `onOpen` | simple | menu only |
| `onEdit` | simple | the edited row only: `closed_at` stamp; re-applies the main filter; shows toasts |
| Close with outcome… | menu | status, outcome, `closed_at` on the selected rows |
| Insert follow-up template… | menu | the marker in the reply column, after a cost confirmation |
| Open WhatsApp chat | menu | nothing |
| Rebuild views | menu | filter views (no data) |
| Recalculate agent workload | menu | Agents load column |

Every `getUi()` call is wrapped in `try/catch`, because it is unavailable
outside a browser session. Nothing in Apps Script inserts, deletes, moves or
sorts rows. The installable `onEdit` that deleted rows on `ARCHIVED` is removed.

---

## 5. Conflict and risk register

Each item names where the conflict lives, what goes wrong, and the task that
resolves it. "Live on main" means the defect exists today, before V2.

| ID | Conflict | Where | What goes wrong | Resolution | Task |
|---|---|---|---|---|---|
| C-01 | Full-tab sort after each new conversation | wf3 "Sort Newest First" | Every in-flight write resolved to a row index before the sort lands on the wrong row. **Live on main** | Remove the sort (P2). Newest-first becomes a sorted filter view | V2-02 |
| C-02 | Writes keyed on `row_number` | wf7 "Clear Cell And Record Outcome", "Mark Invalid Reply" | Combined with C-01: another conversation's status, last message and reply cell get overwritten. **Live on main** | Key on `conversation_id`. Hand-typed rows are claimed first | V2-03 |
| C-03 | Deleting rows while other writes are in flight | wf8 delete; the prototype's instant archive | Every row below a deleted one shifts up. A write resolved before the delete lands on the neighbour. At 50 closes and 500 updates a day, instant deletes would corrupt a row on most days | Hide on close; physical delete only at night; indexes re-read right before the delete; verify afterwards | V2-04, V2-42, V2-43 |
| C-04 | All agents at capacity | wf3 "Increment Agent Load" | Empty match key → error → workflow stops → the customer's message is written nowhere. **Live on main** (fixed only on the WAHA branch, `e5fdaec`) | Port the "Agent Assigned?" guard and `executeOnce` | V2-01 |
| C-05 | Prototype ingests messages in Apps Script | `Sheet.v2.gs` `ingestMessage`, `pickAgent`, `doPost` | A second assignment algorithm and a second writer. Its lock does not cover n8n, so both race | Not adopted. Workflows 2 and 3 stay the only ingest path | — |
| C-06 | Prototype uses positional columns | `Sheet.v2.gs` column map | Any column move breaks one side silently | Look columns up by the row-1 key | V2-37 |
| C-07 | Prototype moves rows to the top | `moveRowToTop` | Same as C-01 | Sorted filter views | V2-35 |
| C-08 | Arabic values vs English comparisons | every Code node comparing `'CLOSED'` etc. | An Arabic status never matches, so closed rows count as open and the load is wrong | `labels.js` + `normalizeConversationRow` at every read; a validator rule enforces it | V2-11, V2-12 |
| C-09 | Duplicate global functions | `SetupSheet.gs` and `SheetTools.gs` both define `onOpen`, `replyToSelected`, `openWhatsAppChat`, `recalculateAgentLoad`, `columnLetter_` | Apps Script has one global namespace. Which one runs depends on file order | Merge into one project | V2-37 |
| C-10 | `ARCHIVED` status | `SheetTools.gs` only | Not a state-machine status. The dropdown offers a value the workflows do not know | Remove. Archive is a location | V2-37 |
| C-11 | Dates stored as ISO text | `time.js` output, dashboard `MINIFS` / `COUNTIFS` | Text comparisons give wrong counts, and the longest wait shows 0 | Derived date columns; formulas use them | V2-13, V2-36 |
| C-12 | Sequential case numbers | prototype `nextCaseId` | No atomic counter in Sheets or n8n. Two executions mint the same number | Display-only code from the id's timestamp; never a key | V2-40 |
| C-13 | Reopen same case vs new case on return | `REOPEN_CLOSED_CONVERSATIONS` vs prototype note | Two contradictory rules | Before the nightly archive: reopen. After: new case with `previous_case_code` | V2-45 |
| C-14 | Reply guard in `onEdit` only | prototype | Mobile never runs `onEdit`, and a closed-window text reaches Meta and fails | n8n guard is authoritative (P6) | V2-20 |
| C-15 | Failed send clears the typed text | wf7 success/failure writeback | Meta error 131047 (window closed) loses what the agent wrote | Guard before sending; keep the text on block; map 131047 to the same state | V2-20 |
| C-16 | Blocked rows are re-processed every minute | wf7 "Mark Invalid Reply" keeps the text | One wasted write per blocked row per minute, against a 60-per-minute quota | `reply_blocked_hash`: skip while the text is unchanged | V2-20 |
| C-17 | Formula columns vs positional appends | `appendViaApi` writes every CSV column | An empty string in a derived column breaks the `ARRAYFORMULA` above it | Send `null` for derived positions (S2), and the checker forbids mapping them | V2-13 |
| C-18 | `USER_ENTERED` to get real dates | any write path | A customer message starting with `=` becomes a formula (injection), and `+962…` loses its plus | All writes stay `RAW` (P5). A validator rule forbids `USER_ENTERED` on customer data | V2-13 |
| C-19 | Changing a shared filter | basic filter on Conversations | An agent filtering by their own name changes the view for everyone | Personal filter views per agent. The main filter is re-applied by the system | V2-35 |
| C-20 | Localised tab names vs name-based references | every Sheets node, `appendViaApi` URLs, dashboard formulas | A renamed tab breaks every reference | Tab names come only from `tabName(key)`. The validator checks every reference. Rule: never rename tabs | V2-30 |
| C-21 | Archive lookup on every new conversation | returning-customer detection | Reading an ever-growing Archive per inbound message burns quota | Small `Customers` tab, upserted nightly | V2-45 |
| C-22 | Checker rule "Archive = Conversations + `archived_at`" | `check-docs.js`, `check-schema-consistency.js` | V2 adds `archive_id`, `restore_requested`, `restored_at` | Update both checkers in the same commit | V2-43 |
| C-23 | Arabic prose in docs | `check-docs.js` language rule | Build fails | Arabic appears only in tables and code blocks; the Arabic guide lives in the Start tab | all docs tasks |
| C-24 | Extra Sheets reads per minute | restore scan, reconciliation | Quota (60 reads/min per service account) | One narrow column read per minute; filter re-applied only on events | V2-42, V2-44 |
| C-25 | Cherry-picking `e5fdaec` brings a tool attribution trailer | commit message | Violates the no-branding rule | `git cherry-pick -n`, then commit with our own message | V2-01 |

---

## 6. What is verified and what needs a spike

The facts below were read from the code on `main` and are not assumptions:
appends are positional and `RAW` with `INSERT_ROWS`; updates are by name; wf7
writes by `row_number`; wf3 sorts the whole tab; the capacity bug exists on
`main`; the parser already extracts pricing; load is counted live from rows.

These behaviours are **not** verified. Spike task V2-10 settles each one on a
throwaway spreadsheet before any dependent task starts.

| Spike | Question | If yes | Fallback if no |
|---|---|---|---|
| S1 | Can n8n's Google Sheets node (v4) read, update and append with header row 1 and first data row 3, and accept an expression as the tab name? | Two-row header (keys hidden, labels visible) and localised tab names | Keep one English header row, with Arabic labels as cell notes, and English tab titles |
| S2 | Does `values.append` with `null` in a position leave that cell empty, so an `ARRAYFORMULA` in the header can spill into the new row? | Derived columns sit next to the data they describe | Derived columns move to the far right of the table |
| S3 | Does a basic filter re-hide a row automatically when an edit makes it fail the criteria? And do filter views re-sort newly appended rows? | No reconciliation needed | Re-apply the filter on close (onEdit and n8n). The view is re-opened to re-sort |
| S4 | Does `SpreadsheetApp.getUi().alert` work inside a simple `onEdit` on desktop, and does `toast` work in all browsers? | Alert on a closed-window reply | Toast only, plus the status the n8n guard writes |
| S5 | Does the Sheets mobile app show filter views and respect the basic filter? | Same views on mobile | Mobile users rely on the main filter only; this is documented |
| S6 | Inside a Click-to-WhatsApp 72-hour window, does Meta accept free-form text after 24 hours? | Guard uses 72 hours when the case started from an ad | Guard stays at 24 hours (the safe default) |

The results are written back into this table (verified: yes/no, date,
evidence) as part of V2-10.

---

## 7. Implementation tasks

### 7.1 Conventions

- Branch `v2`, created from `main` with `git worktree add`, never by switching
  branches in the shared checkout. The WAHA branch is not touched.
- **One commit per task**, with a plain message and no tool attribution
  trailer. No pull request, per the owner's instruction. `main` receives V2
  only when the owner decides.
- Workflow JSON is only ever produced by `build-workflows.js`. Hand edits are
  overwritten, which has already happened once on this project.
- Every task ends with the five gates in [section 8.1](#81-gates-for-every-task).
  A task that changes workflow behaviour also runs its live scenario from
  [section 8.2](#82-end-to-end-acceptance-scenarios) against a test spreadsheet,
  never the client's.
- Sizes: **S** is under half a day, **M** is one to two days, **L** is three days or more.

### 7.2 Phase 0 — make the base safe (live defects on `main`)

These ship first, because every later phase builds on the paths they fix.

**V2-01 · Port the capacity fix** · S · risk low · depends on nothing
- Files: `scripts/setup/build-workflows.js`, workflows 03 and 05 (regenerated), `docs/N8N_WORKFLOWS.md`.
- Do: `git cherry-pick -n e5fdaec`, resolve against `main`, regenerate, commit
  with our own message (C-25). This adds the "Agent Assigned?" IF in front of
  "Increment Agent Load", and `executeOnce` on Read Agents in workflows 3 and 5.
- Test: a validator rule that "Increment Agent Load" is reachable only through
  the true branch of "Agent Assigned?". Live: `scenario-multi-agent.js` with
  every agent at capacity gives a `WAITING_FOR_AGENT` row and no failed execution.

**V2-02 · Remove the full-tab sort** · S · risk low · depends on V2-01
- Files: `build-workflows.js` (wf3: remove "Sort Newest First", and "Read Tab
  Ids" if nothing else uses it; keep "Get Sheets Token", which appends need),
  `apply-sheet-layout.js` (add a "Newest first" filter view now, so people
  do not lose the ordering), `docs/OPERATING_GUIDE.md`.
- Test: a validator rule that no workflow sends `sortRange` or `moveDimension`
  to Conversations. Live: two new conversations are appended at the bottom, and
  the view shows them first.

**V2-03 · Key reply writes on `conversation_id`** · M · risk medium · depends on V2-02
- Files: `build-workflows.js` (wf7), `docs/GOOGLE_SHEETS_SCHEMA.md`.
- Do: "Find Pending Replies" emits a claim item for each hand-typed row (a
  phone, no id). A new "Claim Manual Row" node writes the minted
  `conversation_id` by `row_number`. It is the only `row_number` write left,
  and it is safe because, after V2-02, rows do not move during the day.
  "Clear Cell And Record Outcome" and "Mark Invalid Reply" then match on
  `conversation_id`. Invalid hand-typed rows are claimed too, so the error can
  be recorded.
- Test: a validator rule that no Conversations update matches on `row_number`
  except "Claim Manual Row". Unit tests for the claim and send split. Live
  scenario E19.

**V2-04 · Safe nightly delete** · M · risk medium · depends on V2-02
- Files: new `scripts/lib/rows.js`, `build-workflows.js` (wf8), `scripts/testing/verify-archive.js`, `tests/`.
- Do: `planDeletes(idColumnValues, idsToDelete)` returns `deleteDimension`
  requests sorted from the bottom up. wf8 re-reads only the `conversation_id`
  column right before deleting, sends one `batchUpdate`, then re-reads the ids.
  An archived id still present is logged. A non-archived id that is missing is
  re-appended from the snapshot and logged at `ERROR`.
- Test: unit tests (bottom-up order, unknown ids, duplicate ids, a gap in the
  column). `verify-archive.js` compares the full before and after snapshots:
  only the archived ids differ.

### 7.3 Phase 1 — foundations (no visible change)

**V2-10 · Spikes S1–S6** · M · risk none (throwaway sheet) · depends on nothing
- Files: new `scripts/testing/spike-v2.js`, a temporary n8n test workflow (not
  committed), updates to [section 6](#6-what-is-verified-and-what-needs-a-spike).
- Gate: Phase 3 does not start until S1–S3 are answered. Each "no" switches the
  affected tasks to their fallback before work begins.

**V2-11 · Label layer** · S · risk low · depends on nothing
- Files: new `scripts/lib/labels.js`, `tests/labels/`, `check-env.js` (`SHEET_LANGUAGE`).
- Do: packs `en` and `ar` for status, outcome, stage, via, window and tab names.
  `toCode(value)` accepts a code or any label (trimmed; case-insensitive for
  English). `toLabel(code, lang)`. `tabName(key, lang)`.
- Test: round trip for every code in every pack; every status in
  `CONVERSATION_STATUSES` has a label in every pack; unknown values return
  `null` with a reason; no two codes share a label.

**V2-12 · Normalise on read, label on write** · M · risk medium · depends on V2-11
- Files: `scripts/lib/conversation.js`, `build-workflows.js` (wf3, wf5, wf7, wf8
  Code nodes; the column maps), `validate-workflows.js`, tests.
- Do: `normalizeConversationRow(row)` runs right after every Conversations read
  (status and outcome to codes, booleans, trimmed ids). The column maps convert
  codes to labels for the chosen language on write.
- Test: re-run the existing conversation and assignment suites with Arabic
  fixtures and English fixtures; the decisions must be identical. A validator
  rule: every Code node that consumes a Conversations read calls the normaliser.

**V2-13 · Derived columns and write safety** · M · risk medium · depends on V2-10 (S2)
- Files: `sheets-templates/SetupSheet.gs` (`DERIVED_COLUMNS`), the CSV
  templates, `build-workflows.js` (`null` for derived positions in
  `appendViaApi` rows), `check-schema-consistency.js`, `apply-sheet-layout.js`.
- Do: `last_customer_dt`, `first_message_dt`, `last_activity_dt` parse the
  local part of the ISO text into real dates. `window_state` and
  `waiting_hours` build on them. Each is an `ARRAYFORMULA` in its header cell.
- Test: the schema checker fails if any workflow maps a derived column, or if
  any write path uses `USER_ENTERED` on customer data (C-18). A formula fixture
  test: known timestamps give the expected window and hours.

**V2-14 · Window rule** · S · risk low · depends on nothing
- Files: new `scripts/lib/window.js`, tests.
- Test: boundaries at 23h59m (open) and 24h00m (closed); a missing timestamp is
  closed; the `+03:00` offset parses; hours left rounds down.

### 7.4 Phase 2 — the 24-hour window and cost (time-critical, 1 October)

**V2-20 · Server-side window guard** · M · risk medium · depends on V2-03, V2-14
- Files: `build-workflows.js` (wf7, wf4), `labels.js` (a `WINDOW_CLOSED` reply status), tests.
- Do: before a free-form send, call `windowState`. When the window is closed,
  make no API call, set the reply status to window-closed with a hint to use a
  template, **keep the text**, and write `reply_blocked_hash`. Rows whose text
  hash still matches are skipped (C-16). Meta error 131047 maps to the same
  state (C-15).
- Test: unit tests for the decision; live scenario E6 (the execution shows no
  HTTP call); E5 still sends.

**V2-21 · Templates on explicit request** · M · risk medium · depends on V2-20, O2
- Files: `build-workflows.js` (wf7 template body), a new marker parser in
  `scripts/lib/`, `check-env.js` (`WHATSAPP_TEMPLATES`, JSON with name,
  language, category and parameters), `docs/ENVIRONMENT.md`.
- Do: `[TEMPLATE] name` or `[قالب] name` is looked up in the allow-list and
  sent as a Cloud API template, with the body parameters filled from the row
  (for example the customer name). An unknown name fails as invalid with no API
  call. The WAHA path refuses templates with a clear error.
- Test: parser (spacing, case, the Arabic alias, extra text), body builder,
  allow-list; live scenarios E7 and E8.

**V2-22 · Reply method** · S · risk low · depends on V2-12
- Files: `build-workflows.js` (wf2 echo path → APP, wf7 → SHEET or TEMPLATE,
  wf4 → API), CSV templates, schema documentation.
- Test: fixture echo → APP; each send path writes its own value.

**V2-23 · Pricing capture** · S · risk low · depends on nothing
- Files: `sheets-templates/Messages.csv` (`pricing_category`, `billable`), wf2
  "Update Message Status", fixtures with a `pricing` block, schema docs.
- Test: a status fixture with pricing updates both fields; one without leaves them empty.

**V2-24 · Dashboard: window and billing** · M · risk low · depends on V2-13, V2-22, V2-23
- Files: `scripts/setup/build-dashboard.js`, Lists rate cells (a minimal Lists
  tab if V2-32 is not done yet).
- Test: a new unit test parses every generated formula and checks that each
  referenced column exists in the templates; a live check on a fixture sheet
  compares the counts with hand-computed values (E18).

**V2-25 · Correct the pricing documents** · S · risk none · depends on nothing
- Files: `docs/COSTS.md`, `README.md`, `docs/CLIENT_ONBOARDING.md`.
- Do: replace the flat $10.32 figure with the per-message model (section 1.2)
  and add the client-pays rule and the service price.

### 7.5 Phase 3 — the Arabic working surface

Starts after V2-10 has answered S1–S3.

**V2-30 · Header rows and tab names** · L · risk high · depends on V2-10, V2-11, V2-12
- Files: `apply-sheet-layout.js`, `build-workflows.js` (header options on every
  Conversations, Agents and Archive node; `tabName()` everywhere, including the
  `appendViaApi` URLs), `validate-workflows.js`.
- Test: a validator rule that every sheet reference goes through `tabName()`,
  and that every node on those tabs carries the header options. Full live
  regression (E1–E5, E9, E19) in both `en` and `ar`.

**V2-31 · Column order and grouping** · M · risk medium · depends on V2-30
- Files: CSV templates (new order), `SetupSheet.gs`, `apply-sheet-layout.js`
  (column groups, widths, freeze).
- Note: appends are positional, so CSV order equals sheet order. Reordering an
  existing sheet happens only in the migration (V2-50), with workflows stopped.

**V2-32 · Lists tab** · S · risk low · depends on V2-11
- Named ranges for status, stage, outcome, agents and template names; the rate
  card; the free-tier size. Dropdown validation points at the named ranges.

**V2-33 · Start and System tabs** · S · risk low · depends on V2-11
- The Start tab: how to work, the three reply paths, the seven rules, and what
  each colour means, in the chosen language. The System tab: version, last
  nightly run, last minute poll (a heartbeat written by n8n), protected.

**V2-34 · Formatting and protection** · S · risk low · depends on V2-31
- Conditional colours for window, waiting hours and status; warning-only
  protection on the system block; full protection on derived columns.

**V2-35 · Filter views** · M · risk low · depends on V2-31, V2-10 (S3, S5)
- Per agent "My queue" (not closed, newest first); Newest first; Waiting over
  an hour; Window closing within 4 hours; Closed today (for undo); Follow-ups
  today. Built from the Agents tab and rebuilt from the menu. The main filter
  hides closed rows.

**V2-36 · Dashboard layout and date fix** · M · risk low · depends on V2-13, V2-24
- The full layout from section 4.7, filter cells, and every date formula moved
  onto derived columns (fixes C-11).

**V2-37 · One Apps Script project** · M · risk medium · depends on V2-11, V2-30
- Files: `sheets-templates/Sheet.gs` (replaces `SetupSheet.gs` and
  `SheetTools.gs`), a generated `sheets-templates/Labels.gs` (from `labels.js`;
  `build-workflows.js --check` reports drift), a new test harness
  `tests/apps-script/` that runs the `.gs` files in Node's `vm` with a fake
  `SpreadsheetApp`.
- Test: no duplicate top-level names across `.gs` files; `onEdit` on close
  stamps `closed_at` and nothing else; `onEdit` never calls `deleteRow`,
  `insertRow`, `moveRows` or `sort` (a static check); `getUi` failures are caught.

### 7.6 Phase 4 — the case lifecycle

**V2-40 · Case code** · S · risk low · depends on V2-12
- `C-` plus the last six base-36 digits of the creation time in milliseconds,
  minted in `buildNewConversationRow`. Documented as display-only, not unique by
  contract.

**V2-41 · Stage, outcome, value** · S · risk low · depends on V2-32
- Human-owned columns and dropdowns. Closing without an outcome is allowed but
  warned about, and is archived as "not recorded" (decision D3).

**V2-42 · Hide on close, stamp from mobile** · M · risk medium · depends on V2-37, V2-10 (S3)
- `onEdit` stamps `closed_at` and re-applies the main filter. wf7's minute poll
  stamps `closed_at` on closed rows that lack it (the mobile case), keyed by
  `conversation_id`, and re-applies the filter only when it stamped something.
- Test: live scenarios E10 and E11.

**V2-43 · Nightly archive of every closed row** · M · risk medium · depends on V2-04
- `ARCHIVE_CLOSED_AFTER_HOURS` (default 0) replaces `ARCHIVE_AFTER_DAYS`, which
  is still read as a fallback so existing `.env` files keep working. Order:
  fold duplicates, copy to Archive with a minted `archive_id`, upsert
  `Customers`, delete (V2-04). The Archive gains `archive_id`,
  `restore_requested` and `restored_at`; both checkers are updated in the same
  commit (C-22).

**V2-44 · Restore from Archive** · M · risk medium · depends on V2-43
- wf7 reads just the Archive columns `archive_id`, `restore_requested` and
  `restored_at` each minute. A ticked row that is not yet restored is appended
  to Conversations (the reopen transition) and gets `restored_at`, keyed by
  `archive_id`. The Archive row stays.
- Test: live scenario E15. Restoring twice in a row appends once.

**V2-45 · Returning customer** · M · risk low · depends on V2-43, V2-40
- wf3's create path looks up `Customers` by phone and fills
  `previous_case_code` plus a note. The reopen path is unchanged.
- Test: unit tests in the conversation suite; live scenarios E13 and E14.

**V2-46 · Follow-ups** · S · risk low · depends on V2-13, V2-35
- The FollowUps tab (read-only formula with links), flags for "after the window
  closes", and dashboard counts.

**V2-47 · Duplicates visible during the day** · S · risk low · depends on V2-36
- A dashboard count of open rows sharing a phone and business number. The fold
  itself stays nightly (V2-43).

### 7.7 Phase 5 — packaging, migration and docs

**V2-50 · Migration tool** · L · risk high · depends on every earlier task
- File: new `scripts/setup/migrate-v2.js`, with `--dry-run` as the default and
  `--apply` to act. Steps: check that a manual copy of the spreadsheet exists
  (the owner makes it with File → Make a copy; the service account has no Drive
  scope), deactivate the workflows, add the new columns, move columns into the
  V2 order, add derived formulas, translate stored codes to labels, create
  Lists, Start, System and Customers, build the views and the dashboard,
  re-import and activate the workflows, run the smoke test. Idempotent: a second
  run changes nothing.
- Test: run it on a copy of a V1 fixture sheet, then E21.

**V2-51 · Demo spreadsheet** · S · risk low · depends on V2-36
- New `scripts/setup/seed-demo.js`: fills a separate spreadsheet with realistic
  Arabic demo data (including closed-window cases waiting for a reply) for the
  sales demo. It refuses to run on a sheet that already holds data unless
  `--force` is given.

**V2-52 · Documentation** · M · risk none · depends on the features it describes
- `GOOGLE_SHEETS_SCHEMA.md` (all tabs, all columns, derived columns, labels),
  `OPERATING_GUIDE.md`, `ARCHITECTURE.md` (the lifecycle in section 4.4),
  `N8N_WORKFLOWS.md`, `ENVIRONMENT.md` (`SHEET_LANGUAGE`, `WHATSAPP_TEMPLATES`,
  `ARCHIVE_CLOSED_AFTER_HOURS`), `CLIENT_ONBOARDING.md`, `TROUBLESHOOTING.md`,
  `CHANGELOG.md`, `README.md`.

**V2-53 · Release** · S · depends on V2-50 to V2-52
- The full scenario table in section 8.2 on a fresh install and on a migrated
  copy, then the tag `v2.0.0` on branch `v2`. Merging into `main` is the
  owner's decision.

### 7.8 Track B — operations before 1 October 2026 (owner, no code)

| # | Task | Why now | Unblocks |
|---|---|---|---|
| O1 | Send a reply from the Business app and check whether the echo or status webhooks carry `pricing_category` | Decides whether the app path is really free, which is the most important number in the pitch | V2-24 assumptions |
| O2 | Submit the `followup_general` template for approval (Arabic, utility if Meta accepts it) | Approval takes hours to days | V2-21 live test |
| O3 | Correct the published pricing (same as V2-25) | A wrong price in front of a client is a trust problem | — |
| O4 | Add a payment method to the Meta test account | Service messages may stop without one after 1 October | Live tests |
| O5 | Start business verification for the test account | Takes weeks, and is the only real launch blocker | Selling |

### 7.9 Order and dependencies

```
Phase 0:  V2-01 -> V2-02 -> V2-03
                        \-> V2-04
Phase 1:  V2-10 (spikes)   V2-11 -> V2-12   V2-14   V2-13 (needs S2)
Phase 2:  V2-20 (V2-03, V2-14) -> V2-21 (O2)   V2-22   V2-23   V2-24   V2-25
Phase 3:  V2-30 (S1) -> V2-31 -> V2-34, V2-35 ; V2-32, V2-33 ; V2-36 ; V2-37
Phase 4:  V2-40, V2-41 ; V2-42 (V2-37) ; V2-43 (V2-04) -> V2-44, V2-45 ; V2-46 ; V2-47
Phase 5:  V2-50 -> V2-51, V2-52 -> V2-53
Track B:  O1..O5 in parallel, starting now
```

Phase 0 and Phase 2 can reach a client before the Arabic surface is finished.
They fix live defects and the 1 October exposure without changing the sheet
layout.

---

## 8. Verification

### 8.1 Gates for every task

```
node tests/run-tests.js
node scripts/setup/build-workflows.js --check
node scripts/validation/validate-workflows.js
node scripts/validation/check-schema-consistency.js
node scripts/validation/check-docs.js
node scripts/validation/check-env.js          # when .env keys change
```

New validator rules added by this plan (each in the task that needs it):

| Rule | Added in |
|---|---|
| "Increment Agent Load" only behind "Agent Assigned?" = true | V2-01 |
| No `sortRange` / `moveDimension` on Conversations | V2-02 |
| No Conversations update matched on `row_number` except "Claim Manual Row" | V2-03 |
| Every Conversations read is normalised before use | V2-12 |
| No workflow maps a derived column; no `USER_ENTERED` on customer data | V2-13 |
| Every tab reference goes through `tabName()` | V2-30 |
| No duplicate top-level names in `.gs` files; `onEdit` never moves rows | V2-37 |
| Every dashboard formula references existing columns | V2-24 |

### 8.2 End-to-end acceptance scenarios

Run against a test spreadsheet with `scripts/testing/send-fixture.js` and the
existing verify scripts. Each needs an observed result, not an assumed one.

| # | Scenario | Expected |
|---|---|---|
| E1 | New customer message | Row appended at the bottom, assigned, labels in the sheet language, case code set, window open |
| E2 | Every agent at capacity | `WAITING_FOR_AGENT` row, no failed execution; workflow 5 assigns later |
| E3 | Burst of simultaneous first messages from different customers | One row each (existing `verify-burst.js`) |
| E4 | Two simultaneous messages from one new customer | At most two rows; the dashboard shows a duplicate; the nightly run folds them |
| E5 | Sheet reply inside the window | Sent, text cleared, reply method SHEET |
| E6 | Sheet reply after 24 hours | No HTTP call, text kept, window-closed status, no repeat processing next minute |
| E7 | Template marker with an approved name | Template sent; counted under its category |
| E8 | Template marker with an unknown name | Invalid, no HTTP call |
| E9 | Reply from the Business app (Coexistence) | Echo recorded, reply method APP, status REPLIED |
| E10 | Close with an outcome on desktop | `closed_at` stamped; row hidden for everyone within a minute |
| E11 | Close from the mobile app | `closed_at` stamped by n8n within a minute; row hidden |
| E12 | Nightly archive | Closed rows in Archive, Customers upserted, only those ids removed (snapshot diff) |
| E13 | Customer returns before the nightly run | Same case reopens and is visible again |
| E14 | Customer returns after archiving | New case with `previous_case_code` |
| E15 | Restore ticked in Archive | Row back in Conversations, `restored_at` set, archive row kept, no double restore |
| E16 | A person sorts the tab by hand during the day | No write lands on the wrong row, because every write is keyed by id (the residual in-flight window is documented) |
| E17 | Dashboard longest wait | Matches a hand computation on fixture data (not 0) |
| E18 | Dashboard billing | Counts equal a hand count of the Messages fixture |
| E19 | Hand-typed new row with only a phone and a reply | Claimed, sent, then keyed by id |
| E20 | Same fixtures with `SHEET_LANGUAGE=en` and `ar` | Identical decisions |
| E21 | Migration of a V1 copy | Every V1 row readable, statuses translated, workflows green, a second run changes nothing |

---

## 9. Upgrading an existing deployment

1. Tag the current state (`git tag v1-final`) and export the workflows.
2. The owner makes a copy of the spreadsheet (File → Make a copy). The copy is
   the rollback.
3. `node scripts/setup/migrate-v2.js` (dry run) and read the plan it prints.
4. `node scripts/setup/migrate-v2.js --apply` outside business hours. It stops
   the workflows first and restarts them last.
5. Run the smoke scenarios E1, E5, E6, E10 and E12 on the live sheet with a
   test number.

Rollback: point `GOOGLE_SHEET_ID` at the copy, check out `v1-final`, re-import
the workflows. Messages that arrived during the V2 window are in the Messages
tab of the V2 sheet and can be replayed with `send-fixture.js`.

---

## 10. Out of scope for V2

| Not in V2 | Revisit when |
|---|---|
| AI replies | A paying client asks, and the grounding rules in `FUTURE_AI.md` are met |
| Web inbox | Sheets limits bite (about 300 conversations a day), or agents must not see each other's rows |
| WAHA in the paid product | Never for paying clients, unless Meta's terms change |
| Postgres | Same trigger as the web inbox; see `GOOGLE_SHEETS_TO_POSTGRES.md` |
| Other channels (Instagram, Messenger) | After the first paying clients |
| Daily digest to agents | After V2. Messaging agents from the business number is business-initiated, so it needs a paid template; email is the likely channel |
| Per-agent row privacy | Not possible in Google Sheets; needs the web inbox |

---

## 11. Decisions the owner still has to make

| # | Decision | Recommendation |
|---|---|---|
| D1 | Default `SHEET_LANGUAGE` for new installs | `ar` for Jordanian clients; `en` stays the default for existing installs |
| D2 | Nightly archive time | 03:00 Asia/Amman |
| D3 | Can a case close without an outcome? | Yes, with a warning; archived as "not recorded" |
| D4 | The stage list | The proposal in section 4.3, edited to match how the client sells |
| D5 | Template category for `followup_general` | Utility if Meta approves it; marketing costs about four times as much |
| D6 | Whether the key row stays hidden or visible but narrow | Hidden; the layout tool can show it for debugging |
