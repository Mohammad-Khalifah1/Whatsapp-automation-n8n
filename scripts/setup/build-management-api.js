#!/usr/bin/env node
/**
 * Builds n8n/workflows/09-employees-api.json and 10-tasks-api.json — a
 * management API for the web UI (docs/WAHA_CONNECTOR.md's task-board ask).
 *
 * Deliberately additive and deliberately NOT touching Sheets' denormalized
 * agent-load counter except where this document's own convention already
 * does (see "Read Agents" + recompute, mirroring `recalculateAgentLoad()` in
 * SetupSheet.gs, scoped to the one affected agent instead of all of them).
 *
 * Auth: every endpoint requires `X-Management-Key: <MANAGEMENT_API_KEY>`.
 * Fails closed if the key is not configured or does not match — there is no
 * "unsigned" opt-out here (unlike ALLOW_UNSIGNED_WEBHOOKS for the WhatsApp
 * webhooks), because this surface reads and writes customer names and phone
 * numbers with no signature scheme protecting it otherwise.
 *
 * Usage:
 *   node scripts/setup/build-management-api.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'n8n', 'workflows');

const SHEETS_CREDENTIAL = { googleApi: { id: 'googleSheetsWaSupport', name: 'Google Sheets - WhatsApp Support' } };

const CORS_HEADERS = [
  { name: 'Access-Control-Allow-Origin', value: '*' },
  { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
  { name: 'Access-Control-Allow-Headers', value: 'Content-Type, X-Management-Key' },
];

/**
 * Builds the `columns.schema` array the Google Sheets node's `update`/
 * `append` operations require when `mappingMode` is `defineBelow` — an
 * empty array is silently accepted at build time but fails at RUN time
 * with "columns.schema is required", which unit tests and the JSON
 * validator cannot catch (there is no live Sheets connection in either).
 * Caught only by a real call against the running instance.
 *
 * @param {string[]} columnNames   Every column this node's value map may set.
 * @param {string[]} matchKeys     Which of those are the match/lookup key(s).
 */
function sheetsSchema(columnNames, matchKeys = []) {
  return columnNames.map((id) => ({
    id,
    displayName: id,
    required: false,
    defaultMatch: matchKeys.includes(id),
    display: true,
    type: 'string',
    canBeUsedToMatch: true,
    removed: false,
  }));
}

function respondNode(id, name, position, { body, code = 200, extraHeaders = [] }) {
  return {
    parameters: {
      respondWith: 'json',
      responseBody: body,
      options: {
        responseCode: code,
        responseHeaders: { entries: [...CORS_HEADERS, ...extraHeaders] },
      },
    },
    id, name,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.5,
    position,
  };
}

function optionsPreflightNodes(pathValue, startPos, idPrefix) {
  return [
    {
      parameters: { httpMethod: 'OPTIONS', path: pathValue, responseMode: 'responseNode', options: {} },
      id: idPrefix + '-opt-wh', name: 'CORS Preflight (' + pathValue + ')',
      type: 'n8n-nodes-base.webhook', typeVersion: 2.1,
      position: startPos, webhookId: idPrefix + '-opt-' + Math.random().toString(36).slice(2, 10),
    },
    respondNode(idPrefix + '-opt-resp', 'Ack Preflight', [startPos[0] + 260, startPos[1]], { body: '={{ {} }}', code: 204 }),
  ];
}

/** The auth-check Code node, identical logic wherever it is used. */
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

console.log(JSON.stringify({ event: 'management_api_auth', ok, reason, path: item.json && item.json.webhookUrl }));

