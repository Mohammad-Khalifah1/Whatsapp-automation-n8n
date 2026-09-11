# Decision Log

Significant architectural decisions, why they were made, and what was
deliberately deferred. Each entry records the trade-off accepted, not just the
choice.

---

## D-001 — Docker Compose for the MVP, not Kubernetes

**Decision.** Run n8n as a single Docker Compose service. No Kubernetes
manifests.

**Context.** Kubernetes 1.36.1 is available and healthy on this machine
(`docker-desktop` context), so this was a real option.

**Why.** The MVP is one stateful service with one persistent volume and no
horizontal scaling requirement. Kubernetes would add Deployment, Service,
Ingress, ConfigMap, Secret, PVC and a controller to reason about — and would
change nothing about how the system behaves. The target production environment
is a single small VPS, where Compose is also the right tool.

**Trade-off accepted.** No rolling deploys, no self-healing beyond
`restart: unless-stopped`, no horizontal scale. All acceptable at this volume,
and none of them is what limits throughput (Google Sheets quotas are).

**Revisit when** more than one n8n instance is genuinely needed — see
[KUBERNETES_MIGRATION.md](KUBERNETES_MIGRATION.md).

---

## D-002 — Google Sheets as the MVP store

**Decision.** Agents, Conversations, Messages and Log live in Google Sheets.

**Why.** It gives non-technical managers a filterable, sortable, editable view
with zero front-end work, and it lets agents be reconfigured without touching a
workflow. For an MVP whose main risk is "will the routing model fit how this
team actually works", a spreadsheet answers that question faster than a schema.

**Trade-off accepted.** No transactions, no locking, no constraints, and a hard
ceiling of roughly 60 reads/minute/user. These are real limits and they are
documented rather than glossed over.

**Mitigated by** keeping all business logic I/O-free so the store can be
swapped by changing callers — see
[GOOGLE_SHEETS_TO_POSTGRES.md](GOOGLE_SHEETS_TO_POSTGRES.md).

---

## D-003 — Google Sheets is not treated as a transactional database

**Decision.** Document the race conditions explicitly and mitigate them at the
workflow level, rather than building an elaborate locking scheme on top of a
spreadsheet.

**Why.** Sheets has no atomic compare-and-set. Any "lock" built on it is
advisory: between reading the lock and writing it, another execution can
interleave. A locking layer that *looks* authoritative but is not is more
dangerous than a documented limitation, because people trust it.

**What was done instead.** Assignment runs with concurrency 1, which genuinely
removes the race on a single n8n instance. An advisory lock exists as well, but
is labelled advisory everywhere it appears — including in the code comments.

