/**
 * Workflow 7, the reply-from-sheet path, run from the generated file.
 *
 * Two defects lived here. Every outcome was written back by row number, which
 * goes stale the moment a row above moves. And the node that reads Meta's
 * answer read only the FIRST reply of a poll: the others were sent, never had
 * their cell cleared, and were sent again a minute later, and again, until
 * each got its turn at being first. These tests run the exact generated code
 * with stand-ins for n8n's globals.
 */

'use strict';

const path = require('path');

const WORKFLOW = require(path.join('..', '..', 'n8n', 'workflows', '07-reply-from-sheet.json'));

function code(name) {
  const node = WORKFLOW.nodes.find((n) => n.name === name);
  if (!node) throw new Error('no node ' + name + ' in workflow 7');
  return node.parameters.jsCode;
}

/** Run a Code node body the way n8n does, with the given inputs. */
function run(name, env) {
  const items = (env.inputs || []).map((json) => ({ json }));
  const fn = new Function('require', '$env', '$input', '$', 'console', code(name));
  return fn(
    (m) => require(m),
    env.$env || {},
    { all: () => items, first: () => items[0] },
    (node) => ({
      itemMatching: (i) => ({ json: (env.matching[node] || [])[i] }),
    }),
    { log: () => {} }
  );
}

/** An hour ago: inside Meta's 24-hour customer service window. */
const RECENT = new Date(Date.now() - 3600000).toISOString();
/** Two days ago: outside it. */
const OLD = new Date(Date.now() - 48 * 3600000).toISOString();

describe('Find Pending Replies (generated code)', () => {
  const rows = [
    { row_number: 2, conversation_id: 'CONV-1-962790000001-1', customer_phone: '962790000001', reply_text: 'hello', last_customer_message_at: RECENT },
    { row_number: 3, conversation_id: '', customer_phone: '0790000002', reply_text: 'new outreach', last_customer_message_at: RECENT },
    { row_number: 4, conversation_id: '', customer_phone: '12', reply_text: 'bad number', last_customer_message_at: RECENT },
    { row_number: 5, conversation_id: 'CONV-1-962790000004-1', customer_phone: '962790000004', reply_text: '', last_customer_message_at: RECENT },
  ];
  const out = run('Find Pending Replies', { $env: { DEFAULT_COUNTRY_CODE: '962' }, inputs: rows })
    .map((i) => i.json);

  it('ignores a row with nothing typed', () => {
    assert.equal(out.length, 3);
  });

  it('marks a row that has an id as not manual, so it is written back by id', () => {
    assert.equal(out[0].is_manual, false);
    assert.equal(out[0].conversation_id, 'CONV-1-962790000001-1');
  });

  it('mints an id for a hand-typed row and marks it manual, to be claimed by row number', () => {
    assert.equal(out[1].is_manual, true);
    assert.ok(/^CONV-.+-962790000002-\d+$/.test(out[1].conversation_id), out[1].conversation_id);
    assert.equal(out[1].row_number, 3);
  });

  it('marks an invalid hand-typed row manual too, so its error can still be recorded', () => {
    assert.equal(out[2].skip, true);
    assert.equal(out[2].is_manual, true);
    assert.equal(out[2].row_number, 4);
    assert.equal(out[2].reply_status, 'FAILED');
    assert.ok(out[2].reply_blocked_hash, 'a blocked row remembers why');
  });
});

describe('the 24-hour window guard (generated code)', () => {
  const row = (extra) => Object.assign({
    row_number: 2,
    conversation_id: 'CONV-1-962790000001-1',
    customer_phone: '962790000001',
    reply_text: 'are you still interested?',
  }, extra);
  const scan = (r) => run('Find Pending Replies', { $env: { DEFAULT_COUNTRY_CODE: '962' }, inputs: [r] })
    .map((i) => i.json);

  it('sends when the customer wrote within 24 hours', () => {
    const out = scan(row({ last_customer_message_at: RECENT }));
    assert.equal(out.length, 1);
    assert.equal(out[0].skip, false);
  });

  it('refuses to send after 24 hours, keeps the text, and says why', () => {
    const out = scan(row({ last_customer_message_at: OLD }));
    assert.equal(out.length, 1);
    assert.equal(out[0].skip, true, 'no API call is made');
    assert.equal(out[0].reply_status, 'WINDOW_CLOSED');
    assert.includes(out[0].reply_error, 'window_closed');
    assert.equal(out[0].reply_text, 'are you still interested?');
  });

  it('refuses a number that never wrote to us: a new row can only get a template', () => {
    const out = scan(row({ last_customer_message_at: '' }));
    assert.equal(out[0].reply_status, 'WINDOW_CLOSED');
    assert.includes(out[0].reply_error, 'no_customer_message');
  });

  it('writes the refusal once, then skips the row while nothing changes', () => {
    const first = scan(row({ last_customer_message_at: OLD }))[0];
    const again = scan(row({ last_customer_message_at: OLD, reply_blocked_hash: first.reply_blocked_hash }));
    assert.deepEqual(again, [], 'no write on the next poll');
  });

  it('picks the row up again when the text is edited', () => {
    const first = scan(row({ last_customer_message_at: OLD }))[0];
    const edited = scan(row({
      last_customer_message_at: OLD,
      reply_text: 'different words',
      reply_blocked_hash: first.reply_blocked_hash,
    }));
    assert.equal(edited.length, 1);
    assert.notOk(edited[0].reply_blocked_hash === first.reply_blocked_hash);
  });

  it('picks the row up again when the customer writes and the window reopens', () => {
    const first = scan(row({ last_customer_message_at: OLD }))[0];
    const reopened = scan(row({ last_customer_message_at: RECENT, reply_blocked_hash: first.reply_blocked_hash }));
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0].skip, false, 'it sends now');
  });

  it('checks the number before the window, so a bad number still reads as a bad number', () => {
    const out = scan(row({ customer_phone: '12', last_customer_message_at: OLD }));
    assert.equal(out[0].reply_status, 'FAILED');
    assert.includes(out[0].reply_error, 'invalid_phone');
  });
});

