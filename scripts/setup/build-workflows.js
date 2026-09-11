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
  const prelude = libFiles && libFiles.length ? buildPrelude(libFiles) + '\n' : '';
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
        '  received_at: new Date().toISOString(),',
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
      options: { waitForSubWorkflow: false },
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
        '    received_at: new Date().toISOString(),',
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
        '    received_at: new Date().toISOString(),',
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
        'const nowIso = new Date().toISOString();',
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
        'const nowIso = new Date().toISOString();',
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
        "const strategy = $env.ASSIGNMENT_STRATEGY || 'LEAST_OPEN_CONVERSATIONS';",
        'const decision = selectAgent(agents, { strategy });',
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
        'const nowIso = new Date().toISOString();',
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
    position: [1000, -220],
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
        'const nowIso = new Date().toISOString();',
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
        '  // CRITICAL: the row must be FLAT on the item.',
        '  // The Sheets node uses autoMapInputData, which maps only TOP-LEVEL',
        '  // fields to columns. Returning the row nested under conversation_row',
        '  // made the node append an EMPTY row and still report success — a',
        '  // silent data-loss bug found by checking the sheet, not the logs.',
        '  // Context fields are spread first so row values win on any clash,',
        '  // and unmatched extras are ignored by the Sheets node.',
        "  return [{ json: Object.assign({}, ctx, row, { sheet_operation: 'append' }) }];",
        '}',
        '',
        'const update = Object.assign({}, ctx.conversation_update, {',
        '  conversation_id: ctx.conversation_id,',
        '  updated_at: nowIso,',
        '});',
        '',
        'if (ctx.assignment_decided) {',
        "  update.assigned_agent_id = ctx.assigned_agent_id || '';",
        "  update.assigned_agent_name = ctx.assigned_agent_name || '';",
        "  update.status = ctx.assigned ? 'UNANSWERED' : 'WAITING_FOR_AGENT';",
        "  update.unassigned_reason = ctx.assigned ? '' : (ctx.unassigned_reason || '');",
        '}',
        '',
        "return [{ json: Object.assign({}, ctx, update, { sheet_operation: 'update' }) }];",
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
      columns: { mappingMode: 'autoMapInputData', value: {} },
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
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['conversation_id'] },
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
      [{ node: 'Read Agents', type: 'main', index: 0 }],
      [{ node: 'Build Conversation Row', type: 'main', index: 0 }],
    ],
  };
  connections['Read Agents'] = { main: [[{ node: 'Select Agent', type: 'main', index: 0 }]] };
  connections['Select Agent'] = {
    main: [[
      { node: 'Increment Agent Load', type: 'main', index: 0 },
      { node: 'Build Conversation Row', type: 'main', index: 0 },
    ]],
  };
  connections['Build Conversation Row'] = { main: [[{ node: 'Create Or Update Row?', type: 'main', index: 0 }]] };
  connections['Create Or Update Row?'] = {
    main: [
      [{ node: 'Append Conversation', type: 'main', index: 0 }],
      [{ node: 'Update Conversation', type: 'main', index: 0 }],
    ],
  };
  connections['Append Conversation'] = { main: [[{ node: 'Append Message', type: 'main', index: 0 }]] };
  connections['Update Conversation'] = { main: [[{ node: 'Append Message', type: 'main', index: 0 }]] };
  connections['Append Message'] = { main: [[{ node: 'Audit Assignment', type: 'main', index: 0 }]] };

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
      concurrency: 1,
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
      'Internal endpoint for the future agent inbox. NOT exposed to the public internet in production — see docs/DEPLOYMENT_HOSTINGER.md.',
  });

  nodes.push(
    codeNode(
      'Validate Send Request',
      'validate-send',
      [-300, 0],
      ['phone.js', 'security.js'],
      [
        'const body = $input.first().json.body || {};',
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
      url: '=https://graph.facebook.com/{{ $env.META_GRAPH_API_VERSION }}/{{ $env.META_PHONE_NUMBER_ID }}/messages',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: 'Content-Type', value: 'application/json' }],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody:
        '={{ JSON.stringify(Object.assign({ messaging_product: "whatsapp", recipient_type: "individual", to: $json.to, type: "text", text: { body: $json.text } }, $json.reply_to_message_id ? { context: { message_id: $json.reply_to_message_id } } : {})) }}',
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
      ['security.js'],
      [
        "const request = $('Request Valid?').first().json;",
        'const response = $input.first().json;',
        'const nowIso = new Date().toISOString();',
        '',
        '// "Accepted by the API" is NOT "delivered to the customer".',
        '// Real delivery is only known from a later status webhook.',
        'const messageId = response && response.messages && response.messages[0]',
        '  ? response.messages[0].id',
        '  : null;',
        '',
        'const apiError = response && response.error ? response.error : null;',
        'const ok = !!messageId && !apiError;',
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
          sender_phone: '={{ $env.META_PHONE_NUMBER_ID }}',
          recipient_phone: '={{ $json.to }}',
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
        'const nowIso = new Date().toISOString();',
        '',
        'for (const conversation of waiting) {',
        '  const decision = selectAgent(workingAgents, { strategy });',
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
        '  timestamp: new Date().toISOString(),',
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
      columns: { mappingMode: 'autoMapInputData', value: {} },
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
        'const rows = $input.all().map((i) => i.json).filter((r) => r && r.conversation_id);',
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
        "  const status = String(row.reply_status || '').trim().toUpperCase();",
        '  // PENDING or blank means "not yet handled". SENT/FAILED mean we are',
        '  // done with this text and must not resend it.',
        "  if (status === 'SENT' || status === 'SENDING' || status === 'FAILED') continue;",
        '',
        '  // Strict normalization: never message a number we had to guess.',
        '  const phone = normalizePhoneStrict(row.customer_phone, { defaultCountryCode });',
        '  if (!phone.ok) {',
        '    pending.push({ json: {',
        '      conversation_id: row.conversation_id,',
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
        '      skip: true,',
        "      reply_status: 'FAILED',",
        "      reply_error: 'text_too_long:' + text.length,",
        '      reply_text: text,',
        '    } });',
        '    continue;',
        '  }',
        '',
        '  pending.push({ json: {',
        '    conversation_id: row.conversation_id,',
        '    to: phone.e164,',
        '    text,',
        '    skip: false,',
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
      url: '=https://graph.facebook.com/{{ $env.META_GRAPH_API_VERSION }}/{{ $env.META_PHONE_NUMBER_ID }}/messages',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody:
        '={{ JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: $json.to, type: "text", text: { body: $json.text } }) }}',
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
      [],
      [
        "const request = $('Sendable?').item.json;",
        'const response = $input.first().json;',
        'const nowIso = new Date().toISOString();',
        '',
        'const messageId = response && response.messages && response.messages[0]',
        '  ? response.messages[0].id',
        '  : null;',
        'const apiError = response && response.error ? response.error : null;',
        'const ok = !!messageId && !apiError;',
        '',
        'console.log(JSON.stringify({',
        "  event: ok ? 'sheet_reply_sent' : 'sheet_reply_failed',",
        '  conversation_id: request.conversation_id,',
        '  message_id: messageId,',
        '  error_code: apiError ? apiError.code : null,',
        '  text_length: request.text ? request.text.length : 0,',
        '}));',
        '',
        'return [{ json: {',
        '  conversation_id: request.conversation_id,',
        '  to: request.to,',
        '  text: request.text,',
        '  agent_id: request.agent_id,',
        '  ok,',
        '  message_id: messageId,',
        "  reply_status: ok ? 'SENT' : 'FAILED',",
        "  reply_error: apiError ? ('[' + apiError.code + '] ' + String(apiError.message).slice(0, 200)) : '',",
        '  sent_at: nowIso,',
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
          conversation_id: '={{ $json.conversation_id }}',
          reply_text: '',
          reply_status: '={{ $json.reply_status }}',
          reply_error: '={{ $json.reply_error }}',
          reply_sent_at: '={{ $json.sent_at }}',
          status: '={{ $json.ok ? "REPLIED" : $json.status }}',
          last_message: '={{ $json.ok ? $json.text : undefined }}',
          last_message_id: '={{ $json.ok ? $json.message_id : undefined }}',
          last_message_direction: '={{ $json.ok ? "outbound" : undefined }}',
          last_agent_message_at: '={{ $json.ok ? $json.sent_at : undefined }}',
          last_activity_at: '={{ $json.sent_at }}',
          unread: '={{ $json.ok ? "FALSE" : undefined }}',
          updated_at: '={{ $json.sent_at }}',
        },
        matchingColumns: ['conversation_id'],
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
          message_id: '={{ $json.message_id }}',
          dedupe_key: '={{ "message:" + $json.message_id }}',
          conversation_id: '={{ $json.conversation_id }}',
          direction: 'outbound',
          sender_phone: '={{ $env.META_PHONE_NUMBER_ID }}',
          recipient_phone: '={{ $json.to }}',
          message_type: 'text',
          text: '={{ $json.text }}',
          timestamp: '={{ $json.sent_at }}',
          status: '={{ $json.reply_status }}',
          agent_id: '={{ $json.agent_id }}',
          sent_via: 'google_sheet',
          created_at: '={{ $json.sent_at }}',
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
          conversation_id: '={{ $json.conversation_id }}',
          reply_status: 'FAILED',
          reply_error: '={{ $json.reply_error }}',
          reply_sent_at: '={{ $now.toISO() }}',
        },
        matchingColumns: ['conversation_id'],
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
      rule: { interval: [{ field: 'days', triggerAtHour: 3, triggerAtMinute: 0 }] },
    },
    id: 'archive-schedule',
    name: 'Daily At 03:00',
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
        '  // ONLY closed conversations are ever archived. An open conversation',
        '  // is live work; archiving it would hide a waiting customer.',
        "  if (String(row.status || '').toUpperCase() !== 'CLOSED') continue;",
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
        'return batch.map((r) => ({ json: Object.assign({}, r, { archived_at: new Date(now).toISOString() }) }));',
      ].join('\n')
    )
  );

  nodes.push({
    parameters: {
      operation: 'append',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Archive', mode: 'name' },
      columns: { mappingMode: 'autoMapInputData', value: {} },
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

  connections['Daily At 03:00'] = { main: [[{ node: 'Read Conversations', type: 'main', index: 0 }]] };
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
    // Every Sheets node that maps columns explicitly needs a derived schema.
    for (const node of built.nodes) {
      if (node.type === 'n8n-nodes-base.googleSheets') withSheetSchema(node);
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
