# Testing

## What has actually been executed

This section is the honest record. Nothing is described as working unless it was
run and observed.

| Level | Needs credentials? | Status |
|---|---|---|
| 1 — Unit tests (business logic) | No | **192 passing** |
| 2 — Workflow validation | No | **504 checks passing** |
| 3 — Live webhook (local HTTP) | No | **Passing** — verified against the running n8n |
| 3b — Schema consistency | No | **9 checks passing** |
| 4 — **End-to-end against the live deployment** | Yes (both) | **26 checks passing** |
| 5 — **Archiving** | Yes (both) | **17 checks passing** |

Level 4 is the one that matters, and it is the reason nothing on this page is
hedged any more. It talks to the real webhook over HTTPS with correctly signed
payloads and then reads the real spreadsheet:

```
node scripts/testing/verify-live.js
node scripts/testing/verify-live.js --real-send=9627XXXXXXXX
```

What it proves, in order:

1. the verification handshake accepts the right token
2. and refuses a wrong one
3. an unsigned POST is rejected — the system fails closed
4. a wrongly-signed POST is rejected
5. a signed inbound message creates a conversation row **and** a message row,
   assigned to an agent, with the customer's name and first-contact time
6. redelivering the same `message_id` creates nothing new
7. a second message from the same customer keeps the same agent and returns the
   status to `UNANSWERED`
8. typing into `reply_text` sends, writes the outcome back to that row, and
   clears the cell
9. `status = ARCHIVED` moves the row into `Archive` with an `archived_at`
10. `Conversations` and `Archive` still have exactly their declared columns

With `--real-send` it also adds a hand-typed row and checks that a **real
WhatsApp message** reaches a real number.

The synthetic customer it invents is not a real WhatsApp user, so step 8's send
comes back `FAILED` with Meta's reason recorded — which is the correct outcome
and exercises the whole path including the failure write-back.

---

## Level 1 — Unit tests

```bash
node tests/run-tests.js               # everything
node tests/run-tests.js assignment    # one area
```

No npm install, no credentials, ~15 ms.

```
169 passed, 0 failed, 169 total
```

| Suite | Tests | Covers |
|---|---|---|
| `conversations/phone.test.js` | 17 | E.164 normalization, Arabic digits, ambiguity |
| `assignment/assignment.test.js` | 26 | Selection, tie-breaks, capacity, race exposure |
| `webhook/parser.test.js` | 36 | Real Meta payloads, malformed input, all message types, Coexistence echoes |
| `webhook/security.test.js` | 22 | Handshake, HMAC, redaction |
| `webhook/idempotency.test.js` | 29 | Dedupe keys, status ladder, locks |
| `conversations/conversation.test.js` | 39 | State machine, identity, row building, inactivity |

These test the **same code** that runs in n8n — `scripts/setup/build-workflows.js`
inlines these exact files into Code nodes, so there is no tested-vs-shipped gap.

---

## Level 2 — Workflow validation

```bash
node scripts/validation/validate-workflows.js
```

504 checks across the 9 workflows:

- every Code node body **parses as JavaScript** (`vm.Script` compile)
- no leftover `module.exports` or relative `require()` from inlining
- every `connections` entry references a node that exists
- every node is wired into the graph (no orphans)
- node names and ids are unique
- every `typeVersion` is one the installed n8n supports
- **no hard-coded secrets** (Meta tokens, private keys, bearer literals, API keys)

This catches things that would otherwise fail at 3am. It found two real bugs
during development: a duplicate `const crypto` declaration from inlining two
libraries into one Code node, and it is what enforces the no-secrets rule on
every build.

```bash
node scripts/setup/build-workflows.js --check   # fail if generated files are stale
node scripts/validation/check-env.js            # config completeness, no values printed
```

---

## Level 3 — Live webhook tests

Exercises the real deployed workflow over real HTTP. **Contacts nobody, costs
nothing, sends no WhatsApp message.**

Requires: n8n running, workflow 1 published, `WEBHOOK_VERIFY_TOKEN` and
`META_APP_SECRET` set.

### Results actually observed

| Test | Command | Expected | Observed |
|---|---|---|---|
| Handshake, correct token | curl below | 200 + challenge | **200 `1158201444`** |
| Handshake, wrong token | curl below | 403 | **403 `Forbidden`** |
| Signed POST | `send-fixture.js text-message.json` | 200 | **200 `EVENT_RECEIVED`** |
| Bad signature | `--bad-signature` | 401 | **401 `invalid signature`** |
| No signature | `--no-signature` | 401 | **401 `invalid signature`** |
| All 10 fixtures signed | `send-fixture.js` | 200 each | **200 × 10** |
| Handoff to processor | check logs | no "not active" | **no errors** |

