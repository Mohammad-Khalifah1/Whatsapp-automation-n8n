/**
 * Appends go through the Sheets API with INSERT_ROWS.
 *
 * n8n's Sheets append works out the next free row and writes there, so two
 * executions arriving together pick the same row and one of them is lost with
 * both executions green. build-workflows.js rewrites every Sheets append into
 * an API append (INSERT_ROWS) with the Sheets node kept as its fallback. These
 * tests pin the pieces of that rewrite that decide what lands in the sheet.
 */

'use strict';

const vm = require('vm');
const {
  tabHeader,
  expressionToJs,
  appendRowValues,
  rowByHeaderExpr,
  routeAppendsThroughApi,
} = require('../../scripts/setup/build-workflows');

/** Evaluate a generated JS expression with stand-ins for n8n's globals. */
function evaluate(js, context) {
  return vm.runInNewContext(js, Object.assign({ Object, JSON, String, Array, Error }, context));
}

/** A `$` that answers `$("Sheets Access").first()` and `$("Src").item`. */
function dollar(headers, token) {
  const access = { token: token === undefined ? 'ya29.test' : token, headers };
  return (name) => ({
    first: () => ({ json: name === 'Sheets Access' ? access : {} }),
    item: { json: {} },
  });
}

function sheetsAppend(name, tab, value) {
  return {
    parameters: {
      operation: 'append',
      sheetName: { __rl: true, value: tab, mode: 'name' },
      columns: { mappingMode: 'defineBelow', value },
    },
    id: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.7,
    position: [400, 0],
    onError: 'continueErrorOutput',
  };
}

function workflow(nodes, connections) {
  return {
    name: 'test',
    settings: { executionOrder: 'v1' },
    nodes: [
      { name: 'Trigger', type: 'n8n-nodes-base.executeWorkflowTrigger', position: [0, 0], parameters: {} },
      { name: 'Source', type: 'n8n-nodes-base.code', position: [200, 0], parameters: {} },
    ].concat(nodes),
    connections: Object.assign({
      Trigger: { main: [[{ node: 'Source', type: 'main', index: 0 }]] },
    }, connections),
  };
}

describe('expressionToJs', () => {
  it('turns a single n8n expression into a bare JS expression', () => {
    assert.equal(expressionToJs('={{ $json.message_id }}'), '($json.message_id)');
  });

  it('keeps a literal as a string literal', () => {
    assert.equal(expressionToJs('outbound'), '"outbound"');
  });

  it('joins text mixed with expressions', () => {
    const js = expressionToJs("=message:{{ $json.id }}");
    assert.equal(evaluate(js, { $json: { id: 'wamid.1' } }), 'message:wamid.1');
  });

  it('refuses nested braces rather than guessing', () => {
    assert.throws(() => expressionToJs('={{ JSON.stringify({ a: { b: 1 }}) }}'));
  });

  it('translates a JSON.stringify call with an object literal', () => {
    const js = expressionToJs('={{ JSON.stringify({ reason: $json.reason, field: $json.field }) }}');
    assert.equal(evaluate(js, { $json: { reason: 'r', field: 'f' } }), '{"reason":"r","field":"f"}');
  });
});

describe('appendRowValues', () => {
  it('rejects a column the tab template does not have', () => {
    assert.throws(() => appendRowValues('Messages', { not_a_column: 'x' }));
  });

  it('accepts every column of the template', () => {
    const value = {};
    for (const c of tabHeader('Messages')) value[c] = '={{ $json.' + c + ' }}';
    assert.equal(appendRowValues('Messages', value).length, tabHeader('Messages').length);
  });
});

describe('rowByHeaderExpr', () => {
  const values = appendRowValues('Messages', {
    message_id: '={{ $json.id }}',
    direction: 'inbound',
    text: '={{ $json.text }}',
    supported: '={{ $json.supported }}',
  });
  const js = rowByHeaderExpr('Messages', values);

  it('places each value under its column name, whatever the column order', () => {
    const header = ['text', 'direction', 'extra_column_added_by_hand', 'message_id', 'supported'];
    const row = evaluate(js, {
      $: dollar({ Messages: header }),
      $json: { id: 'wamid.9', text: 'hello', supported: true },
    });
    assert.deepEqual(row, ['hello', 'inbound', null, 'wamid.9', 'true']);
  });

  it('sends every value as text, as the Sheets node does, and skips empty ones', () => {
    const row = evaluate(js, {
      $: dollar({ Messages: ['message_id', 'text', 'supported'] }),
      $json: { id: 42, text: undefined, supported: false },
    });
    assert.deepEqual(row, ['42', null, 'false']);
  });

  it('throws without a header, so the Sheets node fallback writes the row', () => {
    assert.throws(() => evaluate(js, { $: dollar({}), $json: {} }));
  });

  it('throws without a token, before any request is made', () => {
    assert.throws(() => evaluate(js, { $: dollar({ Messages: ['message_id'] }, null), $json: {} }));
  });
});

