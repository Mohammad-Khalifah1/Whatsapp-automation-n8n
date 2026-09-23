/**
 * Codes inside, labels at the boundary (scripts/lib/labels.js).
 */

'use strict';

const { LANGUAGES, ARABIC, TABS, codes, toLabel, toCode, tabName,
  normalizeConversationRow, conversationRowToSheet } = require('../../scripts/lib/labels');
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

describe('a whole conversation row, at the boundary', () => {
  const STORED = {
    conversation_id: 'C-1',
    customer_name: 'مغلقة',
    status: 'مغلقة',
    last_message_direction: 'الزبون',
    last_reply_via: 'قالب (مدفوع)',
    reply_text: '= this is text, not a field it converts',
  };

  it('turns every labelled column back into a code on the way in', () => {
    const row = normalizeConversationRow(STORED);
    assert.equal(row.status, 'CLOSED');
    assert.equal(row.last_message_direction, 'inbound');
    assert.equal(row.last_reply_via, 'TEMPLATE');
  });

  it('leaves every other column exactly as it found it', () => {
    const row = normalizeConversationRow(STORED);
    assert.equal(row.customer_name, 'مغلقة', 'a name that reads like a status is still a name');
    assert.equal(row.reply_text, STORED.reply_text);
    assert.equal(row.conversation_id, 'C-1');
  });

  it('round-trips a row back into the words the sheet holds', () => {
    assert.deepEqual(conversationRowToSheet(normalizeConversationRow(STORED), 'ar'), STORED);
  });

  it('keeps a value it does not recognise rather than blanking it', () => {
    const row = normalizeConversationRow({ status: 'على نار هادية' });
    assert.equal(row.status, 'على نار هادية', 'an unexpected status is something to look at');
    assert.equal(conversationRowToSheet(row, 'ar').status, 'على نار هادية');
  });

  it('changes nothing about an English sheet', () => {
    const english = { status: 'UNANSWERED', last_message_direction: 'inbound', unread: 'TRUE' };
    assert.deepEqual(normalizeConversationRow(english), english);
    assert.deepEqual(conversationRowToSheet(english, 'en'), english);
  });

  it('hands back anything that is not a row, instead of throwing on it', () => {
    assert.equal(normalizeConversationRow(null), null);
    assert.equal(conversationRowToSheet(undefined, 'ar'), undefined);
  });
});
