/**
 * Pure, DOM-free logic for the management UI (Employees + Tasks board).
 *
 * CANONICAL SOURCE for anything the UI computes rather than just displays.
 * Kept separate from index.html on purpose: a <script> tag cannot be
 * require()'d by a test file, and this project's own convention (see
 * scripts/lib/) is that anything worth getting right is worth unit-testing
 * directly, not only by clicking around a browser. Unit-tested:
 * tests/ui/management-logic.test.js.
 *
 * Dual export so the exact same code runs in Node (tests) and the browser
 * (index.html, loaded as a plain <script>, no bundler): CommonJS when
 * `module` exists, otherwise attached to `window.ManagementUILogic`.
 */

'use strict';

/** The four to-do columns, in board order. Mirrors workflow 10's own mapping — not reimplemented, just displayed. */
const COLUMNS = ['backlog', 'to_do', 'waiting', 'done'];

const COLUMN_LABELS = {
  backlog: 'Backlog',
  to_do: 'To Do',
  waiting: 'Waiting on customer',
  done: 'Done',
};

/**
 * Groups tasks (as returned by GET /api/tasks) into the four board columns.
 * The `column` field already comes from the server (workflow 10) — this
 * does not re-derive it from `status`, so the UI and the API can never
 * silently disagree about which column a status belongs to.
 *
 * @param {Array<object>} tasks
 * @returns {{backlog: object[], to_do: object[], waiting: object[], done: object[]}}
 */
function groupTasksByColumn(tasks) {
  const groups = { backlog: [], to_do: [], waiting: [], done: [] };
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const col = COLUMNS.includes(t && t.column) ? t.column : 'backlog';
    groups[col].push(t);
  }
  return groups;
}

/**
 * @param {Array<object>} tasks
 * @param {string} agentId  Empty/undefined = no filter (all agents, including unassigned).
 */
function filterTasksByAgent(tasks, agentId) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!agentId) return list;
  return list.filter((t) => String(t.assigned_agent_id || '') === String(agentId));
}

/**
 * Employee capacity summary for a badge/row — never trusts the sign of the
 * numbers blindly (a malformed Sheets row is possible; this project's own
 * convention throughout scripts/lib/ is to degrade gracefully, not throw).
 *
 * @returns {{ open: number, max: number, atCapacity: boolean, label: string }}
 */
function agentCapacity(agent) {
  const open = Number((agent && agent.open_conversations) || 0) || 0;
  const max = Number((agent && agent.max_open_conversations) || 0) || 0;
  const atCapacity = max > 0 && open >= max;
  return { open, max, atCapacity, label: open + '/' + (max || '?') };
}

/**
 * Client-side mirror of the server's own validation in workflow 9's
 * "Validate & Assign Id" node (build-management-api.js) — intentionally the
 * SAME rules, so a rejected submission is never a surprise. This does not
 * replace server validation (the server is still the source of truth); it
 * only gives immediate feedback without a round trip.
 *
 * @param {object} fields  { name, phone, max_open_conversations }
 * @param {Array<object>} existingEmployees  For the duplicate-phone check.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateNewEmployee(fields, existingEmployees) {
  const errors = [];
  const name = typeof fields.name === 'string' ? fields.name.trim() : '';
  const phone = typeof fields.phone === 'string' ? fields.phone.replace(/[^0-9]/g, '') : '';

  if (!name) errors.push('name is required');
  if (!phone || phone.length < 8) errors.push('phone must be a valid number (digits only, with country code)');

  const list = Array.isArray(existingEmployees) ? existingEmployees : [];
  if (phone && list.some((r) => String(r.phone || '').replace(/[^0-9]/g, '') === phone)) {
    errors.push('an employee with this phone already exists');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Turns a raw fetch/network failure into one consistent shape the UI can
 * render without a try/catch in every call site. Never throws.
 */
function describeApiError(err) {
  if (!err) return 'Unknown error';
  if (err.status === 401) return 'Wrong or missing Management API key.';
  if (err.status === 500) return 'Server misconfigured — MANAGEMENT_API_KEY is not set on the n8n side.';
  if (err.status === 404) return 'Not found.';
  if (err.status >= 400) return (err.body && err.body.error) || ('Request failed (' + err.status + ')');
  return err.message || 'Network error — is n8n reachable at the configured URL?';
}

/**
 * Maps a WAHA session status (from GET /api/waha/status, workflow 11) to a
 * badge label/tone and whether the QR image is worth showing right now.
 * WAHA's own status strings, not reinvented — see docs/WAHA_REFERENCE.md.
 */
function describeSessionStatus(status) {
  var s = String(status || '').toUpperCase();
  if (s === 'WORKING') return { label: 'Connected', tone: 'ok', showQr: false };
  if (s === 'SCAN_QR_CODE') return { label: 'Scan the QR code', tone: 'warn', showQr: true };
  if (s === 'STARTING') return { label: 'Starting…', tone: 'warn', showQr: false };
  if (s === 'FAILED') return { label: 'Failed — try restart', tone: 'bad', showQr: false };
  if (s === 'STOPPED') return { label: 'Stopped', tone: 'off', showQr: false };
  return { label: s || 'Unknown', tone: 'off', showQr: false };
}

const api = {
  COLUMNS,
  COLUMN_LABELS,
  groupTasksByColumn,
  filterTasksByAgent,
  agentCapacity,
  validateNewEmployee,
  describeApiError,
  describeSessionStatus,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.ManagementUILogic = api;
}
