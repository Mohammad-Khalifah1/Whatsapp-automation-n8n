/**
 * Conversation lifecycle: identity, state machine, and field derivation.
 *
 * CANONICAL SOURCE. Unit-tested (tests/conversations/conversation.test.js) and
 * injected into n8n Code nodes by scripts/setup/build-workflows.js.
 *
 * Full semantics for every state and transition: docs/ARCHITECTURE.md
 * ("Conversation State Machine"). Every state here has documented meaning —
 * no state exists that the docs do not explain.
 */

'use strict';

const { localIso } = require('./time');

/**
 * Conversation states.
 *
 * The MVP deliberately uses SIX states, not the eight suggested, because two
 * pairs collapse without losing information:
 *   - OPEN is not a distinct state: it is the union of every non-CLOSED state.
 *     Managers filter "open" with `status != CLOSED`. Keeping OPEN alongside
 *     ASSIGNED/UNANSWERED would allow contradictory rows (OPEN *and* UNANSWERED).
 *   - ASSIGNED collapses into UNANSWERED: the instant a conversation is assigned
 *     it is by definition awaiting the agent's first reply. A separate ASSIGNED
 *     state would be entered and left in the same execution, so it could never
 *     be observed and would only create ambiguity.
 * This is recorded as a decision in docs/DECISIONS.md.
 */
const STATUS = {
  /** Created but no eligible agent existed. Sits in the unassigned queue. */
  WAITING_FOR_AGENT: 'WAITING_FOR_AGENT',
  /** Assigned to an agent; the customer's latest message has no agent reply yet. */
  UNANSWERED: 'UNANSWERED',
  /** Agent has replied and their reply is the most recent message. */
  REPLIED: 'REPLIED',
  /** Alias of REPLIED from the manager's point of view: ball is in customer's court. */
  WAITING_FOR_CUSTOMER: 'WAITING_FOR_CUSTOMER',
  /** Explicitly ended. Only a human/automation closes; customers never close. */
  CLOSED: 'CLOSED',
  /**
   * Moved out of the working sheet. Set by a human choosing it from the
   * dropdown, which triggers an immediate move to the Archive tab.
   * Like CLOSED it is not an open state, so it frees the agent's capacity.
   */
  ARCHIVED: 'ARCHIVED',
};

/** States that count against an agent's open-conversation capacity. */
const OPEN_STATUSES = [
  STATUS.WAITING_FOR_AGENT,
  STATUS.UNANSWERED,
  STATUS.REPLIED,
  STATUS.WAITING_FOR_CUSTOMER,
];

/** Events that drive transitions. */
const EVENT = {
  CUSTOMER_MESSAGE: 'CUSTOMER_MESSAGE',
  AGENT_MESSAGE: 'AGENT_MESSAGE',
  AGENT_ASSIGNED: 'AGENT_ASSIGNED',
  NO_AGENT_AVAILABLE: 'NO_AGENT_AVAILABLE',
  CLOSE: 'CLOSE',
  REOPEN: 'REOPEN',
};

function isOpenStatus(status) {
  return OPEN_STATUSES.indexOf(status) !== -1;
}

/**
 * Generate a stable internal conversation id.
 *
 * Deliberately NOT the WhatsApp message id: message ids are per-message and
 * change with every message, so using one as a conversation key would create a
 * new "conversation" for every inbound message.
 *
 * Format: CONV-<businessPhoneNumberId>-<customerPhone>-<epochMillis>
 * The business number is part of the key so the same customer messaging two
 * different business numbers yields two independent conversations.
 *
 * The timestamp suffix makes ids unique across REOPEN cycles (a customer who
 * returns after a conversation was closed gets a genuinely new conversation
 * row, preserving the closed one for history).
 */
function generateConversationId(businessPhoneNumberId, customerPhone, nowMs) {
  const ts = nowMs === undefined || nowMs === null ? Date.now() : Number(nowMs);
  const biz = String(businessPhoneNumberId || 'unknown').replace(/[^A-Za-z0-9]/g, '');
  const cust = String(customerPhone || 'unknown').replace(/[^A-Za-z0-9]/g, '');
  return 'CONV-' + biz + '-' + cust + '-' + ts;
}

