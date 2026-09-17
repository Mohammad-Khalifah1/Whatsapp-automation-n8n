# Running costs

What this system actually costs to run. Every figure comes from the vendor's own
page or from statute. Verified **2026-09-17**.

Alternatives for every layer: **[ALTERNATIVES.md](ALTERNATIVES.md)**.

---

## The number

| | 30 conv/day | 100 conv/day | 300 conv/day |
|---|---|---|---|
| **You pay, per month** | **$10.32** | **$10.32** | **$14.84** |

That is a VPS and a domain, plus Jordanian tax. Everything else in the stack is
genuinely free, and Meta currently charges nothing for what this system does.

**Volume barely moves it.** Ten times the traffic costs 44% more, because the
only thing that changes is needing a slightly larger box.

> **This document used to say $122 to $443.** That was wrong in two ways: it
> priced an AI auto-reply feature **this system does not have**, and it added
> the owner's own maintenance hours to the invoice as though they were a bill.
> Both are corrected below, and time is now kept separate from cash.

---

## Line by line

| Line | 30/day | 100/day | 300/day | Why |
|---|---|---|---|---|
| **VPS** — [Hetzner CX23](https://www.hetzner.com/cloud) (2 vCPU / 4 GB) | $7.09 | $7.09 | — | Runs Docker, n8n, Caddy |
| **VPS** — [Hetzner CX33](https://www.hetzner.com/cloud) (4 vCPU / 8 GB) | — | — | $10.59 | Headroom for Postgres once Sheets hits its quota |
| **Domain** — [Porkbun](https://porkbun.com/products/domains) `.com` | $0.92 | $0.92 | $0.92 | $11.08/yr. Meta requires a publicly trusted TLS endpoint |
| **Subtotal** | $8.01 | $8.01 | $11.51 | |
| **+ Jordanian tax** (×1.2889) | **$10.32** | **$10.32** | **$14.84** | See below |

### Which VPS you are on changes this

| Option | Monthly | Note |
|---|---|---|
| **Hetzner CX23** | $7.09 | Flat. No contract, no promotional term |
| Hostinger KVM 1 — promo | $6.49 | Requires prepaying 24 months |
| Hostinger KVM 1 — **renewal** | **$11.99** | **+85%.** Verbatim: *"Renews at $11.99/mo for 2 years. Cancel anytime."* |

Hetzner is cheaper than Hostinger's renewal price and has no promotional term to
expire.

---

## What is free, and why

| Component | Cost | Why it is free |
|---|---|---|
| **Meta WhatsApp Cloud API** | **$0** | No platform, access or subscription fee exists. Charges are per delivered message only |
| **Receiving webhooks** | **$0** | Not a billable item |
| **Inbound messages** from customers | **$0** | Verbatim: *"Messages sent from a WhatsApp user to a business are not charged."* Unlimited, at any volume |
| **Your replies**, inside the 24 h window | **$0** *(today)* | Verbatim: non-template messages *"have not been charged since July 1, 2025"* |
| **`wa.me` conversation links** | **$0** | A public URL format, not an API |
| **n8n Community** | **$0 forever** | No trial, no expiry, no execution cap, no seat cap |
| **Google Sheets API** | **$0** | No per-request charge. Quota-limited, not price-limited |
| **Let's Encrypt + Caddy** | **$0 forever** | Commercial use explicitly permitted |
| **Telegram Bot API** | **$0** | For notifying an agent |
| **UptimeRobot + Healthchecks.io** | **$0** | Free tiers cover this system |
| **Backblaze B2** | **$0** | First 10 GB always free; backups here are far under it |

---

## Two connectors, two cost shapes

`WHATSAPP_CONNECTOR` picks how a number reaches the system, and the choice
changes the bill — see [WAHA_CONNECTOR.md](WAHA_CONNECTOR.md).

| | Meta Cloud API | WAHA |
|---|---|---|
| Per-message fees | $0 today; charged from 1 Oct 2026 | **None, ever** — no Meta billing relationship |
| Server | Included in the CX23 above | **One more container.** Budget the CX33 ($10.59) rather than the CX23 |
| Monthly, with tax | $10.32 | **$14.84** |
| Approval needed | Business verification, days to weeks | None |
| Number must be deleted first | Yes, unless Coexistence | **No** |
| Risk | None — it is the sanctioned path | **Ban, unpredictable, no reliable appeal** |

WAHA removes the only line that grows with volume, and adds a risk that is not
priced in dollars. It is cheaper on paper and more expensive if the number is
the business. Put nothing there you cannot afford to lose.

---

## Meta: today, and what changes

### Today — confirmed

Jordan (+962) is in Meta's **Rest of Middle East** region, market code `MDE`.

| Message type | Rate |
|---|---|
| **Service** — your free-form reply inside the 24 h window | **$0.00** |
| **Utility** template, inside an open window | **$0.00** |
| Utility template, outside the window | $0.0091 |
| Authentication template | $0.0091 |
| Marketing template | $0.0341 |
| **Inbound**, customer → business | **$0.00**, unlimited |

**For this system — an inbound desk that answers within 24 hours — Meta's bill
today is $0.00.**

### From 1 October 2026 — charging confirmed, price not

| | Status |
|---|---|
| **Service messages become chargeable** | ✅ **Confirmed by Meta**, verbatim: *"Effective October 1, 2026, Meta will charge on a per-message basis for service messages, consistent with how Meta charges for template messages."* |
| **The rate** | ❌ **Not published.** Meta's page said rates would be announced *"no later than September 1, 2026"* — that date has passed with no rate card |
| **1,000 free service messages per month** | ⚠️ Widely reported by resellers. **Not on any Meta page** |
| **30 September payment-method deadline** | ⚠️ Same — reported, not on any Meta page |
| In-window utility templates losing their free status | ❌ **Contradicted.** Meta's page still states they are free |

**If** it lands at the current utility rate of $0.0091 per reply, and **if** the
1,000 free allowance is real:

| | 30/day | 100/day | 300/day |
|---|---|---|---|
| Replies sent (3 per conversation) | 2,736 | 9,120 | 27,360 |
| Less 1,000 free | 1,736 | 8,120 | 26,360 |
| Meta, per month | $15.80 | $73.89 | $239.88 |
| **Total with tax** | **$30.69** | **$105.56** | **$324.01** |

Without the free allowance, add $9.10/month to each. **Both figures rest on an
unpublished rate — treat them as planning estimates, not quotes.**

Two facts that are confirmed: Meta offers **no volume discount on service
messages, ever**, and it may change the rate card **at any time**, effective the
first of the following month.

### The question that decides all of it

Your agents reply from the **WhatsApp Business app** via Coexistence. Does Meta
bill those replies as service messages?

| If app replies are **not** billed | Meta stays **$0 forever**. Your cost stays $10–15/month |
| If they **are** billed | The table above applies from October |

No Meta page answers this. **Ask Meta directly** — it is the difference between
$10 and $324 a month.

---

## Jordanian tax

Applies to every foreign invoice — Hetzner, Porkbun, and Meta if it ever bills.

| Charge | Rate | Statute |
|---|---|---|
| General sales tax on imported services, **self-assessed by you** | **16%** | General Sales Tax Law Art. 6(a); Art. 4 bis (e); Art. 9(e) makes the recipient liable |
| Withholding tax on payments to non-residents | **10%** | Income Tax Law No. 34/2014 Art. 12(B)(1) |
| **Combined multiplier** | **×1.2889** | 10% withholding grossed up (1 ÷ 0.9), then 16% GST |

> **Check this with your accountant before budgeting it.** The statute is real
> and quoted above. Whether a small business actually operates withholding on an
> $8 card payment to a foreign VPS provider is a question of practice, not of
> law, and this document cannot answer it. If withholding does not apply, the
> multiplier is ×1.16 and the totals drop to **$9.29 / $9.29 / $13.35**.

---

## Your time — kept separate on purpose

This is **not** a cash cost, and it does not belong in the same column as an
invoice. If you maintain the system yourself, nothing leaves your account.

| Work | Realistic time |
|---|---|
| Docker and n8n updates | ~1 h/month |
| Checking backups actually restore | ~30 min/month |
| Occasional debugging | varies |
| **Total** | **1–2 hours a month, roughly flat with volume** |

It is roughly flat because the system does the same thing at any volume: receive
a webhook, write rows. Three hundred conversations a day does not need three
times the maintenance of one hundred.

An earlier version of this document put 5–14 hours a month at $20/hour into the
headline total. That single invented line was **63–82% of the number**, and it
is why the figure looked like $443 instead of $15.

---

## Auto-reply is not part of this system

There is no AI in it. No LLM call exists anywhere: on the Meta path the only
external hosts it contacts are `graph.facebook.com`, `sheets.googleapis.com` and
`oauth2.googleapis.com`, and on the WAHA path a container on your own server
replaces the first of those. The `product` column is typed by a person.

If it is ever added, two bills appear: the model that writes the text (priced per
token by whichever provider you pick), and Meta delivering the reply — at the
same rate as any other reply, because **Meta does not charge differently for an
automated one**. The exception is Meta's own in-WhatsApp AI, billed at $2.00 per
1M tokens, roughly 4-5 cents a message.

---

## Optional lines

Not required. Listed so they are a decision, not a surprise.

| Service | Cost | When you would want it |
|---|---|---|
| [Sentry](https://sentry.io/pricing/) Team | $26/month | Shared error visibility. The free tier is **1 user**; logging to Postgres also works and is free |
| Self-hosted PostgreSQL | **$0** | Replaces Sheets at ~300 conv/day, when the 60-writes/min-per-user quota starts returning 429s |
| [Chatwoot Community](https://www.chatwoot.com/pricing/self-hosted-plans) | **$0/agent** | A real web inbox instead of a spreadsheet. Needs 4 GB RAM and 4 cores — the existing box qualifies |
| [Google Workspace](https://workspace.google.com/pricing.html) | $0 Essentials Starter · $7/user Business Starter | Company-owned Sheets instead of a personal Gmail. Essentials Starter is free for up to 100 users |
| Transactional email ([SES](https://aws.amazon.com/ses/pricing/)) | $0.10 per 1,000 | Required only if you add Chatwoot |

---

## Is n8n really free?

**Yes — permanently, for running your own company's support desk.**

| Question | Answer |
|---|---|
| Free forever, or a trial? | **Free forever.** No expiry clause exists in `LICENSE.md` |
| Execution / user / concurrency caps? | **None** |
| Commercial use for your own business? | **Permitted** — *"your own internal business purposes"* |
| Does it start costing after a period? | **No.** Nothing in the licence is time-based |

**What does cost money — none of it time-based:**

| Trigger | Licence | Price |
|---|---|---|
| Hosting **clients'** workflows on your instance | Enterprise — *"an Enterprise license would be required"* | **Not published** |
| Embedding or white-labelling n8n in your product | Embed / OEM | **Not published** |
| Needing SSO, Git versioning, or workflow sharing between users | Self-hosted Business | **€667/month, billed annually** |
| Helping clients set up **their own** instances | **None** — *"no commercial license would be required on your part"* | **$0** |

If you intend to resell this, the engine is a licence decision before it is a
technical one — see [ALTERNATIVES.md](ALTERNATIVES.md#automation-engine-replacing-n8n).

---

## What could not be verified

| Claim | Status |
|---|---|
| **Jordan's service rate after 1 October** | **Unknown.** No October rate card is published. $0.0091 is carried from the current utility rate as an assumption |
| The 1,000 free service message allowance | Reported by resellers; **absent from every Meta page** |
| The 30 September payment deadline | Same |
| **Whether Coexistence replies are billed** | **The most important open question for this architecture** |
| Whether Jordanian withholding applies in practice to small foreign card payments | A question for an accountant, not a statute |
| Cloudflare Registrar `.com` price | No figure published outside the logged-in dashboard |
| n8n Enterprise / Embed prices | Not published — quote-only |
| Hetzner: is primary IPv4 already in the listed price? | Prices render via JavaScript. Every Hetzner figure here may be $0.60/mo too high — in your favour |

### Not priced here

Arabic speech-to-text for voice notes · vision tokens for inbound photos ·
WhatsApp media retention (Cloud API media URLs expire) · WhatsApp Business
Calling API · Jordan PDPL No. 24 of 2023 compliance if you resell · one-time
build and migration labour.

---

## Corrections made to this document

| Was | Is |
|---|---|
| $122 / $262 / $443 per month | **$10.32 / $10.32 / $14.84** |
| An AI line in the main totals | **Removed.** The system has no AI. Moved to a section about adding it later |
| An AI line was priced into the totals | **Removed.** The system has no AI; pricing a feature that does not exist is not a cost |
| Maintenance hours added into the invoice total | **Separated.** It is time, not cash — and 1–2 h/month, not 5–14 |
| Sentry listed as mandatory | **Optional** |
| October charging "reported, not published" | **Confirmed by Meta verbatim.** The *rate* is what remains unpublished |
| Jordanian tax presented as certain | Statute quoted; **practice flagged as a question for an accountant** |
| Marketing at $0.0392 | **$0.0341** — the confirmed current rate |
| Chatwoot needs 8 GB RAM | **4 GB and 4 cores.** No VPS upgrade needed |
