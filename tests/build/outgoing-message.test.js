/**
 * Workflow 4, the send API, run from the generated file.
 *
 * A send that failed used to update the conversation exactly like one that
 * went out: status REPLIED, unread cleared, and the text that never left
 * copied into last_message. The sheet then said a customer had been answered
 * when they had not.
 */

'use strict';

const path = require('path');

const WORKFLOW = require(path.join('..', '..', 'n8n', 'workflows', '04-outgoing-agent-message.json'));
const node = (name) => WORKFLOW.nodes.find((n) => n.name === name);

function interpret(response, request) {
  const code = node('Interpret Send Result').parameters.jsCode;
  const fn = new Function('require', '$env', '$input', '$', 'console', code);
  return fn(
    (m) => require(m),
    { WHATSAPP_CONNECTOR: 'meta' },
    { first: () => ({ json: response }) },
    () => ({ first: () => ({ json: request }) }),
    { log: () => {} }
  )[0].json;
}

const REQUEST = { conversation_id: 'CONV-a', agent_id: 'A1', to: '962790000001', text: 'hello' };

describe('Interpret Send Result (generated code)', () => {
  it('reports a send that went out', () => {
    const out = interpret({ messages: [{ id: 'wamid.1' }] }, REQUEST);
    assert.equal(out.ok, true);
    assert.equal(out.status, 'SENT');
    assert.equal(out.window_closed, false);
  });

  it('reports a closed window as its own state, not a plain failure', () => {
    const out = interpret({ error: { code: 131047, message: 'Re-engagement message' } }, REQUEST);
    assert.equal(out.status, 'WINDOW_CLOSED');
    assert.equal(out.window_closed, true);
    assert.equal(out.error_code, '131047');
  });

  it('still reports any other refusal as FAILED', () => {
    const out = interpret({ error: { code: 131026, message: 'Message undeliverable' } }, REQUEST);
    assert.equal(out.status, 'FAILED');
    assert.equal(out.window_closed, false);
  });
});

describe('Update Conversation After Reply', () => {
  const value = node('Update Conversation After Reply').parameters.columns.value;

  it('changes the conversation only when the send went out', () => {
    for (const column of ['status', 'last_message', 'last_message_id', 'last_message_direction',
      'last_agent_message_at', 'last_activity_at', 'unread']) {
      assert.includes(value[column], '.ok ?', column + ' is written even on a failure');
      assert.includes(value[column], 'undefined');
    }
  });

  it('still records that an attempt was made', () => {
    assert.includes(value.updated_at, '.sent_at');
    assert.notOk(value.updated_at.indexOf('.ok ?') !== -1);
  });

  it('finds the row by conversation_id', () => {
    assert.deepEqual(node('Update Conversation After Reply').parameters.columns.matchingColumns,
      ['conversation_id']);
  });
});
