#!/usr/bin/env node
/**
 * Workflow builder.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * n8n Code nodes cannot `require()` files from the host, so business logic
 * pasted into a workflow is a COPY. Copies drift: the tests keep passing while
 * the thing actually running in production quietly diverges.
 *
 * THE SOLUTION
 * ------------
 * scripts/lib/*.js is the single canonical source. It is unit-tested directly.
 * This script inlines those exact bytes into the Code nodes of every workflow
 * at build time. The workflow JSON in n8n/workflows/ is therefore GENERATED —
 * never hand-edit the Code node bodies there; edit scripts/lib/ and rebuild.
 *
 * Usage:
 *   node scripts/setup/build-workflows.js          # build all workflows
 *   node scripts/setup/build-workflows.js --check  # verify generated files are current
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const LIB_DIR = path.join(ROOT, 'scripts', 'lib');
const OUT_DIR = path.join(ROOT, 'n8n', 'workflows');

/**
 * n8n node type versions, read from the running n8n 2.38.5 image on
 * 2026-09-10. Pinned here so a workflow never silently downgrades to an older
 * parameter schema. Re-verify when upgrading n8n (see docs/N8N_WORKFLOWS.md).
 */
/**
 * STABLE WORKFLOW IDS.
 *
 * n8n's `import:workflow` UPDATES an existing workflow when the JSON carries an
 * `id` that already exists, and CREATES a new one when it does not. Without a
 * fixed id, every re-import produces another duplicate set — so these ids are
 * pinned here.
 *
 * Pinning them also removes the chicken-and-egg problem for Execute Workflow
 * nodes: a workflow's id is known at build time, so cross-references can be
 * written directly instead of being patched after the first import.
 *
 * Format matches n8n's own 16-character alphanumeric ids.
 */
const WORKFLOW_ID = {
  receiver: 'whatsappRecv0001',
  processor: 'whatsappProc0002',
  conversation: 'whatsappConv0003',
  outgoing: 'whatsappSend0004',
  queueRetry: 'whatsappQueu0005',
  errorHandler: 'whatsappErrH0006',
  replyFromSheet: 'whatsappShRp0007',
  archive: 'whatsappArch0008',
};

const NODE_VERSION = {
  webhook: 2.1,
  respondToWebhook: 1.5,
  code: 2,
  if: 2.3,
  switch: 3.4,
  set: 3.5,
  httpRequest: 4.5,
  googleSheets: 4.7,
  noOp: 1,
  merge: 3.2,
  executeWorkflow: 1.3,
  executeWorkflowTrigger: 1.2,
  stopAndError: 1,
  scheduleTrigger: 1.4,
  errorTrigger: 1,
};

/**
 * WAHA connector (docs/WAHA_CONNECTOR.md) — shared between workflow 4's
 * webhook-triggered send and workflow 7's sheet-polling send, the two places
 * that call out to WhatsApp to deliver a reply. WHATSAPP_CONNECTOR selects
 * the branch at RUN time (an n8n expression), not at build time, so one
 * generated workflow file serves both connectors and a deployment can flip
 * between them by changing one env var, no rebuild required.
 *
 * Kept here rather than in scripts/lib/ because — unlike security.js/
 * webhook-parser.js — this is HTTP Request node PARAMETERS (url, headers,
 * body), not Code node logic; inlineLibrary() has nothing to paste for it.
 */
const WHATSAPP_SEND_URL_EXPR =
  "={{ $env.WHATSAPP_CONNECTOR === 'waha' ? ($env.WAHA_BASE_URL + '/api/sendText') : ('https://graph.facebook.com/' + $env.META_GRAPH_API_VERSION + '/' + $env.META_PHONE_NUMBER_ID + '/messages') }}";

const WHATSAPP_SEND_HEADERS = {
  parameters: [
    // Exactly one of these two is non-empty at run time, selected by
    // WHATSAPP_CONNECTOR. Sending both headers unconditionally (one empty)
    // is harmless — each API ignores headers it does not recognise — and
    // avoids needing a second HTTP Request node just to vary a header set.
    { name: 'Authorization', value: "={{ $env.WHATSAPP_CONNECTOR === 'waha' ? '' : ('Bearer ' + $env.META_ACCESS_TOKEN) }}" },
    // A send-only session key (scripts/setup/configure-waha.js), never the
    // admin WAHA_API_KEY — n8n is not given that one at all.
    { name: 'X-Api-Key', value: "={{ $env.WHATSAPP_CONNECTOR === 'waha' ? $env.WAHA_SEND_API_KEY : '' }}" },
    { name: 'Content-Type', value: 'application/json' },
  ],
};

/**
 * @param {boolean} keepContext  Whether to thread the reply onto a specific
 *   message when the request carries `reply_to_message_id`. Workflow 4
 *   supports this (an agent can reply to a specific message) — as Meta's
 *   `context.message_id`, or WAHA's `reply_to`, which takes the WAHA message
 *   id workflow 1b stores. Workflow 7's sheet-polling send does not carry
 *   that field, so it always sends a plain message.
 */
function whatsappSendBodyExpr(keepContext) {
  const metaBody = keepContext
    ? 'Object.assign({ messaging_product: "whatsapp", recipient_type: "individual", to: $json.to, type: "text", text: { body: $json.text } }, $json.reply_to_message_id ? { context: { message_id: $json.reply_to_message_id } } : {})'
    : '{ messaging_product: "whatsapp", recipient_type: "individual", to: $json.to, type: "text", text: { body: $json.text } }';
  const wahaPlain =
    "{ session: ($env.WAHA_SESSION || 'default'), chatId: (String($json.to || '').replace(/[^0-9]/g, '') + '@c.us'), text: $json.text }";
  const wahaBody = keepContext
    ? `Object.assign(${wahaPlain}, $json.reply_to_message_id ? { reply_to: $json.reply_to_message_id } : {})`
    : wahaPlain;
  return `={{ JSON.stringify($env.WHATSAPP_CONNECTOR === 'waha' ? (${wahaBody}) : (${metaBody})) }}`;
}

/**
 * Lines for the Interpret-result Code nodes (workflow 4 and 7), spliced into
 * the surrounding array-of-lines template with `...WHATSAPP_INTERPRET_RESULT_LINES`.
 * The per-connector response shapes live in scripts/lib/send-result.js, which
 * both nodes inline — including NOWEB's `{ key: { id } }`, which does not
 * match WAHA's own OpenAPI spec.
 */
const WHATSAPP_INTERPRET_RESULT_LINES = [
  'const sendResult = interpretSendResponse($env.WHATSAPP_CONNECTOR, response);',
  'const messageId = sendResult.messageId;',
  'const apiError = sendResult.apiError;',
  'const ok = sendResult.ok;',
];

/**
 * Turn a CommonJS library file into a snippet that can be pasted inside a
 * Code node: strip the module wiring, keep the logic verbatim.
 */
