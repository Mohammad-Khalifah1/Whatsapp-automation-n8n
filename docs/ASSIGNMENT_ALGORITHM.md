# Assignment Algorithm

How a conversation is routed to an agent — and an honest account of what this
design can and cannot guarantee on Google Sheets.

Implementation: [`scripts/lib/assignment.js`](../scripts/lib/assignment.js)
Tests: [`tests/assignment/assignment.test.js`](../tests/assignment/assignment.test.js)

---

## The algorithm

**Strategy: `LEAST_OPEN_CONVERSATIONS`** (default)

### Step 1 — eligibility

An agent may receive a new conversation only if **all** of these hold:

| Condition | Rule | Failure reason recorded |
|---|---|---|
| Active | `active` is truthy | `INACTIVE` |
| Available | `available` is truthy | `UNAVAILABLE` |
| Has capacity | `open_conversations < max_open_conversations` | `AT_CAPACITY` |
| Has an id | `agent_id` is non-empty | `MALFORMED_RECORD` |

Every excluded agent is recorded **with the reason**, and that list is written
to the Log sheet. When someone asks "why didn't Sara get this one?", the
answer is in the audit row, not in a guess.

### Step 2 — ordering

Eligible agents are sorted by a three-level comparator:

1. **Fewest `open_conversations`** — the core of the strategy.
2. **Earliest `last_assigned_at`** — an agent never assigned sorts *first*
   (a blank timestamp is treated as "longest ago", not as "unknown").
3. **Lowest `agent_id`**, lexicographically — the deterministic fallback.

### Step 3 — selection

The first agent in that order wins.

### Worked example (from the specification)

| Agent | open_conversations |
|---|---|
| Ahmed | 4 |
| Mohammad | 3 |
| Sara | 3 |

Ahmed is excluded by load. Mohammad and Sara tie at 3, so the tie-breaker
decides: whoever was assigned longer ago, and if that also ties, the lower
`agent_id`. **Ahmed cannot be selected.** This exact case is asserted in the
test suite.

---

## Why step 3 exists

A deterministic final tie-breaker is not cosmetic. It means:

- Two n8n executions given identical agent state pick the **same** agent, so
  behaviour is reproducible in tests and in incident review.
- Input ordering from Google Sheets (which is not guaranteed stable) cannot
  change the outcome.
- There is no randomness to explain to a manager asking why routing looked
  unfair on a particular day.

What it does **not** do is prevent double-assignment under concurrency. That
requires the store to serialize the read-decide-write cycle, which Google
Sheets cannot do.

---

## No eligible agent

The conversation is **never dropped**. When nobody qualifies:

```
status            = WAITING_FOR_AGENT
assigned_agent_id = (empty)
unassigned_reason = NO_ELIGIBLE_AGENT | NO_AGENTS_CONFIGURED
```

Two distinct reasons are used because they need different responses:

- `NO_AGENTS_CONFIGURED` — the Agents sheet is empty or unreadable. A
  configuration problem.
- `NO_ELIGIBLE_AGENT` — agents exist but all are inactive, unavailable, or
  full. A staffing problem.

**Workflow 5** re-attempts the queue every 5 minutes, oldest conversation
first, so nobody starves at the back. Within a single retry run, each
assignment is reflected in a local copy of agent load before the next
conversation is considered — otherwise one run would hand the entire backlog to
whichever agent happened to be least loaded at the start.

---

## Concurrency and race conditions

**This is the most important section in this document.**

### The race

Google Sheets offers no atomic compare-and-set. Assignment requires
read → decide → write, and another execution can interleave between the read
and the write:

```
        Execution A                     Execution B
        (customer 1)                    (customer 2)
             │                               │
   t0   READ Agents                          │
        Mohammad: 3 open                     │
             │                          READ Agents          t1
             │                          Mohammad: 3 open
             │                               │
   t2   DECIDE: Mohammad                     │
             │                          DECIDE: Mohammad     t3
             │                               │
   t4   WRITE Mohammad = 4                   │
             │                          WRITE Mohammad = 4   t5
             v                               v

   Result: Mohammad now has TWO new conversations,
           the counter says 4 (should be 5),
           and Sara received nothing.
```

The counter is wrong *and* the distribution is wrong. Both errors persist until
someone corrects the sheet by hand.

