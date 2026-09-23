/**
 * The same decisions on an Arabic sheet as on an English one (plan E20).
 *
 * `SHEET_LANGUAGE` changes the words in the sheet, never the logic. That is
 * only true if every read turns labels back into codes and every write turns
 * codes back into labels — and the place it has to be true is the generated
 * workflow, not the library. So these tests run the exact generated Code
 * nodes twice: once with an English sheet, once with the same rows written in
 * Arabic, and check that the decisions match and that no cell comes back in
 * the wrong language.
 *
 * Without the conversion, an Arabic sheet reads as a sheet full of unknown
 * statuses: every agent looks idle, no conversation looks closed, and the
 * queue is never retried.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { toLabel } = require('../../scripts/lib/labels');

const DIR = path.join(__dirname, '..', '..', 'n8n', 'workflows');
const WORKFLOWS = {};

function code(file, name) {
  if (!WORKFLOWS[file]) WORKFLOWS[file] = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  const node = WORKFLOWS[file].nodes.find((n) => n.name === name);
  if (!node) throw new Error('no node ' + name + ' in ' + file);
  return node.parameters.jsCode;
}

/** Run a generated Code node body with stand-ins for n8n's globals. */
function run(file, name, env) {
  const items = (env.inputs || []).map((json) => ({ json }));
  const named = env.nodes || {};
  const fn = new Function('require', '$env', '$input', '$', 'console', code(file, name));
  return fn(
    (m) => require(m),
    env.$env || {},
    { all: () => items, first: () => items[0] },
    (node) => {
      const rows = (named[node] || []).map((json) => ({ json }));
      return {
        all: () => rows,
        first: () => rows[0],
        item: rows[0],
        itemMatching: (i) => rows[i],
      };
    },
    { log: () => {} }
  );
}

/** The same row, written the way a sheet in that language holds it. */
const LABELLED = {
  status: 'status', stage: 'stage', outcome: 'outcome',
  reply_status: 'reply_status', last_reply_via: 'via', last_message_direction: 'direction',
};

function inLanguage(row, lang) {
  const out = Object.assign({}, row);
  for (const column of Object.keys(LABELLED)) {
    if (out[column]) out[column] = toLabel(LABELLED[column], out[column], lang);
  }
  return out;
}

/** Run the same fixture under both languages. */
function bothLanguages(build) {
  return { en: build('en'), ar: build('ar') };
}

const RECENT = new Date(Date.now() - 3600000).toISOString();
const LONG_AGO = new Date(Date.now() - 400 * 86400000).toISOString();

describe('workflow 3 — an Arabic sheet does not make every agent look idle', () => {
  const agents = [
    { agent_id: 'A1', name: 'Rana', active: 'TRUE', available: 'TRUE', max_open_conversations: '3', open_conversations: '0', last_assigned_at: '' },
    { agent_id: 'A2', name: 'Omar', active: 'TRUE', available: 'TRUE', max_open_conversations: '5', open_conversations: '0', last_assigned_at: '' },
  ];
  const conversations = [
    { conversation_id: 'C-1', assigned_agent_id: 'A1', status: 'UNANSWERED' },
    { conversation_id: 'C-2', assigned_agent_id: 'A1', status: 'REPLIED' },
    { conversation_id: 'C-3', assigned_agent_id: 'A1', status: 'WAITING_FOR_CUSTOMER' },
    { conversation_id: 'C-4', assigned_agent_id: 'A1', status: 'CLOSED' },
  ];
  const decide = (lang) => run('03-conversation-assignment.json', 'Select Agent', {
    $env: { ASSIGNMENT_STRATEGY: 'LEAST_OPEN_CONVERSATIONS', SHEET_LANGUAGE: lang },
    inputs: agents,
    nodes: {
      'Needs Assignment?': [{ correlation_id: 'X', conversation_id: 'C-9' }],
      'Read All Conversations': conversations.map((c) => inLanguage(c, lang)),
    },
  })[0].json;

  const decisions = bothLanguages(decide);

  it('counts the same open conversations, so it passes over the full agent', () => {
    assert.equal(decisions.en.assigned_agent_id, 'A2', 'A1 is at its limit of 3');
    assert.equal(decisions.ar.assigned_agent_id, decisions.en.assigned_agent_id);
  });

  it('reaches the same verdict on every agent it evaluated', () => {
    assert.deepEqual(decisions.ar.assignment_audit, decisions.en.assignment_audit);
  });

  it('does not count a closed conversation in either language', () => {
    assert.equal(decisions.ar.agent_open_before, 0, 'A2 has nothing open');
  });
});

