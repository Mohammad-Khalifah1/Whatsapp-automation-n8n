/**
 * The MVP workflow's decision node, executed as generated.
 *
 * The unit tests around it prove each library function in isolation. This runs
 * the ACTUAL JavaScript that ships inside `00-mvp-inbound.json` — the inlined
 * prelude plus the node body — against real Meta webhook fixtures, with n8n's
 * `$()` and `$env` stubbed.
 *
 * That matters because everything this file covers is composition, and
 * composition is where the silent failures live: reading the wrong field off an
 * event, letting a raw phone number overwrite a normalized one, or returning a
 * nested object to a Sheets node that only maps top-level fields. None of those
 * break a library test, and none of them throw at runtime — they just write the
 * wrong thing, or nothing, to the sheet and report success.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, 'n8n', 'workflows', '00-mvp-inbound.json');
const FIXTURES = path.join(ROOT, 'n8n', 'fixtures');

/** Pull one Code node's body out of the generated workflow. */
function nodeCode(nodeName) {
  const wf = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));
  const node = (wf.nodes || []).find((n) => n.name === nodeName);
  if (!node) throw new Error('node not found in generated workflow: ' + nodeName);
  return node.parameters.jsCode;
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name + '.json'), 'utf8'));
}

/**
 * Run a Code node body the way n8n does: as a function, with the node-reference
 * helpers in scope. Returns both the items and the structured log lines, since
 * the log is where the workflow records why it decided what it decided.
 */
function runNode(code, nodeOutputs, env) {
  const logs = [];
  const $ = (name) => {
    if (!Object.prototype.hasOwnProperty.call(nodeOutputs, name)) {
      throw new Error('node body referenced an unstubbed node: ' + name);
    }
    const items = (nodeOutputs[name] || []).map((json) => ({ json }));
    return {
      all: () => items,
      first: () => items[0] || { json: {} },
    };
  };

  // n8n exposes only the built-ins listed in NODE_FUNCTION_ALLOW_BUILTIN
  // (docker-compose.yml sets it to `crypto`). Mirroring that here means a Code
  // node that reached for anything else would fail this test rather than fail
  // in production.
  const allowedBuiltins = ['crypto'];
  const requireStub = (name) => {
    if (allowedBuiltins.indexOf(name) === -1) {
      throw new Error('Code node required a module n8n does not allow: ' + name);
    }
    return require(name);
  };

  const sandbox = {
    $,
    $env: env || {},
    require: requireStub,
    Buffer,
    console: {
      log: (line) => {
        try {
          logs.push(JSON.parse(line));
        } catch (e) {
          logs.push({ raw: line });
        }
      },
    },
  };

  const items = new vm.Script('(function () {\n' + code + '\n})()').runInNewContext(sandbox);
  return { items: items.map((i) => i.json), logs };
}

/**
 * Feed a fixture through the real parse node, so the events handed to the
 * resolve node have exactly the shape the workflow produces at runtime —
 * not a shape this test invented.
 */
function parseFixture(fixtureName) {
  const body = fixture(fixtureName);
  const { items } = runNode(
    nodeCode('Parse & Normalize Events'),
    { 'Verify Signature': [{ body }] },
    { DEFAULT_COUNTRY_CODE: '962' }
  );
  return items;
}

function resolve(options) {
  const o = options || {};
  return runNode(
    nodeCode('Resolve, Classify & Assign'),
    {
      'Parse & Normalize Events': o.events || [],
      'Lookup Duplicate': o.duplicates || [],
      'Read Conversations': o.conversations || [],
      'Read Agents': o.agents || [],
      'Read Categories': o.categories || [],
    },
    Object.assign({ DEFAULT_COUNTRY_CODE: '962' }, o.env || {})
  );
}

const AGENTS = [
  { agent_id: 'A1', name: 'Ahmed', active: 'TRUE', available: 'TRUE', max_open_conversations: '5', open_conversations: '0', last_assigned_at: '' },
  { agent_id: 'A2', name: 'Sara', active: 'TRUE', available: 'TRUE', max_open_conversations: '5', open_conversations: '0', last_assigned_at: '' },
];

const CATEGORIES = [
  { category_id: 'C-PRICE', name: 'استفسار سعر', keywords: 'سعر, بكم, price', priority: '20', active: 'TRUE' },
  { category_id: 'C-COMPLAINT', name: 'شكوى', keywords: 'شكوى, مشكلة', priority: '5', active: 'TRUE' },
];

