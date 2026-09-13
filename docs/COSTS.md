# Running costs

What this system costs to run. Every figure comes from the vendor's own page or
statute, re-checked by an independent pass. Verified **2026-09-13**.

Alternatives and recommendations: **[ALTERNATIVES.md](ALTERNATIVES.md)**.

- [Meta rates — confirmed vs unpublished](#meta-rates--confirmed-vs-unpublished)
- [Is n8n really free?](#is-n8n-really-free)
- [Cost table](#cost-table)
- [Jordanian tax](#jordanian-tax)
- [Monthly total](#monthly-total)
- [What could not be verified](#what-could-not-be-verified)
- [The risk if you sell this](#the-risk-if-you-sell-this)

---

## Meta rates — confirmed vs unpublished

Jordan (+962) is in Meta's **Rest of Middle East** region, market code `MDE`,
with Bahrain, Iraq, Kuwait, Lebanon, Oman and Yemen.

### Confirmed — in force today

| Message type | Rate |
|---|---|
| **Service** — free-form agent reply inside the 24h window | **$0.00** |
| **Utility** template, inside an open window | **$0.00** |
| **Utility** template, outside the window | $0.0091 |
| **Authentication** template | $0.0091 |
| **Marketing** template | $0.0341 |
| **Inbound**, customer → business | **$0.00**, unlimited |

Utility templates inside an open customer service window are free, verbatim from
Meta, with the billing webhook showing `"billable": false` and
`"type": "free_customer_service"`.

> A widely repeated claim says in-window utility templates lose their free status
> on 1 October 2026. **Nothing on Meta's site supports it.** Do not budget for it.

### Not published — the reported 1 October 2026 change

| Claim | Status |
|---|---|
| Service messages become chargeable after **1,000 free per business phone number per month**, no roll-over | Reported consistently by multiple BSPs. **Not confirmable on any Meta page** |
| Payment method required by **30 September 2026** or delivery stops | Same — reported, not confirmable |
| Service charged at the utility rate ($0.0091 for Jordan) | **Unknown officially** |
| Marketing rises to $0.0392 | **Not a current figure.** Today's confirmed rate is $0.0341 |

As of 2026-09-13 the only downloadable rate cards on Meta's pricing page are
labelled *effective July 1, 2026*. The October section is prose with no numbers
and still says Meta *"will announce to-be rates no later than September 1,
2026"* — a date that has passed with no card published. Meta's own rate endpoint
requires a session nonce and returns nothing to an automated request, and the
rates are not embedded in the page HTML.

**The grouping is also being re-cut on the same day.** Iraq, Kuwait and Oman
leave Rest of Middle East on 1 October 2026, and a residual "Rest of" rate is
exactly what gets re-priced when its membership changes.

Two facts that do come from Meta:

- **No volume tiers for service messages, ever.** Rest of Middle East also shows
  0% discount at every published utility tier — scale buys nothing here.
- **Meta may change the rate card at any time**, effective the first day of the
  following calendar month. Up to twelve changes a year, days of notice. The
  quarterly cadence people quote is policy, not a contractual cap.

**Action:** download the USD rate card from Meta's pricing page and confirm
Jordan's service rate yourself before committing a budget or quoting a client.

---

## Is n8n really free?

**Yes — permanently, for running your own company's support desk.** No trial, no
expiry, no execution cap, no user cap, no seat cap.

| Source | What it says |
|---|---|
| `LICENSE.md` (Sustainable Use License) | A *"non-exclusive, royalty-free, worldwide, non-sublicensable, non-transferable license to use, copy, distribute, make available, and prepare derivative works"* for *"your own internal business purposes"*. No expiry, trial, user cap or execution limit appears anywhere in it |
| Community Edition docs | *"The Community edition includes almost the complete feature set of n8n"* |
| Concurrency docs | *"Concurrency control is disabled by default"* on self-hosted |

### Three things do cost money — none of them time-based

They arrive because of something **you** change, never because a period elapsed.

| Trigger | Licence | Price |
|---|---|---|
| **You host clients' workflows on your own instance** — the resale model | **Enterprise.** Verbatim: *"If you intend to host and manage your clients' workflows and credentials within your own internal n8n instance, an Enterprise license would be required."* | **Not published** — "Contact Sales" |
| **You embed or white-label n8n into your product** | **Embed / OEM**, a separate contract, priced on an annual execution commitment | **Not published** |
| **You need an Enterprise-only feature** | Self-hosted Business | **€667/month billed annually — €8,004 up front** |

> The "$50,000/year Embed minimum" that circulates on forums is **not an n8n
> figure**. Email `license@n8n.io` for scope and `sales@n8n.io` for terms; n8n's
> helpdesk states it *"cannot grant permission to use our license for your
> specific use case."*

Enterprise-only features, from n8n's docs: custom variables and environments,
external secrets, external binary data storage, log streaming, multi-main mode,
projects, SSO (SAML/LDAP), Git-based version control, and **workflow and
credential sharing** — *"Only the instance owner and the user who creates them
can access workflows and credentials."*

> The sharing limit probably does not bite here: agents never log into n8n, they
> work in WhatsApp and the sheet. Only the person who builds workflows needs an
> account, and on Community that is one person.

Also outside the free licence: any file with `.ee.` in its name or `.ee` in its
directory path, and any branch other than `master`. Nothing here depends on those.

**Consulting is explicitly fine.** *"If your role is limited to assisting your
clients with setting up their own internal instances of n8n, no commercial
license would be required on your part."*

---

## Cost table

**Mandatory** — the system does not run without these.

| Service | What it is | Why this project needs it | From what size | Monthly |
|---|---|---|---|---|
| [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/pricing/) | The messaging platform | The only compliant way to run a business number | Day one | **$0 platform fee.** Per-message only |
| [n8n Community](https://n8n.io/pricing/) | Self-hosted automation engine | Webhook, routing, Sheets writes | Day one | **$0 forever** |
| [Google Sheets API](https://developers.google.com/sheets/api/limits) | Datastore + manager UI | Conversations, Messages, Agents, Categories, Log | Day one | **$0** |
| VPS — [Hetzner CX23](https://www.hetzner.com/cloud) | 2 vCPU / 4 GB / 40 GB / 20 TB | Docker, n8n, Caddy | Day one | **€5.49 + €0.50 IPv4 ≈ $7.09** |
| Domain — [Porkbun .com](https://porkbun.com/products/domains) | Public hostname | Meta requires a publicly trusted TLS endpoint | Day one | **$11.08/yr = $0.92** |
| [Let's Encrypt](https://letsencrypt.org/) + [Caddy](https://caddyserver.com/docs/automatic-https) | TLS + automation | HTTPS on the webhook | Day one | **$0 forever** |
| [Telegram Bot API](https://core.telegram.org/bots/api) | Agent notification | The sheet does not ring | Day one | **$0** |
| [Healthchecks.io](https://healthchecks.io/pricing/) | Dead-man's-switch | Tells you a workflow **stopped running** | Day one | **$0** (20 jobs) |
| [UptimeRobot](https://uptimerobot.com/pricing/) | Uptime monitoring | Confirms the webhook is reachable | Day one | **$0** (50 monitors) |
| [Backblaze B2](https://www.backblaze.com/cloud-storage/pricing) | Off-site backup | A backup on the same VPS is not a backup | Day one | **$0** under the always-free 10 GB |
| A Jordanian phone line | The WhatsApp number | Must receive one SMS or call; cannot already be on WhatsApp | Day one | **Not priced** — carrier-dependent |

**Conditional** — arrives at a specific size, or when a feature is switched on.

| Service | What it is | From what size | Monthly |
|---|---|---|---|
| [Claude Haiku 4.5](https://platform.claude.com/docs/en/about-claude/pricing) | AI classification / draft replies | When auto-reply is switched on | **$8.78** (30/day) · **$29.25** (100/day) · **$87.75** (300/day) |
| Speech-to-text | Arabic voice notes | Voice notes are routine on a Jordanian desk | **Not priced** — a real gap |
| [Sentry](https://sentry.io/pricing/) | Error tracking | When more than one person operates it | $0 Developer (**1 user**) → **$26** Team |
| Transactional email ([SES](https://aws.amazon.com/ses/pricing/)) | Invitations, resets, notifications | Required by Chatwoot; a fresh VPS IP cannot deliver mail | **$0.10 per 1,000** |
| Self-hosted PostgreSQL | Replaces Sheets | ~300 conversations/day, when the 60-writes/min-per-user quota returns 429s | **$0** on the existing VPS |
| VPS — [Hetzner CX33](https://www.hetzner.com/cloud) | 4 vCPU / 8 GB | Adding Postgres or Chatwoot | **≈ $10.59** |
| [Chatwoot Community](https://www.chatwoot.com/pricing/self-hosted-plans) | Agent inbox, web + mobile | When agents will not work in a spreadsheet | **$0/agent forever** |
| [Google Workspace](https://workspace.google.com/pricing.html) | Company-owned Google identity | When the business must own the data | **$0** Essentials Starter (100 users, no Gmail) · **$7/user** Business Starter |
| [ngrok](https://ngrok.com/pricing) | Dev tunnel | Development only | **$0** (20,000 req/month) |

Chatwoot's official requirements: **4 GB RAM and 4 CPU cores, rated to 10,000
conversations/day**; 8 GB / 8 cores for 20,000/day. The Postgres host needs
5–10 GB, Redis starts at 100 MB, plus 1 GB swap. **The existing 4 GB box
qualifies — no upgrade is required to add the inbox.**

### Corrected: the AI line is higher than commonly quoted

Claude Haiku 4.5's **minimum cacheable prefix is 4,096 tokens**. This system's
routing rules and product snippet come to roughly 1,500 tokens — **below the
threshold, so prompt caching does not apply at all.** Every estimate that
assumed caching understated this line by about 40%.

| | 30/day | 100/day | 300/day |
|---|---|---|---|
| **Uncached — what you will pay** | **$8.78** | **$29.25** | **$87.75** |
| *If* the prefix exceeded 4,096 tokens | $6.49 | $18.45 | $52.65 |

Caching is worth engineering for only if you deliberately grow the stable prefix
past 4,096 tokens — a larger FAQ or product catalogue would do it, and would then
pay for itself at 300/day.

Assumptions: 3 inbound messages per conversation, ~2,000 input and 250 output
tokens per call, 30.4 days, **text only**.

---

## Jordanian tax

Confirmed from the Jordan Income and Sales Tax Department's published statutes.
This applies to **every foreign vendor invoice** here — Meta, Hetzner, Anthropic,
Google, Porkbun, Sentry.

| Charge | Rate | Statute |
|---|---|---|
| **General sales tax on imported services** — self-assessed by you, the recipient | **16%** | General Sales Tax Law Art. 6(a); Art. 4 bis (e) covers imported electronic services; Art. 9(e) makes the recipient liable |
| **Withholding tax on payments to non-residents** | **10%** | Income Tax Law No. 34/2014 Art. 12(B)(1); remit within 30 days per Art. 12(E) |

Registration within 30 days (Art. 13(b)), bi-monthly returns (Art. 16), input
credit possible under Art. 19(c).

**Multiplier on every foreign line: ×1.289 in gross cash** — the 10% withholding
grossed up (10/90 = +11.11%), then 16% GST on top. If the GST is creditable
against your own output tax, the net multiplier is ×1.111.

Meta's terms put this on you: amounts *"may be subject to and include applicable
taxes and levies, including withholding taxes."* Add a **2–3% cross-border/FX
fee** on a Jordanian card paying USD or EUR.

---

## Monthly total

### Today — the regime actually in force

| Line | 30 conv/day | 100 conv/day | 300 conv/day |
|---|---|---|---|
| Meta messages | **$0** | **$0** | **$0** |
| VPS | $7.09 | $7.09 | $10.59 |
| Domain | $0.92 | $0.92 | $0.92 |
| n8n · Sheets · TLS · Telegram · monitoring · backups | $0 | $0 | $0 |
| AI (uncached Haiku 4.5) | $8.78 | $29.25 | $87.75 |
| Sentry | $0 | $26 | $26 |
| **Subtotal** | **$16.79** | **$63.26** | **$125.26** |
| **+ Jordanian tax and FX (×1.289)** | **$21.64** | **$81.54** | **$161.46** |
| Maintenance hours | 4–6 | 8–10 | 12–16 |
| **True total at $20/h** | **≈ $120** | **≈ $260** | **≈ $450** |

### Planning estimate — if the reported October change lands

Assumes $0.0091 per service message after 1,000 free. **Not confirmed.**

| Line | 30 conv/day | 100 conv/day | 300 conv/day |
|---|---|---|---|
| Service messages billable | 1,736 | 8,120 | 26,360 |
| Meta messages | $15.80 | $73.89 | $239.88 |
| Everything else | $16.79 | $63.26 | $125.26 |
| **+ tax and FX (×1.289)** | **$41.99** | **$176.94** | **$470.68** |
| **True total at $20/h** | **≈ $140** | **≈ $355** | **≈ $760** |

Message maths: 3 agent replies × 30.4 days, minus 1,000 free, × $0.0091.
Inbound messages are free at any volume.

**Two things the proportions show.** The five lines usually worried about — n8n,
Sheets, VPS, domain, TLS — total **$8/month** and are not where the money is. And
if the October change lands, **Meta becomes 51–66% of the cash bill** and it is
the one line with no volume discount and no price protection.

---

## What could not be verified

| Claim | Status |
|---|---|
| **Jordan's post-1-October service rate** | ⚠️ **Unknown officially.** No October 2026 rate card is published. $0.0091 is a planning assumption carried from the current utility rate |
| **The 1,000 free service messages / 30 Sept payment deadline** | Reported consistently by multiple BSPs; **absent from every Meta page that could be fetched** |
| Marketing at $0.0392 | **Not a current figure.** Confirmed today: $0.0341 |
| Cloudflare Registrar .com price | No figure exists outside the logged-in dashboard. ~$10.46 is derived from ICANN's schedule |
| Meta Business verification fee | Very likely $0, not stated on any reachable page |
| Jordanian SIM / DID cost | Not priced from a carrier's own page |
| n8n Enterprise, Embed and OEM prices | Not published at all. Quote-only |
| Commercial-use permission at the paid VPS providers | Ordinary paid hosting, but no licence text was quoted |
| Hetzner: whether the listed price already includes primary IPv4 | Prices render via JavaScript. Every Hetzner figure may be €0.50/mo too high — in your favour |
| Whether Coexistence replies count as billable service messages | **The most important open question for this architecture.** Ask Meta directly |

### Still missing from this document

- **Arabic speech-to-text.** Voice notes are routine on a Jordanian WhatsApp desk
  and the AI model here is text-only. A real, unpriced line.
- **Vision tokens** for inbound photos, screenshots and invoices — one image can
  exceed the entire 2,000-token input budget assumed above.
- **WhatsApp media retention.** Cloud API media URLs expire, so keeping
  attachments means downloading and storing them. The $0 backup figure assumes a
  ~10 MB/day text export.
- **WhatsApp Business Calling API** — business-initiated calls billed by duration
  in six-second pulses. A live meter on the same number.
- **WhatsApp Groups API** — billed per recipient per delivered message.
- **Jordan Personal Data Protection Law No. 24 of 2023** — this system processes
  third parties' message content. If resold, each client needs a privacy notice
  and a lawful basis.
- **Secrets management** for a team holding Meta tokens, AI keys and VPS
  credentials.
- **One-time build and migration labour**, including the Sheets→Postgres move
  this document says becomes necessary at 300/day.

### Corrected during verification

- **Prompt caching does not apply.** Haiku 4.5's minimum cacheable prefix is
  4,096 tokens; this system's stable prefix is ~1,500. The AI line is
  $8.78–$87.75, not $6.49–$52.65.
- **No October 2026 rate card exists.** An earlier draft presented $0.0091
  service and $0.0392 marketing as published October figures. Neither is.
- **In-window utility templates stay free**, verbatim from Meta with the billing
  webhook to prove it.
- **Chatwoot needs 4 GB RAM and 4 cores**, rated to 10,000 conversations/day —
  not 8 GB. No VPS upgrade is required.
- **n8n Business is self-hosted, not Cloud.** n8n Cloud tops out at Pro.
- **Google Workspace Essentials Starter is $0** for up to 100 users with Drive,
  Sheets and an admin console.
- **Jordanian tax was missing entirely** from every earlier estimate: 16% GST
  self-assessed plus 10% withholding, a ×1.289 multiplier.
- Iraq, Kuwait and Oman become standalone markets on 1 Oct 2026; **Iraq's rates
  go down**, not up.
- Porkbun .xyz renews at $16.00 from 25 Aug 2026, not $14.21.

---

## The risk if you sell this

The largest cost line is also the least verifiable and the least contractually
protected — and it is the line a client would be paying for.

If the October change lands as reported, Meta becomes **51–66% of the cash
bill**. That line has:

- **no published number** you can show a client from a durable URL,
- **no volume discount, ever** — Meta states it will not offer volume tiers for
  service messages,
- **no price protection** — the rate card may change at any time, effective the
  first of the following month,
- **a grouping being re-cut on the same day charging begins**,
- **a cost driver you do not control** — the bill is per outbound reply, so five
  replies instead of three raises it 67%, and letting the 24-hour window lapse
  converts a free reply into a $0.0091 utility or $0.0341 marketing template.

Selling this as a fixed monthly fee means writing an uncapped, unhedgeable,
monthly-repriceable pass-through into a fixed-price contract. Bill Meta message
fees as a pass-through at cost instead.

Licence and engine implications are in
[ALTERNATIVES.md](ALTERNATIVES.md#recommendations).

### One more Meta trap

A business phone number used with **both the WhatsApp Business app and the Cloud
API** — i.e. Coexistence, which [OPERATING_GUIDE.md](OPERATING_GUIDE.md)
recommends — has a **fixed throughput of 20 messages per second**, instead of the
80 mps default that auto-upgrades to 1,000 mps for free. Not a cash cost, but a
ceiling that arrives with the architecture.
