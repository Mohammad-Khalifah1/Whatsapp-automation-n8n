/**
 * The Apps Script files never delete or move a row.
 *
 * Deleting a row shifts every row below it, under whatever the workflows are
 * writing at that moment. Workflow 8 is the only thing allowed to delete, and
 * it deletes by id from a fresh read. SheetTools.gs used to delete archived
 * rows on its own, racing workflow 8.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..', '..', 'sheets-templates');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.gs'));

/** Source with comments removed, so a comment explaining a rule is not a hit. */
function code(file) {
  return fs.readFileSync(path.join(DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

describe('Apps Script files', () => {
  for (const file of FILES) {
    it(file + ' parses as JavaScript', () => {
      new vm.Script(fs.readFileSync(path.join(DIR, file), 'utf8'));
    });

    it(file + ' never deletes or moves a row', () => {
      const src = code(file);
      for (const call of ['deleteRow(', 'deleteRows(', 'moveRows(', 'insertRowBefore(', 'insertRowsBefore(']) {
        assert.ok(src.indexOf(call) === -1, file + ' calls ' + call);
      }
    });
  }

  it('SheetTools.gs does not append rows to another tab either', () => {
    assert.ok(code('SheetTools.gs').indexOf('appendRow(') === -1);
  });
});
