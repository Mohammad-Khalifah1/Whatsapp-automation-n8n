/**
 * Agent assignment engine.
 *
 * CANONICAL SOURCE. Unit-tested (tests/assignment/assignment.test.js) and
 * injected into n8n Code nodes by scripts/setup/build-workflows.js.
 *
 * The engine is a PURE FUNCTION of (agents, options) -> decision. It performs
 * no I/O. That is deliberate:
 *   - it is exhaustively testable without Google Sheets or Meta,
 *   - the strategy can change (LEAST_OPEN_CONVERSATIONS -> ROUND_ROBIN) without
 *     touching persistence,
 *   - when the store moves to PostgreSQL, only the caller changes: it will wrap
 *     this call in `SELECT ... FOR UPDATE` / a transaction. See
 *     docs/GOOGLE_SHEETS_TO_POSTGRES.md.
 *
 * See docs/ASSIGNMENT_ALGORITHM.md for the full specification, including the
 * concurrency limitations of Google Sheets as a state store.
 */

'use strict';

const { localIso } = require('./time');

const STRATEGIES = {
  LEAST_OPEN_CONVERSATIONS: 'LEAST_OPEN_CONVERSATIONS',
  ROUND_ROBIN: 'ROUND_ROBIN',
};

/** Machine-readable reasons an agent was excluded, recorded for audit. */
const INELIGIBLE = {
  INACTIVE: 'INACTIVE',
  UNAVAILABLE: 'UNAVAILABLE',
  AT_CAPACITY: 'AT_CAPACITY',
  MALFORMED_RECORD: 'MALFORMED_RECORD',
  OUTSIDE_WORKING_HOURS: 'OUTSIDE_WORKING_HOURS',
  WRONG_ACCOUNT: 'WRONG_ACCOUNT',
};

const NO_AGENT_REASON = {
  NO_AGENTS_CONFIGURED: 'NO_AGENTS_CONFIGURED',
  NO_ELIGIBLE_AGENT: 'NO_ELIGIBLE_AGENT',
};

/**
 * Google Sheets returns everything as strings. 'TRUE'/'true'/'1'/'yes' are all
 * truthy in practice because humans edit these cells by hand. Anything
 * unrecognised is treated as FALSE (fail closed: do not route a customer to an
 * agent whose availability we cannot positively confirm).
 */
function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue === undefined ? false : defaultValue;
  }
  if (typeof value === 'boolean') return value;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'نعم'].indexOf(v) !== -1) return true;
  if (['false', '0', 'no', 'n', 'لا'].indexOf(v) !== -1) return false;
  return defaultValue === undefined ? false : defaultValue;
}

/**
 * Sheets cells arrive as strings and may be blank. Returns `fallback` when the
 * value is not a finite number, so a typo in a spreadsheet cell cannot produce
 * NaN comparisons that silently reorder the queue.
 */
function parseIntSafe(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const n = Number(String(value).trim());
  if (!isFinite(n)) return fallback;
  return Math.trunc(n);
}

/**
 * Parse an ISO-8601 timestamp to epoch ms. Invalid/blank -> null, which sorts
 * FIRST in the tie-breaker (an agent who has never been assigned should get
 * the next conversation ahead of one who was assigned an hour ago).
 */
function parseTimestamp(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const t = Date.parse(String(value).trim());
  return isNaN(t) ? null : t;
}

/**
 * Parse the Agents-sheet `whatsapp_accounts` column: a comma-separated list
 * of `business_phone_number_id` values this agent may be assigned from.
 * Empty/missing = unrestricted — eligible for every account. This is the
 * single default that makes session scoping additive rather than breaking:
 * every row written before this column existed reads back as unrestricted,
 * identical to the behaviour before this feature. See
 * docs/FUTURE_SESSION_SCOPED_ASSIGNMENT.md.
 */
function parseAccountList(value) {
  const s = value === undefined || value === null ? '' : String(value).trim();
  if (!s) return [];
  return s.split(',').map((v) => v.trim()).filter(Boolean);
}

/**
 * Normalize one raw agent row (as read from Google Sheets) into a typed record,
 * and decide eligibility. Never throws on a malformed row — marks it ineligible
 * with MALFORMED_RECORD so one bad spreadsheet row cannot break routing for
 * everyone.
 *
 * @param {object} rawAgent
 * @param {object} [options]
 * @param {string} [options.businessPhoneNumberId]  The conversation's account
 *   (Meta phone_number_id, or "waha:<session>"). Omitted/empty -> the
 *   WRONG_ACCOUNT check never fires, so callers that do not pass it get
 *   exactly today's unrestricted behaviour.
 */
