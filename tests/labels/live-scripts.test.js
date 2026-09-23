/**
 * The scripts that check the live deployment read the sheet the way the
 * workflows do.
 *
 * They open the same spreadsheet as n8n. Comparing a cell against an English
 * code makes every check fail on a sheet kept in another language — a false
 * alarm about a system that is working — and typing a code into a status cell
 * leaves a value the column's own validation rejects. Neither can be caught by
 * running them, because running them needs the live deployment, so the rule is
 * checked here in the source, the way the Apps Script rules are.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'scripts', 'testing');

/** The scripts that read or write the business's own spreadsheet. */
const SCRIPTS = ['verify-live.js', 'verify-archive.js', 'scenario-multi-agent.js', 'show-sheet.js'];

const CODES = ['WAITING_FOR_AGENT', 'UNANSWERED', 'REPLIED', 'WAITING_FOR_CUSTOMER',
  'CLOSED', 'ARCHIVED', 'SENT', 'FAILED', 'WINDOW_CLOSED', 'inbound', 'outbound'];

const source = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');

describe('the live scripts and the language of the sheet', () => {
  for (const file of SCRIPTS) {
    const code = source(file);

    it(file + ' takes its values from the label table', () => {
      assert.includes(code, "require('../lib/labels')");
    });

    it(file + ' compares a cell as a code, never as the English word', () => {
      // A cell read straight off the row and compared to a word. Comparing
      // the result of toCode(...) to a code is the right way round and looks
      // the same on the right-hand side, so the left-hand side is the tell.
      const pattern = /\.(status|reply_status|last_message_direction|last_reply_via|stage|outcome)\s*(===|!==)\s*'/g;
      const found = code.match(pattern) || [];
      assert.deepEqual(found, [], 'compare toCode(field, cell) instead');
    });

    it(file + " writes a status in the sheet's own words", () => {
      // Anywhere but inside toLabel('status', CODE, LANG), which is the form
      // that puts the right word in the cell.
      const pattern = new RegExp("(?<!toLabel\\()'status',\\s*'(" + CODES.join('|') + ")'", 'g');
      const found = code.match(pattern) || [];
      assert.deepEqual(found, [], "write toLabel('status', CODE, LANG) instead");
    });
  }
});