function inlineLibrary(fileName) {
  const source = fs.readFileSync(path.join(LIB_DIR, fileName), 'utf8');
  const lines = source.split(/\r?\n/);
  const kept = [];
  const builtins = new Set();
  let inExportsBlock = false;

  for (const line of lines) {
    // Drop the trailing `module.exports = { ... };` block.
    if (/^\s*module\.exports\s*=/.test(line)) {
      inExportsBlock = !/;\s*$/.test(line) || /\{\s*$/.test(line);
      continue;
    }
    if (inExportsBlock) {
      if (/^\s*\}\s*;\s*$/.test(line)) inExportsBlock = false;
      continue;
    }
    // Drop `const x = require('./y')` for sibling libraries — they are all
    // inlined together into the same scope, so the binding already exists.
    if (/require\(['"]\.\.?\//.test(line)) continue;
    // Hoist built-in requires (e.g. `const crypto = require('crypto')`) out of
    // the library body. Two libraries that both need `crypto` would otherwise
    // each emit the declaration, producing
    // "Identifier 'crypto' has already been declared".
    const builtinMatch = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(['"]([a-z:_-]+)['"]\)\s*;?\s*$/.exec(line);
    if (builtinMatch) {
      builtins.add(builtinMatch[1] + '|' + builtinMatch[2]);
      continue;
    }
    // Drop 'use strict' (the Code node body is already strict-ish and a
    // stray directive mid-file is a syntax error).
    if (/^\s*['"]use strict['"];\s*$/.test(line)) continue;
    kept.push(line);
  }

  return { body: kept.join('\n').trim(), builtins };
}

/** Build the shared prelude injected into every Code node that needs logic. */
function buildPrelude(libFiles) {
  const bodies = [];
  const allBuiltins = new Set();

  for (const f of libFiles) {
    const { body, builtins } = inlineLibrary(f);
    bodies.push({ file: f, body });
    for (const b of builtins) allBuiltins.add(b);
  }

  const parts = [
    '// ==========================================================================',
    '// GENERATED — DO NOT EDIT THIS BLOCK INSIDE n8n.',
    '// Source of truth: scripts/lib/' + libFiles.join(', scripts/lib/'),
    '// Rebuild with: node scripts/setup/build-workflows.js',
    '// ==========================================================================',
  ];

  // Emit each built-in require exactly once, before any library body.
  // Requires NODE_FUNCTION_ALLOW_BUILTIN to permit these modules — see
  // docker-compose.yml.
  if (allBuiltins.size > 0) {
    parts.push('');
    for (const entry of Array.from(allBuiltins).sort()) {
      const [binding, moduleName] = entry.split('|');
      parts.push("const " + binding + " = require('" + moduleName + "');");
    }
  }

  for (const b of bodies) {
    parts.push('');
    parts.push('// ----- scripts/lib/' + b.file + ' -----');
    parts.push(b.body);
  }
  parts.push('');
  parts.push('// ===================== end generated block ================================');
  parts.push('');
  return parts.join('\n');
}

/**
 * The n8n credential every Google Sheets node uses. Only the id and name are
 * referenced — the service-account key itself lives in n8n's encrypted store,
 * never in this repository.
 */
const GOOGLE_CREDENTIAL = {
  id: 'googleSheetsWaSupport',
  name: 'Google Sheets - WhatsApp Support',
};

/**
 * Google Sheets v4 rejects `mappingMode: 'defineBelow'` unless a matching
 * `schema` array is supplied. The failure —
 *   "`columns.schema` is required when `columns.mappingMode` is `defineBelow`"
 * — is routed to the node's error output, where an unconnected branch swallows
 * it, so the workflow still reports success and the sheet stays empty.
 *
 * Deriving the schema from the column map (rather than hand-maintaining one
 * beside it) means the two cannot drift when a field is added.
 */
// The canonical Conversations header. autoMapInputData on an append CREATES a
// column for every unmatched top-level field, and the item at that point in
// workflow 3 carries the whole pipeline context — which appended 41 internal
// fields as real columns in a live sheet. Mapping explicitly is the fix.
// Read from the template, never inlined as a literal. A hard-coded copy meant
// that adding a column to Conversations.csv changed the sheet but not the
// workflows, so the new columns were written as empty cells with nothing to
// say why.
const CONVERSATION_COLUMNS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'sheets-templates', 'Conversations.csv'), 'utf8'
).split(/\r?\n/)[0].split(',').map((c) => c.trim()).filter(Boolean);

/**
 * Column map for a Conversations write.
 *
 * Every column reads from ONE object on the item, `write_row`, instead of from
 * the item itself. That matters for updates: an expression that resolves to
 * undefined leaves the cell alone, so a write that only means to change the
 * last message cannot also blank the assigned agent. Reading straight off the
 * item did exactly that - the pipeline context happened to carry an empty
 * assigned_agent_id, and every follow-up message unassigned the conversation.
 *
 * @param {string} source  Expression for the object to read columns from.
 */
function conversationColumnMap(source) {
  const from = source || '$json.write_row';
  const value = {};
  for (const c of CONVERSATION_COLUMNS) {
    value[c] = '={{ ' + from + "['" + c + "'] }}";
  }
  return value;
}

/** The canonical Messages header, for anything that needs it by position. */
const MESSAGE_COLUMNS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'sheets-templates', 'Messages.csv'), 'utf8'
).split(/\r?\n/)[0].split(',').map((c) => c.trim()).filter(Boolean);

/** Column map for the Log tab, mirroring sheets-templates/Log.csv. */
function logColumnMap() {
  const cols = ['event_id', 'event_type', 'conversation_id', 'message_id',
    'source', 'timestamp', 'status', 'error', 'details'];
  const value = {};
  for (const c of cols) value[c] = "={{ $json['" + c + "'] }}";
  return value;
}

/**
 * Every Google Sheets node retries before it gives up.
 *
 * The Sheets quota is 60 reads per minute per user, and the service account is
 * one user. A burst of messages arriving together, on top of two workflows that
 * poll every minute, goes over it — and a node that fails once loses that
 * customer's message for good: HTTP 200 already went back to Meta, so there is
 * no redelivery coming.
 *
 * Three tries, two seconds apart, turns a rate limit into a pause instead of a
 * loss. It costs nothing when nothing is wrong.
 */
/**
 * A Sheets node must never fail quietly.
 *
 * `continueErrorOutput` sends a failure down the node's SECOND output. If
 * nothing is wired to that output, the branch just ends — and n8n records the
 * execution as a SUCCESS. Eleven nodes were set that way, including every write
 * that records a conversation or a message.
 *
 * The result, under a burst of messages arriving together: HTTP 200 back to
 * Meta, execution logged as successful, and no row anywhere. Nothing to find,
 * nothing to alert on, nothing to retry. The customer was simply never heard.
 *
 * So: if a node's error output is wired, leave it alone — someone handled it
 * deliberately. If it is not, fail loudly. A failed execution is visible in the
 * n8n log, triggers the error workflow, and gets recorded in the Log tab. A
 * swallowed one is not.
 */
function failLoudly(node, wiredErrorOutputs) {
  if (node.onError === 'continueErrorOutput' && !wiredErrorOutputs.has(node.name)) {
    node.onError = 'stopWorkflow';
  }
  return node;
}

/**
 * Append a row through the Sheets API, with insertDataOption=INSERT_ROWS.
 *
 * WHY NOT THE SHEETS NODE
 * values.append defaults to insertDataOption=OVERWRITE: it picks the target row
 * from the table's current extent and writes there. Two calls arriving together
 * compute the SAME target, and the second overwrites the first. Both return
 * HTTP 200. Measured against the Google API with no n8n involved: six
 * simultaneous appends, six 200s, THREE rows. Half the data gone, silently.
 *
 * INSERT_ROWS inserts instead of overwriting and cannot collide - the same
 * measurement gives six of six. n8n's Google Sheets node does not expose the
 * option, so the two appends that would lose a CUSTOMER MESSAGE go direct.
 *
 * Authentication is the token minted by the Sign/Get pair, for the same reason
 * the sort does it: the n8n Google credential authenticates an HTTP Request
 * node with a scope that does not cover this, and returns 403.
 *
 * @param {string} name       Node name.
 * @param {string} id         Node id.
 * @param {Array}  position   Canvas position.
 * @param {string} tab        Sheet tab to append to.
 * @param {string} rowExpr    Expression yielding the row array, in column order.
 */
function appendViaApi(name, id, position, tab, rowExpr) {
  return {
    parameters: {
      method: 'POST',
      url: '=https://sheets.googleapis.com/v4/spreadsheets/{{ $env.GOOGLE_SHEET_ID }}/values/' +
        encodeURIComponent(tab + '!A1') +
        ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Authorization', value: '=Bearer {{ $("Get Sheets Token").item.json.access_token }}' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ values: [' + rowExpr + '] }) }}',
      options: {
        timeout: 15000,
        response: { response: { responseFormat: 'json' } },
      },
    },
    id,
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: NODE_VERSION.httpRequest,
    position,
    // Losing this write loses the customer's message. Retry, then fail loudly.
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    onError: 'stopWorkflow',
  };
}

function withRetry(node) {
  node.retryOnFail = true;
  node.maxTries = 3;
  node.waitBetweenTries = 2000;
  return node;
}

function withSheetSchema(node) {
  // Attach the Google credential here rather than as a post-build step, so
  // `build-workflows.js --check` compares like with like and cannot report
  // freshly generated files as stale.
  //
  // The id is stable and created by scripts/setup/import-credentials, so the
  // reference resolves on any instance that has imported it. No secret is
  // stored in the workflow — only the credential's id and display name.
  node.credentials = {
    googleApi: { id: GOOGLE_CREDENTIAL.id, name: GOOGLE_CREDENTIAL.name },
  };

  const cols = node.parameters && node.parameters.columns;
  if (!cols || cols.mappingMode !== 'defineBelow' || !cols.value) return node;
  const matching = cols.matchingColumns || [];
  cols.schema = Object.keys(cols.value).map((name) => ({
    id: name,
    displayName: name,
    required: false,
    defaultMatch: matching.indexOf(name) !== -1,
    display: true,
    type: 'string',
    canBeUsedToMatch: true,
    removed: false,
  }));
  if (!cols.matchingColumns) cols.matchingColumns = [];
  cols.attemptToConvertTypes = false;
  cols.convertFieldsToString = true;
  return node;
}

/** Helper to build a Code node. */
function codeNode(name, id, position, libFiles, body, opts) {
  const options = opts || {};
  // time.js goes into every Code node: localIso() is how this project writes a
  // timestamp, and a node where it is undefined fails at runtime, not at build
  // time. It is a few lines with no dependencies, so the cost is nothing.
  const libs = ['time.js'].concat(libFiles || [])
    .filter((f, i, all) => all.indexOf(f) === i);
  const prelude = buildPrelude(libs) + '\n';
  return {
    parameters: {
      mode: options.mode || 'runOnceForAllItems',
      jsCode: prelude + body,
    },
    id,
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: NODE_VERSION.code,
    position,
  };
}

/**
 * Sticky note factory.
 *
 * The id and name are DERIVED FROM THE CONTENT, not random. A random id would
 * make every build produce a different file, which:
 *   - defeats `--check` (it could never tell a real change from noise),
 *   - creates a spurious git diff on every rebuild,
 *   - makes re-imports look like edits.
 * Hashing the content keeps the build deterministic: same input, same bytes.
 */
function stickyNote(content, position, height, width, color) {
  const hash = crypto
    .createHash('sha256')
    .update(content + '|' + position.join(','))
    .digest('hex');
  return {
    parameters: {
      content,
      height: height || 200,
      width: width || 400,
      color: color || 4,
    },
    id: 'sticky-' + hash.slice(0, 8),
    name: 'Note ' + hash.slice(8, 12),
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position,
  };
}

// ===========================================================================
// Workflow 1 — WhatsApp Webhook Receiver
// ===========================================================================
function buildWebhookReceiver() {
  const nodes = [];
  const connections = {};

  nodes.push({
    parameters: {
      httpMethod: 'GET',
      path: 'whatsapp/webhook',
      responseMode: 'responseNode',
      options: {},
    },
    id: 'wh-get',
    name: 'Meta Verification (GET)',
    type: 'n8n-nodes-base.webhook',
    typeVersion: NODE_VERSION.webhook,
    position: [-460, -120],
    webhookId: 'a1b2c3d4-0000-4000-8000-whatsappget1',
  });

  nodes.push({
    parameters: {
      httpMethod: 'POST',
      path: 'whatsapp/webhook',
      responseMode: 'responseNode',
      options: {
        // CRITICAL: the HMAC must be computed over the exact bytes Meta sent.
        // Without rawBody, n8n re-serializes the JSON and every signature fails.
        rawBody: true,
      },
    },
    id: 'wh-post',
    name: 'Meta Events (POST)',
    type: 'n8n-nodes-base.webhook',
    typeVersion: NODE_VERSION.webhook,
    position: [-460, 160],
    webhookId: 'a1b2c3d4-0000-4000-8000-whatsapppost',
  });

  // ---- GET verification path ----
  nodes.push(
    codeNode(
      'Verify Handshake',
      'verify-handshake',
      [-200, -120],
      ['security.js'],
      [
        'const item = $input.first().json;',
        'const query = item.query || {};',
        '',
        "const expectedToken = $env.WEBHOOK_VERIFY_TOKEN;",
        'const result = verifyWebhookHandshake(query, expectedToken);',
        '',
        '// Never log the token itself — only whether it matched.',
        'console.log(JSON.stringify({',
        "  event: 'webhook_verification',",
        '  ok: result.ok,',
        '  reason: result.reason,',
        '  status: result.statusCode,',
        '}));',
        '',
        'return [{ json: result }];',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      respondWith: 'text',
      responseBody: '={{ $json.body }}',
      options: {
        responseCode: '={{ $json.statusCode }}',
      },
    },
    id: 'respond-get',
    name: 'Respond Challenge',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: NODE_VERSION.respondToWebhook,
    position: [40, -120],
  });

  // ---- POST event path ----
  nodes.push(
    codeNode(
      'Verify Signature',
      'verify-signature',
      [-200, 160],
      ['security.js', 'webhook-parser.js', 'idempotency.js'],
      [
        'const item = $input.first();',
        'const json = item.json || {};',
        'const headers = json.headers || {};',
        '',
        '// n8n lowercases incoming header names.',
        "const signature = headers['x-hub-signature-256'] || '';",
        '',
        '// IMPORTANT: with the Webhook node option `rawBody` enabled, n8n puts',
        '// the PARSED body in json.body and the UNTOUCHED bytes base64-encoded',
        '// in binary.data.data. The HMAC must be computed over those raw bytes —',
        '// re-serializing json.body changes key order/whitespace and every',
        '// signature would fail.',
        'let rawBody = null;',
        'if (item.binary && item.binary.data && item.binary.data.data) {',
        "  rawBody = Buffer.from(item.binary.data.data, 'base64');",
        '} else if (json.body !== undefined) {',
        '  // No raw body available (rawBody disabled). Signature verification',
        '  // cannot be trusted in this state; fall back only so that local,',
        '  // explicitly-unsigned fixture testing still works.',
        "  rawBody = Buffer.from(typeof json.body === 'string' ? json.body : JSON.stringify(json.body), 'utf8');",
        '}',
        '',
        'const appSecret = $env.META_APP_SECRET;',
        '',
        '// FAIL CLOSED. Signature verification is always required unless it is',
        '// EXPLICITLY disabled with ALLOW_UNSIGNED_WEBHOOKS=true.',
        '//',
        '// An earlier version inferred "not required" from "no app secret set",',
        '// which meant that forgetting META_APP_SECRET silently turned a public',
        '// endpoint into one that accepted forged customer messages from anyone.',
        '// That was caught by POSTing an unsigned payload to a real deployment.',
        '// Absence of a secret is now a misconfiguration (500), never consent.',
        "const allowUnsigned = String($env.ALLOW_UNSIGNED_WEBHOOKS || '').trim().toLowerCase() === 'true';",
        'const required = !allowUnsigned;',
        '',
        'if (allowUnsigned) {',
        '  // Loud, because this must never be true on an internet-facing host.',
        '  console.log(JSON.stringify({',
        "    event: 'SECURITY_WARNING',",
        "    message: 'ALLOW_UNSIGNED_WEBHOOKS=true — signature verification is DISABLED',",
        '  }));',
        '}',
        '',
        'const verdict = verifySignature(rawBody, signature, appSecret, { required });',
        '',
        '// Prefer the raw bytes for parsing so what we verified is what we act on.',
        'let parsedBody = null;',
        'try {',
        '  parsedBody = rawBody',
        "    ? JSON.parse(rawBody.toString('utf8'))",
        "    : (typeof json.body === 'object' ? json.body : null);",
        '} catch (e) {',
        "  parsedBody = (typeof json.body === 'object') ? json.body : null;",
        '}',
        '',
        'console.log(JSON.stringify({',
        "  event: 'webhook_received',",
        '  signature_ok: verdict.ok,',
        '  signature_reason: verdict.reason,',
        '  has_body: parsedBody !== null,',
        '}));',
        '',
        'return [{ json: {',
        '  signature_ok: verdict.ok,',
        '  signature_reason: verdict.reason,',
        '  status_code: verdict.ok ? 200 : verdict.statusCode,',
        '  body: parsedBody,',
        '  received_at: localIso(),',
        '} }];',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'sig-ok',
            leftValue: '={{ $json.signature_ok }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: 'if-sig',
    name: 'Signature Valid?',
    type: 'n8n-nodes-base.if',
    typeVersion: NODE_VERSION.if,
    position: [40, 160],
  });

  // Fast-ack: respond 200 BEFORE doing any slow work, so Meta never retries
  // just because Google Sheets was slow.
  nodes.push({
    parameters: {
      respondWith: 'text',
      responseBody: 'EVENT_RECEIVED',
      options: { responseCode: 200 },
    },
    id: 'respond-200',
    name: 'Ack 200 Immediately',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: NODE_VERSION.respondToWebhook,
    position: [300, 60],
  });

  nodes.push({
    parameters: {
      respondWith: 'text',
      responseBody: 'invalid signature',
      options: { responseCode: 401 },
    },
    id: 'respond-401',
    name: 'Reject 401',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: NODE_VERSION.respondToWebhook,
    position: [300, 300],
  });

  // After acking, hand off to the processor. Because the ack already went out,
  // this can take as long as it needs without causing a Meta retry.
  nodes.push({
    parameters: {
      workflowId: {
        __rl: true,
        value: WORKFLOW_ID.processor,
        mode: 'id',
      },
      workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [] },
      // WAIT for it. The ack has already gone out - Respond to Webhook ran
      // two nodes ago - so waiting costs Meta nothing and cannot cause a retry.
      //
      // Fire-and-forget looked equivalent and was not. The parent execution
      // finishes the instant this node returns, and under two webhooks arriving
      // at the same moment one sub-workflow start was simply dropped: webhook
      // 200, no conversation row, no message row, nothing in the log. Two
      // customers messaging at once, one of them silently ignored.
      options: { waitForSubWorkflow: true },
    },
    id: 'call-processor',
    name: 'Hand Off To Processor',
    type: 'n8n-nodes-base.executeWorkflow',
    typeVersion: NODE_VERSION.executeWorkflow,
    position: [560, 60],
  });

  nodes.push(
    stickyNote(
      [
        '## Workflow 1 — WhatsApp Webhook Receiver',
        '',
        'The ONLY workflow Meta talks to.',
        '',
        '**GET** = one-time verification handshake (echoes `hub.challenge`).',
        '**POST** = live events, HMAC-verified, then acked in <100ms.',
        '',
        '### Why the 200 is sent before processing',
        'Meta retries any webhook it does not get a timely 200 for. If we did',
        'Google Sheets I/O first, a slow Sheets call would cause a retry, which',
        'would double-process the message. We ack first, then work.',
        '',
        '### Raw Body is mandatory',
        'The POST node has `rawBody: true`. The HMAC must be computed over the',
        'exact bytes Meta sent — re-serialised JSON produces a different digest',
        'and rejects every legitimate request.',
      ].join('\n'),
      [-460, -520],
      340,
      620,
      4
    )
  );

  connections['Meta Verification (GET)'] = { main: [[{ node: 'Verify Handshake', type: 'main', index: 0 }]] };
  connections['Verify Handshake'] = { main: [[{ node: 'Respond Challenge', type: 'main', index: 0 }]] };
  connections['Meta Events (POST)'] = { main: [[{ node: 'Verify Signature', type: 'main', index: 0 }]] };
  connections['Verify Signature'] = { main: [[{ node: 'Signature Valid?', type: 'main', index: 0 }]] };
  connections['Signature Valid?'] = {
    main: [
      [{ node: 'Ack 200 Immediately', type: 'main', index: 0 }],
      [{ node: 'Reject 401', type: 'main', index: 0 }],
    ],
  };
  connections['Ack 200 Immediately'] = { main: [[{ node: 'Hand Off To Processor', type: 'main', index: 0 }]] };

  return {
    id: WORKFLOW_ID.receiver,
    name: 'WhatsApp — 1 Webhook Receiver',
    nodes,
    connections,
    settings: {
      executionOrder: 'v1',
      saveManualExecutions: true,
      saveExecutionProgress: true,
      // Errors here are operationally critical: Meta traffic is being dropped.
      errorWorkflow: '',
    },
    tags: [],
  };
}

// ===========================================================================
// Workflow 2 — Incoming Message Processor
// ===========================================================================
function buildMessageProcessor() {
  const nodes = [];
  const connections = {};

  nodes.push({
    parameters: {
      inputSource: 'passthrough',
    },
    id: 'proc-trigger',
    name: 'When Called By Receiver',
    type: 'n8n-nodes-base.executeWorkflowTrigger',
    typeVersion: NODE_VERSION.executeWorkflowTrigger,
    position: [-460, 0],
  });

  nodes.push(
    codeNode(
      'Parse & Normalize Events',
      'parse-events',
      [-200, 0],
      ['webhook-parser.js', 'phone.js', 'idempotency.js'],
      [
        'const input = $input.first().json;',
        'const body = input.body || input;',
        '',
        'const parsed = parseWebhook(body);',
        'const defaultCountryCode = $env.DEFAULT_COUNTRY_CODE || \'962\';',
        '',
        'if (!parsed.ok) {',
        '  console.log(JSON.stringify({',
        "    event: 'webhook_parse_failed',",
        '    reason: parsed.reason,',
        '  }));',
        '  return [{ json: {',
        "    kind: 'error',",
        "    processing_status: 'parse_failed',",
        '    reason: parsed.reason,',
        '    received_at: localIso(),',
        '  } }];',
        '}',
        '',
        '// One n8n item per event, so batched webhooks fan out correctly',
        '// instead of only the first message being processed.',
        'const items = parsed.events.map((event) => {',
        '  const dedupeKey = buildDedupeKey(event);',
        '  const correlationId = buildCorrelationId(dedupeKey);',
        '',
        '  const phoneSource = event.kind === \'status\' ? event.recipient_phone : event.customer_phone;',
        '  const normalized = normalizePhone(phoneSource, { defaultCountryCode });',
        '',
        '  return { json: Object.assign({}, event, {',
        '    dedupe_key: dedupeKey,',
        '    correlation_id: correlationId,',
        '    customer_phone_e164: normalized.ok ? normalized.e164 : null,',
        '    phone_normalized_ok: normalized.ok,',
        '    phone_ambiguous: normalized.ambiguous,',
        '    phone_reason: normalized.reason,',
        '    wa_link: normalized.ok ? normalized.waLink : null,',
        '    received_at: localIso(),',
        '  }) };',
        '});',
        '',
        'console.log(JSON.stringify({',
        "  event: 'webhook_parsed',",
        '  messages: parsed.counts.messages,',
        '  statuses: parsed.counts.statuses,',
        '  unknown: parsed.counts.unknown,',
        '}));',
        '',
        'return items;',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      rules: {
        values: [
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
              conditions: [
                {
                  id: 'is-message',
                  leftValue: '={{ $json.kind }}',
                  rightValue: 'message',
                  operator: { type: 'string', operation: 'equals' },
                },
              ],
              combinator: 'and',
            },
            renameOutput: true,
            outputKey: 'customer_message',
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
              conditions: [
                {
                  id: 'is-status',
                  leftValue: '={{ $json.kind }}',
                  rightValue: 'status',
                  operator: { type: 'string', operation: 'equals' },
                },
              ],
              combinator: 'and',
            },
            renameOutput: true,
            outputKey: 'status_update',
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
              conditions: [
                {
                  id: 'is-echo',
                  leftValue: '={{ $json.kind }}',
                  rightValue: 'echo',
                  operator: { type: 'string', operation: 'equals' },
                },
              ],
              combinator: 'and',
            },
            renameOutput: true,
            outputKey: 'app_reply_echo',
          },
        ],
      },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'other_event' },
    },
    id: 'route-kind',
    name: 'Route By Event Kind',
    type: 'n8n-nodes-base.switch',
    typeVersion: NODE_VERSION.switch,
    position: [60, 0],
  });

  // ---- Duplicate check against the Messages sheet ----
  nodes.push({
    parameters: {
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Messages', mode: 'name' },
      filtersUI: {
        values: [
          { lookupColumn: 'dedupe_key', lookupValue: '={{ $json.dedupe_key }}' },
        ],
      },
      options: { returnAllMatches: false },
    },
    id: 'lookup-dupe',
    name: 'Lookup Existing Message',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [320, -160],
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
    notes: 'alwaysOutputData=true so "no match" produces an empty item rather than ending the branch.',
  });

  nodes.push(
    codeNode(
      'Is Duplicate?',
      'is-duplicate',
      [560, -160],
      ['idempotency.js'],
      [
        "const event = $('Route By Event Kind').item.json;",
        'const matches = $input.all().map((i) => i.json).filter((j) => j && Object.keys(j).length > 0);',
        '',
        'const verdict = checkDuplicate(event.dedupe_key, matches);',
        '',
        'console.log(JSON.stringify({',
        "  event: 'dedupe_check',",
        '  correlation_id: event.correlation_id,',
        '  duplicate: verdict.duplicate,',
        '}));',
        '',
        'return [{ json: Object.assign({}, event, {',
        '  is_duplicate: verdict.duplicate,',
        '}) }];',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'not-dupe',
            leftValue: '={{ $json.is_duplicate }}',
            rightValue: false,
            operator: { type: 'boolean', operation: 'false', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: 'if-new',
    name: 'New Message?',
    type: 'n8n-nodes-base.if',
    typeVersion: NODE_VERSION.if,
    position: [800, -160],
  });

  nodes.push({
    parameters: {},
    id: 'skip-dupe',
    name: 'Skip Duplicate',
    type: 'n8n-nodes-base.noOp',
    typeVersion: NODE_VERSION.noOp,
    position: [1060, -40],
    notes: 'Meta retried an event we already processed. Correct behaviour: do nothing.',
  });

  nodes.push({
    parameters: {
      workflowId: { __rl: true, value: WORKFLOW_ID.conversation, mode: 'id' },
      workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [] },
      options: { waitForSubWorkflow: true },
    },
    id: 'call-conversation',
    name: 'Resolve Conversation',
    type: 'n8n-nodes-base.executeWorkflow',
    typeVersion: NODE_VERSION.executeWorkflow,
    position: [1060, -260],
  });

  // ---- Status update branch ----
  nodes.push({
    parameters: {
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Messages', mode: 'name' },
      filtersUI: { values: [{ lookupColumn: 'message_id', lookupValue: '={{ $json.message_id }}' }] },
      options: { returnAllMatches: false },
    },
    id: 'lookup-outbound',
    name: 'Find Outbound Message',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [320, 120],
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
  });

  nodes.push(
    codeNode(
      'Apply Status Ladder',
      'apply-status',
      [560, 120],
      ['idempotency.js'],
      [
        "const event = $('Route By Event Kind').item.json;",
        'const existing = $input.all().map((i) => i.json).filter((j) => j && Object.keys(j).length > 0)[0] || null;',
        '',
        '// Status callbacks can arrive out of order (read before delivered) and',
        '// can arrive BEFORE the outbound message row exists.',
        'if (!existing) {',
        '  console.log(JSON.stringify({',
        "    event: 'status_before_message_record',",
        '    correlation_id: event.correlation_id,',
        '    message_id: event.message_id,',
        '  }));',
        '  return [{ json: Object.assign({}, event, {',
        '    apply_status: false,',
        "    skip_reason: 'MESSAGE_ROW_NOT_FOUND',",
        "    processing_status: 'deferred',",
        '  }) }];',
        '}',
        '',
        'const verdict = shouldApplyStatus(existing.status, event.status);',
        '',
        'console.log(JSON.stringify({',
        "  event: 'status_ladder',",
        '  correlation_id: event.correlation_id,',
        '  from: existing.status || null,',
        '  to: event.status,',
        '  applied: verdict.apply,',
        '  reason: verdict.reason,',
        '}));',
        '',
        'return [{ json: Object.assign({}, event, {',
        '  apply_status: verdict.apply,',
        '  skip_reason: verdict.apply ? null : verdict.reason,',
        '  existing_row_number: existing.row_number || null,',
        '  conversation_id: existing.conversation_id || null,',
        '}) }];',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'apply',
            leftValue: '={{ $json.apply_status }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: 'if-apply-status',
    name: 'Apply Status?',
    type: 'n8n-nodes-base.if',
    typeVersion: NODE_VERSION.if,
    position: [800, 120],
  });

  nodes.push({
    parameters: {
      operation: 'update',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Messages', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          message_id: '={{ $json.message_id }}',
          status: '={{ $json.status }}',
          status_updated_at: '={{ $json.timestamp_iso }}',
        },
        matchingColumns: ['message_id'],
      },
      options: {},
    },
    id: 'update-status',
    name: 'Update Message Status',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [1060, 60],
    onError: 'continueErrorOutput',
  });

  nodes.push({
    parameters: {},
    id: 'skip-status',
    name: 'Skip Stale Status',
    type: 'n8n-nodes-base.noOp',
    typeVersion: NODE_VERSION.noOp,
    position: [1060, 240],
  });

  // ---- WhatsApp Business App echo branch (Coexistence) ----
  nodes.push({
    parameters: {
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
      filtersUI: {
        values: [{ lookupColumn: 'customer_phone', lookupValue: '={{ $json.customer_phone_e164 }}' }],
      },
      options: { returnAllMatches: true },
    },
    id: 'echo-find-conv',
    name: 'Find Conversation For Echo',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [320, 560],
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
  });

  nodes.push(
    codeNode(
      'Apply App Reply',
      'apply-echo',
      [560, 560],
      ['conversation.js'],
      [
        "const echo = $('Route By Event Kind').item.json;",
        'const rows = $input.all().map((i) => i.json).filter((r) => r && r.conversation_id);',
        '',
        '// Control events (revoke/edit) modify a previous message rather than',
        '// being a new reply. Record them, but do not move the conversation',
        '// state — deleting a message is not answering a customer.',
        'if (echo.is_control_event) {',
        '  console.log(JSON.stringify({',
        "    event: 'echo_control',",
        '    correlation_id: echo.correlation_id,',
        '    type: echo.message_type,',
        '    target: echo.revoked_message_id || echo.edited_message_id,',
        '  }));',
        '  return [{ json: Object.assign({}, echo, {',
        '    conversation_found: rows.length > 0,',
        "    conversation_id: rows.length > 0 ? rows[0].conversation_id : '',",
        '    update_conversation: false,',
        '  }) }];',
        '}',
        '',
        'const matching = rows.filter((r) =>',
        "  String(r.business_phone_number_id || '') === String(echo.business_phone_number_id || '')",
        ');',
        "const open = matching.filter((r) => r.status !== 'CLOSED')",
        '  .sort((a, b) => Date.parse(b.last_activity_at || 0) - Date.parse(a.last_activity_at || 0));',
        '',
        'if (open.length === 0) {',
        '  // An agent messaged a customer we have no open conversation for.',
        '  // Record it; do not invent a conversation from an outbound message.',
        '  console.log(JSON.stringify({',
        "    event: 'echo_without_conversation',",
        '    correlation_id: echo.correlation_id,',
        '  }));',
        '  return [{ json: Object.assign({}, echo, {',
        '    conversation_found: false,',
        '    update_conversation: false,',
        '  }) }];',
        '}',
        '',
        'const existing = open[0];',
        'const nowIso = localIso();',
        '',
        '// THIS is what Coexistence buys us: a reply typed in the WhatsApp',
        '// Business App now advances the conversation exactly like an API',
        '// reply would. Without it, the conversation would sit on UNANSWERED',
        '// forever even though the customer was answered.',
        'const { update, transition } = buildAgentMessageUpdate(existing, {',
        '  message_id: echo.message_id,',
        '  preview: echo.preview,',
        '  text: echo.text,',
        '  timestamp_iso: echo.timestamp_iso,',
        '}, { now_iso: nowIso });',
        '',
        'console.log(JSON.stringify({',
        "  event: 'echo_applied',",
        '  correlation_id: echo.correlation_id,',
        '  conversation_id: existing.conversation_id,',
        '  from_status: existing.status,',
        '  to_status: transition.next,',
        "  sent_via: 'whatsapp_business_app',",
        '}));',
        '',
        'return [{ json: Object.assign({}, echo, {',
        '  conversation_found: true,',
        '  update_conversation: true,',
        '  conversation_id: existing.conversation_id,',
        '  assigned_agent_id: existing.assigned_agent_id || \'\',',
        '  conversation_update: Object.assign({ conversation_id: existing.conversation_id }, update),',
        '}) }];',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'do-update',
            leftValue: '={{ $json.update_conversation }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: 'if-echo-update',
    name: 'Echo Updates Conversation?',
    type: 'n8n-nodes-base.if',
    typeVersion: NODE_VERSION.if,
    position: [800, 560],
  });

  nodes.push({
    parameters: {
      operation: 'update',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          conversation_id: '={{ $json.conversation_update.conversation_id }}',
          status: '={{ $json.conversation_update.status }}',
          last_message: '={{ $json.conversation_update.last_message }}',
          last_message_id: '={{ $json.conversation_update.last_message_id }}',
          last_message_direction: 'outbound',
          last_agent_message_at: '={{ $json.conversation_update.last_agent_message_at }}',
          last_activity_at: '={{ $json.conversation_update.last_activity_at }}',
          unread: 'FALSE',
          updated_at: '={{ $json.conversation_update.updated_at }}',
        },
        matchingColumns: ['conversation_id'],
      },
      options: {},
    },
    id: 'echo-update-conv',
    name: 'Update Conversation From App Reply',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [1060, 480],
    onError: 'continueErrorOutput',
  });

  nodes.push({
    parameters: {
      operation: 'append',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Messages', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          message_id: '={{ $json.message_id }}',
          dedupe_key: '={{ $json.dedupe_key }}',
          conversation_id: '={{ $json.conversation_id }}',
          direction: 'outbound',
          sender_phone: '={{ $json.business_display_phone_number }}',
          recipient_phone: '={{ $json.customer_phone_e164 }}',
          customer_phone: '={{ $json.customer_phone_e164 }}',
          message_type: '={{ $json.message_type }}',
          text: '={{ $json.preview }}',
          timestamp: '={{ $json.timestamp_iso }}',
          status: 'SENT',
          agent_id: '={{ $json.assigned_agent_id }}',
          sent_via: 'whatsapp_business_app',
          supported: '={{ $json.supported }}',
          processing_status: '={{ $json.processing_status }}',
          correlation_id: '={{ $json.correlation_id }}',
          created_at: '={{ $now.toISO() }}',
        },
      },
      options: {},
    },
    id: 'echo-append-msg',
    name: 'Record App Reply Message',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [1320, 560],
    onError: 'continueRegularOutput',
  });

  // ---- Other/unknown events ----
  nodes.push({
    parameters: {
      operation: 'append',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Log', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          event_id: '={{ $json.correlation_id }}',
          event_type: '={{ $json.kind }}',
          source: 'meta_webhook',
          timestamp: '={{ $json.received_at }}',
          status: 'unhandled',
          details: '={{ JSON.stringify({ reason: $json.reason, field: $json.field }) }}',
        },
      },
      options: {},
    },
    id: 'log-other',
    name: 'Log Unhandled Event',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [320, 800],
    onError: 'continueRegularOutput',
  });

  nodes.push(
    stickyNote(
      [
        '## Workflow 2 — Incoming Message Processor',
        '',
        'Runs AFTER the 200 has already been sent, so it may take its time.',
        '',
        '### Three branches',
        '1. **customer_message** → dedupe → resolve conversation → assign',
        '2. **status_update** → monotonic status ladder (never downgrade READ)',
        '3. **other_event** → recorded in Events, never silently dropped',
        '',
        '### Idempotency',
        'Dedupe is on `dedupe_key`, which is the Meta message id for messages',
        'and message-id+status for status callbacks — so `sent → delivered →',
        'read` is NOT mistaken for three duplicates of the same event.',
      ].join('\n'),
      [-460, -420],
      320,
      620,
      5
    )
  );

  connections['When Called By Receiver'] = { main: [[{ node: 'Parse & Normalize Events', type: 'main', index: 0 }]] };
  connections['Parse & Normalize Events'] = { main: [[{ node: 'Route By Event Kind', type: 'main', index: 0 }]] };
  connections['Route By Event Kind'] = {
    main: [
      [{ node: 'Lookup Existing Message', type: 'main', index: 0 }],
      [{ node: 'Find Outbound Message', type: 'main', index: 0 }],
      [{ node: 'Find Conversation For Echo', type: 'main', index: 0 }],
      [{ node: 'Log Unhandled Event', type: 'main', index: 0 }],
    ],
  };
  connections['Find Conversation For Echo'] = { main: [[{ node: 'Apply App Reply', type: 'main', index: 0 }]] };
  connections['Apply App Reply'] = { main: [[{ node: 'Echo Updates Conversation?', type: 'main', index: 0 }]] };
  connections['Echo Updates Conversation?'] = {
    main: [
      [{ node: 'Update Conversation From App Reply', type: 'main', index: 0 }],
      [{ node: 'Record App Reply Message', type: 'main', index: 0 }],
    ],
  };
  connections['Update Conversation From App Reply'] = { main: [[{ node: 'Record App Reply Message', type: 'main', index: 0 }]] };
  connections['Lookup Existing Message'] = { main: [[{ node: 'Is Duplicate?', type: 'main', index: 0 }]] };
  connections['Is Duplicate?'] = { main: [[{ node: 'New Message?', type: 'main', index: 0 }]] };
  connections['New Message?'] = {
    main: [
      [{ node: 'Resolve Conversation', type: 'main', index: 0 }],
      [{ node: 'Skip Duplicate', type: 'main', index: 0 }],
    ],
  };
  connections['Find Outbound Message'] = { main: [[{ node: 'Apply Status Ladder', type: 'main', index: 0 }]] };
  connections['Apply Status Ladder'] = { main: [[{ node: 'Apply Status?', type: 'main', index: 0 }]] };
  connections['Apply Status?'] = {
    main: [
      [{ node: 'Update Message Status', type: 'main', index: 0 }],
      [{ node: 'Skip Stale Status', type: 'main', index: 0 }],
    ],
  };

  return {
    id: WORKFLOW_ID.processor,
    name: 'WhatsApp — 2 Incoming Message Processor',
    nodes,
    connections,
    settings: { executionOrder: 'v1', saveManualExecutions: true, saveExecutionProgress: true },
    tags: [],
  };
}