describe('MVP resolve node — a new customer message', () => {
  const events = parseFixture('text-message');
  const { items, logs } = resolve({ events, agents: AGENTS, categories: CATEGORIES });

  it('produces exactly one row to write', () => {
    assert.equal(items.length, 1);
  });

  it('marks it as an append, since no conversation existed', () => {
    assert.equal(items[0].sheet_operation, 'append');
  });

  it('assigns an eligible agent and sets the status accordingly', () => {
    assert.ok(items[0].assigned_agent_id, 'expected an agent to be assigned');
    assert.equal(items[0].status, 'UNANSWERED');
    assert.equal(items[0].unassigned_reason, '');
  });

  it('classifies the message from the Categories rows', () => {
    // The fixture is the specification's own example: a price enquiry.
    assert.equal(items[0].category, 'استفسار سعر');
    assert.equal(items[0].message_category, 'استفسار سعر');
  });

  it('stores the NORMALIZED phone number, never the raw one', () => {
    // The event carries `customer_phone` straight from Meta and
    // `customer_phone_e164` normalized. Both would map to the same sheet
    // column, and spreading the event would let the raw one win.
    assert.equal(items[0].customer_phone, events[0].customer_phone_e164);
    assert.ok(/^[0-9]+$/.test(items[0].customer_phone), 'phone must be digits only');
  });

  it('keeps the row flat — a nested row appends a blank line and reports success', () => {
    for (const key of ['conversation_id', 'status', 'customer_phone', 'category', 'last_message']) {
      assert.equal(typeof items[0][key], 'string', key + ' must be a top-level string');
    }
  });

  it('records the decision in the log', () => {
    const resolved = logs.find((l) => l.event === 'message_resolved');
    assert.ok(resolved, 'expected a message_resolved log line');
    assert.equal(resolved.created, true);
    assert.equal(resolved.category, 'استفسار سعر');
  });
});

describe('MVP resolve node — idempotency', () => {
  it('writes nothing when the message is already in the Messages sheet', () => {
    const events = parseFixture('text-message');
    const { items, logs } = resolve({
      events,
      duplicates: [{ dedupe_key: events[0].dedupe_key, message_id: events[0].message_id }],
      agents: AGENTS,
      categories: CATEGORIES,
    });

    assert.equal(items.length, 0, 'a Meta retry must not create a second row');
    assert.ok(logs.some((l) => l.event === 'duplicate_skipped'));
  });

  it('reports the skip in the batch summary', () => {
    const events = parseFixture('text-message');
    const { logs } = resolve({
      events,
      duplicates: [{ dedupe_key: events[0].dedupe_key }],
      agents: AGENTS,
      categories: CATEGORIES,
    });
    const done = logs.find((l) => l.event === 'batch_done');
    assert.equal(done.received, 1);
    assert.equal(done.written, 0);
    assert.equal(done.skipped_duplicates, 1);
  });
});

describe('MVP resolve node — an existing conversation', () => {
  const events = parseFixture('text-message');
  const existing = {
    conversation_id: 'CONV-EXISTING-1',
    customer_phone: events[0].customer_phone_e164,
    business_phone_number_id: events[0].business_phone_number_id,
    assigned_agent_id: 'A2',
    assigned_agent_name: 'Sara',
    status: 'REPLIED',
    category: 'شكوى',
    last_activity_at: '2026-09-10T09:00:00.000Z',
    created_at: '2026-09-10T08:00:00.000Z',
    reply_text: 'a manager was mid-sentence',
  };

  const { items } = resolve({
    events,
    conversations: [existing],
    agents: AGENTS,
    categories: CATEGORIES,
  });

  it('updates the existing conversation instead of creating a second one', () => {
    assert.equal(items.length, 1);
    assert.equal(items[0].sheet_operation, 'update');
    assert.equal(items[0].conversation_id, 'CONV-EXISTING-1');
  });

  it('does not reassign a conversation that already has an agent', () => {
    assert.equal(items[0].assigned_agent_id, undefined, 'assignment fields must be absent');
    assert.equal(items[0].agent_id, 'A2', 'the message is still attributed to Sara');
  });

  it('sends ONLY changed fields, so it cannot clobber a manager mid-edit', () => {
    // The Sheets node writes every top-level field it recognises. Anything not
    // in this item keeps its current cell value.
    assert.equal(items[0].reply_text, undefined);
    assert.equal(items[0].created_at, undefined);
    assert.equal(items[0].customer_phone, undefined);
  });

  it('moves the conversation back to UNANSWERED', () => {
    assert.equal(items[0].status, 'UNANSWERED');
    assert.equal(items[0].unread, 'TRUE');
  });

  it('overwrites the category only when the new message actually matched', () => {
    // This fixture matches the pricing keywords, so it wins.
    assert.equal(items[0].category, 'استفسار سعر');
  });
});

