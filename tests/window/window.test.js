/**
 * The 24-hour customer service window (scripts/lib/window.js).
 */

'use strict';

const { WINDOW_HOURS, windowState } = require('../../scripts/lib/window');

const HOUR = 3600000;
const LAST = '2026-09-21T10:00:00.000+03:00';       // 07:00 UTC
const AT = Date.parse(LAST);

describe('windowState', () => {
  it('is a 24-hour window', () => {
    assert.equal(WINDOW_HOURS, 24);
  });

  it('is open one minute before it closes', () => {
    const w = windowState({ last_customer_message_at: LAST, now: AT + 24 * HOUR - 60000 });
    assert.equal(w.open, true);
    assert.equal(w.hours_left, 0, 'less than an hour left rounds down to 0');
  });

  it('is closed exactly 24 hours after the customer last wrote', () => {
    const w = windowState({ last_customer_message_at: LAST, now: AT + 24 * HOUR });
    assert.equal(w.open, false);
    assert.equal(w.hours_left, 0);
    assert.equal(w.reason, 'closed');
  });

  it('rounds hours left down', () => {
    const w = windowState({ last_customer_message_at: LAST, now: AT + 2.5 * HOUR });
    assert.equal(w.hours_left, 21);
  });

  it('says when it closes, in UTC', () => {
    assert.equal(windowState({ last_customer_message_at: LAST, now: AT }).closes_at, '2026-09-22T07:00:00.000Z');
  });

  it('reads an offset and a Z timestamp for the same instant the same way', () => {
    const a = windowState({ last_customer_message_at: LAST, now: AT + HOUR });
    const b = windowState({ last_customer_message_at: '2026-09-21T07:00:00.000Z', now: AT + HOUR });
    assert.deepEqual(a, b);
  });

  it('counts a missing timestamp as closed', () => {
    for (const value of [undefined, null, '', '   ']) {
      const w = windowState({ last_customer_message_at: value, now: AT });
      assert.equal(w.open, false);
      assert.equal(w.reason, 'no_customer_message');
      assert.equal(w.closes_at, null);
    }
  });

  it('counts an unreadable timestamp as closed', () => {
    const w = windowState({ last_customer_message_at: 'yesterday', now: AT });
    assert.equal(w.open, false);
    assert.equal(w.reason, 'unreadable_timestamp');
  });

  it('never promises more than a whole window, even from a clock running ahead', () => {
    const w = windowState({ last_customer_message_at: LAST, now: AT - 5 * HOUR });
    assert.equal(w.open, true);
    assert.equal(w.hours_left, 24);
  });

  it('accepts now as a Date', () => {
    assert.equal(windowState({ last_customer_message_at: LAST, now: new Date(AT + HOUR) }).hours_left, 23);
  });
});