/**
 * Decide the next state given the current state and an event.
 *
 * Returns the transition rather than mutating, so it is trivially testable and
 * the caller decides how to persist it.
 *
 * @param {string|null} currentStatus  null/'' means "no existing conversation".
 * @param {string} event               One of EVENT.*
 * @param {object} [ctx]
 * @param {boolean} [ctx.reopenClosed=true]  Whether a customer message on a
 *        CLOSED conversation reopens it (see docs/ARCHITECTURE.md).
 * @param {boolean} [ctx.hasAgent=false]     Whether an agent is assigned.
 * @returns {{ next: string, changed: boolean, reason: string }}
 */
function nextStatus(currentStatus, event, ctx) {
  const options = ctx || {};
  const reopenClosed = options.reopenClosed === undefined ? true : !!options.reopenClosed;
  const hasAgent = !!options.hasAgent;
  const current = currentStatus || null;

  const result = (next, reason) => ({
    next,
    changed: next !== current,
    reason,
  });

  switch (event) {
    case EVENT.CUSTOMER_MESSAGE: {
      // A customer message always means the business owes a reply.
      if (current === null) {
        return result(
          hasAgent ? STATUS.UNANSWERED : STATUS.WAITING_FOR_AGENT,
          'new_conversation_from_customer_message'
        );
      }
      if (current === STATUS.CLOSED) {
        if (!reopenClosed) {
          // Configured not to auto-reopen: stay closed, caller creates a new
          // conversation instead.
          return result(STATUS.CLOSED, 'closed_conversation_not_reopened_by_config');
        }
        return result(
          hasAgent ? STATUS.UNANSWERED : STATUS.WAITING_FOR_AGENT,
          'reopened_by_customer_message'
        );
      }
      if (current === STATUS.WAITING_FOR_AGENT) {
        // Still nobody to route to; more messages don't change that.
        return result(STATUS.WAITING_FOR_AGENT, 'still_awaiting_agent');
      }
      // REPLIED / WAITING_FOR_CUSTOMER / UNANSWERED -> the customer spoke last.
      return result(STATUS.UNANSWERED, 'customer_message_awaiting_agent_reply');
    }

    case EVENT.AGENT_ASSIGNED: {
      if (current === STATUS.CLOSED) {
        return result(STATUS.CLOSED, 'cannot_assign_closed_conversation');
      }
      return result(STATUS.UNANSWERED, 'agent_assigned_awaiting_first_reply');
    }

    case EVENT.NO_AGENT_AVAILABLE: {
      if (current === STATUS.CLOSED) {
        return result(STATUS.CLOSED, 'closed_conversation_unchanged');
      }
      return result(STATUS.WAITING_FOR_AGENT, 'no_eligible_agent');
    }

    case EVENT.AGENT_MESSAGE: {
      if (current === STATUS.CLOSED) {
        // An agent messaging a closed conversation reopens it — they are
        // deliberately re-engaging the customer.
        return result(STATUS.REPLIED, 'reopened_by_agent_message');
      }
      return result(STATUS.REPLIED, 'agent_replied');
    }

    case EVENT.CLOSE:
      return result(STATUS.CLOSED, 'closed');

    case EVENT.REOPEN: {
      if (current !== STATUS.CLOSED) {
        return result(current, 'reopen_ignored_not_closed');
      }
      return result(
        hasAgent ? STATUS.UNANSWERED : STATUS.WAITING_FOR_AGENT,
        'manually_reopened'
      );
    }

    default:
      return result(current === null ? STATUS.WAITING_FOR_AGENT : current, 'unknown_event');
  }
}

/**
 * Build the full Conversations row for a brand-new conversation.
 * Field names match docs/GOOGLE_SHEETS_SCHEMA.md exactly (snake_case).
 */