This failure is demonstrated explicitly in the test suite
(`assignment — concurrency exposure`), because a race that is only described in
prose tends to be quietly forgotten.

### What Google Sheets genuinely cannot provide

| Property | Available? | Consequence |
|---|---|---|
| Atomic compare-and-set | **No** | The race above is unpreventable at the storage layer |
| Row-level locking | **No** | Two writers can target the same row |
| Transactions | **No** | Conversation write and agent-counter write cannot be one unit |
| Read-after-write consistency | **Not guaranteed** | A read immediately after a write may return stale data |
| Uniqueness constraints | **No** | Duplicate `conversation_id` rows are possible if logic misbehaves |
| Referential integrity | **No** | A message can reference a conversation that does not exist |

Google Sheets is a good MVP **reporting and operational** layer. It is not a
transactional database, and this project does not pretend otherwise.

### Mitigations actually implemented

**1. No serialization — deliberately.**

Workflow 3 used to run with a concurrency limit of 1, on the theory that
executions would queue instead of interleaving. On this deployment, under a
burst of webhooks, the overflow was not queued: it was **dropped**. HTTP 200 had
already gone back to Meta, so no redelivery came, and the message produced no
conversation row, no message row and no log entry. See the warning at the end
of this document.

So there is no limit, on the workflow or globally:

```yaml
- N8N_CONCURRENCY_PRODUCTION_LIMIT=-1   # NOT 1 - see the warning below
```

That reopens the two races the limit was closing. Neither loses data, and both
are repaired rather than prevented:

- **Two executions both create a conversation for the same new customer.**
  Workflow 8 finds two open conversations for the same customer and business
  number on its next sweep — within a minute — and folds the newer into the
  oldest, which keeps `first_message_at`.
- **Two new customers go to the same agent.** Load is counted live from the
  Conversations rows on every assignment, not from a stored counter, so the
  imbalance corrects itself on the very next one.

