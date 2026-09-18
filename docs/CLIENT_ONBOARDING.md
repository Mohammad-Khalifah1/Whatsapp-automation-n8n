# Deploying this system for a client

What you have to ask the client for, what it costs to run, and where the costs
can change later. Every figure here was checked against the vendor's own
documentation in September 2026; where a number depends on the client's country
or traffic, this says so rather than inventing a figure.

Sources are listed at the end.

---

## 1. What you need from the client

Nothing here is optional. The system cannot run without all of it.

### 1.1 A phone number for the business

| Requirement | Detail |
|---|---|
| The number | One phone number that will be the business's WhatsApp line. It must be able to receive an SMS or a voice call once, for verification. |
| Its current state | It must **not** be in use on a personal WhatsApp account, unless you migrate it (below). A number already registered on WhatsApp Business App can be kept through Coexistence. |
| After registration | The number stops working in the normal WhatsApp app. It is then an API number. This is irreversible in practice — plan it. |

**If the client wants to keep an existing WhatsApp number and its chat history**,
use Coexistence: the WhatsApp Business App and the Cloud API share the number,
replies sent from the phone are mirrored to the webhook, and history is
preserved. This system already handles those mirrored messages — see
[COEXISTENCE.md](COEXISTENCE.md).

### 1.2 A Meta account and app

| What | Where the client gets it | What you need from it |
|---|---|---|
| Meta Business account | business.facebook.com | Admin access for whoever will manage the number |
| WhatsApp Business Account (WABA) | Created during WhatsApp setup | `META_WABA_ID` |
| A Meta app (type: Business) | developers.facebook.com | `META_APP_SECRET` |
| The registered number | WhatsApp → API Setup | `META_PHONE_NUMBER_ID` |
| A System User access token | Business Settings → System Users | `META_ACCESS_TOKEN` |

**Permissions the token must carry** — both, or the system half-works:

- `whatsapp_business_messaging` — sending messages
- `whatsapp_business_management` — reading the account and its webhooks

**Token lifetime.** A token generated from the Graph API Explorer or the app
dashboard is temporary (often ~1 hour). Only a **System User** token can be
issued as long-lived: 60 days, or "never expires" if the client chooses that
option when generating it. If it is a 60-day token, it must be regenerated
before it lapses, or every outbound message stops. Put a calendar reminder on
the expiry date — there is no warning from Meta.

**Two subscriptions, not one.** Both are required and they are set in different
places:

1. The app must subscribe to the `messages` webhook field, with your callback
   URL and verify token.
2. The **WABA** must be subscribed to the app (`subscribed_apps`).

Doing only the first is the single most common reason a correctly-built system
receives nothing. It was the cause of a full day of silence during this build.

### 1.3 A Google account

| What | Where | What you need from it |
|---|---|---|
| A Google Cloud project | console.cloud.google.com | — |
| Google Sheets API, enabled | APIs & Services → Library | — |
| A service account + JSON key | IAM → Service Accounts | The JSON key file |
| The spreadsheet | Google Sheets | `GOOGLE_SHEET_ID` (from the URL) |

Then **share the spreadsheet with the service account's email address as an
Editor**. It is an ordinary share. Skipping it produces a permission error on
every write, which is easy to misread as a credential problem.

### 1.4 Somewhere to run it

A host with a **public HTTPS URL that is always reachable**. See section 3 for
what does and does not qualify.

### 1.5 A checklist you can send the client

> - A phone number for the business line, that can receive one SMS.
> - Admin access to your Meta Business account (or we create one).
> - A Google account that will own the spreadsheet.
> - A decision: keep an existing WhatsApp number (Coexistence), or start a new one.
> - A payment method on the Meta account, only if you will ever send marketing
>   or reminder templates. Replies to customers do not need one.

---

## 2. What it costs to run

### 2.1 n8n

**$0.** Self-hosted Community Edition is free, with no execution, workflow or
user limits, under the Sustainable Use License.