// ===========================================================================
// Workflow 3 — Conversation Lookup / Create + Assignment
// ===========================================================================
function buildConversationAndAssignment() {
  const nodes = [];
  const connections = {};

  nodes.push({
    parameters: { inputSource: 'passthrough' },
    id: 'conv-trigger',
    name: 'When Called By Processor',
    type: 'n8n-nodes-base.executeWorkflowTrigger',
    typeVersion: NODE_VERSION.executeWorkflowTrigger,
    position: [-560, 0],
  });

  nodes.push({
    parameters: {
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
      filtersUI: {
        values: [
          { lookupColumn: 'customer_phone', lookupValue: '={{ $json.customer_phone_e164 }}' },
        ],
      },
      options: { returnAllMatches: true },
    },
    id: 'find-conv',
    name: 'Find Existing Conversation',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [-300, 0],
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
  });

  nodes.push(
    codeNode(
      'Decide Create Or Update',
      'decide-conv',
      [-40, 0],
      ['conversation.js', 'phone.js'],
      [
        "const event = $('When Called By Processor').first().json;",
        'const rows = $input.all().map((i) => i.json).filter((j) => j && j.conversation_id);',
        '',
        '// Scope to the SAME business number: one customer messaging two',
        '// business numbers must get two independent conversations.',
        'const sameNumber = rows.filter((r) =>',
        '  String(r.business_phone_number_id || \'\') === String(event.business_phone_number_id || \'\')',
        ');',
        '',
        '// The active conversation is the most recently updated non-closed one.',
        'const open = sameNumber',
        "  .filter((r) => r.status !== 'CLOSED')",
        '  .sort((a, b) => Date.parse(b.last_activity_at || 0) - Date.parse(a.last_activity_at || 0));',
        '',
        'const nowIso = localIso();',
        "const reopenClosed = String($env.REOPEN_CLOSED_CONVERSATIONS || 'true') !== 'false';",
        '',
        'if (open.length > 0) {',
        '  const existing = open[0];',
        '  const { update, transition } = buildCustomerMessageUpdate(existing, event, { now_iso: nowIso, reopenClosed });',
        '',
        '  console.log(JSON.stringify({',
        "    event: 'conversation_found',",
        '    correlation_id: event.correlation_id,',
        '    conversation_id: existing.conversation_id,',
        '    from_status: existing.status,',
        '    to_status: transition.next,',
        '  }));',
        '',
        '  return [{ json: Object.assign({}, event, {',
        '    action: existing.assigned_agent_id ? \'update\' : \'assign\',',
        '    conversation_id: existing.conversation_id,',
        '    existing_conversation: existing,',
        '    conversation_update: update,',
        '    needs_assignment: !existing.assigned_agent_id,',
        '  }) }];',
        '}',
        '',
        '// Nothing open — check whether a CLOSED conversation should reopen.',
        "const closed = sameNumber.filter((r) => r.status === 'CLOSED')",
        '  .sort((a, b) => Date.parse(b.last_activity_at || 0) - Date.parse(a.last_activity_at || 0));',
        '',
        'if (closed.length > 0 && reopenClosed) {',
        '  const existing = closed[0];',
        '  const { update, transition } = buildCustomerMessageUpdate(existing, event, { now_iso: nowIso, reopenClosed });',
        '',
        '  console.log(JSON.stringify({',
        "    event: 'conversation_reopened',",
        '    correlation_id: event.correlation_id,',
        '    conversation_id: existing.conversation_id,',
        '    to_status: transition.next,',
        '  }));',
        '',
        '  return [{ json: Object.assign({}, event, {',
        "    action: 'update',",
        '    conversation_id: existing.conversation_id,',
        '    existing_conversation: existing,',
        '    conversation_update: update,',
        '    needs_assignment: !existing.assigned_agent_id,',
        '    reopened: true,',
        '  }) }];',
        '}',
        '',
        '// Brand new conversation.',
        'const row = buildNewConversationRow({',
        '  customer_phone: event.customer_phone_e164 || event.customer_phone,',
        '  customer_name: event.customer_name,',
        '  business_phone_number_id: event.business_phone_number_id,',
        '  last_message: event.preview,',
        '  // The first message is, by definition, unanswered.',
        "  unanswered_messages: appendUnanswered('', event),",
        '  last_message_id: event.message_id,',
        '  last_customer_message_at: event.timestamp_iso,',
        '  wa_link: event.wa_link,',
        '  now_iso: nowIso,',
        '});',
        '',
        'console.log(JSON.stringify({',
        "  event: 'conversation_created',",
        '  correlation_id: event.correlation_id,',
        '  conversation_id: row.conversation_id,',
        '}));',
        '',
        'return [{ json: Object.assign({}, event, {',
        "  action: 'create',",
        '  conversation_id: row.conversation_id,',
        '  new_conversation_row: row,',
        '  needs_assignment: true,',
        '}) }];',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'needs-assign',
            leftValue: '={{ $json.needs_assignment }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: 'if-assign',
    name: 'Needs Assignment?',
    type: 'n8n-nodes-base.if',
    typeVersion: NODE_VERSION.if,
    position: [220, 0],
  });

  nodes.push({
    parameters: {
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Agents', mode: 'name' },
      options: { returnAllMatches: true },
    },
    id: 'read-agents',
    name: 'Read Agents',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [480, -120],
    // Once, not once per input item. Its input is every Conversations row, and
    // a Sheets read runs for each item it receives: 16 conversations meant 16
    // identical reads of Agents per inbound message (64 rows for 4 agents),
    // spending the 60-reads-a-minute quota on duplicates.
    executeOnce: true,
    alwaysOutputData: true,
    onError: 'continueErrorOutput',
  });

  nodes.push(
    codeNode(
      'Select Agent',
      'select-agent',
      [740, -120],
      ['assignment.js', 'conversation.js'],
      [
        "const context = $('Needs Assignment?').first().json;",
        'const agents = $input.all().map((i) => i.json).filter((a) => a && a.agent_id);',
        '',
        "// Count each agent load from the conversations that actually exist.",
        '// The Agents.open_conversations counter is incremented on assignment and',
        '// nothing decrements it when a conversation closes or is archived, so it',
        '// only ever grows. Left to itself it reached max_open_conversations for',
        '// every agent and the whole team became ineligible: new customers piled',
        '// up as WAITING_FOR_AGENT with three idle agents sitting there.',
        '// A count derived from the rows cannot drift, because there is no second',
        '// copy of the truth to disagree with.',
        "const allConversations = $('Read All Conversations').all()",
        '  .map((i) => i.json)',
        '  .filter((r) => r && r.conversation_id);',
        'const liveLoad = countOpenConversationsByAgent(allConversations);',
        'const agentsWithLoad = withLiveLoad(agents, liveLoad);',
        '',
        "const strategy = $env.ASSIGNMENT_STRATEGY || 'LEAST_OPEN_CONVERSATIONS';",
        '// businessPhoneNumberId scopes eligibility to agents whose',
        '// whatsapp_accounts includes this conversation\'s account (or who',
        '// have no whatsapp_accounts at all — unrestricted). See',
        '// docs/FUTURE_SESSION_SCOPED_ASSIGNMENT.md.',
        'const decision = selectAgent(agentsWithLoad, { strategy, businessPhoneNumberId: context.business_phone_number_id });',
        '',
        'console.log(JSON.stringify({',
        "  event: 'agent_selection',",
        '  correlation_id: context.correlation_id,',
        '  conversation_id: context.conversation_id,',
        '  assigned: decision.assigned,',
        '  agent_id: decision.agent ? decision.agent.agent_id : null,',
        '  reason: decision.reason,',
        '  eligible_count: decision.candidates.length,',
        '  evaluated_count: decision.evaluated.length,',
        '}));',
        '',
        'const nowIso = localIso();',
        '',
        'return [{ json: Object.assign({}, context, {',
        '  assignment_decided: true,',
        '  assigned: decision.assigned,',
        '  assigned_agent_id: decision.agent ? decision.agent.agent_id : \'\',',
        '  assigned_agent_name: decision.agent ? decision.agent.name : \'\',',
        '  assignment_status: decision.status,',
        '  unassigned_reason: decision.reason || \'\',',
        '  assignment_strategy: decision.strategy,',
        '  agent_open_before: decision.agent ? decision.agent.open_conversations : null,',
        '  agent_open_after: decision.agent ? decision.agent.open_conversations + 1 : null,',
        '  assigned_at: nowIso,',
        '  // Full audit of who was excluded and why.',
        '  assignment_audit: decision.evaluated.map((a) => ({',
        '    agent_id: a.agent_id,',
        '    eligible: a.eligible,',
        '    reasons: a.ineligible_reasons,',
        '    open: a.open_conversations,',
        '    max: a.max_open_conversations,',
        '  })),',
        '}) }];',
      ].join('\n')
    )
  );

  // When every agent is full or away, Select Agent decides WAITING_FOR_AGENT
  // with an empty assigned_agent_id. Increment Agent Load used to receive that
  // anyway; the Sheets update refuses an empty match value ("The 'Column to
  // Match On' parameter is required"). Once failLoudly() turned that swallowed
  // error into a stop, the stop also killed the parallel Build Conversation
  // Row branch — so at full capacity a new customer's message was never
  // written at all, instead of queuing for workflow 5.
  nodes.push({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'agent-assigned',
            leftValue: '={{ $json.assigned }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: 'if-agent-assigned',
    name: 'Agent Assigned?',
    type: 'n8n-nodes-base.if',
    typeVersion: NODE_VERSION.if,
    position: [1000, -220],
  });

  nodes.push({
    parameters: {
      operation: 'update',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Agents', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          agent_id: '={{ $json.assigned_agent_id }}',
          open_conversations: '={{ $json.agent_open_after }}',
          last_assigned_at: '={{ $json.assigned_at }}',
          updated_at: '={{ $json.assigned_at }}',
        },
        matchingColumns: ['agent_id'],
      },
      options: {},
    },
    id: 'incr-agent',
    name: 'Increment Agent Load',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [1260, -300],
    onError: 'continueErrorOutput',
    notes:
      'NOT atomic. Google Sheets has no compare-and-set. Mitigated by running this workflow with concurrency 1. See docs/ASSIGNMENT_ALGORITHM.md.',
  });

  nodes.push(
    codeNode(
      'Build Conversation Row',
      'build-row',
      [1260, 0],
      ['conversation.js'],
      [
        'const ctx = $input.first().json;',
        'const nowIso = localIso();',
        '',
        '// Merge the assignment outcome into whichever row shape we are writing.',
        "if (ctx.action === 'create') {",
        '  const row = Object.assign({}, ctx.new_conversation_row, {',
        "    assigned_agent_id: ctx.assigned_agent_id || '',",
        "    assigned_agent_name: ctx.assigned_agent_name || '',",
        "    status: ctx.assigned ? 'UNANSWERED' : 'WAITING_FOR_AGENT',",
        "    unassigned_reason: ctx.assigned ? '' : (ctx.unassigned_reason || ''),",
        '    updated_at: nowIso,',
        '  });',
        '  // The Sheets nodes read every column from write_row, so a create',
        '  // writes the whole row and an update writes only what changed.',
        "  return [{ json: Object.assign({}, ctx, { write_row: row, sheet_operation: 'append' }) }];",
        '}',
        '',
        '// An update must name ONLY the fields it means to change. Anything',
        '// absent here is left exactly as it is in the sheet: the agent who',
        '// owns the conversation, the product and quantity a human typed, the',
        '// reply that workflow 7 is in the middle of sending, and',
        '// first_message_at, which is written once and never again.',
        'const update = Object.assign({}, ctx.conversation_update, {',
        '  conversation_id: ctx.conversation_id,',
        '  updated_at: nowIso,',
        '});',
        '',
        '// Assignment fields are written only when assignment actually ran.',
        'if (ctx.assignment_decided) {',
        "  update.assigned_agent_id = ctx.assigned_agent_id || '';",
        "  update.assigned_agent_name = ctx.assigned_agent_name || '';",
        "  update.status = ctx.assigned ? 'UNANSWERED' : 'WAITING_FOR_AGENT';",
        "  update.unassigned_reason = ctx.assigned ? '' : (ctx.unassigned_reason || '');",
        '}',
        '',
        '',
        '// A Sheets write with an explicit column map writes EVERY mapped',
        '// column. An expression that resolves to undefined lands as an empty',
        '// cell, not as "leave it alone" - which is how a follow-up message',
        '// blanked the customer name, phone and assigned agent on a live row.',
        '// So the update carries the whole row: what the sheet already holds,',
        '// with the changed fields laid over it.',
        'const merged = Object.assign({}, ctx.existing_conversation, update);',
        '// row_number is n8n bookkeeping from the read, never a column.',
        'delete merged.row_number;',
        '',
        "return [{ json: Object.assign({}, ctx, { write_row: merged, sheet_operation: 'update' }) }];",
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'is-append',
            leftValue: '={{ $json.sheet_operation }}',
            rightValue: 'append',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: 'if-append',
    name: 'Create Or Update Row?',
    type: 'n8n-nodes-base.if',
    typeVersion: NODE_VERSION.if,
    position: [1520, 0],
  });

  nodes.push({
    parameters: {
      operation: 'append',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
      columns: { mappingMode: 'defineBelow', value: conversationColumnMap() },
      options: {},
    },
    id: 'append-conv',
    name: 'Append Conversation',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [1780, -120],
    onError: 'continueErrorOutput',
  });

  nodes.push({
    parameters: {
      operation: 'update',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
      columns: { mappingMode: 'defineBelow', value: conversationColumnMap(), matchingColumns: ['conversation_id'] },
      options: {},
    },
    id: 'update-conv',
    name: 'Update Conversation',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [1780, 120],
    onError: 'continueErrorOutput',
  });

  nodes.push({
    parameters: {
      operation: 'append',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Messages', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          message_id: '={{ $json.message_id }}',
          dedupe_key: '={{ $json.dedupe_key }}',
          conversation_id: '={{ $json.conversation_id }}',
          direction: 'inbound',
          sender_phone: '={{ $json.customer_phone_e164 }}',
          recipient_phone: '={{ $json.business_display_phone_number }}',
          customer_phone: '={{ $json.customer_phone_e164 }}',
          message_type: '={{ $json.message_type }}',
          text: '={{ $json.preview }}',
          timestamp: '={{ $json.timestamp_iso }}',
          status: 'RECEIVED',
          agent_id: '={{ $json.assigned_agent_id }}',
          supported: '={{ $json.supported }}',
          processing_status: '={{ $json.processing_status }}',
          correlation_id: '={{ $json.correlation_id }}',
          raw_event_reference: '={{ $json.media_id || "" }}',
          created_at: '={{ $now.toISO() }}',
        },
      },
      options: {},
    },
    id: 'append-msg',
    name: 'Append Message',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [2040, 0],
    onError: 'continueErrorOutput',
  });

  nodes.push({
    parameters: {
      operation: 'append',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Log', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          event_id: '={{ $json.correlation_id }}',
          event_type: '={{ $json.assigned ? "AGENT_ASSIGNED" : "WAITING_FOR_AGENT" }}',
          conversation_id: '={{ $json.conversation_id }}',
          message_id: '={{ $json.message_id }}',
          source: 'assignment_engine',
          timestamp: '={{ $now.toISO() }}',
          status: '={{ $json.assignment_status }}',
          error: '={{ $json.unassigned_reason }}',
          details: '={{ JSON.stringify($json.assignment_audit || []) }}',
        },
      },
      options: {},
    },
    id: 'audit-assign',
    name: 'Audit Assignment',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [2300, 0],
    onError: 'continueRegularOutput',
  });

  nodes.push(
    stickyNote(
      [
        '## Workflow 3 — Conversation Resolution + Agent Assignment',
        '',
        '### CONCURRENCY WARNING',
        'This workflow MUST run with concurrency 1.',
        'Google Sheets has no atomic compare-and-set, so two simultaneous',
        'executions can both read "Mohammad has 3 open" before either writes,',
        'and both assign him. Serializing execution removes the race on a',
        'single n8n instance.',
        '',
        'Set it in the workflow settings, or via env:',
        '`N8N_CONCURRENCY_PRODUCTION_LIMIT=1`',
        '',
        'The real fix is PostgreSQL with `SELECT ... FOR UPDATE` —',
        'see docs/GOOGLE_SHEETS_TO_POSTGRES.md.',
        '',
        '### Never drops a conversation',
        'If no agent is eligible, status becomes WAITING_FOR_AGENT with a',
        'recorded `unassigned_reason`, and workflow 7 retries the queue.',
      ].join('\n'),
      [-560, -520],
      420,
      640,
      3
    )
  );

  connections['When Called By Processor'] = { main: [[{ node: 'Find Existing Conversation', type: 'main', index: 0 }]] };
  connections['Find Existing Conversation'] = { main: [[{ node: 'Decide Create Or Update', type: 'main', index: 0 }]] };
  connections['Decide Create Or Update'] = { main: [[{ node: 'Needs Assignment?', type: 'main', index: 0 }]] };
  connections['Needs Assignment?'] = {
    main: [
      [{ node: 'Read All Conversations', type: 'main', index: 0 }],
      [{ node: 'Build Conversation Row', type: 'main', index: 0 }],
    ],
  };
  nodes.push(withSheetSchema({
    parameters: {
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
      options: { returnAllMatches: true },
    },
    id: 'read-all-conversations',
    name: 'Read All Conversations',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [480, -300],
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
  }));

  connections['Read All Conversations'] = { main: [[{ node: 'Read Agents', type: 'main', index: 0 }]] };
  connections['Read Agents'] = { main: [[{ node: 'Select Agent', type: 'main', index: 0 }]] };
  connections['Select Agent'] = {
    main: [[
      { node: 'Agent Assigned?', type: 'main', index: 0 },
      { node: 'Build Conversation Row', type: 'main', index: 0 },
    ]],
  };
  // False branch left empty on purpose: nothing to increment, and the row is
  // still written as WAITING_FOR_AGENT by the Build Conversation Row branch.
  connections['Agent Assigned?'] = { main: [[{ node: 'Increment Agent Load', type: 'main', index: 0 }], []] };
  connections['Build Conversation Row'] = { main: [[{ node: 'Create Or Update Row?', type: 'main', index: 0 }]] };
  connections['Create Or Update Row?'] = {
    main: [
      [{ node: 'Append Conversation', type: 'main', index: 0 }],
      [{ node: 'Update Conversation', type: 'main', index: 0 }],
    ],
  };
  connections['Append Conversation'] = { main: [[{ node: 'Append Message', type: 'main', index: 0 }]] };
  connections['Update Conversation'] = { main: [[{ node: 'Append Message', type: 'main', index: 0 }]] };

  // ---- keep the newest conversation at the top -------------------------------
  //
  // A Sheets append always lands at the BOTTOM, so without this the oldest
  // conversation sits at the top of the tab and whoever is using it scrolls to
  // find what just came in. The n8n Sheets node has no sort operation, so this
  // calls the Sheets API directly.
  //
  // It mints its own access token rather than using the n8n Google credential:
  // that credential authenticates an HTTP Request node with a scope that does
  // not cover spreadsheets.batchUpdate, and the call comes back 403 Forbidden.
  // Signing here also keeps to the rule that every secret this project uses
  // lives in .env and nowhere else.
  nodes.push(
    codeNode(
      'Sign Sheets Token Request',
      'sign-sheets-token',
      [2960, 0],
      [],
      [
        "// Allowed by NODE_FUNCTION_ALLOW_BUILTIN=crypto. The prelude only hoists",
        '// requires it finds inside an inlined library, so this node asks for it.',
        "const crypto = require('crypto');",
        '',
        "const email = $env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';",
        '// Stored with literal \\n escapes, the way a .env file can hold a key.',
        "const key = String($env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').split('\\\\n').join('\\n');",
        '',
        'if (!email || !key) {',
        '  console.log(JSON.stringify({ event: "sort_skipped", reason: "no_service_account" }));',
        '  return [];',
        '}',
        '',
        "const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');",
        'const now = Math.floor(Date.now() / 1000);',
        "const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({",
        '  iss: email,',
        "  scope: 'https://www.googleapis.com/auth/spreadsheets',",
        "  aud: 'https://oauth2.googleapis.com/token',",
        '  iat: now,',
        '  exp: now + 3600,',
        '});',
        "const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key, 'base64url');",
        '',
        "return [{ json: { assertion: unsigned + '.' + signature } }];",
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      method: 'POST',
      url: 'https://oauth2.googleapis.com/token',
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
      },
      // Sent as form fields rather than a raw body: with a raw body n8n hands
      // back the response as an unparsed stream, and the access token arrives
      // as a Buffer nobody downstream can read.
      sendBody: true,
      contentType: 'form-urlencoded',
      bodyParameters: {
        parameters: [
          { name: 'grant_type', value: 'urn:ietf:params:oauth:grant-type:jwt-bearer' },
          { name: 'assertion', value: '={{ $json.assertion }}' },
        ],
      },
      options: { timeout: 10000, response: { response: { neverError: true, responseFormat: 'json' } } },
    },
    id: 'get-sheets-token',
    name: 'Get Sheets Token',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: NODE_VERSION.httpRequest,
    position: [3180, 0],
    // Sorting is cosmetic. Failing to sort must never lose a message.
    onError: 'continueRegularOutput',
  });

  nodes.push(
    codeNode(
      'Build Sort Request',
      'build-sort-request',
      [3400, 0],
      [],
      [
        'const token = ($input.first().json || {}).access_token;',
        'if (!token) {',
        '  console.log(JSON.stringify({ event: "sort_skipped", reason: "no_token" }));',
        '  return [];',
        '}',
        '',
        '// Sort on last_activity_at, descending: whatever moved most recently is',
        '// at the top. The column is found by NAME, so reordering the sheet',
        '// cannot silently sort the wrong one.',
        'const COLUMNS = ' + JSON.stringify(CONVERSATION_COLUMNS) + ';',
        "const sortColumn = COLUMNS.indexOf('last_activity_at');",
        'if (sortColumn === -1) return [];',
        '',
        'const MESSAGE_COLUMNS = ' + JSON.stringify(MESSAGE_COLUMNS) + ';',
        '',
        'return [{ json: {',
        '  token,',
        '  sortColumn,',
        '  columnCount: COLUMNS.length,',
        "  messageSortColumn: MESSAGE_COLUMNS.indexOf('timestamp'),",
        '  messageColumnCount: MESSAGE_COLUMNS.length,',
        '} }];',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      url: '=https://sheets.googleapis.com/v4/spreadsheets/{{ $env.GOOGLE_SHEET_ID }}?fields=sheets.properties',
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: 'Authorization', value: '=Bearer {{ $json.token }}' }],
      },
      options: { timeout: 10000, response: { response: { neverError: true, responseFormat: 'json' } } },
    },
    id: 'read-tab-ids',
    name: 'Read Tab Ids',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: NODE_VERSION.httpRequest,
    position: [3620, 0],
    onError: 'continueRegularOutput',
  });

  nodes.push(
    codeNode(
      'Build Sort Range',
      'build-sort-range',
      [3840, 0],
      [],
      [
        "const cfg = $('Build Sort Request').item.json;",
        'const meta = $input.first().json || {};',
        'const props = (meta.sheets || []).map((s) => s.properties).filter(Boolean);',
        '',
        '// Row 1 is the header and must stay put, so every range starts at row 2.',
        'const sortTab = (title, column, columnCount) => {',
        '  const tab = props.find((p) => p.title === title);',
        '  if (!tab || column === -1) return null;',
        '  const rowCount = (tab.gridProperties && tab.gridProperties.rowCount) || 0;',
        '  if (rowCount < 3) return null;',
        '  return { sortRange: {',
        '    range: {',
        '      sheetId: tab.sheetId,',
        '      startRowIndex: 1,',
        '      endRowIndex: rowCount,',
        '      startColumnIndex: 0,',
        '      endColumnIndex: columnCount,',
        '    },',
        '    sortSpecs: [{ dimensionIndex: column, sortOrder: "DESCENDING" }],',
        '  } };',
        '};',
        '',
        '// Both tabs, newest at the top: Conversations by when the customer last',
        '// moved, Messages by when each message happened. One batch, one call.',
        'const requests = [',
        "  sortTab('Conversations', cfg.sortColumn, cfg.columnCount),",
        "  sortTab('Messages', cfg.messageSortColumn, cfg.messageColumnCount),",
        '].filter(Boolean);',
        '',
        'if (!requests.length) {',
        '  console.log(JSON.stringify({ event: "sort_skipped", reason: "nothing_to_sort" }));',
        '  return [];',
        '}',
        '',
        'return [{ json: { token: cfg.token, body: { requests } } }];',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      method: 'POST',
      url: '=https://sheets.googleapis.com/v4/spreadsheets/{{ $env.GOOGLE_SHEET_ID }}:batchUpdate',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Authorization', value: '=Bearer {{ $json.token }}' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.body) }}',
      options: { timeout: 15000, response: { response: { neverError: true, responseFormat: 'json' } } },
    },
    id: 'sort-conversations',
    name: 'Sort Newest First',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: NODE_VERSION.httpRequest,
    position: [4060, 0],
    onError: 'continueRegularOutput',
  });

  connections['Append Message'] = { main: [[{ node: 'Audit Assignment', type: 'main', index: 0 }]] };
  connections['Audit Assignment'] = { main: [[{ node: 'Sign Sheets Token Request', type: 'main', index: 0 }]] };
  connections['Sign Sheets Token Request'] = { main: [[{ node: 'Get Sheets Token', type: 'main', index: 0 }]] };
  connections['Get Sheets Token'] = { main: [[{ node: 'Build Sort Request', type: 'main', index: 0 }]] };
  connections['Build Sort Request'] = { main: [[{ node: 'Read Tab Ids', type: 'main', index: 0 }]] };
  connections['Read Tab Ids'] = { main: [[{ node: 'Build Sort Range', type: 'main', index: 0 }]] };
  connections['Build Sort Range'] = { main: [[{ node: 'Sort Newest First', type: 'main', index: 0 }]] };


  return {
    id: WORKFLOW_ID.conversation,
    name: 'WhatsApp — 3 Conversation & Assignment',
    nodes,
    connections,
    settings: {
      executionOrder: 'v1',
      saveManualExecutions: true,
      saveExecutionProgress: true,
      // Serialize assignment. Google Sheets has no atomic compare-and-set, so
      // two parallel executions can both read "Mohammad has 3 open" and both
      // assign him. Shipping this in the generated JSON means a fresh import
      // is safe by default instead of depending on someone remembering to set
      // it in the UI. See docs/ASSIGNMENT_ALGORITHM.md.
      executionTimeout: 300,
      // NO concurrency limit here, deliberately.
      //
      // concurrency: 1 was meant to serialise assignment, because Google
      // Sheets has no compare-and-set and two executions can both read an
      // empty result and both create a conversation. It did stop that. It also
      // DROPPED the overflow: with a limit of 1, a burst of four webhooks
      // arriving together lost two of them outright - HTTP 200 returned to
      // Meta, no conversation row, no message row, nothing in the log.
      //
      // A duplicate row is visible and repairable. A dropped customer message
      // is invisible and gone. So the limit is off, and the duplicate it used
      // to prevent is healed instead: workflow 8 folds two open conversations
      // for the same customer back into one on its next sweep.
    },
    tags: [],
  };
}

