# Testing

## What has actually been executed

This section is the honest record. Nothing is described as working unless it was
run and observed.

| Level | Needs credentials? | Status |
|---|---|---|
| 1 — Unit tests (business logic) | No | **162 passing** |
| 2 — Workflow validation | No | **303 checks passing** |
| 3 — Live webhook (local HTTP) | No | **Passing** — verified against the running n8n |
| 4 — Google Sheets persistence | Yes (Google) | **Not executed** — no service account available |
| 5 — Outgoing messages | Yes (Meta) | **Not executed** — no access token available |
| 6 — Real Meta end-to-end | Yes (both) | **Not executed** |

Levels 4–6 are built and structurally validated but have **not** been run
against live APIs. They are not claimed to work.

---

## Level 1 — Unit tests

```bash
node tests/run-tests.js               # everything
node tests/run-tests.js assignment    # one area
```

No npm install, no credentials, ~15 ms.

```
162 passed, 0 failed, 162 total
```

| Suite | Tests | Covers |
|---|---|---|
| `conversations/phone.test.js` | 17 | E.164 normalization, Arabic digits, ambiguity |
| `assignment/assignment.test.js` | 26 | Selection, tie-breaks, capacity, race exposure |
| `webhook/parser.test.js` | 29 | Real Meta payloads, malformed input, all message types |
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

303 checks across the 6 workflows:

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
| All 8 fixtures signed | `send-fixture.js` | 200 each | **200 × 8** |
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
| 14 | Google Sheets API failure | Nodes set to `continueErrorOutput` | **Not executed** — needs credentials |
| 15 | Outgoing message success | — | **Not executed** — needs Meta token |
| 16 | Outgoing message failure | Error interpretation is unit-covered | **Partial** |
| 17 | Delivered status | Unit (ladder) + fixture | **Tested** |
| 18 | Read status | Unit (ladder) | **Tested** |
| 19 | Failed status | Unit (ladder) + fixture | **Tested** |
| 20 | Phone normalization | Unit — 17 tests | **Tested** |
| 21 | Timezone handling | Unit — UTC enforced | **Tested** |
| 22 | Application restart | `docker compose restart` performed | **Tested** |
| 23 | n8n restart | Performed repeatedly during development | **Tested** |
| 24 | Persistent data after Docker restart | Workflows survived several restarts | **Tested** |
| 25 | Credentials not exposed in logs | Unit — redaction; validator scans workflows | **Tested** |

### On scenario 4

The race is **demonstrated, not fixed at the logic layer** — because it cannot
be. The test asserts that two executions reading identical state pick the same
agent, which is exactly the failure Google Sheets permits. The mitigation is
workflow concurrency 1, and the real fix is PostgreSQL. Documented in
[ASSIGNMENT_ALGORITHM.md](ASSIGNMENT_ALGORITHM.md#concurrency-and-race-conditions).

---

## Level 4–6 — What still needs credentials

### Google Sheets (needs a service account)

| Check | Procedure | Expected |
|---|---|---|
| Read agents | Send a fixture, inspect execution | Agents rows returned |
| Create conversation | Send a new-customer fixture | New row, status `UNANSWERED` |
| Update conversation | Send a second message | Same row updated, no duplicate |
| Append message | Any fixture | One row per message |
| Append audit event | Any fixture | Events row with the eligibility list |
| Dedupe against Sheets | `--twice` | Second delivery creates nothing |
| Sheets failure | Revoke sharing, send fixture | Webhook still 200; error recorded |

### Outgoing messages (needs a Meta token)

| Check | Procedure | Expected |
|---|---|---|
| Send success | POST to `/webhook/agent/send` | 200, `wamid` returned, status `SENT` |
| Send failure | Use an invalid token | 502, status `FAILED`, error 190 |
| Status progression | Send, then wait | `SENT` → `DELIVERED` → `READ` |
| 24h window | Reply after 24h | Error 131047 recorded |

```bash
curl -X POST http://localhost:5678/webhook/agent/send \
  -H "Content-Type: application/json" \
  -d '{"to":"962791234567","text":"مرحبا","conversation_id":"CONV-...","agent_id":"A2"}'
```

> **This sends a real WhatsApp message and may cost money.** Only run it against
> a test number you control.

### Full end-to-end (needs both)

1. Message the business number from a real WhatsApp account
2. Confirm the conversation row appears with an assigned agent
3. Reply through workflow 4
4. Confirm status becomes `REPLIED`, `unread` becomes `FALSE`
5. Confirm the message status advances to `DELIVERED`

---

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
node tests/run-tests.js                          # 162 passed
node scripts/setup/build-workflows.js            # regenerate
node scripts/validation/validate-workflows.js    # 303 passed
node scripts/setup/import-workflows.js           # 6/6 [ok]
node scripts/testing/send-fixture.js             # 200 × 8
```

If you changed anything in `scripts/lib/`, the rebuild step is mandatory —
otherwise the tests pass against code that is not what n8n is running.