function buildNewConversationRow(input) {
  const i = input || {};
  const nowIso = i.now_iso || localIso();
  const conversationId =
    i.conversation_id ||
    generateConversationId(i.business_phone_number_id, i.customer_phone, Date.parse(nowIso));

  return {
    // --- business-facing, kept first so the sheet reads left to right ---
    customer_name: i.customer_name || '',
    customer_phone: i.customer_phone || '',
    assigned_agent_name: i.assigned_agent_name || '',
    status: i.status || STATUS.WAITING_FOR_AGENT,
    // Filled in by a human, never by the system. The update builders must not
    // include these, or a manual entry would be wiped on the next message.
    product: '',
    quantity: '',
    // first_message_at is written once and never updated, so response time can
    // be measured against when the customer first made contact.
    first_message_at: i.last_customer_message_at || nowIso,
    conversation_id: conversationId,
    business_phone_number_id: i.business_phone_number_id || '',
    assigned_agent_id: i.assigned_agent_id || '',
    last_message: i.last_message || '',
    unanswered_messages: i.unanswered_messages || '',
    unanswered_count: i.unanswered_messages ? '1' : '0',
    last_message_id: i.last_message_id || '',
    last_message_direction: i.last_message_direction || 'inbound',
    // What kind of message it was. A row reading 'image' with an empty
    // last_message is a customer who sent a photo, not a customer who sent
    // nothing - which is the difference between answering and ignoring them.
    last_message_type: i.last_message_type || 'text',
    last_customer_message_at: i.last_customer_message_at || nowIso,
    last_agent_message_at: '',
    last_activity_at: nowIso,
    unread: i.unread === undefined ? 'TRUE' : i.unread ? 'TRUE' : 'FALSE',
    created_at: nowIso,
    updated_at: nowIso,
    closed_at: '',
    wa_link: i.wa_link || '',
    // Why the conversation is unassigned, when it is. Empty when assigned.
    unassigned_reason: i.unassigned_reason || '',
  };
}

/**
 * The customer's messages that nobody has answered yet, as one readable block.
 *
 * WHY THIS EXISTS
 * `last_message` holds one value, so a customer who writes three times before
 * anyone replies leaves only the third visible. The first two are not lost -
 * they are in the Messages tab - but they are invisible on the tab people
 * actually work in, which is where "we answered them" gets decided. This keeps
 * everything still owed a reply in front of whoever is looking.
 *
 * It is append-only until a reply goes out, and a reply clears it. That is the
 * whole state machine.
 *
 * @param {string} existingBlock  What the cell holds now.
 * @param {object} message        The inbound message.
 * @param {object} [opts]
 * @param {number} [opts.maxEntries=10]  Keep the newest N. A customer who sends
 *                                       forty messages should not make the row
 *                                       unreadable.
 * @param {number} [opts.maxChars=1500]  Hard cap, so one pasted essay cannot
 *                                       push the cell past what Sheets shows.
 * @returns {string}
 */
function appendUnanswered(existingBlock, message, opts) {
  const options = opts || {};
  const maxEntries = options.maxEntries === undefined ? 10 : options.maxEntries;
  const maxChars = options.maxChars === undefined ? 1500 : options.maxChars;

  const m = message || {};
  const text = String(m.preview || m.text || '').trim();
  const type = String(m.message_type || 'text').trim();
  // An image with no caption must still show as something, or the row reads as
  // an empty message rather than as a photo waiting for an answer.
  const body = text !== '' ? text : '[' + (type || 'message') + ']';

  const stamp = m.timestamp_iso ? String(m.timestamp_iso).slice(11, 16) : '';
  const line = (stamp ? stamp + '  ' : '') + body;

  const existing = String(existingBlock || '').trim();
  const lines = existing === '' ? [] : existing.split('\n');
  // Newest first, matching the order of every other view in this system.
  lines.unshift(line);

  let kept = lines.slice(0, maxEntries);
  while (kept.length > 1 && kept.join('\n').length > maxChars) kept.pop();

  return kept.join('\n');
}

/**
 * Compute the field updates to apply to an existing conversation when a new
 * inbound customer message arrives. Returns ONLY changed fields, so the caller
 * writes a minimal update (fewer Sheets cells touched = fewer lost concurrent
 * edits).
 */
function buildCustomerMessageUpdate(existing, message, opts) {
  const options = opts || {};
  const nowIso = options.now_iso || localIso();
  const current = existing || {};
  const transition = nextStatus(current.status || null, EVENT.CUSTOMER_MESSAGE, {
    reopenClosed: options.reopenClosed,
    hasAgent: !!(current.assigned_agent_id && String(current.assigned_agent_id).trim()),
  });

  // Everything the customer has said that nobody has answered yet.
  const unanswered = appendUnanswered(current.unanswered_messages, message, {
    maxEntries: options.maxUnanswered,
  });

  const update = {
    status: transition.next,
    unanswered_messages: unanswered,
    unanswered_count: String(unanswered === '' ? 0 : unanswered.split('\n').length),
    last_message: message.preview || message.text || '',
    last_message_id: message.message_id || '',
    last_message_direction: 'inbound',
    last_message_type: message.message_type || 'text',
    last_customer_message_at: message.timestamp_iso || nowIso,
    last_activity_at: message.timestamp_iso || nowIso,
    unread: 'TRUE',
    updated_at: nowIso,
  };

  // Reopening clears the closure timestamp.
  if (current.status === STATUS.CLOSED && transition.next !== STATUS.CLOSED) {
    update.closed_at = '';
  }

  // Refresh the profile name if WhatsApp now gives us one and we had none.
  if (message.customer_name && !current.customer_name) {
    update.customer_name = message.customer_name;
  }

  return { update, transition };
}