describe('Interpret Sheet Send (generated code)', () => {
  const requests = [
    { conversation_id: 'CONV-a', is_manual: false, row_number: 2, to: '962790000001', text: 'one',
      customer_phone: '962790000001', agent_id: 'A1', source_row: { status: 'UNANSWERED' } },
    { conversation_id: 'CONV-b', is_manual: true, row_number: 3, to: '962790000002', text: 'two',
      customer_phone: '962790000002', agent_id: 'sheet', source_row: {} },
    { conversation_id: 'CONV-c', is_manual: false, row_number: 7, to: '962790000003', text: 'three',
      customer_phone: '962790000003', agent_id: 'A2', source_row: { status: 'UNANSWERED', unread: 'TRUE' } },
  ];
  const responses = [
    { messages: [{ id: 'wamid.one' }] },
    { messages: [{ id: 'wamid.two' }] },
    { error: { code: 131047, message: 'Re-engagement message' } },
  ];
  const out = run('Interpret Sheet Send', {
    $env: { WHATSAPP_CONNECTOR: 'meta' },
    inputs: responses,
    matching: { 'Sendable?': requests },
  });

  it('answers for EVERY reply sent in the poll, not only the first', () => {
    assert.equal(out.length, 3);
  });

  it('pairs each answer with its own request', () => {
    assert.deepEqual(out.map((i) => i.json.conversation_id), ['CONV-a', 'CONV-b', 'CONV-c']);
    assert.deepEqual(out.map((i) => i.pairedItem.item), [0, 1, 2]);
  });

  it('records each outcome separately', () => {
    assert.deepEqual(out.map((i) => i.json.reply_status), ['SENT', 'SENT', 'WINDOW_CLOSED']);
    assert.equal(out[1].json.message_id, 'wamid.two');
    assert.includes(out[2].json.reply_error, '131047');
  });

  it('treats Meta refusing a closed window as the guard does: keeps the text and remembers it', () => {
    assert.equal(out[2].json.keep_text, true);
    assert.equal(out[2].json.reply_text, 'three');
    assert.ok(out[2].json.reply_blocked_hash, 'the next poll will skip it');
  });

  it('clears the text and the memory on a send that went out', () => {
    assert.equal(out[0].json.keep_text, false);
    assert.equal(out[0].json.reply_blocked_hash, '');
  });

  it('gives a failed send its own dedupe key, instead of one shared by every failure', () => {
    assert.equal(out[0].json.dedupe_key, 'message:wamid.one');
    assert.includes(out[2].json.dedupe_key, 'failed:CONV-c:');
  });

  it('still reports a plain failure as FAILED', () => {
    const plain = run('Interpret Sheet Send', {
      $env: { WHATSAPP_CONNECTOR: 'meta' },
      inputs: [{ error: { code: 131026, message: 'Message undeliverable' } }],
      matching: { 'Sendable?': [requests[0]] },
    });
    assert.equal(plain[0].json.reply_status, 'FAILED');
    assert.equal(plain[0].json.keep_text, false);
  });

  it('keeps a failed conversation exactly as it was', () => {
    assert.equal(out[2].json.new_status, 'UNANSWERED');
    assert.equal(out[2].json.new_unread, 'TRUE');
  });

  it('carries is_manual through, so each outcome goes to the right write', () => {
    assert.deepEqual(out.map((i) => i.json.is_manual), [false, true, false]);
  });
});

