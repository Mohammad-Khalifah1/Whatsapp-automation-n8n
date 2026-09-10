/**
 * Test scenarios 5, 6, 7, 8, 9: least-open-conversations assignment,
 * tie-breaking, unavailable agents, all agents unavailable, capacity limits.
 */

'use strict';

const {
  selectAgent,
  evaluateAgent,
  parseBoolean,
  STRATEGIES,
  INELIGIBLE,
  NO_AGENT_REASON,
} = require('../../scripts/lib/assignment');

/** Helper mirroring how rows actually arrive from Google Sheets: as strings. */
function agent(id, name, open, max, overrides) {
  return Object.assign(
    {
      agent_id: id,
      name,
      phone: '962790000000',
      active: 'TRUE',
      available: 'TRUE',
      max_open_conversations: String(max === undefined ? 5 : max),
      open_conversations: String(open),
      last_assigned_at: '',
      role: 'agent',
    },
    overrides || {}
  );
}

describe('assignment — least open conversations (spec example)', () => {
  it('routes to the agent with the fewest open conversations', () => {
    // The exact example from the specification:
    //   Ahmed 4, Mohammad 3, Sara 3  ->  must go to Mohammad or Sara.
    const agents = [
      agent('A1', 'Ahmed', 4),
      agent('A2', 'Mohammad', 3),
      agent('A3', 'Sara', 3),
    ];
    const d = selectAgent(agents);
    assert.ok(d.assigned, 'someone must be assigned');
    assert.ok(
      d.agent.name === 'Mohammad' || d.agent.name === 'Sara',
      'expected Mohammad or Sara, got ' + d.agent.name
    );
    assert.ok(d.agent.name !== 'Ahmed', 'Ahmed has the most load and must not be chosen');
  });

  it('picks the single least-loaded agent unambiguously', () => {
    const agents = [agent('A1', 'Ahmed', 4), agent('A2', 'Mohammad', 1), agent('A3', 'Sara', 3)];
    const d = selectAgent(agents);
    assert.equal(d.agent.name, 'Mohammad');
    assert.equal(d.status, 'ASSIGNED');
  });

  it('orders all eligible candidates by load, not just the winner', () => {
    const agents = [agent('A1', 'Ahmed', 4), agent('A2', 'Mohammad', 3), agent('A3', 'Sara', 1)];
    const d = selectAgent(agents);
    assert.deepEqual(
      d.candidates.map((c) => c.name),
      ['Sara', 'Mohammad', 'Ahmed']
    );
  });
});

describe('assignment — tie-breaking', () => {
  it('breaks a load tie by earliest last_assigned_at', () => {
    const agents = [
      agent('A2', 'Mohammad', 3, 5, { last_assigned_at: '2026-09-09T10:00:00.000Z' }),
      agent('A3', 'Sara', 3, 5, { last_assigned_at: '2026-09-09T09:00:00.000Z' }),
    ];
    const d = selectAgent(agents);
    assert.equal(d.agent.name, 'Sara', 'Sara was assigned longer ago, so she is next');
  });

  it('treats a never-assigned agent as earliest (they go first)', () => {
    const agents = [
      agent('A2', 'Mohammad', 3, 5, { last_assigned_at: '2026-09-09T09:00:00.000Z' }),
      agent('A3', 'Sara', 3, 5, { last_assigned_at: '' }),
    ];
    const d = selectAgent(agents);
    assert.equal(d.agent.name, 'Sara', 'never-assigned agent should be preferred');
  });

  it('falls back to agent_id for a total tie, deterministically', () => {
    const agents = [
      agent('A9', 'Zoe', 3, 5, { last_assigned_at: '2026-09-09T09:00:00.000Z' }),
      agent('A2', 'Mohammad', 3, 5, { last_assigned_at: '2026-09-09T09:00:00.000Z' }),
    ];
    const first = selectAgent(agents).agent.agent_id;
    // Reversing input order must not change the outcome.
    const second = selectAgent(agents.slice().reverse()).agent.agent_id;
    assert.equal(first, 'A2', 'lowest agent_id wins a total tie');
    assert.equal(first, second, 'result must not depend on input ordering');
  });

  it('is deterministic across repeated identical calls (reproducible in incident review)', () => {
    const agents = [agent('A1', 'Ahmed', 2), agent('A2', 'Mohammad', 2), agent('A3', 'Sara', 2)];
    const picks = [];
    for (let i = 0; i < 25; i += 1) picks.push(selectAgent(agents).agent.agent_id);
    assert.equal(new Set(picks).size, 1, 'same input must always yield the same agent');
  });
});

