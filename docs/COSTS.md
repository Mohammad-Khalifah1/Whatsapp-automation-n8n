# Running costs

Every figure below comes from the vendor's own page or statute, re-checked by an
independent pass. Verified **2026-09-13**. Alternatives and recommendations:
**[ALTERNATIVES.md](ALTERNATIVES.md)**.

All volumes assume **3 agent replies per conversation** and a **30.4-day month**.
Full assumption list: [Basis of every figure](#basis-of-every-figure).

---

## 1. Headline

Today's regime — what you actually pay now.

| | 30 conv/day | 100 conv/day | 300 conv/day |
|---|---|---|---|
| Vendor invoices | $16.90 | $63.65 | $126.43 |
| **+ Jordanian tax and FX (×1.2889)** | **$21.78** | **$82.04** | **$162.95** |
| Maintenance | 5 h | 9 h | 14 h |
| **True total at $20/h** | **$122** | **$262** | **$443** |

If the reported 1 October 2026 Meta change lands — **not confirmed**, see §3.

| | 30 conv/day | 100 conv/day | 300 conv/day |
|---|---|---|---|
| Vendor invoices incl. Meta | $32.70 | $137.54 | $366.31 |
| **+ tax and FX (×1.2889)** | **$42.15** | **$177.27** | **$472.13** |
| **True total at $20/h** | **$142** | **$357** | **$752** |
| Meta's share of the invoice | 48% | 54% | 65% |

---

## 2. Meta rates — confirmed, in force today

Jordan (+962) is in Meta's **Rest of Middle East** region, market code `MDE`,
with Bahrain, Iraq, Kuwait, Lebanon, Oman and Yemen.

| Message type | Rate | Note |
|---|---|---|
| **Service** — free-form agent reply inside the 24 h window | **$0.00** | The rate-card column reads `n/a` |
| **Utility** template, inside an open window | **$0.00** | Billing webhook: `"billable": false`, `"type": "free_customer_service"` |
| **Utility** template, outside the window | $0.0091 | |
| **Authentication** template | $0.0091 | Authentication-International is `n/a` for this region |
| **Marketing** template | $0.0341 | |
| **Inbound**, customer → business | **$0.00** | Unlimited, at any volume |

| Meta fact | Detail |
|---|---|
| Platform / hosting fee | **$0.00** — charges are per delivered message only |
| Volume tiers on service messages | **None, ever.** Region also shows 0% discount at every published utility tier |
| Rate-card change rights | Meta may change it **at any time**, effective the 1st of the following calendar month. Up to 12 changes/year |
| Throughput | 80 msg/sec default, auto-upgraded to 1,000 free — **but 20 msg/sec fixed** if the number is used with both the Business app and the Cloud API (Coexistence) |
| Messaging limits | 250 → 2,000 → 10,000 → 100,000 → unlimited. Earned, never bought. Counts only unique users messaged **outside** a service window |
| Phone number registration, display-name approval | **$0.00** from Meta |

---

## 3. Meta's 1 October 2026 change — reported, not published

| Claim | Status |
|---|---|
| Service messages become chargeable after **1,000 free per business phone number per month**, no roll-over | Reported consistently by multiple BSPs. **Not confirmable on any Meta page** |
| Payment method required by **30 September 2026** or delivery stops | Same — reported, not confirmable |
| Service charged at the utility rate ($0.0091 here) | **Unknown officially** |
| Marketing rises to $0.0392 | **Not a current figure.** Confirmed today: $0.0341 |
| In-window utility templates lose their free status | **Contradicted.** Meta's page still states they are free |

| Why it cannot be confirmed | Evidence |
|---|---|
| Only July 2026 rate cards are downloadable | The October section on Meta's pricing page is prose with **no numbers** |
| Meta missed its own announcement date | The page still says rates would be announced *"no later than September 1, 2026"* |
| The rate endpoint is gated | Meta's own pricing API returns `rest_missing_callback_param: _wab_nonce` to any automated request |
| The rates are not in the page source | 286 KB of HTML fetched; `Rest of Middle East` and `MDE` appear, the numbers do not |
| The region is being re-cut the same day | Iraq, Kuwait and Oman leave *Rest of Middle East* on 1 Oct 2026 — a residual "Rest of" rate is exactly what gets re-priced |

> **Action:** download the USD rate card from Meta's pricing page and confirm
> Jordan's service rate yourself before committing a budget or quoting a client.
> The $0.0091 used in §1 is a planning assumption carried from the utility rate.

---

## 4. Is n8n really free?

**Yes — permanently, for running your own company's support desk.**

| Question | Answer | Source |
|---|---|---|
| Free forever, or a trial? | **Free forever.** No expiry or trial clause exists | `LICENSE.md` |
| Execution cap? | **None** | Community Edition docs |
| User / seat cap? | **None** | Community Edition docs |
| Concurrency cap? | **None** — *"Concurrency control is disabled by default"* | Concurrency docs |
| Feature set? | *"The Community edition includes almost the complete feature set of n8n"* | Community Edition docs |
| Commercial use for your own business? | **Permitted** — *"your own internal business purposes"* | `LICENSE.md` |
| Does it start costing after a period? | **No.** Nothing in the licence is time-based | `LICENSE.md` |

### What does cost money — none of it time-based

| Trigger | Licence required | Price |
|---|---|---|
| **You host clients' workflows on your own instance** — the resale model | **Enterprise.** *"If you intend to host and manage your clients' workflows and credentials within your own internal n8n instance, an Enterprise license would be required."* | **Not published** — "Contact Sales" |
| **You embed or white-label n8n into your product** | **Embed / OEM**, a separate contract on an annual execution commitment | **Not published** |
| **You need an Enterprise-only feature** | Self-hosted Business | **€667/month, billed annually = €8,004 up front** |
| You only help clients set up **their own** instances | **None** — *"no commercial license would be required on your part"* | **$0** |

| Enterprise-only features | Relevant here? |
|---|---|
| **Workflow and credential sharing** — *"Only the instance owner and the user who creates them can access workflows and credentials"* | Only if a second person builds workflows. Agents never log into n8n |
| SSO (SAML/LDAP), projects, Git version control | No |
| External secrets, external binary data storage | No |
| Log streaming, multi-main mode | No |
| Custom variables and environments | No |
| Files with `.ee.` in the name or `.ee` in the path; branches other than `master` | Nothing here depends on them |

> The "$50,000/year Embed minimum" circulating on forums is **not an n8n figure**.
> Licence scope: `license@n8n.io`. Terms: `sales@n8n.io`. n8n's helpdesk states it
> *"cannot grant permission to use our license for your specific use case."*

---

## 5. Mandatory costs

The system does not run without these.

| Service | What it is | Why needed | From | Monthly |
|---|---|---|---|---|
| [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/pricing/) | Messaging platform | The only compliant way to run a business number | Day one | **$0** platform fee; per-message only |
| [n8n Community](https://n8n.io/pricing/) | Automation engine | Webhook, routing, Sheets writes | Day one | **$0** |
| [Google Sheets API](https://developers.google.com/sheets/api/limits) | Datastore + manager UI | The five tabs | Day one | **$0** |
| [Hetzner CX23](https://www.hetzner.com/cloud) | 2 vCPU / 4 GB / 40 GB / 20 TB | Docker, n8n, Caddy | Day one | **€5.99 ≈ $7.09** |
| [Porkbun .com](https://porkbun.com/products/domains) | Public hostname | Meta requires a publicly trusted TLS endpoint | Day one | **$11.08/yr = $0.92** |
| [Let's Encrypt](https://letsencrypt.org/) + [Caddy](https://caddyserver.com/docs/automatic-https) | TLS + renewal | HTTPS on the webhook | Day one | **$0** |
| [Telegram Bot API](https://core.telegram.org/bots/api) | Agent notification | The sheet does not ring | Day one | **$0** |
| [Healthchecks.io](https://healthchecks.io/pricing/) | Dead-man's-switch | Detects a workflow that **stopped running** | Day one | **$0** (20 jobs) |
| [UptimeRobot](https://uptimerobot.com/pricing/) | Uptime monitoring | Confirms the webhook is reachable | Day one | **$0** (50 monitors) |
| [Backblaze B2](https://www.backblaze.com/cloud-storage/pricing) | Off-site backup | A backup on the same VPS is not a backup | Day one | **$0** under the always-free 10 GB |
| A Jordanian phone line | The WhatsApp number | Must receive one SMS or call; cannot already be on WhatsApp | Day one | **Not priced** — carrier-dependent |
| | | | | **$8.01 + Meta** |

## 6. Conditional costs

| Service | What it is | Triggered by | Monthly |
|---|---|---|---|
| [Claude Haiku 4.5](https://platform.claude.com/docs/en/about-claude/pricing) | AI classification / draft replies | Switching auto-reply on | **$8.89** / **$29.64** / **$88.92** |
| Speech-to-text | Arabic voice notes | Voice notes on the desk | **Not priced — a real gap** |
| [Sentry](https://sentry.io/pricing/) | Error tracking | A second person operating the system | $0 (**1 user**) → **$26** |
| Transactional email ([SES](https://aws.amazon.com/ses/pricing/)) | Invitations, resets | Adding Chatwoot; a fresh VPS IP cannot deliver mail | **$0.10 per 1,000** |
| Self-hosted PostgreSQL | Replaces Sheets | ~300 conv/day — the 60-writes/min-per-user quota returns 429s | **$0** on the existing VPS |
| [Hetzner CX33](https://www.hetzner.com/cloud) | 4 vCPU / 8 GB / 80 GB | Adding Postgres or Chatwoot | **€8.99 ≈ $10.59** |
| [Chatwoot Community](https://www.chatwoot.com/pricing/self-hosted-plans) | Agent inbox, web + mobile | Agents who will not work in a spreadsheet | **$0/agent** |
| [Google Workspace](https://workspace.google.com/pricing.html) | Company-owned Google identity | The business must own the data | **$0** Essentials Starter (100 users, no Gmail) · **$7/user** Business Starter |
| [ngrok](https://ngrok.com/pricing) | Dev tunnel | Local testing only | **$0** (20,000 req/month) |

| Chatwoot official requirement | Figure |
|---|---|
| RAM | **4 GB**, rated to 10,000 conversations/day (8 GB for 20,000) |
| CPU | **4 cores** (8 for 20,000/day) |
| PostgreSQL host storage | 5–10 GB |
| Redis | from 100 MB |
| Swap | at least 1 GB |
| **Verdict** | **The existing 4 GB box qualifies — adding the inbox needs no VPS upgrade** |

---

## 7. AI pricing — caching does **not** apply

Claude Haiku 4.5's minimum cacheable prefix is **4,096 tokens**. This system's
stable prefix (routing rules + product snippet) is ~1,500 tokens, so no cache
discount is reachable. Estimates that assumed caching understated this by ~40%.

| Model | Input /MTok | Output /MTok | 30/day | 100/day | 300/day |
|---|---|---|---|---|---|
| **Claude Haiku 4.5** — what applies | $1.00 | $5.00 | **$8.89** | **$29.64** | **$88.92** |
| Claude Sonnet 5 | $2.00 | $10.00 | $17.78 | $59.28 | $177.84 |
| [OpenAI gpt-5-nano](https://openai.com/api/pricing/) | $0.05 | $0.40 | $0.55 | $1.82 | $5.47 |
| OpenAI gpt-4o-mini | $0.15 | $0.60 | $1.23 | $4.10 | $12.31 |

No cached figure is quoted here on purpose. Reaching the discount means growing
the stable prefix past 4,096 tokens, which also raises the token count on every
call — so the saving depends entirely on how large the new prefix is, and any
single number would be invented. Worth engineering only if a product catalogue or
FAQ block is going into the prompt anyway.

---

## 8. Jordanian tax

Applies to **every foreign vendor invoice** here: Meta, Hetzner, Anthropic,
Google, Porkbun, Sentry.

| Charge | Rate | Statute |
|---|---|---|
| **General sales tax on imported services** — self-assessed by you, the recipient | **16%** | General Sales Tax Law Art. 6(a); Art. 4 bis (e) covers imported electronic services; Art. 9(e) makes the recipient liable |
| **Withholding tax on payments to non-residents** | **10%** | Income Tax Law No. 34/2014 Art. 12(B)(1); remit within 30 days per Art. 12(E) |
| Registration deadline | 30 days | Art. 13(b) |
| Return frequency | Bi-monthly | Art. 16 |
| Input credit | Possible | Art. 19(c) |

| Multiplier | Value | Working |
|---|---|---|
| **Gross cash out** | **×1.2889** | 10% withholding grossed up (1 ÷ 0.9 = 1.1111) × 1.16 GST. Shown as ×1.289 elsewhere; totals use the unrounded value |
| Net, if GST is creditable against your output tax | ×1.111 | Withholding gross-up only |
| Cross-border / FX fee on a Jordanian card | +2–3% | Not included in the ×1.289 above |

Meta's terms put this on you: amounts *"may be subject to and include applicable
taxes and levies, including withholding taxes."*

---

## 9. Monthly total, line by line

### Today — the regime actually in force

| Line | 30 conv/day | 100 conv/day | 300 conv/day |
|---|---|---|---|
| Meta messages | **$0.00** | **$0.00** | **$0.00** |
| VPS | $7.09 | $7.09 | $10.59 |
| Domain | $0.92 | $0.92 | $0.92 |
| n8n · Sheets · TLS · Telegram · monitoring · backups | $0.00 | $0.00 | $0.00 |
| AI — Haiku 4.5, uncached | $8.89 | $29.64 | $88.92 |
| Sentry | $0.00 | $26.00 | $26.00 |
| **Vendor invoices** | **$16.90** | **$63.65** | **$126.43** |
| **+ tax and FX (×1.2889)** | **$21.78** | **$82.04** | **$162.95** |
| Maintenance hours | 4–6 | 8–10 | 12–16 |
| **True total at $20/h** | **$122** | **$262** | **$443** |

### Planning estimate — if the October change lands at $0.0091

| Line | 30 conv/day | 100 conv/day | 300 conv/day |
|---|---|---|---|
| Service messages sent | 2,736 | 9,120 | 27,360 |
| Less free allowance | −1,000 | −1,000 | −1,000 |
| Billable | 1,736 | 8,120 | 26,360 |
| **Meta messages @ $0.0091** | **$15.80** | **$73.89** | **$239.88** |
| Everything else | $16.90 | $63.65 | $126.43 |
| **Vendor invoices** | **$32.70** | **$137.54** | **$366.31** |
| **+ tax and FX (×1.2889)** | **$42.15** | **$177.27** | **$472.13** |
| **True total at $20/h** | **$142** | **$357** | **$752** |
| Meta's share of the invoice | 48% | 54% | 65% |

### Basis of every figure

| Assumption | Value |
|---|---|
| Month length | 30.4 days |
| Agent replies per conversation | 3 |
| Inbound customer messages per conversation | 3 (free, uncharged) |
| AI calls per month | 1 per inbound message |
| AI tokens per call | ~2,000 input, 250 output, **text only** |
| Free service allowance | 1,000/month per business phone number, no roll-over |
| Service rate used | $0.0091 — **planning assumption, not confirmed** |
| Maintenance rate | $20/h, illustrative |
| Hours used in the total | 5 / 9 / 14 |
| EUR→USD | ~1.18, for Hetzner's EUR invoices |
| Jordanian tax | ×1.2889 gross |

---

## 10. What could not be verified

| Claim | Status |
|---|---|
| **Jordan's post-1-October service rate** | ⚠️ **Unknown officially.** No October 2026 rate card is published |
| **1,000 free service messages / 30 Sept payment deadline** | Reported by multiple BSPs; **absent from every fetchable Meta page** |
| Marketing at $0.0392 | **Not a current figure.** Confirmed today: $0.0341 |
| Cloudflare Registrar .com price | No figure outside the logged-in dashboard. ~$10.46 derived from ICANN's schedule |
| Meta Business verification fee | Very likely $0; not stated on any reachable page |
| Jordanian SIM / DID cost | Not priced from a carrier's own page |
| n8n Enterprise, Embed, OEM prices | Not published at all — quote-only |
| Commercial-use permission at the paid VPS providers | Ordinary paid hosting, but no licence text was quoted |
| Hetzner: is primary IPv4 already in the listed price? | Prices render via JavaScript. Every Hetzner figure may be €0.50/mo too high — **in your favour** |
| **Do Coexistence replies count as billable service messages?** | **The most important open question for this architecture.** Ask Meta directly |

## 11. Cost lines still missing

| Line | Why it matters |
|---|---|
| **Arabic speech-to-text** | Voice notes are routine on a Jordanian desk; the AI model here is text-only |
| **Vision tokens** | One inbound photo or invoice can exceed the entire 2,000-token input budget |
| **WhatsApp media retention** | Cloud API media URLs expire; keeping attachments means downloading and storing them. The $0 backup figure assumes a ~10 MB/day text export |
| **WhatsApp Business Calling API** | Business-initiated calls billed by duration in six-second pulses — a live meter on the same number |
| **WhatsApp Groups API** | Billed per recipient per delivered message |
| **Jordan PDPL No. 24 of 2023** | This system processes third parties' message content; resale implies a privacy notice and lawful basis per client |
| **Secrets management** | A team holding Meta tokens, AI keys and VPS credentials |
| **One-time build and migration labour** | Including the Sheets→Postgres move this document says becomes necessary at 300/day |

## 12. Corrected during verification

| Was | Is |
|---|---|
| AI line assumed prompt caching | **Caching does not apply** — Haiku 4.5 needs a 4,096-token prefix, this system has ~1,500 |
| AI line computed on a 30-day month while Meta used 30.4 | **Both now on 30.4 days** — AI is $8.89/$29.64/$88.92, not $8.78/$29.25/$87.75 |
| $0.0091 service and $0.0392 marketing presented as published October figures | **No October rate card exists.** Today's marketing rate is $0.0341 |
| In-window utility templates become billable in October | **They stay free** — verbatim, with the billing webhook to prove it |
| Chatwoot needs 8 GB RAM | **4 GB and 4 cores**, rated to 10,000 conv/day. No VPS upgrade needed |
| n8n Business is a Cloud plan | **Self-hosted.** n8n Cloud tops out at Pro |
| Company-owned Sheets costs $7/user | **Workspace Essentials Starter is $0** for up to 100 users |
| Jordanian tax absent from every estimate | **16% GST self-assessed + 10% withholding = ×1.2889** |
| Iraq, Kuwait, Oman rates rise in October | **Iraq's go down**; all three become standalone markets |
| Porkbun .xyz renews at $14.21 | **$16.00** from 25 Aug 2026 |
| "$7.50/month all-in" | **$122-$443/month** true cost, depending on volume |
| A hypothetical prompt-cached AI figure was quoted | **Removed.** It cannot be computed without deciding how large the new prefix would be |
| 300/day taxed totals were $162.97 and $472.17 | **$162.95 and $472.13** — the earlier figures rounded the tax multiplier before multiplying |
| Five replies instead of three was called a 67% rise | **69%** |
| A window lapse was called "4x more" | Marketing is **3.75x** the utility rate |

---

## 13. The risk if you sell this

| Risk | Detail |
|---|---|
| **No auditable number** | Meta publishes no per-country rate at a durable URL. You cannot show a client the figure you are billing them for |
| **No volume discount, ever** | Meta states it will not offer volume tiers for service messages. The one line that grows with the product can never be negotiated down |
| **No price protection** | The rate card may change at any time, effective the 1st of the following month |
| **Region being re-cut** | Iraq, Kuwait and Oman leave *Rest of Middle East* on the same day charging is said to begin |
| **You do not control the driver** | The bill is per outbound reply. Five replies instead of three raises it **69%** |
| **Window lapses are the 4× trap** | Letting the 24 h window close converts a free reply into a $0.0091 utility template, or a $0.0341 marketing one — **3.75× the utility rate** |
| **Tax is on you** | ×1.2889 on every pass-through, self-assessed, with 30-day registration and bi-monthly returns |
| **Licence exposure** | Hosting clients' workflows on your n8n instance requires an Enterprise licence at an unpublished price |

| Conclusion | Action |
|---|---|
| A fixed monthly fee makes you the counterparty to an uncapped, monthly-repriceable cost | **Bill Meta message fees as a pass-through at cost** |
| n8n's licence does not permit the resale shape | **Choose the engine as a licence decision** — see [ALTERNATIVES.md](ALTERNATIVES.md#recommendations) |
| Coexistence halves throughput and may be billable | **Get Meta's answer in writing before scaling** |