describe('every generated API append', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', '..', 'n8n', 'workflows');

  // Stands in for any value an expression reads: stringifies to "v".
  const anything = new Proxy(function () {}, {
    get: (target, prop) => (prop === Symbol.toPrimitive ? () => 'v' : (prop === 'toJSON' ? undefined : anything)),
    apply: () => anything,
  });

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const wf = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const appends = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest' &&
      /:append\?/.test((n.parameters || {}).url || ''));
    for (const node of appends) {
      it(file + ' / ' + node.name + ': its body evaluates to one full row', () => {
        const tab = decodeURIComponent(node.parameters.url.split('/values/')[1].split(':append')[0]).split('!')[0];
        const header = tabHeader(tab);
        const body = node.parameters.jsonBody;
        assert.ok(body.indexOf('={{') === 0 && body.slice(-2) === '}}', 'one expression');
        const json = evaluate(body.slice(3, -2), {
          $: (name) => (name === 'Sheets Access'
            ? { first: () => ({ json: { token: 't', headers: { [tab]: header } } }) }
            : { first: () => ({ json: anything }), item: { json: anything } }),
          $json: anything,
          $now: anything,
          $env: anything,
        });
        const row = JSON.parse(json).values[0];
        assert.equal(row.length, header.length, 'one cell per column');
      });
    }
  }
});

describe('routeAppendsThroughApi', () => {
  const build = () => {
    const wf = workflow(
      [sheetsAppend('Record Message', 'Messages', { message_id: '={{ $json.id }}', direction: 'inbound' })],
      {
        Source: { main: [[{ node: 'Record Message', type: 'main', index: 0 }]] },
        'Record Message': { main: [[{ node: 'After', type: 'main', index: 0 }]] },
      }
    );
    wf.nodes.push({ name: 'After', type: 'n8n-nodes-base.noOp', position: [600, 0], parameters: {} });
    routeAppendsThroughApi(wf);
    return wf;
  };
  const node = (wf, name) => wf.nodes.find((n) => n.name === name);

  it('replaces the Sheets append with an INSERT_ROWS API append under the same name', () => {
    const api = node(build(), 'Record Message');
    assert.equal(api.type, 'n8n-nodes-base.httpRequest');
    assert.includes(api.parameters.url, 'insertDataOption=INSERT_ROWS');
    assert.includes(api.parameters.url, 'valueInputOption=USER_ENTERED');
  });

  it('keeps the Sheets node as a fallback on the error output, feeding the same next node', () => {
    const wf = build();
    assert.deepEqual(wf.connections['Record Message'].main.map((o) => o.map((t) => t.node)),
      [['After'], ['Fallback: Record Message']]);
    assert.deepEqual(wf.connections['Fallback: Record Message'].main.map((o) => o.map((t) => t.node)),
      [['After']]);
  });

  it('points the fallback at the real source, not at the error item', () => {
    const fallback = node(build(), 'Fallback: Record Message');
    assert.equal(fallback.parameters.columns.value.message_id, '={{ $("Source").item.json.id }}');
  });

  it('hangs the access branch off the trigger, above everything else', () => {
    const wf = build();
    const first = wf.connections.Trigger.main[0].map((t) => t.node);
    assert.equal(first[0], 'Sign Sheets Token Request');
    const sign = node(wf, 'Sign Sheets Token Request');
    const branch = ['Sign Sheets Token Request', 'Need Sheets Token?', 'Get Sheets Token',
      'Sheet Headers Fresh?', 'Read Sheet Headers', 'Sheets Access'];
    for (const n of wf.nodes) {
      if (branch.indexOf(n.name) === -1) {
        assert.ok(n.position[1] > sign.position[1], n.name + ' sits above the access branch');
      }
    }
  });

  it('skips the token request when a cached token is still good', () => {
    const wf = build();
    assert.deepEqual(wf.connections['Need Sheets Token?'].main.map((o) => o.map((t) => t.node)),
      [['Get Sheets Token'], ['Sheet Headers Fresh?']]);
    assert.deepEqual(wf.connections['Sheet Headers Fresh?'].main.map((o) => o.map((t) => t.node)),
      [['Sheets Access'], ['Read Sheet Headers']]);
  });

  it('reads the header of exactly the tabs the workflow appends to', () => {
    const read = node(build(), 'Read Sheet Headers');
    assert.includes(read.parameters.url, 'ranges=Messages!1%3A1');
    assert.notOk(read.parameters.url.indexOf('Conversations') !== -1);
  });

  it('refuses a fallback that cannot tell which input it reads', () => {
    const wf = workflow(
      [
        sheetsAppend('Record Message', 'Messages', { message_id: '={{ $json.id }}' }),
        { name: 'Other', type: 'n8n-nodes-base.code', position: [200, 200], parameters: {} },
      ],
      {
        Source: { main: [[{ node: 'Record Message', type: 'main', index: 0 }]] },
        Other: { main: [[{ node: 'Record Message', type: 'main', index: 0 }]] },
      }
    );
    assert.throws(() => routeAppendsThroughApi(wf));
  });
});