What that licence does **not** allow: reselling n8n itself as a hosted service
to your own customers. Running it to operate your own business, or building and
operating a system for one client, is fine. Offering "n8n as a service" is not,
without a separate agreement with n8n.

There is no point at which this system outgrows the free edition. The paid
editions add SSO, RBAC, environments and audit logs — none of which this system
uses.

### 2.2 The server

This deployment runs on a Hostinger VPS the client already pays for. As a line
item, an adequate VPS is **$5–8 / month**: the whole system is one Docker
container with SQLite, and n8n's own guidance for a small self-hosted instance is
around 2 vCPU / 4 GB. It shares the machine with other projects here without
interfering with them.

Domain: **$0** as deployed. It uses `sslip.io`, which resolves an IP-derived
hostname with no registration, and a free Let's Encrypt certificate. A real
domain is $10–15/year if the client wants one, and changes nothing technically.

### 2.3 Meta / WhatsApp

This is where people expect a bill and mostly do not get one, **for this system
as built**.

| Message type | Cost |
|---|---|
| A customer messages you | Free |
| You reply within 24 hours of their last message | **Free** |
| Service conversations generally | **Free and unlimited** since 1 Nov 2024 |
| A template you send to start a conversation (marketing, utility, authentication) | **Paid**, per message delivered, priced by country and category |

**This system only sends free-form replies.** It does not send templates. So in
normal support use — a customer writes, an agent answers — the Meta cost is
**zero**, with no monthly minimum and no per-seat fee.

Two consequences the client must understand:

1. **The 24-hour window is a hard rule, not a guideline.** Outside it, a
   free-form message is rejected by Meta (error 131047). Typing into `reply_text`
   for a customer who last wrote 30 hours ago will come back `FAILED` with that
   reason recorded in `reply_error`. This is Meta's restriction, not a bug, and
   no amount of code changes it. Reaching such a customer requires an approved
   template — which is a paid message and a feature this system does not
   currently have.

2. **The old "1,000 free conversations per month" allowance no longer exists.**
   Anything written before mid-2025 that mentions it is out of date. It was
   replaced by per-message pricing, in which service messages are free.

**When a bill would start.** The moment the client wants to *initiate* contact:
order updates, appointment reminders, promotions, re-engaging a customer after
24 hours. Those are templates, they must be approved by Meta, and they are
charged per delivered message at Meta's published rate for the recipient's
country. Rates differ per country and Meta revises them; quote from the current
rate card rather than from any blog, including this one.

### 2.4 Google

**$0** for this system's usage.

Standard use of the Sheets API is free. The limits that matter:

| Limit | Value |
|---|---|
| Read requests | 300 / minute / project, and **60 / minute / user** |
| Write requests | 300 / minute / project, 60 / minute / user |
| Daily requests | Unlimited |

The service account is a single "user", so **60 reads per minute is the real
ceiling** for this deployment. In practice that is what caps throughput long
before anything else does — see [ARCHITECTURE.md](ARCHITECTURE.md) for the
throughput analysis and the migration path to PostgreSQL when the client
outgrows it.

Exceeding the quota does not produce a charge today; it produces `429 Too many
requests`. Google has said that exceeding quota is planned to become billable
through Google Cloud later in 2026. It does not change the cost of this
deployment, which sits far below the quota, but it is worth knowing before
scaling reads aggressively.

A Google Workspace subscription is **not** required. A free Gmail account can
own the spreadsheet and the Cloud project.

### 2.5 Honest total

**[COSTS.md](COSTS.md) is the authoritative figure.** It is re-derived from each
vendor's own page and re-checked; this table is the summary.

| Item | Monthly |
|---|---|
| n8n | $0 |
| Google Sheets | $0 |
| TLS, monitoring, backups, Telegram alerts | $0 |
| WhatsApp, support replies inside 24 h | $0 *(today — see below)* |
| VPS (Hetzner CX23) | $7.09 |
| Domain (Porkbun `.com`, $11.08/yr) | $0.92 |
| Subtotal | $8.01 |
| **+ Jordanian tax (×1.2889)** | **$10.32 / month** |

