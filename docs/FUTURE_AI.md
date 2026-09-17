# Future: AI Layer

**Not built, and deliberately so.** This documents where AI can be added, where
it must not go, and the integration points the current design already provides.

---

## The rule that matters most

> **Do not put AI in the critical message-routing path.**

If an AI call sits between "customer message arrives" and "conversation is
created and assigned", then every AI failure becomes a lost customer message:

| AI failure | Consequence in the routing path |
|---|---|
| API outage | Messages are not routed at all |
| Latency spike | Webhook slow → Meta retries → duplicate processing |
| Rate limit | Same as outage |
| Hallucinated classification | Silently wrong routing, hard to detect |
| Cost spike | Every inbound message becomes billable |

Routing is deterministic, tested, and free. Keep it that way, and let AI
**enrich** conversations that have already been safely routed.

---

## Correct integration shape

```
Customer message
      │
      v
[1] Webhook Receiver ──────► 200 ack
      │
      v
[2] Message Processor
      │
      v
[3] Conversation & Assignment    ◄── ROUTING COMPLETE, DETERMINISTIC
      │                              Nothing above depends on AI.
      │
      ├──────────────► [7] AI Enrichment  (async, best-effort)
      │                       │
      │                       ├── intent classification
      │                       ├── sentiment
      │                       ├── summary
      │                       └── suggested reply  ──► stored as a DRAFT
      v
Agent works the conversation, with AI output as advice
```

The enrichment workflow runs **after** assignment, asynchronously. If it fails,
the conversation is still created, still assigned, and still answerable — the
agent simply does not get a suggestion.

---

## Where the seams already are

The current design leaves three clean insertion points that need no
restructuring:

1. **After assignment in workflow 3.** Add a branch that calls an enrichment
   sub-workflow without blocking persistence.
2. **The Log sheet/table.** AI output can be recorded as events without
   changing any existing schema.
3. **Workflow 4's request shape.** A suggested reply is just a `text` value an
   agent chooses to send — the send path needs no AI awareness at all.

---

## Candidate features, ranked by value and risk

| Feature | Value | Risk | Where it runs |
|---|---|---|---|
| **Conversation summary** | High | Low | After assignment, async |
| **Suggested reply (draft only)** | High | Low if never auto-sent | After assignment, async |
| **Intent classification** | Medium | Low | After assignment, async |
| **Sentiment / urgency flag** | Medium | Low | After assignment, async |
| **FAQ auto-answer** | High | **High** | Only with explicit guardrails |
| **AI-driven routing** | Medium | **High** | Not recommended |
| **Fully automated replies** | High | **Very high** | Not recommended for support |

### Summary and suggested reply first

These are the safest and most immediately useful. A wrong summary costs an agent
five seconds. A wrong auto-reply costs a customer relationship.

### On FAQ auto-answer

Tempting, and genuinely valuable — but it is the point where AI starts talking
to customers unsupervised. If you build it:

- Require a **high confidence threshold**; below it, escalate silently to a human
- Restrict to a **closed set of approved answers**, not free generation
- Always leave the conversation assigned to a human as well
- Make the customer's path to a human obvious and immediate
- Log every auto-answer for review
- Start with a **shadow mode**: generate the answer, show it to the agent, send
  nothing. Compare against what agents actually sent for a few weeks before
  enabling.

### On AI-driven routing

Routing by predicted topic or complexity sounds appealing, but:

- It replaces a deterministic, tested, free decision with a probabilistic, paid,
  hard-to-audit one
- "Why did Sara get this?" becomes unanswerable
- The current audit trail records exactly why each agent was chosen or excluded;
  an AI decision cannot match that

If you want topic-based routing, classify the topic with AI *as an enrichment*,
then route on that field **deterministically**. That keeps the routing decision
auditable while still using the AI signal.

---

## Sketch of the enrichment workflow

```
Execute Workflow Trigger  (called async from workflow 3)
   │
   v
Build Context
   • last N messages for this conversation
   • customer name, conversation age
   • NO credentials, NO other customers' data
   │
   v
Call model API   (timeout 10s, 1 retry, neverError)
   │
   ├── success → Parse & validate the response shape
   │                → Store enrichment (intent, sentiment, summary, draft)
   │                → Record an Events row
   │
   └── failure → Record an Events row and STOP.
                 The conversation is untouched and still workable.
```

The failure branch is the important part: enrichment failing must be a
non-event operationally.

### Suggested schema addition

```sql
CREATE TABLE conversation_enrichment (
    conversation_id  TEXT PRIMARY KEY REFERENCES conversations(conversation_id),
    intent           TEXT,
    intent_confidence NUMERIC(4,3),
    sentiment        TEXT,
    urgency          TEXT,
    summary          TEXT,
    suggested_reply  TEXT,
    model            TEXT NOT NULL,      -- which model produced this
    prompt_version   TEXT NOT NULL,      -- so results stay comparable
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Recording `model` and `prompt_version` matters: without them, a change in either
silently invalidates every comparison you might later want to make about
quality.

---

## Privacy and data handling

Customer messages are personal data. Sending them to a third-party model
provider is a **data processing decision**, not just a technical one.

| Consideration | Action |
|---|---|
| Consent and disclosure | Check whether your privacy notice covers this |
| Data residency | Where does the provider process and store? |
| Training on your data | Use an API tier that excludes it |
| Retention | Prefer zero-retention endpoints where available |
| Minimization | Send the last few messages, never the whole history by default |
| PII redaction | Consider stripping phone numbers before sending |
| Self-hosting | An on-premise model avoids the question entirely |

For a support system handling Jordanian customers, verify obligations before
sending anything to an external provider.

---

## Cost

AI has a **per-message marginal cost** — the only line in this system that
grows with every conversation. At the cheap end of current model pricing it is a
few dollars a month at 30 conversations a day and a few tens at 300; the exact
figure depends entirely on the provider, the model and how long the prompt is,
so it is not worth quoting one here.

Note that Meta bills the delivery separately and **does not charge differently
for an automated reply** — see [COSTS.md](COSTS.md).

Before enabling anything:

1. Estimate messages/month
2. Estimate tokens per enrichment (context + output)
3. Multiply, and add headroom for retries
4. Decide whether enrichment runs on **every** message or only on new
   conversations

Enriching only the **first** message of a conversation is usually most of the
value at a fraction of the cost.

Set a hard spend cap at the provider. An enrichment loop triggered by a retry
storm can generate a surprising bill.

---

## Recommended sequence

1. **Do nothing until routing is proven in production.** Fix the real bottleneck
   first — which is currently that agent replies are invisible unless sent
   through the API.
2. **Shadow mode summaries.** Generate, store, show to agents, measure whether
   they help.
3. **Suggested replies as drafts.** Never auto-sent. Measure acceptance rate.
4. **Intent classification as an enrichment field**, with deterministic routing
   on it if it proves accurate.
5. **FAQ auto-answer**, only with the guardrails above, and only after months of
   shadow data.

Steps 2–4 are low-risk and reversible. Step 5 changes what customers experience
and should not be rushed.

---

## What must not change

Whatever is added:

- The webhook must still ack in under 100 ms
- Conversation creation and assignment must not depend on any AI call
- An AI outage must degrade the system to "no suggestions", never to "no routing"
- Every AI-generated action must be attributable and reviewable
- A customer must always be able to reach a human