describe('workflow 7 wiring', () => {
  const node = (name) => WORKFLOW.nodes.find((n) => n.name === name);
  const targets = (name) => WORKFLOW.connections[name].main.map((o) => o.map((t) => t.node));

  it('writes a sent reply back by conversation_id, and claims only a hand-typed row by number', () => {
    assert.deepEqual(targets('Row Had An Id?'),
      [['Clear Cell And Record Outcome'], ['Claim Row And Record Outcome']]);
    assert.deepEqual(node('Clear Cell And Record Outcome').parameters.columns.matchingColumns, ['conversation_id']);
    assert.deepEqual(node('Claim Row And Record Outcome').parameters.columns.matchingColumns, ['row_number']);
  });

  it('writes an invalid reply back the same way', () => {
    assert.deepEqual(targets('Invalid Row Had An Id?'),
      [['Mark Invalid Reply'], ['Claim Row And Mark Invalid']]);
    assert.deepEqual(node('Mark Invalid Reply').parameters.columns.matchingColumns, ['conversation_id']);
  });

  it('the claim gives the row its id and the number it was sent to', () => {
    const value = node('Claim Row And Record Outcome').parameters.columns.value;
    assert.includes(value.conversation_id, '($json.conversation_id)');
    assert.includes(value.customer_phone, '($json.customer_phone)');
  });
});

const CATALOG = JSON.stringify([
  { name: 'followup_general', language: 'ar', category: 'utility', params: ['customer_name'] },
]);

describe('templates (generated code)', () => {
  const row = (extra) => Object.assign({
    row_number: 2,
    conversation_id: 'CONV-1-962790000001-1',
    customer_phone: '962790000001',
    customer_name: 'أحمد',
    last_customer_message_at: OLD,          // the window is closed
  }, extra);
  const scan = (r, env) => run('Find Pending Replies', {
    $env: Object.assign({ DEFAULT_COUNTRY_CODE: '962', WHATSAPP_TEMPLATES: CATALOG, WHATSAPP_CONNECTOR: 'meta' }, env),
    inputs: [r],
  }).map((i) => i.json);

  it('sends an approved template even though the window is closed', () => {
    const out = scan(row({ reply_text: '[TEMPLATE] followup_general' }));
    assert.equal(out.length, 1);
    assert.equal(out[0].skip, false);
    assert.equal(out[0].is_template, true);
    assert.equal(out[0].template_name, 'followup_general');
  });

  it('builds the body Meta expects, with the parameter from the row', () => {
    const body = scan(row({ reply_text: '[TEMPLATE] followup_general' }))[0].template_body;
    assert.equal(body.type, 'template');
    assert.equal(body.template.name, 'followup_general');
    assert.deepEqual(body.template.components[0].parameters, [{ type: 'text', text: 'أحمد' }]);
  });

  it('accepts the Arabic marker from a phone keyboard', () => {
    assert.equal(scan(row({ reply_text: '[قالب] followup_general' }))[0].is_template, true);
  });

  it('refuses a name that is not in the allow-list, before spending anything', () => {
    const out = scan(row({ reply_text: '[TEMPLATE] made_up' }));
    assert.equal(out[0].skip, true);
    assert.includes(out[0].reply_error, 'unknown_template:made_up');
  });

  it('refuses when no templates are configured', () => {
    const out = scan(row({ reply_text: '[TEMPLATE] followup_general' }), { WHATSAPP_TEMPLATES: '' });
    assert.equal(out[0].skip, true);
    assert.includes(out[0].reply_error, 'no_templates_configured');
  });

  it('names the empty cell instead of sending a template Meta would refuse', () => {
    const out = scan(row({ reply_text: '[TEMPLATE] followup_general', customer_name: '' }));
    assert.equal(out[0].skip, true);
    assert.includes(out[0].reply_error, 'template_needs:customer_name');
  });

  it('refuses a template on the WAHA connector, which has none', () => {
    const out = scan(row({ reply_text: '[TEMPLATE] followup_general' }), { WHATSAPP_CONNECTOR: 'waha' });
    assert.equal(out[0].skip, true);
    assert.includes(out[0].reply_error, 'templates_need_cloud_api');
  });

  it('leaves an ordinary reply alone', () => {
    const out = scan(row({ reply_text: 'hello', last_customer_message_at: RECENT }));
    assert.equal(out[0].is_template, false);
    assert.equal(out[0].template_body, null);
  });
});

describe('a template is recorded as a template', () => {
  const out = run('Interpret Sheet Send', {
    $env: { WHATSAPP_CONNECTOR: 'meta' },
    inputs: [{ messages: [{ id: 'wamid.t' }] }],
    matching: { 'Sendable?': [{
      conversation_id: 'CONV-t', is_manual: false, row_number: 2, to: '962790000001',
      text: '[TEMPLATE] followup_general', is_template: true, template_name: 'followup_general',
      agent_id: 'sheet', source_row: {},
    }] },
  })[0].json;

  it('says how it was sent, and what kind of message it was', () => {
    assert.equal(out.sent_via, 'template');
    assert.equal(out.message_type, 'template');
    assert.equal(out.template_name, 'followup_general');
  });

  it('an ordinary reply still reads as a sheet reply', () => {
    const plain = run('Interpret Sheet Send', {
      $env: { WHATSAPP_CONNECTOR: 'meta' },
      inputs: [{ messages: [{ id: 'wamid.p' }] }],
      matching: { 'Sendable?': [{ conversation_id: 'CONV-p', text: 'hi', source_row: {} }] },
    })[0].json;
    assert.equal(plain.sent_via, 'google_sheet');
    assert.equal(plain.message_type, 'text');
  });
});