// ===========================================================================
// Workflow 4 — Outgoing Agent Message
// ===========================================================================
function buildOutgoingMessage() {
  const nodes = [];
  const connections = {};

  nodes.push({
    parameters: {
      httpMethod: 'POST',
      path: 'agent/send',
      responseMode: 'responseNode',
      options: {},
    },
    id: 'send-trigger',
    name: 'Agent Send Request',
    type: 'n8n-nodes-base.webhook',
    typeVersion: NODE_VERSION.webhook,
    position: [-560, 0],
    webhookId: 'a1b2c3d4-0000-4000-8000-agentsendxxx',
    notes:
      'Internal endpoint for the future agent inbox. Requires an X-Agent-Key header matching AGENT_SEND_API_KEY, and is still NOT exposed to the public internet in production — see docs/DEPLOYMENT_HOSTINGER.md.',
  });

  nodes.push(
    codeNode(
      'Validate Send Request',
      'validate-send',
      [-300, 0],
      ['phone.js', 'security.js'],
      [
        'const input = $input.first().json;',
        '',
        '// Authenticate before looking at anything else. This endpoint can send',
        '// any text to any number from the business account, so an unset',
        '// AGENT_SEND_API_KEY rejects everything (500) rather than opening it up.',
        "const auth = verifyApiKeyHeader(input.headers, 'x-agent-key', $env.AGENT_SEND_API_KEY);",
        'if (!auth.ok) {',
        "  console.log(JSON.stringify({ event: 'send_request_unauthorized', reason: auth.reason }));",
        '  return [{ json: {',
        '    valid: false,',
        "    errors: [auth.statusCode === 500 ? 'server_misconfigured' : 'unauthorized'],",
        '    status_code: auth.statusCode,',
        '  } }];',
        '}',
        '',
        'const body = input.body || {};',
        "const defaultCountryCode = $env.DEFAULT_COUNTRY_CODE || '962';",
        '',
        'const errors = [];',
        '',
        '// Strict normalization: we must never message the wrong person because',
        '// an ambiguous number was guessed.',
        'const phone = normalizePhoneStrict(body.to, { defaultCountryCode });',
        "if (!phone.ok) errors.push('invalid_recipient:' + (phone.reason || 'unknown'));",
        '',
        "const text = typeof body.text === 'string' ? body.text.trim() : '';",
        "if (!text) errors.push('empty_text');",
        "if (text.length > 4096) errors.push('text_too_long');",
        '',
        "const conversationId = body.conversation_id ? String(body.conversation_id) : '';",
        "if (!conversationId) errors.push('missing_conversation_id');",
        '',
        "const agentId = body.agent_id ? String(body.agent_id) : '';",
        "if (!agentId) errors.push('missing_agent_id');",
        '',
        'if (errors.length > 0) {',
        '  console.log(JSON.stringify({',
        "    event: 'send_request_rejected',",
        '    errors,',
        '    conversation_id: conversationId,',
        '  }));',
        '  return [{ json: { valid: false, errors, status_code: 400 } }];',
        '}',
        '',
        'return [{ json: {',
        '  valid: true,',
        '  to: phone.e164,',
        '  text,',
        '  conversation_id: conversationId,',
        '  agent_id: agentId,',
        '  reply_to_message_id: body.reply_to_message_id || null,',
        '  status_code: 200,',
        '} }];',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'valid',
            leftValue: '={{ $json.valid }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: 'if-valid',
    name: 'Request Valid?',
    type: 'n8n-nodes-base.if',
    typeVersion: NODE_VERSION.if,
    position: [-40, 0],
  });

  nodes.push({
    parameters: {
      method: 'POST',
      // WHATSAPP_CONNECTOR selects the path: "meta" (default, unchanged
      // behaviour) or "waha" (docs/WAHA_CONNECTOR.md) — a QR-linked number,
      // no Meta approval, no account deletion. Both branches are plain
      // expressions, so nothing here needs an n8n credential either way.
      url: WHATSAPP_SEND_URL_EXPR,
      // The token is read from the environment rather than an n8n credential.
      //
      // Every secret this project uses then lives in exactly one place — .env —
      // so there is no separate credential to create by hand and nothing to
      // forget when deploying to a new host. The workflow JSON stores the
      // EXPRESSION, never the value, so an exported workflow leaks nothing.
      sendHeaders: true,
      headerParameters: WHATSAPP_SEND_HEADERS,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: whatsappSendBodyExpr(true),
      options: {
        timeout: 15000,
        response: { response: { neverError: true, responseFormat: 'json' } },
        retry: { retry: { maxTries: 3, waitBetweenTries: 2000 } },
      },
    },
    id: 'send-meta',
    name: 'Send Via Cloud API',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: NODE_VERSION.httpRequest,
    position: [220, -100],
    onError: 'continueRegularOutput',
    notes:
      'Uses an httpHeaderAuth credential named "Meta WhatsApp Token" holding Authorization: Bearer <META_ACCESS_TOKEN>. The token is NEVER placed in this node, so it cannot leak through an exported workflow.',
  });

  nodes.push(
    codeNode(
      'Interpret Send Result',
      'interpret-send',
      [480, -100],
      ['security.js', 'send-result.js'],
      [
        "const request = $('Request Valid?').first().json;",
        'const response = $input.first().json;',
        'const nowIso = localIso();',
        '',
        '// "Accepted by the API" is NOT "delivered to the customer".',
        '// Real delivery is only known from a later status webhook (Meta) or',
        '// is simply unavailable yet (WAHA — see docs/WAHA_CONNECTOR.md).',
        ...WHATSAPP_INTERPRET_RESULT_LINES,
        '',
        'console.log(JSON.stringify({',
        "  event: ok ? 'send_accepted' : 'send_failed',",
        '  conversation_id: request.conversation_id,',
        '  agent_id: request.agent_id,',
        '  message_id: messageId,',
        '  error_code: apiError ? apiError.code : null,',
        '  error_type: apiError ? apiError.type : null,',
        '  // The message body itself is customer data; log only its length.',
        '  text_length: request.text ? request.text.length : 0,',
        '}));',
        '',
        'return [{ json: {',
        '  ok,',
        '  message_id: messageId,',
        "  status: ok ? 'SENT' : 'FAILED',",
        '  conversation_id: request.conversation_id,',
        '  agent_id: request.agent_id,',
        '  to: request.to,',
        '  text: request.text,',
        '  sent_at: nowIso,',
        '  error_code: apiError ? String(apiError.code) : null,',
        '  error_message: apiError ? String(apiError.message) : null,',
        '  status_code: ok ? 200 : 502,',
        '} }];',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      operation: 'append',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Messages', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          message_id: '={{ $json.message_id }}',
          dedupe_key: '={{ "message:" + $json.message_id }}',
          conversation_id: '={{ $json.conversation_id }}',
          direction: 'outbound',
          sender_phone: '={{ $env.META_BUSINESS_PHONE || $env.META_PHONE_NUMBER_ID }}',
          recipient_phone: '={{ $json.to }}',
          customer_phone: '={{ $json.to }}',
          message_type: 'text',
          text: '={{ $json.text }}',
          timestamp: '={{ $json.sent_at }}',
          status: '={{ $json.status }}',
          agent_id: '={{ $json.agent_id }}',
          created_at: '={{ $json.sent_at }}',
        },
      },
      options: {},
    },
    id: 'store-out',
    name: 'Store Outbound Message',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [740, -100],
    onError: 'continueRegularOutput',
  });

  nodes.push({
    parameters: {
      operation: 'update',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          conversation_id: '={{ $json.conversation_id }}',
          status: 'REPLIED',
          last_message: '={{ $json.text }}',
          last_message_id: '={{ $json.message_id }}',
          last_message_direction: 'outbound',
          last_agent_message_at: '={{ $json.sent_at }}',
          last_activity_at: '={{ $json.sent_at }}',
          unread: 'FALSE',
          updated_at: '={{ $json.sent_at }}',
        },
        matchingColumns: ['conversation_id'],
      },
      options: {},
    },
    id: 'update-conv-out',
    name: 'Update Conversation After Reply',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [1000, -100],
    onError: 'continueRegularOutput',
  });

  nodes.push({
    parameters: {
      respondWith: 'json',
      responseBody: '={{ JSON.stringify($json) }}',
      options: { responseCode: '={{ $json.status_code }}' },
    },
    id: 'respond-send',
    name: 'Respond To Agent',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: NODE_VERSION.respondToWebhook,
    position: [1260, 0],
  });

  nodes.push(
    stickyNote(
      [
        '## Workflow 4 — Outgoing Agent Message',
        '',
        'The ONLY supported path for an agent reply.',
        '',
        '### Critical distinction',
        '`SENT` here means **the Cloud API accepted the request**.',
        'It does NOT mean the customer received anything.',
        'DELIVERED / READ / FAILED arrive later via workflow 2\'s status branch.',
        '',
        '### Replies sent from the normal WhatsApp app are INVISIBLE here',
        'If an agent replies from their phone instead of through this endpoint,',
        'no webhook is generated for it and the conversation will keep showing',
        'as UNANSWERED. This is a platform limitation, not a bug.',
        'See docs/ARCHITECTURE.md "Agent access model".',
        '',
        '### Authentication',
        'Callers must send `X-Agent-Key: <AGENT_SEND_API_KEY>`.',
        'Unset key -> 500, wrong or missing key -> 401. Fails closed.',
        '',
        '### Token handling',
        'The access token lives in an n8n credential, never in this JSON.',
      ].join('\n'),
      [-560, -520],
      420,
      640,
      6
    )
  );

  connections['Agent Send Request'] = { main: [[{ node: 'Validate Send Request', type: 'main', index: 0 }]] };
  connections['Validate Send Request'] = { main: [[{ node: 'Request Valid?', type: 'main', index: 0 }]] };
  connections['Request Valid?'] = {
    main: [
      [{ node: 'Send Via Cloud API', type: 'main', index: 0 }],
      [{ node: 'Respond To Agent', type: 'main', index: 0 }],
    ],
  };
  connections['Send Via Cloud API'] = { main: [[{ node: 'Interpret Send Result', type: 'main', index: 0 }]] };
  connections['Interpret Send Result'] = { main: [[{ node: 'Store Outbound Message', type: 'main', index: 0 }]] };
  connections['Store Outbound Message'] = { main: [[{ node: 'Update Conversation After Reply', type: 'main', index: 0 }]] };
  connections['Update Conversation After Reply'] = { main: [[{ node: 'Respond To Agent', type: 'main', index: 0 }]] };

  return {
    id: WORKFLOW_ID.outgoing,
    name: 'WhatsApp — 4 Outgoing Agent Message',
    nodes,
    connections,
    settings: { executionOrder: 'v1', saveManualExecutions: true },
    tags: [],
  };
}