function evaluateAgent(rawAgent, options) {
  const opts = options || {};
  const agent = {
    agent_id: rawAgent && rawAgent.agent_id !== undefined ? String(rawAgent.agent_id).trim() : '',
    name: rawAgent && rawAgent.name !== undefined ? String(rawAgent.name).trim() : '',
    phone: rawAgent && rawAgent.phone !== undefined ? String(rawAgent.phone).trim() : '',
    role: rawAgent && rawAgent.role !== undefined ? String(rawAgent.role).trim() : '',
    active: parseBoolean(rawAgent ? rawAgent.active : undefined, false),
    available: parseBoolean(rawAgent ? rawAgent.available : undefined, false),
    max_open_conversations: parseIntSafe(
      rawAgent ? rawAgent.max_open_conversations : undefined,
      opts.defaultMaxOpenConversations === undefined ? 5 : opts.defaultMaxOpenConversations
    ),
    open_conversations: parseIntSafe(rawAgent ? rawAgent.open_conversations : undefined, 0),
    last_assigned_at_ms: parseTimestamp(rawAgent ? rawAgent.last_assigned_at : undefined),
    last_assigned_at: rawAgent && rawAgent.last_assigned_at ? String(rawAgent.last_assigned_at) : null,
    whatsapp_accounts: parseAccountList(rawAgent ? rawAgent.whatsapp_accounts : undefined),
    _raw: rawAgent,
  };

  const ineligibleReasons = [];

  if (!agent.agent_id) {
    ineligibleReasons.push(INELIGIBLE.MALFORMED_RECORD);
  }
  if (!agent.active) ineligibleReasons.push(INELIGIBLE.INACTIVE);
  if (!agent.available) ineligibleReasons.push(INELIGIBLE.UNAVAILABLE);

  // Capacity: a negative or zero max means "cannot take conversations".
  if (agent.max_open_conversations <= 0) {
    ineligibleReasons.push(INELIGIBLE.AT_CAPACITY);
  } else if (agent.open_conversations >= agent.max_open_conversations) {
    ineligibleReasons.push(INELIGIBLE.AT_CAPACITY);
  }

  // Session/account scoping: unrestricted (empty list) is always eligible.
  // A restricted agent is eligible only when the conversation's account is
  // in their list — and only when the caller actually told us which
  // account this conversation is on; no businessPhoneNumberId means this
  // check cannot fire, preserving today's behaviour for any caller that
  // has not been updated to pass it.
  if (agent.whatsapp_accounts.length > 0 && opts.businessPhoneNumberId) {
    if (agent.whatsapp_accounts.indexOf(String(opts.businessPhoneNumberId)) === -1) {
      ineligibleReasons.push(INELIGIBLE.WRONG_ACCOUNT);
    }
  }

  agent.eligible = ineligibleReasons.length === 0;
  agent.ineligible_reasons = ineligibleReasons;
  return agent;
}

/**
 * Deterministic comparator implementing the documented tie-breaker chain:
 *   1. fewest open_conversations
 *   2. earliest last_assigned_at (never-assigned sorts first)
 *   3. agent_id ascending (lexicographic, stable + deterministic fallback)
 *
 * Step 3 guarantees that two n8n executions given identical agent state pick
 * the SAME agent, which makes the behaviour reproducible in tests and in
 * incident review. It does not by itself prevent double-assignment under
 * concurrency — see docs/ASSIGNMENT_ALGORITHM.md.
 */
function compareLeastOpen(a, b) {
  if (a.open_conversations !== b.open_conversations) {
    return a.open_conversations - b.open_conversations;
  }
  const aTs = a.last_assigned_at_ms;
  const bTs = b.last_assigned_at_ms;
  if (aTs === null && bTs !== null) return -1;
  if (aTs !== null && bTs === null) return 1;
  if (aTs !== null && bTs !== null && aTs !== bTs) return aTs - bTs;
  if (a.agent_id < b.agent_id) return -1;
  if (a.agent_id > b.agent_id) return 1;
  return 0;
}

/**
 * ROUND_ROBIN comparator — provided so the strategy is genuinely pluggable
 * rather than aspirational. Selects the agent whose last assignment is oldest,
 * ignoring current load (capacity is still enforced during eligibility).
 */
function compareRoundRobin(a, b) {
  const aTs = a.last_assigned_at_ms;
  const bTs = b.last_assigned_at_ms;
  if (aTs === null && bTs !== null) return -1;
  if (aTs !== null && bTs === null) return 1;
  if (aTs !== null && bTs !== null && aTs !== bTs) return aTs - bTs;
  if (a.agent_id < b.agent_id) return -1;
  if (a.agent_id > b.agent_id) return 1;
  return 0;
}