At around 300 conversations a day the box moves up to a CX33 and the total
becomes **$14.84**. Volume barely moves it; the box size is the only thing that
changes.

**Two things this table cannot settle, and a client should hear both:**

**Jordanian tax.** 16% general sales tax on imported services is self-assessed
by the recipient, and a further 10% is withheld on payments to non-residents —
a ×1.2889 gross multiplier. The statute is quoted in [COSTS.md](COSTS.md#jordanian-tax).
Whether a small business actually operates withholding on an $8 card payment is
a question for an accountant. Without it the total is **$9.29**.

**Meta's 1 October 2026 change.** Meta has confirmed, verbatim, that it *"will
charge on a per-message basis for service messages"* from that date — the
replies this system sends. **The rate is not published.** If it lands at the
current utility rate of $0.0091, a desk answering 100 conversations a day would
add roughly $74/month. Quote message fees to a client as a **pass-through at
cost**, never inside a fixed monthly price: Meta offers no volume discount on
service messages and may change the rate card on a month's notice.

Plus one-off setup time, and the ongoing cost of **remembering to renew the Meta
token** if it is a 60-day one.

---

## 3. Does it have to be a VPS?

It has to be **something that is always on and reachable over HTTPS**. That is
not a preference; it follows from two hard requirements:

1. **Meta posts webhooks to you.** If your URL does not answer promptly, Meta
   retries for a while and then gives up. Messages are lost, not queued.
2. **Three of the eight workflows are scheduled** — send the reply typed into
   the sheet, retry the unassigned queue, archive old conversations. A host that
   sleeps does not run schedules. A sleeping host means a reply typed into the
   sheet simply never goes out.

Docker is not the constraint. The whole deployment is one `docker-compose.yml`
and it will run anywhere Docker runs. "Always on" is the constraint.

### What actually qualifies, checked in September 2026

| Option | Verdict |
|---|---|
| **Any small VPS** (Hostinger, Contabo, Hetzner, DigitalOcean) | **Works.** $4–8/month. What this deployment uses. |
| **Oracle Cloud Always Free** | **Genuinely free and always-on**, no expiry. Caveats: the Ampere ARM allocation was halved in 2026 to 2 OCPU / 12 GB, and many regions report "out of capacity" when you try to create the instance. If you can get one, it is a real free option. |
| **Render free tier** | **Not suitable.** Free web services spin down after 15 minutes idle and take 30–60 seconds to wake. A webhook can be missed and scheduled workflows do not run while asleep. Render's paid tier removes the spin-down. |
| **Railway** | No free tier since 2023. A one-off $5 trial credit, then $5/month. |
| **Fly.io** | No free tier in 2026. Trial only, then roughly $2–5/month for an always-on machine. Scale-to-zero is available but reintroduces cold starts. |
| **n8n Cloud** | Works, and removes the server entirely. Paid, and priced per execution — which for a webhook-driven system with three per-minute schedules is the expensive shape. |

**The short answer for a client:** the cheapest reliable option is a $5 VPS. The
cheapest free option is Oracle Always Free, if capacity is available in their
region. "Free hosting that sleeps" is not an option for this system, and
promising it to a client will produce lost messages.

---

## 4. Every tool and account this uses

Nothing else. There is no hidden service and no paid dependency.

| What | Where | Cost | What it does here |
|---|---|---|---|
| **WhatsApp Cloud API** | developers.facebook.com | $0 for support replies | Receives customer messages, sends replies |
| **Meta Business Suite** | business.facebook.com | $0 | Owns the WhatsApp account, issues the token |
| **n8n**, self-hosted | docs.n8n.io | $0 | Runs the eight workflows |
| **Docker + Docker Compose** | docker.com | $0 | One container, one file, one volume |
| **Google Sheets** | sheets.google.com | $0 | The database and the user interface |
| **Google Cloud** | console.cloud.google.com | $0 | Only to enable the Sheets API and hold the service account |
| **A VPS** | any provider | $5–8 / month | Somewhere always-on for the container |
| **nginx** | nginx.org | $0 | HTTPS in front of n8n |
| **Let's Encrypt** | letsencrypt.org | $0 | The certificate, renewed automatically |
| **sslip.io** | sslip.io | $0 | A hostname without registering a domain |
| **Node.js** | nodejs.org | $0 | Runs the build, validation and verification scripts |

The repository itself has **no npm dependencies**. `node tests/run-tests.js`
works on a clean machine with nothing installed but Node.

---

## 5. Installing it for a different business

The system is not tied to this client. Everything that identifies one is an
environment variable or a row in a spreadsheet.

**What changes:** `.env` and the spreadsheet.

```
1. Create the Meta app, WABA and phone number for the new business
   -> META_APP_SECRET, META_WABA_ID, META_PHONE_NUMBER_ID, META_ACCESS_TOKEN

2. Create a spreadsheet, share it with the service account as Editor
   -> GOOGLE_SHEET_ID

3. Copy .env.example to .env and fill it in
   node scripts/validation/check-env.js        # says what is missing

4. Build the sheet
   node scripts/setup/apply-sheet-layout.js    # tabs, columns, dropdowns, colours
   node scripts/setup/build-dashboard.js       # after you add the agents

5. Deploy
   node scripts/setup/build-workflows.js
   node scripts/setup/import-workflows.js      # imports AND publishes all eight
   docker compose restart

6. Point Meta's webhook at https://<host>/webhook/whatsapp/webhook
   and subscribe the WABA to the app - both, not just the first

7. Prove it
   node scripts/testing/verify-live.js --real-send=<a number you control>
```

**What does not change:** no code. Not the workflows, not the business logic,
not the sheet schema. Adding, removing or rate-limiting an agent is a row in the
`Agents` tab, not a deployment.

**One VPS can host several businesses.** Each gets its own directory, its own
`.env`, its own container name, its own webhook path and its own port, exactly
the way this deployment sits in `/opt/n8n-1` alongside unrelated projects
without touching them. The cost of the second business is the spreadsheet and
the Meta account, both $0 — the server is already paid for.

---

## 6. What is not included, and what it would take

| Ask | Reality |
|---|---|
| "Send customers a reminder / promotion" | Needs Meta-approved templates. Paid per message. Not built. |
| "Reply to someone who wrote 3 days ago" | Impossible without a template. Meta's rule. |
| "Two agents editing at the same second" | Google Sheets has no atomic compare-and-set. Serialising was tried and dropped messages under load, so a duplicate conversation is repaired within a minute instead. Documented in [ASSIGNMENT_ALGORITHM.md](ASSIGNMENT_ALGORITHM.md). |
| "Thousands of messages a minute" | The 60 reads/minute Sheets quota is the ceiling. The PostgreSQL migration path is written up in [GOOGLE_SHEETS_TO_POSTGRES.md](GOOGLE_SHEETS_TO_POSTGRES.md). |
| "Let an AI answer" | Deliberately out of scope. Design notes in [FUTURE_AI.md](FUTURE_AI.md). |

---

## Sources

- [Pricing on the WhatsApp Business Platform — Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- [Usage limits — Google Sheets API](https://developers.google.com/workspace/sheets/api/limits)
- [Compare editions — n8n Docs](https://docs.n8n.io/deploy/host-n8n/community-edition-features)
- [Always Free Resources — Oracle Cloud](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Oracle Cloud free tier 2026 allocation change — TerminalBytes](https://terminalbytes.com/oracle-cloud-free-tier-changes-2026/)
- [Platforms with a real free tier for developers in 2026 — Render](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026)
- [Railway vs Render vs Fly.io pricing, 2026 — ExpressTech](https://expresstech.io/render-vs-railway-vs-fly-io-2026-pricing-showdown/)