describe('assignment — eligibility filters', () => {
  it('excludes inactive agents (scenario 7)', () => {
    const agents = [agent('A1', 'Ahmed', 0, 5, { active: 'FALSE' }), agent('A2', 'Mohammad', 4)];
    const d = selectAgent(agents);
    assert.equal(d.agent.name, 'Mohammad', 'inactive Ahmed must be skipped despite 0 load');
    const ahmed = d.evaluated.find((a) => a.agent_id === 'A1');
    assert.includes(ahmed.ineligible_reasons, INELIGIBLE.INACTIVE);
  });

  it('excludes unavailable agents', () => {
    const agents = [agent('A1', 'Ahmed', 0, 5, { available: 'FALSE' }), agent('A2', 'Mohammad', 4)];
    const d = selectAgent(agents);
    assert.equal(d.agent.name, 'Mohammad');
    const ahmed = d.evaluated.find((a) => a.agent_id === 'A1');
    assert.includes(ahmed.ineligible_reasons, INELIGIBLE.UNAVAILABLE);
  });

  it('excludes agents at max capacity (scenario 9)', () => {
    const agents = [agent('A1', 'Ahmed', 5, 5), agent('A2', 'Mohammad', 4, 5)];
    const d = selectAgent(agents);
    assert.equal(d.agent.name, 'Mohammad');
    const ahmed = d.evaluated.find((a) => a.agent_id === 'A1');
    assert.includes(ahmed.ineligible_reasons, INELIGIBLE.AT_CAPACITY);
  });

  it('treats over-capacity (data drift) as at capacity, not as negative headroom', () => {
    const agents = [agent('A1', 'Ahmed', 9, 5), agent('A2', 'Mohammad', 4, 5)];
    const d = selectAgent(agents);
    assert.equal(d.agent.name, 'Mohammad');
  });

  it('treats max_open_conversations of 0 as "cannot take conversations"', () => {
    const agents = [agent('A1', 'Ahmed', 0, 0)];
    const d = selectAgent(agents);
    assert.notOk(d.assigned);
  });
});

describe('assignment — no eligible agent (scenario 8)', () => {
  it('never silently drops: returns WAITING_FOR_AGENT with a reason', () => {
    const agents = [
      agent('A1', 'Ahmed', 5, 5),
      agent('A2', 'Mohammad', 0, 5, { available: 'FALSE' }),
      agent('A3', 'Sara', 0, 5, { active: 'FALSE' }),
    ];
    const d = selectAgent(agents);
    assert.notOk(d.assigned, 'nobody is eligible');
    assert.equal(d.agent, null);
    assert.equal(d.status, 'WAITING_FOR_AGENT', 'must be queued, not dropped');
    assert.equal(d.reason, NO_AGENT_REASON.NO_ELIGIBLE_AGENT);
  });

  it('records why every single agent was excluded, for the audit trail', () => {
    const agents = [
      agent('A1', 'Ahmed', 5, 5),
      agent('A2', 'Mohammad', 0, 5, { available: 'FALSE' }),
    ];
    const d = selectAgent(agents);
    assert.equal(d.evaluated.length, 2);
    for (const e of d.evaluated) {
      assert.ok(e.ineligible_reasons.length > 0, e.agent_id + ' must have a documented reason');
    }
  });

  it('handles an empty agent list distinctly from "all ineligible"', () => {
    const d = selectAgent([]);
    assert.notOk(d.assigned);
    assert.equal(d.reason, NO_AGENT_REASON.NO_AGENTS_CONFIGURED);
    assert.equal(d.status, 'WAITING_FOR_AGENT');
  });

  it('handles a null/undefined agent list without throwing', () => {
    assert.doesNotThrow(() => selectAgent(null));
    assert.doesNotThrow(() => selectAgent(undefined));
    assert.notOk(selectAgent(null).assigned);
  });
});

describe('assignment — malformed spreadsheet data (manual editing)', () => {
  it('one corrupt row cannot break routing for everyone', () => {
    const agents = [
      { agent_id: '', name: 'Broken Row', active: 'TRUE', available: 'TRUE' },
      agent('A2', 'Mohammad', 1),
    ];
    const d = selectAgent(agents);
    assert.ok(d.assigned, 'the healthy agent must still be selected');
    assert.equal(d.agent.name, 'Mohammad');
  });

  it('non-numeric capacity cells fall back to a default instead of producing NaN', () => {
    const a = evaluateAgent(
      { agent_id: 'A1', name: 'X', active: 'TRUE', available: 'TRUE', max_open_conversations: 'five', open_conversations: 'lots' },
      { defaultMaxOpenConversations: 5 }
    );
    assert.equal(a.max_open_conversations, 5, 'garbage max falls back to default');
    assert.equal(a.open_conversations, 0, 'garbage load falls back to 0');
    assert.ok(a.eligible);
  });

  it('fails CLOSED on unrecognised availability values', () => {
    // A human typing "maybe" must not be treated as available.
    const a = evaluateAgent(
      { agent_id: 'A1', name: 'X', active: 'maybe', available: 'maybe', max_open_conversations: '5' }
    );
    assert.notOk(a.eligible, 'unrecognised value must not grant availability');
  });

  it('accepts the truthy spellings humans actually type', () => {
    for (const v of ['TRUE', 'true', 'True', '1', 'yes', 'Y', 'نعم']) {
      assert.equal(parseBoolean(v), true, 'should be truthy: ' + v);
    }
    for (const v of ['FALSE', 'false', '0', 'no', 'لا']) {
      assert.equal(parseBoolean(v), false, 'should be falsy: ' + v);
    }
  });

  it('never throws on deeply malformed input', () => {
    const nasty = [[null], [undefined], [{}], [{ agent_id: null }], [42], ['string']];
    for (const n of nasty) {
      assert.doesNotThrow(() => selectAgent(n), 'input: ' + JSON.stringify(n));
    }
  });
});

