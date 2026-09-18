# Future: full independence from WAHA's own dashboard

**Partially built already.** A plan for the rest, in the same spirit as
[FUTURE_SESSION_SCOPED_ASSIGNMENT.md](FUTURE_SESSION_SCOPED_ASSIGNMENT.md).
Answers three things asked together: can this project stop depending on
WAHA's own dashboard entirely, build a fully custom interface on its API
instead, and — audited across everything WAHA exposes, not just the piece
already done — what exactly would that take.

---

## 0. The feasibility question, answered honestly

**For what this project actually needs: yes, confirmed, not inferred.**
Every capability this system uses — session status, QR, restart, sending
text — already goes through this project's own API (workflow 11, workflow
4/7), never WAHA's dashboard, and every one of those calls was tested live
against the running instance this session (real HTTP calls, real responses,
documented in the `add-waha-connector` commit history).

**What is NOT independently confirmed:** that WAHA's dashboard has zero
capability beyond its public, Swagger-documented REST API. WAHA's own docs
do not state this explicitly (checked directly — the dashboard page
documents *that* the dashboard exists and can be disabled
`WAHA_DASHBOARD_ENABLED=false`, not that it is *purely* a client of the
public API with no server-side-only route). Architecturally it almost
certainly is one — it is a Nuxt SPA served from `/dashboard` — but "almost
certainly" is not "verified," and this document says so rather than
rounding it up.

**Why this distinction does not block anything.** The question that matters
is not "does the dashboard have zero unique capability anywhere," it is
"does WAHA's *public* REST API cover everything a support-routing tool
needs." §1 answers that directly, capability by capability, and for
everything in the **Replicate now** and **Already built** rows, the answer
is independently confirmed by this session's own live tests — not by
trusting WAHA's architecture.

---

## 1. Full audit — every WAHA capability group, one verdict each

Same 19 tag groups from the OpenAPI spec already explored this session
(150 endpoints total). Ordered by relevance to *this* project, not by
WAHA's own menu order.

| Group | Endpoints | Relevant to support routing? | Status | Verdict |
|---|---|---|---|---|
| 🖥️ Sessions | 15 | **Yes — core** | Status/restart replicated (workflow 11) | **Already built.** `start`/`stop`/`logout` not yet wrapped — see §2 |
| 📱 Pairing | 7 | **Yes** | QR replicated (workflow 11) | **Already built.** Pairing-by-code (phone number instead of QR) not wrapped — see §2 |
| 📤 Chatting | 26 | **Yes — core** | `sendText` replicated (workflow 4/7); inbound already flows through workflow 1b | **Mostly built.** Media send (image/file/voice/video), `sendSeen`/typing not wrapped — tracked in `FUTURE_TASKS_EMPLOYEES_AND_AI_AGENTS.md` §4, not duplicated here |
| 💬 Chats | 16 | **Maybe — a real chat history view** | Not built | **Replicate later** — see §3, real but not urgent (the Sheet already shows `last_message`; a full thread view is a bigger UI, not an API gap) |
| 👤 Contacts | 13 | **Small, useful piece** | Not built | **Replicate later** — `check-exists` specifically, see §3 |
| 🔑 Api Keys | 6 | **Only for us, not end users** | `configure-waha.js` already calls this directly (not through a UI) | **Skip a UI for it.** A key-rotation script is the right shape, not a page |
| 🔍 Observability | 10 | Operational, not user-facing | Partially — `/health` used by docker-compose's own healthcheck | **Skip.** Belongs in monitoring (`ALTERNATIVES.md`'s UptimeRobot/Healthchecks row), not this UI |
| 🆔 Profile | 5 | Cosmetic (display name, avatar) | Not built | **Skip for now** — not part of "distribute conversations to employees," revisit if asked for |
| ✅ Presence | 4 | Anti-detection mitigation | Not built | **Tracked in `FUTURE_TASKS_EMPLOYEES_AND_AI_AGENTS.md` §4**, not duplicated here — different purpose (anti-ban, not a dashboard feature) |
| 🖼️ Media | 2 | Format conversion only | Not built | **Skip** — only matters once inbound media handling itself is built (a separate, already-tracked gap) |
| 👥 Groups | 33 | **No** — this project explicitly does not serve groups | N/A | **Skip.** Workflow 1b already deliberately drops group messages |
| 📢 Channels | 14 | **No** | N/A | **Skip** — not a support-routing concept |
| 🏷️ Labels | 7 | **No** (WhatsApp Business accounts only) | N/A | **Skip** |
| 🟢 Status | 6 | **No** (Stories) | N/A | **Skip** |
| 📞 Calls | 1 | **No** | N/A | **Skip** |
| 📅 Events | 1 | Internal | N/A | **Skip** |
| 🧩 Apps: MCP | 1 | Interesting, different purpose | N/A | **Tracked in `FUTURE_TASKS_EMPLOYEES_AND_AI_AGENTS.md` §5** (AI grounding), not a dashboard-replacement concern |
| 🧩 Apps (general) | 7 | WAHA's own n8n/Chatwoot/Typebot integrations | N/A | **Skip** — this project already has its own n8n integration (workflow 1b), built to the exact shape it needs |
| 🧩 Apps: Brazilian phones | 4 | **No** | N/A | **Skip** — not this project's market |

