# WAHA connector — a normal WhatsApp number, no deletion, no Meta approval

A second way to get a WhatsApp number into this system, alongside the Meta
Cloud API path in [META_WHATSAPP_SETUP.md](META_WHATSAPP_SETUP.md). Pick one
per number; `WHATSAPP_CONNECTOR` selects which.

Source: [WAHA documentation](https://waha.devlike.pro/docs/), verified
2026-09-17. For WAHA's own configuration, security model and API — and where
this deployment departs from the official recommendations — see
[WAHA_REFERENCE.md](WAHA_REFERENCE.md).

---

## What this is, and is not

[WAHA](https://waha.devlike.pro/) (WhatsApp HTTP API) links a number the same
way WhatsApp Web does: open the WAHA dashboard, scan a QR code with the phone
that already has WhatsApp on it. **The number is not deleted, converted, or
touched on Meta's side at all** — it keeps its existing account and chat
history. This is what makes it fit the request that started this: connect the
number you already use, without erasing anything, and route what comes in to
your team through the same Sheet-based assignment this project already has.

**It is not sanctioned by Meta.** WAHA works by automating WhatsApp Web/the
multi-device protocol, which WhatsApp's Terms of Service do not permit. There
is a real, unpredictable risk of the number being banned, with no advance
warning and no appeal process most people have found reliable. Do not put a
number here that the business cannot afford to lose. WAHA ships some
mitigation (steady session, no burst sending) but mitigation is not
elimination — this document makes no claim otherwise.

If the number matters enough to insure, the Meta Cloud API path is the one
with an actual compliance story. This connector is for exactly the case you
described: get connected today, keep n8n and the Sheet exactly as they are,
decide on Meta later if it turns out to matter.

---

## How it fits the existing system

```
WhatsApp (your phone)
      |  WhatsApp Web protocol (QR-linked)
      v
WAHA container ── same Docker network as n8n
      |  POST, HMAC-SHA512 signed
      v
[1b] WAHA Webhook Receiver  ── verifies HMAC, adapts the payload into the
      |                         SAME envelope shape workflow 2 already parses
      |                         from Meta
      v
[2] Message Processor  ── UNCHANGED — dedup, routing by event kind
      v
[3] Conversation & Assignment  ── UNCHANGED — same Sheet, same round-robin
```

Workflow 1b is new. Workflows 2, 3, 5, 6, 8 are **untouched** — WAHA's events
are translated into Meta's own webhook shape before they reach them, so every
already-verified piece of dedup and assignment logic runs unmodified. Only the
two outbound send paths (workflow 4, and workflow 7's "type into the sheet,
it goes out within a minute") were touched, and only to add a second branch:
`WHATSAPP_CONNECTOR=meta` still takes the exact code path it always did.

---

## How the workflow is built

`scripts/setup/build-waha-receiver.js` generates
`n8n/workflows/01b-waha-webhook-receiver.json`, the WAHA-side twin of the Meta
receiver. It is a generator for the same reason the others are: n8n Code nodes
cannot import host files, so the tested libraries in `scripts/lib/` are inlined
at build time and the running code stays identical to the code under test.

```bash
node scripts/setup/build-waha-receiver.js
node scripts/setup/import-workflows.js
```

---

## Setup

1. `docker compose up -d` — this now also starts the `waha` container.
2. Open `http://localhost:3000/dashboard` (header `X-Api-Key: <your WAHA_API_KEY
   from .env>`) and start the `default` session.
3. Scan the QR with the phone — **WhatsApp app → Linked Devices → Link a
   Device**, same flow as WhatsApp Web.
4. Send yourself a test message from another phone. It should appear as a new
   row within a few seconds, and get assigned exactly like a Meta-sourced
   message would.
5. To reply: type into `reply_text` in the Sheet as usual (workflow 7 polls
   every minute), or POST to workflow 4's webhook directly.

`WHATSAPP_CONNECTOR=waha` in `.env` is what routes replies through WAHA
instead of Meta — the Meta credentials above it are untouched and still work
if you flip it back to `meta`.

---

## Scope of this first cut — read before trusting it

This was built and wired in one session, to get a real QR-linkable session
running today. It has **not** been proven the way the rest of this system's
"Live and verified" status in the README has (see there for what *that* level
of proof looks like — a real send, a real webhook, captured and checked).

| Piece | Status |
|---|---|
| WAHA container starts, reports healthy, serves a QR | **Verified this session** |
| n8n container still starts and passes all 192 unit tests + workflow validation with these changes | **Verified this session** |
| A real message scanned-and-sent round trip (phone → Sheet → reply → phone) | **Not yet done** — needs a phone to scan the QR, which this session cannot do for you |
| Media messages (image/audio/document) via WAHA | **Not handled yet** — arrive as a placeholder text row, not dropped, not crashed on, but not usable content |
| Group messages | Not scoped in this first cut |
| HMAC verification on the WAHA→n8n webhook | Implemented, unit-validated by the workflow linter, **not yet exercised against a real signed WAHA request** |

Treat this the way the rest of the project's own conventions ask you to:
"built and unit-tested" is not "verified live" until someone actually scans
the code and watches a message land in the Sheet. Do that before relying on
it for a real conversation.

## Known gaps to close next

- Media handling in workflow 1b's adapter (`Adapt To Meta Envelope` node).
- A real end-to-end proof script, mirroring
  `scripts/testing/verify-live.js`, for the WAHA path.
- Session-loss recovery: if `.sessions` is lost (volume removed), the number
  needs re-scanning. No alerting on that yet.
- Multi-number: this first cut assumes one WAHA session (`default`). WAHA
  supports more; the adapter's `business_phone_number_id` is already derived
  from the session name so multi-session should mostly work, but is untested.
