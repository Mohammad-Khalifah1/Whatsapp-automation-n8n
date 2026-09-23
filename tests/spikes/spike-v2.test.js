/**
 * The spike tool's verdicts (scripts/testing/spike-v2.js).
 *
 * The spikes decide whether Phase 3 is built as designed or on its fallback,
 * so the part that turns an API response into "yes" or "no" is the part that
 * must not be wrong. It runs against a live throwaway spreadsheet; these tests
 * run the same decisions against recorded responses, including the ones that
 * mean the fallback.
 */

'use strict';

const {
  SPIKE_TABS, MANUAL_CHECKS,
  guardSpreadsheet, answerS2, answerS3Filter, answerS3Sort,
  renderResultsTable, parseArgs,
} = require('../../scripts/testing/spike-v2');

const HEADER = ['customer', 'note', 'derived'];
const SEEDED = [['one', 'n1', 'ONE'], ['two', 'n2', 'TWO'], ['three', 'n3', 'THREE']];
const FORMULA = '=ARRAYFORMULA(IF(A2:INDEX(A:A,MAX(2,COUNTA(A:A)))="","",UPPER(A2:INDEX(A:A,MAX(2,COUNTA(A:A))))))';

const s2 = (values, formulaCell) => answerS2({
  values, seededRows: 3, derivedIndex: 2, expectedDerived: 'FOUR',
  formulaCell: formulaCell === undefined ? FORMULA : formulaCell,
});

describe('the throwaway guard', () => {
  it('refuses the live sheet, whatever the flag says', () => {
    assert.throws(() => guardSpreadsheet('SHEET-1', 'SHEET-1'));
    assert.throws(() => guardSpreadsheet('  SHEET-1  ', 'SHEET-1'), 'a stray space is not a different sheet');
  });

  it('refuses to run with no spreadsheet at all', () => {
    assert.throws(() => guardSpreadsheet('', 'SHEET-1'));
    assert.throws(() => guardSpreadsheet(undefined, undefined));
  });

  it('allows any other spreadsheet', () => {
    assert.equal(guardSpreadsheet('THROWAWAY', 'SHEET-1'), 'THROWAWAY');
  });
});

describe('S2 — an append with null next to a bounded array', () => {
  it('says yes when the row lands below the last one and the formula covers it', () => {
    const result = s2([HEADER].concat(SEEDED, [['four', 'n4', 'FOUR']]));
    assert.equal(result.answer, 'yes');
    assert.includes(result.detail, 'row 5');
  });

  it('says no when the append lands somewhere else entirely', () => {
    const gap = [HEADER].concat(SEEDED, [[], [], ['four', 'n4', 'FOUR']]);
    assert.equal(s2(gap).answer, 'no');
  });

  it('says no when the formula spilled below the table', () => {
    const spilled = [HEADER].concat(SEEDED, [['four', 'n4', 'FOUR'], ['', '', '']]);
    assert.equal(s2(spilled).answer, 'no');
    assert.includes(s2(spilled).detail, 'taller');
  });

  it('says no when the derived cell did not extend over the new row', () => {
    const blank = [HEADER].concat(SEEDED, [['four', 'n4', '']]);
    assert.equal(s2(blank).answer, 'no');
    assert.includes(s2(blank).detail, 'did not extend');
  });

  it('says no when the append overwrote the formula itself', () => {
    assert.equal(s2([HEADER].concat(SEEDED, [['four', 'n4', 'FOUR']]), 'ONE').answer, 'no');
  });

  it('says no rather than throwing when the read came back empty', () => {
    assert.equal(s2([]).answer, 'no');
  });
});

describe('S3 — a basic filter after a write', () => {
  it('says yes when the edited row is hidden and the untouched row is not', () => {
    const result = answerS3Filter({
      hiddenByFilter: [false, false, true, false, false],
      editedRowIndex: 2, untouchedRowIndex: 1,
    });
    assert.equal(result.answer, 'yes');
  });

  it('says no when the row a write made fail is still on screen', () => {
    const result = answerS3Filter({
      hiddenByFilter: [false, false, false, false, false],
      editedRowIndex: 2, untouchedRowIndex: 1,
    });
    assert.equal(result.answer, 'no');
    assert.includes(result.detail, 're-apply');
  });

  it('says no when a row that still passes was hidden as well', () => {
    const result = answerS3Filter({
      hiddenByFilter: [false, true, true, false, false],
      editedRowIndex: 2, untouchedRowIndex: 1,
    });
    assert.equal(result.answer, 'no');
  });

  it('says no rather than throwing when no metadata came back', () => {
    assert.equal(answerS3Filter({ editedRowIndex: 2, untouchedRowIndex: 1 }).answer, 'no');
  });
});

describe('S3 — a sort inside a filter view', () => {
  it('says yes when the API still reads the rows in the order they were written', () => {
    assert.equal(answerS3Sort({ before: ['C-1', 'C-2', 'C-3'], after: ['C-1', 'C-2', 'C-3'] }).answer, 'yes');
  });

  it('says no when the sort moved the real rows, and shows both orders', () => {
    const result = answerS3Sort({ before: ['C-1', 'C-2', 'C-3'], after: ['C-3', 'C-2', 'C-1'] });
    assert.equal(result.answer, 'no');
    assert.includes(result.detail, 'C-3|C-2|C-1');
  });
});

describe('what it prints', () => {
  it('renders the plan table with the date it was checked', () => {
    const table = renderResultsTable([
      { id: 'S2', answer: 'yes', detail: 'appended at row 5' },
      { id: 'S3', answer: 'no', detail: 'filter: not re-applied' },
    ], '2026-09-23');
    assert.includes(table, '| S2 | yes | appended at row 5 | 2026-09-23 |');
    assert.includes(table, '| S3 | no |');
  });

  it('never breaks the table with a pipe from an error message', () => {
    const table = renderResultsTable([{ id: 'S2', answer: 'error', detail: 'a|b' }], '2026-09-23');
    assert.includes(table, 'a/b');
  });

  it('tells a person what to do for every spike no API can answer', () => {
    for (const id of ['S1', 'S4', 'S5', 'S6', 'S7']) {
      assert.ok(Array.isArray(MANUAL_CHECKS[id]) && MANUAL_CHECKS[id].length > 0, 'no check for ' + id);
    }
    assert.includes(MANUAL_CHECKS.S1.join(' '), SPIKE_TABS.headers);
    assert.includes(MANUAL_CHECKS.S7.join(' '), SPIKE_TABS.protection);
  });

  it('only ever names tabs of its own', () => {
    for (const tab of Object.values(SPIKE_TABS)) assert.ok(tab.indexOf('SPIKE_') === 0, tab);
  });
});

describe('the flags', () => {
  it('reads the spreadsheet id, and the two modes', () => {
    assert.deepEqual(parseArgs(['--spreadsheet', 'ABC']), { spreadsheet: 'ABC', create: false, clean: false });
    assert.deepEqual(parseArgs(['--create']), { spreadsheet: '', create: true, clean: false });
    assert.deepEqual(parseArgs(['--spreadsheet', 'ABC', '--clean']), { spreadsheet: 'ABC', create: false, clean: true });
  });

  it('does not mistake a missing id for one', () => {
    assert.equal(parseArgs(['--spreadsheet']).spreadsheet, '');
  });
});
