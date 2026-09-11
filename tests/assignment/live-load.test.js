/**
 * Live agent load: counting open conversations from the Conversations rows
 * instead of trusting the denormalized Agents.open_conversations counter.
 *
 * This is the MVP workflow's answer to the assignment race documented in
 * docs/ASSIGNMENT_ALGORITHM.md. The counter needs an atomic increment that
 * Google Sheets cannot provide; a count derived from the rows needs no write
 * at all, so there is nothing to serialize and nothing to drift.
 */

'use strict';

const { countOpenConversationsByAgent, STATUS } = require('../../scripts/lib/conversation');
const { withLiveLoad, selectAgent } = require('../../scripts/lib/assignment');

/** Rows arrive from Google Sheets as strings. */
function conversation(agentId, status) {
  return {
    conversation_id: 'CONV-' + Math.random().toString(36).slice(2, 8),
    customer_phone: '962790000000',
    assigned_agent_id: agentId,
    status,
    last_activity_at: '2026-09-11T10:00:00.000Z',
  };
}

function agent(id, name, counterValue, max) {
  return {
    agent_id: id,
    name,
    active: 'TRUE',
    available: 'TRUE',
    max_open_conversations: String(max === undefined ? 5 : max),
    open_conversations: String(counterValue),
    last_assigned_at: '',
  };
}

describe('countOpenConversationsByAgent', () => {
  it('counts every non-closed status against the agent', () => {
    const rows = [
      conversation('A1', STATUS.UNANSWERED),
      conversation('A1', STATUS.REPLIED),
      conversation('A1', STATUS.WAITING_FOR_CUSTOMER),
      conversation('A2', STATUS.WAITING_FOR_AGENT),
    ];
    assert.deepEqual(countOpenConversationsByAgent(rows), { A1: 3, A2: 1 });
  });

  it('does not count closed conversations', () => {
    const rows = [
      conversation('A1', STATUS.UNANSWERED),
      conversation('A1', STATUS.CLOSED),
      conversation('A1', STATUS.CLOSED),
    ];
    assert.deepEqual(countOpenConversationsByAgent(rows), { A1: 1 });
  });

  it('ignores unassigned conversations — a queue is nobody\'s load', () => {
    const rows = [
      conversation('', STATUS.WAITING_FOR_AGENT),
      conversation('   ', STATUS.WAITING_FOR_AGENT),
      conversation('A1', STATUS.UNANSWERED),
    ];
    assert.deepEqual(countOpenConversationsByAgent(rows), { A1: 1 });
  });

  it('returns an empty map rather than throwing on junk rows', () => {
    assert.deepEqual(countOpenConversationsByAgent([null, 'nope', {}, undefined]), {});
    assert.deepEqual(countOpenConversationsByAgent(null), {});
  });

  it('ignores an unrecognised status instead of counting it', () => {
    // A manager typing free text into the status column must not silently
    // inflate someone's workload.
    assert.deepEqual(countOpenConversationsByAgent([conversation('A1', 'شغال')]), {});
  });
});

describe('withLiveLoad', () => {
  it('replaces the stored counter with the counted value', () => {
    const agents = [agent('A1', 'Ahmed', 7), agent('A2', 'Sara', 0)];
    const live = withLiveLoad(agents, { A1: 2, A2: 4 });

    assert.equal(live[0].open_conversations, 2);
    assert.equal(live[1].open_conversations, 4);
  });

  it('treats a missing agent as zero, not as unknown', () => {
    // Falling back to the stale counter here would reintroduce the exact drift
    // this function exists to remove.
    const live = withLiveLoad([agent('A1', 'Ahmed', 9)], {});
    assert.equal(live[0].open_conversations, 0);
  });

  it('preserves the original counter for comparison', () => {
    const live = withLiveLoad([agent('A1', 'Ahmed', 9)], { A1: 2 });
    assert.equal(live[0].open_conversations_counter, '9');
  });

  it('does not mutate the rows it was given', () => {
    const agents = [agent('A1', 'Ahmed', 9)];
    withLiveLoad(agents, { A1: 2 });
    assert.equal(agents[0].open_conversations, '9');
  });

  it('survives junk rows', () => {
    assert.doesNotThrow(() => withLiveLoad([null, undefined, agent('A1', 'Ahmed', 1)], {}));
    assert.deepEqual(withLiveLoad(null, {}), []);
  });
});

describe('live load changes who gets the conversation', () => {
  it('routes by reality when the counter has drifted', () => {
    // The sheet claims Ahmed has 1 and Sara has 4, so the counter would pick
    // Ahmed. The conversations say the opposite — Ahmed is actually carrying 4.
    const agents = [agent('A1', 'Ahmed', 1), agent('A2', 'Sara', 4)];
    const rows = [
      conversation('A1', STATUS.UNANSWERED),
      conversation('A1', STATUS.UNANSWERED),
      conversation('A1', STATUS.REPLIED),
      conversation('A1', STATUS.REPLIED),
      conversation('A2', STATUS.UNANSWERED),
    ];

    assert.equal(selectAgent(agents).agent.agent_id, 'A1', 'counter picks the wrong agent');

    const live = withLiveLoad(agents, countOpenConversationsByAgent(rows));
    assert.equal(selectAgent(live).agent.agent_id, 'A2', 'live load picks the right one');
  });

  it('still enforces capacity against the counted load', () => {
    // Sara's counter says 0, but she genuinely holds her maximum of 2.
    const agents = [agent('A2', 'Sara', 0, 2)];
    const rows = [conversation('A2', STATUS.UNANSWERED), conversation('A2', STATUS.REPLIED)];

    const decision = selectAgent(withLiveLoad(agents, countOpenConversationsByAgent(rows)));
    assert.equal(decision.assigned, false, 'an at-capacity agent must not be handed more');
  });
});
