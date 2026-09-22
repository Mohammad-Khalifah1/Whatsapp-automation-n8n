/**
 * How a customer was answered, and when they were answered first.
 *
 * A reply from the WhatsApp Business app, from the sheet, and as a paid
 * template cost very different amounts, and the sheet could not tell them
 * apart. `first_reply_at` is what a first-response time is measured to, so it
 * is set once and never moved.
 */

'use strict';

const { buildAgentMessageUpdate, STATUS } = require('../../scripts/lib/conversation');

const MESSAGE = { message_id: 'wamid.1', preview: 'on its way', timestamp_iso: '2026-09-22T10:00:00.000+03:00' };

describe('how the reply was sent', () => {
  it('records the path when one is given', () => {
    const { update } = buildAgentMessageUpdate({ status: STATUS.UNANSWERED }, MESSAGE, { via: 'APP' });
    assert.equal(update.last_reply_via, 'APP');
  });

  it('leaves the cell alone when no path is given, instead of blanking it', () => {
    const { update } = buildAgentMessageUpdate({ status: STATUS.UNANSWERED, last_reply_via: 'SHEET' }, MESSAGE, {});
    assert.equal(update.last_reply_via, undefined);
  });
});

describe('when the customer was first answered', () => {
  it('is set on the first reply', () => {
    const { update } = buildAgentMessageUpdate({ status: STATUS.UNANSWERED }, MESSAGE, { via: 'APP' });
    assert.equal(update.first_reply_at, MESSAGE.timestamp_iso);
  });

  it('is never moved by a later reply', () => {
    const existing = { status: STATUS.REPLIED, first_reply_at: '2026-09-20T09:00:00.000+03:00' };
    const { update } = buildAgentMessageUpdate(existing, MESSAGE, { via: 'APP' });
    assert.equal(update.first_reply_at, undefined, 'undefined leaves the cell exactly as it was');
  });

  it('falls back to now when the message carries no timestamp', () => {
    const { update } = buildAgentMessageUpdate({}, { preview: 'hi' }, { now_iso: '2026-09-22T11:00:00.000+03:00' });
    assert.equal(update.first_reply_at, '2026-09-22T11:00:00.000+03:00');
  });
});
