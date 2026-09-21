/**
 * Codes inside, labels at the boundary (scripts/lib/labels.js).
 */

'use strict';

const { LANGUAGES, ARABIC, TABS, codes, toLabel, toCode, tabName } = require('../../scripts/lib/labels');
const { STATUS } = require('../../scripts/lib/conversation');

describe('labels', () => {
  it('has a label for every conversation status the state machine knows', () => {
    for (const status of Object.values(STATUS)) {
      assert.ok(codes('status').indexOf(status) !== -1, 'no label for ' + status);
    }
  });

  it('round-trips every code of every field in every language', () => {
    for (const field of Object.keys(ARABIC)) {
      for (const code of codes(field)) {
        for (const lang of LANGUAGES) {
          assert.equal(toCode(field, toLabel(field, code, lang)), code, field + '/' + code + '/' + lang);
        }
      }
    }
  });

  it('never gives two codes the same label within a field', () => {
    for (const field of Object.keys(ARABIC)) {
      const labels = codes(field).map((c) => ARABIC[field][c]);
      assert.equal(new Set(labels).size, labels.length, field + ' has a repeated label');
    }
  });

  it('keeps an English sheet exactly as it is: the English label is the code', () => {
    assert.equal(toLabel('status', 'UNANSWERED', 'en'), 'UNANSWERED');
    assert.equal(toLabel('direction', 'inbound', 'en'), 'inbound');
  });

  it('writes Arabic for an Arabic sheet', () => {
    assert.equal(toLabel('status', 'CLOSED', 'ar'), 'مغلقة');
    assert.equal(toLabel('status', 'WAITING_FOR_CUSTOMER', 'ar'), 'معلّقة');
  });

  it('reads a code, its English form in any case, or its Arabic label', () => {
    assert.equal(toCode('status', 'CLOSED'), 'CLOSED');
    assert.equal(toCode('status', 'closed'), 'CLOSED');
    assert.equal(toCode('status', '  مغلقة  '), 'CLOSED');
    assert.equal(toCode('reply_status', 'فشل'), 'FAILED');
  });

  it('answers null for a value it does not know, instead of guessing', () => {
    assert.equal(toCode('status', 'maybe'), null);
    assert.equal(toCode('status', ''), null);
    assert.equal(toCode('status', null), null);
  });

  it('writes an unknown code unchanged rather than blanking it', () => {
    assert.equal(toLabel('status', 'SOMETHING_NEW', 'ar'), 'SOMETHING_NEW');
    assert.equal(toLabel('status', '', 'ar'), '');
  });

  it('refuses an unknown field or tab, which is a bug and not data', () => {
    assert.throws(() => toCode('colour', 'red'));
    assert.throws(() => tabName('Nowhere', 'ar'));
  });

  it('names every tab in every language, and keeps the hidden ones in English', () => {
    for (const key of Object.keys(TABS)) {
      for (const lang of LANGUAGES) assert.ok(tabName(key, lang), key + '/' + lang);
    }
    assert.equal(tabName('Conversations', 'en'), 'Conversations');
    assert.equal(tabName('Conversations', 'ar'), 'المحادثات');
    assert.equal(tabName('Messages', 'ar'), 'Messages');
  });
});