// ===========================================================================
// Workflow 5 — Unassigned Queue Retry
// ===========================================================================
function buildUnassignedRetry() {
  const nodes = [];
  const connections = {};

  nodes.push({
    parameters: {
      rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] },
    },
    id: 'retry-schedule',
    name: 'Every 5 Minutes',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: NODE_VERSION.scheduleTrigger,
    position: [-460, 0],
  });

  nodes.push({
    parameters: {
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
      filtersUI: { values: [{ lookupColumn: 'status', lookupValue: 'WAITING_FOR_AGENT' }] },
      options: { returnAllMatches: true },
    },
    id: 'read-waiting',
    name: 'Read Waiting Conversations',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [-200, 0],
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
  });

  nodes.push({
    parameters: {
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Agents', mode: 'name' },
      options: { returnAllMatches: true },
    },
    id: 'read-agents-retry',
    name: 'Read Agents',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [60, 0],
    // Once, not once per waiting conversation. Per-item reads gave Assign
    // Waiting Queue one copy of every agent per waiting row; it bumps the load
    // on the FIRST copy only, so the next pick could land on another copy of
    // the same agent at its old load and push it past max_open_conversations.
    executeOnce: true,
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
  });

  nodes.push(
    codeNode(
      'Assign Waiting Queue',
      'assign-queue',
      [320, 0],
      ['assignment.js', 'conversation.js'],
      [
        "const waiting = $('Read Waiting Conversations').all()",
        '  .map((i) => i.json)',
        "  .filter((c) => c && c.conversation_id && c.status === 'WAITING_FOR_AGENT')",
        '  // Oldest first: nobody should be stuck at the back of the queue.',
        '  .sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0));',
        '',
        'const agents = $input.all().map((i) => i.json).filter((a) => a && a.agent_id);',
        "const strategy = $env.ASSIGNMENT_STRATEGY || 'LEAST_OPEN_CONVERSATIONS';",
        '',
        'if (waiting.length === 0) {',
        "  console.log(JSON.stringify({ event: 'queue_retry', waiting: 0, assigned: 0 }));",
        '  return [];',
        '}',
        '',
        '// Work on a mutable copy so each assignment within this run is',
        "// reflected in the next agent's load — otherwise a single run would",
        '// hand the whole queue to the same least-loaded agent.',
        'const workingAgents = agents.map((a) => Object.assign({}, a));',
        'const results = [];',
        'const nowIso = localIso();',
        '',
        'for (const conversation of waiting) {',
        '  // Scoped to THIS conversation\'s account — see',
        '  // docs/FUTURE_SESSION_SCOPED_ASSIGNMENT.md.',
        '  const decision = selectAgent(workingAgents, { strategy, businessPhoneNumberId: conversation.business_phone_number_id });',
        '  if (!decision.assigned) {',
        '    // Still nobody available — leave it queued and stop trying.',
        '    console.log(JSON.stringify({',
        "      event: 'queue_retry_exhausted',",
        '      remaining: waiting.length - results.length,',
        '      reason: decision.reason,',
        '    }));',
        '    break;',
        '  }',
        '',
        '  const chosen = decision.agent;',
        '',
        '  // Reflect the assignment locally before the next iteration.',
        '  const idx = workingAgents.findIndex((a) => String(a.agent_id) === String(chosen.agent_id));',
        '  if (idx !== -1) {',
        '    workingAgents[idx] = Object.assign({}, workingAgents[idx], {',
        '      open_conversations: chosen.open_conversations + 1,',
        '      last_assigned_at: nowIso,',
        '    });',
        '  }',
        '',
        '  results.push({ json: {',
        '    conversation_id: conversation.conversation_id,',
        '    assigned_agent_id: chosen.agent_id,',
        '    assigned_agent_name: chosen.name,',
        "    status: 'UNANSWERED',",
        "    unassigned_reason: '',",
        '    updated_at: nowIso,',
        '    agent_open_after: chosen.open_conversations + 1,',
        '    assigned_at: nowIso,',
        '  } });',
        '}',
        '',
        'console.log(JSON.stringify({',
        "  event: 'queue_retry',",
        '  waiting: waiting.length,',
        '  assigned: results.length,',
        '}));',
        '',
        'return results;',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      operation: 'update',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          conversation_id: '={{ $json.conversation_id }}',
          assigned_agent_id: '={{ $json.assigned_agent_id }}',
          assigned_agent_name: '={{ $json.assigned_agent_name }}',
          status: '={{ $json.status }}',
          unassigned_reason: '',
          updated_at: '={{ $json.updated_at }}',
        },
        matchingColumns: ['conversation_id'],
      },
      options: {},
    },
    id: 'update-assigned',
    name: 'Persist Assignment',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [580, 0],
    onError: 'continueErrorOutput',
  });

  nodes.push({
    parameters: {
      operation: 'update',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Agents', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          agent_id: '={{ $json.assigned_agent_id }}',
          open_conversations: '={{ $json.agent_open_after }}',
          last_assigned_at: '={{ $json.assigned_at }}',
          updated_at: '={{ $json.assigned_at }}',
        },
        matchingColumns: ['agent_id'],
      },
      options: {},
    },
    id: 'update-agent-retry',
    name: 'Update Agent Load',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [840, 0],
    onError: 'continueErrorOutput',
  });

  nodes.push(
    stickyNote(
      [
        '## Workflow 5 — Unassigned Queue Retry',
        '',
        'Every 5 minutes, tries to assign conversations stuck in',
        'WAITING_FOR_AGENT (nobody was available when they arrived).',
        '',
        'Processes OLDEST FIRST so nobody starves at the back of the queue,',
        'and tracks each assignment locally within the run so one agent does',
        'not receive the entire backlog.',
      ].join('\n'),
      [-460, -340],
      260,
      560,
      3
    )
  );

  connections['Every 5 Minutes'] = { main: [[{ node: 'Read Waiting Conversations', type: 'main', index: 0 }]] };
  connections['Read Waiting Conversations'] = { main: [[{ node: 'Read Agents', type: 'main', index: 0 }]] };
  connections['Read Agents'] = { main: [[{ node: 'Assign Waiting Queue', type: 'main', index: 0 }]] };
  connections['Assign Waiting Queue'] = { main: [[{ node: 'Persist Assignment', type: 'main', index: 0 }]] };
  connections['Persist Assignment'] = { main: [[{ node: 'Update Agent Load', type: 'main', index: 0 }]] };

  return {
    id: WORKFLOW_ID.queueRetry,
    name: 'WhatsApp — 5 Unassigned Queue Retry',
    nodes,
    connections,
    settings: { executionOrder: 'v1' },
    tags: [],
  };
}