Full analysis:
[ASSIGNMENT_ALGORITHM.md](ASSIGNMENT_ALGORITHM.md#concurrency-and-race-conditions).

---

## D-004 — Business logic lives outside n8n and is inlined at build time

**Decision.** All decision logic lives in `scripts/lib/*.js`. A build script
(`scripts/setup/build-workflows.js`) inlines those exact files into n8n Code
nodes. Workflow JSON is generated, never hand-edited.

**Why.** n8n Code nodes cannot `require()` host files, so logic pasted into a
workflow is a *copy*. Copies drift: tests keep passing while the thing actually
running quietly diverges. Inlining at build time makes the tested code and the
running code byte-identical by construction.

It also makes the logic testable without Meta or Google credentials — which is
why there are 169 passing tests on a machine with no API keys.

**Trade-off accepted.** Editing logic requires a rebuild and re-import; you
cannot fix business logic by typing into the n8n UI. That is a feature: a fix
made in the UI would be lost on the next import and would never be tested.

**Enforced by** `scripts/validation/validate-workflows.js`, which parses every
Code node body and fails if it is not valid JavaScript.

---

## D-005 — Conversation identity is a synthesized internal id

**Decision.** `CONV-<business_phone_number_id>-<customer_phone>-<epoch_ms>`.
Explicitly **not** the WhatsApp message id.

**Why.** A `wamid` identifies one message. Using it as a conversation key would
create a new conversation for every message. Including the business phone
number id means one customer messaging two of your numbers gets two independent
conversations, which is what a multi-number WABA requires. The timestamp suffix
keeps ids unique across close/recreate cycles so closed history is preserved.

---

## D-006 — Five conversation states, not eight

**Decision.** `WAITING_FOR_AGENT`, `UNANSWERED`, `REPLIED`,
`WAITING_FOR_CUSTOMER` (reserved), `CLOSED`.

**Why two were collapsed.**

- **`OPEN` removed.** It is not a state, it is the set `status != CLOSED`.
  Keeping it alongside `UNANSWERED` would permit contradictory rows that are
  both `OPEN` and `UNANSWERED`, and would force every filter to special-case
  the overlap.
- **`ASSIGNED` merged into `UNANSWERED`.** A conversation is assigned and
  awaiting its first reply within the same execution. A distinct `ASSIGNED`
  state would be entered and left before anything could observe it, so it would
  add ambiguity and no information.

The specification permitted simplification where technically justified. Every
remaining state has documented semantics in
[ARCHITECTURE.md](ARCHITECTURE.md#conversation-state-machine); none exists
without one.

---

## D-007 — Idempotency keys differ for messages and statuses

**Decision.** Messages dedupe on `message:<wamid>`. Statuses dedupe on
`status:<wamid>:<STATUS>`.

**Why.** The same message id arrives repeatedly as `sent` → `delivered` →
`read`. Keying statuses on the message id alone would treat legitimate delivery
progression as duplicates, and delivery tracking would silently never update —
a bug that looks like "delivery status doesn't work" and is very hard to trace.

Paired with a monotonic status ladder so out-of-order callbacks cannot downgrade
`READ` back to `DELIVERED`.

---

## D-008 — Acknowledge the webhook before doing any work

**Decision.** Workflow 1 responds `200 EVENT_RECEIVED` immediately after
signature verification, then hands off asynchronously.

**Why.** Meta retries webhooks it does not get a timely `200` for. If Google
Sheets I/O happened first, a slow Sheets call would trigger a retry, and the
retry would arrive while the first execution was still working — manufacturing
exactly the concurrency problem that is hardest to defend against. Acking first
removes the most common cause of duplicate processing.

**Trade-off accepted.** A `200` means "accepted", not "processed". Processing
failures are therefore invisible to Meta and must be found in the Log sheet
and n8n's execution log. This is the correct trade: Meta cannot fix our
downstream failure by retrying, so asking it to retry helps nobody.

---

## D-009 — Inactivity does not auto-close

**Decision.** `CONVERSATION_INACTIVITY_HOURS` (default 24) computes
*eligibility* for closing. Nothing closes automatically in the MVP.

**Why.** Auto-closing is destructive and asymmetric: closing a conversation the
customer still cares about is far worse than leaving a stale one open. Until
there is operational evidence of what "stale" means for this team, the safe
default is to surface the candidates and let a human decide.

The rule is explicit and implemented (`isInactivityCloseEligible`), fails safe
on unparseable dates, and refuses to act on already-closed conversations — so
enabling it later is a small, tested change rather than new work.

---

## D-010 — Phone numbers stored E.164 without `+`

**Decision.** Store `962791234567`. Derive `+962791234567` and
`https://wa.me/962791234567` on demand.

**Why.** It matches what Meta sends in `wa_id` and `from`, so inbound data needs
no transformation and lookups compare like with like. One canonical
representation means a customer cannot end up with two conversations because one
row stored `+962...` and another stored `00962...`.

**Ambiguity is flagged, never guessed.** `791234567` could be a Jordanian
number missing its trunk zero, or a foreign number. Guessing risks messaging a
stranger, so it is returned flagged; outbound sends use the strict variant that
refuses ambiguous input outright.

---

## D-011 — Fail closed on every security check

**Decision.** Missing `WEBHOOK_VERIFY_TOKEN` ⇒ handshake fails.
Missing `META_APP_SECRET` ⇒ signature verification fails.
Unrecognized agent `available` value ⇒ agent is not eligible.

**Why.** The alternative — treating "not configured" as "not required" — means
a deployment mistake silently disables authentication. An endpoint that accepts
unsigned webhooks because someone forgot an environment variable is worse than
one that visibly refuses everything.

---

## D-012 — Signature verified over raw bytes, not re-serialized JSON

**Decision.** The Webhook node runs with `rawBody: true`, and the HMAC is
computed over the base64-decoded raw body from `binary.data.data`.

**Why.** `JSON.stringify(JSON.parse(body))` changes key order, whitespace and
unicode escaping, producing a different digest. Verifying against re-serialized
JSON rejects every legitimate Meta request.

**This was found by testing, not by reading.** The first implementation read
the raw body from the wrong field and returned `401` on a correctly signed
payload. It was caught by an actual signed HTTP request against the running
instance, which is why that test now lives in
[`scripts/testing/send-fixture.js`](../scripts/testing/send-fixture.js).

---

## D-013 — Stable, pinned workflow ids

**Decision.** Each workflow carries a fixed id (`whatsappRecv0001`, …).

**Why.** n8n's `import:workflow` *updates* a workflow whose id already exists
and *creates* one when it does not. Without pinned ids, every re-import produced
another complete set of duplicates — which is exactly what happened during
development before this was fixed.

Pinning also removes a chicken-and-egg problem: Execute Workflow nodes address
targets by id, so with ids known at build time the cross-references are correct
in the generated JSON and need no post-import patching.

---

## D-014 — Explicit `N8N_ENCRYPTION_KEY`

**Decision.** Set the key explicitly from `.env` rather than letting n8n
generate one into its volume.

**Why.** An auto-generated key exists only inside the Docker volume. Restore
that volume elsewhere — or lose it — and every stored credential becomes
undecryptable. An explicit key can be backed up and moved to the VPS with the
data.

**Consequence encountered.** n8n refuses to start when an explicit key disagrees
with one already stored in a volume. Because the existing volume held zero
workflows and zero credentials, the stack was pointed at a **fresh** volume and
the old one was left untouched on disk for the operator to inspect or remove —
rather than deleting data unilaterally.

---

## D-015 — `NODE_FUNCTION_ALLOW_BUILTIN=crypto`, and env access enabled

**Decision.** Allow exactly one Node built-in (`crypto`) in Code nodes, and set
`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`.

**Why.** `crypto` is required for HMAC signature verification. Scoping to that
single module rather than `*` keeps the blast radius small.
`NODE_FUNCTION_ALLOW_EXTERNAL` is deliberately unset: no npm packages in Code
nodes at all.

n8n 2.x blocks `$env` in nodes by default. Configuration (verify token, app
secret, Graph API version, sheet id) is read from the environment specifically
so it is not hard-coded into workflow JSON, so this had to be enabled.

**Trade-off accepted.** Code nodes can read this container's environment. That
is acceptable because the container runs nothing but these workflows and its
environment *is* their configuration — and it is why every log path goes through
`redact()`.

---

## D-016 — Future-tightening n8n defaults pinned now

**Decision.** Explicitly set `N8N_UNVERIFIED_PACKAGES_ENABLED=false`,
`N8N_RUNNERS_TASK_TIMEOUT=60`, and the two compression caps.

**Why.** n8n warns that these defaults will change in a future release. Pinning
them means upgrading n8n cannot silently alter this system's behaviour. The
values chosen are the *safer* future defaults, not the current permissive ones:
no community packages, a 60-second task cap that turns a hung Code node into a
fast visible failure, and small archive limits on a system that never processes
archives.

---

## D-017 — A zero-dependency test runner

**Decision.** `tests/run-tests.js` is hand-written; there is no Jest, Mocha or
`package.json` dependency.

**Why.** The tests are the evidence that this system works. Making them
dependent on a successful `npm install` means a proxy, a lockfile conflict, or
an offline machine becomes a reason nobody runs them. 169 tests run with nothing
but Node.

**Trade-off accepted.** No watch mode, no coverage report, no parallelism. The
suite runs in about 15 ms, so none of those matter yet.

---

## Deliberately deferred

| Deferred | Why | Where it is designed |
|---|---|---|
| PostgreSQL | Sheets is sufficient at MVP volume and better for manager visibility | [GOOGLE_SHEETS_TO_POSTGRES.md](GOOGLE_SHEETS_TO_POSTGRES.md) |
| Agent web inbox | Workflow 4 already provides the reply API it would sit on | [FUTURE_AGENT_INBOX.md](FUTURE_AGENT_INBOX.md) |
| AI classification / auto-reply | Must not sit in the critical routing path before routing itself is proven | [FUTURE_AI.md](FUTURE_AI.md) |
| Kubernetes | No concrete benefit at one instance | [KUBERNETES_MIGRATION.md](KUBERNETES_MIGRATION.md) |
| Media download and storage | `media_id` and `mime_type` are captured, so files can be fetched later | [ARCHITECTURE.md](ARCHITECTURE.md#message-type-support) |
| Template messages (>24h replies) | Needs Meta template approval; the failure is detected and reported (error 131047) | [ERROR_HANDLING.md](ERROR_HANDLING.md) |
| Automatic conversation closing | Destructive; needs operational evidence first | D-009 above |
| Multi-language agent UI | The MVP surface is a spreadsheet | — |
| SLA timers and alerting | Needs real response-time data first | [FUTURE_AGENT_INBOX.md](FUTURE_AGENT_INBOX.md) |
