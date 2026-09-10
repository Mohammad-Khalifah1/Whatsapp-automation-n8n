/**
 * Test scenarios 1, 2, 10: new conversation, existing conversation, and a
 * closed conversation receiving a new customer message. Plus full state
 * machine coverage and conversation identity rules.
 */

'use strict';

const {
  STATUS,
  EVENT,
  isOpenStatus,
  generateConversationId,
  nextStatus,
  buildNewConversationRow,
  buildCustomerMessageUpdate,
  buildAgentMessageUpdate,
  isInactivityCloseEligible,
} = require('../../scripts/lib/conversation');

describe('conversation identity', () => {
  it('does NOT use the WhatsApp message id as the conversation id', () => {
    const id = generateConversationId('106540352242922', '962791234567', 1788969600000);
    assert.ok(id.indexOf('wamid') === -1, 'must not embed a message id');
    assert.ok(id.indexOf('CONV-') === 0);
  });

  it('scopes the id by business number, so one customer messaging two numbers gets two conversations', () => {
    const a = generateConversationId('BIZ_A', '962791234567', 1788969600000);
    const b = generateConversationId('BIZ_B', '962791234567', 1788969600000);
    assert.ok(a !== b, 'different business numbers must not collide');
  });

  it('is stable for the same inputs at the same instant', () => {
    const a = generateConversationId('BIZ', '962791234567', 1788969600000);
    const b = generateConversationId('BIZ', '962791234567', 1788969600000);
    assert.equal(a, b);
  });

  it('differs across reopen cycles so closed history is preserved', () => {
    const first = generateConversationId('BIZ', '962791234567', 1788969600000);
    const later = generateConversationId('BIZ', '962791234567', 1788969700000);
    assert.ok(first !== later);
  });

  it('strips characters that would corrupt a spreadsheet key', () => {
    const id = generateConversationId('BIZ/123', '+962-79-123-4567', 1788969600000);
    assert.ok(/^CONV-[A-Za-z0-9]+-[A-Za-z0-9]+-\d+$/.test(id), 'got: ' + id);
  });

  it('never throws on missing inputs', () => {
    assert.doesNotThrow(() => generateConversationId(null, null));
    assert.doesNotThrow(() => generateConversationId(undefined, undefined, undefined));
  });
});

describe('state machine — new conversation (scenario 1)', () => {
  it('a customer message with an available agent starts as UNANSWERED', () => {
    const t = nextStatus(null, EVENT.CUSTOMER_MESSAGE, { hasAgent: true });
    assert.equal(t.next, STATUS.UNANSWERED);
    assert.ok(t.changed);
  });

  it('a customer message with NO agent starts as WAITING_FOR_AGENT (never dropped)', () => {
    const t = nextStatus(null, EVENT.CUSTOMER_MESSAGE, { hasAgent: false });
    assert.equal(t.next, STATUS.WAITING_FOR_AGENT);
  });
});

describe('state machine — existing conversation (scenario 2)', () => {
  it('a follow-up customer message on a REPLIED conversation returns it to UNANSWERED', () => {
    const t = nextStatus(STATUS.REPLIED, EVENT.CUSTOMER_MESSAGE, { hasAgent: true });
    assert.equal(t.next, STATUS.UNANSWERED, 'the business owes a reply again');
    assert.ok(t.changed);
  });

  it('a second message while already UNANSWERED does not change state', () => {
    const t = nextStatus(STATUS.UNANSWERED, EVENT.CUSTOMER_MESSAGE, { hasAgent: true });
    assert.equal(t.next, STATUS.UNANSWERED);
    assert.notOk(t.changed, 'no spurious update — reduces Sheets writes');
  });

  it('more messages while WAITING_FOR_AGENT keep it queued', () => {
    const t = nextStatus(STATUS.WAITING_FOR_AGENT, EVENT.CUSTOMER_MESSAGE, { hasAgent: false });
    assert.equal(t.next, STATUS.WAITING_FOR_AGENT);
    assert.notOk(t.changed);
  });

  it('an agent reply moves UNANSWERED to REPLIED', () => {
    const t = nextStatus(STATUS.UNANSWERED, EVENT.AGENT_MESSAGE, { hasAgent: true });
    assert.equal(t.next, STATUS.REPLIED);
  });
});

