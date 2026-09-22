/**
 * Everything is connected to something that exists.
 *
 * The workflows are generated, so a typo does not fail a compiler: it fails at
 * three in the morning, on a real customer's message. These tests read the
 * generated files and check the joins that only show up at run time:
 *
 *   - every `$("Some Node")` names a node that is really in that workflow,
 *   - and one that has already run when it is read,
 *   - every Sheets node writes to a tab that exists, and to columns that tab
 *     really has (a column that does not exist is accepted by Google and
 *     lands nowhere),
 *   - every Sheets API URL names a real tab,
 *   - every Execute Workflow call names a workflow in this repository,
 *   - every node can be reached from a trigger.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'n8n', 'workflows');
const TEMPLATES = path.join(__dirname, '..', '..', 'sheets-templates');

const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
const WORKFLOWS = FILES.map((file) => ({ file, wf: JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) }));
const WORKFLOW_IDS = new Set(WORKFLOWS.map((w) => w.wf.id));

/** The columns a tab really has, or null when there is no such tab. */
function columnsOf(tab) {
  const file = path.join(TEMPLATES, tab + '.csv');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].split(',').map((c) => c.trim()).filter(Boolean);
}

/** Node names read by an expression: $("Name") or $('Name'). */
function referencedNodes(node) {
  const text = JSON.stringify(node.parameters || {});
  const names = new Set();
  const pattern = /\$\(\s*\\?["']([^"'\\]+)\\?["']\s*\)/g;
  let match = pattern.exec(text);
  while (match !== null) {
    names.add(match[1]);
    match = pattern.exec(text);
  }
  return Array.from(names);
}

function graph(wf) {
  const targetsOf = (name) => (((wf.connections[name] || {}).main) || [])
    .reduce((all, output) => all.concat((output || []).map((t) => t.node)), []);
  const after = (name) => {
    const seen = new Set();
    const stack = targetsOf(name).slice();
    while (stack.length > 0) {
      const next = stack.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push.apply(stack, targetsOf(next));
    }
    return seen;
  };
  return { targetsOf, after };
}

for (const { file, wf } of WORKFLOWS) {
  describe(file + ' is wired to things that exist', () => {
    const names = new Set(wf.nodes.map((n) => n.name));
    const { targetsOf, after } = graph(wf);
    const real = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');

    it('every expression names a node that exists', () => {
      for (const node of real) {
        for (const ref of referencedNodes(node)) {
          assert.ok(names.has(ref), node.name + ' reads $("' + ref + '"), which is not in this workflow');
        }
      }
    });

    it('every node it reads has already run', () => {
      for (const node of real) {
        const later = after(node.name);
        for (const ref of referencedNodes(node)) {
          assert.notOk(later.has(ref),
            node.name + ' reads $("' + ref + '"), which runs after it');
        }
      }
    });

    it('every Sheets node names a tab that exists, and columns that tab has', () => {
      for (const node of real) {
        if (node.type !== 'n8n-nodes-base.googleSheets') continue;
        const tab = ((node.parameters || {}).sheetName || {}).value;
        if (typeof tab !== 'string' || tab.indexOf('{{') !== -1) continue;
        const columns = columnsOf(tab);
        assert.ok(columns, node.name + ' writes to a tab with no template: ' + tab);
        const mapped = Object.keys(((node.parameters || {}).columns || {}).value || {});
        for (const column of mapped) {
          if (column === 'row_number') continue; // n8n's own row index, not a column
          assert.ok(columns.indexOf(column) !== -1,
            node.name + ' writes ' + tab + '.' + column + ', which the tab does not have');
        }
      }
    });

    it('every Sheets API call names a tab that exists', () => {
      const tabPattern = /(?:values\/|ranges=)([^!]+)!/g;
      for (const node of real) {
        const url = (node.parameters || {}).url;
        if (typeof url !== 'string') continue;
        let match = tabPattern.exec(url);
        while (match !== null) {
          const tab = decodeURIComponent(match[1]);
          assert.ok(columnsOf(tab), node.name + ' calls the API for a tab with no template: ' + tab);
          match = tabPattern.exec(url);
        }
      }
    });

    it('every workflow it calls is one of ours', () => {
      for (const node of real) {
        if (node.type !== 'n8n-nodes-base.executeWorkflow') continue;
        const target = ((node.parameters || {}).workflowId || {}).value;
        assert.ok(WORKFLOW_IDS.has(target), node.name + ' calls an unknown workflow: ' + target);
      }
    });

    it('every node can be reached from a trigger', () => {
      const triggers = real.filter((n) => /Trigger$|\.webhook$/.test(n.type));
      assert.ok(triggers.length > 0, 'a workflow with no trigger never runs');
      const reachable = new Set(triggers.map((t) => t.name));
      for (const trigger of triggers) for (const name of after(trigger.name)) reachable.add(name);
      for (const node of real) {
        assert.ok(reachable.has(node.name), node.name + ' is not reachable from a trigger');
      }
    });

    it('every connection goes to a node that exists', () => {
      for (const source of Object.keys(wf.connections)) {
        assert.ok(names.has(source), 'connections name a source that does not exist: ' + source);
        for (const target of targetsOf(source)) {
          assert.ok(names.has(target), source + ' is connected to a node that does not exist: ' + target);
        }
      }
    });
  });
}

describe('the workflows fit together', () => {
  it('every workflow id is unique, so an import cannot overwrite another', () => {
    const ids = WORKFLOWS.map((w) => w.wf.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('the receivers hand over to the message processor', () => {
    const processor = WORKFLOWS.find((w) => w.file.indexOf('02-') === 0).wf.id;
    for (const file of ['01-webhook-receiver.json', '01b-waha-webhook-receiver.json']) {
      const wf = WORKFLOWS.find((w) => w.file === file).wf;
      const calls = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow')
        .map((n) => ((n.parameters || {}).workflowId || {}).value);
      assert.ok(calls.indexOf(processor) !== -1, file + ' does not call the message processor');
    }
  });

  it('the message processor hands over to conversation and assignment', () => {
    const conversation = WORKFLOWS.find((w) => w.file.indexOf('03-') === 0).wf.id;
    const wf = WORKFLOWS.find((w) => w.file.indexOf('02-') === 0).wf;
    const calls = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow')
      .map((n) => ((n.parameters || {}).workflowId || {}).value);
    assert.ok(calls.indexOf(conversation) !== -1);
  });
});