const body = (item.json && item.json.body) || {};
const query = (item.json && item.json.query) || {};
return [{ json: { auth_ok: ok, auth_reason: reason, body, query } }];
`.trim();
}

function authIfNode(id, name, position) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'auth-ok',
          leftValue: '={{ $json.auth_ok }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    },
    id, name, type: 'n8n-nodes-base.if', typeVersion: 2.3, position,
  };
}

function unauthorizedRespond(id, position) {
  return respondNode(id, 'Reject Unauthorized', position, {
    body: '={{ { "error": $json.auth_reason === "MANAGEMENT_API_KEY_NOT_CONFIGURED" ? "server misconfigured" : "unauthorized" } }}',
    code: '={{ $json.auth_reason === "MANAGEMENT_API_KEY_NOT_CONFIGURED" ? 500 : 401 }}',
  });
}

function stickyNote(id, name, content, position, size) {
  return {
    parameters: { content, height: size[1], width: size[0], color: 4 },
    id, name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position,
  };
}

// ============================================================================
// 09 — Employees API
// ============================================================================

function buildEmployeesApi() {
  const nodes = [];
  const connections = {};

  // ---- GET /webhook/api/employees — list ----
  nodes.push({
    parameters: { httpMethod: 'GET', path: 'api/employees', responseMode: 'responseNode', options: {} },
    id: 'emp-list-wh', name: 'List Employees (GET)', type: 'n8n-nodes-base.webhook', typeVersion: 2.1,
    position: [-700, -300], webhookId: 'a1b2c3d4-0000-4000-8000-emplistget01',
  });
  nodes.push({
    parameters: { mode: 'runOnceForAllItems', jsCode: authCheckCode() },
    id: 'emp-list-auth', name: 'Check Auth (List)', type: 'n8n-nodes-base.code', typeVersion: 2, position: [-460, -300],
  });
  nodes.push(authIfNode('emp-list-if', 'Authorized? (List)', [-220, -300]));
  nodes.push(unauthorizedRespond('emp-list-401', [40, -180]));
  nodes.push({
    parameters: {
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Agents', mode: 'name' },
      options: { returnAllMatches: true },
    },
    id: 'emp-list-read', name: 'Read Agents (List)', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7,
    position: [40, -380], credentials: SHEETS_CREDENTIAL,
  });
  nodes.push({
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `
const rows = $input.all().map(i => i.json);
return [{ json: { rows } }];
`.trim(),
    },
    id: 'emp-list-collect', name: 'Collect Rows', type: 'n8n-nodes-base.code', typeVersion: 2, position: [280, -380],
  });
  nodes.push(respondNode('emp-list-200', 'Respond Employees', [500, -380], { body: '={{ $json.rows }}' }));

  connections['List Employees (GET)'] = { main: [[{ node: 'Check Auth (List)', type: 'main', index: 0 }]] };
  connections['Check Auth (List)'] = { main: [[{ node: 'Authorized? (List)', type: 'main', index: 0 }]] };
  connections['Authorized? (List)'] = {
    main: [
      [{ node: 'Read Agents (List)', type: 'main', index: 0 }],
      [{ node: 'Reject Unauthorized', type: 'main', index: 0 }],
    ],
  };
  connections['Read Agents (List)'] = { main: [[{ node: 'Collect Rows', type: 'main', index: 0 }]] };
  connections['Collect Rows'] = { main: [[{ node: 'Respond Employees', type: 'main', index: 0 }]] };

  // ---- POST /webhook/api/employees — create ----
  nodes.push({
    parameters: { httpMethod: 'POST', path: 'api/employees', responseMode: 'responseNode', options: {} },
    id: 'emp-add-wh', name: 'Add Employee (POST)', type: 'n8n-nodes-base.webhook', typeVersion: 2.1,
    position: [-700, 0], webhookId: 'a1b2c3d4-0000-4000-8000-empaddpost01',
  });
  nodes.push({
    parameters: { mode: 'runOnceForAllItems', jsCode: authCheckCode() },
    id: 'emp-add-auth', name: 'Check Auth (Add)', type: 'n8n-nodes-base.code', typeVersion: 2, position: [-460, 0],
  });
  nodes.push(authIfNode('emp-add-if', 'Authorized? (Add)', [-220, 0]));
  nodes.push(respondNode('emp-add-401', 'Reject Unauthorized (Add)', [40, 140], {
    body: '={{ { "error": $json.auth_reason === "MANAGEMENT_API_KEY_NOT_CONFIGURED" ? "server misconfigured" : "unauthorized" } }}',
    code: '={{ $json.auth_reason === "MANAGEMENT_API_KEY_NOT_CONFIGURED" ? 500 : 401 }}',
  }));
  nodes.push({
    parameters: {
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Agents', mode: 'name' },
      options: { returnAllMatches: true },
    },
    id: 'emp-add-read', name: 'Read Agents (Add)', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7,
    position: [40, -140], credentials: SHEETS_CREDENTIAL,
  });
  nodes.push({
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `
// Validates the new-employee request and computes the next agent_id.
// Existing ids follow "A<n>" (see sheets-templates/Agents.csv); this keeps
// that convention rather than introducing a second id shape.

const body = $('Check Auth (Add)').first().json.body || {};
const existing = $input.all().map(i => i.json);

const errors = [];
const name = typeof body.name === 'string' ? body.name.trim() : '';
const phone = typeof body.phone === 'string' ? body.phone.replace(/[^0-9]/g, '') : '';
if (!name) errors.push('name is required');
if (!phone || phone.length < 8) errors.push('phone must be a valid number (digits only, with country code)');

const phoneTaken = existing.some(r => String(r.phone || '').replace(/[^0-9]/g, '') === phone && phone);
if (phoneTaken) errors.push('an employee with this phone already exists');

let maxN = 0;
for (const r of existing) {
  const m = /^A(\\d+)$/.exec(String(r.agent_id || ''));
  if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
}
const agentId = 'A' + (maxN + 1);

const nowIso = new Date().toISOString();
const maxOpen = Number.isFinite(Number(body.max_open_conversations)) && Number(body.max_open_conversations) > 0
  ? Math.floor(Number(body.max_open_conversations)) : 5;

// Accepts an array or a comma-string; normalizes to the same comma-string
// shape scripts/lib/assignment.js's parseAccountList() reads. Empty/omitted
// = unrestricted (eligible for every account) — see
// docs/FUTURE_SESSION_SCOPED_ASSIGNMENT.md.
const whatsappAccounts = Array.isArray(body.whatsapp_accounts)
  ? body.whatsapp_accounts.map(String).map(function (s) { return s.trim(); }).filter(Boolean).join(',')
  : (typeof body.whatsapp_accounts === 'string' ? body.whatsapp_accounts.trim() : '');

