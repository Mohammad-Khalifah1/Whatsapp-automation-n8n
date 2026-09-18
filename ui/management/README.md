# Management UI — Employees & Tasks

A plain, dependency-free web page over the Management API
([workflows 9 & 10](../../n8n/workflows/09-employees-api.json)):
a to-do board over conversations, and a simple team-management screen.
No build step, no framework, no npm install — open `index.html` in a browser.

## Run it

```bash
# n8n must already be running (docker compose up -d) and workflows 9/10 published
python3 -m http.server 8765 --directory ui/management
# or: npx serve ui/management
```

Open `http://localhost:8765`, enter your n8n base URL (`http://localhost:5678`
locally) and the `MANAGEMENT_API_KEY` value from `.env`, then **Save & connect**.

Opening `index.html` directly as a `file://` URL also works in most browsers —
a local static server just avoids browser quirks around `file://` + `fetch`.

## Files

| File | What it is |
|---|---|
| `index.html` | The page: layout, styling, DOM wiring, `fetch` calls to the Management API |
| `logic.js` | Every pure, DOM-free computation the page does — grouping tasks into columns, filtering, validation, error-message mapping. Loaded by `index.html` via a plain `<script>` tag, and `require()`'d directly by `tests/ui/management-logic.test.js` |

The split exists so the logic is actually unit-tested
(`node tests/run-tests.js ui`) rather than only "tested" by clicking around —
the same reasoning `scripts/lib/` already follows for the n8n workflows.

## What this does and does not do

- **Reads and writes through the Management API only.** It never talks to
  Google Sheets, WAHA, or Meta directly — same security boundary the API
  itself already enforces (`X-Management-Key`, fails closed).
- **No auth of its own.** Anyone who has the Management API key can use this
  page fully. It is an internal tool for whoever administers the system, not
  something to put on the public internet as-is.
- **The key is stored in `localStorage`**, in the browser it was entered in
  only — never sent anywhere except the configured n8n URL. Per-viewer
  convenience, not a secrets vault: don't rely on it surviving a cleared
  browser profile, and don't paste the key into a shared machine's browser.
- **Closing/reopening a task calls the same endpoint workflow 10 already
  exposes** — it does not duplicate the agent-load recompute logic; that
  stays server-side, exactly once.

## Honesty about what's verified

Built and verified this session:

| Level | Status |
|---|---|
| `logic.js` pure functions | **Unit-tested** — `tests/ui/management-logic.test.js`, run by `node tests/run-tests.js` |
| Every `fetch` call's path/method/body | **Cross-checked** against the same Management API calls already live-verified in this session (create/update/list employees, list/close/reopen tasks) |
| Static files serve correctly, inline JS is syntactically valid | **Verified** this session |
| Actually clicked through in a real browser | **Not yet done** — this session has no browser to drive. Open it once yourself before relying on it for real team use, the same "built and unit-tested is not verified live" distinction the rest of this project draws (see the README's own Status table) |