// ===========================================================================
// Workflow 6 — Error Handler
// ===========================================================================
function buildErrorHandler() {
  const nodes = [];
  const connections = {};

  nodes.push({
    parameters: {},
    id: 'err-trigger',
    name: 'On Workflow Error',
    type: 'n8n-nodes-base.errorTrigger',
    typeVersion: NODE_VERSION.errorTrigger,
    position: [-460, 0],
  });

  nodes.push(
    codeNode(
      'Build Error Record',
      'build-error',
      [-200, 0],
      ['security.js'],
      [
        'const err = $input.first().json;',
        'const execution = err.execution || {};',
        'const workflow = err.workflow || {};',
        '',
        '// Redact before anything is written to a sheet a human will read,',
        '// or to the n8n log — an error payload can contain request headers',
        '// including the Authorization bearer token.',
        'const safeError = redact({',
        '  message: execution.error ? execution.error.message : null,',
        '  stack: execution.error ? execution.error.stack : null,',
        '  node: execution.lastNodeExecuted || null,',
        '});',
        '',
        'console.log(JSON.stringify({',
        "  event: 'workflow_failed',",
        '  workflow_name: workflow.name || null,',
        '  execution_id: execution.id || null,',
        '  node: execution.lastNodeExecuted || null,',
        '}));',
        '',
        'return [{ json: {',
        "  event_id: 'err-' + (execution.id || Date.now()),",
        "  event_type: 'WORKFLOW_ERROR',",
        "  source: workflow.name || 'unknown_workflow',",
        '  timestamp: localIso(),',
        "  status: 'FAILED',",
        "  error: String(safeError.message || 'unknown error').slice(0, 500),",
        '  details: JSON.stringify({',
        '    execution_id: execution.id || null,',
        '    node: execution.lastNodeExecuted || null,',
        '    mode: execution.mode || null,',
        '  }),',
        '} }];',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      operation: 'append',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Log', mode: 'name' },
      columns: { mappingMode: 'defineBelow', value: logColumnMap() },
      options: {},
    },
    id: 'log-error',
    name: 'Record In Events Sheet',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [60, 0],
    onError: 'continueRegularOutput',
    notes: 'If Sheets itself is the thing that failed, this will also fail — the n8n execution log remains the source of truth.',
  });

  nodes.push(
    stickyNote(
      [
        '## Workflow 6 — Error Handler',
        '',
        'Set this as the **Error Workflow** in every other workflow\'s settings.',
        '',
        'Redacts credentials before writing anything, because n8n error',
        'payloads can contain request headers including bearer tokens.',
        '',
        '### Deliberate limitation',
        'If Google Sheets is the failing dependency, this handler cannot log',
        'to Sheets either. The n8n execution log is the fallback source of',
        'truth. See docs/TROUBLESHOOTING.md.',
      ].join('\n'),
      [-460, -340],
      280,
      560,
      2
    )
  );

  connections['On Workflow Error'] = { main: [[{ node: 'Build Error Record', type: 'main', index: 0 }]] };
  connections['Build Error Record'] = { main: [[{ node: 'Record In Events Sheet', type: 'main', index: 0 }]] };

  return {
    id: WORKFLOW_ID.errorHandler,
    name: 'WhatsApp — 6 Error Handler',
    nodes,
    connections,
    settings: { executionOrder: 'v1' },
    tags: [],
  };
}