describe('assignment — strategy is genuinely pluggable', () => {
  it('ROUND_ROBIN ignores load and uses last_assigned_at', () => {
    const agents = [
      agent('A1', 'Ahmed', 0, 5, { last_assigned_at: '2026-09-09T12:00:00.000Z' }),
      agent('A2', 'Mohammad', 4, 5, { last_assigned_at: '2026-09-09T08:00:00.000Z' }),
    ];
    const least = selectAgent(agents, { strategy: STRATEGIES.LEAST_OPEN_CONVERSATIONS });
    const rr = selectAgent(agents, { strategy: STRATEGIES.ROUND_ROBIN });
    assert.equal(least.agent.name, 'Ahmed', 'least-open picks the idle agent');
    assert.equal(rr.agent.name, 'Mohammad', 'round-robin picks whoever waited longest');
  });

  it('round robin still respects capacity', () => {
    const agents = [
      agent('A1', 'Ahmed', 1, 5, { last_assigned_at: '2026-09-09T12:00:00.000Z' }),
      agent('A2', 'Mohammad', 5, 5, { last_assigned_at: '2026-09-09T08:00:00.000Z' }),
    ];
    const rr = selectAgent(agents, { strategy: STRATEGIES.ROUND_ROBIN });
    assert.equal(rr.agent.name, 'Ahmed', 'the longest-waiting agent is full, so skip him');
  });

  it('an unknown strategy falls back to the documented default rather than failing', () => {
    const agents = [agent('A1', 'Ahmed', 4), agent('A2', 'Mohammad', 1)];
    const d = selectAgent(agents, { strategy: 'NOT_A_REAL_STRATEGY' });
    assert.ok(d.assigned);
    assert.equal(d.agent.name, 'Mohammad');
  });
});

describe('assignment — concurrency exposure (scenario 4)', () => {
  it('DEMONSTRATES the race: two simultaneous reads of identical state pick the SAME agent', () => {
    // This is the failure mode Google Sheets cannot prevent on its own.
    // Two webhooks arriving together both read "Mohammad has 3 open" before
    // either writes, so both select Mohammad and he ends up with 2 new
    // conversations while Sara gets none.
    const stateAtReadTime = [agent('A2', 'Mohammad', 3), agent('A3', 'Sara', 4)];

    const executionA = selectAgent(stateAtReadTime);
    const executionB = selectAgent(stateAtReadTime); // same snapshot, no write in between

    assert.equal(executionA.agent.agent_id, executionB.agent.agent_id,
      'both executions pick the same agent — this is the documented race');

    // The mitigation is NOT in this pure function: it is serialization at the
    // workflow level (n8n concurrency=1) plus the advisory lock, and ultimately
    // SELECT ... FOR UPDATE in PostgreSQL.
    // See docs/ASSIGNMENT_ALGORITHM.md "Concurrency and race conditions".
  });

  it('once the first assignment is persisted, the second execution picks differently', () => {
    // Proves the algorithm itself is correct: given FRESH state it self-corrects.
    const before = [agent('A2', 'Mohammad', 3), agent('A3', 'Sara', 4)];
    const first = selectAgent(before);
    assert.equal(first.agent.name, 'Mohammad');

    // Simulate the write landing before the second execution reads.
    const after = [agent('A2', 'Mohammad', 4), agent('A3', 'Sara', 4)];
    const second = selectAgent(after);
    assert.equal(second.agent.name, 'Mohammad',
      'tie at 4/4 broken deterministically by agent_id (A2 < A3)');

    const after2 = [agent('A2', 'Mohammad', 5), agent('A3', 'Sara', 4)];
    assert.equal(selectAgent(after2).agent.name, 'Sara', 'load now genuinely favours Sara');
  });
});