The one race that did lose data, two rows appended in the same instant
colliding in Google Sheets itself, is closed by appending with `INSERT_ROWS`
when the service account is set in `.env`. It is written up with measurements
in [ARCHITECTURE.md](ARCHITECTURE.md#messages-arriving-at-the-same-instant).

Beyond one n8n instance none of this is enough — at which point you should be on
PostgreSQL.

**2. Fast acknowledgement reduces retry-driven concurrency.**

Workflow 1 acks in under 100 ms, before touching Sheets. Most duplicate
concurrent processing in naive implementations comes from Meta retrying a slow
webhook; removing the slowness removes most of the concurrency.

**3. Deduplication prevents *retry*-driven double assignment.**

A replayed webhook is caught by its dedupe key before reaching assignment. This
handles retries — it does **not** handle two *different* customers arriving
simultaneously, which is what mitigation 1 is for.

**4. Advisory lock — available, honest about being advisory.**

`buildLockClaim()` / `canClaimLock()` in
[`scripts/lib/idempotency.js`](../scripts/lib/idempotency.js) implement a
TTL-bounded advisory lock. It narrows the race window from the whole assignment
pipeline (several seconds of Sheets I/O) down to a single write round-trip
(~200–400 ms), and makes contention *visible* in the audit log.

It is **not a mutex**. Between reading the lock row and writing it, another
execution can interleave. It is included because it is the correct seam for the
PostgreSQL migration — the same call site becomes `SELECT ... FOR UPDATE` — and
because narrowing a window is genuinely better than ignoring it. It is not a
substitute for mitigation 1.

Expired locks are reclaimable so a crashed execution cannot deadlock the queue.

### Summary of guarantees

| Scenario | Protected? | By what |
|---|---|---|
| Meta retries the same webhook | **Yes** | Dedupe key |
| Same customer sends 5 rapid messages | **Yes** | Dedupe + conversation lookup |
| Two customers arrive simultaneously, one n8n instance | **Yes** | Concurrency 1 |
| Two customers arrive simultaneously, multiple n8n instances | **No** | Requires PostgreSQL |
| Someone edits the sheet by hand mid-assignment | **No** | Inherent to a shared spreadsheet |
| Counter drift over time | **Partially** | Recomputable — see below |

### Handing a conversation over

Pick a different name in `assigned_agent_name`. Within a minute workflow 7
writes `assigned_agent_id` to match, so live load counting (which keys on the
id) counts that conversation against the new owner. Before that the two could
disagree indefinitely: the sheet showed one agent, capacity was charged to
another.

## Recovering from counter drift

Because `open_conversations` is a denormalized counter, it can drift. The true
value is always derivable:

```
open_conversations(agent) =
    COUNT(Conversations WHERE assigned_agent_id = agent
                          AND status != 'CLOSED')
```

Any drift is therefore correctable by recomputation rather than guesswork. On
PostgreSQL this becomes a view or a trigger-maintained column and stops drifting
altogether.

---

## Adding Round Robin

`ROUND_ROBIN` is **implemented, not aspirational** — it is a second comparator
behind the same interface, and it is covered by tests.

| | `LEAST_OPEN_CONVERSATIONS` | `ROUND_ROBIN` |
|---|---|---|
| Primary sort | fewest open conversations | oldest `last_assigned_at` |
| Respects capacity | Yes | Yes |
| Respects active/available | Yes | Yes |
| Best when | Workloads vary in length | Workloads are uniform and fairness of *turns* matters |

Select it with:

```bash
ASSIGNMENT_STRATEGY=ROUND_ROBIN
```

An unrecognized strategy falls back to the documented default rather than
failing — a typo in configuration must not stop customer messages being routed.

To add a third strategy: write a comparator, register it in `COMPARATORS`, add
tests. Eligibility, persistence, audit, and the queue retry are all untouched.

---

## Defensive parsing of agent data

The Agents sheet is edited by humans, and every cell arrives as a string.

| Input | Interpreted as | Rationale |
|---|---|---|
| `TRUE`, `true`, `1`, `yes`, `Y`, `نعم` | `true` | The spellings people actually type |
| `FALSE`, `false`, `0`, `no`, `لا` | `false` | |
| `maybe`, `""`, anything else | **`false`** | **Fails closed** — never route to an agent whose availability cannot be positively confirmed |
| `max_open_conversations = "five"` | default (5) | A typo must not produce `NaN` comparisons that silently reorder the queue |
| `open_conversations = ""` | `0` | |
| `open_conversations = 9`, max `5` | at capacity | Over-capacity drift is treated as full, not as negative headroom |
| `max_open_conversations = 0` | cannot take conversations | Explicitly "off" |
| Row with no `agent_id` | excluded, `MALFORMED_RECORD` | **One corrupt row must not break routing for everyone** |

`selectAgent()` never throws. Given `null`, `undefined`, an array of nulls, or
numbers where objects were expected, it returns a decision with a reason.

---

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `ASSIGNMENT_STRATEGY` | `LEAST_OPEN_CONVERSATIONS` | Selection strategy |
| `N8N_CONCURRENCY_PRODUCTION_LIMIT` | `-1` | **Do NOT set to 1** - it serialises by dropping the overflow. See below. |

Per-agent limits live in the Agents sheet (`max_open_conversations`), not in
environment variables, so a manager can change capacity without a redeploy.

---

## Test coverage

`node tests/run-tests.js assignment` — 26 tests covering:

- The specification's Ahmed/Mohammad/Sara example
- Tie-breaking by `last_assigned_at`, by never-assigned, and by `agent_id`
- Determinism across 25 repeated calls and across reversed input order
- Inactive, unavailable, at-capacity, over-capacity, and zero-capacity agents
- All agents ineligible; no agents configured; `null` agent list
- Malformed rows, non-numeric cells, unrecognized boolean spellings
- `ROUND_ROBIN` behaviour and capacity enforcement; unknown strategy fallback
- **Explicit demonstration of the concurrency race**, and proof that the
  algorithm self-corrects once state is fresh

---

### Do not set `N8N_CONCURRENCY_PRODUCTION_LIMIT=1`

Earlier versions of this document recommended it, to serialise assignment
because Google Sheets has no compare-and-set. It does serialise it. It also
**drops** everything over the limit rather than queueing it, and a dropped
webhook is a customer message that is simply gone: HTTP 200 already went back to
Meta, so no redelivery is coming.

Measured on the live deployment: a burst of six webhooks posted together, with
the limit at 1, produced two conversations. With the limit at `-1`, the same
burst produced six successful executions.

A duplicate conversation row — the thing the limit was meant to prevent — is
visible and repairable, and workflow 8 folds duplicates back together on its
next sweep. A dropped message is neither.

