# Migrating from Google Sheets to PostgreSQL

What changes, what does not, and when to do it.

---

## When to migrate

Migrate when **any** of these is true:

| Trigger | Why it matters |
|---|---|
| **Sustained load above ~10 messages/minute** | 60 reads/min/user is the ceiling; each message costs several reads |
| **More than one n8n instance** | Concurrency-1 serialization stops working; the assignment race returns |
| **Assignment correctness becomes critical** | Sheets cannot make read-decide-write atomic |
| **More than ~50,000 conversations** | Lookups scan the sheet; performance degrades |
| **An agent inbox is being built** | A web app needs indexed queries, not spreadsheet scans |
| **Audit integrity is required** | Anyone with edit access can silently alter history |

Do **not** migrate merely because Postgres feels more professional. Google
Sheets gives managers a filterable view for free, and that is genuinely valuable
while the routing model is still being validated.

---

## What does not change

This is the point of the architecture.

| Unchanged | Why |
|---|---|
| `scripts/lib/*.js` — all decision logic | It performs no I/O. It takes data and returns decisions |
| All 162 unit tests | They test pure functions |
| Conversation state machine | Storage-independent |
| Assignment algorithm and tie-breakers | Storage-independent |
| Phone normalization | Storage-independent |
| Idempotency keys and status ladder | Storage-independent |
| Webhook parsing and signature verification | Nothing to do with the store |
| Workflows 1 and 6 | No Sheets nodes |
| Column names | The schema below reuses them exactly |

**Only the persistence nodes change**: Google Sheets nodes become Postgres
nodes. Roughly 12 nodes across workflows 2–5.

---

## Schema

Column names are identical to the sheets, so field mapping in the workflows does
not change.

```sql
CREATE TYPE conversation_status AS ENUM (
    'WAITING_FOR_AGENT', 'UNANSWERED', 'REPLIED',
    'WAITING_FOR_CUSTOMER', 'CLOSED'
);

CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');

CREATE TYPE message_status AS ENUM (
    'RECEIVED', 'PENDING', 'ACCEPTED', 'SENT',
    'DELIVERED', 'READ', 'FAILED'
);

-- ---------------------------------------------------------------- agents
CREATE TABLE agents (
    agent_id               TEXT PRIMARY KEY,
    name                   TEXT NOT NULL,
    phone                  TEXT,
    active                 BOOLEAN NOT NULL DEFAULT TRUE,
    available              BOOLEAN NOT NULL DEFAULT TRUE,
    max_open_conversations INTEGER NOT NULL DEFAULT 5
                           CHECK (max_open_conversations >= 0),
    -- Denormalized for fast selection; kept correct by trigger (below).
    open_conversations     INTEGER NOT NULL DEFAULT 0
                           CHECK (open_conversations >= 0),
    last_assigned_at       TIMESTAMPTZ,
    role                   TEXT,
    working_hours          TEXT,
    timezone               TEXT DEFAULT 'Asia/Amman',
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly the eligibility predicate from the assignment engine.
CREATE INDEX idx_agents_eligible
    ON agents (open_conversations, last_assigned_at, agent_id)
    WHERE active AND available;

-- --------------------------------------------------------- conversations
CREATE TABLE conversations (
    conversation_id          TEXT PRIMARY KEY,
    customer_phone           TEXT NOT NULL,
    customer_name            TEXT,
    business_phone_number_id TEXT NOT NULL,
    assigned_agent_id        TEXT REFERENCES agents(agent_id),
    assigned_agent_name      TEXT,
    status                   conversation_status NOT NULL
                             DEFAULT 'WAITING_FOR_AGENT',
    last_message             TEXT,
    last_message_id          TEXT,
    last_message_direction   message_direction,
    last_customer_message_at TIMESTAMPTZ,
    last_agent_message_at    TIMESTAMPTZ,
    last_activity_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    unread                   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at                TIMESTAMPTZ,
    wa_link                  TEXT,
    unassigned_reason        TEXT,

    CONSTRAINT closed_has_timestamp
        CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);

-- THE constraint Sheets cannot express: at most one open conversation per
-- (customer, business number). Makes duplicate conversations impossible
-- rather than merely unlikely.
CREATE UNIQUE INDEX idx_one_open_conversation
    ON conversations (customer_phone, business_phone_number_id)
    WHERE status <> 'CLOSED';

CREATE INDEX idx_conversations_queue
    ON conversations (status, created_at)
    WHERE status = 'WAITING_FOR_AGENT';

CREATE INDEX idx_conversations_agent
    ON conversations (assigned_agent_id, status);

-- -------------------------------------------------------------- messages
CREATE TABLE messages (
    message_id          TEXT PRIMARY KEY,
    -- THE idempotency guarantee: a duplicate insert fails, atomically.
    dedupe_key          TEXT NOT NULL UNIQUE,
    conversation_id     TEXT REFERENCES conversations(conversation_id),
    direction           message_direction NOT NULL,
    sender_phone        TEXT,
    recipient_phone     TEXT,
    message_type        TEXT,
    text                TEXT,
    timestamp           TIMESTAMPTZ,
    status              message_status,
    status_updated_at   TIMESTAMPTZ,
    agent_id            TEXT REFERENCES agents(agent_id),
    supported           BOOLEAN DEFAULT TRUE,
    processing_status   TEXT,
    correlation_id      TEXT,
    raw_event_reference TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, timestamp);
CREATE INDEX idx_messages_correlation  ON messages (correlation_id);

-- ---------------------------------------------------------------- events
CREATE TABLE events (
    event_id        BIGSERIAL PRIMARY KEY,
    correlation_id  TEXT,
    event_type      TEXT NOT NULL,
    conversation_id TEXT,
    message_id      TEXT,
    source          TEXT,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
    status          TEXT,
    error           TEXT,
    -- JSONB, so the audit trail is queryable instead of an opaque string.
    details         JSONB
);

CREATE INDEX idx_events_correlation ON events (correlation_id);
CREATE INDEX idx_events_time        ON events (timestamp DESC);
CREATE INDEX idx_events_details     ON events USING GIN (details);
```