const COMPARATORS = {
  [STRATEGIES.LEAST_OPEN_CONVERSATIONS]: compareLeastOpen,
  [STRATEGIES.ROUND_ROBIN]: compareRoundRobin,
};

/**
 * Select the agent who should receive a new conversation.
 *
 * @param {Array<object>} rawAgents  Rows from the Agents sheet (strings are fine).
 * @param {object} [options]
 * @param {string} [options.strategy='LEAST_OPEN_CONVERSATIONS']
 * @param {number} [options.defaultMaxOpenConversations=5]
 * @param {string} [options.businessPhoneNumberId]  See evaluateAgent — omit
 *   for today's unrestricted behaviour.
 * @returns {{
 *   assigned: boolean,
 *   agent: object|null,
 *   status: 'ASSIGNED'|'WAITING_FOR_AGENT',
 *   reason: string|null,
 *   strategy: string,
 *   candidates: Array<object>,   // eligible agents, in selection order
 *   evaluated: Array<object>,    // every agent + why they were excluded
 *   decided_at: string           // ISO timestamp of the decision
 * }}
 *
 * When no agent is eligible the conversation is NOT dropped: the caller must
 * persist status WAITING_FOR_AGENT together with `reason`, and the unassigned
 * queue is retried by the reassignment workflow.
 */
function selectAgent(rawAgents, options) {
  const opts = options || {};
  const strategy = opts.strategy || STRATEGIES.LEAST_OPEN_CONVERSATIONS;
  const comparator = COMPARATORS[strategy] || compareLeastOpen;
  const decidedAt = opts.now ? localIso(opts.now) : localIso();

  const list = Array.isArray(rawAgents) ? rawAgents : [];
  const evaluated = list.map((a) => evaluateAgent(a, opts));

  if (evaluated.length === 0) {
    return {
      assigned: false,
      agent: null,
      status: 'WAITING_FOR_AGENT',
      reason: NO_AGENT_REASON.NO_AGENTS_CONFIGURED,
      strategy,
      candidates: [],
      evaluated,
      decided_at: decidedAt,
    };
  }

  const candidates = evaluated.filter((a) => a.eligible).sort(comparator);

  if (candidates.length === 0) {
    return {
      assigned: false,
      agent: null,
      status: 'WAITING_FOR_AGENT',
      reason: NO_AGENT_REASON.NO_ELIGIBLE_AGENT,
      strategy,
      candidates: [],
      evaluated,
      decided_at: decidedAt,
    };
  }

  return {
    assigned: true,
    agent: candidates[0],
    status: 'ASSIGNED',
    reason: null,
    strategy,
    candidates,
    evaluated,
    decided_at: decidedAt,
  };
}

/**
 * Overlay live conversation counts onto the agent rows before selection.
 *
 * `selectAgent` reads `open_conversations` off each agent row. By default that
 * value is the denormalized counter maintained in the Agents sheet. Passing the
 * rows through here first replaces it with a count derived from the
 * Conversations sheet (see `countOpenConversationsByAgent` in conversation.js),
 * so selection is based on what is actually open rather than on a counter that
 * can drift.
 *
 * The original counter is preserved as `open_conversations_counter` so an
 * operator comparing the two can see the drift rather than having it silently
 * overwritten.
 *
 * @param {Array<object>} rawAgents  Rows from the Agents sheet.
 * @param {object} loadMap           agent_id -> open count.
 * @returns {Array<object>}          Copies, with open_conversations replaced.
 */
function withLiveLoad(rawAgents, loadMap) {
  const loads = loadMap || {};

  return (rawAgents || []).map(function (agent) {
    if (!agent || typeof agent !== 'object') return agent;
    const id = String(agent.agent_id || '').trim();
    // An agent with no open conversations has no entry in the map, which is
    // zero — not "unknown". Falling back to the stale counter here would
    // reintroduce exactly the drift this function removes.
    const live = Object.prototype.hasOwnProperty.call(loads, id) ? loads[id] : 0;

    return Object.assign({}, agent, {
      open_conversations: live,
      open_conversations_counter: agent.open_conversations,
    });
  });
}

module.exports = {
  selectAgent,
  withLiveLoad,
  evaluateAgent,
  compareLeastOpen,
  compareRoundRobin,
  parseBoolean,
  parseIntSafe,
  parseTimestamp,
  parseAccountList,
  STRATEGIES,
  INELIGIBLE,
  NO_AGENT_REASON,
};
