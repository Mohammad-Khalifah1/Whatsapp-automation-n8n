# Future: Agent Inbox

**Not built.** This documents the design the current system is shaped for, and
the specific reason it will eventually be needed.

---

## Why this is necessary, not just nice

The MVP gives agents a Google Sheet plus a `wa.me` link. That works, but it has
one structural flaw that cannot be fixed by improving the spreadsheet:

**Replies sent from the WhatsApp app are invisible to the system.**

Meta only emits webhooks for messages sent through the Cloud API. When an agent
clicks the `wa.me` link and replies from their phone:

- the customer gets an answer
- `last_agent_message_at` stays empty
- the conversation stays `UNANSWERED` forever
- response-time reporting is meaningless
- `open_conversations` never decreases, so the agent looks permanently loaded

No amount of spreadsheet work fixes this. The only fix is to make replying go
through the Cloud API — which means giving agents an interface that does that.

---

## What already exists

The reply API is **already built and working**: workflow 4 validates a request,
sends via the Cloud API, records the outbound message, updates the conversation,
and reports the result.

```
POST /webhook/agent/send
{
  "to": "962791234567",
  "text": "السعر 25 دينار",
  "conversation_id": "CONV-...",
  "agent_id": "A2",
  "reply_to_message_id": "wamid..."   // optional
}
→ { "ok": true, "message_id": "wamid...", "status": "SENT" }
```

So the inbox is **a user interface over an endpoint that already exists**, plus
a read API. The WhatsApp integration core does not change at all.

---

## Target architecture

```
Browser (agent)
   │
   v
Auth (session / JWT)
   │
   v
Web Inbox (React or similar)
   │  REST + WebSocket
   v
Backend API  ──────────────► PostgreSQL
   │                          (see GOOGLE_SHEETS_TO_POSTGRES.md)
   └──► POST /webhook/agent/send ──► n8n workflow 4 ──► Meta Cloud API
```

### One decision worth making early

Should the inbox call n8n's workflow 4, or call Meta directly?

**Call workflow 4.** It already handles validation, strict phone normalization,
retries, status interpretation, and persistence. Duplicating that in the backend
creates two code paths that will diverge — and the one that diverges will be the
one that sends a message to the wrong person.

Later, if n8n is removed from the send path entirely, port workflow 4's logic
wholesale rather than rewriting it.

---

## Prerequisite: PostgreSQL

A web app cannot run on Google Sheets. Every screen needs indexed queries
(`WHERE assigned_agent_id = ? AND status != 'CLOSED' ORDER BY last_activity_at`),
and 60 reads/minute would be consumed by a handful of agents refreshing.

Migrate first: [GOOGLE_SHEETS_TO_POSTGRES.md](GOOGLE_SHEETS_TO_POSTGRES.md).

---

## Feature scope

### Phase 1 — replaces the spreadsheet

| Feature | Why first |
|---|---|
| Agent login | Identity is required for attribution |
| Conversation list, filtered to the agent | The core view |
| Open a conversation, see full history | Currently impossible — agents only see `last_message` |
| **Send a reply** | **The whole point — makes replies trackable** |
| Unread indicator | |
| Close / reopen | Currently manual spreadsheet editing |

Phase 1 alone eliminates the invisible-reply problem.

### Phase 2 — supervision

| Feature | Notes |
|---|---|
| Supervisor view of all conversations | Replaces the manager's sheet |
| Manual assignment / reassignment | Currently requires editing cells |
| Search by phone, name, text | |
| Filters: status, agent, date | |
| Internal notes | Not sent to the customer |
| Agent availability toggle | Replaces editing `available` |

### Phase 3 — quality

| Feature | Notes |
|---|---|
| Attachments (send and receive media) | Media ids are already captured |
| Canned responses | |
| SLA timers and breach alerts | Needs real response-time data — which only exists once replies are tracked |
| Analytics: response time, volume, per-agent | Same dependency |
| Read receipts surfaced to agents | Status data is already collected |

Note the ordering dependency: **SLA and analytics are worthless until replies go
through the API.** That is another reason Phase 1 must come first.

---

## Data model additions

The existing tables are largely sufficient. What is missing is authentication
and internal notes:

```sql
CREATE TABLE agent_users (
    agent_id      TEXT PRIMARY KEY REFERENCES agents(agent_id),
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,          -- argon2id or bcrypt
    role          TEXT NOT NULL DEFAULT 'agent',  -- agent | supervisor | admin
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversation_notes (
    note_id         BIGSERIAL PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
    agent_id        TEXT NOT NULL REFERENCES agents(agent_id),
    note            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Separating `agent_users` from `agents` keeps routing configuration independent
of authentication — an agent can exist for routing before they have a login, and
disabling a login should not silently change routing behaviour.

---

## API sketch

```
POST   /api/auth/login
POST   /api/auth/logout

GET    /api/conversations?status=UNANSWERED&agent_id=me&page=1
GET    /api/conversations/:id
GET    /api/conversations/:id/messages
POST   /api/conversations/:id/messages      → proxies to workflow 4
PATCH  /api/conversations/:id               → close, reopen, reassign
POST   /api/conversations/:id/notes

GET    /api/agents/me
PATCH  /api/agents/me                       → availability toggle

WS     /api/stream                          → new message / status events
```

### Live updates

Polling every few seconds does not scale past a handful of agents. Options, in
order of preference:

1. **Postgres `LISTEN`/`NOTIFY`** — a trigger notifies on insert; the backend
   pushes over WebSocket. No extra infrastructure.
2. **Redis pub/sub** — if you already run Redis.
3. **Polling** — acceptable only for a first prototype.

---

## Authorization rules

| Role | Can see | Can do |
|---|---|---|
| `agent` | Their own conversations | Reply, close, reopen, add notes |
| `supervisor` | All conversations | Everything an agent can, plus reassign |
| `admin` | Everything | Plus manage agents and settings |

Enforce on the **server**, per request. A UI that hides a button is not access
control.

---

## Security additions

The MVP's threat model assumes only trusted operators reach n8n. An inbox
changes that — it puts a login form on the public internet.

| Control | Why |
|---|---|
| Argon2id or bcrypt password hashing | Never store recoverable passwords |
| Rate limiting on login | Credential stuffing |
| Short-lived sessions with refresh | Limits stolen-token lifetime |
| CSRF protection | Cookie-based sessions |
| Server-side authorization on every request | See above |
| Audit log of agent actions | Who closed what, who replied |
| MFA for supervisors and admins | They can see every customer conversation |

Also revisit `/webhook/agent/send`. In the MVP it is restricted at the reverse
proxy; once a backend calls it, it should be reachable only from that backend —
not from the internet at all.

---

## Suggested build order

1. **Migrate to PostgreSQL** — everything depends on it
2. **Read-only inbox** — list and view conversations; prove the data model
3. **Authentication** — login, sessions, roles
4. **Replying** — the payoff; the invisible-reply problem disappears
5. **Close / reopen / reassign** — retire spreadsheet editing
6. **Live updates** — WebSocket
7. **Supervisor views**
8. **Attachments, SLA, analytics**

Steps 1–4 deliver essentially all of the value. Everything after is refinement.

---

## What this does not change

Worth stating explicitly, because it is the payoff for how the MVP was built:

- Webhook receiving, signature verification, parsing — unchanged
- Conversation state machine — unchanged
- Assignment algorithm — unchanged
- Phone normalization — unchanged
- Idempotency — unchanged
- All 503 unit tests — still valid

The inbox is an additional consumer of the same core, not a replacement for it.