### Keeping the counter honest

On Sheets, `open_conversations` drifts and must be recomputed by hand. In
Postgres a trigger keeps it exact:

```sql
CREATE OR REPLACE FUNCTION sync_agent_open_count() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.assigned_agent_id IS NOT NULL AND NEW.status <> 'CLOSED' THEN
            UPDATE agents SET open_conversations = open_conversations + 1
             WHERE agent_id = NEW.assigned_agent_id;
        END IF;

    ELSIF TG_OP = 'UPDATE' THEN
        -- Left the open set, or moved away from this agent.
        IF OLD.assigned_agent_id IS NOT NULL AND OLD.status <> 'CLOSED'
           AND (NEW.status = 'CLOSED'
                OR NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id)
        THEN
            UPDATE agents SET open_conversations = open_conversations - 1
             WHERE agent_id = OLD.assigned_agent_id;
        END IF;

        -- Entered the open set, or moved to this agent.
        IF NEW.assigned_agent_id IS NOT NULL AND NEW.status <> 'CLOSED'
           AND (OLD.status = 'CLOSED'
                OR NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id)
        THEN
            UPDATE agents SET open_conversations = open_conversations + 1
             WHERE agent_id = NEW.assigned_agent_id;
        END IF;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_agent_open_count
    AFTER INSERT OR UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION sync_agent_open_count();
```

---

## The race condition disappears

This is the main prize.

**Today (Sheets):** read agents → decide → write. Another execution can
interleave between read and write, so two conversations can go to the same
agent. Mitigated only by serializing the whole workflow.

**After (Postgres):** the read-decide-write becomes one transaction, and the
selected agent row is locked:

```sql
BEGIN;

-- The eligibility and ordering rules are IDENTICAL to assignment.js:
--   fewest open, then earliest last_assigned_at (nulls first), then agent_id.
SELECT agent_id, name, open_conversations
  FROM agents
 WHERE active
   AND available
   AND open_conversations < max_open_conversations
 ORDER BY open_conversations ASC,
          last_assigned_at ASC NULLS FIRST,
          agent_id ASC
 LIMIT 1
 FOR UPDATE SKIP LOCKED;      -- concurrent workers get different agents

-- ... insert/update the conversation; the trigger maintains the counter ...

COMMIT;
```

`FOR UPDATE` blocks a second transaction from reading the same row until this
one commits. `SKIP LOCKED` lets a concurrent worker take the *next* eligible
agent instead of waiting — so parallelism increases while correctness holds.

**Result:** concurrency 1 is no longer needed. Multiple n8n instances become
safe.

Note that `ORDER BY` mirrors `compareLeastOpen()` exactly, including
`NULLS FIRST` for never-assigned agents. The decision rules are unchanged; only
their enforcement moves into the database.