describe('state machine — closed conversations (scenario 10)', () => {
  it('a customer message REOPENS a closed conversation by default', () => {
    const t = nextStatus(STATUS.CLOSED, EVENT.CUSTOMER_MESSAGE, { hasAgent: true });
    assert.equal(t.next, STATUS.UNANSWERED);
    assert.equal(t.reason, 'reopened_by_customer_message');
  });

  it('reopening with no agent assigned goes back to the queue', () => {
    const t = nextStatus(STATUS.CLOSED, EVENT.CUSTOMER_MESSAGE, { hasAgent: false });
    assert.equal(t.next, STATUS.WAITING_FOR_AGENT);
  });

  it('honours reopenClosed=false (configurable policy)', () => {
    const t = nextStatus(STATUS.CLOSED, EVENT.CUSTOMER_MESSAGE, { hasAgent: true, reopenClosed: false });
    assert.equal(t.next, STATUS.CLOSED);
    assert.equal(t.reason, 'closed_conversation_not_reopened_by_config');
  });

  it('an agent message reopens a closed conversation (deliberate re-engagement)', () => {
    const t = nextStatus(STATUS.CLOSED, EVENT.AGENT_MESSAGE, { hasAgent: true });
    assert.equal(t.next, STATUS.REPLIED);
    assert.equal(t.reason, 'reopened_by_agent_message');
  });

  it('refuses to assign an agent to a closed conversation', () => {
    const t = nextStatus(STATUS.CLOSED, EVENT.AGENT_ASSIGNED, {});
    assert.equal(t.next, STATUS.CLOSED);
    assert.equal(t.reason, 'cannot_assign_closed_conversation');
  });

  it('an explicit REOPEN on a non-closed conversation is a no-op, not a corruption', () => {
    const t = nextStatus(STATUS.REPLIED, EVENT.REOPEN, {});
    assert.equal(t.next, STATUS.REPLIED);
    assert.notOk(t.changed);
  });
});

describe('state machine — assignment transitions', () => {
  it('AGENT_ASSIGNED moves a queued conversation to UNANSWERED', () => {
    const t = nextStatus(STATUS.WAITING_FOR_AGENT, EVENT.AGENT_ASSIGNED, { hasAgent: true });
    assert.equal(t.next, STATUS.UNANSWERED);
  });

  it('NO_AGENT_AVAILABLE queues rather than dropping', () => {
    const t = nextStatus(null, EVENT.NO_AGENT_AVAILABLE, {});
    assert.equal(t.next, STATUS.WAITING_FOR_AGENT);
  });

  it('an unknown event never corrupts an existing state', () => {
    const t = nextStatus(STATUS.REPLIED, 'SOME_EVENT_WE_DID_NOT_DEFINE', {});
    assert.equal(t.next, STATUS.REPLIED, 'state preserved');
    assert.equal(t.reason, 'unknown_event');
  });

  it('open statuses are exactly the non-closed ones', () => {
    assert.ok(isOpenStatus(STATUS.WAITING_FOR_AGENT));
    assert.ok(isOpenStatus(STATUS.UNANSWERED));
    assert.ok(isOpenStatus(STATUS.REPLIED));
    assert.notOk(isOpenStatus(STATUS.CLOSED));
    assert.notOk(isOpenStatus('GARBAGE'));
  });
});

describe('row building — new conversation', () => {
  const row = buildNewConversationRow({
    customer_phone: '962791234567',
    customer_name: 'Omar Khaled',
    business_phone_number_id: '106540352242922',
    assigned_agent_id: 'A2',
    assigned_agent_name: 'Mohammad',
    status: STATUS.UNANSWERED,
    last_message: 'بدي أعرف السعر',
    last_message_id: 'wamid.ABC',
    wa_link: 'https://wa.me/962791234567',
    now_iso: '2026-09-10T10:00:00.000Z',
  });

  it('matches the documented business example', () => {
    assert.equal(row.customer_phone, '962791234567');
    assert.equal(row.assigned_agent_name, 'Mohammad');
    assert.equal(row.status, 'UNANSWERED');
    assert.equal(row.last_message, 'بدي أعرف السعر');
    assert.equal(row.unread, 'TRUE');
    assert.equal(row.wa_link, 'https://wa.me/962791234567');
  });

  it('contains every documented column, with no undefined values', () => {
    const required = [
      'conversation_id', 'customer_phone', 'customer_name', 'business_phone_number_id',
      'assigned_agent_id', 'assigned_agent_name', 'status', 'last_message', 'last_message_id',
      'last_message_direction', 'last_customer_message_at', 'last_agent_message_at',
      'last_activity_at', 'unread', 'created_at', 'updated_at', 'closed_at', 'wa_link',
    ];
    for (const key of required) {
      assert.ok(Object.prototype.hasOwnProperty.call(row, key), 'missing column: ' + key);
      assert.ok(row[key] !== undefined && row[key] !== null, 'undefined column: ' + key);
    }
  });

  it('writes TRUE/FALSE strings that Google Sheets filters can use', () => {
    assert.ok(row.unread === 'TRUE' || row.unread === 'FALSE');
  });

  it('leaves last_agent_message_at and closed_at empty on creation', () => {
    assert.equal(row.last_agent_message_at, '');
    assert.equal(row.closed_at, '');
  });

  it('defaults to WAITING_FOR_AGENT when no status is supplied', () => {
    assert.equal(buildNewConversationRow({}).status, STATUS.WAITING_FOR_AGENT);
  });
});