describe('workflow 3 — the row it writes back is in one language', () => {
  const write = (lang) => run('03-conversation-assignment.json', 'Build Conversation Row', {
    $env: { SHEET_LANGUAGE: lang },
    // The row arrives here as codes: Decide Create Or Update normalised it.
    inputs: [{
      action: 'update',
      conversation_id: 'C-1',
      assignment_decided: false,
      existing_conversation: {
        conversation_id: 'C-1', status: 'CLOSED', stage: 'QUOTED',
        last_message_direction: 'outbound', customer_name: 'Ahmad',
      },
      conversation_update: { status: 'UNANSWERED', last_message_direction: 'inbound' },
    }],
  })[0].json.write_row;

  const rows = bothLanguages(write);

  it('writes Arabic words for an Arabic sheet', () => {
    assert.equal(rows.ar.status, 'بانتظار الرد');
    assert.equal(rows.ar.last_message_direction, 'الزبون');
    assert.equal(rows.ar.stage, 'عرض مرسل', 'a column it did not change keeps the sheet language too');
  });

  it('writes the codes for an English sheet, exactly as it always did', () => {
    assert.equal(rows.en.status, 'UNANSWERED');
    assert.equal(rows.en.last_message_direction, 'inbound');
    assert.equal(rows.en.stage, 'QUOTED');
  });

  it('touches nothing else', () => {
    assert.equal(rows.ar.customer_name, 'Ahmad');
    assert.equal(rows.ar.conversation_id, rows.en.conversation_id);
  });
});

describe('workflow 2 — a reply from the app finds the open conversation', () => {
  const echo = {
    correlation_id: 'X',
    business_phone_number_id: 'PN-1',
    message_id: 'wamid.echo',
    preview: 'on its way',
    text: 'on its way',
    timestamp_iso: RECENT,
    is_control_event: false,
  };
  // The closed row is the more recent one, so it is the one picked by
  // mistake if 'مغلقة' is not understood to mean CLOSED.
  const rows = [
    { conversation_id: 'C-CLOSED', business_phone_number_id: 'PN-1', status: 'CLOSED', last_activity_at: RECENT },
    { conversation_id: 'C-OPEN', business_phone_number_id: 'PN-1', status: 'UNANSWERED', last_activity_at: LONG_AGO },
  ];
  const apply = (lang) => run('02-message-processor.json', 'Apply App Reply', {
    $env: { SHEET_LANGUAGE: lang },
    inputs: rows.map((r) => inLanguage(r, lang)),
    nodes: { 'Route By Event Kind': [echo] },
  })[0].json;

  const applied = bothLanguages(apply);

  it('answers the open conversation, not the closed one, in either language', () => {
    assert.equal(applied.en.conversation_id, 'C-OPEN');
    assert.equal(applied.ar.conversation_id, 'C-OPEN');
  });

  it('records the reply in the sheet language', () => {
    assert.equal(applied.ar.conversation_update.status, 'تم الرد');
    assert.equal(applied.ar.conversation_update.last_reply_via, toLabel('via', 'APP', 'ar'));
    assert.equal(applied.ar.conversation_update.last_message_direction, 'نحن');
  });

  it('records it as codes on an English sheet', () => {
    assert.equal(applied.en.conversation_update.status, 'REPLIED');
    assert.equal(applied.en.conversation_update.last_reply_via, 'APP');
    assert.equal(applied.en.conversation_update.last_message_direction, 'outbound');
  });
});

describe('workflow 5 — the queue is retried on an Arabic sheet too', () => {
  const agents = [
    { agent_id: 'A1', name: 'Rana', active: 'TRUE', available: 'TRUE', max_open_conversations: '5', open_conversations: '0', last_assigned_at: '' },
  ];
  const waiting = [
    { conversation_id: 'C-1', status: 'WAITING_FOR_AGENT', created_at: LONG_AGO },
    { conversation_id: 'C-2', status: 'REPLIED', created_at: LONG_AGO },
  ];
  const assign = (lang) => run('05-unassigned-queue-retry.json', 'Assign Waiting Queue', {
    $env: { SHEET_LANGUAGE: lang, ASSIGNMENT_STRATEGY: 'LEAST_OPEN_CONVERSATIONS' },
    inputs: agents,
    nodes: { 'Read Waiting Conversations': waiting.map((w) => inLanguage(w, lang)) },
  }).map((i) => i.json);

  const assigned = bothLanguages(assign);

  it('finds the waiting row whatever language it is written in', () => {
    assert.deepEqual(assigned.en.map((r) => r.conversation_id), ['C-1']);
    assert.deepEqual(assigned.ar.map((r) => r.conversation_id), ['C-1']);
  });

  it('gives it to the same agent', () => {
    assert.equal(assigned.ar[0].assigned_agent_id, assigned.en[0].assigned_agent_id);
  });

  it('writes the new status in the sheet language', () => {
    assert.equal(assigned.en[0].status, 'UNANSWERED');
    assert.equal(assigned.ar[0].status, 'بانتظار الرد');
  });
});

