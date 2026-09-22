/**
 * How a blocked reply is remembered (scripts/lib/reply-guard.js).
 *
 * A reply that cannot go out keeps its text, so the poll a minute later would
 * find it again and rewrite the same failure for as long as it sits there.
 * The row remembers this text, blocked for this reason, and is skipped while
 * both are unchanged.
 */

'use strict';

const { blockedHash } = require('../../scripts/lib/reply-guard');

describe('blockedHash', () => {
  it('is the same for the same text and reason', () => {
    assert.equal(blockedHash('are you still there?', 'window_closed:closed'),
      blockedHash('are you still there?', 'window_closed:closed'));
  });

  it('changes when the text is edited', () => {
    assert.notOk(blockedHash('a', 'window_closed:closed') === blockedHash('b', 'window_closed:closed'));
  });

  it('changes when the reason changes, so a reopened window is picked up', () => {
    assert.notOk(blockedHash('a', 'window_closed:closed') === blockedHash('a', 'invalid_phone:ambiguous'));
  });

  it('does not confuse a text/reason split', () => {
    assert.notOk(blockedHash('ab', 'c') === blockedHash('a', 'bc'));
  });

  it('is short enough for a cell, and stable across runs', () => {
    const hash = blockedHash('مرحبا', 'window_closed:no_customer_message');
    assert.equal(hash.length, 16);
    assert.ok(/^[0-9a-f]{16}$/.test(hash));
  });

  it('handles missing values instead of throwing', () => {
    assert.equal(blockedHash(undefined, undefined).length, 16);
    assert.equal(blockedHash(null, 'x').length, 16);
  });
});
