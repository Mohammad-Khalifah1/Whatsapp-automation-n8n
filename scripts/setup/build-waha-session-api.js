#!/usr/bin/env node
/**
 * Builds n8n/workflows/11-waha-session-api.json — session status, QR, and
 * restart for the management UI's Connection tab (ui/management/README.md).
 *
 * Uses WAHA_STATUS_API_KEY (read + control, never send — minted by
 * scripts/setup/configure-waha.js), never WAHA_API_KEY (the admin key) and
 * never WAHA_SEND_API_KEY (workflow 4/7's send-only key). Same
 * X-Management-Key auth as workflows 9/10, same fail-closed rule.
 *
 * Usage:
 *   node scripts/setup/build-waha-session-api.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'n8n', 'workflows');

const CORS_HEADERS = [
  { name: 'Access-Control-Allow-Origin', value: '*' },
  { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
  { name: 'Access-Control-Allow-Headers', value: 'Content-Type, X-Management-Key' },
];

function respondNode(id, name, position, { body, code = 200, extraHeaders = [] }) {
  return {
    parameters: {
      respondWith: 'json',
      responseBody: body,
      options: { responseCode: code, responseHeaders: { entries: [...CORS_HEADERS, ...extraHeaders] } },
    },
    id, name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.5, position,
  };
}

function authCheckCode() {
  return `
const crypto = require('crypto');
function safeEqual(a, b) {
  const bufA = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const bufB = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}
const item = $input.first();
const headers = (item.json && item.json.headers) || {};
const provided = headers['x-management-key'] || '';
const expected = $env.MANAGEMENT_API_KEY;
let ok = false;
let reason = 'UNKNOWN';
if (!expected || String(expected).trim() === '') {
  reason = 'MANAGEMENT_API_KEY_NOT_CONFIGURED';
} else if (!provided) {
  reason = 'MISSING_KEY_HEADER';
} else {
  ok = safeEqual(String(provided), String(expected));
  reason = ok ? 'OK' : 'KEY_MISMATCH';
}
return [{ json: { auth_ok: ok, auth_reason: reason } }];
`.trim();
}

function authIfNode(id, name, position) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: 'auth-ok', leftValue: '={{ $json.auth_ok }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
      options: {},
    },
    id, name, type: 'n8n-nodes-base.if', typeVersion: 2.3, position,
  };
}

function unauthorizedRespond(id, name, position) {
  return respondNode(id, name, position, {
    body: '={{ { "error": $json.auth_reason === "MANAGEMENT_API_KEY_NOT_CONFIGURED" ? "server misconfigured" : "unauthorized" } }}',
    code: '={{ $json.auth_reason === "MANAGEMENT_API_KEY_NOT_CONFIGURED" ? 500 : 401 }}',
  });
}

function optionsPreflightNodes(pathValue, startPos, idPrefix) {
  return [
    {
      parameters: { httpMethod: 'OPTIONS', path: pathValue, responseMode: 'responseNode', options: {} },
      id: idPrefix + '-opt-wh', name: 'CORS Preflight (' + pathValue + ')',
      type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: startPos,
      webhookId: idPrefix + '-opt-' + Math.random().toString(36).slice(2, 10),
    },
    respondNode(idPrefix + '-opt-resp', idPrefix + '-ack', [startPos[0] + 260, startPos[1]], { body: '={{ {} }}', code: 204 }),
  ];
}

function stickyNote(id, name, content, position, size) {
  return { parameters: { content, height: size[1], width: size[0], color: 4 }, id, name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position };
}

const nodes = [];
const connections = {};

// ---- GET /api/waha/status ----
nodes.push({
  parameters: { httpMethod: 'GET', path: 'api/waha/status', responseMode: 'responseNode', options: {} },
  id: 'st-wh', name: 'Get Status (GET)', type: 'n8n-nodes-base.webhook', typeVersion: 2.1,
  position: [-700, -300], webhookId: 'a1b2c3d4-0000-4000-8000-wahastatget1',
});
nodes.push({ parameters: { mode: 'runOnceForAllItems', jsCode: authCheckCode() }, id: 'st-auth', name: 'Check Auth (Status)', type: 'n8n-nodes-base.code', typeVersion: 2, position: [-460, -300] });
nodes.push(authIfNode('st-if', 'Authorized? (Status)', [-220, -300]));
nodes.push(unauthorizedRespond('st-401', 'Reject Unauthorized (Status)', [40, -180]));
nodes.push({
  parameters: {
    method: 'GET',
    url: '={{ $env.WAHA_BASE_URL + "/api/sessions/" + $env.WAHA_SESSION }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'X-Api-Key', value: '={{ $env.WAHA_STATUS_API_KEY }}' }] },
    options: { timeout: 10000, response: { response: { neverError: true, responseFormat: 'json' } } },
  },
  id: 'st-call', name: 'Call WAHA (Status)', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5, position: [40, -380],
});
nodes.push({
  parameters: {
    mode: 'runOnceForAllItems',
    jsCode: `
const r = $input.first().json || {};
return [{ json: {
  session: $env.WAHA_SESSION,
  status: r.status || 'UNKNOWN',
  engine: r.engine && r.engine.engine ? r.engine.engine : null,
  connected: r.status === 'WORKING',
  me: r.me ? { id: r.me.id, pushName: r.me.pushName } : null,
} }];
`.trim(),
  },
  id: 'st-map', name: 'Simplify Status', type: 'n8n-nodes-base.code', typeVersion: 2, position: [280, -380],
});
nodes.push(respondNode('st-200', 'Respond Status', [500, -380], { body: '={{ $json }}' }));

connections['Get Status (GET)'] = { main: [[{ node: 'Check Auth (Status)', type: 'main', index: 0 }]] };
connections['Check Auth (Status)'] = { main: [[{ node: 'Authorized? (Status)', type: 'main', index: 0 }]] };
connections['Authorized? (Status)'] = { main: [[{ node: 'Call WAHA (Status)', type: 'main', index: 0 }], [{ node: 'Reject Unauthorized (Status)', type: 'main', index: 0 }]] };
connections['Call WAHA (Status)'] = { main: [[{ node: 'Simplify Status', type: 'main', index: 0 }]] };
connections['Simplify Status'] = { main: [[{ node: 'Respond Status', type: 'main', index: 0 }]] };

// ---- GET /api/waha/qr (binary passthrough) ----
nodes.push({
  parameters: { httpMethod: 'GET', path: 'api/waha/qr', responseMode: 'responseNode', options: {} },
  id: 'qr-wh', name: 'Get QR (GET)', type: 'n8n-nodes-base.webhook', typeVersion: 2.1,
  position: [-700, 0], webhookId: 'a1b2c3d4-0000-4000-8000-wahaqrget001',
});
nodes.push({ parameters: { mode: 'runOnceForAllItems', jsCode: authCheckCode() }, id: 'qr-auth', name: 'Check Auth (QR)', type: 'n8n-nodes-base.code', typeVersion: 2, position: [-460, 0] });
nodes.push(authIfNode('qr-if', 'Authorized? (QR)', [-220, 0]));
nodes.push(unauthorizedRespond('qr-401', 'Reject Unauthorized (QR)', [40, 140]));
nodes.push({
  parameters: {
    method: 'GET',
    url: '={{ $env.WAHA_BASE_URL + "/api/" + $env.WAHA_SESSION + "/auth/qr?format=image" }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'X-Api-Key', value: '={{ $env.WAHA_STATUS_API_KEY }}' }] },
    options: { timeout: 10000, response: { response: { neverError: true, responseFormat: 'file' } } },
  },
  id: 'qr-call', name: 'Call WAHA (QR)', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5, position: [40, -80],
});
nodes.push(respondNode('qr-200', 'Respond QR', [280, -80], { body: '={{ $binary.data }}' }));
// respondNode() always sets respondWith:'json' — override for binary here.
nodes[nodes.length - 1].parameters.respondWith = 'binary';
nodes[nodes.length - 1].parameters.responseDataSource = 'firstEntryBinary';
delete nodes[nodes.length - 1].parameters.responseBody;

connections['Get QR (GET)'] = { main: [[{ node: 'Check Auth (QR)', type: 'main', index: 0 }]] };
connections['Check Auth (QR)'] = { main: [[{ node: 'Authorized? (QR)', type: 'main', index: 0 }]] };
connections['Authorized? (QR)'] = { main: [[{ node: 'Call WAHA (QR)', type: 'main', index: 0 }], [{ node: 'Reject Unauthorized (QR)', type: 'main', index: 0 }]] };
connections['Call WAHA (QR)'] = { main: [[{ node: 'Respond QR', type: 'main', index: 0 }]] };

// ---- POST /api/waha/restart ----
nodes.push({
  parameters: { httpMethod: 'POST', path: 'api/waha/restart', responseMode: 'responseNode', options: {} },
  id: 'rs-wh', name: 'Restart (POST)', type: 'n8n-nodes-base.webhook', typeVersion: 2.1,
  position: [-700, 320], webhookId: 'a1b2c3d4-0000-4000-8000-wharestpost1',
});
nodes.push({ parameters: { mode: 'runOnceForAllItems', jsCode: authCheckCode() }, id: 'rs-auth', name: 'Check Auth (Restart)', type: 'n8n-nodes-base.code', typeVersion: 2, position: [-460, 320] });
nodes.push(authIfNode('rs-if', 'Authorized? (Restart)', [-220, 320]));
nodes.push(unauthorizedRespond('rs-401', 'Reject Unauthorized (Restart)', [40, 460]));
nodes.push({
  parameters: {
    method: 'POST',
    url: '={{ $env.WAHA_BASE_URL + "/api/sessions/" + $env.WAHA_SESSION + "/restart" }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'X-Api-Key', value: '={{ $env.WAHA_STATUS_API_KEY }}' }] },
    options: { timeout: 15000, response: { response: { neverError: true, responseFormat: 'json' } } },
  },
  id: 'rs-call', name: 'Call WAHA (Restart)', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5, position: [40, 240],
});
nodes.push({
  parameters: {
    mode: 'runOnceForAllItems',
    jsCode: `
const r = $input.first().json || {};
return [{ json: { session: $env.WAHA_SESSION, status: r.status || 'UNKNOWN', restarted: !!r.status } }];
`.trim(),
  },
  id: 'rs-map', name: 'Confirm Restart', type: 'n8n-nodes-base.code', typeVersion: 2, position: [280, 240],
});
nodes.push(respondNode('rs-200', 'Respond Restart', [500, 240], { body: '={{ $json }}' }));

connections['Restart (POST)'] = { main: [[{ node: 'Check Auth (Restart)', type: 'main', index: 0 }]] };
connections['Check Auth (Restart)'] = { main: [[{ node: 'Authorized? (Restart)', type: 'main', index: 0 }]] };
connections['Authorized? (Restart)'] = { main: [[{ node: 'Call WAHA (Restart)', type: 'main', index: 0 }], [{ node: 'Reject Unauthorized (Restart)', type: 'main', index: 0 }]] };
connections['Call WAHA (Restart)'] = { main: [[{ node: 'Confirm Restart', type: 'main', index: 0 }]] };
connections['Confirm Restart'] = { main: [[{ node: 'Respond Restart', type: 'main', index: 0 }]] };

// ---- CORS preflight ----
const [c1a, c1b] = optionsPreflightNodes('api/waha/status', [-700, 620], 'wc0');
const [c2a, c2b] = optionsPreflightNodes('api/waha/qr', [-700, 780], 'wc1');
const [c3a, c3b] = optionsPreflightNodes('api/waha/restart', [-700, 940], 'wc2');
nodes.push(c1a, c1b, c2a, c2b, c3a, c3b);
connections['CORS Preflight (api/waha/status)'] = { main: [[{ node: c1b.name, type: 'main', index: 0 }]] };
connections['CORS Preflight (api/waha/qr)'] = { main: [[{ node: c2b.name, type: 'main', index: 0 }]] };
connections['CORS Preflight (api/waha/restart)'] = { main: [[{ node: c3b.name, type: 'main', index: 0 }]] };

nodes.push(stickyNote('note', 'Note',
  '## Workflow 11 — WAHA Session API\n\n' +
  'GET /api/waha/status — session status, mapped down to {status, engine,\n' +
  'connected, me}\n' +
  'GET /api/waha/qr — the QR image, streamed through as binary\n' +
  'POST /api/waha/restart — restart the session\n\n' +
  'Uses WAHA_STATUS_API_KEY only (read+control, never send — minted by\n' +
  'scripts/setup/configure-waha.js). Never the admin key, never the\n' +
  'send-only key workflows 4/7 use.\n\n' +
  'Same X-Management-Key auth as workflows 9/10, fails closed.',
  [-700, -700], [640, 300]));

const workflow = {
  id: 'whatsappWahaSess011',
  name: 'WhatsApp — 11 WAHA Session API',
  nodes, connections,
  settings: { executionOrder: 'v1', saveManualExecutions: true, saveExecutionProgress: true, errorWorkflow: '' },
  tags: [],
};

fs.writeFileSync(path.join(OUT_DIR, '11-waha-session-api.json'), JSON.stringify(workflow, null, 2) + '\n', 'utf8');
console.log('Wrote 11-waha-session-api.json (' + workflow.nodes.length + ' nodes)');
