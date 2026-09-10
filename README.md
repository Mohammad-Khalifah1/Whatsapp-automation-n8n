# WhatsApp Support Routing

A WhatsApp customer-support routing and conversation-tracking system built on
the Meta WhatsApp Cloud API, n8n, and Google Sheets.

A customer messages your WhatsApp business number. The system creates or finds
their conversation, assigns the agent with the fewest open conversations,
records every message, and gives managers a filterable Google Sheet showing who
is waiting and for how long.

---

## Status

| Area | State |
|---|---|
| Docker + n8n environment | **Working, verified** — n8n 2.38.5, healthy, persistent volume |
| Core business logic | **Working, 169 unit tests passing** |
| Webhook receiver (verify + signature + ack) | **Working, verified live with real HTTP calls** |
| n8n workflows (8) | **Built, validated, imported and published** |
| Reply from the sheet (workflow 7) | **Built, NOT yet verified** — needs credentials |
| Nightly archiving (workflow 8) | **Built, NOT yet verified** — needs credentials |
| Business App echo tracking (Coexistence) | **Built and unit-tested**; live behaviour needs Coexistence enabled |
| Google Sheets persistence | **Built, NOT yet verified** — needs a Google service account |
| Outgoing messages via Cloud API | **Built, NOT yet verified** — needs Meta credentials |
| Production deployment | **Documented, not performed** |

Nothing above is marked "working" unless it was actually executed. See
[docs/TESTING.md](docs/TESTING.md) for exactly what was tested and how, and
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
node tests/run-tests.js                   # 169 unit tests, no credentials needed
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

Full detail: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Two things to understand before using this

**1. Google Sheets is not a transactional database.**
It has no atomic compare-and-set, so two conversations arriving in the same
instant can both be assigned to the same agent. The MVP mitigates this by
serializing the assignment workflow (concurrency 1), which removes the race on
a single n8n instance — it does not make Sheets transactional. The honest
analysis is in [docs/ASSIGNMENT_ALGORITHM.md](docs/ASSIGNMENT_ALGORITHM.md),
and the migration path is in
[docs/GOOGLE_SHEETS_TO_POSTGRES.md](docs/GOOGLE_SHEETS_TO_POSTGRES.md).

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
│   └── fixtures/               10 real-shape Meta webhook payloads
│
├── scripts/
│   ├── lib/                    canonical business logic (unit-tested)
│   ├── setup/                  build + import workflows
│   ├── validation/             workflow, config and schema validators
│   └── testing/                fixture sender, live webhook tests
│
├── sheets-templates/           CSV headers + one-click Apps Script setup
└── tests/                      169 tests, zero npm dependencies
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
| [OPERATING_GUIDE.md](docs/OPERATING_GUIDE.md) | **Start here for daily use** — the three reply paths, filtering, speed, archiving |
| [COEXISTENCE.md](docs/COEXISTENCE.md) | Making WhatsApp Business App replies visible to the system |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, state machine, phone normalization |
| [SETUP.md](docs/SETUP.md) | Step-by-step local setup, credentials, tunnels |
| [ENVIRONMENT.md](docs/ENVIRONMENT.md) | Every environment variable and where it is read |
| [META_WHATSAPP_SETUP.md](docs/META_WHATSAPP_SETUP.md) | Meta app, WABA, phone number, tokens, webhook config |
| [N8N_WORKFLOWS.md](docs/N8N_WORKFLOWS.md) | Each workflow: inputs, outputs, errors, idempotency |
| [GOOGLE_SHEETS_SCHEMA.md](docs/GOOGLE_SHEETS_SCHEMA.md) | All four sheets, every column, recommended filters |
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
