# WhatsApp Support Routing

A WhatsApp customer-support routing and conversation-tracking system built on
the Meta WhatsApp Cloud API, n8n, and Google Sheets.

A customer messages your WhatsApp business number. The system creates or finds
their conversation, assigns the agent with the fewest open conversations,
records every message, and gives managers a filterable Google Sheet showing who
is waiting and for how long.

---

## Status

**Live and verified end to end.** Every row below was executed against the
running deployment, not inspected in the code.

| Area | State |
|---|---|
| Docker + n8n environment | **Live** — n8n 2.38.5 on a VPS, behind nginx and Let's Encrypt |
| Core business logic | **186 unit tests passing** |
| Webhook receiver | **Verified live** — the handshake echoes the challenge; unsigned and wrongly-signed POSTs are refused |
| Inbound message to a sheet row | **Verified live** |
| Automatic assignment | **Verified live** — the eligible agent with the fewest open conversations |
| Agent stickiness | **Verified live** — the agent who owns a conversation keeps it |
| Agent capacity limits | **Verified live** — at capacity, a conversation waits rather than being forced on someone |
| Idempotency on redelivery | **Verified live** — no duplicate conversation or message row |
| Reply from the sheet | **Verified live** — including a real message to a real number |
| Messaging a new number by hand | **Verified live** |
| Archiving | **Verified live** — `ARCHIVED` moves the row within a minute |
| Newest-first ordering | **Verified live** — both Conversations and Messages |
| Dashboard | **Live formulas** over Conversations, Messages, Archive and Agents |
| Coexistence (WhatsApp Business App echoes) | **Built and unit-tested**; needs Coexistence enabled on the number |

Reproduce all of it:

```
node scripts/testing/verify-live.js
node scripts/testing/verify-live.js --real-send=9627XXXXXXXX   # sends for real
```

See [docs/TESTING.md](docs/TESTING.md) for what each check proves, and
[CHANGELOG.md](CHANGELOG.md) for what was built when.

---

## Quick start

```bash
# 1. Configure
cp .env.example .env
#    Then fill in .env — see docs/ENVIRONMENT.md for every variable.
#    At minimum you need N8N_ENCRYPTION_KEY and WEBHOOK_VERIFY_TOKEN.

# 2. Start n8n
docker compose up -d

# 3. Verify it is healthy
curl http://localhost:5678/healthz        # -> {"status":"ok"}

# 4. Build and import the workflows
node scripts/setup/build-workflows.js
node scripts/setup/import-workflows.js

# 5. Run the tests
node tests/run-tests.js                   # 186 unit tests, no credentials needed
node scripts/validation/validate-workflows.js
```

Then open <http://localhost:5678>, create the two credentials, and publish the
workflows — full walkthrough in **[docs/SETUP.md](docs/SETUP.md)**.

---

## How it works

```
WhatsApp customer
      |
      v
Meta WhatsApp Cloud API
      |
      |  POST (HMAC-signed)
      v
[1] Webhook Receiver ───── verifies signature, acks 200 in <100ms
      |
      v
[2] Message Processor ──── parses, deduplicates, routes by event kind
      |
      v
[3] Conversation & Assignment ── finds/creates conversation,
      |                          picks least-loaded agent
      v
Google Sheets  (Agents · Conversations · Messages · Events)
      ^
      |
[4] Outgoing Agent Message ── the ONLY supported reply path
[5] Unassigned Queue Retry ── re-tries conversations nobody could take
[6] Error Handler ─────────── records failures, redacts secrets
[7] Reply From Sheet ──────── type in a cell, customer gets a WhatsApp message
[8] Archive Conversations ─── nightly, keeps the working sheet small
```

<p align="center">
  <img src="docs/images/workflow-canvas.png" alt="The inbound path drawn on the n8n canvas" width="100%">
</p>
<p align="center">
  <sub>
    The inbound path on the n8n canvas — verify, acknowledge, parse, deduplicate,
    resolve the conversation, assign an agent, write the rows.<br>
    Captured from the single-workflow variant that <a href="CHANGELOG.md">0.4.0</a>
    removed, so the <code>Categories</code> node and the <code>whatsapp/mvp</code>
    path in it no longer exist. The shape of the journey is the same; the shipped
    version splits it across workflows 1-3 and is drawn below.
  </sub>
</p>

### What workflow 3 actually does

This is the path a customer's message takes, node by node. It is the workflow
worth understanding — the other seven are short.

```
 Called by workflow 2
          │
          ▼
 Find Existing Conversation ──── read Conversations, filtered to this number
          │
          ▼
 Decide Create Or Update ─────── same customer, same business number?
          │                      → update it.  otherwise → create it.
          ▼
 Needs Assignment? ───────────── does it already have an owner?
     │           │
   false        true
     │           │
     │           ▼
     │   Read All Conversations ─ count each agent's REAL open load
     │           │                (the stored counter only ever grows)
     │           ▼
     │      Read Agents ───────── active, available, under capacity
     │           │
     │           ▼
     │      Select Agent ──────── fewest open conversations wins;
     │           │                ties go to whoever waited longest
     │           ├──────────────► Increment Agent Load
     │           │
     ▼           ▼
 Build Conversation Row ──────── one object, write_row, holding exactly
          │                      what should end up in the sheet
          ▼
 Create Or Update Row? ───┬───► Append Conversation   (new customer)
                          └───► Update Conversation   (existing row)
                                        │
                                        ▼
                                 Append Message ────── the message itself,
                                        │              never overwritten
                                        ▼
                                 Audit Assignment ──── who got it and why
                                        │
                                        ▼
                        Sign → Get Token → Sort Newest First
                                 keeps the newest at the top of both tabs
```

Full detail: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Two things to understand before using this