if (errors.length > 0) {
  return [{ json: { valid: false, errors } }];
}

return [{ json: {
  valid: true,
  row: {
    agent_id: agentId,
    name,
    phone,
    active: true,
    available: body.available === false ? false : true,
    max_open_conversations: maxOpen,
    open_conversations: 0,
    last_assigned_at: '',
    role: typeof body.role === 'string' && body.role ? body.role : 'agent',
    working_hours: typeof body.working_hours === 'string' && body.working_hours ? body.working_hours : '09:00-17:00',
    timezone: typeof body.timezone === 'string' && body.timezone ? body.timezone : ($env.TZ || 'Asia/Amman'),
    whatsapp_accounts: whatsappAccounts,
    created_at: nowIso,
    updated_at: nowIso,
  },
} }];
`.trim(),
    },
    id: 'emp-add-validate', name: 'Validate & Assign Id', type: 'n8n-nodes-base.code', typeVersion: 2, position: [260, -140],
  });
  nodes.push({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'valid-ok', leftValue: '={{ $json.valid }}', rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    },
    id: 'emp-add-validif', name: 'Valid?', type: 'n8n-nodes-base.if', typeVersion: 2.3, position: [480, -140],
  });
  nodes.push(respondNode('emp-add-400', 'Reject Invalid', [700, 0], { body: '={{ { "error": "validation failed", "details": $json.errors } }}', code: 400 }));
  nodes.push({
    parameters: {
      operation: 'append',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Agents', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          agent_id: '={{ $json.row.agent_id }}', name: '={{ $json.row.name }}', phone: '={{ $json.row.phone }}',
          active: '={{ $json.row.active }}', available: '={{ $json.row.available }}',
          max_open_conversations: '={{ $json.row.max_open_conversations }}', open_conversations: '={{ $json.row.open_conversations }}',
          last_assigned_at: '={{ $json.row.last_assigned_at }}', role: '={{ $json.row.role }}',
          working_hours: '={{ $json.row.working_hours }}', timezone: '={{ $json.row.timezone }}',
          whatsapp_accounts: '={{ $json.row.whatsapp_accounts }}',
          created_at: '={{ $json.row.created_at }}', updated_at: '={{ $json.row.updated_at }}',
        },
        matchingColumns: [],
        schema: sheetsSchema(['agent_id', 'name', 'phone', 'active', 'available', 'max_open_conversations', 'open_conversations', 'last_assigned_at', 'role', 'working_hours', 'timezone', 'whatsapp_accounts', 'created_at', 'updated_at']),
        attemptToConvertTypes: false, convertFieldsToString: true,
      },
      options: {},
    },
    id: 'emp-add-append', name: 'Append Employee', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7,
    position: [700, -140], credentials: SHEETS_CREDENTIAL, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
  });
  nodes.push(respondNode('emp-add-201', 'Respond Created', [920, -140], { body: '={{ $("Validate & Assign Id").first().json.row }}', code: 201 }));

  connections['Add Employee (POST)'] = { main: [[{ node: 'Check Auth (Add)', type: 'main', index: 0 }]] };
  connections['Check Auth (Add)'] = { main: [[{ node: 'Authorized? (Add)', type: 'main', index: 0 }]] };
  connections['Authorized? (Add)'] = {
    main: [
      [{ node: 'Read Agents (Add)', type: 'main', index: 0 }],
      [{ node: 'Reject Unauthorized (Add)', type: 'main', index: 0 }],
    ],
  };
  connections['Read Agents (Add)'] = { main: [[{ node: 'Validate & Assign Id', type: 'main', index: 0 }]] };
  connections['Validate & Assign Id'] = { main: [[{ node: 'Valid?', type: 'main', index: 0 }]] };
  connections['Valid?'] = {
    main: [
      [{ node: 'Append Employee', type: 'main', index: 0 }],
      [{ node: 'Reject Invalid', type: 'main', index: 0 }],
    ],
  };
  connections['Append Employee'] = { main: [[{ node: 'Respond Created', type: 'main', index: 0 }]] };

  // ---- POST /webhook/api/employees/update ----
  nodes.push({
    parameters: { httpMethod: 'POST', path: 'api/employees/update', responseMode: 'responseNode', options: {} },
    id: 'emp-upd-wh', name: 'Update Employee (POST)', type: 'n8n-nodes-base.webhook', typeVersion: 2.1,
    position: [-700, 320], webhookId: 'a1b2c3d4-0000-4000-8000-empupdpost01',
  });
  nodes.push({
    parameters: { mode: 'runOnceForAllItems', jsCode: authCheckCode() },
    id: 'emp-upd-auth', name: 'Check Auth (Update)', type: 'n8n-nodes-base.code', typeVersion: 2, position: [-460, 320],
  });
  nodes.push(authIfNode('emp-upd-if', 'Authorized? (Update)', [-220, 320]));
  nodes.push(respondNode('emp-upd-401', 'Reject Unauthorized Upd', [40, 460], {
    body: '={{ { "error": $json.auth_reason === "MANAGEMENT_API_KEY_NOT_CONFIGURED" ? "server misconfigured" : "unauthorized" } }}',
    code: '={{ $json.auth_reason === "MANAGEMENT_API_KEY_NOT_CONFIGURED" ? 500 : 401 }}',
  }));
  nodes.push({
    parameters: {
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Agents', mode: 'name' },
      options: { returnAllMatches: true },
    },
    id: 'emp-upd-read', name: 'Read Agents (Update)', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7,
    position: [40, 100], credentials: SHEETS_CREDENTIAL,
  });
  nodes.push({
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `
// Only known, non-identity fields may be changed here. agent_id itself is
// immutable (it's the join key every conversation row already points at).
//
// The Google Sheets "update" node sets every column it is given — a column
// whose value is undefined still overwrites the cell with blank (see the
// same note in workflow 7's Interpret Sheet Send). A partial PATCH must
// therefore read the row first and carry forward every field the caller did
// not ask to change, rather than only sending what changed.
const body = $('Check Auth (Update)').first().json.body || {};
const agentId = typeof body.agent_id === 'string' ? body.agent_id.trim() : '';
if (!agentId) {
  return [{ json: { valid: false, errors: ['agent_id is required'] } }];
}

