# Future: session-scoped assignment and account ownership

**Not built.** A plan, in the same spirit as
[FUTURE_TASKS_EMPLOYEES_AND_AI_AGENTS.md](FUTURE_TASKS_EMPLOYEES_AND_AI_AGENTS.md)
— written before touching
[scripts/lib/assignment.js](../scripts/lib/assignment.js), which is live,
unit-tested, and currently the one piece of this system a change here can
genuinely break. Two things were asked together:

1. Can an employee be assigned to one WhatsApp session, or several?
2. Can an employee own a whole WhatsApp account alone, own several accounts,
   or share one account with another employee — with conversations from a
   shared account distributed between just the people who share it?

Both are the same underlying change: **assignment eligibility must be able to
depend on which WhatsApp account/session a conversation came from, not just
on load.** Today it cannot — every active, available, under-capacity agent is
eligible for every conversation, regardless of source.

---

## 0. What "account" and "session" mean in this codebase today

Every conversation already carries `business_phone_number_id`
(`Conversations` tab). Its value today:

| Connector | Value | Set by |
|---|---|---|
| Meta Cloud API | The real Meta phone number id, e.g. `1385581811295002` | `scripts/lib/webhook-parser.js` |
| WAHA | `waha:<session>`, e.g. `waha:default` | Workflow 1b's `Adapt To Meta Envelope` node |

This id is **already the natural account/session identifier** — no new
concept needs inventing, just a place to say which agents are eligible for
it.

---

## 1. Data model — one new field, additive

Add `whatsapp_accounts` to the `Agents` tab: a comma-separated list of
`business_phone_number_id` values this agent may receive conversations from.
**Empty = eligible for every account**, exactly today's behaviour. This one
default is what makes the change additive rather than breaking:

