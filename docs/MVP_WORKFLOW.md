# The MVP workflow

`n8n/workflows/00-mvp-inbound.json` — the entire inbound path in one workflow.

Workflows 1, 2 and 3 split receive / parse / resolve across three workflows
joined by Execute Workflow calls. This does the same work in one, adds request
classification, and drops the agent-load counter that made workflow 3 need
`concurrency: 1`.

| | Workflows 1+2+3 | This |
|---|---|---|
| Workflows | 3 | 1 |
| Nodes | 44 | 23 |
| Sub-workflow hops per message | 2 | 0 |
| Agent load | counter in `Agents`, can drift | counted from `Conversations` |
| Requires concurrency 1 | yes | no |
| Classifies the request | no | yes |

---

## It does not conflict with workflows 1-8

That is enforced, not just intended:

| | Workflows 1-8 | MVP |
|---|---|---|
| Workflow id | `whatsappRecv0001` … | `whatsappMvp00001` |
| Webhook path | `/webhook/whatsapp/webhook` | `/webhook/whatsapp/mvp` |
| Writes `Agents.open_conversations` | yes | **never — read only** |

Both sets can be imported and active at the same time. Only the one Meta
actually calls does any work, because Meta posts to a single URL.

Sheet changes are additive and appended at the END of each header row, so
existing data does not shift: a `category` column on `Conversations` and
`Messages`, and a new `Categories` tab. Workflows 1-8 ignore all of it.

> **Switching back to workflows 1-3 later?** Run **WhatsApp Support →
> Recalculate agent workload** from the sheet menu first. The MVP never writes
> `open_conversations`, so that counter will be stale by however many
> conversations the MVP handled.

---

## The path

```
Meta ──POST(signed)──► Verify Signature ──► Ack 200 ──► Parse & Normalize
                              │                              │
                              └─ invalid ──► 401             ▼
                                                    Route By Event Kind
                                                    │                │
                                         customer_message      everything else
                                                    ▼                ▼
                                            Lookup Duplicate     (ignored)
                                                    ▼
                                  Read Conversations · Agents · Categories
                                                    ▼
                                      Resolve, Classify & Assign
                                                    ▼
                                  Conversations ─► Messages ─► Log
```

The 200 goes out **before** any Sheets I/O, so a slow spreadsheet can never make
Meta retry and double-deliver.

### Agent load is counted, not stored

Workflow 3 increments `Agents.open_conversations` on every assignment. Google
Sheets has no atomic compare-and-set, so two executions can read the same value
and both write it back — which is why workflow 3 runs with `concurrency: 1` and
why the Apps Script ships a repair tool.

This workflow counts open conversations from the `Conversations` rows it has
already read for the lookup. There is no second copy of the truth, so there is
nothing to drift, nothing to repair, and no write to serialize.

Within a single batched webhook the count is incremented in memory as each
assignment is made, so two customers arriving in one POST do not both get handed
to the same idle agent.

---

## The `Categories` tab

| Column | Meaning |
|---|---|
| `category_id` | Stable key, e.g. `C-PRICE` |
| `name` | What appears in the `category` column |
| `keywords` | Comma-separated. `,` `،` `\|` `;` all work |
| `priority` | **Lower wins a tie.** Complaints at 5 beat pricing at 20 |
| `active` | Uncheck to switch a category off without deleting it |
| `notes` | Free text for whoever maintains the list |

Add a product line by adding a row. No rebuild, no re-import, no developer.

**Matching rules** — Arabic is normalized first (diacritics stripped, alef /
teh-marbuta / alef-maksura variants unified, Arabic-Indic digits converted), so
one keyword covers the ways people actually type it:

- Arabic keywords match as substrings, because the definite article and
  conjunctions are written joined to the noun — the bare noun matches inside the
  prefixed form.
- Latin keywords match whole words only. Substring matching would make a keyword
  like `ac` match `back`.
- The category with the **most** keyword hits wins; `priority` breaks the tie,
  then `category_id`. The same message always lands in the same category.

