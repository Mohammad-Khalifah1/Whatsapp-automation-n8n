/**
 * The archive's delete: planned by id from a fresh read, one batch from the
 * bottom up, and checked afterwards (scripts/lib/rows.js).
 */

'use strict';

const { readGrid, planDeletes, checkDeletes } = require('../../scripts/lib/rows');

/** A spreadsheets.get response with includeGridData, as the API returns it. */
function response(title, sheetId, table) {
  return {
    sheets: [{
      properties: { sheetId, title },
      data: [{
        rowData: table.map((row) => (row === null ? {} : {
          values: row.map((v) => (v === '' ? {} : { formattedValue: v })),
        })),
      }],
    }],
  };
}

const HEADER = ['customer_name', 'status', 'conversation_id'];
const TABLE = [
  HEADER,
  ['Ahmad', 'CLOSED', 'C-1'],    // sheet row 2, grid index 1
  ['Lina', 'UNANSWERED', 'C-2'], // index 2
  ['Omar', 'CLOSED', 'C-3'],     // index 3
  ['Sara', 'REPLIED', 'C-4'],    // index 4
];

describe('readGrid', () => {
  it('reads the header and rows as strings', () => {
    const grid = readGrid(response('Conversations', 7, TABLE), 'Conversations');
    assert.equal(grid.sheetId, 7);
    assert.deepEqual(grid.header, HEADER);
    assert.deepEqual(grid.rows[2], ['Omar', 'CLOSED', 'C-3']);
  });

  it('turns an empty cell into an empty string and keeps an empty row', () => {
    const grid = readGrid(response('Conversations', 7, [HEADER, ['A', '', 'C-1'], null]), 'Conversations');
    assert.deepEqual(grid.rows[0], ['A', '', 'C-1']);
    assert.deepEqual(grid.rows[1], []);
  });

  it('answers null, not an empty tab, when the tab is missing', () => {
    assert.equal(readGrid(response('Archive', 9, TABLE), 'Conversations'), null);
    assert.equal(readGrid({}, 'Conversations'), null);
  });
});

describe('planDeletes', () => {
  const grid = readGrid(response('Conversations', 7, TABLE), 'Conversations');

  it('finds rows by id and deletes them from the bottom up', () => {
    const plan = planDeletes(grid, ['C-1', 'C-3']);
    assert.deepEqual(plan.requests.map((r) => r.deleteDimension.range.startIndex), [3, 1]);
    assert.equal(plan.requests[0].deleteDimension.range.endIndex, 4);
    assert.equal(plan.requests[0].deleteDimension.range.sheetId, 7);
    assert.equal(plan.requests[0].deleteDimension.range.dimension, 'ROWS');
  });

  it('follows a row that moved since it was first read', () => {
    const moved = readGrid(response('Conversations', 7, [HEADER, TABLE[2], TABLE[4], TABLE[1], TABLE[3]]), 'Conversations');
    const plan = planDeletes(moved, ['C-1']);
    assert.equal(plan.requests[0].deleteDimension.range.startIndex, 3);
  });

  it('reports an id that is already gone, and deletes nothing for it', () => {
    const plan = planDeletes(grid, ['C-9', 'C-1']);
    assert.deepEqual(plan.missing, ['C-9']);
    assert.equal(plan.requests.length, 1);
  });

  it('deletes every copy of a repeated id, and says so', () => {
    const twice = readGrid(response('Conversations', 7, TABLE.concat([['Ahmad', 'CLOSED', 'C-1']])), 'Conversations');
    const plan = planDeletes(twice, ['C-1']);
    assert.deepEqual(plan.requests.map((r) => r.deleteDimension.range.startIndex), [5, 1]);
    assert.deepEqual(plan.repeated, ['C-1']);
  });

  it('never touches a row without an id', () => {
    const blank = readGrid(response('Conversations', 7, [HEADER, ['typed by hand', '', '']]), 'Conversations');
    assert.equal(planDeletes(blank, ['']).requests.length, 0);
  });

  it('deletes nothing when the id column cannot be found', () => {
    const plan = planDeletes(readGrid(response('Conversations', 7, [['a', 'b'], ['1', '2']]), 'Conversations'), ['C-1']);
    assert.equal(plan.error, 'no_id_column');
    assert.equal(plan.requests.length, 0);
  });

  it('deletes nothing without a grid', () => {
    assert.equal(planDeletes(null, ['C-1']).requests.length, 0);
  });
});

describe('checkDeletes', () => {
  const before = readGrid(response('Conversations', 7, TABLE), 'Conversations');

  it('reports a clean delete as clean', () => {
    const after = readGrid(response('Conversations', 7, [HEADER, TABLE[2], TABLE[4]]), 'Conversations');
    const check = checkDeletes(before, after, ['C-1', 'C-3']);
    assert.deepEqual(check.stillPresent, []);
    assert.deepEqual(check.lost, []);
  });

  it('finds the row a misplaced delete removed, with its values by name', () => {
    // Meant to delete C-3, removed C-4 instead.
    const after = readGrid(response('Conversations', 7, [HEADER, TABLE[1], TABLE[2], TABLE[3]]), 'Conversations');
    const check = checkDeletes(before, after, ['C-3']);
    assert.deepEqual(check.stillPresent, ['C-3']);
    assert.equal(check.lost.length, 1);
    assert.equal(check.lost[0].id, 'C-4');
    assert.deepEqual(check.lost[0].row, { customer_name: 'Sara', status: 'REPLIED', conversation_id: 'C-4' });
  });

  it('does not restore rows added after the first read', () => {
    const after = readGrid(response('Conversations', 7, [HEADER, TABLE[2], TABLE[4], ['New', 'UNANSWERED', 'C-5']]), 'Conversations');
    assert.deepEqual(checkDeletes(before, after, ['C-1', 'C-3']).lost, []);
  });

  it('restores nothing from a read that lost more rows than were deleted', () => {
    const after = readGrid(response('Conversations', 7, [HEADER]), 'Conversations');
    const check = checkDeletes(before, after, ['C-1']);
    assert.deepEqual(check.lost, []);
    assert.includes(check.error, 'implausible_loss');
  });

  it('restores nothing from an empty read, even when as many rows are gone as were deleted', () => {
    // Deleted C-1 and C-3; the second read came back with no rows at all.
    const after = readGrid(response('Conversations', 7, [HEADER]), 'Conversations');
    const check = checkDeletes(before, after, ['C-1', 'C-3']);
    assert.deepEqual(check.lost, []);
    assert.includes(check.error, 'implausible_loss');
  });

  it('does not bring back a row someone deleted by hand while the batch ran', () => {
    // C-1 archived cleanly; C-2 was deleted by a person at the same time.
    const after = readGrid(response('Conversations', 7, [HEADER, TABLE[3], TABLE[4]]), 'Conversations');
    const check = checkDeletes(before, after, ['C-1']);
    assert.deepEqual(check.lost, []);
    assert.includes(check.error, 'implausible_loss');
  });

  it('restores nothing when the second read failed', () => {
    const check = checkDeletes(before, null, ['C-1']);
    assert.deepEqual(check.lost, []);
    assert.equal(check.error, 'no_grid');
  });
});
