# Version 2 — Plan

Status: **plan only — nothing in this document is built yet.**
Revision 2, 21 September 2026. Baseline: `main` at `1c409b2`.

Version 2 turns the sheet into a real inbox that an Arabic-speaking merchant can
run without training. It also gets the product ready for Meta's billing change
on **1 October 2026**. It reuses what already works: the webhook path,
assignment, reply from the sheet, archiving, the tests and the validators. It
records every conflict found between the V2 design and the existing code, and
the task that resolves each one, before any code is written.

Contents

0. [Review log](#0-review-log)
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

## 0. Review log

Revision 1 was checked line by line against the code on `main`, the source of
n8n 2.38.5's Google Sheets node, and the prototype's flows document. These
corrections were made in revision 2. Each one is backed by something that was
read or run, not assumed.

| # | Revision 1 said | What is actually true | Consequence |
|---|---|---|---|
| R1 | Appends use the Sheets API with `INSERT_ROWS` | `appendViaApi()` exists in `build-workflows.js` but **nothing calls it**. Every append uses n8n's Sheets node, which (per its 2.38.5 source) reads the sheet, computes the next row, and writes to that row. Two executions at once pick the same row. `ARCHITECTURE.md` documents this as a known limitation, and `verify-burst.js` fails on purpose until it is fixed | New first task V2-01. Burst scenario E3 is a release gate |
| R2 | Workflow 8 archives at night | It runs **every minute** (cron at second 30). It deletes `ARCHIVED` rows at once and folds duplicates at once, by `row_number`, during working hours | Deleting during the day is a live defect on `main` (C-03). Moving deletes to the night is pulled forward to Phase 1 (V2-15) |
| R3 | `ARCHIVED` is known only to `SheetTools.gs` | It is a documented V1 feature: workflow 8 moves `ARCHIVED` rows within a minute, **and** the optional installable `onEdit` in `SheetTools.gs` deletes the same rows. Two deleters race each other | C-10 rewritten. `ARCHIVED` becomes an alias of `CLOSED` on read |
| R4 | The sort's token nodes could simply stay | The Sign/Get token pair in workflow 3 exists only to feed the sort | V2-01 moves the token in front of the appends before V2-03 removes the sort |
| R5 | A hand-typed row can message a new number | Under the V2 window guard, a number that never wrote to us has no open window. Only a template can reach it | Scenario E19 corrected; outreach is template-only (C-27) |
| R6 | Status list: five codes, labels only | The prototype also has "on hold" and "new". `WAITING_FOR_CUSTOMER` already behaves as "parked" (a customer message moves it to `UNANSWERED`) | "On hold" maps to `WAITING_FOR_CUSTOMER`; "new" is derived (C-29) |
| R7 | Stage and a required outcome are separate | The prototype derives the outcome from the stage (won, lost) and adds "duplicate" | Outcome derived at archive time, human may override (V2-41) |
| R8 | Dashboard: three filters | The prototype has eight filters and sections for money, stage and month | V2-36 matches it; needs a new `first_reply_at` column (V2-22) |
| R9 | Follow-up reminder deferred | It is flow F6 of the prototype | Added as optional task V2-47 |
| R10 | Reassigning by editing the agent's name is fine | Load is counted by `assigned_agent_id`; editing only the name leaves the id stale | New task V2-46 (C-28) |
| R11 | Formula columns only need `null` in appends | n8n's append writes `''` into every unmapped column (source), and an `ARRAYFORMULA` that spills `""` to the bottom of the sheet can make append see a taller table. This project already met the same effect: whole-column validation produced 59 phantom Agents rows | Derived arrays are bounded to the data rows; spike S2 checks append placement |
| R12 | New settings just go in `.env` | Both compose files pass variables to n8n one by one, and the server's compose file is maintained by hand | Every task that adds a variable updates both compose files, the examples, `check-env.js` and the server (C-31) |
| R13 | `ARCHIVE_CLOSED_AFTER_HOURS=0` could replace `ARCHIVE_AFTER_DAYS` | In V1, `ARCHIVE_AFTER_DAYS=0` **disables** archiving. Reading it as "0 hours" would archive everything | Legacy meaning kept; new variables defined without inversion (C-30) |
| R14 | Implementation on a new `v2` branch | The owner wants the work on the new branch that holds this plan | Implementation continues on `plan-v2` |
| R15 | The cherry-pick of `e5fdaec` may conflict | Tried on a copy of `main`: it applies cleanly. Tests, the build check, workflow validation (now 508 checks) and schema consistency pass. The docs checker then fails once: `docs/TESTING.md` still quotes 504 | V2-02 is small and includes that one-line doc fix |
| R16 | All data writes are `RAW` | n8n 2.38.5's Google Sheets node v4.7 defaults to `USER_ENTERED` (`cellFormatDefault`), and no node here sets it. Every write is parsed as if typed, so customer text starting with `=` becomes a formula | Found while building V2-01. New Phase 0 task V2-06 (C-18) |
| R17 | API appends must be positional, so CSV order must equal sheet order | V2-01 places values by name against the live header row instead | Column order is cosmetic again. The fallback Sheets node still fills `''` into unmapped columns, which V2-13 must handle |

---

## 1. Where V2 comes from

V2 comes from a separate planning conversation that ended with three
artifacts: a sheet prototype (`Sheet.v2.gs`), a flows document (entities, state
machine, tabs, flows F1–F11, edge cases C1–C13, seven rules), and a plan update
written for the 1 October billing change. Where this plan disagrees with the
prototype, [section 5](#5-conflict-and-risk-register) gives the reason.

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

### 1.2 Meta pricing the design depends on (from 1 October 2026)

| Item | Value | Used by |
|---|---|---|
| Inbound messages and webhooks | Free | — |
| Service message, Jordan (Rest of Middle East) | $0.0091 | Cost estimate |
| Utility template | $0.0091; free when sent inside an open service window | Cost estimate |
| Marketing template | $0.0392 | Cost estimate |
| Free tier | 1,000 service messages per business number per month, not carried over | "Free messages left" |
| Customer service window | 24 hours from the **customer's** last message | Send guard, window column |
| Click-to-WhatsApp entry point | 72 hours free instead of 24 (pricing only, see S6) | Cost estimate |
| Replies sent from the Business app | **Probably free, unconfirmed.** Must be tested (task O1) | Cost estimate, sales pitch |

These rates come from the planning conversation. That conversation itself
warns that the rate card was not yet published when it was written. The rates
therefore live only in the Lists tab. They are never written into formulas or
code, and they must be checked against Meta's published card before quoting a
client. The dashboard counts billable messages from the `pricing` block Meta
sends in status webhooks. The rates only turn those counts into an estimate.

### 1.3 What V2 takes from the prototype

| Prototype element | V2 verdict | Why |
|---|---|---|
| Separate "last customer message" column | **Adopted; it already exists** (`last_customer_message_at`) | Only the display is missing |
| Window column (open N hours / closed, needs template) | Adopted as a derived formula column | Time-based values must not be rewritten by n8n every minute |
| Reply method column (app / sheet / template) | Adopted as `last_reply_via` | Needed for the billing split |
| Guard on the reply cell when the window is closed | Adopted, but **n8n is the authority**, not `onEdit` | `onEdit` does not fire on mobile (prototype edge case C13) |
| Last speaker column | Adopted: `last_message_direction` shown with labels | Already stored |
| Status vs stage | Adopted | Status tracks the reply; stage tracks the sale |
| Stages new, interested, offer sent, won, lost | Adopted | Outcome derives from stage |
| Instant archive on close | **Adapted**: hidden at once, moved physically at night | Deleting rows during the day corrupts concurrent writes (C-03) |
| Newest conversation at the top (`insertRowBefore(2)`, `moveRowToTop`) | **Rejected as a physical move**; replaced by sorted filter views | Same reason (C-01) |
| `ingestMessage`, `pickAgent`, `nextCaseId`, `doPost`, `LockService` | **Rejected** | They duplicate workflows 2 and 3 with a second, untested writer whose lock does not cover n8n (C-05) |
| Human case number (`C-1042`) | Adapted: display-only case code, not sequential | No atomic counter without a database (C-12) |
| Restore removes the row from the archive (F9) | Adapted: the archive row is kept and marked restored | The prototype's own rule 4 says the archive is append-only (C-34) |
| Positional column map in Apps Script | Rejected | Columns are resolved by header key (C-06) |
| Follow-up template menu item | Adopted, with a cost confirmation | Humans decide spending |
| Morning follow-up list per agent (F6) | Adopted as an optional task | V2-47 |
| Dashboard filter panel and sections | Adopted | V2-36 |
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
| `scripts/testing/verify-burst.js` (live) | **fails by design** per `ARCHITECTURE.md`: simultaneous appends lose rows (R1). Not re-run in this review, because Docker was down |

Every V2 task must leave the first five green. `verify-burst.js` must turn green
in V2-01 and stay green.

### 2.2 What is reused, and how it changes

| Existing asset | V2 use | Change |
|---|---|---|
| `scripts/lib/webhook-parser.js` | Unchanged core. It already extracts `pricing_category`, `billable` and `has_referral` | New tests only |
| `scripts/lib/conversation.js` | State machine, row builders, live load count | `normalizeConversationRow`, case code, outcome from stage |
| `scripts/lib/assignment.js` | Selection, live load | None |
| `scripts/lib/idempotency.js`, `security.js`, `phone.js` | Unchanged | None. Apps Script never normalises phones itself |
| `scripts/lib/time.js` | `localIso` stays the machine format (Asia/Amman, offset included) | None. Human-facing dates are derived by formulas |
| New `scripts/lib/labels.js` | Codes to Arabic/English labels, tab names | New |
| New `scripts/lib/window.js` | The 24-hour rule, in one place | New |
| New `scripts/lib/rows.js` | Safe delete planning for the archive | New |
| `build-workflows.js` → `appendViaApi()` | Written in 0.6.0, never wired | **Wired for every append** (V2-01) |
| wf3 "Sign Sheets Token Request" / "Get Sheets Token" / "Read Tab Ids" | Built for the sort | Token reused by appends; the tab-id read moves to workflow 8 for `deleteDimension` |
| `scripts/setup/apply-sheet-layout.js` | The declared single source of the sheet's layout | Extended: label row, Lists, views, protections |
| `scripts/setup/build-dashboard.js` | Dashboard formulas | Rewritten formulas (text-date bug), new sections |
| `sheets-templates/SetupSheet.gs` + `SheetTools.gs` | A second setup path and a second dashboard builder, plus the menu | Merged into one runtime-only project (C-09) |
| `scripts/testing/*` | Live verification | Reused, extended with V2 scenarios |
| `scripts/validation/*` | Build-time gates | New rules per task |

### 2.3 Changes per workflow

V2 adds no new workflow file. The same nine files change.

| Workflow | V2 change |
|---|---|
| 01 webhook receiver | None |
| 01b WAHA receiver | None. It stays buildable but is not part of the paid product |
| 02 message processor | Appends through the API; pricing fields on status updates; `last_reply_via=APP` and `first_reply_at` on Business-app echoes |
| 03 conversation and assignment | Appends through the API; capacity fix; remove the full-tab sort; normalise on read; labels on write; case code; returning-customer lookup; re-show a reopened row |
| 04 outgoing agent message | Append through the API; window guard; `last_reply_via=API` |
| 05 unassigned retry | `executeOnce` on Read Agents; normalise on read |
| 06 error handler | Append through the API |
| 07 reply from sheet | Append through the API; writes keyed by `conversation_id`; window guard; templates; no retry loop; `closed_at` stamping; restore scan; name-to-id reconciliation |
| 08 archive | Runs at night only; one verified `deleteDimension` batch; fold duplicates first; `Customers` upsert; outcome derivation |

---

## 3. Design principles that resolve the conflicts

- **P1 — One structural writer.** Only n8n inserts, deletes or moves rows.
  Apps Script never does, and never writes system columns.
- **P2 — During the day, rows only get appended.** Nothing sorts, moves or
  deletes rows in the active tabs between the nightly runs. n8n's update reads
  the key column and then writes to the index it found (2.38.5 source). Any
  sort or delete in between sends that write to the wrong row.
- **P3 — Rows are addressed by `conversation_id`.** `row_number` is used in one
  place only: claiming a hand-typed row, which gets an id before anything else.
- **P4 — Codes inside, labels at the boundary.** Code compares `CLOSED`, never
  an Arabic string. The sheet shows labels. One module converts both ways.
  Reads accept a code or any known label, so a V1 sheet keeps working.
- **P5 — Derive, do not rewrite.** Window state, hours waiting and real date
  values are bounded spreadsheet formulas over the machine columns. n8n never
  rewrites a cell because time passed. Customer text is never allowed to become
  a formula (V2-06).
- **P6 — The server guard is the authority.** The sheet warns. n8n refuses.
- **P7 — No money is spent without a human.** Templates are only sent from an
  explicit marker a person typed or inserted.
- **P8 — One source of truth per kind.** Column names and order: the CSV
  templates. Labels and tab names: `labels.js`, from which the Apps Script label
  block is generated. Layout: `apply-sheet-layout.js`. Rates and SLA hours: the
  Lists tab. Secrets and template definitions: `.env`.
- **P9 — No new moving parts.** No Apps Script web app, no new database, no new
  service. The same components, with better behaviour.

---

## 4. Target design

### 4.1 Tabs

Tab titles come from `labels.js` for the chosen `SHEET_LANGUAGE` (`en` by
default for existing installs, `ar` for new Arabic clients). The key is what
the code uses.

| Key | Arabic title | Visible | Who writes | Purpose |
|---|---|---|---|---|
| `Start` | ابدأ من هنا | yes | layout tool | How to work, colours, the rules in 4.10 |
| `Dashboard` | لوحة التحكم | yes | formulas; filter cells by humans | Filters, now, money, stage, team, window, billing, month |
| `Conversations` | المحادثات | yes | n8n (rows); humans (their columns) | The inbox |
| `FollowUps` | متابعات اليوم | yes | formulas only | Read-only list of due follow-ups, linked to their rows |
| `Archive` | الأرشيف | yes | n8n (append only); humans (restore tick) | Closed cases |
| `Agents` | الموظفين | yes | humans; n8n (`last_assigned_at`) | Team, capacity, availability |
| `Lists` | القوائم | yes | layout tool; owner (rates, stages, SLA) | Dropdown sources, rate card, template names |
| `System` | النظام — لا تلمسه | yes, protected | n8n (heartbeat) | Version, last nightly run, last poll, time-zone offset |
| `Customers` | — | hidden | n8n (nightly) | One row per customer: name, last case, count |
| `Messages` | — | hidden | n8n | Unchanged, plus pricing columns |
| `Log` | — | hidden | n8n | Unchanged |

### 4.2 Conversations columns

Row 1 holds the machine keys; n8n and Apps Script read them. Row 2 holds the
labels a person reads. Row 1 is hidden, and both rows are frozen. n8n 2.38.5
supports this for reads and updates (verified in its source, section 6). API
appends read row 1 (`!1:1`) as their header, so they keep matching by key.

The physical order below becomes the CSV order. Since V2-01, appends place
values by name against the live header, so a sheet whose columns are in a
different order still works. The order matters for what people see.
Reordering an existing sheet still happens only in the migration, with
workflows stopped, because `apply-sheet-layout.js` rewrites rows while it
re-maps them.

**Visible block** (what an agent works in):

| Key | Arabic label | Owner | New |
|---|---|---|---|
| `case_code` | رقم الحالة | n8n | yes |
| `customer_name` | اسم الزبون | n8n, human may correct | |
| `customer_phone` | الهاتف | n8n; human only on a new outreach row | |
| `window_state` | النافذة | formula | yes |
| `waiting_hours` | ساعات الانتظار | formula | yes |
| `last_message` | آخر رسالة | n8n | |
| `last_message_direction` | آخر متحدث | n8n (shown as a label) | moved |
| `assigned_agent_name` | الموظف | n8n, human may reassign | |
| `status` | الحالة | n8n + human (close, park, reopen) | |
| `stage` | المرحلة | human | yes |
| `reply_text` | اكتب ردك هنا | human | |
| `reply_status` | حالة الرد | n8n | |
| `reply_error` | سبب الفشل | n8n | moved |
| `notes` | ملاحظات | human | yes |
| `follow_up_at` | موعد المتابعة | human (date picker) | yes |
| `deal_value` | القيمة | human | yes |
| `product` | المنتج | human | |
| `quantity` | الكمية | human | |
| `order_ref` | رقم الطلب | human | yes |
| `outcome` | النتيجة | human override; else derived at archive | yes |
| `last_reply_via` | طريقة الرد | n8n | yes |
| `wa_link` | فتح | n8n | |

**System block** (grouped and collapsed, protected per S8): `conversation_id`,
`assigned_agent_id`, `business_phone_number_id`, `unanswered_count`,
`unanswered_messages`, `last_message_type`, `last_message_id`,
`first_message_at`, `last_activity_at`, `last_customer_message_at`,
`last_agent_message_at`, `created_at`, `updated_at`, `closed_at`,
`unassigned_reason`, `reply_sent_at`, `unread`, plus these new columns:

| Key | Purpose | Written by |
|---|---|---|
| `first_reply_at` | First outbound message of the case; drives first-response time and "lost because late" | n8n, once |
| `previous_case_code` | Set when a returning customer opens a new case | n8n |
| `reply_blocked_hash` | Stops a blocked reply from being re-processed every minute | n8n |
| `last_customer_dt`, `first_message_dt`, `last_activity_dt`, `closed_dt` | Real date values for formulas, converted from the stored offset to the sheet's zone | formula |

Derived columns are declared in `DERIVED_COLUMNS`. Each is one `ARRAYFORMULA`
in its key cell, **bounded to the data rows** (for example
`A3:INDEX(A:A, COUNTA(customer_phone column))`) so it never spills below the
table. n8n never writes them: API appends send `null` in their positions. The
schema checker fails the build if any workflow maps one.

### 4.3 Value labels

Stored values are labels in the chosen language. Reads accept the code, the
English label or the Arabic label.

```
status        WAITING_FOR_AGENT    -> بانتظار موظف
              UNANSWERED           -> بانتظار الرد
              REPLIED              -> تم الرد
              WAITING_FOR_CUSTOMER -> معلّقة
              CLOSED               -> مغلقة
              (read alias) ARCHIVED -> CLOSED
stage         NEW -> جديد   INTERESTED -> مهتم   QUOTED -> عرض مرسل   WON -> اشترى   LOST -> ضايع
outcome       BOUGHT -> اشترى   LOST -> ضايع   NO_REPLY -> بدون رد   DUPLICATE -> مكرر   NOT_RECORDED -> غير مسجّل
reply_status  SENT -> تم الإرسال   FAILED -> فشل   WINDOW_CLOSED -> النافذة مسكّرة — استعمل قالب
direction     inbound -> الزبون   outbound -> نحن
via           APP -> تطبيق (مجاني)   SHEET -> شيت (API)   TEMPLATE -> قالب (مدفوع)   API -> API
window        OPEN -> مفتوحة   CLOSED -> مسكّرة — بدك قالب
```

`WAITING_FOR_CUSTOMER` is shown as "on hold". That is what it already does:
a human parks the case, and the next customer message moves it back to
`UNANSWERED` (`nextStatus` in `conversation.js`). "New" is not a stored status,
because the system cannot observe that nobody has opened a row. The dashboard
counts "never answered" cases from an empty `first_reply_at`.

### 4.4 Case lifecycle

```
customer message ──> row appended at the bottom ──> assigned ──> replies ...
                                                                  │
                human sets status = CLOSED (optionally stage / outcome)
                                                                  │
      row hidden from the main view (filter re-applied: onEdit on desktop,
      n8n within a minute everywhere); n8n stamps closed_at
                                                                  │
   nightly run (ARCHIVE_HOUR): fold duplicates -> derive outcome -> copy to Archive
                               -> upsert Customers -> verified delete of those rows
```

- **Customer writes again before the nightly run**: the closed row is still in
  the tab, so the existing reopen logic applies (`REOPEN_CLOSED_CONVERSATIONS`,
  default `true`). workflow 3 **re-applies the filter**, so the reopened row
  becomes visible again (C-32).
- **Customer writes again after the nightly run**: a new case. Name,
  `previous_case_code` and a note (returned after case X) come from the
  `Customers` tab, without reading the Archive.
- **Restore from the Archive**: tick `restore_requested` (or use the menu on
  desktop). Within a minute, n8n appends the row back to Conversations and
  stamps `restored_at`. The archive row is kept.
- **Duplicates** (two simultaneous first messages from one customer): still
  possible, because Sheets has no compare-and-set. They are counted on the
  dashboard during the day and folded at night. The losing row is archived with
  outcome `DUPLICATE`.
- **Outcome**: a human may set it. If it is empty at archive time, it is
  derived from the stage (`WON` → bought, `LOST` → lost, otherwise no reply).

### 4.5 The 24-hour window

- Input: `last_customer_message_at` only. An agent's message never extends it.
- `window.js` → `windowState({ last_customer_message_at, now })` returns
  `{ open, hours_left, closes_at }`. A missing or unreadable timestamp counts as
  **closed**, so an unknown state fails safe.
- The sheet shows it through a derived formula that mirrors the same rule. A
  fixture test pins both to the same answer at the boundaries.
- The spreadsheet recalculates every minute (`autoRecalc: MINUTE`). Its time
  zone must equal `GENERIC_TIMEZONE` (Asia/Amman). The layout tool asserts both.
  Derived dates read the offset stored in each value, so a stray UTC value
  cannot shift the window by three hours.
- The 72-hour Click-to-WhatsApp window affects **pricing**, not the right to
  send free-form text. The guard stays at 24 hours unless S6 proves otherwise.
- A row typed by hand for a number that never wrote to us has no window. Only a
  template can be sent to it (C-27).

### 4.6 Reply paths and what each costs

| Path | How | Guard | Recorded as |
|---|---|---|---|
| Business app (default) | "Open" link, reply in the app | Meta's own | `APP`, from the echo webhook |
| Sheet | Type in the reply column | n8n refuses when the window is closed and keeps the text | `SHEET` |
| Template | `[TEMPLATE] followup_general` in the reply column, or the menu item | Name must be in the allow-list. Allowed when the window is closed | `TEMPLATE` |
| API (workflow 4) | Programmatic | Same window guard | `API` |

The marker also accepts the Arabic alias `[قالب] name`, so a person on a phone
can type it without the menu.

### 4.7 Dashboard

The filter panel (cells at the top) matches the prototype: reference time,
quick period (today, last 7 days, this month, all, custom), from and to dates,
agent, stage, status, minimum value, and a text search over name, phone and
order number. The filter mask is computed in hidden helper columns **on the
Dashboard tab**, never in the data tabs (P5).

| Section | Contents | Source |
|---|---|---|
| Now | Waiting for us, longest wait (fixed), never answered, unassigned, possible duplicates, follow-ups due | Conversations + derived dates |
| Money | Pending value, confirmed sales, lost cases, **value lost because we were late** (lost cases whose first reply took longer than the SLA hours in Lists) | `deal_value`, `stage`, `outcome`, `first_reply_at` |
| By stage | Count and value per stage | `stage` |
| Team | Per agent: open, waiting, first-response time, sales, lost | Conversations + Archive |
| 24h window | Waiting with a closed window (needs a template), closing within 4 hours, follow-ups due after the window closes | derived columns, `follow_up_at` |
| Billing (month to date) | Billable messages by category, free service messages left, estimated cost at Lists rates, share by reply path | Messages `pricing_category`, `billable`, `sent_via` |
| By month | Trend of new and closed cases; ignores the date filter on purpose | Conversations + Archive |

Every date formula uses the derived date columns. That fixes the "longest wait
= 0" bug, which comes from `MINIFS` over ISO text. Month filters on the
Messages tab can stay on text (`TEXT(TODAY(),"yyyy-mm")&"*"`), because the ISO
prefix matches correctly.

### 4.8 Follow-ups

`follow_up_at` is a date picker. The FollowUps tab is a read-only `FILTER`,
with a `HYPERLINK` to each row found by `MATCH` on `conversation_id`, so it
never depends on row numbers. A follow-up after the window closes is flagged:
it will need a template. Setting a follow-up does not change the status. The
optional morning list per agent is V2-47.

### 4.9 Apps Script: one project, runtime only

The layout belongs to `apply-sheet-layout.js` and the dashboard to
`build-dashboard.js`. Apps Script keeps only what must run inside the sheet.

| Function | Trigger | May write |
|---|---|---|
| `onOpen` | simple | menu only |
| `onEdit` | simple | nothing in data; shows toasts; re-applies the main filter after a close |
| Close… | menu | `status`, `stage`, `outcome` on the selected rows |
| Park (on hold) | menu | `status` |
| Insert follow-up template… | menu | the marker in `reply_text`, after a cost confirmation |
| Restore selected | menu, Archive tab | `restore_requested` |
| Open WhatsApp chat | menu | nothing |
| Rebuild my views | menu | filter views only |
| `removeLegacyTriggers` | run once in migration | deletes the V1 installable trigger |

Every `getUi()` call is wrapped in `try/catch`, because it is unavailable
outside a browser session. `closed_at` is stamped by n8n only, so the system
block can stay protected. The script carries a `VERSION` constant that the
System tab displays, so a stale paste is visible.

### 4.10 The rules on the Start tab

| # | Rule | Enforced by |
|---|---|---|
| 1 | رقم الزبون ما بينكتب ولا بيتغيّر بصف موجود | protection on existing rows is not possible; n8n owns the column |
| 2 | محادثة مفتوحة وحدة لكل زبون | nightly fold; dashboard count |
| 3 | «مغلقة» = أرشفة (تختفي فوراً وتنتقل بالليل) | filter + workflow 8 |
| 4 | الأرشيف للإضافة فقط — الاسترجاع بعلامة، مش بالحذف | workflow 8 never deletes from Archive |
| 5 | لا تكتب بالأعمدة الرمادية | protection (S8) |
| 6 | لا ترتّب التبويب ولا تحذف صفوف — استعمل عرضك | protection (S8), views |
| 7 | كل حقل متكرر من قائمة | data validation |
| 8 | لا تغيّر أسماء التبويبات | System tab health line |

---

## 5. Conflict and risk register

"Live on main" means the defect exists today, before V2.

| ID | Conflict | Where | What goes wrong | Resolution | Task |
|---|---|---|---|---|---|
| C-01 | Full-tab sort after each new conversation | wf3 "Sort Newest First" | In-flight writes land on the wrong row. **Live on main** | Remove the sort; sorted filter views | V2-03 |
| C-02 | Writes keyed on `row_number` | wf7 "Clear Cell And Record Outcome", "Mark Invalid Reply" | With C-01 or C-03: another conversation's status, message and reply cell get overwritten. **Live on main** | Key on `conversation_id`; claim hand-typed rows first | V2-04 |
| C-03 | Deleting rows during working hours | wf8 runs every minute: `ARCHIVED` rows and duplicate folds are deleted at once | Rows below a delete shift up; a write resolved before it lands on the neighbour. **Live on main** | Phase 0: one verified batch delete. Phase 1: deletes only at night; hide on close | V2-05, V2-15 |
| C-04 | All agents at capacity | wf3 "Increment Agent Load" | Empty match key stops the workflow; the message is written nowhere. **Live on main** (fixed only on the WAHA branch, `e5fdaec`) | Port the guard and `executeOnce` | V2-02 |
| C-05 | Prototype ingests messages in Apps Script | `Sheet.v2.gs` | Second assignment algorithm and second writer; its lock does not cover n8n | Not adopted | — |
| C-06 | Prototype uses positional columns | `Sheet.v2.gs` | A column move breaks one side silently | Header-key lookup | V2-37 |
| C-07 | Prototype moves rows to the top | `insertRowBefore(2)`, `moveRowToTop` | Same as C-01 | Sorted filter views | V2-35 |
| C-08 | Arabic values vs English comparisons | every Code node; `countOpenConversationsByAgent` checks `isOpenStatus` on the raw cell | Every Arabic status is "not open", so every agent's load becomes 0 and capacity is ignored | `labels.js` + normaliser at every read; validator rule | V2-11, V2-12 |
| C-09 | Two Apps Script files, two setup paths | `SetupSheet.gs` and `SheetTools.gs` both define `onOpen`, `replyToSelected`, `openWhatsAppChat`, `recalculateAgentLoad`, `columnLetter_`; `setupEverything` and `buildDashboard_` duplicate the Node tools | One global namespace, so file order decides which runs; two layouts drift | One runtime-only project; the Node tools own setup | V2-37 |
| C-10 | `ARCHIVED` has two deleters | wf8 (every minute) and the optional installable `onEditInstallable` | Both delete the same rows; one delete shifts the other's target. **Live on main** where the trigger is installed | `ARCHIVED` read as `CLOSED`; workflow 8 is the only deleter; the trigger is disarmed in V2-05 and removed in migration | V2-05, V2-50 |
| C-11 | Dates stored as ISO text | dashboard `MINIFS`/`COUNTIFS` | Wrong counts; longest wait 0 | Offset-aware derived date columns | V2-13, V2-36 |
| C-12 | Sequential case numbers | prototype `nextCaseId` | Two executions mint the same number | Display-only code; never a key | V2-40 |
| C-13 | Reopen the same case vs a new case | `REOPEN_CLOSED_CONVERSATIONS` vs prototype F8 | Contradictory rules | Before the nightly run: reopen. After: new linked case | V2-43 |
| C-14 | Reply guard in `onEdit` only | prototype | Mobile skips it; the send fails at Meta | n8n guard (P6) | V2-20 |
| C-15 | Failed send clears the typed text | wf7 routes failures into "Clear Cell" | Meta error 131047 (window closed) loses what the agent wrote | Guard before sending; keep the text; map 131047 to the same state | V2-20 |
| C-16 | Blocked rows re-processed every minute | wf7 "Mark Invalid Reply" keeps the text | A wasted write per row per minute | `reply_blocked_hash` | V2-20 |
| C-17 | Formula columns vs appends | n8n's append writes `''` into unmapped columns; unbounded spills extend the table | A broken `ARRAYFORMULA`, or appends landing far below the data | API appends (V2-01) already send `null` for any column they do not write. V2-13 also switches the fallback Sheets nodes to "Minimise API Calls", which fills `null` instead of `''` (2.38.5 source). Bounded arrays; S2 | V2-01, V2-13 |
| C-18 | Customer text interpreted as a formula | every Sheets node write: n8n 2.38.5's v4.7 default is `USER_ENTERED`, and no node overrides it | A message starting with `=`, `+`, `-` or `@` is parsed by Sheets. `=IMPORTXML(…)` or `=HYPERLINK(…)` from a customer becomes a live formula in the team's sheet. **Live on main** | Neutralise customer-controlled text before any write (a leading apostrophe keeps it literal under `USER_ENTERED`); validator rule. Switching to `RAW` is not done blindly, because it would change the type of every cell (numbers, `TRUE`/`FALSE`) | V2-06 |
| C-19 | A shared filter | basic filter on Conversations | An agent filtering by their name changes everyone's view | Personal filter views; the main filter is re-applied by the system | V2-35 |
| C-20 | Localised tab names vs name-based references | Sheets nodes, API URLs, dashboard formulas | A renamed tab breaks every reference | `tabName(key)` everywhere; validator rule; System health line | V2-30 |
| C-21 | Archive lookup per new conversation | returning customer | Reading a growing Archive burns quota | `Customers` tab | V2-43 |
| C-22 | Checker rule "Archive = Conversations + `archived_at`" | `check-docs.js`, `check-schema-consistency.js` | V2 adds restore columns | Update both checkers in the same commit | V2-42 |
| C-23 | Arabic prose in docs | `check-docs.js` | Build fails | Arabic only in tables and code; the Arabic guide lives in the Start tab | all docs tasks |
| C-24 | Extra Sheets reads per minute | wf7 reads Archive restore columns and Agents | 60 reads per minute per service account | Narrow reads; wf8's per-minute read moves to the night (net +2 reads per minute) | V2-15, V2-42, V2-46 |
| C-25 | Cherry-picking brings a tool trailer | commit message | Branding rule | `git cherry-pick -n`, own message | V2-02 |
| C-26 | Simultaneous appends overwrite each other | every Sheets-node append (n8n computes the row, then writes) | A customer's message or conversation row vanishes with every execution green. **Live on main**, documented as a known limitation | Every append goes through the API with `INSERT_ROWS`; the Sheets node survives only as its fallback; validator rules. **Built in V2-01**; live burst test pending | V2-01 |
| C-27 | Outreach rows vs the window guard | wf7 hand-typed rows | Plain text to a new number is blocked | Outreach is template-only; documented; E19 | V2-20 |
| C-28 | Reassigning by editing the name | `assigned_agent_name` vs `assigned_agent_id` | Load and "My queue" disagree | n8n reconciles the id from the name every minute | V2-46 |
| C-29 | Prototype statuses (new, on hold) | prototype vs `CONVERSATION_STATUSES` | Unknown values | On hold = `WAITING_FOR_CUSTOMER`; "new" is derived | V2-11 |
| C-30 | Archive settings meaning | `ARCHIVE_AFTER_DAYS=0` disables archiving in V1 | Reading it as "archive after 0 hours" would archive everything | Keep the legacy meaning; add `ARCHIVE_HOUR` and `ARCHIVE_CLOSED_AFTER_HOURS` without inversion | V2-15 |
| C-31 | New settings never reach n8n | both compose files pass variables one by one; the server's compose is hand-maintained | `$env.X` is undefined in production | Definition of done includes both compose files, the examples, `check-env.js`, `ENVIRONMENT.md` and the server | every task that adds a variable |
| C-32 | A reopened closed row stays hidden | filter hides closed rows | A returning customer waits unseen | Workflow 3 re-applies the filter on reopen | V2-15 |
| C-33 | `onEdit` stamping vs protection | protected system block | The stamp fails for the agent | n8n stamps `closed_at` | V2-15 |
| C-34 | Prototype contradiction | F9 deletes from the archive; rule 4 forbids it | — | Keep archive rows; mark `restored_at` | V2-42 |
| C-35 | Failed sends write Messages rows with an empty id | wf7 "Record Sent Reply" (`dedupe_key` = `message:`) | Colliding dedupe keys | No Messages row for a blocked send; a failed send gets `failed:<conversation_id>:<time>` | V2-20 |

---

## 6. What is verified and what needs a spike

### 6.1 Verified (read in the code or run on 21 September 2026)

| Fact | Evidence |
|---|---|
| n8n update reads the key column, then writes only the mapped cells at the index it found | n8n 2.38.5 `GoogleSheet.ts` (`prepareDataForUpdateOrUpsert`, `batchUpdate`) |
| n8n append computes the next row and writes there; the "Minimise API calls" option uses `values.append` without `INSERT_ROWS`; unmapped columns are filled with `''` | n8n 2.38.5 `append.operation.ts`, `GoogleSheet.ts` (`appendData`, `updateRows`) |
| n8n read and update accept a header row and a first data row | `dataLocationOnSheet` (read), `locationDefine` (update) in the same source |
| Every Sheets node write is `USER_ENTERED`: v4.7's default, and no node overrides it | n8n 2.38.5 `GoogleSheets.utils.ts` (`cellFormatDefault`) |
| Static data is saved for sub-workflow runs as well as trigger runs | n8n 2.38.5 `execution-lifecycle-hooks.ts` (`getLifecycleHooksForSubExecutions` includes `hookFunctionsSave`) |
| `appendViaApi()` is never called | search of `build-workflows.js` |
| Workflow 8 runs every minute and deletes by `row_number` | its schedule rule and "Remove From Conversations" |
| The token pair in workflow 3 only feeds the sort | its connections |
| Timestamps carry the Asia/Amman offset | `time.js`, `metaTimestampToIso`, `TZ` in both compose files |
| `crypto` is allowed in Code nodes | `NODE_FUNCTION_ALLOW_BUILTIN=crypto` |
| Settings reach n8n only if listed in compose | both compose files |
| `e5fdaec` cherry-picks cleanly; every gate passes after it except one stale check count in `TESTING.md` | trial on a detached copy of `main`, then discarded |
| Tests are discovered as `*.test.js` under `tests/` | `tests/run-tests.js` |

### 6.2 Spikes (V2-10, on a throwaway spreadsheet)

| Spike | Question | If yes | Fallback if no |
|---|---|---|---|
| S1 | Does a Sheets node accept an expression as the tab name, and do reads and updates behave with keys in row 1 and labels in row 2 (hidden row 1)? | Two header rows, localised tab names | One English header row with Arabic notes; English tab titles |
| S2 | With derived columns bounded to the data rows, does an API append with `null` in their positions land directly below the last row and let the formula extend? | Derived columns next to the data they describe | Derived columns at the far right, or computed on a hidden tab |
| S3 | Does a basic filter re-hide a row when an edit makes it fail? Does a sort inside a filter view leave the underlying order, as the API sees it, unchanged? | No re-apply needed; views are safe | Re-apply the filter on close and reopen (planned anyway); document "re-open the view to re-sort" |
| S4 | Does `getUi().alert` work inside a simple `onEdit` on desktop? | Alert on a closed-window reply | Toast only |
| S5 | Does the Sheets mobile app show filter views and respect the basic filter? | Same views on mobile | Mobile relies on the main filter; documented |
| S6 | Inside a Click-to-WhatsApp 72-hour window, does Meta accept free-form text after 24 hours? | Guard uses 72 hours for ad-started cases | Guard stays at 24 hours |
| S7 | Does enforced protection of the system and derived columns (editors: owner and service account) stop agents from sorting the tab and deleting rows, while they can still edit the visible block and use filter views? | Rules 5 and 6 are enforced, not just asked for | Warning-only protection; the residual risk is documented |
| S8 | After 1 October: do status webhooks mark free-tier service messages with `billable: false`? | Billing counts use `billable` directly | Count service messages and subtract the free tier in the formula |

S1 to S7 are answered before Phase 3 starts. S8 is an observation task (O6).
The results are written back into this table with the date and the evidence.

---

## 7. Implementation tasks

### 7.1 Conventions

- **Branch: `plan-v2`**, the new branch that holds this plan. Work happens in
  a `git worktree`, never by switching branches in the shared checkout. `main`
  and the WAHA branch are not touched. No pull request. `main` receives V2 only
  when the owner decides.
- **One commit per task**, with a plain message and no tool attribution.
- Workflow JSON is produced only by `build-workflows.js`. Hand edits are
  overwritten, which has already happened once on this project.
- **Definition of done for every task:**
  1. The five gates in [8.1](#81-gates-for-every-task) pass.
  2. A task that changes behaviour runs its live scenario from
     [8.2](#82-end-to-end-acceptance-scenarios) against the **test**
     spreadsheet, never a client's.
  3. A new setting is added to `.env.example`, `.env.prod.example`, both
     compose files, `check-env.js` and `ENVIRONMENT.md`, and is noted for the
     server's hand-maintained compose file.
  4. A new script is mentioned in the docs (the docs checker requires it). A new
     tab is added to the docs checker's tab list and to the schema document.
- Sizes: **S** under half a day, **M** one to two days, **L** three days or more.

### 7.2 Before the first task

- Docker Desktop running and the local stack up (`docker compose up -d`). It
  was not running when this plan was reviewed.
- A dedicated **test** spreadsheet in `.env` (`GOOGLE_SHEET_ID`), shared with
  the service account as editor.
- Meta test number and token in `.env`, and a tunnel for webhooks
  (`docs/SETUP.md`).
- For O1: the Coexistence-linked number and the Business app on a phone.

### 7.3 Phase 0 — live defects on `main`

These ship first, because every later phase builds on the paths they fix.

**V2-01 · Concurrency-safe appends everywhere** · M · risk medium ·
**built; offline gates pass; live burst test pending**
- As built: `build-workflows.js` rewrites all ten Sheets-node appends (six
  workflows) into an API append with `INSERT_ROWS` under the original name, and
  keeps the Sheets node as `Fallback: <name>` on its error output. Values are
  placed **by column name** against the live header row, so column order in
  the sheet still does not matter. An access branch hangs off each trigger and
  runs first. It ends in `Sheets Access`: a cached token (reused until five
  minutes before expiry) and cached header rows (re-read at most once a
  minute). Writes keep `USER_ENTERED` with text values, exactly as before.
  `docker-compose.prod.yml` and `.env.prod.example` now pass the service
  account (they did not, so production had always skipped the sort).
- Tests: validator rules (fallback-only Sheets appends, `INSERT_ROWS`,
  `USER_ENTERED`, by-name placement, complete access branch that runs first),
  each proven by breaking a generated file. Two new test files (38 tests), including the body of
  every generated append evaluated to a full row, and the generated access
  branch run with a real RSA key.
- Still to do: **`verify-burst.js` passes** (E3) and `verify-live.js` still
  passes, against a test spreadsheet on the local stack.

**V2-02 · Port the capacity fix** · S · risk low · after V2-01 ·
**built; offline gates pass; live scenario pending**
- As built: `git cherry-pick -n e5fdaec` applied cleanly on top of V2-01 and
  was committed with our own message (C-25). It adds "Agent Assigned?" in front
  of "Increment Agent Load", and `executeOnce` on Read Agents in workflows 3
  and 5. Workflow 3's canvas note, which still told operators to set a
  concurrency limit of 1, was corrected in the same commit.
- Tests: a validator rule that "Increment Agent Load" is fed only by the true
  branch, proven by wiring it back to Select Agent.
- Still to do: `scenario-multi-agent.js` with every agent at capacity (E2).

**V2-03 · Remove the full-tab sort** · S · risk low · after V2-01
- Files: `build-workflows.js` (wf3: remove "Build Sort Request", "Read Tab Ids",
  "Build Sort Range", "Sort Newest First"; the access branch stays, because the
  appends use it), `apply-sheet-layout.js` (a "Newest first" filter view now,
  so people keep the ordering), `docs/OPERATING_GUIDE.md`.
- Test: a validator rule that no workflow sends `sortRange` or `moveDimension`.
  Live: new rows land at the bottom; the view shows them first.

**V2-04 · Key reply writes on `conversation_id`** · M · risk medium · after V2-03
- Files: `build-workflows.js` (wf7), `docs/GOOGLE_SHEETS_SCHEMA.md`.
- Do: "Find Pending Replies" emits a claim for each hand-typed row (a phone, no
  id). "Claim Manual Row" writes the minted id by `row_number`, the only
  `row_number` write left. Every other write matches `conversation_id`.
  Invalid hand-typed rows are claimed too, so their error can be recorded.
- Residual risk: until V2-15, workflow 8 still deletes during the day, so a
  claim can in rare cases race a delete. This is documented and closed by V2-15.
- Test: a validator rule that no Conversations update matches `row_number`
  except "Claim Manual Row". Unit tests for the claim/send split.

**V2-05 · One deleter, verified deletes** · M · risk medium · after V2-01
- Files: new `scripts/lib/rows.js`, `build-workflows.js` (wf8),
  `sheets-templates/SheetTools.gs` (the installable trigger no longer deletes;
  it only shows a toast), `scripts/testing/verify-archive.js`, tests.
- Do: `planDeletes(idColumn, idsToDelete)` returns `deleteDimension` requests
  from the bottom up. Workflow 8 re-reads only the `conversation_id` column
  right before deleting, reads the tab id (the node moved from workflow 3),
  sends **one** `batchUpdate`, then re-reads the ids. An archived id still
  present is logged. A non-archived id that went missing is re-appended from
  the snapshot and logged at `ERROR`.
- Test: unit tests (order, unknown ids, duplicate ids, gaps).
  `verify-archive.js` compares full snapshots before and after: only the
  archived ids differ.

**V2-06 · Customer text never becomes a formula** · S · risk low · after V2-01
- Found while building V2-01 (R16). Every Sheets write is `USER_ENTERED`, so
  Sheets parses a customer's message as if someone typed it.
- Files: new `scripts/lib/sheet-safe.js` (`sheetSafe(value)`: a string that
  starts with `=`, `+`, `-` or `@` gets a leading apostrophe, which Sheets keeps
  as text and does not display), the Code nodes that build customer-controlled
  fields (`last_message`, `unanswered_messages`, `customer_name`, Messages
  `text`), tests, `validate-workflows.js`, `docs/SECURITY.md`.
- Not a switch to `RAW`: that would change the type of every cell the system
  writes today (counts, `TRUE`/`FALSE`, phone numbers), which the dashboard
  formulas rely on.
- Test: unit tests for `sheetSafe` (formula prefixes, Arabic text, numbers,
  empty); a validator rule that those fields pass through `sheetSafe`; live, a
  message `=1+1` is shown as `=1+1`, not `2`.

### 7.4 Phase 1 — foundations

**V2-10 · Spikes S1–S7** · M · risk none
- Files: new `scripts/testing/spike-v2.js` (documented in `TESTING.md`), a
  temporary n8n workflow (not committed), and results written into
  [6.2](#62-spikes-v2-10-on-a-throwaway-spreadsheet).
- Gate: Phase 3 waits for S1, S2, S3 and S7. Each "no" switches the affected
  tasks to their fallback first.

**V2-11 · Label layer** · S · risk low
- Files: new `scripts/lib/labels.js`, `tests/labels/*.test.js`, `check-env.js`
  (`SHEET_LANGUAGE`).
- Do: `en` and `ar` packs for everything in 4.3 and every tab name.
  `toCode(field, value)` accepts a code, any label, or a read alias
  (`ARCHIVED`). `toLabel(field, code, lang)`. `tabName(key, lang)`.
- Test: round trip for every code in every pack; every status in
  `CONVERSATION_STATUSES` has labels; no two codes share a label; unknown values
  return `null` with a reason.

**V2-12 · Normalise on read, label on write** · M · risk medium · after V2-11
- Files: `conversation.js`, `build-workflows.js`, `validate-workflows.js`, tests.
- Do: `normalizeConversationRow(row)` runs right after every Conversations read
  in workflows 3, 5, 7 and 8. The Code nodes that build `write_row` or result
  fields convert codes to labels at the end. Literal values inside Sheets nodes
  (such as `reply_status: 'FAILED'`) come from a generator helper that emits a
  language-aware expression, never a raw string.
- Test: the conversation and assignment suites run with English and Arabic
  fixtures and must decide identically (E20). Validator rules: every Code node
  consuming a Conversations read calls the normaliser; no raw status literal in
  a Sheets node.

**V2-13 · Derived columns and write safety** · M · risk medium · after V2-10 (S2)
- Files: CSV templates, `SetupSheet.gs` schema (`DERIVED_COLUMNS`),
  `build-workflows.js` (fallback Sheets appends set "Minimise API Calls" so they
  write `null`, not `''`, into columns they do not map),
  `check-schema-consistency.js`, `apply-sheet-layout.js`.
- Do: bounded `ARRAYFORMULA`s for the derived columns in 4.2. The dates are
  converted from each value's stored offset to the sheet's zone, using the
  System tab's offset cell.
- Test: the checker fails if a workflow maps a derived column. A formula fixture: known timestamps give the
  expected window, hours and dates.

**V2-14 · Window rule** · S · risk low
- Files: new `scripts/lib/window.js`, tests.
- Test: 23h59m open, 24h00m closed, missing timestamp closed, `+03:00` and `Z`
  both parse, hours left rounds down.

**V2-15 · Hide on close; delete only at night** · M · risk medium · after V2-05, V2-12, V2-10 (S3)
- Files: `build-workflows.js` (wf7, wf3, wf8), `apply-sheet-layout.js` (main
  filter), `SheetTools.gs` (`onEdit` re-applies the filter), env files.
- Do:
  - The main filter hides closed rows.
  - Workflow 7's minute poll stamps `closed_at` on closed rows that lack it
    (keyed by id) and re-applies the filter when it stamped something.
  - Workflow 3 re-applies the filter when it reopens a closed row (C-32).
  - Workflow 8 keeps an hourly trigger but acts only in `ARCHIVE_HOUR`
    (default 3, Asia/Amman). It archives closed rows older than
    `ARCHIVE_CLOSED_AFTER_HOURS` (default 0: all of them). `ARCHIVE_AFTER_DAYS=0`
    still disables archiving. An upgraded install with only
    `ARCHIVE_AFTER_DAYS=N` keeps N days until the owner opts in (C-30).
  - `ARCHIVED` in old rows is read as `CLOSED`.
- Test: E10, E11, E12, E13, E24, E25.

### 7.5 Phase 2 — the 24-hour window and cost (time-critical, 1 October)

**V2-20 · Server-side window guard** · M · risk medium · after V2-04, V2-11, V2-14
- Files: `build-workflows.js` (wf7, wf4), tests.
- Do: before a free-form send, call `windowState`. When it is closed:
  - make no API call;
  - set `reply_status` to window-closed with a hint to use a template;
  - keep the text;
  - write `reply_blocked_hash` (a `crypto` hash of the text and the reason);
  - write no Messages row.

  Rows whose hash still matches are skipped. Meta error 131047 maps to the
  same state. A failed API send keeps its Messages row, with the dedupe key
  `failed:<conversation_id>:<time>` (C-35).
- Test: unit tests for the decision; E5, E6, E19.

**V2-21 · Templates on explicit request** · M · risk medium · after V2-20; live test needs O2
- Files: `build-workflows.js` (template body; WAHA path refuses with a clear
  error), a marker parser in `scripts/lib/`, `check-env.js`
  (`WHATSAPP_TEMPLATES`: JSON with name, language, category and parameters).
- Do: `[TEMPLATE] name` or `[قالب] name` is looked up in the allow-list and
  sent as a Cloud API template, with body parameters filled from the row. An
  unknown name fails as invalid with no API call.
- Test: parser (spacing, case, the Arabic alias, extra text), body builder,
  allow-list; E7, E8.

**V2-22 · Reply method and first reply** · S · risk low · after V2-12
- Files: `build-workflows.js` (wf2 echo → `APP`, wf7 → `SHEET` or `TEMPLATE`,
  wf4 → `API`), CSV templates, schema docs.
- Do: every outbound path sets `last_reply_via`, and sets `first_reply_at` if
  it is empty.
- Test: fixtures for each path; `first_reply_at` is never overwritten.

**V2-23 · Pricing capture** · S · risk low · after V2-01
- Files: `Messages.csv` (`pricing_category`, `billable`), wf2 "Update Message
  Status", fixtures with a `pricing` block, schema docs.
- Test: a status with pricing fills both fields; one without leaves them empty.

**V2-24 · Dashboard: window and billing** · M · risk low · after V2-13, V2-22, V2-23
- Files: `build-dashboard.js`, minimal Lists rate cells (complete in V2-32).
- Test: a unit test parses every generated formula and checks that each
  referenced column exists; E18 against a fixture sheet.

**V2-25 · Correct the pricing documents** · S · risk none
- Files: `docs/COSTS.md`, `README.md`, `docs/CLIENT_ONBOARDING.md`.
- Do: replace the flat $10.32 figure with the per-message model and its
  caveat (1.2), and add the client-pays rule and the service price.

**Milestone M1 — target before 1 October:** V2-01 to V2-06, V2-11, V2-14,
V2-20, V2-23, V2-25, and V2-21 if the template is approved in time. The
must-have is V2-20: from 1 October a reply that silently fails costs a customer.

### 7.6 Phase 3 — the Arabic working surface

Starts after S1, S2, S3 and S7 are answered.

**V2-30 · Header rows and tab names** · L · risk high · after V2-10, V2-12
- Files: `apply-sheet-layout.js`, `build-workflows.js` (header options on every
  Conversations, Agents and Archive read and update; `tabName()` in every tab
  reference, API URLs included), `validate-workflows.js`.
- Test: validator rules for both; full live regression (E1–E6, E9, E19) in `en`
  and `ar`.

**V2-31 · Column order, grouping, Agents load** · M · risk medium · after V2-30
- CSV order as in 4.2. Column groups, widths, freeze. On Agents,
  `open_conversations` becomes a derived count, so nothing writes it any more.
  "Increment Agent Load" writes only `last_assigned_at`, which the tie-breaker
  uses.

**V2-32 · Lists tab** · S · risk low · after V2-11
- Named ranges for status, stage, outcome, agents and template names; the rate
  card; the free-tier size; the first-reply SLA hours. Dropdowns point at them.

**V2-33 · Start and System tabs** · S · risk low · after V2-11
- Start: how to work, the three reply paths, colours, the rules in 4.10. System:
  version, script version, last nightly run, last poll (heartbeat written by
  n8n), time-zone offset, tab health.

**V2-34 · Formatting and protection** · S · risk low · after V2-31, S7
- Colours for window, waiting hours and status. Protection for the system block
  and derived columns as S7 decides.

**V2-35 · Filter views** · M · risk low · after V2-31, S3, S5
- Per agent "My queue" (not closed, newest first), Newest first, Waiting over an
  hour, Window closing within 4 hours, Closed today (for undo), Follow-ups
  today. Built from the Agents tab; rebuilt from the menu.

**V2-36 · Dashboard, full** · M · risk low · after V2-13, V2-24
- The filter panel and every section in 4.7. Replaces `buildDashboard_` in Apps
  Script as the only dashboard.

**V2-37 · One Apps Script project** · M · risk medium · after V2-11, V2-30
- Files: `sheets-templates/Sheet.gs` (replaces `SetupSheet.gs` and
  `SheetTools.gs`); a generated `sheets-templates/Labels.gs` (from `labels.js`;
  `build-workflows.js --check` reports drift); a new harness
  `tests/apps-script/` that runs the `.gs` files in Node's `vm` with a fake
  `SpreadsheetApp`.
- Test: no duplicate top-level names; no call to `deleteRow`, `insertRow`,
  `moveRows`, `sort` or writes to system columns (static check); `getUi`
  failures are caught; menu actions write only the columns in 4.9.

### 7.7 Phase 4 — the case lifecycle

**V2-40 · Case code** · S · risk low · after V2-12
- `C-` plus the last six base-36 digits of the creation time in milliseconds,
  minted in `buildNewConversationRow`. Display-only, not unique by contract.

**V2-41 · Stage and outcome** · S · risk low · after V2-32
- Stage dropdown. Outcome: a human override, or derived at archive time (4.4).
  The nightly fold archives losers with `DUPLICATE`.

**V2-42 · Restore from the Archive** · M · risk medium · after V2-15
- Archive columns `restore_requested`, `restored_at` and `archive_id` sit first
  (A to C), so the minute poll reads just `A3:C` through the API. A ticked row
  that is not yet restored is appended to Conversations with the reopen
  transition, and `restored_at` is written by `archive_id`. Both checkers are
  updated (C-22).
- Test: E15; ticking twice restores once.

**V2-43 · Customers tab and returning customers** · M · risk low · after V2-15, V2-40
- Workflow 8 upserts `Customers` (phone, name, last case, last conversation id,
  last closed time, last outcome, case count) during the nightly run. Workflow
  3's create path looks the phone up and fills the name if WhatsApp gave none,
  plus `previous_case_code` and a note.
- Test: unit tests; E13, E14.

**V2-44 · Follow-ups tab** · S · risk low · after V2-13, V2-35
- The read-only list with links, "after the window closes" flags, and the
  dashboard counts.

**V2-45 · Duplicates visible during the day** · S · risk low · after V2-36
- A dashboard count of open rows sharing a phone and business number.

**V2-46 · Reassignment by name** · S · risk low · after V2-12
- The minute poll reads Agents. Where `assigned_agent_name` names a different
  agent than `assigned_agent_id`, it rewrites the id (keyed by
  `conversation_id`). A human choice overrides capacity.
- Test: E22.

**V2-47 · Morning follow-up list (optional)** · S · risk low · after V2-44
- An n8n schedule at `FOLLOWUP_DIGEST_HOUR` sends each agent their due list
  through the Telegram Bot API (`TELEGRAM_BOT_TOKEN` in `.env`, an HTTP call
  like the rest of the project) or by email. Agents get a `notify_chat_id`
  column. It is off unless configured. It does not use WhatsApp, because a
  message to an agent from the business number is business-initiated and paid.
- Test: E23.

### 7.8 Phase 5 — packaging, migration and docs

**V2-50 · Migration tool** · L · risk high · after every earlier task
- File: new `scripts/setup/migrate-v2.js`, dry run by default, `--apply` to act.
- Steps:
  1. Confirm the owner made a copy of the spreadsheet (File → Make a copy; the
     service account has no Drive scope).
  2. Deactivate the workflows.
  3. Add the new columns, move columns into the V2 order, add the derived
     formulas.
  4. Translate stored codes to labels, and `ARCHIVED` to closed.
  5. Create Lists, Start, System and Customers; build the views and the
     dashboard.
  6. Print the Apps Script steps (paste `Sheet.gs` and `Labels.gs`, run
     `removeLegacyTriggers`).
  7. Re-import and activate the workflows; run the smoke test.

  It is idempotent: a second run changes nothing.
- Test: on a copy of a V1 fixture sheet, then E21.

**V2-51 · Demo spreadsheet** · S · risk low · after V2-36
- New `scripts/setup/seed-demo.js` fills a separate spreadsheet with realistic
  Arabic demo data, closed-window cases included, for the sales demo. It
  refuses a sheet that already holds data unless `--force` is given.

**V2-52 · Documentation** · M · risk none
- `GOOGLE_SHEETS_SCHEMA.md` (every tab, column, derived column and label),
  `OPERATING_GUIDE.md`, `ARCHITECTURE.md` (lifecycle in 4.4; the append
  limitation closed), `N8N_WORKFLOWS.md`, `ENVIRONMENT.md` (`SHEET_LANGUAGE`,
  `WHATSAPP_TEMPLATES`, `ARCHIVE_HOUR`, `ARCHIVE_CLOSED_AFTER_HOURS`,
  `FOLLOWUP_DIGEST_HOUR`, `TELEGRAM_BOT_TOKEN`), `TESTING.md`,
  `CLIENT_ONBOARDING.md`, `TROUBLESHOOTING.md`, `CHANGELOG.md`, `README.md`.

**V2-53 · Release** · S · after V2-50 to V2-52
- The full scenario table on a fresh install and on a migrated copy, then the
  tag `v2.0.0` on `plan-v2`. Merging into `main` is the owner's decision.

### 7.9 Track B — operations (owner, no code)

| # | Task | When | Unblocks |
|---|---|---|---|
| O1 | Send a reply from the Business app and check whether the echo or status webhooks carry `pricing_category` | before 1 Oct | Whether the app path is free, the key number in the pitch |
| O2 | Submit `followup_general` for approval (Arabic; utility if Meta accepts it) | now; approval takes hours to days | V2-21 live test |
| O3 | Correct published pricing (same as V2-25) | before 1 Oct | — |
| O4 | Add a payment method to the Meta test account | before 1 Oct | Live tests after 1 Oct |
| O5 | Start business verification for the test account | now; takes weeks | Selling |
| O6 | Observe the first real status webhooks after 1 Oct (S8) | first week of Oct | Exact billing counts |

### 7.10 Order and dependencies

```
Phase 0:  V2-01 ─┬─> V2-02
                 ├─> V2-03 ─> V2-04
                 ├─> V2-05
                 └─> V2-06
Phase 1:  V2-10 (spikes)   V2-11 ─> V2-12   V2-14   V2-13 (S2)
          V2-15 (V2-05, V2-12, S3)
Phase 2:  V2-20 (V2-04, V2-11, V2-14) ─> V2-21 (O2)
          V2-22 (V2-12)   V2-23 (V2-01)   V2-24 (V2-13, V2-22, V2-23)   V2-25
Phase 3:  V2-30 (S1, V2-12) ─> V2-31 ─> V2-34 (S7), V2-35 (S3, S5)
          V2-32, V2-33 (V2-11)   V2-36 (V2-13, V2-24)   V2-37 (V2-30)
Phase 4:  V2-40, V2-41, V2-42 (V2-15), V2-43 (V2-15, V2-40), V2-44, V2-45, V2-46, V2-47
Phase 5:  V2-50 ─> V2-51, V2-52 ─> V2-53
Track B:  O1..O5 now; O6 after 1 October
```

---

## 8. Verification

### 8.1 Gates for every task

```
node tests/run-tests.js
node scripts/setup/build-workflows.js --check
node scripts/validation/validate-workflows.js
node scripts/validation/check-schema-consistency.js
node scripts/validation/check-docs.js
node scripts/validation/check-env.js          # when settings change
```

New validator rules, each added by the task that needs it:

| Rule | Task |
|---|---|
| A Sheets-node append exists only as the fallback of an API append; every API append uses `INSERT_ROWS` and `USER_ENTERED`, places values by name, and falls back; the access branch is complete and the trigger's topmost child (**in place**) | V2-01 |
| "Increment Agent Load" only behind "Agent Assigned?" = true | V2-02 |
| No `sortRange` / `moveDimension` anywhere | V2-03 |
| No Conversations update matched on `row_number` except "Claim Manual Row" | V2-04 |
| Workflow 8 deletes only through one `batchUpdate` built by `planDeletes` | V2-05 |
| Every Conversations read is normalised; no raw status literal in a Sheets node | V2-12 |
| Customer-controlled text passes through `sheetSafe` before any write | V2-06 |
| No workflow maps a derived column | V2-13 |
| Every tab reference goes through `tabName()`; header options on every read and update | V2-30 |
| Every dashboard formula references existing columns | V2-24 |
| No duplicate top-level names in `.gs`; Apps Script never moves rows or writes system columns | V2-37 |

### 8.2 End-to-end acceptance scenarios

Run against the test spreadsheet with `send-fixture.js` and the verify
scripts. Each needs an observed result, not an assumed one.

| # | Scenario | Expected |
|---|---|---|
| E1 | New customer message | Row at the bottom, assigned, labels in the sheet language, case code, window open |
| E2 | Every agent at capacity | `WAITING_FOR_AGENT` row, no failed execution; workflow 5 assigns later |
| E3 | Burst of simultaneous first messages from different customers | One row each; **`verify-burst.js` passes** |
| E4 | Two simultaneous messages from one new customer | At most two rows; dashboard shows a duplicate; the nightly run folds them with outcome duplicate |
| E5 | Sheet reply inside the window | Sent, text cleared, reply method SHEET, `first_reply_at` set once |
| E6 | Sheet reply after 24 hours | No HTTP call, text kept, window-closed status, no Messages row, skipped on the next poll |
| E7 | Template marker with an approved name | Template sent, counted under its category |
| E8 | Template marker with an unknown name | Invalid, no HTTP call |
| E9 | Reply from the Business app (Coexistence) | Echo recorded, reply method APP, status REPLIED |
| E10 | Close on desktop | Hidden at once; `closed_at` stamped by n8n within a minute |
| E11 | Close from the mobile app | Stamped and hidden within a minute |
| E12 | Nightly archive | Closed rows in Archive, Customers upserted, only those ids removed (snapshot diff); nothing deleted outside `ARCHIVE_HOUR` |
| E13 | Customer writes again before the nightly run | Same case reopens and becomes visible |
| E14 | Customer writes again after archiving | New case with name, `previous_case_code` and a note |
| E15 | Restore ticked in Archive | Row back, `restored_at` set, archive row kept, no double restore |
| E16 | Someone tries to sort the tab or delete a row | Blocked by protection (S7 yes) or, if not, no write lands on the wrong row, because writes are keyed by id |
| E17 | Dashboard longest wait | Matches a hand computation (not 0) |
| E18 | Dashboard billing | Equals a hand count of the Messages fixture |
| E19 | Hand-typed row for a new number | Plain text: blocked as window-closed and kept. Template marker: claimed, sent, then keyed by id |
| E20 | Same fixtures with `SHEET_LANGUAGE=en` and `ar` | Identical decisions |
| E21 | Migration of a V1 copy | All V1 rows readable, statuses translated, workflows green; a second run changes nothing |
| E22 | Agent name edited by hand | Within a minute `assigned_agent_id` matches; load and "My queue" agree |
| E23 | Morning list (when configured) | Each agent receives only their due follow-ups |
| E24 | A V1 row still marked `ARCHIVED` | Treated as closed: hidden, archived at night |
| E25 | Customer writes to a hidden closed row | Row reopens and becomes visible without anyone touching the filter |

---

## 9. Upgrading an existing deployment

1. Tag the current state (`git tag v1-final`) and export the workflows.
2. The owner makes a copy of the spreadsheet. The copy is the rollback.
3. `node scripts/setup/migrate-v2.js` (dry run); read the plan it prints.
4. Add the new settings to the server's compose file by hand. It is
   maintained separately from the repository.
5. `node scripts/setup/migrate-v2.js --apply` outside working hours. It stops
   the workflows first and restarts them last.
6. Paste the new Apps Script files and run `removeLegacyTriggers` once.
7. Smoke test with a test number: E1, E5, E6, E10, and E12 the next morning.

Rollback: point `GOOGLE_SHEET_ID` back at the copy, check out `v1-final`, and
re-import the workflows. V1 cannot read Arabic labels, so conversations that
arrived during the V2 window are copied into the copy by hand. They are plain
values in the V2 sheet, and the Messages tab has the full history.

---

## 10. Out of scope for V2

| Not in V2 | Revisit when |
|---|---|
| AI replies | A paying client asks, and the grounding rules in `FUTURE_AI.md` are met |
| Web inbox | Sheets limits bite (about 300 conversations a day), or agents must not see each other's rows |
| WAHA in the paid product | Never for paying clients, unless Meta's terms change |
| Postgres | Same trigger as the web inbox (`GOOGLE_SHEETS_TO_POSTGRES.md`) |
| Other channels | After the first paying clients |
| Folding duplicates during the day | Needs compare-and-set, meaning a database |
| Per-agent row privacy | Not possible in Google Sheets; needs the web inbox |

---

## 11. Decisions the owner still has to make

| # | Decision | Recommendation |
|---|---|---|
| D1 | Default `SHEET_LANGUAGE` for new installs | `ar` for Jordanian clients; `en` stays the default for existing installs |
| D2 | Nightly archive hour | 03:00 Asia/Amman (`ARCHIVE_HOUR=3`) |
| D3 | Can a case close without a stage or outcome? | Yes; the outcome is derived, "not recorded" if nothing fits |
| D4 | The stage list | The prototype's five (4.3), edited to match how the client sells |
| D5 | Template category for `followup_general` | Utility if Meta approves it; marketing costs about four times as much |
| D6 | First-reply SLA for "value lost because late" | 2 hours, editable in Lists |
| D7 | Morning list channel (V2-47) | Telegram (free, instant); email as the alternative |