describe('workflow 7 — a reply typed into an Arabic sheet', () => {
  const row = {
    row_number: 2,
    conversation_id: 'C-1',
    customer_phone: '962790000001',
    reply_text: 'تفضل',
    status: 'REPLIED',
    last_message_direction: 'outbound',
    last_customer_message_at: RECENT,
  };
  const scan = (lang) => run('07-reply-from-sheet.json', 'Find Pending Replies', {
    $env: { SHEET_LANGUAGE: lang, DEFAULT_COUNTRY_CODE: '962' },
    inputs: [inLanguage(row, lang)],
  }).map((i) => i.json);

  const interpret = (lang, response) => run('07-reply-from-sheet.json', 'Interpret Sheet Send', {
    $env: { SHEET_LANGUAGE: lang },
    inputs: [response],
    nodes: { 'Sendable?': [scan(lang)[0]] },
  }).map((i) => i.json);

  const OK = { messages: [{ id: 'wamid.sent' }] };
  const REFUSED = { error: { code: 131047, message: 'outside the window' } };

  it('is picked up in either language', () => {
    assert.equal(scan('en')[0].skip, false);
    assert.equal(scan('ar')[0].skip, false);
    assert.equal(scan('ar')[0].to, '962790000001');
  });

  it('reads the row as codes, so nothing below compares an Arabic word', () => {
    assert.equal(scan('ar')[0].source_row.status, 'REPLIED');
  });

  it('records a sent reply in the sheet language', () => {
    const ar = interpret('ar', OK)[0];
    assert.equal(ar.reply_status, 'تم الإرسال');
    assert.equal(ar.new_status, 'تم الرد');
    assert.equal(ar.new_last_reply_via, toLabel('via', 'SHEET', 'ar'));
    assert.equal(ar.new_last_message_direction, 'نحن');
  });

  it('records it as codes on an English sheet', () => {
    const en = interpret('en', OK)[0];
    assert.equal(en.reply_status, 'SENT');
    assert.equal(en.new_status, 'REPLIED');
    assert.equal(en.new_last_reply_via, 'SHEET');
    assert.equal(en.new_last_message_direction, 'outbound');
  });

  it('rewrites the untouched columns in the sheet language when a send is refused', () => {
    const ar = interpret('ar', REFUSED)[0];
    assert.equal(ar.ok, false);
    assert.equal(ar.reply_status, toLabel('reply_status', 'WINDOW_CLOSED', 'ar'));
    assert.equal(ar.new_status, 'تم الرد', 'the status it already had, in the sheet language');
    assert.equal(ar.new_last_message_direction, 'نحن');
  });

  it('makes the same decision about sending in both languages', () => {
    assert.equal(interpret('ar', REFUSED)[0].keep_text, interpret('en', REFUSED)[0].keep_text);
    assert.equal(interpret('ar', OK)[0].message_id, interpret('en', OK)[0].message_id);
  });
});

describe('workflow 8 — archiving reads an Arabic sheet', () => {
  const rows = [
    { conversation_id: 'C-OLD', row_number: 2, customer_phone: '962790000001', status: 'CLOSED', closed_at: LONG_AGO },
    { conversation_id: 'C-NOW', row_number: 3, customer_phone: '962790000002', status: 'ARCHIVED' },
    { conversation_id: 'C-LIVE', row_number: 4, customer_phone: '962790000003', status: 'UNANSWERED', last_activity_at: RECENT },
    { conversation_id: 'C-RECENT', row_number: 5, customer_phone: '962790000004', status: 'CLOSED', closed_at: RECENT },
  ];
  const archivable = (lang) => run('08-archive-conversations.json', 'Select Archivable', {
    $env: { SHEET_LANGUAGE: lang, ARCHIVE_AFTER_DAYS: '30', ARCHIVE_BATCH_SIZE: '200' },
    inputs: rows.map((r) => inLanguage(r, lang)),
  }).map((i) => i.json);

  const chosen = bothLanguages((lang) => archivable(lang).map((r) => r.conversation_id).sort());

  it('archives the aged-out and the explicitly marked rows, and nothing else', () => {
    assert.deepEqual(chosen.en, ['C-NOW', 'C-OLD']);
  });

  it('makes exactly the same choice on the Arabic sheet', () => {
    assert.deepEqual(chosen.ar, chosen.en);
  });

  it('leaves a live conversation alone in either language', () => {
    assert.notOk(chosen.ar.indexOf('C-LIVE') !== -1);
    assert.notOk(chosen.ar.indexOf('C-RECENT') !== -1, 'closed today, not yet aged out');
  });

  it('copies the row into the Archive in the words the sheet uses', () => {
    const arabic = archivable('ar').find((r) => r.conversation_id === 'C-OLD');
    assert.equal(arabic.status, 'مغلقة', 'the Archive is read by the same people');
    assert.equal(archivable('en').find((r) => r.conversation_id === 'C-OLD').status, 'CLOSED');
  });
});