**What is deliberately not classified:** a message with no words. An image with
a caption is classified on the caption, but a bare location or voice note is
not — its preview reads `[location] …`, and matching that against a keyword like
`location` would file a confident false positive. Those get the fallback
category `غير مصنّف` with reason `no_text_to_classify`, recorded in `Log`.

On a follow-up message the conversation's category only changes if the new
message actually matched something. An unmatched *"tamam, shukran"* does not
reset a conversation to the fallback.

---

## What it does NOT do

Deliberate MVP scope. Each is handled by the existing workflows if you need it.

| Not handled | Consequence | Where it lives |
|---|---|---|
| Delivery receipts (sent/delivered/read) | `Messages.status` stays `RECEIVED` | Workflow 2 |
| Business App echoes (Coexistence) | **Conversations stay `UNANSWERED` even after an agent replies** | Workflow 2 |
| Sending replies | No outbound path | Workflows 4 and 7 |
| Notifying the assigned agent | The sheet does not ring — response time still depends on someone looking | Not built yet |
| Retrying the unassigned queue | `WAITING_FOR_AGENT` rows sit until a new message arrives | Workflow 5 |

The echo gap is the one that matters operationally: without it, status tracking
is one-directional. The MVP proves the inbound path; closing the loop is the
next step.

---

## Running it

```bash
node scripts/setup/build-workflows.js
node scripts/setup/import-workflows.js
```

**Importing deactivates the workflow.** Re-activate it afterwards — in the UI, or:

```bash
docker exec n8n-whatsapp n8n update:workflow --id=whatsappMvp00001 --active=true
docker restart n8n-whatsapp     # activation needs a restart
```

Then point the Meta webhook at `https://<your-host>/webhook/whatsapp/mvp` and
run `setupEverything` from the sheet's Apps Script so the `Categories` tab and
the `category` columns exist. Seeding is safe to re-run: it writes the starter
categories only into an empty tab and never overwrites rows you have tuned.

### Errors are visible, not silent

The three data writes (`Append Conversation`, `Update Conversation`,
`Append Message`) and the two critical reads (`Read Conversations`,
`Read Agents`) use `onError: stopWorkflow`. A failure marks the execution
**failed** instead of reporting success while the row goes nowhere.

This is not theoretical. Run against a live n8n with no Sheets credential, the
first build reported `n8n.workflow.success` while `Append Conversation`
"finished" in 2 ms and wrote nothing. After the change the same request records
`n8n.workflow.failed`.

`Read Categories` and `Audit Decision` stay non-fatal on purpose: a missing
category or a lost audit line must never stop a customer's message from being
recorded. `Lookup Duplicate` is also non-fatal — a failed dedupe check risks
writing a duplicate row, which is recoverable, where failing closed would drop a
real customer message, which is not.

---

## Verified

Run live against n8n 2.38.5 on 2026-09-11:

| Check | Result |
|---|---|
| `GET` handshake, correct token | 200, challenge echoed |
| `GET` handshake, wrong token | 403 |
| `POST` unsigned | 401 — fails closed |
| `POST` signed | 200 `EVENT_RECEIVED` |
| Node graph executes in order | Verify → Ack → Parse → Route → Lookup → Read … |
| Missing credentials | execution recorded as **failed** |

**Not verified — needs a Google service account:** the Sheets writes themselves,
classification against a real `Categories` tab, and assignment against real
`Agents` rows. Same blocker as the rest of the project; see
[SETUP.md](SETUP.md).

Covered by tests without credentials: 57 of the 231 unit tests, including
`tests/mvp/resolve-node.test.js`, which extracts the decision node's **generated
JavaScript** out of `00-mvp-inbound.json` and runs it against the real Meta
fixtures with `$()` and `$env` stubbed. That is what catches composition bugs —
reading the wrong field off an event, or letting a raw phone number overwrite a
normalized one — which no library test would see.

```bash
node tests/run-tests.js mvp
```