/**
 * Compute updates for an outbound agent message that the API accepted.
 * NOTE: 'accepted by the API' is NOT 'delivered to the customer' — delivery is
 * only known from a later status webhook. See docs/ERROR_HANDLING.md.
 */
function buildAgentMessageUpdate(existing, message, opts) {
  const options = opts || {};
  const nowIso = options.now_iso || localIso();
  const current = existing || {};
  const transition = nextStatus(current.status || null, EVENT.AGENT_MESSAGE, {
    hasAgent: true,
  });

  const update = {
    status: transition.next,
    // Answering clears the backlog. This is the only thing that does.
    unanswered_messages: '',
    unanswered_count: '0',
    last_message: message.preview || message.text || '',
    last_message_id: message.message_id || '',
    last_message_direction: 'outbound',
    last_message_type: message.message_type || 'text',
    last_agent_message_at: message.timestamp_iso || nowIso,
    last_activity_at: message.timestamp_iso || nowIso,
    // The agent has now seen and answered the customer.
    unread: 'FALSE',
    updated_at: nowIso,
  };

  if (current.status === STATUS.CLOSED) {
    update.closed_at = '';
  }

  return { update, transition };
}

/**
 * Determine whether a conversation is eligible for inactivity-based closing.
 * The MVP does NOT auto-close: this only marks eligibility so a human or an
 * explicitly enabled scheduled workflow can act. See docs/DECISIONS.md.
 */
function isInactivityCloseEligible(conversation, opts) {
  const options = opts || {};
  const hours = Number(options.inactivityHours);
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now();
  const c = conversation || {};

  if (!isFinite(hours) || hours <= 0) {
    return { eligible: false, reason: 'INACTIVITY_DISABLED' };
  }
  if (!isOpenStatus(c.status)) {
    return { eligible: false, reason: 'NOT_OPEN' };
  }
  const lastActivity = c.last_activity_at ? Date.parse(String(c.last_activity_at)) : NaN;
  if (isNaN(lastActivity)) {
    return { eligible: false, reason: 'NO_VALID_LAST_ACTIVITY' };
  }
  const idleHours = (nowMs - lastActivity) / 3600000;
  if (idleHours < hours) {
    return { eligible: false, reason: 'STILL_ACTIVE', idle_hours: idleHours };
  }
  return { eligible: true, reason: 'INACTIVE_BEYOND_THRESHOLD', idle_hours: idleHours };
}

/**
 * Count each agent's currently-open conversations directly from the
 * Conversations rows.
 *
 * This is the alternative to the denormalized `Agents.open_conversations`
 * counter. The counter has to be incremented on assignment and decremented on
 * close, and Google Sheets has no atomic compare-and-set, so two executions can
 * read the same value and both write it back — the drift that
 * `recalculateAgentLoad()` in the Apps Script exists to repair. Deriving the
 * number from the rows that actually exist cannot drift, because there is no
 * second copy of the truth to disagree with.
 *
 * The cost is reading the Conversations tab instead of a single cell. The MVP
 * workflow already reads that tab to find the customer's existing conversation,
 * so counting here is free — same rows, one pass.
 *
 * @param {Array<object>} rows  Rows from the Conversations sheet.
 * @returns {object}            Map of agent_id -> open conversation count.
 */
function countOpenConversationsByAgent(rows) {
  const counts = {};

  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;

    const agentId = String(row.assigned_agent_id || '').trim();
    if (!agentId) continue;                       // unassigned: nobody's load
    if (!isOpenStatus(String(row.status || '').trim())) continue;

    counts[agentId] = (counts[agentId] || 0) + 1;
  }

  return counts;
}

module.exports = {
  appendUnanswered,
  STATUS,
  OPEN_STATUSES,
  EVENT,
  isOpenStatus,
  countOpenConversationsByAgent,
  generateConversationId,
  nextStatus,
  buildNewConversationRow,
  buildCustomerMessageUpdate,
  buildAgentMessageUpdate,
  isInactivityCloseEligible,
};
