# Alternatives and recommendations

Every layer of this system has a cheaper or freer replacement. This document
lists them with verified prices and licences, and says which ones a company
should actually depend on.

Prices only: **[COSTS.md](COSTS.md)**. Verified **2026-09-13**.

- [Automation engine](#automation-engine-replacing-n8n)
- [Datastore](#datastore-replacing-google-sheets)
- [Hosting](#hosting)
- [Domain registrar](#domain-registrar)
- [AI provider](#ai-provider)
- [Notifying the agent](#notifying-the-agent)
- [Monitoring and backup](#monitoring-and-backup)
- [Agent inbox](#agent-inbox)
- [The near-zero stack](#the-near-zero-stack-and-where-it-breaks)
- [Recommendations](#recommendations)

---

## Automation engine (replacing n8n)

| Option | Licence | Free for commercial self-hosting? | Notes |
|---|---|---|---|
| **[Node-RED](https://nodered.org/)** | Apache 2.0 | ✅ **No strings at all** | No paid edition exists. Google Sheets support is community nodes of varying quality |
| **[Activepieces](https://www.activepieces.com/pricing)** | MIT core | ✅ *"unlimited flows and users, with nothing metered"* | Closest drop-in. Excluded from OSS: projects, SSO, audit logs, Git Sync |
| [Kestra](https://kestra.io/pricing) | Apache 2.0 | ✅ Unlimited flows and executions, 2,000+ plugins | YAML, not a canvas. Enterprise is **per instance**, price not published |
| [Huginn](https://github.com/huginn/huginn) | MIT | ✅ | Cleanest licence, worst fit — no Sheets agent |
| ⚠️ [Windmill](https://www.windmill.dev/pricing) | **Not clean AGPL as shipped** | ❌ | Published Docker images *"include proprietary and non-public code"*. Only a self-compiled build without the `enterprise` flag is AGPLv3 |
| [Temporal](https://temporal.io/pricing) | MIT | ✅ | Wrong layer — no connectors, no webhook receiver |
| A plain Node/Express service | — | ✅ | Removes `build-workflows.js` and its validators entirely |

**If the plan is to resell, this table matters more than any price.** Node-RED,
Activepieces, Kestra and Huginn carry **no resale restriction at all**, while
n8n requires an unpriced Enterprise licence for exactly that business model —
see [COSTS.md](COSTS.md#is-n8n-really-free).

---

## Datastore (replacing Google Sheets)

| Option | Free tier | Commercial use | The catch |
|---|---|---|---|
| **Self-hosted PostgreSQL** | Unlimited | ✅ | Backups, upgrades and monitoring become yours. No web UI |
| **[Baserow](https://baserow.io/pricing) self-hosted** | MIT core: *"never have row, storage, or API request limitations"* | ✅ | Keeps a spreadsheet UI over real Postgres. Premium/SSO paid per user |
| [Turso](https://turso.tech/pricing) | 5 GB, 10M writes/month | ✅ | Most generous — but **no "free forever" commitment**, and the tier has been rewritten before |
| [Neon](https://neon.com/pricing) | 0.5 GB, 100 CU-hours | ✅ | Scale-to-zero after 5 min — the first message after a quiet spell pays a cold start. No minimum monthly fee on Launch |
| [Supabase](https://supabase.com/pricing) | 500 MB | ✅ | ❌ *"Free projects are paused after 1 week of inactivity"* — disqualifying for production |
| [Cloudflare D1](https://developers.cloudflare.com/d1/platform/pricing/) | 100,000 row-writes/day | ✅ | Bills **rows touched**, not statements — one unindexed lookup burns the quota |
| ⚠️ [NocoDB](https://nocodb.com/pricing) | "Free Forever" | ❌ | **Sustainable Use License** — the same internal-use-only restriction as n8n |
| ❌ [Airtable](https://airtable.com/pricing) | **1,000 API calls per month** | — | Exhausted in under two days at 30 conversations/day |

⚠️ Google's own limits page states: *"Exceeding the quota request limits is
planned to incur charges to your Google Cloud billing account later in 2026."*
No rate is published. Sheets' $0 is not guaranteed indefinitely.

---

## Hosting

| Provider | Spec | Price | Renewal |
|---|---|---|---|
| **[Hetzner CX23](https://www.hetzner.com/cloud)** | 2 vCPU / 4 GB / 40 GB / 20 TB | €5.49 + €0.50 IPv4 | **Flat — no jump, no contract** |
| **[Hetzner CX33](https://www.hetzner.com/cloud)** | 4 vCPU / 8 GB / 80 GB | €8.49 + €0.50 | **Flat** |
| [Hostinger KVM 1](https://www.hostinger.com/vps-hosting) | 1 vCPU / 4 GB / 50 GB | $6.49 (24-month prepay) | **$11.99 (+85%)** |
| [Hostinger KVM 2](https://www.hostinger.com/vps-hosting) | 2 vCPU / 8 GB | $8.99 | **$14.99 (+67%)** |
| [Hostinger KVM 4](https://www.hostinger.com/vps-hosting) | 4 vCPU / 16 GB | $12.99 | **$28.99 (+123%)** |
| [Contabo Cloud VPS 4](https://contabo.com/en/vps/) | 4 vCPU / 8 GB / 100 GB | €5.50 or €4.40 ⚠️ | Two conflicting official figures; neither is a month-to-month rate |
| [Vultr](https://www.vultr.com/pricing/) | 4 GB / 8 GB | $20 / $40 | Flat |
| [DigitalOcean](https://www.digitalocean.com/pricing/droplets) | 4 GB / 8 GB | $24 / $48 | Flat — **~4.5× Hetzner** |
| [Akamai (Linode)](https://www.linode.com/pricing/) | 4 GB / 8 GB | $24 / $48 | Flat. Backups $2–$10 |
| [OVH VPS-2](https://www.ovhcloud.com/en/vps/) | 4 vCore / 8 GB | from $8.50 | Auto-renews at **the same price**. Early exit costs the remaining balance. Backup is the previous 24 h only |
| **[Oracle Always Free](https://www.oracle.com/cloud/free/)** | **2 OCPU ARM + 12 GB** | **$0 forever** | ⚠️ No SLA · Always-Free accounts *not eligible for Oracle Support* · idle instances reclaimed · accounts idle 30 days may be *"deemed abandoned"* |

Hostinger's fine print, verbatim: *"Renews at $11.99/mo for 2 years. Cancel
anytime."* The increase is real; the lock-in is not.

**Not priced, and it should be: no Gulf or Jordanian host.** Latency to Amman is
a real concern and every provider above is in Europe or North America.

---

## Domain registrar

| Registrar | .com year 1 | .com renewal | .io renewal | .xyz renewal |
|---|---|---|---|---|
| **[Porkbun](https://porkbun.com/products/domains)** | **$11.08** | **$11.08 — identical** | $51.80 | $14.21 → **$16.00** (from 25 Aug 2026) |
| [Cloudflare Registrar](https://www.cloudflare.com/products/registrar/) | At-cost, no markup | ~$10.46 ⚠️ **derived, never quoted** | — | — |
| ❌ [Hostinger](https://www.hostinger.com/domain-name-search) | $0.01 | **$19.99 (~2000× jump)** | **$74.99** | $19.99 |

The floor no registrar can go below: ICANN's .com fee schedule, **$10.26/yr
today → $10.97/yr from 1 November 2026 at 04:00 UTC**, plus $0.20 per
transaction. Any .com at $0.01–$5 is a first-year loss-leader.

⚠️ **One failed auto-renew costs about $211** — the registry's $40 restore fee
plus Porkbun's $200 domain-restoration fee — with the webhook down throughout.

TLS has no alternative worth considering: **Let's Encrypt is $0 forever** and
commercial use is explicitly permitted (Subscriber Agreement v1.8). A commercial
wildcard is $218–$224/yr for no benefit. Caddy automates renewal. Note that
Caddy's ZeroSSL fallback is capped at 3 certificates per 90 days on the free
plan, so it is not a free safety net.

---

## AI provider

| Provider | Price /MTok | 30/day | 100/day | 300/day |
|---|---|---|---|---|
| **[Claude Haiku 4.5](https://platform.claude.com/docs/en/about-claude/pricing)** | $1 in / $5 out | **$8.78** | **$29.25** | **$87.75** |
| Claude Sonnet 5 | $2 / $10 | $17.55 | $58.50 | $175.50 |
| [OpenAI gpt-5-nano](https://openai.com/api/pricing/) | $0.05 / $0.40 | $0.54 | $1.80 | $5.40 |
| OpenAI gpt-4o-mini | $0.15 / $0.60 | $1.21 | $4.05 | $12.15 |
| [DeepSeek flash](https://api-docs.deepseek.com/quick_start/pricing) | $0.30 / $1.20, 50% off-peak | — | — | — |
| ⚠️ [Gemini free tier](https://ai.google.dev/pricing) | $0 | — | — | — |

⚠️ **Gemini's free tier is the wrong trade for a commercial product.** Google's
pricing page states it means *"Content used to improve our products"* —
customers' WhatsApp messages would enter Google's training data. Its numeric
rate limits are no longer published, so capacity cannot be planned. DeepSeek's
off-peak window (01:00–04:00 and 06:00–10:00 UTC) overlaps Jordanian business
hours.

Prompt caching does not apply at this prompt size — see
[COSTS.md](COSTS.md#corrected-the-ai-line-is-higher-than-commonly-quoted).

---

## Notifying the agent

| Channel | Cost | Limits |
|---|---|---|
| **Telegram Bot API** | **$0** | 1 msg/sec per chat · ~30/sec overall · **20/min in a group**. Each employee `/start`s the bot once. Paid broadcast needs 100,000 Stars and 100,000 MAU — not an escape hatch here |
| Firebase Cloud Messaging | **$0 at any volume** | You must build the receiving app |
| [Pushover](https://pushover.net/pricing) | $4.99 one-time per user per platform · Teams $5/user/mo | 10,000 msgs/month free per application |
| ntfy self-hosted | $0 | ❌ Runs on the VPS it watches — dies with it |
| [Resend](https://resend.com/pricing) | $0 / Pro $20 | ⚠️ The binding limit is **100/day**, not 3,000/month. No permanence stated |
| [Amazon SES](https://aws.amazon.com/ses/pricing/) | **$0.10 per 1,000** | Cheapest at volume. Starts in sandbox — needs a production-access request |
| ⚠️ [SendGrid](https://sendgrid.com/en-us/pricing) | Free tier is now a **60-day trial** | Then $19.95/mo or sending stops |
| ❌ Twilio SMS to Jordan | **$0.4429 per SMS** | 100 conv/day × 5 agents = **$6,643/month** |

---

## Monitoring and backup

| Service | Free | Paid | Free-tier ceiling |
|---|---|---|---|
| [Sentry](https://sentry.io/pricing/) | ✅ Developer | Team **$26/mo** | ⚠️ **1 user** — a team cannot share it. 5,000 events/month |
| [UptimeRobot](https://uptimerobot.com/pricing/) | ✅ 50 monitors | Solo $9/mo annual | 5-minute interval |
| [Healthchecks.io](https://healthchecks.io/pricing/) | ✅ 20 jobs | $20/mo for SMS + history | Supporter ($5) adds **no functionality** over free |
| [Better Stack](https://betterstack.com/pricing) | ✅ 10 monitors, 30-sec checks | Nano $45/mo | 3 GB logs at **3-day retention** |
| [Backblaze B2](https://www.backblaze.com/cloud-storage/pricing) | ✅ **first 10 GB always free** | $6.95/TB/mo | Text backups stay well under 10 GB |
| [Cloudflare R2](https://developers.cloudflare.com/r2/pricing/) | ✅ 10 GB + **egress always free** | $0.015/GB | 2.2× B2 per GB, no egress conditions |
| ❌ AWS S3 | No permanent free storage | $0.023/GB + **$0.09/GB egress** | No reason to choose it here |

Neither free monitoring tier includes on-call escalation, and a 5-minute check
interval means up to five minutes of undetected downtime. Acceptable for your own
desk; not if you sell an uptime commitment.

---

## Agent inbox

| Option | Cost | Notes |
|---|---|---|
| **Chatwoot Community self-hosted** | **$0/agent forever** | Shared inbox, assignment, teams, labels, SLA, reports, WhatsApp Cloud API. **4 GB / 4 cores**, rated to 10,000 conversations/day. Needs transactional email |
| Chatwoot Cloud Hacker | $0 | 2 agents |
| Chatwoot Cloud Startups | $19/agent/mo | 8 agents = **$152/mo** |
| Chatwoot Cloud Business | $39/agent/mo | |

The existing 4 GB box meets Chatwoot's stated minimum — **adding the inbox needs
no VPS upgrade.**

---

## The near-zero stack, and where it breaks

| Layer | Free option | Breaking point |
|---|---|---|
| Compute | Oracle Always Free (2 OCPU ARM, 12 GB) | **No SLA, no support, idle reclamation** — not something a company should depend on |
| Automation | Node-RED / Activepieces | None — no commercial strings |
| Datastore | Self-hosted Postgres / Baserow | Backups are yours |
| Inbox | Chatwoot CE | 4 GB RAM, plus transactional email |
| TLS | Let's Encrypt + Caddy | 5 duplicate certs per 7 days |
| Notification | Telegram | 20 msgs/min in a group |
| Monitoring | UptimeRobot + Healthchecks | 5-minute blind spot, no escalation |
| **Domain** | ❌ none suitable | **$11.08/yr unavoidable** |

**Verdict.** Every layer above compute is genuinely and legitimately free
forever. Compute is where free stops being responsible: Oracle states in writing
that Free Tier carries no SLAs, that Always-Free-only customers are not eligible
for Oracle Support, that idle instances are reclaimed, and that accounts idle 30
days may be deemed abandoned.

The cheapest stack a company should actually depend on is about **$9.31/month**
before tax — Hetzner CX33 + IPv4 + backups + a .com.

---

## Recommendations

### If you keep running this for your own company

1. **Stay on Meta Cloud API direct.** No BSP is cheaper — every one of them adds
   a markup on top of Meta's rate, none subtracts from it.
2. **Move the VPS to Hetzner at the next renewal.** $7.09 flat against
   Hostinger's $11.99, with no promotional term to expire.
3. **Never renew the domain at Hostinger.** $11.08 at Porkbun against $19.99.
4. **Add the agent notification.** It is the one thing the system still cannot
   do, it is free on Telegram, and it is the reason the project exists.
5. **Keep Sheets until roughly 300 conversations/day**, then move to
   self-hosted Postgres on the same box. That is the quota wall, not a cost wall.

### If you sell this to other companies

1. **Change the automation engine first.** n8n's Sustainable Use License needs an
   unpriced Enterprise licence to host clients' workflows on your instance.
   Node-RED, Activepieces and Kestra have no such restriction. This is a licence
   decision before it is a technical one.
2. **Bill Meta message fees as a pass-through at cost**, never inside a fixed
   monthly price. That line has no volume discount, no price protection, and can
   be re-priced monthly.
3. **Price Jordanian tax in explicitly** — 16% self-assessed GST plus 10%
   withholding is a ×1.289 multiplier on every foreign invoice you pass through.
4. **Do not promise uptime on a single VPS with free-tier monitoring.** A
   5-minute check interval and no escalation is not an SLA posture.
5. **Install on each client's own server instead of hosting them.** n8n states
   verbatim that consulting help for clients setting up *their own* instances
   needs no commercial licence — that shape is free and compliant.

### The two decisions worth making before anything else

| Question | Why it decides the rest |
|---|---|
| **Do Coexistence replies count as billable service messages?** | The whole operating model — agents replying from the WhatsApp Business app — depends on the answer. Ask Meta directly |
| **Build it, or run Chatwoot?** | Chatwoot Community is free, does most of what this system does, and closes the notification gap natively. Run it on the existing box for one day with real conversations before deciding |
