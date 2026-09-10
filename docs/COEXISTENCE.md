# WhatsApp Coexistence — replies from the app become visible

**This solves the biggest limitation in the original design.**

Sources, verified 2026-09-10:
- [`smb_message_echoes` webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes)
- [WhatsApp webhooks overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview)
- [Onboard WhatsApp Business app users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)

---

## The problem it fixes

Without Coexistence, a phone number is either on the **WhatsApp Business App**
or on the **Cloud API** — not both. And Meta only emits webhooks for messages
sent *through the API*.

So when an agent clicked the `wa.me` link and replied from their phone:

- the customer got an answer
- the system saw **nothing**
- the conversation stayed `UNANSWERED` forever
- response-time reporting was meaningless
- the agent's `open_conversations` never went down

This was documented as an unavoidable platform constraint. **It no longer is.**

---

## What Coexistence does

Meta rolled this out in **May 2025**. One phone number runs the WhatsApp
Business App **and** the Cloud API at the same time, with messages mirrored in
both directions:

| Direction | Behaviour |
|---|---|
| API sends a message | It appears in the WhatsApp Business App |
| **App sends a message** | **A `smb_message_echoes` webhook is delivered to us** |
| Customer sends a message | Arrives in both |

The second row is the one that matters. An agent replying from their phone now
produces a webhook, so the reply is tracked exactly like an API reply.

---

## What this system does with it

Implemented in [`scripts/lib/webhook-parser.js`](../scripts/lib/webhook-parser.js)
and the echo branch of workflow 2.

An echo is parsed as `kind: 'echo'`, `direction: 'outbound'`, and then applied to
the conversation through the **same** `buildAgentMessageUpdate()` used for API
replies. The result:

| Field | Effect of an app reply |
|---|---|
| `status` | → `REPLIED` |
| `last_agent_message_at` | set to the reply time |
| `last_message_direction` | `outbound` |
| `unread` | → `FALSE` |
| `Messages` row | appended with `sent_via = whatsapp_business_app` |

`sent_via` is what lets reporting distinguish the three reply paths:

| `sent_via` | Meaning |
|---|---|
| *(empty)* / `cloud_api` | Sent through workflow 4 |
| `whatsapp_business_app` | An agent typed it on their phone |
| `google_sheet` | Typed into the sheet (workflow 7) |

### The trap this avoids

In an echo, **`from` is the business and `to` is the customer** — reversed from
a normal `messages` payload.

Reading `from` as the customer would file the agent's own reply under the
business's phone number, create a phantom conversation, and flip the real one to
`UNANSWERED`. There is a dedicated test asserting the correct attribution.

### Revoke and edit

Echoes also carry `revoke` (message deleted) and `edit` types. These are
recorded as control events but **do not** advance conversation state — deleting
a message is not answering a customer.

---

## What it cannot do

Be clear about the boundary:

| | Tracked? |
|---|---|
| Agent replies from the **WhatsApp Business App** on the business number | **Yes** |
| Agent replies from a **linked companion device** (WhatsApp Web on the business account) | **Yes** |
| Agent replies from their **own personal WhatsApp** to the customer | **No** — different number, nothing to do with our WABA |
| Messages sent **before** Coexistence was enabled | **No** — only new messages are mirrored |

The `wa.me` link in the sheet opens a chat from *whatever WhatsApp account the
clicker is signed into*. If that is a personal account, the reply is still
invisible. Coexistence tracks the **business number**, not the person.

---

## Requirements and trade-offs

| Requirement | Detail |
|---|---|
| WhatsApp **Business App** (not regular WhatsApp) | The number must be registered on it |
| Onboarding via Embedded Signup | Coexistence is enabled during that flow |
| **The app must be opened at least once every 13 days** | Otherwise the account goes inactive |
| Extra webhook subscriptions | `smb_message_echoes`, and optionally `smb_app_state_sync` |

The 13-day rule is an operational obligation, not a technical one — but if the
business phone sits in a drawer, Coexistence silently stops working. Assign it
to someone.

---

## Enabling it

1. Register the number on the **WhatsApp Business App**.
2. Onboard through Meta's Embedded Signup flow, choosing the Coexistence path
   for an existing Business App user.
3. In *WhatsApp → Configuration → Webhook fields*, subscribe to:
   - `messages` (already required)
   - **`smb_message_echoes`** — app-sent replies
   - `smb_app_state_sync` *(optional)* — contact sync from the app
4. No change is needed on this side. Workflow 2 already routes `echo` events;
   they simply start arriving.

Test it: send a reply from the WhatsApp Business App and confirm the
conversation moves to `REPLIED` with `sent_via = whatsapp_business_app`.

Locally, without Meta:

```bash
node scripts/testing/send-fixture.js echo-agent-reply.json
node scripts/testing/send-fixture.js echo-revoke.json
```

---

## Which reply path should a company use?

All three now work and all three are tracked. They suit different people.

| Path | Best for | Speed | Notes |
|---|---|---|---|
| **WhatsApp Business App** (Coexistence) | Agents who want a real chat UI, media, voice notes | Instant | Feels like normal WhatsApp; nothing to learn |
| **Google Sheet `reply_text`** (workflow 7) | Managers and occasional responders | ≤ 60s | Zero setup, works from any browser |
| **API `/webhook/agent/send`** (workflow 4) | The future agent inbox, automation | Instant | Programmatic |

A realistic setup: agents work in the **Business App** for speed, supervisors
use the **sheet** for oversight and occasional replies, and the API is reserved
for the inbox when it is built. Every one of those is recorded in the same
`Messages` table with `sent_via` telling you which was used.

---

## Effect on the architecture

The "agent access model" section of
[ARCHITECTURE.md](ARCHITECTURE.md#agent-access-model) described path C —
external replies — as permanently invisible. With Coexistence enabled, **path C
becomes visible**, and the strongest argument for building the agent inbox
weakens considerably.

The inbox is still worth building for queueing, search, internal notes, SLA and
analytics. But "we cannot see agent replies" is no longer a reason to rush it.