```bash
# Handshake
curl "http://localhost:5678/webhook/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=1158201444"

# Signed delivery — signature computed exactly as Meta computes it
node scripts/testing/send-fixture.js text-message.json
node scripts/testing/send-fixture.js                     # all fixtures
node scripts/testing/send-fixture.js text-message.json --bad-signature
node scripts/testing/send-fixture.js text-message.json --no-signature
node scripts/testing/send-fixture.js text-message.json --twice   # duplicate
```

### Fixtures

| File | Exercises |
|---|---|
| `text-message.json` | Arabic text, the worked example from the spec |
| `image-message.json` | Media with caption, media id, mime type |
| `location-message.json` | Non-text message with no text body |
| `unsupported-type.json` | A type Meta has not invented yet |
| `batched-multiple-messages.json` | 4 messages, 2 business numbers, one POST |
| `status-delivered.json` | Delivery receipt with pricing/billability |
| `status-failed.json` | Failure with error 131047 (24-hour window) |
| `malformed-payload.json` | Change with neither messages nor statuses |
| `echo-agent-reply.json` | An agent reply sent from the WhatsApp Business App (Coexistence) |
| `echo-revoke.json` | An agent deleting a message from the app |

---

## The 25 required scenarios

| # | Scenario | How it is tested | Status |
|---|---|---|---|
| 1 | First message from new customer | Unit + live fixture | **Tested** |
| 2 | Second message from existing customer | Unit (state machine) | **Tested** |
| 3 | Duplicate webhook | Unit (dedupe) + `--twice` | **Tested** |
| 4 | Two simultaneous new customers | Unit — race explicitly demonstrated | **Tested (exposed)** |
| 5 | Least-conversations assignment | Unit — the Ahmed/Mohammad/Sara case | **Tested** |
| 6 | Tie-breaking | Unit — 4 tests incl. determinism | **Tested** |
| 7 | Unavailable agent | Unit | **Tested** |
| 8 | All agents unavailable | Unit — queues, never drops | **Tested** |
| 9 | Agent at max capacity | Unit | **Tested** |
| 10 | Closed conversation receives message | Unit (reopen) | **Tested** |
| 11 | Malformed webhook | Unit + live fixture | **Tested** |
| 12 | Unsupported message type | Unit + live fixture | **Tested** |
| 13 | Meta API failure | Fixture `status-failed.json` parsed | **Partial** — real outage not simulated |
| 14 | Google Sheets API failure | Nodes set to `continueErrorOutput`; exercised live when a write was refused | **Tested** |
| 15 | Outgoing message success | `verify-live.js --real-send` delivers a real WhatsApp message | **Tested** |
| 16 | Outgoing message failure | Unit, plus live: Meta refused a number and the row recorded `[131030]` | **Tested** |
| 17 | Delivered status | Unit (ladder) + fixture | **Tested** |
| 18 | Read status | Unit (ladder) | **Tested** |
| 19 | Failed status | Unit (ladder) + fixture | **Tested** |
| 20 | Phone normalization | Unit — 17 tests | **Tested** |
| 21 | Timezone handling | Unit — local time with an explicit UTC offset | **Tested** |
| 22 | Application restart | `docker compose restart` performed | **Tested** |
| 23 | n8n restart | Performed repeatedly during development | **Tested** |
| 24 | Persistent data after Docker restart | Workflows survived several restarts | **Tested** |
| 25 | Credentials not exposed in logs | Unit — redaction; validator scans workflows | **Tested** |

### Scenarios added after the original list

| Scenario | How it is tested | Status |
|---|---|---|
| Agent replies from the WhatsApp Business App | Unit (7 tests) + live fixture | **Tested** |
| Echo direction is not reversed | Unit — asserts customer is `to`, not `from` | **Tested** |
| Agent deletes a message from the app (`revoke`) | Unit — recorded, does not advance state | **Tested** |
| Reply typed into the sheet | `verify-live.js` — sent, outcome written back, cell cleared | **Tested** |
| Double-send guard on sheet replies | `verify-live.js` asserts `reply_text` is cleared on send | **Tested** |
| Nightly archiving | `verify-archive.js` — 17 checks, both the manual and the swept path | **Tested** |
| Sheet schema drift | `check-schema-consistency.js`, verified against a planted mismatch | **Tested** |
| Messaging a number not yet in the sheet | `verify-live.js --real-send` adds a row by hand and it sends | **Tested** |
| Every unanswered message stays visible | Unit (6 tests) + live: five messages accumulated, a reply cleared them | **Tested** |
| Newest conversation at the top | Live — a follow-up moves its row to row 2 | **Tested** |
| Agent capacity is respected | Live — at capacity a conversation waits as `WAITING_FOR_AGENT` | **Tested** |
| Documentation matches the system | `check-docs.js` — links, counts, coverage, language | **Tested** |

