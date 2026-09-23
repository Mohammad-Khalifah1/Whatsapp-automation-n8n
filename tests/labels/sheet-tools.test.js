/**
 * The two tools that write to the sheet, in the sheet's own language.
 *
 * `apply-sheet-layout.js` decides what a cell is allowed to hold and what
 * colour it turns. `build-dashboard.js` decides what the team is told is
 * happening. Both used to compare English codes, so on an Arabic sheet the
 * dropdowns would reject every value n8n writes, nothing would be coloured,
 * and the dashboard would report a quiet week for a desk that is on fire.
 *
 * Both now take their values from scripts/lib/labels.js, the same place the
 * workflows take them from.
 */

'use strict';

const { codes, toLabel, LANGUAGES } = require('../../scripts/lib/labels');
const layout = require('../../scripts/setup/apply-sheet-layout');
const dashboard = require('../../scripts/setup/build-dashboard');

describe('the dropdowns a person picks from', () => {
  it('offers every value the system writes, in each language', () => {
    for (const lang of LANGUAGES) {
      const offered = layout.labelled('status', false, lang);
      for (const code of codes('status')) {
        assert.ok(offered.indexOf(toLabel('status', code, lang)) !== -1,
          lang + ' dropdown is missing ' + code);
      }
      assert.equal(offered.length, codes('status').length, 'no extra values in ' + lang);
    }
  });

  it('allows an empty cell only where a column starts empty', () => {
    assert.equal(layout.labelled('reply_status', true)[0], '', 'a reply has no status until one is sent');
    assert.notOk(layout.labelled('status', false).indexOf('') !== -1, 'a conversation always has a status');
  });

  it('leaves the machine tabs in codes', () => {
    assert.deepEqual(layout.ENUMS.Messages.direction, ['inbound', 'outbound']);
    assert.ok(layout.ENUMS.Messages.status.indexOf('DELIVERED') !== -1);
  });

  // Asked for a language rather than read off ENUMS, which follows whatever
  // SHEET_LANGUAGE the machine running the tests happens to have set.
  it('is the codes themselves in English, so an existing sheet is unchanged', () => {
    assert.deepEqual(layout.labelled('status', false, 'en'), codes('status'));
    assert.deepEqual(layout.labelled('direction', false, 'en'), codes('direction'));
  });
});

describe('the colour a cell turns', () => {
  it('finds the colour of a value written in either language', () => {
    assert.equal(layout.colourKey('status', 'CLOSED'), 'CLOSED');
    assert.equal(layout.colourKey('status', 'مغلقة'), 'CLOSED');
    assert.equal(layout.colourKey('last_message_direction', 'الزبون'), 'inbound');
  });

  it('leaves a column that holds no labelled value alone', () => {
    assert.equal(layout.colourKey('status', 'RECEIVED'), 'RECEIVED', 'a delivery state, not a conversation status');
    assert.equal(layout.colourKey('sent_via', 'google_sheet'), 'google_sheet');
  });

  it('has a colour for every conversation status, whatever it is written in', () => {
    for (const lang of LANGUAGES) {
      for (const label of layout.labelled('status', false, lang)) {
        assert.ok(layout.COLORS[layout.colourKey('status', label)], 'no colour for ' + label);
      }
    }
  });
});

describe('what the dashboard counts', () => {
  it('counts a status in every language it can be written in', () => {
    assert.deepEqual(dashboard.labelVariants('status', 'UNANSWERED'), ['UNANSWERED', 'بانتظار الرد']);
  });

  it('counts a value whose languages agree only once', () => {
    assert.deepEqual(dashboard.labelVariants('via', 'API'), ['API']);
  });

  it('adds the spellings together, keeping the other criteria on each', () => {
    const formula = dashboard.countLabelled('R', 'status', 'REPLIED', 'A,"Rana"');
    assert.equal(formula, 'COUNTIFS(R,"REPLIED",A,"Rana")+COUNTIFS(R,"تم الرد",A,"Rana")');
  });

  it('excludes every spelling of a closed case from the open count', () => {
    const parts = dashboard.excluding('R', 'status', ['CLOSED', 'ARCHIVED']);
    assert.deepEqual(parts, ['R,"<>CLOSED"', 'R,"<>مغلقة"', 'R,"<>ARCHIVED"', 'R,"<>أرشفة الآن"']);
  });

  it('still reads as it always did on an English sheet', () => {
    assert.includes(dashboard.countLabelled('R', 'status', 'UNANSWERED'), 'COUNTIFS(R,"UNANSWERED")');
  });

  it('finds a column by name, so reordering the sheet cannot point it elsewhere', () => {
    assert.equal(dashboard.col('Conversations', ['a', 'status', 'c'], 'status'), "'Conversations'!$B:$B");
    assert.throws(() => dashboard.col('Conversations', ['a'], 'status'));
  });
});