Idempotency likewise stops being advisory:

```sql
INSERT INTO messages (message_id, dedupe_key, ...)
VALUES ($1, $2, ...)
ON CONFLICT (dedupe_key) DO NOTHING;
```

A duplicate webhook is rejected by the database itself, with no read-then-check
window at all.

---

## Migration steps

### 1. Add Postgres to the stack

```yaml
  postgres:
    image: postgres:17-alpine
    container_name: postgres-whatsapp
    restart: unless-stopped
    environment:
      - POSTGRES_DB=whatsapp_support
      - POSTGRES_USER=${POSTGRES_USER}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d whatsapp_support"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - n8n_whatsapp_network
    # Deliberately NOT published to the host — only n8n needs to reach it.
```

Add `postgres_data` to `volumes:` and the credentials to `.env` /
`.env.example`.

> Keep n8n's **own** database on SQLite unless you have a reason to move it.
> Migrating n8n's internal store is a separate concern from migrating this
> system's data.

### 2. Create the schema

```bash
docker exec -i postgres-whatsapp psql -U $POSTGRES_USER -d whatsapp_support < scripts/setup/schema.sql
```

### 3. Export existing data

Download each sheet as CSV, then:

```sql
\copy agents        FROM 'Agents.csv'        CSV HEADER;
\copy conversations FROM 'Conversations.csv' CSV HEADER;
\copy messages      FROM 'Messages.csv'      CSV HEADER;
\copy events        FROM 'Events.csv'        CSV HEADER;
```

Expect the unique index on open conversations to reject duplicates that Sheets
allowed. That is the migration surfacing pre-existing corruption — resolve each
one rather than dropping the constraint.

Recompute the counters once after import:

```sql
UPDATE agents a SET open_conversations = (
    SELECT COUNT(*) FROM conversations c
     WHERE c.assigned_agent_id = a.agent_id AND c.status <> 'CLOSED'
);
```

### 4. Swap the nodes

For each Google Sheets node, replace with a Postgres node:

| Sheets operation | Postgres equivalent |
|---|---|
| Lookup by `dedupe_key` | `SELECT ... WHERE dedupe_key = $1` |
| Lookup conversation | `SELECT ... WHERE customer_phone = $1 AND business_phone_number_id = $2 AND status <> 'CLOSED'` |
| Read all agents | The `SELECT ... FOR UPDATE SKIP LOCKED` above |
| Append conversation | `INSERT ... ON CONFLICT DO NOTHING` |
| Update conversation | `UPDATE ... WHERE conversation_id = $1` |
| Append message | `INSERT ... ON CONFLICT (dedupe_key) DO NOTHING` |
| Append event | `INSERT INTO events ...` |

Do this in `scripts/setup/build-workflows.js`, not in the n8n UI — the workflow
JSON is generated.

### 5. Remove the serialization

Once assignment runs inside a transaction with `FOR UPDATE`, set workflow 3's
concurrency back to its default.

### 6. Keep the manager view

Managers lose the spreadsheet. Replace it with one of:

- **A read-only sync** — a scheduled workflow mirroring Postgres into the same
  sheet. Managers keep their filters; the sheet stops being the system of record.
- **Metabase or Grafana** — better filtering, no sync lag.
- **The agent inbox** — see [FUTURE_AGENT_INBOX.md](FUTURE_AGENT_INBOX.md).

Do not skip this step. Removing the manager's view is the change people will
actually notice.

---

## Suggested cutover

1. Run both stores in parallel — write to Postgres *and* Sheets for a week.
2. Compare row counts and spot-check conversations daily.
3. Switch reads to Postgres, keep writing to both.
4. Stop writing to Sheets; keep it as a read-only mirror.
5. Remove the Sheets nodes.

Steps 1–3 are cheap insurance: they let you discover mapping mistakes while the
old store is still authoritative.

---

## What you gain and lose

| Gain | Lose |
|---|---|
| Atomic assignment, no race | Managers' direct spreadsheet editing |
| Real uniqueness constraints | Zero-infrastructure operation |
| Referential integrity | Free hosting |
| Indexed queries at scale | Instant familiarity for non-technical staff |
| Queryable JSONB audit | |
| No quota ceiling | |
| Multiple n8n instances | |
| Point-in-time recovery | |

The honest summary: Sheets is better for *people*, Postgres is better for
*correctness and scale*. Migrate when correctness starts to matter more than
convenience — and give people a replacement view when you do.
