# n8n Assets

## `workflows/` — GENERATED, do not hand-edit

Every file here is produced by
[`scripts/setup/build-workflows.js`](../scripts/setup/build-workflows.js).

```bash
node scripts/setup/build-workflows.js          # generate
node scripts/validation/validate-workflows.js  # verify
node scripts/setup/import-workflows.js         # import into the container
```

### Why they are generated

n8n Code nodes cannot `require()` files from the host, so business logic pasted
into a workflow is a **copy**. Copies drift — the tests keep passing while the
thing actually running quietly diverges.

The builder inlines `scripts/lib/*.js` byte-for-byte into the Code nodes, so the
tested code and the running code are the same code by construction.

### Consequences

- **Editing a workflow in the n8n UI is temporary.** The next import overwrites
  it, and the change is never covered by tests.
- To change logic, edit `scripts/lib/`, add tests, rebuild, re-import.
- To change structure (nodes, wiring, parameters), edit the builder.

Experimenting in the UI is fine — just move the change back into the builder
before relying on it.

### Files

| File | Workflow | Pinned id |
|---|---|---|
| `01-webhook-receiver.json` | Webhook Receiver | `whatsappRecv0001` |
| `02-message-processor.json` | Incoming Message Processor | `whatsappProc0002` |
| `03-conversation-assignment.json` | Conversation & Assignment | `whatsappConv0003` |
| `04-outgoing-agent-message.json` | Outgoing Agent Message | `whatsappSend0004` |
| `05-unassigned-queue-retry.json` | Unassigned Queue Retry | `whatsappQueu0005` |
| `06-error-handler.json` | Error Handler | `whatsappErrH0006` |

Ids are pinned so `n8n import:workflow` **updates** these workflows instead of
creating a new copy on every run, and so Execute Workflow cross-references are
already correct in the generated JSON.

Full descriptions: [`docs/N8N_WORKFLOWS.md`](../docs/N8N_WORKFLOWS.md).

---

## `fixtures/` — Meta webhook payloads

Real-shape payloads, verified against
[Meta's webhook documentation](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components)
on 2026-09-09. Used both by the unit tests and by the live fixture sender, so
the same data proves the logic and the deployment.

| File | Exercises |
|---|---|
| `text-message.json` | Arabic text — the worked example from the spec |
| `image-message.json` | Media with caption, media id, mime type |
| `location-message.json` | A message with no text body |
| `unsupported-type.json` | A message type Meta has not invented yet |
| `batched-multiple-messages.json` | 4 messages across 2 business numbers in one POST |
| `status-delivered.json` | Delivery receipt with pricing/billability |
| `status-failed.json` | Failure with error 131047 (24-hour window) |
| `malformed-payload.json` | A change containing neither messages nor statuses |

### Sending them

```bash
node scripts/testing/send-fixture.js                          # all, signed
node scripts/testing/send-fixture.js text-message.json        # one
node scripts/testing/send-fixture.js text-message.json --bad-signature
node scripts/testing/send-fixture.js text-message.json --no-signature
node scripts/testing/send-fixture.js text-message.json --twice   # duplicate
```

The sender computes `X-Hub-Signature-256` exactly as Meta does — HMAC-SHA256
over the raw file bytes — so a passing test genuinely exercises the production
signature path.

**These contact nobody.** No WhatsApp message is sent, no Meta API is called,
nothing costs money.

### Adding a fixture

1. Capture a real payload from n8n's execution log (or Meta's docs).
2. **Replace real phone numbers and message ids** with obviously fake ones.
3. Save it here and add assertions in `tests/webhook/parser.test.js`.

Fixtures are committed to git, so they must never contain real customer data.

---

## Importing

```bash
node scripts/setup/import-workflows.js          # import (idempotent)
node scripts/setup/import-workflows.js --list   # show what n8n has
```

Workflows are imported as **drafts**. Publishing is a deliberate, separate step
— see [`docs/SETUP.md`](../docs/SETUP.md#step-7--configure-the-workflows).

> Two n8n CLI gotchas found the hard way:
>
> - **Never pipe `n8n publish:workflow` into `head`** — the pipe closing sends
>   SIGPIPE and the command hangs indefinitely.
> - **`--activeState=fromJson` does not work here** — it requires queue or
>   multi-main mode.