const rows = $input.all().map(i => i.json);
const existing = rows.find(r => String(r.agent_id || '') === agentId);
if (!existing) {
  return [{ json: { valid: false, errors: ['no employee with agent_id ' + agentId], notFound: true } }];
}

const ALLOWED = ['name', 'phone', 'active', 'available', 'max_open_conversations', 'role', 'working_hours', 'timezone', 'whatsapp_accounts'];
const provided = ALLOWED.filter(k => Object.prototype.hasOwnProperty.call(body, k));
if (provided.length === 0) {
  return [{ json: { valid: false, errors: ['no updatable fields provided: ' + ALLOWED.join(', ')] } }];
}

const patch = { agent_id: agentId };
for (const k of ALLOWED) {
  patch[k] = provided.includes(k) ? body[k] : existing[k];
}
if (patch.phone) patch.phone = String(patch.phone).replace(/[^0-9]/g, '');
// Same array-or-comma-string normalization as create (Validate & Assign Id) —
// see docs/FUTURE_SESSION_SCOPED_ASSIGNMENT.md.
if (provided.includes('whatsapp_accounts')) {
  patch.whatsapp_accounts = Array.isArray(body.whatsapp_accounts)
    ? body.whatsapp_accounts.map(String).map(function (s) { return s.trim(); }).filter(Boolean).join(',')
    : (typeof body.whatsapp_accounts === 'string' ? body.whatsapp_accounts.trim() : '');
}
patch.updated_at = new Date().toISOString();