**1. Google Sheets is not a transactional database.**
It has no atomic compare-and-set, so two conversations arriving in the same
instant can both be assigned to the same agent. Workflow 3 mitigates this by
serializing assignment (`concurrency: 1`), which removes the race on a single
n8n instance — it does not make Sheets transactional. Workflow 0 sidesteps it
instead, by counting open conversations from the rows rather than maintaining a
counter, so there is no shared value to corrupt. The honest analysis is in
[docs/ASSIGNMENT_ALGORITHM.md](docs/ASSIGNMENT_ALGORITHM.md), and the migration
path is in [docs/GOOGLE_SHEETS_TO_POSTGRES.md](docs/GOOGLE_SHEETS_TO_POSTGRES.md).

**2. Replies must come from the business number, not a personal account.**
Meta only emits webhooks for messages involving your WABA number. With
**Coexistence** enabled, replies typed in the WhatsApp Business App *are*
mirrored to the webhook and tracked — see
[docs/COEXISTENCE.md](docs/COEXISTENCE.md). Without it, only replies sent
through the API or the sheet are visible. Either way, an agent replying from
their **personal** WhatsApp is invisible to the system.

---

## Running costs

For an inbound support desk where agents reply within 24 hours, **Meta charges
nothing for the messages** — service messages have been free since 1 Nov 2024.
Realistic total is **$7–12/month** (a small VPS plus a domain).

The costs that surprise people are the VPS renewal jump and the fact that
replying *after* 24 hours requires a paid template message. Full breakdown:
[docs/DEPLOYMENT_HOSTINGER.md](docs/DEPLOYMENT_HOSTINGER.md#costs).

---

## Repository layout

```
├── docker-compose.yml          n8n stack (pinned to 2.38.5)
├── .env.example                every variable, documented, no real values
├── CHANGELOG.md                what was actually built and verified
│
├── docs/                       see the index below
│
├── n8n/
│   ├── workflows/              GENERATED — do not hand-edit
│   │   01-08…                  the eight workflows, in order
│   └── fixtures/               10 real-shape Meta webhook payloads
│
├── scripts/
│   ├── lib/                    canonical business logic (unit-tested)
│   ├── setup/                  build workflows, apply the sheet layout,
│   │                           build the dashboard, import + publish
│   ├── validation/             workflow, config and schema validators
│   └── testing/                fixture sender, live end-to-end verification
│
├── sheets-templates/           CSV headers + an optional in-sheet menu
└── tests/                      186 tests, zero npm dependencies
```

**`scripts/lib/` is the single source of truth for business logic.** n8n Code
nodes cannot import host files, so `scripts/setup/build-workflows.js` inlines
these exact files into the workflow JSON. Never edit logic inside n8n — edit
`scripts/lib/`, re-run the build, and re-import. This is what keeps the tested
code and the running code identical.

---

## Documentation

| Document | What it covers |
|---|---|
| [CLIENT_ONBOARDING.md](docs/CLIENT_ONBOARDING.md) | **Deploying this for a client** — what to ask them for, what it costs, whether it has to be a VPS |
| [OPERATING_GUIDE.md](docs/OPERATING_GUIDE.md) | **Start here for daily use** — the three reply paths, filtering, speed, archiving |
| [COEXISTENCE.md](docs/COEXISTENCE.md) | Making WhatsApp Business App replies visible to the system |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, state machine, phone normalization |
| [SETUP.md](docs/SETUP.md) | Step-by-step local setup, credentials, tunnels |
| [ENVIRONMENT.md](docs/ENVIRONMENT.md) | Every environment variable and where it is read |
| [META_WHATSAPP_SETUP.md](docs/META_WHATSAPP_SETUP.md) | Meta app, WABA, phone number, tokens, webhook config |
| [N8N_WORKFLOWS.md](docs/N8N_WORKFLOWS.md) | Each workflow: inputs, outputs, errors, idempotency |
| [GOOGLE_SHEETS_SCHEMA.md](docs/GOOGLE_SHEETS_SCHEMA.md) | All six tabs, every column, and how to reply and archive from the sheet |
| [ASSIGNMENT_ALGORITHM.md](docs/ASSIGNMENT_ALGORITHM.md) | Selection rules, tie-breaking, and the concurrency limits |
| [SECURITY.md](docs/SECURITY.md) | Secret handling, signature verification, least privilege |
| [ERROR_HANDLING.md](docs/ERROR_HANDLING.md) | Every failure mode and what the system does about it |
| [TESTING.md](docs/TESTING.md) | The three test levels and the 25 required scenarios |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptoms, causes, fixes |
| [GOOGLE_SHEETS_TO_POSTGRES.md](docs/GOOGLE_SHEETS_TO_POSTGRES.md) | Exactly what changes when moving to Postgres |
| [FUTURE_AGENT_INBOX.md](docs/FUTURE_AGENT_INBOX.md) | The web inbox this is designed to grow into |
| [FUTURE_AI.md](docs/FUTURE_AI.md) | Where an AI layer plugs in, and where it must not |
| [DEPLOYMENT_HOSTINGER.md](docs/DEPLOYMENT_HOSTINGER.md) | VPS deployment, TLS, firewall, backups, costs |
| [KUBERNETES_MIGRATION.md](docs/KUBERNETES_MIGRATION.md) | If and when Compose stops being enough |
| [DECISIONS.md](docs/DECISIONS.md) | Why each significant choice was made |

---

## Security

`.env` is git-ignored and contains every secret. `.env.example` contains only
placeholders. Workflow JSON is scanned for hard-coded credentials by
`scripts/validation/validate-workflows.js`, and all log output passes through a
redactor that masks tokens, keys, and signatures.

Never commit `.env`. Full policy: [docs/SECURITY.md](docs/SECURITY.md).