| `whatsapp_accounts` value | Meaning |
|---|---|
| *(empty)* | Unrestricted — eligible for any account (today's behaviour, unchanged) |
| `waha:default` | Owns/works that one account exclusively (relative to other agents who also list only that account) |
| `1385581811295002,waha:default` | Responsible for more than one account |
| Two agents both list `waha:default` | They **share** it — `LEAST_OPEN_CONVERSATIONS` already distributes fairly between exactly this eligible subset, no new logic needed for the sharing case itself |

Sharing "equally" is not new code — it is what the existing tie-breaking
in `docs/ASSIGNMENT_ALGORITHM.md` already does, once the eligible set is
correctly narrowed to just the agents linked to that account.

No new tab, no new sheet, no migration. Existing rows get an empty value on
first read (Sheets returns `''` for a missing column), which the eligibility
rule below treats as unrestricted — every current deployment keeps working
exactly as it does today without anyone editing a single row.

---

## 2. The one change to the assignment algorithm

`docs/ASSIGNMENT_ALGORITHM.md` Step 1 (eligibility) gains a fifth condition,
alongside `active`, `available`, `has capacity`, `has an id`:

```
Session-eligible: agent.whatsapp_accounts is empty
                   OR conversation.business_phone_number_id is in agent.whatsapp_accounts
```

Recorded with its own exclusion reason (`WRONG_ACCOUNT`) in the Log sheet,
matching how every other exclusion is already made visible rather than
silent.

**This is the entire logic change.** Ordering (fewest open conversations,
then longest-since-assigned, then lowest `agent_id`) is untouched — it now
just runs over a correctly pre-filtered candidate list instead of everyone.

### Implementation sketch (`scripts/lib/assignment.js`)

```js
function isSessionEligible(agent, conversation) {
  const accounts = String(agent.whatsapp_accounts || '').trim();
  if (accounts === '') return true; // unrestricted — today's behaviour
  const allowed = accounts.split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(String(conversation.business_phone_number_id || ''));
}
```

Added as one more filter in the same eligibility pipeline the existing
`active`/`available`/`has capacity` checks already run through — same shape,
same place, same audit-logging convention.

### No eligible agent — unchanged

If nobody is session-eligible (e.g. a WAHA account nobody has been assigned
to yet), the existing fallback already handles it correctly with no change:
`status = WAITING_FOR_AGENT`, and workflow 5 retries it later, exactly as it
does today for any other no-eligible-agent case.

---

## 3. Employees API changes

Extends workflow 9 ([`09-employees-api.json`](../n8n/workflows/09-employees-api.json)),
additively, the same way the employee-update work in this session already
reads-then-merges rather than overwriting blindly:

- `POST /api/employees` (create) accepts an optional `whatsapp_accounts`
  field — array or comma-string, normalized to a comma-string on write.
- `POST /api/employees/update` adds `whatsapp_accounts` to the `ALLOWED`
  field list already in `Validate Patch` — no other change to that node,
  since it already reads-merges-writes generically over the `ALLOWED` array.
- `GET /api/employees` already returns every column verbatim, so
  `whatsapp_accounts` appears with no change at all.

A validation worth adding at the same time: reject an unknown account id
(one that has never appeared as a `business_phone_number_id` in
`Conversations`) with a warning, not a hard failure — a new WAHA session
legitimately has zero conversations yet, so "unknown" cannot mean "invalid."

### A useful companion endpoint

`GET /api/accounts` — list every distinct `business_phone_number_id` seen in
`Conversations`, plus (for WAHA ones) live status from
`GET /api/sessions` on the WAHA container. This is what a UI needs to
populate an "assign this employee to..." picker with real options instead of
free text. Safe, read-only, new workflow file — does not touch 9 or 10.

---

## 4. What this enables, concretely

| Scenario from the request | How it maps |
|---|---|
| "Assign an employee to one WhatsApp session" | `whatsapp_accounts = "waha:default"` |
| "Assign an employee to several sessions" | `whatsapp_accounts = "waha:default,waha:sales"` |
| "Responsible for a whole account alone" | Only that agent lists the account — `LEAST_OPEN_CONVERSATIONS` has exactly one candidate, so every conversation from it goes to them |
| "Responsible for more than one account, alone" | Multiple accounts listed, no other agent lists any of them |
| "Shares an account with another employee" | Both agents list the same account — the existing fair-distribution algorithm runs over just those two |

Nothing here requires the multi-session WAHA support flagged as untested in
[WAHA_CONNECTOR.md](WAHA_CONNECTOR.md) to be finished first, but it becomes
far more useful once it is — right now there is exactly one WAHA session
(`default`) to assign anyone to. Running two real WAHA sessions side by side
is the natural next verification step once this ships.

---

## 5. Build order and what must be re-verified before trusting it

| Step | Grade | Why |
|---|---|---|
| Add `whatsapp_accounts` column + Employees API field | Safe | Additive column, generic patch logic already handles it |
| Add `GET /api/accounts` | Safe | New, read-only, isolated file |
| Add `isSessionEligible` to `assignment.js` | **Caution** | Touches the one live, unit-tested core algorithm this whole system depends on |
| Re-run `tests/assignment/assignment.test.js` | **Required, not optional** | Must still pass unmodified — the existing tests assert today's unrestricted behaviour, which this change must preserve exactly for empty `whatsapp_accounts` |
| Add new tests: shared account fairness, exclusive ownership, multi-account agent, `WRONG_ACCOUNT` exclusion reason recorded | **Required before merging** | The worked example in `ASSIGNMENT_ALGORITHM.md` needs a session-scoped counterpart proving the same determinism holds |
| Live test: two real WAHA sessions, agents split across them | Caution | Confirms the design against real multi-session behaviour, not just Sheets logic |

**Do not skip the re-run of the existing assignment tests.** They are the
proof that an unrestricted agent (the default for every current row) is
unaffected — the whole safety argument for this being additive rests on that
one regression check passing untouched.

---

## 6. Gap check against the upstream WAHA project

Asked alongside this plan: what does this integration not yet use from
[github.com/devlikeapro/waha](https://github.com/devlikeapro/waha) itself
(7,400+ stars, Apache 2.0, `core` branch, verified 2026-09-18)?

| WAHA capability | Used here? | Note |
|---|---|---|
| **Multi-session** (`POST /api/sessions` with a `name`) | No — one session (`default`) | Directly what this plan is for. WAHA's own quick-start README demonstrates exactly this |
| **Media send/receive** | No | Inbound media arrives as a placeholder; `sendImage`/`sendFile`/`sendVoice`/`sendVideo` unused outbound. Listed in `WAHA_CONNECTOR.md`'s known gaps |
| **`startTyping`/`stopTyping`/`sendSeen` (Presence)** | No | Exactly the anti-detection mitigations in `FUTURE_TASKS_EMPLOYEES_AND_AI_AGENTS.md` §4 |
| **`messageCapping`/`reachoutTimelock`** | No | WhatsApp's own native rate-limit signals, surfaced directly by WAHA — should replace guessed pacing once wired in |
| **`reply_to` (threaded replies)** | No | Supported by `sendText`, not yet sent from workflow 4/7's WAHA branch |
| **Groups** (33 endpoints) | No | A real gap already found this session: a group message's `@g.us` id would be misparsed as a customer phone number by workflow 1b's adapter — needs an explicit guard, not just a missing feature |
| **Channels (newsletters), Labels, Status** | No | Not relevant to a 1:1 support-routing use case; safe to leave unused |
| **Contacts → check-exists** | No | Could validate a phone number before creating a conversation row, catching typos early |
| **Pairing by code** (phone number instead of QR) | No | An alternative to scanning — same linking result, sometimes easier when the phone isn't physically at hand |
| **Built-in "Apps" integrations** (native n8n, Chatwoot, Typebot connectors) | No — a hand-built adapter (workflow 1b) is used instead | Worth a look before extending 1b further: WAHA ships a maintained n8n integration app. This project's adapter exists because it needed the Meta-envelope translation trick to reuse workflows 2/3 unmodified — a decision worth revisiting only if the native app turns out to support the same trick more cheaply, not assumed |
| **MCP server** (`/mcp`) | No | Directly relevant to the AI-agent grounding work in `FUTURE_TASKS_EMPLOYEES_AND_AI_AGENTS.md` §5 — WAHA can expose itself as tools to an AI client natively, which may be a shorter path than a hand-built tool layer for an AI agent that needs to *send* WhatsApp messages, worth evaluating before building one from scratch |
| **`GET /api/screenshot`** | No | A quick visual "is this session actually connected and what does it see" check — cheap to add to `WAHA_CONNECTOR.md`'s troubleshooting steps |
| **Api Keys management endpoints** | No | The key is managed via `WAHA_API_KEY` in `.env` only; fine at this scale, the endpoint exists if key rotation without a restart is ever needed |

None of these are required for what was asked this session. They are listed
because "is anything missing relative to upstream" was asked directly — this
is the honest answer, ranked by what would actually matter next: groups (a
real bug, not just a gap), presence/capping (anti-ban, already planned),
media (a real usability gap), then everything else.