return [{ json: { valid: true, agent_id: agentId, patch, changed_fields: provided } }];
`.trim(),
    },
    id: 'emp-upd-validate', name: 'Validate Patch', type: 'n8n-nodes-base.code', typeVersion: 2, position: [260, 100],
  });
  nodes.push({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: 'v', leftValue: '={{ $json.valid }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
      options: {},
    },
    id: 'emp-upd-validif', name: 'Valid? (Update)', type: 'n8n-nodes-base.if', typeVersion: 2.3, position: [480, 100],
  });
  nodes.push(respondNode('emp-upd-400', 'Reject Invalid Upd', [700, 260], {
    body: '={{ { "error": "validation failed", "details": $json.errors } }}',
    code: '={{ $json.notFound ? 404 : 400 }}',
  }));
  nodes.push({
    parameters: {
      operation: 'update',
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Agents', mode: 'name' },
      columns: {
        mappingMode: 'defineBelow',
        // Explicit per-key mapping, not a single "={{ $json.patch }}"
        // expression — empirically, against this n8n version, the update
        // operation silently no-ops when the whole object is handed over
        // as one dynamic expression instead of individual column
        // expressions. Every other write node in this codebase (Append
        // Employee, Update Agent Load, and the pre-existing Increment
        // Agent Load in workflow 3) already uses this per-key shape; this
        // now matches that proven pattern instead of diverging from it.
        value: {
          agent_id: '={{ $json.patch.agent_id }}',
          name: '={{ $json.patch.name }}',
          phone: '={{ $json.patch.phone }}',
          active: '={{ $json.patch.active }}',
          available: '={{ $json.patch.available }}',
          max_open_conversations: '={{ $json.patch.max_open_conversations }}',
          role: '={{ $json.patch.role }}',
          working_hours: '={{ $json.patch.working_hours }}',
          timezone: '={{ $json.patch.timezone }}',
          whatsapp_accounts: '={{ $json.patch.whatsapp_accounts }}',
          updated_at: '={{ $json.patch.updated_at }}',
        },
        matchingColumns: ['agent_id'],
        schema: sheetsSchema(['agent_id', 'name', 'phone', 'active', 'available', 'max_open_conversations', 'role', 'working_hours', 'timezone', 'whatsapp_accounts', 'updated_at'], ['agent_id']),
        attemptToConvertTypes: false, convertFieldsToString: true,
      },
      options: {},
    },
    id: 'emp-upd-write', name: 'Update Employee Row', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7,
    position: [480, 220], credentials: SHEETS_CREDENTIAL, onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
  });
  nodes.push(respondNode('emp-upd-200', 'Respond Updated', [700, 220], { body: '={{ $("Validate Patch").first().json.patch }}' }));

  connections['Update Employee (POST)'] = { main: [[{ node: 'Check Auth (Update)', type: 'main', index: 0 }]] };
  connections['Check Auth (Update)'] = { main: [[{ node: 'Authorized? (Update)', type: 'main', index: 0 }]] };
  connections['Authorized? (Update)'] = {
    main: [
      [{ node: 'Read Agents (Update)', type: 'main', index: 0 }],
      [{ node: 'Reject Unauthorized Upd', type: 'main', index: 0 }],
    ],
  };
  connections['Read Agents (Update)'] = { main: [[{ node: 'Validate Patch', type: 'main', index: 0 }]] };
  connections['Validate Patch'] = { main: [[{ node: 'Valid? (Update)', type: 'main', index: 0 }]] };
  connections['Valid? (Update)'] = {
    main: [
      [{ node: 'Update Employee Row', type: 'main', index: 0 }],
      [{ node: 'Reject Invalid Upd', type: 'main', index: 0 }],
    ],
  };
  connections['Update Employee Row'] = { main: [[{ node: 'Respond Updated', type: 'main', index: 0 }]] };

  // ---- CORS preflight for both paths ----
  const [p1a, p1b] = optionsPreflightNodes('api/employees', [-700, 620], 'emp-cors1');
  const [p2a, p2b] = optionsPreflightNodes('api/employees/update', [-700, 780], 'emp-cors2');
  nodes.push(p1a, p1b, p2a, p2b);
  connections['CORS Preflight (api/employees)'] = { main: [[{ node: 'Ack Preflight', type: 'main', index: 0 }]] };
  // Two nodes share the name "Ack Preflight" across preflight pairs — n8n
  // connects by node NAME, so give the second pair a distinct name.
  p2b.name = 'Ack Preflight (Update)';
  connections['CORS Preflight (api/employees/update)'] = { main: [[{ node: 'Ack Preflight (Update)', type: 'main', index: 0 }]] };

  nodes.push(stickyNote('emp-note', 'Note',
    '## Workflow 9 — Employees API\n\n' +
    'Additive, no other workflow calls or is called by this one.\n\n' +
    '`GET /api/employees` — list\n' +
    '`POST /api/employees` — create (auto-assigns the next A<n> id)\n' +
    '`POST /api/employees/update` — patch name/phone/active/available/\n' +
    'max_open_conversations/role/working_hours/timezone. agent_id is\n' +
    'immutable — every conversation row already points at it.\n\n' +
    'Every path requires `X-Management-Key` matching `MANAGEMENT_API_KEY`.\n' +
    'Fails CLOSED: unset key -> 500, wrong key -> 401. No unsigned opt-out\n' +
    '(unlike the WhatsApp webhooks) — this surface has no HMAC/Meta signature\n' +
    'protecting it otherwise, and it reads/writes names and phone numbers.',
    [-700, -700], [640, 340]));

  return {
    id: 'whatsappEmpApi009',
    name: 'WhatsApp — 9 Employees API',
    nodes, connections,
    settings: { executionOrder: 'v1', saveManualExecutions: true, saveExecutionProgress: true, errorWorkflow: '' },
    tags: [],
  };
}

// ============================================================================
// 10 — Tasks API (conversations, framed as a to-do list)
// ============================================================================

function buildTasksApi() {
  const nodes = [];
  const connections = {};

  const TODO_MAP_CODE = `
// Frames each conversation's status as a to-do-list column, matching
// docs/FUTURE_TASKS_EMPLOYEES_AND_AI_AGENTS.md section 2 — no new data,
// just a view over the status field that already exists.
function column(status) {
  if (status === 'WAITING_FOR_AGENT') return 'backlog';
  if (status === 'UNANSWERED') return 'to_do';
  if (status === 'REPLIED' || status === 'WAITING_FOR_CUSTOMER') return 'waiting';
  if (status === 'CLOSED') return 'done';
  return 'other';
}
`.trim();

  // ---- GET /webhook/api/tasks?agent_id=&status= ----
  nodes.push({
    parameters: { httpMethod: 'GET', path: 'api/tasks', responseMode: 'responseNode', options: {} },
    id: 'task-list-wh', name: 'List Tasks (GET)', type: 'n8n-nodes-base.webhook', typeVersion: 2.1,
    position: [-700, -300], webhookId: 'a1b2c3d4-0000-4000-8000-tasklistget1',
  });
  nodes.push({
    parameters: { mode: 'runOnceForAllItems', jsCode: authCheckCode() },
    id: 'task-list-auth', name: 'Check Auth (List)', type: 'n8n-nodes-base.code', typeVersion: 2, position: [-460, -300],
  });
  nodes.push(authIfNode('task-list-if', 'Authorized? (List)', [-220, -300]));
  nodes.push(unauthorizedRespond('task-list-401', [40, -180]));
  nodes.push({
    parameters: {
      authentication: 'serviceAccount',
      documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
      sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
      options: { returnAllMatches: true },
    },
    id: 'task-list-read', name: 'Read Conversations (List)', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7,
    position: [40, -380], credentials: SHEETS_CREDENTIAL,
  });
  nodes.push({
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `
${TODO_MAP_CODE}

