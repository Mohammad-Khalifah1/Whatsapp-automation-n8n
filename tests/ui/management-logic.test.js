/**
 * Unit tests for ui/management/logic.js — the pure, DOM-free logic behind
 * the Employees + Tasks board UI. No browser, no DOM: exactly what runs in
 * the page, required directly the way every other scripts/lib/ module is.
 */

'use strict';

const {
  COLUMNS,
  COLUMN_LABELS,
  groupTasksByColumn,
  filterTasksByAgent,
  agentCapacity,
  validateNewEmployee,
  describeApiError,
} = require('../../ui/management/logic');

describe('groupTasksByColumn', () => {
  it('sorts tasks into their four columns', () => {
    const tasks = [
      { conversation_id: '1', column: 'backlog' },
      { conversation_id: '2', column: 'to_do' },
      { conversation_id: '3', column: 'to_do' },
      { conversation_id: '4', column: 'waiting' },
      { conversation_id: '5', column: 'done' },
    ];
    const groups = groupTasksByColumn(tasks);
    assert.equal(groups.backlog.length, 1);
    assert.equal(groups.to_do.length, 2);
    assert.equal(groups.waiting.length, 1);
    assert.equal(groups.done.length, 1);
  });

  it('never drops a task, even with a garbage or missing column value', () => {
    const tasks = [{ conversation_id: '1' }, { conversation_id: '2', column: 'not_a_real_column' }];
    const groups = groupTasksByColumn(tasks);
    const total = COLUMNS.reduce((n, c) => n + groups[c].length, 0);
    assert.equal(total, 2, 'a task with an unrecognised column must still appear somewhere, not vanish');
  });

  it('never throws on non-array input', () => {
    assert.doesNotThrow(() => groupTasksByColumn(null));
    assert.doesNotThrow(() => groupTasksByColumn(undefined));
    const groups = groupTasksByColumn(undefined);
    assert.equal(groups.backlog.length, 0);
  });

  it('every declared column has a human label', () => {
    for (const c of COLUMNS) {
      assert.ok(typeof COLUMN_LABELS[c] === 'string' && COLUMN_LABELS[c].length > 0);
    }
  });
});

describe('filterTasksByAgent', () => {
  const tasks = [
    { conversation_id: '1', assigned_agent_id: 'A1' },
    { conversation_id: '2', assigned_agent_id: 'A2' },
    { conversation_id: '3', assigned_agent_id: 'A1' },
    { conversation_id: '4', assigned_agent_id: '' },
  ];

  it('returns only that agent\'s tasks', () => {
    const filtered = filterTasksByAgent(tasks, 'A1');
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every((t) => t.assigned_agent_id === 'A1'));
  });

  it('returns everything, including unassigned, when no agent is given', () => {
    assert.equal(filterTasksByAgent(tasks, '').length, 4);
    assert.equal(filterTasksByAgent(tasks, undefined).length, 4);
  });

  it('never throws on non-array input', () => {
    assert.doesNotThrow(() => filterTasksByAgent(null, 'A1'));
  });
});

describe('agentCapacity', () => {
  it('flags an agent at their cap', () => {
    const c = agentCapacity({ open_conversations: 5, max_open_conversations: 5 });
    assert.equal(c.atCapacity, true);
    assert.equal(c.label, '5/5');
  });

  it('does not flag an agent under capacity', () => {
    const c = agentCapacity({ open_conversations: 2, max_open_conversations: 5 });
    assert.equal(c.atCapacity, false);
  });

  it('treats a missing/zero max as "not really capped", not a false at-capacity', () => {
    const c = agentCapacity({ open_conversations: 3, max_open_conversations: 0 });
    assert.equal(c.atCapacity, false, 'a max of 0 is a data problem, not a real cap of zero');
  });

  it('degrades a malformed row to zeros rather than throwing or producing NaN', () => {
    const c = agentCapacity({ open_conversations: 'not a number', max_open_conversations: null });
    assert.equal(c.open, 0);
    assert.equal(c.max, 0);
    assert.doesNotThrow(() => agentCapacity(null));
    assert.doesNotThrow(() => agentCapacity(undefined));
  });
});

describe('validateNewEmployee (mirrors workflow 9\'s server-side validation)', () => {
  it('accepts a well-formed submission', () => {
    const r = validateNewEmployee({ name: 'Rana', phone: '962791234567' }, []);
    assert.equal(r.valid, true);
    assert.equal(r.errors.length, 0);
  });

  it('rejects a missing name', () => {
    const r = validateNewEmployee({ name: '', phone: '962791234567' }, []);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.indexOf('name') !== -1));
  });

  it('rejects a too-short phone', () => {
    const r = validateNewEmployee({ name: 'Rana', phone: '123' }, []);
    assert.equal(r.valid, false);
  });

  it('rejects a duplicate phone, ignoring formatting differences', () => {
    const existing = [{ agent_id: 'A1', phone: '962-79-1234567' }];
    const r = validateNewEmployee({ name: 'Someone Else', phone: '962791234567' }, existing);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.indexOf('already exists') !== -1));
  });

  it('strips non-digits from phone before every check', () => {
    const r = validateNewEmployee({ name: 'Rana', phone: '+962 79 123 4567' }, []);
    assert.equal(r.valid, true);
  });
});

describe('describeApiError', () => {
  it('gives a specific message for a wrong/missing key', () => {
    assert.ok(describeApiError({ status: 401 }).toLowerCase().indexOf('key') !== -1);
  });

  it('gives a specific message for server misconfiguration', () => {
    assert.ok(describeApiError({ status: 500 }).indexOf('MANAGEMENT_API_KEY') !== -1);
  });

  it('surfaces the server\'s own error text when present', () => {
    const msg = describeApiError({ status: 400, body: { error: 'validation failed' } });
    assert.equal(msg, 'validation failed');
  });

  it('never throws on a bare network failure with no status', () => {
    assert.doesNotThrow(() => describeApiError(new Error('fetch failed')));
    assert.doesNotThrow(() => describeApiError(undefined));
  });
});
