/**
 * The agent name and the agent id say the same thing.
 *
 * Handing a conversation over is done by picking a different name in the
 * sheet. The name is what a person sees and filters by; the id is what the
 * load count and the dashboard use. Changing one left the other stale, so a
 * conversation could show as Sara's while still counting against Ahmad's
 * capacity — and "my conversations" and "who is full" disagreed.
 */

'use strict';

const path = require('path');

const WORKFLOW = require(path.join('..', '..', 'n8n', 'workflows', '07-reply-from-sheet.json'));

const AGENTS = [
  { agent_id: 'A1', name: 'Ahmad' },
  { agent_id: 'A2', name: 'Sara' },
];

function reconcile(rows, agents) {
  const node = WORKFLOW.nodes.find((n) => n.name === 'Find Renamed Agents');
  const fn = new Function('require', '$input', '$', 'console', node.parameters.jsCode);
  return fn(
    (m) => require(m),
    { all: () => rows.map((json) => ({ json })) },
    () => ({ all: () => (agents || AGENTS).map((json) => ({ json })) }),
    { log: () => {} }
  ).map((i) => i.json);
}

const row = (extra) => Object.assign({ conversation_id: 'CONV-1' }, extra);

describe('Find Renamed Agents (generated code)', () => {
  it('follows the name when someone hands a conversation over', () => {
    const out = reconcile([row({ assigned_agent_name: 'Sara', assigned_agent_id: 'A1' })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].assigned_agent_id, 'A2');
    assert.equal(out[0].assigned_agent_name, 'Sara');
  });

  it('writes nothing when the two already agree', () => {
    assert.deepEqual(reconcile([row({ assigned_agent_name: 'Sara', assigned_agent_id: 'A2' })]), []);
  });

  it('matches a name whatever the case or spacing', () => {
    const out = reconcile([row({ assigned_agent_name: '  sara ', assigned_agent_id: 'A1' })]);
    assert.equal(out[0].assigned_agent_id, 'A2');
  });

  it('puts the name back when it was cleared but the conversation has an owner', () => {
    const out = reconcile([row({ assigned_agent_name: '', assigned_agent_id: 'A1' })]);
    assert.equal(out[0].assigned_agent_name, 'Ahmad');
    assert.equal(out[0].assigned_agent_id, 'A1');
  });

  it('updates the name when the agent was renamed in the Agents tab', () => {
    const out = reconcile([row({ assigned_agent_name: 'Ahmed', assigned_agent_id: 'A1' })]);
    assert.equal(out[0].assigned_agent_name, 'Ahmad');
    assert.equal(out[0].assigned_agent_id, 'A1');
  });

  it('leaves a name nobody has alone when there is no id to check it against', () => {
    assert.deepEqual(reconcile([row({ assigned_agent_name: 'Someone Else', assigned_agent_id: '' })]), [],
      'guessing here would hand a customer to whoever is nearby in the list');
  });

  it('leaves an unassigned row to the queue retry, not to this', () => {
    assert.deepEqual(reconcile([row({ assigned_agent_name: '', assigned_agent_id: '' })]), []);
  });

  it('writes nothing at all on a quiet minute', () => {
    assert.deepEqual(reconcile([
      row({ conversation_id: 'C1', assigned_agent_name: 'Ahmad', assigned_agent_id: 'A1' }),
      row({ conversation_id: 'C2', assigned_agent_name: 'Sara', assigned_agent_id: 'A2' }),
    ]), []);
  });

  it('survives an Agents tab that could not be read', () => {
    assert.deepEqual(reconcile([row({ assigned_agent_name: 'Sara', assigned_agent_id: 'A1' })], []), []);
  });
});

describe('Fix Agent Reference', () => {
  const node = WORKFLOW.nodes.find((n) => n.name === 'Fix Agent Reference');

  it('writes to the row by its conversation id', () => {
    assert.deepEqual(node.parameters.columns.matchingColumns, ['conversation_id']);
  });

  it('touches only the two cells that disagreed, and the updated stamp', () => {
    assert.deepEqual(Object.keys(node.parameters.columns.value).sort(),
      ['assigned_agent_id', 'assigned_agent_name', 'conversation_id', 'updated_at']);
  });
});