### On scenario 4

The race is **demonstrated, not fixed at the logic layer** — because it cannot
be. The test asserts that two executions reading identical state pick the same
agent, which is exactly the failure Google Sheets permits. The mitigation is
workflow concurrency 1, and the real fix is PostgreSQL. Documented in
[ASSIGNMENT_ALGORITHM.md](ASSIGNMENT_ALGORITHM.md#concurrency-and-race-conditions).

---

## Distribution and stickiness have their own run

```
node scripts/testing/scenario-multi-agent.js
```

Three different customers arriving in sequence, then follow-up messages from
each. It proves the two behaviours a support desk depends on and which no unit
test can show:

- **Distribution** — the three customers are spread across three agents rather
  than piling onto one.
- **Stickiness** — a second and third message from the SAME customer stay with
  the agent already handling them. A desk that reshuffles the owner mid
  conversation is worse than useless.

It also checks that the status returns to `UNANSWERED` on every new customer
message, which is what keeps a follow-up visible.

---

## Archiving has its own run

Archiving is the only operation that DELETES from Conversations, so it gets its
own script:

```
node scripts/testing/verify-archive.js
```

Seventeen checks. The one that matters is the batch: deleting a row shifts every
row beneath it, so a sweep that does not delete bottom-up removes the wrong
rows — from the one tab whose entire job is not losing anything. The script
archives **two of three** conversations at once and then asserts that the third
is still there, unchanged, and not in Archive.

It also covers both ways a row leaves:

- someone sets `status` to `ARCHIVED`
- the sweep takes a conversation that has been `CLOSED` longer than
  `ARCHIVE_AFTER_DAYS` — the unattended path, which is why it is tested

and checks that every column survives the move, including `product` and
`quantity`, which only a human ever writes.

### Clearing up afterwards

```
node scripts/testing/clean-test-rows.js --dry-run
node scripts/testing/clean-test-rows.js
```

It matches the **names** the verification scripts write, never a pattern over
phone numbers. That is not fussiness: a regex meant to catch synthetic numbers
matched a real customer's number and deleted 46 genuine message rows. Nothing in
a phone number says whether it is real.

Always run the dry run first. If anything does go, Google Sheets keeps version
history: File → Version history → restore.

---

## Level 4 — the live end-to-end run

`scripts/testing/verify-live.js` is the executable version of the table below.
Run it after every deploy; it is the only thing that proves the deployment
rather than the code.

| Check | How it is exercised | Expected |
|---|---|---|
| Read agents | A signed inbound fixture | The conversation is assigned to an agent |
| Create conversation | A message from a new number | New row, status `UNANSWERED` |
| Update conversation | A second message | Same row updated, no duplicate |
| Agent stickiness | A second message | `assigned_agent_name` unchanged |
| Append message | Any message | One row per message in `Messages` |
| Audit event | Any message | A row in `Log` with the decision |
| Dedupe | The same `message_id` twice | The second delivery creates nothing |
| Send from the sheet | Text typed into `reply_text` | Sent, cell cleared, outcome written |
| Send to a new number | A hand-typed row | Real WhatsApp message delivered |
| 24h window | Reply after 24h | Error `131047` recorded in `reply_error` |
| Archiving | `status = ARCHIVED` | Row in `Archive`, gone from `Conversations` |
| Column drift | Header compared to the CSV | Exactly the declared columns |

## Restart and persistence

```bash
docker compose restart n8n
# workflows, credentials and executions all survive

docker compose down && docker compose up -d
# same — the named volume is not removed by `down`
```

`docker compose down -v` **would** delete the volume. Do not run it unless you
intend to lose everything.

---

## Regression check before any change

```bash
node tests/run-tests.js                          # 169 passed
node scripts/setup/build-workflows.js            # regenerate
node scripts/validation/validate-workflows.js    # 414 passed
node scripts/setup/import-workflows.js           # 6/6 [ok]
node scripts/testing/send-fixture.js             # 200 × 10
```

If you changed anything in `scripts/lib/`, the rebuild step is mandatory —
otherwise the tests pass against code that is not what n8n is running.

---

## Checking the documentation

```
node scripts/validation/check-docs.js
```

Documentation rots quietly, and a document that is confidently wrong is worse
than none: the reader has no way to tell which parts still hold. This checks the
claims that can be checked mechanically — every relative link resolves, every
count of tests, checks, columns and workflows matches reality, nothing still
points at a file that was removed, every script is mentioned somewhere, and the
prose is in English with no tool branding.

It cannot check that prose is true. It can check that prose is not provably
stale, which is most of the rot. Run it with the other validators before a
commit:

```
node tests/run-tests.js
node scripts/validation/validate-workflows.js
node scripts/validation/check-schema-consistency.js
node scripts/validation/check-docs.js
```