const query = $('Check Auth (List)').first().json.query || {};
const wantAgent = query.agent_id || null;
const wantStatus = query.status || null;

let rows = $input.all().map(i => i.json);
if (wantAgent) rows = rows.filter(r => String(r.assigned_agent_id || '') === String(wantAgent));
if (wantStatus) rows = rows.filter(r => String(r.status || '') === String(wantStatus));

const tasks = rows.map(r => ({
  conversation_id: r.conversation_id,
  customer_name: r.customer_name,
  customer_phone: r.customer_phone,
  assigned_agent_id: r.assigned_agent_id,
  assigned_agent_name: r.assigned_agent_name,
  status: r.status,
  column: column(r.status),
  last_message: r.last_message,
  unanswered_count: r.unanswered_count,
  first_message_at: r.first_message_at,
  last_activity_at: r.last_activity_at,
}));

// Newest activity first, matching the Sheet's own ordering convention.
tasks.sort((a, b) => String(b.last_activity_at || '').localeCompare(String(a.last_activity_at || '')));

return [{ json: { tasks } }];
`.trim(),
    },
    id: 'task-list-map', name: 'Map To To-Do Columns', type: 'n8n-nodes-base.code', typeVersion: 2, position: [280, -380],
  });
  nodes.push(respondNode('task-list-200', 'Respond Tasks', [500, -380], { body: '={{ $json.tasks }}' }));

  connections['List Tasks (GET)'] = { main: [[{ node: 'Check Auth (List)', type: 'main', index: 0 }]] };
  connections['Check Auth (List)'] = { main: [[{ node: 'Authorized? (List)', type: 'main', index: 0 }]] };
  connections['Authorized? (List)'] = {
    main: [
      [{ node: 'Read Conversations (List)', type: 'main', index: 0 }],
      [{ node: 'Reject Unauthorized', type: 'main', index: 0 }],
    ],
  };
  connections['Read Conversations (List)'] = { main: [[{ node: 'Map To To-Do Columns', type: 'main', index: 0 }]] };
  connections['Map To To-Do Columns'] = { main: [[{ node: 'Respond Tasks', type: 'main', index: 0 }]] };

  // ---- POST /webhook/api/tasks/close  { conversation_id } ----
  function closeReopenBranch(pathValue, targetStatus, idPrefix, yPos) {
    nodes.push({
      parameters: { httpMethod: 'POST', path: pathValue, responseMode: 'responseNode', options: {} },
      id: idPrefix + '-wh', name: (targetStatus === 'CLOSED' ? 'Close Task' : 'Reopen Task') + ' (POST)',
      type: 'n8n-nodes-base.webhook', typeVersion: 2.1,
      position: [-700, yPos], webhookId: 'a1b2c3d4-0000-4000-8000-' + idPrefix + '01',
    });
    nodes.push({
      parameters: { mode: 'runOnceForAllItems', jsCode: authCheckCode() },
      id: idPrefix + '-auth', name: 'Check Auth (' + targetStatus + ')', type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [-460, yPos],
    });
    nodes.push(authIfNode(idPrefix + '-if', 'Authorized? (' + targetStatus + ')', [-220, yPos]));
    nodes.push(respondNode(idPrefix + '-401', 'Reject Unauthorized ' + targetStatus, [40, yPos + 140], {
      body: '={{ { "error": $json.auth_reason === "MANAGEMENT_API_KEY_NOT_CONFIGURED" ? "server misconfigured" : "unauthorized" } }}',
      code: '={{ $json.auth_reason === "MANAGEMENT_API_KEY_NOT_CONFIGURED" ? 500 : 401 }}',
    }));
    nodes.push({
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: `
const body = $json.body || {};
const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id.trim() : '';
if (!conversationId) return [{ json: { valid: false, errors: ['conversation_id is required'] } }];
const nowIso = new Date().toISOString();
return [{ json: {
  valid: true,
  conversation_id: conversationId,
  patch: {
    conversation_id: conversationId,
    status: '${targetStatus}',
    closed_at: ${targetStatus === 'CLOSED' ? "nowIso" : "''"},
    updated_at: nowIso,
  },
} }];
`.trim(),
      },
      id: idPrefix + '-validate', name: 'Validate (' + targetStatus + ')', type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [40, yPos - 140],
    });
    nodes.push({
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [{ id: 'v', leftValue: '={{ $json.valid }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
          combinator: 'and',
        },
        options: {},
      },
      id: idPrefix + '-validif', name: 'Valid? (' + targetStatus + ')', type: 'n8n-nodes-base.if', typeVersion: 2.3,
      position: [260, yPos - 140],
    });
    nodes.push(respondNode(idPrefix + '-400', 'Reject Invalid ' + targetStatus, [480, yPos + 20], { body: '={{ { "error": "validation failed", "details": $json.errors } }}', code: 400 }));
    nodes.push({
      parameters: {
        operation: 'update',
        authentication: 'serviceAccount',
        documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
        sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
        columns: {
          mappingMode: 'defineBelow',
          // Explicit per-key mapping — see the comment on "Update Employee
          // Row" above for why a single "={{ $json.patch }}" expression is
          // not used here.
          value: {
            conversation_id: '={{ $json.patch.conversation_id }}',
            status: '={{ $json.patch.status }}',
            closed_at: '={{ $json.patch.closed_at }}',
            updated_at: '={{ $json.patch.updated_at }}',
          },
          matchingColumns: ['conversation_id'],
          schema: sheetsSchema(['conversation_id', 'status', 'closed_at', 'updated_at'], ['conversation_id']),
          attemptToConvertTypes: false, convertFieldsToString: true,
        },
        options: {},
      },
      id: idPrefix + '-write', name: 'Update Conversation Status (' + targetStatus + ')', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7,
      position: [480, yPos - 140], credentials: SHEETS_CREDENTIAL, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
    });
    // Re-fetch the conversation's agent, then recompute that ONE agent's
    // open_conversations the same way recalculateAgentLoad() does in
    // SetupSheet.gs — scoped to one agent instead of all of them, since only
    // one agent's load can possibly have changed.
    nodes.push({
      parameters: {
        authentication: 'serviceAccount',
        documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
        sheetName: { __rl: true, value: 'Conversations', mode: 'name' },
        options: { returnAllMatches: true },
      },
      id: idPrefix + '-readconv', name: 'Read All Conversations (' + targetStatus + ')', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7,
      position: [700, yPos - 140], credentials: SHEETS_CREDENTIAL, onError: 'continueRegularOutput',
    });
    nodes.push({
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: `
// Mirrors recalculateAgentLoad() in SetupSheet.gs: open = count of
// non-CLOSED, non-ARCHIVED conversations for the affected agent.
//
// IMPORTANT: this node's input is "Read All Conversations" — every row in
// the sheet, not the validated request. $json here would be whichever item
// happens to be current in a runOnceForAllItems context, NOT the
// conversation being closed. The conversation_id must be pulled explicitly
// from the Validate node by name, the same way "Respond" below does.
const conv = $('Validate (${targetStatus})').first().json.conversation_id;
const rows = $input.all().map(i => i.json);
const target = rows.find(r => r.conversation_id === conv);
const agentId = target && target.assigned_agent_id ? String(target.assigned_agent_id) : null;