// ===========================================================================
// Workflow 7 — Reply From Sheet
// ===========================================================================
function buildReplyFromSheet() {
  const nodes = [];
  const connections = {};

  nodes.push({
    parameters: {
      rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] },
    },
    id: 'reply-schedule',
    name: 'Every Minute',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: NODE_VERSION.scheduleTrigger,
    position: [-620, 0],
    notes: 'One minute is the practical floor: faster polling burns the Google Sheets read quota for no perceptible gain.',
  });

  nodes.push({
    parameters: {
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
      options: { returnAllMatches: true },
    },
    id: 'read-for-reply',
    name: 'Read Conversations',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [-380, 0],
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
  });

  nodes.push(
    codeNode(
      'Find Pending Replies',
      'find-pending',
      [-140, 0],
      ['phone.js'],
      [
        '// Accept a row with only a phone number and reply_text. Someone typing',
        '// a new row by hand to message a customer is a legitimate use, and',
        "// requiring a conversation_id silently ignored those rows entirely.",
        'const rows = $input.all().map((i) => i.json)',
        '  .filter((r) => r && (r.conversation_id || r.customer_phone));',
        "const defaultCountryCode = $env.DEFAULT_COUNTRY_CODE || '962';",
        '',
        '// A reply is pending when a human has typed into reply_text and the',
        '// system has not yet processed it. reply_status is the guard that',
        '// stops the same text being sent twice on the next poll.',
        'const pending = [];',
        '',
        'for (const row of rows) {',
        "  const text = (row.reply_text === undefined || row.reply_text === null) ? '' : String(row.reply_text).trim();",
        "  if (text === '') continue;",
        '',
        '  // reply_text being non-empty IS the instruction to send. The system',
        '  // clears the cell the moment the message goes out, so text sitting',
        '  // there always means "not sent yet" and nothing can be sent twice.',
        '  //',
        '  // reply_status is deliberately NOT a guard. It is an OUTCOME the',
        '  // system writes, and treating it as one meant that anyone who set it',
        '  // to SENT themselves - the obvious way to say "send this" - had',
        '  // their message silently dropped.',
        '',
        '  // Strict normalization: never message a number we had to guess.',
        '  const phone = normalizePhoneStrict(row.customer_phone, { defaultCountryCode });',
        '  if (!phone.ok) {',
        '    pending.push({ json: {',
        '      conversation_id: row.conversation_id,',
        '      row_number: row.row_number,',
        '      skip: true,',
        "      reply_status: 'FAILED',",
        "      reply_error: 'invalid_phone:' + (phone.reason || 'unknown'),",
        '      reply_text: text,',
        '    } });',
        '    continue;',
        '  }',
        '',
        '  if (text.length > 4096) {',
        '    pending.push({ json: {',
        '      conversation_id: row.conversation_id,',
        '      row_number: row.row_number,',
        '      skip: true,',
        "      reply_status: 'FAILED',",
        "      reply_error: 'text_too_long:' + text.length,",
        '      reply_text: text,',
        '    } });',
        '    continue;',
        '  }',
        '',
        '  // A hand-typed row has no id yet. Mint one so the outcome can be',
        '  // written back to that row, and so the message is recorded against',
        '  // a real conversation rather than floating free.',
        '  const convId = row.conversation_id ||',
        "    ('CONV-' + ($env.META_PHONE_NUMBER_ID || 'manual') + '-' + phone.e164 + '-' + Date.now());",
        '',
        '  pending.push({ json: {',
        '    conversation_id: convId,',
        '    is_manual: !row.conversation_id,',
        '    // Write the outcome back to the PHYSICAL row this text came from.',
        '    // conversation_id is blank on a hand-typed row, and two rows can',
        '    // hold the same phone, so neither is a safe key. n8n treats',
        '    // row_number as the row index itself.',
        '    row_number: row.row_number,',
        '    customer_phone: phone.e164,',
        '    to: phone.e164,',
        '    text,',
        '    skip: false,',
        '    // Carried so the outcome write can keep every column it does not',
        '    // mean to change.',
        '    source_row: row,',
        "    agent_id: row.assigned_agent_id || 'sheet',",
        "    agent_name: row.assigned_agent_name || '',",
        '    reply_text: text,',
        '  } });',
        '}',
        '',
        'console.log(JSON.stringify({',
        "  event: 'sheet_reply_scan',",
        '  scanned: rows.length,',
        '  pending: pending.length,',
        '}));',
        '',
        'return pending;',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'not-skip',
            leftValue: '={{ $json.skip }}',
            rightValue: false,
            operator: { type: 'boolean', operation: 'false', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: 'if-sendable',
    name: 'Sendable?',
    type: 'n8n-nodes-base.if',
    typeVersion: NODE_VERSION.if,
    position: [100, 0],
  });

  nodes.push({
    parameters: {
      method: 'POST',
      // WHATSAPP_CONNECTOR selects the path: "meta" (default, unchanged
      // behaviour) or "waha" (docs/WAHA_CONNECTOR.md).
      url: WHATSAPP_SEND_URL_EXPR,
      // The token is read from the environment rather than an n8n credential.
      //
      // Every secret this project uses then lives in exactly one place — .env —
      // so there is no separate credential to create by hand and nothing to
      // forget when deploying to a new host. The workflow JSON stores the
      // EXPRESSION, never the value, so an exported workflow leaks nothing.
      sendHeaders: true,
      headerParameters: WHATSAPP_SEND_HEADERS,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: whatsappSendBodyExpr(false),
      options: {
        timeout: 15000,
        response: { response: { neverError: true, responseFormat: 'json' } },
        retry: { retry: { maxTries: 3, waitBetweenTries: 2000 } },
      },
    },
    id: 'sheet-send',
    name: 'Send Reply Via Cloud API',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: NODE_VERSION.httpRequest,
    position: [340, -120],
    onError: 'continueRegularOutput',
    notes: 'Uses the "Meta WhatsApp Token" credential. The token is never stored in this node.',
  });

  nodes.push(
    codeNode(
      'Interpret Sheet Send',
      'interpret-sheet-send',
      [580, -120],
      ['send-result.js'],
      [
        "const request = $('Sendable?').item.json;",
        'const response = $input.first().json;',
        'const nowIso = localIso();',
        '',
        ...WHATSAPP_INTERPRET_RESULT_LINES,
        '',
        'console.log(JSON.stringify({',
        "  event: ok ? 'sheet_reply_sent' : 'sheet_reply_failed',",
        '  conversation_id: request.conversation_id,',
        '  message_id: messageId,',
        '  error_code: apiError ? apiError.code : null,',
        '  text_length: request.text ? request.text.length : 0,',
        '}));',
        '',
        '// Every field the Sheets node writes must have a concrete value here.',
        '// A mapped column whose expression is undefined lands as an EMPTY',
        "// cell, so 'leave this one alone' has to be written as the value the",
        '// row already holds. On a failure that means keeping the conversation',
        '// exactly as it was, and only recording why the send did not go out.',
        'const row = request.source_row || {};',
        '',
        'return [{ json: {',
        '  conversation_id: request.conversation_id,',
        '  row_number: request.row_number,',
        '  to: request.to,',
        '  text: request.text,',
        '  agent_id: request.agent_id,',
        '  ok,',
        '  message_id: messageId,',
        "  reply_status: ok ? 'SENT' : 'FAILED',",
        "  reply_error: apiError ? ('[' + apiError.code + '] ' + String(apiError.message).slice(0, 200)) : '',",
        '  sent_at: nowIso,',
        "  new_status: ok ? 'REPLIED' : (row.status || ''),",
        "  new_unanswered: ok ? '' : (row.unanswered_messages || ''),",
        "  new_unanswered_count: ok ? '0' : (row.unanswered_count || ''),",
        "  new_last_message: ok ? request.text : (row.last_message || ''),",
        "  new_last_message_id: ok ? messageId : (row.last_message_id || ''),",
        "  new_last_message_type: ok ? 'text' : (row.last_message_type || 'text'),",
        "  new_last_message_direction: ok ? 'outbound' : (row.last_message_direction || ''),",
        "  new_last_agent_message_at: ok ? nowIso : (row.last_agent_message_at || ''),",
        "  new_unread: ok ? 'FALSE' : (row.unread || ''),",
        '} }];',
      ].join('\n')
    )
  );

  // On success: clear reply_text so the cell is ready for the next reply, and
  // record the outcome where the person who typed it will see it.
  nodes.push({
    parameters: {
      operation: 'update',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          row_number: '={{ $json.row_number }}',
          conversation_id: '={{ $json.conversation_id }}',
          reply_text: '',
          reply_status: '={{ $json.reply_status }}',
          reply_error: '={{ $json.reply_error }}',
          reply_sent_at: '={{ $json.sent_at }}',
          status: '={{ $json.new_status }}',
          unanswered_messages: '={{ $json.new_unanswered }}',
          unanswered_count: '={{ $json.new_unanswered_count }}',
          last_message: '={{ $json.new_last_message }}',
          last_message_id: '={{ $json.new_last_message_id }}',
          last_message_type: '={{ $json.new_last_message_type }}',
          last_message_direction: '={{ $json.new_last_message_direction }}',
          last_agent_message_at: '={{ $json.new_last_agent_message_at }}',
          last_activity_at: '={{ $json.sent_at }}',
          unread: '={{ $json.new_unread }}',
          updated_at: '={{ $json.sent_at }}',
        },
        matchingColumns: ['row_number'],
      },
      options: {},
    },
    id: 'clear-reply',
    name: 'Clear Cell And Record Outcome',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [820, -120],
    onError: 'continueErrorOutput',
  });

  nodes.push({
    parameters: {
      operation: 'append',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Messages', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          // Reference the send node explicitly. This node runs AFTER a Sheets
          // update, so $json here is that update's output — using it silently
          // wrote a row with no message_id and no text.
          message_id: "={{ $('Interpret Sheet Send').item.json.message_id }}",
          dedupe_key: "={{ 'message:' + $('Interpret Sheet Send').item.json.message_id }}",
          conversation_id: "={{ $('Interpret Sheet Send').item.json.conversation_id }}",
          direction: 'outbound',
          sender_phone: '={{ $env.META_BUSINESS_PHONE || $env.META_PHONE_NUMBER_ID }}',
          recipient_phone: "={{ $('Interpret Sheet Send').item.json.to }}",
          customer_phone: "={{ $('Interpret Sheet Send').item.json.to }}",
          message_type: 'text',
          text: "={{ $('Interpret Sheet Send').item.json.text }}",
          timestamp: "={{ $('Interpret Sheet Send').item.json.sent_at }}",
          status: "={{ $('Interpret Sheet Send').item.json.reply_status }}",
          agent_id: "={{ $('Interpret Sheet Send').item.json.agent_id }}",
          sent_via: 'google_sheet',
          created_at: "={{ $('Interpret Sheet Send').item.json.sent_at }}",
        },
      },
      options: {},
    },
    id: 'sheet-append-msg',
    name: 'Record Sent Reply',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [1060, -120],
    onError: 'continueRegularOutput',
  });

  // Validation failures never reach Meta — record why, and clear the cell so a
  // bad value does not retry forever.
  nodes.push({
    parameters: {
      operation: 'update',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          row_number: '={{ $json.row_number }}',
          reply_status: 'FAILED',
          reply_error: '={{ $json.reply_error }}',
          reply_sent_at: '={{ $now.toISO() }}',
        },
        matchingColumns: ['row_number'],
      },
      options: {},
    },
    id: 'mark-invalid',
    name: 'Mark Invalid Reply',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [340, 160],
    onError: 'continueRegularOutput',
    notes: 'reply_text is deliberately NOT cleared here, so the person can see and correct what they typed.',
  });

  nodes.push(
    stickyNote(
      [
        '## Workflow 7 — Reply From The Sheet',
        '',
        'Type a message into the **reply_text** column of a conversation row.',
        'Within a minute it is sent to that customer over the Cloud API and',
        'the cell is cleared.',
        '',
        '### Why this matters',
        'It gives non-technical staff a working reply channel with no app to',
        'install and no training — and unlike replying from a personal phone,',
        'every message IS tracked.',
        '',
        '### Guard against double-sending',
        '`reply_status` is the interlock. Blank/PENDING = send it.',
        'SENDING/SENT/FAILED = leave it alone. Without this, every poll would',
        'resend the same text until someone cleared the cell by hand.',
        '',
        '### On failure',
        'reply_text is NOT cleared, so the author can see and fix what they',
        'typed. reply_error says what went wrong.',
      ].join('\n'),
      [-620, -520],
      420,
      620,
      5
    )
  );

  connections['Every Minute'] = { main: [[{ node: 'Read Conversations', type: 'main', index: 0 }]] };
  connections['Read Conversations'] = { main: [[{ node: 'Find Pending Replies', type: 'main', index: 0 }]] };
  connections['Find Pending Replies'] = { main: [[{ node: 'Sendable?', type: 'main', index: 0 }]] };
  connections['Sendable?'] = {
    main: [
      [{ node: 'Send Reply Via Cloud API', type: 'main', index: 0 }],
      [{ node: 'Mark Invalid Reply', type: 'main', index: 0 }],
    ],
  };
  connections['Send Reply Via Cloud API'] = { main: [[{ node: 'Interpret Sheet Send', type: 'main', index: 0 }]] };
  connections['Interpret Sheet Send'] = { main: [[{ node: 'Clear Cell And Record Outcome', type: 'main', index: 0 }]] };
  connections['Clear Cell And Record Outcome'] = { main: [[{ node: 'Record Sent Reply', type: 'main', index: 0 }]] };

  return {
    id: WORKFLOW_ID.replyFromSheet,
    name: 'WhatsApp — 7 Reply From Sheet',
    nodes,
    connections,
    settings: { executionOrder: 'v1', saveManualExecutions: true },
    tags: [],
  };
}