describe('MVP resolve node — a batched webhook', () => {
  const events = parseFixture('batched-multiple-messages');
  const { items } = resolve({ events, agents: AGENTS, categories: CATEGORIES });

  it('processes every message, not just the first', () => {
    const messages = events.filter((e) => e.kind === 'message');
    assert.ok(messages.length > 1, 'fixture should contain several messages');
    assert.equal(items.length, messages.length);
  });

  it('gives one customer one conversation, however many messages they sent', () => {
    const byCustomer = {};
    for (const item of items) {
      const phone = item.customer_phone || item.sender_phone;
      byCustomer[phone] = byCustomer[phone] || new Set();
      byCustomer[phone].add(item.conversation_id);
    }
    for (const phone of Object.keys(byCustomer)) {
      assert.equal(byCustomer[phone].size, 1, 'customer ' + phone + ' got more than one conversation');
    }
  });

  it('spreads a batch across agents instead of giving them all to one', () => {
    // Load is incremented in memory as each assignment is made, so the second
    // customer in a batch does not see the first customer's agent as idle.
    const appends = items.filter((i) => i.sheet_operation === 'append');
    if (appends.length > 1) {
      const assigned = new Set(appends.map((i) => i.assigned_agent_id));
      assert.ok(assigned.size > 1, 'a batch of new conversations all went to one agent');
    }
  });
});

describe('MVP resolve node — nothing is ever dropped', () => {
  it('queues the conversation when no agent is eligible', () => {
    const offline = AGENTS.map((a) => Object.assign({}, a, { available: 'FALSE' }));
    const { items } = resolve({
      events: parseFixture('text-message'),
      agents: offline,
      categories: CATEGORIES,
    });

    assert.equal(items.length, 1, 'the message must still be recorded');
    assert.equal(items[0].status, 'WAITING_FOR_AGENT');
    assert.ok(items[0].unassigned_reason, 'the reason must be recorded, not left blank');
  });

  it('classifies a message that has no words at all as NO_TEXT', () => {
    // A location has nothing to match. Its preview reads "[location] ...",
    // which must never be fed to the matcher — the word "location" is exactly
    // the sort of keyword a business would put in a delivery category.
    const { items } = resolve({
      events: parseFixture('location-message'),
      agents: AGENTS,
      categories: CATEGORIES,
    });

    assert.equal(items.length, 1, 'the message must still be recorded');
    assert.equal(items[0].category, 'غير مصنّف');
    assert.equal(items[0].classification_reason, 'no_text_to_classify');
  });

  it('classifies an image by its caption, which is real customer text', () => {
    const { items } = resolve({
      events: parseFixture('image-message'),
      agents: AGENTS,
      categories: CATEGORIES,
    });

    assert.equal(items.length, 1);
    // This fixture's caption matches no keyword, so it falls back — but on
    // NO_MATCH, meaning the caption was genuinely considered.
    assert.equal(items[0].classification_reason, 'no_keyword_matched');
    assert.equal(items[0].message_type, 'image');
  });

  it('records an unsupported message type rather than discarding it', () => {
    const { items } = resolve({
      events: parseFixture('unsupported-type'),
      agents: AGENTS,
      categories: CATEGORIES,
    });

    assert.equal(items.length, 1, 'an unsupported type is still a customer waiting');
    assert.equal(items[0].processing_status, 'unsupported');
    assert.ok(items[0].conversation_id);
  });

  it('still works when the Categories tab is empty', () => {
    const { items } = resolve({
      events: parseFixture('text-message'),
      agents: AGENTS,
      categories: [],
    });

    assert.equal(items.length, 1);
    assert.equal(items[0].classification_reason, 'no_active_categories_configured');
    assert.ok(items[0].assigned_agent_id, 'classification must never block routing');
  });

  it('ignores status callbacks and echoes, which the MVP does not handle', () => {
    const { items } = resolve({
      events: parseFixture('status-delivered'),
      agents: AGENTS,
      categories: CATEGORIES,
    });
    assert.equal(items.length, 0);
  });
});