if (!agentId) {
  console.log(JSON.stringify({ event: 'recompute_agent_load_skipped', conversation_id: conv, reason: 'no_assigned_agent' }));
  return [{ json: { has_agent: false } }];
}

const open = rows.filter(r =>
  r.assigned_agent_id === agentId &&
  r.status !== 'CLOSED' &&
  r.status !== 'ARCHIVED'
).length;

return [{ json: { has_agent: true, agent_id: agentId, open_conversations: open, updated_at: new Date().toISOString() } }];
`.trim(),
      },
      id: idPrefix + '-recompute', name: 'Recompute Agent Load (' + targetStatus + ')', type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [920, yPos - 140],
    });
    nodes.push({
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [{ id: 'ha', leftValue: '={{ $json.has_agent }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
          combinator: 'and',
        },
        options: {},
      },
      id: idPrefix + '-skipif', name: 'Has Agent? (' + targetStatus + ')', type: 'n8n-nodes-base.if', typeVersion: 2.3,
      position: [1140, yPos - 140],
    });
    nodes.push({
      parameters: {
        operation: 'update',
        authentication: 'serviceAccount',
        documentId: { __rl: true, value: '={{ $env.GOOGLE_SHEET_ID }}', mode: 'id' },
        sheetName: { __rl: true, value: 'Agents', mode: 'name' },
        columns: {
          mappingMode: 'defineBelow',
          value: { agent_id: '={{ $json.agent_id }}', open_conversations: '={{ $json.open_conversations }}', updated_at: '={{ $json.updated_at }}' },
          matchingColumns: ['agent_id'],
          schema: sheetsSchema(['agent_id', 'open_conversations', 'updated_at'], ['agent_id']),
          attemptToConvertTypes: false, convertFieldsToString: true,
        },
        options: {},
      },
      id: idPrefix + '-writeload', name: 'Update Agent Load (' + targetStatus + ')', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7,
      position: [1360, yPos - 260], credentials: SHEETS_CREDENTIAL, onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
    });
    nodes.push(respondNode(idPrefix + '-200', 'Respond ' + targetStatus, [1580, yPos - 140], { body: '={{ $("Validate (' + targetStatus + ')").first().json.patch }}' }));

    const N = targetStatus === 'CLOSED' ? 'Close Task' : 'Reopen Task';
    connections[N + ' (POST)'] = { main: [[{ node: 'Check Auth (' + targetStatus + ')', type: 'main', index: 0 }]] };
    connections['Check Auth (' + targetStatus + ')'] = { main: [[{ node: 'Authorized? (' + targetStatus + ')', type: 'main', index: 0 }]] };
    connections['Authorized? (' + targetStatus + ')'] = {
      main: [
        [{ node: 'Validate (' + targetStatus + ')', type: 'main', index: 0 }],
        [{ node: 'Reject Unauthorized ' + targetStatus, type: 'main', index: 0 }],
      ],
    };
    connections['Validate (' + targetStatus + ')'] = { main: [[{ node: 'Valid? (' + targetStatus + ')', type: 'main', index: 0 }]] };
    connections['Valid? (' + targetStatus + ')'] = {
      main: [
        [{ node: 'Update Conversation Status (' + targetStatus + ')', type: 'main', index: 0 }],
        [{ node: 'Reject Invalid ' + targetStatus, type: 'main', index: 0 }],
      ],
    };
    connections['Update Conversation Status (' + targetStatus + ')'] = { main: [[{ node: 'Read All Conversations (' + targetStatus + ')', type: 'main', index: 0 }]] };
    connections['Read All Conversations (' + targetStatus + ')'] = { main: [[{ node: 'Recompute Agent Load (' + targetStatus + ')', type: 'main', index: 0 }]] };
    connections['Recompute Agent Load (' + targetStatus + ')'] = { main: [[{ node: 'Has Agent? (' + targetStatus + ')', type: 'main', index: 0 }]] };
    connections['Has Agent? (' + targetStatus + ')'] = {
      main: [
        [{ node: 'Update Agent Load (' + targetStatus + ')', type: 'main', index: 0 }],
        // No assigned agent (e.g. a WAITING_FOR_AGENT conversation) — there
        // is no load to recompute, but the close/reopen itself already
        // succeeded and must still be answered. Same target, no dead end.
        [{ node: 'Respond ' + targetStatus, type: 'main', index: 0 }],
      ],
    };
    connections['Update Agent Load (' + targetStatus + ')'] = { main: [[{ node: 'Respond ' + targetStatus, type: 'main', index: 0 }]] };
  }

  closeReopenBranch('api/tasks/close', 'CLOSED', 'task-close', 200);
  closeReopenBranch('api/tasks/reopen', 'UNANSWERED', 'task-reopen', 700);

  // ---- CORS preflight ----
  const [c1a, c1b] = optionsPreflightNodes('api/tasks', [-700, 1100], 'task-cors0');
  const [c2a, c2b] = optionsPreflightNodes('api/tasks/close', [-700, 1260], 'task-cors1');
  const [c3a, c3b] = optionsPreflightNodes('api/tasks/reopen', [-700, 1420], 'task-cors2');
  c2b.name = 'Ack Preflight (Close)';
  c3b.name = 'Ack Preflight (Reopen)';
  nodes.push(c1a, c1b, c2a, c2b, c3a, c3b);
  connections['CORS Preflight (api/tasks)'] = { main: [[{ node: 'Ack Preflight', type: 'main', index: 0 }]] };
  connections['CORS Preflight (api/tasks/close)'] = { main: [[{ node: 'Ack Preflight (Close)', type: 'main', index: 0 }]] };
  connections['CORS Preflight (api/tasks/reopen)'] = { main: [[{ node: 'Ack Preflight (Reopen)', type: 'main', index: 0 }]] };

  nodes.push(stickyNote('task-note', 'Note',
    '## Workflow 10 — Tasks API\n\n' +
    'Conversations, framed as a to-do list — no new data. See\n' +
    'docs/FUTURE_TASKS_EMPLOYEES_AND_AI_AGENTS.md section 2.\n\n' +
    '`GET /api/tasks?agent_id=&status=` — list, mapped to backlog/to_do/\n' +
    'waiting/done\n' +
    '`POST /api/tasks/close` / `/api/tasks/reopen` — { conversation_id }\n\n' +
    'Close/reopen also recomputes the ONE affected agent\'s\n' +
    'open_conversations, the same arithmetic recalculateAgentLoad() in\n' +
    'SetupSheet.gs already uses (count of non-CLOSED, non-ARCHIVED rows) —\n' +
    'scoped to one agent instead of the whole sheet. Reply/send still goes\n' +
    'through workflow 4 or the Sheet\'s reply_text column; this workflow only\n' +
    'closes/reopens, it does not send messages.\n\n' +
    'Same auth as workflow 9: `X-Management-Key`, fails closed.',
    [-700, -700], [640, 340]));

  return {
    id: 'whatsappTaskApi010',
    name: 'WhatsApp — 10 Tasks API',
    nodes, connections,
    settings: { executionOrder: 'v1', saveManualExecutions: true, saveExecutionProgress: true, errorWorkflow: '' },
    tags: [],
  };
}

const employees = buildEmployeesApi();
const tasks = buildTasksApi();

fs.writeFileSync(path.join(OUT_DIR, '09-employees-api.json'), JSON.stringify(employees, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(OUT_DIR, '10-tasks-api.json'), JSON.stringify(tasks, null, 2) + '\n', 'utf8');
console.log('Wrote 09-employees-api.json (' + employees.nodes.length + ' nodes)');
console.log('Wrote 10-tasks-api.json (' + tasks.nodes.length + ' nodes)');
