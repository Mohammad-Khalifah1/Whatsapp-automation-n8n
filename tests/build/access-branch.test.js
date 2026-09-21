/**
 * The access branch, run from the generated workflow itself.
 *
 * `Sign Sheets Token Request` and `Sheets Access` are Code nodes whose bodies
 * are built as strings in build-workflows.js. A mistake in them would only
 * show up inside n8n, on a live message. These tests take the exact code from
 * a generated workflow file and run it with stand-ins for n8n's globals
 * ($env, $input, $(), $getWorkflowStaticData), so a broken body fails here.
 */

'use strict';

const crypto = require('crypto');
const path = require('path');

const WORKFLOW = require(path.join('..', '..', 'n8n', 'workflows', '03-conversation-assignment.json'));

function code(name) {
  const node = WORKFLOW.nodes.find((n) => n.name === name);
  if (!node) throw new Error('no node ' + name + ' in workflow 3');
  return node.parameters.jsCode;
}

/** Run a Code node body the way n8n does: as the body of a function. */
function run(name, env) {
  const fn = new Function(
    'require', '$env', '$input', '$', '$getWorkflowStaticData', 'console',
    code(name)
  );
  return fn(
    (m) => require(m),
    env.$env || {},
    { first: () => env.input, all: () => (env.input ? [env.input] : []) },
    (node) => {
      const out = (env.nodes || {})[node];
      if (out === undefined) throw new Error('node ' + node + ' has not run');
      return { first: () => ({ json: out }) };
    },
    () => env.store,
    { log: (line) => (env.logs = (env.logs || []).concat(line)) }
  );
}

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const ENV = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'bot@example.iam.gserviceaccount.com',
  // As .env holds it: one line, literal \n escapes.
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: PEM.split('\n').join('\\n'),
};

describe('Sign Sheets Token Request (generated code)', () => {
  it('signs a token request when nothing is cached', () => {
    const out = run('Sign Sheets Token Request', { $env: ENV, store: {} });
    assert.equal(out.length, 1);
    assert.equal(out[0].json.need_token, true);
    assert.equal(out[0].json.headers_fresh, false);
    assert.equal(out[0].json.assertion.split('.').length, 3, 'a JWT has three parts');
  });

  it('reuses a cached token that is not about to expire', () => {
    const store = { sheetsToken: { value: 'ya29.cached', expiresAt: Date.now() + 30 * 60000 } };
    const out = run('Sign Sheets Token Request', { $env: ENV, store });
    assert.equal(out[0].json.need_token, false);
    assert.equal(out[0].json.token, 'ya29.cached');
  });

  it('asks again for a token within five minutes of expiry', () => {
    const store = { sheetsToken: { value: 'ya29.old', expiresAt: Date.now() + 60000 } };
    const out = run('Sign Sheets Token Request', { $env: ENV, store });
    assert.equal(out[0].json.need_token, true);
  });

  it('reports headers read less than a minute ago as fresh', () => {
    const store = { sheetHeaders: { at: Date.now() - 10000, headers: {} } };
    const out = run('Sign Sheets Token Request', { $env: ENV, store });
    assert.equal(out[0].json.headers_fresh, true);
  });

  it('stops the branch, and logs why, without a service account', () => {
    const env = { $env: {}, store: {} };
    const out = run('Sign Sheets Token Request', env);
    assert.deepEqual(out, []);
    assert.includes(env.logs.join('\n'), 'sheets_token_unavailable');
  });
});

describe('Sheets Access (generated code)', () => {
  const headerRanges = {
    valueRanges: [
      { range: 'Conversations!A1:AC1', values: [['customer_name', 'customer_phone']] },
      { range: "'Log'!A1:I1", values: [['event_id', 'event_type']] },
      { range: 'Messages!A1:S1', values: [['status', 'direction']] },
    ],
  };

  it('takes a new token and fresh headers, and caches both', () => {
    const store = {};
    const out = run('Sheets Access', {
      store,
      input: { json: headerRanges },
      nodes: {
        'Sign Sheets Token Request': { need_token: true, assertion: 'x.y.z' },
        'Get Sheets Token': { access_token: 'ya29.new', expires_in: 3599 },
      },
    });
    assert.equal(out[0].json.token, 'ya29.new');
    assert.deepEqual(out[0].json.headers.Conversations, ['customer_name', 'customer_phone']);
    assert.deepEqual(out[0].json.headers.Log, ['event_id', 'event_type'], 'a quoted tab name is unquoted');
    assert.equal(store.sheetsToken.value, 'ya29.new');
    assert.ok(store.sheetsToken.expiresAt > Date.now() + 3500 * 1000);
    assert.ok(store.sheetHeaders.at > 0);
  });

  it('uses the cached token and cached headers when both are fresh', () => {
    const store = { sheetHeaders: { at: Date.now(), headers: { Messages: ['status'] } } };
    const out = run('Sheets Access', {
      store,
      input: { json: { need_token: false, token: 'ya29.cached' } },
      nodes: { 'Sign Sheets Token Request': { need_token: false, token: 'ya29.cached' } },
    });
    assert.equal(out[0].json.token, 'ya29.cached');
    assert.deepEqual(out[0].json.headers, { Messages: ['status'] });
  });

  it('drops a token Google refused, so the next run asks for a new one', () => {
    const store = { sheetsToken: { value: 'ya29.revoked', expiresAt: Date.now() + 3000000 } };
    const env = {
      store,
      input: { json: { error: { code: 401, message: 'Request had invalid authentication credentials.' } } },
      nodes: { 'Sign Sheets Token Request': { need_token: false, token: 'ya29.revoked' } },
    };
    const out = run('Sheets Access', env);
    assert.equal(out[0].json.token, null);
    assert.equal(store.sheetsToken, undefined);
    assert.includes(env.logs.join('\n'), 'sheets_access_unavailable');
  });

  it('logs a column the workflow writes but the sheet does not have', () => {
    const env = {
      store: {},
      input: { json: headerRanges },
      nodes: {
        'Sign Sheets Token Request': { need_token: false, token: 'ya29.cached' },
      },
    };
    run('Sheets Access', env);
    assert.includes(env.logs.join('\n'), 'sheet_header_mismatch');
  });

  it('still answers, with no token, when the token request failed', () => {
    const out = run('Sheets Access', {
      store: {},
      input: { json: { error: { code: 400 } } },
      nodes: {
        'Sign Sheets Token Request': { need_token: true, assertion: 'x.y.z' },
        'Get Sheets Token': { error: 'invalid_grant' },
      },
    });
    assert.equal(out[0].json.token, null);
    assert.deepEqual(out[0].json.headers, {});
  });
});
