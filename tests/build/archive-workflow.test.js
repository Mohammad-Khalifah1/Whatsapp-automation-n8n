/**
 * Workflow 8's delete path, run from the generated file.
 *
 * Plan Deletes, Build Delete Request and Check Deletes are Code nodes that
 * inline scripts/lib/rows.js. These tests run the exact generated bodies with
 * stand-ins for n8n's globals, through a whole run: rows copied, a fresh read,
 * the batch planned, and a second read checked, including a delete that
 * landed on the wrong row.
 */

'use strict';

const path = require('path');

const WORKFLOW = require(path.join('..', '..', 'n8n', 'workflows', '08-archive-conversations.json'));

function code(name) {
  const node = WORKFLOW.nodes.find((n) => n.name === name);
  if (!node) throw new Error('no node ' + name + ' in workflow 8');
  return node.parameters.jsCode;
}

/** Run a Code node body with the given input items and named node outputs. */
function run(name, env) {
  const items = (env.inputs || []).map((json) => ({ json }));
  const logs = [];
  const fn = new Function('$input', '$', 'console', code(name));
  const out = fn(
    { all: () => items, first: () => items[0] },
    (node) => ({
      first: () => ({ json: (env.nodes || {})[node] }),
      itemMatching: (i) => ({ json: ((env.matching || {})[node] || [])[i] }),
    }),
    { log: (line) => logs.push(line) }
  );
  return { out, logs: logs.join('\n') };
}

function grid(table) {
  return {
    sheets: [{
      properties: { sheetId: 42, title: 'Conversations' },
      data: [{ rowData: table.map((row) => ({ values: row.map((v) => ({ formattedValue: v })) })) }],
    }],
  };
}

const HEADER = ['customer_phone', 'status', 'conversation_id'];
const BEFORE = [HEADER,
  ['962790000001', 'CLOSED', 'C-1'],
  ['962790000002', 'UNANSWERED', 'C-2'],
  ['962790000003', 'ARCHIVED', 'C-3'],
  ['962790000004', 'REPLIED', 'C-4'],
];
const ARCHIVED = [
  { conversation_id: 'C-3', customer_phone: '962790000003', closed_at: 'x', row_number: 4 },
  { conversation_id: 'C-1', customer_phone: '962790000001', closed_at: 'y', row_number: 2 },
];

describe('Plan Deletes (generated code)', () => {
  it('collects every copied row, paired to what Select Archivable chose', () => {
    const { out } = run('Plan Deletes', {
      inputs: [{ spreadsheetId: 's' }, { spreadsheetId: 's' }],
      matching: { 'Select Archivable': ARCHIVED },
    });
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].json.archived.map((r) => r.conversation_id), ['C-3', 'C-1']);
  });

  it('does nothing when nothing was copied', () => {
    assert.deepEqual(run('Plan Deletes', { inputs: [] }).out, []);
  });
});

describe('Build Delete Request (generated code)', () => {
  it('plans a bottom-up batch by id, from the fresh read', () => {
    const { out } = run('Build Delete Request', {
      inputs: [grid(BEFORE)],
      nodes: { 'Plan Deletes': { archived: ARCHIVED } },
    });
    const requests = out[0].json.body.requests;
    assert.deepEqual(requests.map((r) => r.deleteDimension.range.startIndex), [3, 1]);
    assert.equal(requests[0].deleteDimension.range.sheetId, 42);
    assert.deepEqual(out[0].json.deleted_ids.sort(), ['C-1', 'C-3']);
  });

  it('deletes nothing when the read has no Conversations tab', () => {
    const { out, logs } = run('Build Delete Request', {
      inputs: [{ sheets: [] }],
      nodes: { 'Plan Deletes': { archived: ARCHIVED } },
    });
    assert.deepEqual(out, []);
    assert.includes(logs, 'no_grid');
  });
});

describe('Check Deletes (generated code)', () => {
  const plan = run('Build Delete Request', {
    inputs: [grid(BEFORE)],
    nodes: { 'Plan Deletes': { archived: ARCHIVED } },
  }).out[0].json;

  it('audits every archived row after a clean delete', () => {
    const { out } = run('Check Deletes', {
      inputs: [grid([HEADER, BEFORE[2], BEFORE[4]])],
      nodes: { 'Build Delete Request': plan, 'Plan Deletes': { archived: ARCHIVED } },
    });
    assert.deepEqual(out.map((i) => i.json.kind), ['archived', 'archived']);
  });

  it('hands back a row the batch removed by mistake, to be appended again', () => {
    // C-4 went instead of C-3.
    const { out, logs } = run('Check Deletes', {
      inputs: [grid([HEADER, BEFORE[2], BEFORE[3]])],
      nodes: { 'Build Delete Request': plan, 'Plan Deletes': { archived: ARCHIVED } },
    });
    const restore = out.filter((i) => i.json.kind === 'restore');
    assert.equal(restore.length, 1);
    assert.equal(restore[0].json.restore_row.conversation_id, 'C-4');
    assert.equal(restore[0].json.restore_row.status, 'REPLIED');
    assert.includes(logs, 'archive_delete_missed');
  });

  it('restores nothing when the second read came back empty', () => {
    const { out, logs } = run('Check Deletes', {
      inputs: [grid([HEADER])],
      nodes: { 'Build Delete Request': plan, 'Plan Deletes': { archived: ARCHIVED } },
    });
    assert.equal(out.filter((i) => i.json.kind === 'restore').length, 0);
    assert.includes(logs, 'implausible_loss');
  });
});

describe('workflow 8 wiring', () => {
  const targets = (name) => WORKFLOW.connections[name].main.map((o) => o.map((t) => t.node));

  it('deletes through the API only with a token, and keeps the row delete otherwise', () => {
    assert.deepEqual(targets('Delete Via API?'), [['Plan Deletes'], ['Remove From Conversations']]);
  });

  it('deletes only after the copy, and checks after the delete', () => {
    assert.deepEqual(targets('Copy To Archive')[0], ['Delete Via API?']);
    assert.deepEqual(targets('Delete Archived Rows'), [['Read Conversations After Delete']]);
    assert.deepEqual(targets('Read Conversations After Delete'), [['Check Deletes']]);
  });
});