describe('row updates — customer message', () => {
  it('sets unread and flips a replied conversation back to unanswered', () => {
    const existing = {
      status: STATUS.REPLIED,
      assigned_agent_id: 'A2',
      customer_name: 'Omar Khaled',
    };
    const { update, transition } = buildCustomerMessageUpdate(
      existing,
      { message_id: 'wamid.NEW', preview: 'تمام شكرا', timestamp_iso: '2026-09-10T11:00:00.000Z' },
      { now_iso: '2026-09-10T11:00:01.000Z' }
    );
    assert.equal(update.status, STATUS.UNANSWERED);
    assert.equal(update.unread, 'TRUE');
    assert.equal(update.last_message_direction, 'inbound');
    assert.equal(update.last_customer_message_at, '2026-09-10T11:00:00.000Z');
    assert.ok(transition.changed);
  });

  it('clears closed_at when reopening', () => {
    const { update } = buildCustomerMessageUpdate(
      { status: STATUS.CLOSED, assigned_agent_id: 'A2' },
      { message_id: 'wamid.X', preview: 'مرحبا مرة ثانية' }
    );
    assert.equal(update.closed_at, '', 'a reopened conversation must not keep a closure time');
  });

  it('backfills the customer name only when we did not already have one', () => {
    const withName = buildCustomerMessageUpdate(
      { status: STATUS.REPLIED, customer_name: 'Existing Name' },
      { message_id: 'w', customer_name: 'Profile Name' }
    );
    assert.equal(withName.update.customer_name, undefined, 'do not overwrite a known name');

    const withoutName = buildCustomerMessageUpdate(
      { status: STATUS.REPLIED, customer_name: '' },
      { message_id: 'w', customer_name: 'Profile Name' }
    );
    assert.equal(withoutName.update.customer_name, 'Profile Name');
  });

  it('never throws on missing existing conversation', () => {
    assert.doesNotThrow(() => buildCustomerMessageUpdate(null, { message_id: 'w' }));
    assert.doesNotThrow(() => buildCustomerMessageUpdate(undefined, {}));
  });
});

describe('row updates — agent message', () => {
  it('marks read, records the agent timestamp, and moves to REPLIED', () => {
    const { update } = buildAgentMessageUpdate(
      { status: STATUS.UNANSWERED, assigned_agent_id: 'A2' },
      { message_id: 'wamid.OUT', preview: 'السعر 25 دينار', timestamp_iso: '2026-09-10T11:05:00.000Z' }
    );
    assert.equal(update.status, STATUS.REPLIED);
    assert.equal(update.unread, 'FALSE');
    assert.equal(update.last_message_direction, 'outbound');
    assert.equal(update.last_agent_message_at, '2026-09-10T11:05:00.000Z');
  });

  it('does not touch last_customer_message_at', () => {
    const { update } = buildAgentMessageUpdate(
      { status: STATUS.UNANSWERED, last_customer_message_at: '2026-09-10T11:00:00.000Z' },
      { message_id: 'wamid.OUT' }
    );
    assert.equal(update.last_customer_message_at, undefined,
      'agent replies must not overwrite when the customer last spoke');
  });
});

describe('inactivity policy (scenario: configurable auto-close, MVP does not auto-close)', () => {
  const NOW = '2026-09-10T12:00:00.000Z';

  it('marks a conversation eligible after the threshold', () => {
    const r = isInactivityCloseEligible(
      { status: STATUS.REPLIED, last_activity_at: '2026-09-09T10:00:00.000Z' },
      { inactivityHours: 24, now: NOW }
    );
    assert.ok(r.eligible, 'idle 26h with a 24h threshold');
  });

  it('does not mark a still-active conversation', () => {
    const r = isInactivityCloseEligible(
      { status: STATUS.REPLIED, last_activity_at: '2026-09-10T11:00:00.000Z' },
      { inactivityHours: 24, now: NOW }
    );
    assert.notOk(r.eligible);
    assert.equal(r.reason, 'STILL_ACTIVE');
  });

  it('is disabled when the threshold is unset or zero (safe default)', () => {
    for (const h of [0, null, undefined, '', 'abc', -5]) {
      const r = isInactivityCloseEligible(
        { status: STATUS.REPLIED, last_activity_at: '2020-01-01T00:00:00.000Z' },
        { inactivityHours: h, now: NOW }
      );
      assert.notOk(r.eligible, 'must be disabled for: ' + String(h));
      assert.equal(r.reason, 'INACTIVITY_DISABLED');
    }
  });

  it('never re-closes an already closed conversation', () => {
    const r = isInactivityCloseEligible(
      { status: STATUS.CLOSED, last_activity_at: '2020-01-01T00:00:00.000Z' },
      { inactivityHours: 24, now: NOW }
    );
    assert.notOk(r.eligible);
    assert.equal(r.reason, 'NOT_OPEN');
  });

  it('refuses to act on a row with a corrupt timestamp', () => {
    const r = isInactivityCloseEligible(
      { status: STATUS.REPLIED, last_activity_at: 'yesterday sometime' },
      { inactivityHours: 24, now: NOW }
    );
    assert.notOk(r.eligible, 'must not close based on an unparseable date');
    assert.equal(r.reason, 'NO_VALID_LAST_ACTIVITY');
  });

  it('never throws', () => {
    for (const c of [null, undefined, {}, { status: null }]) {
      assert.doesNotThrow(() => isInactivityCloseEligible(c, { inactivityHours: 24 }));
    }
  });
});