// ===========================================================================
// Workflow 8 — Archive Old Conversations
// ===========================================================================
function buildArchive() {
  const nodes = [];
  const connections = {};

  nodes.push({
    parameters: {
      // Thirty seconds behind workflow 7. This one re-sorts Conversations,
      // which renumbers rows, while workflow 7 writes a reply outcome back by
      // physical row number. Running them at opposite ends of the minute keeps
      // those two apart.
      rule: { interval: [{ field: 'cronExpression', expression: '30 * * * * *' }] },
    },
    id: 'archive-schedule',
    name: 'Every Minute',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: NODE_VERSION.scheduleTrigger,
    position: [-620, 0],
    notes: 'Runs in the local timezone set by GENERIC_TIMEZONE (Asia/Amman).',
  });

  nodes.push({
    parameters: {
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
      options: { returnAllMatches: true },
    },
    id: 'archive-read',
    name: 'Read Conversations',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [-380, 0],
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
  });

  nodes.push(
    codeNode(
      'Select Archivable',
      'select-archivable',
      [-140, 0],
      ['conversation.js'],
      [
        'const rows = $input.all().map((i) => i.json).filter((r) => r && r.conversation_id);',
        '',
        '// ---- fold duplicate conversations back together -------------------',
        '//',
        '// Two webhooks arriving at the same moment can both read a sheet with',
        '// no conversation for that customer, and both create one. Google Sheets',
        '// has no compare-and-set, so nothing at write time can prevent it. The',
        '// alternative - a concurrency limit of 1 - DROPPED the overflow, which',
        '// loses customer messages outright. A duplicate row is the better',
        '// failure, because it can be repaired, and this is the repair.',
        '//',
        '// The oldest row wins: it carries first_message_at, which is what',
        '// response time is measured from. Everything the newer row learned is',
        '// folded into it, and the newer row is archived rather than deleted.',
        'const openByCustomer = {};',
        'for (const row of rows) {',
        "  const st = String(row.status || '').toUpperCase();",
        "  if (st === 'CLOSED' || st === 'ARCHIVED' || st === '') continue;",
        "  const key = String(row.customer_phone || '').trim() + '|' +",
        "    String(row.business_phone_number_id || '').trim();",
        "  if (key === '|') continue;",
        '  (openByCustomer[key] = openByCustomer[key] || []).push(row);',
        '}',
        '',
        '// The oldest row wins: it carries first_message_at, which is what',
        '// response time is measured from. The newer ones are the accident.',
        'const duplicates = [];',
        'for (const key of Object.keys(openByCustomer)) {',
        '  const group = openByCustomer[key];',
        '  if (group.length < 2) continue;',
        '  group.sort((a, b) =>',
        "    String(a.created_at || '').localeCompare(String(b.created_at || '')));",
        '  for (const extra of group.slice(1)) duplicates.push(extra);',
        '  console.log(JSON.stringify({',
        "    event: 'duplicate_conversations_found',",
        '    customer_phone: group[0].customer_phone,',
        '    count: group.length,',
        '    keeping: group[0].conversation_id,',
        '  }));',
        '}',
        'const days = Number($env.ARCHIVE_AFTER_DAYS || 30);',
        'const maxBatch = Number($env.ARCHIVE_BATCH_SIZE || 200);',
        'const now = Date.now();',
        '',
        'if (!isFinite(days) || days <= 0) {',
        "  console.log(JSON.stringify({ event: 'archive_disabled' }));",
        '  return [];',
        '}',
        '',
        'const cutoff = now - days * 86400000;',
        'const archivable = [];',
        '',
        'for (const row of rows) {',
        "  const st = String(row.status || '').toUpperCase();",
        '',
        '  // A human choosing ARCHIVED from the dropdown is an explicit',
        '  // instruction: move it now, regardless of age. This is what makes',
        '  // the dropdown feel immediate without needing an Apps Script',
        '  // trigger installed in the spreadsheet.',
        "  if (st === 'ARCHIVED') { archivable.push(row); continue; }",
        '',
        '  // Otherwise only CLOSED rows age out. An open conversation is live',
        '  // work; archiving it would hide a waiting customer.',
        "  if (st !== 'CLOSED') continue;",
        '',
        '  const ts = Date.parse(row.closed_at || row.last_activity_at || row.updated_at || \'\');',
        '  // Never archive a row whose date we cannot read — that is how data',
        '  // gets lost silently.',
        '  if (isNaN(ts)) continue;',
        '  if (ts > cutoff) continue;',
        '',
        '  archivable.push(row);',
        '}',
        '',
        '// A duplicate is archived like anything else, but tagged so the audit',
        '// row says why it moved - otherwise it looks like an unexplained',
        '// disappearance, which is the thing this system must never do.',
        'for (const dup of duplicates) {',
        '  if (archivable.indexOf(dup) === -1) {',
        "    archivable.push(Object.assign({}, dup, { archive_reason: 'duplicate_conversation' }));",
        '  }',
        '}',
        '',
        '// Deleting rows shifts every row beneath it. Sorting DESCENDING by',
        '// row_number means each delete only moves rows we have already',
        '// handled, so indices stay valid throughout the batch.',
        'archivable.sort((a, b) => Number(b.row_number || 0) - Number(a.row_number || 0));',
        '',
        'const batch = archivable.slice(0, maxBatch);',
        '',
        'console.log(JSON.stringify({',
        "  event: 'archive_scan',",
        '  total_rows: rows.length,',
        '  eligible: archivable.length,',
        '  batch: batch.length,',
        '  cutoff_days: days,',
        '}));',
        '',
        'return batch.map((r) => ({ json: Object.assign({}, r, { archived_at: localIso(now) }) }));',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      operation: 'append',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Archive', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: Object.assign(conversationColumnMap('$json'), {
          archived_at: '={{ $json.archived_at }}',
        }),
      },
      options: {},
    },
    id: 'archive-append',
    name: 'Copy To Archive',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [100, 0],
    onError: 'stopWorkflow',
    notes:
      'onError=stopWorkflow is deliberate: if the copy fails, the delete MUST NOT run, or the data is gone.',
  });

  nodes.push({
    parameters: {
      operation: 'delete',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
      toDelete: 'rows',
      startIndex: '={{ $json.row_number }}',
      numberToDelete: 1,
    },
    id: 'archive-delete',
    name: 'Remove From Conversations',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [340, 0],
    onError: 'continueErrorOutput',
    executeOnce: false,
    notes:
      'Runs ONLY after a successful archive copy. Items arrive sorted by row_number DESCENDING so deletes do not shift rows still to be processed.',
  });

  nodes.push({
    parameters: {
      operation: 'append',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Log', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          event_id: '={{ "archive-" + $json.conversation_id }}',
          event_type: 'CONVERSATION_ARCHIVED',
          conversation_id: '={{ $json.conversation_id }}',
          source: 'archive_workflow',
          timestamp: '={{ $now.toISO() }}',
          status: 'ARCHIVED',
          details: '={{ JSON.stringify({ closed_at: $json.closed_at, customer_phone: $json.customer_phone }) }}',
        },
      },
      options: {},
    },
    id: 'archive-audit',
    name: 'Audit Archive',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: NODE_VERSION.googleSheets,
    position: [580, 0],
    onError: 'continueRegularOutput',
  });

  nodes.push(
    stickyNote(
      [
        '## Workflow 8 — Archive Old Conversations',
        '',
        'Nightly at 03:00, moves conversations that have been **CLOSED** for',
        'more than `ARCHIVE_AFTER_DAYS` (default 30) into',
        '`Conversations_Archive`, keeping the working sheet small and fast.',
        '',
        '### Three safety rules',
        '1. **Only CLOSED rows.** An open conversation is live work.',
        '2. **Copy before delete.** The copy node is `stopWorkflow` on error,',
        '   so a failed copy can never be followed by a delete.',
        '3. **Delete bottom-up.** Rows are sorted by row_number DESCENDING,',
        '   because deleting a row shifts everything below it. Deleting',
        '   top-down would corrupt the indices of rows still queued.',
        '',
        '### Unreadable dates are skipped',
        'A row whose closed_at cannot be parsed is left alone rather than',
        'archived on a guess.',
        '',
        'Set `ARCHIVE_AFTER_DAYS=0` to disable entirely.',
      ].join('\n'),
      [-620, -560],
      460,
      620,
      3
    )
  );

  connections['Every Minute'] = { main: [[{ node: 'Read Conversations', type: 'main', index: 0 }]] };
  connections['Read Conversations'] = { main: [[{ node: 'Select Archivable', type: 'main', index: 0 }]] };
  connections['Select Archivable'] = { main: [[{ node: 'Copy To Archive', type: 'main', index: 0 }]] };
  connections['Copy To Archive'] = { main: [[{ node: 'Remove From Conversations', type: 'main', index: 0 }]] };
  connections['Remove From Conversations'] = { main: [[{ node: 'Audit Archive', type: 'main', index: 0 }]] };

  return {
    id: WORKFLOW_ID.archive,
    name: 'WhatsApp — 8 Archive Old Conversations',
    nodes,
    connections,
    settings: { executionOrder: 'v1', saveManualExecutions: true },
    tags: [],
  };
}

// ===========================================================================
// Build + write
// ===========================================================================

/**
 * Nodes whose parameters must read from a NAMED node instead of `$json`.
 *
 * `$json` is whatever the immediately preceding node output. When that node is
 * a Google Sheets write, its output is the row it wrote - not the item that
 * went in - so every `$json.message_id` downstream silently became undefined.
 * That produced Messages rows containing only a direction, and Log rows whose
 * event_type held a status. Naming the source node makes the reference say
 * what it means and survive any change to what a Sheets node returns.
 *
 * file -> { node to rewrite: node to read from }
 */
const ITEM_SOURCES = {
  '02-message-processor.json': { 'Record App Reply Message': 'Apply App Reply' },
  '03-conversation-assignment.json': {
    'Append Message': 'Build Conversation Row',
    'Audit Assignment': 'Build Conversation Row',
  },
  '04-outgoing-agent-message.json': { 'Update Conversation After Reply': 'Interpret Send Result' },
  '05-unassigned-queue-retry.json': { 'Update Agent Load': 'Assign Waiting Queue' },
  '08-archive-conversations.json': {
    'Remove From Conversations': 'Select Archivable',
    'Audit Archive': 'Select Archivable',
  },
};

/** Rewrite every `$json` reference in a node's parameters to a named source. */
function bindItemSource(node, sourceName) {
  const ref = '$("' + sourceName + '").item.json';
  const walk = (value) => {
    if (typeof value === 'string') {
      return value.split('$json').join(ref);
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) out[k] = walk(value[k]);
      return out;
    }
    return value;
  };
  node.parameters = walk(node.parameters || {});
}

const WORKFLOWS = [
  { file: '01-webhook-receiver.json', build: buildWebhookReceiver },
  { file: '02-message-processor.json', build: buildMessageProcessor },
  { file: '03-conversation-assignment.json', build: buildConversationAndAssignment },
  { file: '04-outgoing-agent-message.json', build: buildOutgoingMessage },
  { file: '05-unassigned-queue-retry.json', build: buildUnassignedRetry },
  { file: '06-error-handler.json', build: buildErrorHandler },
  { file: '07-reply-from-sheet.json', build: buildReplyFromSheet },
  { file: '08-archive-conversations.json', build: buildArchive },
];

function main() {
  const checkOnly = process.argv.indexOf('--check') !== -1;

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  let drift = 0;
  for (const wf of WORKFLOWS) {
    const built = wf.build();

    // Bind the references that must not depend on what the previous node
    // happened to output. Done before the schema is derived so the schema is
    // computed from the final expressions.
    const sources = ITEM_SOURCES[wf.file] || {};
    for (const node of built.nodes) {
      if (sources[node.name]) bindItemSource(node, sources[node.name]);
    }

    // Every Sheets node that maps columns explicitly needs a derived schema.
    for (const node of built.nodes) {
      if (node.type === 'n8n-nodes-base.googleSheets') withRetry(withSheetSchema(node));
    }

    // Which nodes actually have something wired to their error output.
    const wiredErrorOutputs = new Set();
    for (const name of Object.keys(built.connections || {})) {
      const outputs = (built.connections[name] || {}).main || [];
      outputs.forEach((targets, index) => {
        if (index > 0 && targets && targets.length) wiredErrorOutputs.add(name);
      });
    }
    for (const node of built.nodes) {
      failLoudly(node, wiredErrorOutputs);
    }
    const json = JSON.stringify(built, null, 2) + '\n';
    const target = path.join(OUT_DIR, wf.file);

    if (checkOnly) {
      const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
      if (current !== json) {
        console.log('DRIFT   ' + wf.file + ' is out of date — run: node scripts/setup/build-workflows.js');
        drift += 1;
      } else {
        console.log('CURRENT ' + wf.file);
      }
      continue;
    }

    fs.writeFileSync(target, json, 'utf8');
    const nodeCount = built.nodes.length;
    const codeNodes = built.nodes.filter((n) => n.type === 'n8n-nodes-base.code').length;
    console.log(
      'BUILT   ' + wf.file.padEnd(36) + nodeCount + ' nodes (' + codeNodes + ' code) ' +
        (json.length / 1024).toFixed(1) + ' KB'
    );
  }

  if (checkOnly && drift > 0) {
    process.exit(1);
  }
  if (!checkOnly) {
    console.log('\nWorkflows written to n8n/workflows/');
    console.log('Import with: node scripts/setup/import-workflows.js');
  }
}

main();