**Reading the table straight:** of 19 groups, 3 are already built into this
project's own API, 3 more are worth adding (§2/§3), 2 are already tracked
elsewhere under a more accurate heading, and 11 are genuinely irrelevant to
a WhatsApp support-routing tool — replicating them would be building
WAHA's dashboard for its own sake, not serving this project. "قلد كل شيء"
taken literally would mean 150 endpoints; taken as "cover everything this
project could plausibly need," it is 6 items, 3 of them already done.

---

## 2. Close the Sessions/Pairing gap — same session, same shape

Small additions to workflow 11 ([`11-waha-session-api.json`](../n8n/workflows/11-waha-session-api.json)),
using the same `WAHA_STATUS_API_KEY` (read + control, already scoped —
no new key needed, `control` already covers session lifecycle):

| Endpoint to add | WAHA call | Why |
|---|---|---|
| `POST /api/waha/logout` | `POST /api/sessions/{session}/logout` | A clean "unlink this number" — today only `restart` exists, which reconnects rather than logs out |
| `POST /api/waha/start` | `POST /api/sessions/{session}/start` | The Connection tab can currently only restart a session that exists; starting one from `STOPPED` needs this |
| `GET /api/waha/pair-code` | `POST /api/{session}/auth/request-code` (WAHA's phone-number pairing) | An alternative to scanning — type a code into WhatsApp instead. Useful when the phone isn't physically at hand for the person doing the linking |

**Grade: Safe.** Same auth pattern, same key, three more thin proxy
endpoints in an already-built and already-tested workflow. No core-algorithm
risk like `FUTURE_SESSION_SCOPED_ASSIGNMENT.md`'s change — this only adds
read/control passthrough, nothing touches assignment or Sheets writes.

---

## 3. Chats + Contacts — worth it, not urgent

Two small, genuinely useful additions, each a new thin workflow (12, 13)
following the exact same shape as 9/10/11:

### `GET /api/waha/chat-history?phone=...` (new, small)

Proxies `GET /api/{session}/chats/{chatId}/messages` (WAHA's Chats group).
**Why it's worth it:** the Sheet only stores `last_message` — an agent
picking up a conversation from someone else cannot see the full back-and-
forth without this. **Why it's not urgent:** the Messages tab in Google
Sheets already has every message ever sent/received, filterable by
`conversation_id` — this is a nicer UI for data that already exists and is
already queryable, not a missing capability.

### `POST /api/waha/check-number` (new, tiny)

Proxies `POST /api/contacts/check-exists`. **Why it's worth it:** catches a
typo'd phone number before a conversation row gets created for a number
that was never real. **Why it's not urgent:** the cost of a wrong number
today is one bad row, not a broken system — cheap to fix by hand, no rush.

**Grade: Safe**, same reasoning as §2. Build these when a real "I picked up
someone else's conversation and had no context" or "we created a garbage
row" incident actually happens — not preemptively, matching this project's
own stated preference (COSTS.md, ALTERNATIVES.md) for building the next
real bottleneck, not every plausible one.

---

## 4. What "no قيود ولا مشاكل" (no restrictions, no problems) actually rests on

Concrete, not a slogan:

| Claim | Where it's proven |
|---|---|
| Every capability this project uses has a real REST endpoint | Confirmed against WAHA's own OpenAPI spec, same version (`2026.8.2`) as the running container |
| Those endpoints work when called the way this project calls them | Live-tested this session: status, QR (binary passthrough), restart — real HTTP calls against the real running instance, not mocked |
| A properly-scoped key can do this without holding admin power | `WAHA_STATUS_API_KEY` (read+control, never send) — minted through WAHA's own Keys API, its scope *proven* by two probes (`configure-waha.js`): can read, cannot send |
| Adding more of these doesn't touch anything fragile | Every addition in §2/§3 is a new, isolated workflow or a new node in an already-isolated one — none of them touch `scripts/lib/assignment.js`, workflow 2/3's dedup/routing, or any Sheets write path outside their own new nodes |

The one thing this document does **not** claim: that WAHA's dashboard could
be deleted from the container image and nothing would break anywhere in
*WAHA itself*. That was never the question. The question was whether *this
project* can run without ever opening it — and after §1's audit, the answer
is yes, with the six-item list in §2/§3 being the only remaining polish, not
a blocker.

---

## 5. Build order

```
1. §2 — Sessions/Pairing gap (logout, start, pair-by-code)   Safe, do first
2. §3 — Contacts check-exists                                  Safe, cheap
3. §3 — Chat history view                                      Safe, bigger UI lift
```

Nothing here is gated on anything else in this document or in
`FUTURE_SESSION_SCOPED_ASSIGNMENT.md` — all three can be built in any order,
each independently tested the same way workflow 11 already was (live HTTP
calls against the running stack, not just the JSON validator).
