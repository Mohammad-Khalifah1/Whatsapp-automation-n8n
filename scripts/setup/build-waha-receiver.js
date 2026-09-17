#!/usr/bin/env node
/**
 * Builds n8n/workflows/01b-waha-webhook-receiver.json — the WAHA (QR-code)
 * counterpart to workflow 1. See docs/WAHA_CONNECTOR.md for why this exists
 * and what it does and does not prove yet.
 *
 * Deliberately hand-authored, not wired into build-workflows.js's codegen
 * (scripts/lib/*.js inlining). It is new, additive, and unverified against a
 * real WhatsApp send/receive — see the doc's honesty section before trusting
 * it the way the Meta path (workflow 1) has been proven.
 *
 * Usage:
 *   node scripts/setup/build-waha-receiver.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'n8n', 'workflows', '01b-waha-webhook-receiver.json');

const verifyHmacCode = `// Verifies WAHA's webhook HMAC (X-Webhook-Hmac, SHA-512 over the raw body)
// and adapts the payload into the SAME envelope shape workflow 2's parser
// already expects from Meta (object/entry/changes/value.messages or
// value.message_echoes). This lets workflow 2, 3, and every Sheets write
// downstream run completely unmodified — only the receiver differs.
//
// Fail-closed, matching workflow 1's Meta path: a missing/wrong secret
// rejects the request rather than silently accepting unsigned traffic,
// unless ALLOW_UNSIGNED_WEBHOOKS=true (local testing only).

const crypto = require('crypto');

function safeEqual(a, b) {
  const bufA = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const bufB = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

const item = $input.first();
const json = item.json || {};
const headers = json.headers || {};

let rawBody = null;
if (item.binary && item.binary.data && item.binary.data.data) {
  rawBody = Buffer.from(item.binary.data.data, 'base64');
} else if (json.body !== undefined) {
  rawBody = Buffer.from(typeof json.body === 'string' ? json.body : JSON.stringify(json.body), 'utf8');
}

const secret = $env.WAHA_HMAC_SECRET;
const allowUnsigned = String($env.ALLOW_UNSIGNED_WEBHOOKS || '').trim().toLowerCase() === 'true';
const providedSig = headers['x-webhook-hmac'] || '';

let sigOk = false;
let reason = 'UNKNOWN';

if (allowUnsigned) {
  sigOk = true;
  reason = 'SIGNATURE_CHECK_DISABLED';
  console.log(JSON.stringify({ event: 'SECURITY_WARNING', message: 'ALLOW_UNSIGNED_WEBHOOKS=true — WAHA signature verification is DISABLED' }));
} else if (!secret || String(secret).trim() === '') {
  sigOk = false;
  reason = 'WAHA_HMAC_SECRET_NOT_CONFIGURED';
} else if (!providedSig) {
  sigOk = false;
  reason = 'MISSING_SIGNATURE_HEADER';
} else {
  const expected = crypto.createHmac('sha512', String(secret)).update(rawBody || Buffer.alloc(0)).digest('hex');
  sigOk = safeEqual(String(providedSig).toLowerCase(), expected);
  reason = sigOk ? 'SIGNATURE_VALID' : 'SIGNATURE_MISMATCH';
}

console.log(JSON.stringify({ event: 'waha_webhook_received', signature_ok: sigOk, reason }));

let parsed = null;
try {
  parsed = rawBody ? JSON.parse(rawBody.toString('utf8')) : (typeof json.body === 'object' ? json.body : null);
} catch (e) {
  parsed = (typeof json.body === 'object') ? json.body : null;
}

return [{ json: {
  signature_ok: sigOk,
  signature_reason: reason,
  status_code: sigOk ? 200 : (reason === 'WAHA_HMAC_SECRET_NOT_CONFIGURED' ? 500 : 401),
  body: parsed,
} }];
`;

const adaptCode = `// Adapts a WAHA "message" event into the Meta Cloud API webhook envelope
// shape, so workflow 2's existing parser (scripts/lib/webhook-parser.js)
// handles it unmodified. v1 scope: TEXT messages only — see
// docs/WAHA_CONNECTOR.md for what media/group messages do today (parsed as
// an unsupported placeholder, not dropped, not crashed on).
//
// payload.fromMe === true means the message was sent from the linked phone
// itself (the owner replying in the regular WhatsApp app while the session
// is connected) rather than through this system — mapped to message_echoes,
// reusing the exact mechanism workflow 2 already has for Meta Coexistence.

const body = $json.body || {};
const event = body.event;
const session = body.session || $env.WAHA_SESSION || 'default';
const payload = body.payload || {};

const waId = String(payload.from || payload.to || '').split('@')[0];
const businessId = 'waha:' + session;

function textOf(p) {
  return typeof p.body === 'string' && p.body !== '' ? p.body : null;
}

const base = {
  waba_id: businessId,
  field: 'messages',
  business_phone_number_id: businessId,
  business_display_phone_number: session,
};

let value = {};

if (event === 'message' && payload.fromMe !== true) {
  const text = textOf(payload);
  value = {
    metadata: { phone_number_id: businessId, display_phone_number: session },
    contacts: [{ wa_id: waId, profile: { name: null } }],
    messages: [{
      from: waId,
      id: payload.id || null,
      timestamp: payload.timestamp != null ? String(payload.timestamp) : null,
      type: 'text',
      text: { body: payload.hasMedia && !text ? '[media via WAHA — not yet parsed, see docs/WAHA_CONNECTOR.md]' : (text || '') },
    }],
  };
} else if (event === 'message' && payload.fromMe === true) {
  const text = textOf(payload);
  value = {
    message_echoes: [{
      id: payload.id || null,
      to: waId,
      from: businessId,
      timestamp: payload.timestamp != null ? String(payload.timestamp) : null,
      type: 'text',
      text: { body: text || '' },
    }],
  };
} else {
  // session.status and any other event type: record as unrecognised rather
  // than silently dropping it, same policy as workflow 2's own fallback.
  value = { unhandled_waha_event: event || null };
}

const envelope = {
  object: 'whatsapp_business_account',
  entry: [{ id: businessId, changes: [Object.assign({}, base, { value })] }],
};

return [{ json: { body: envelope } }];
`;

const workflow = {
  id: 'whatsappWahaRecv1b',
  name: 'WhatsApp — 1b WAHA Webhook Receiver',
  nodes: [
    {
      parameters: {
        httpMethod: 'POST',
        path: 'whatsapp/waha-incoming',
        responseMode: 'responseNode',
        options: { rawBody: true },
      },
      id: 'waha-wh-post',
      name: 'WAHA Events (POST)',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.1,
      position: [-460, 160],
      webhookId: 'a1b2c3d4-0000-4000-8000-wahaeventpost',
    },
    {
      parameters: { mode: 'runOnceForAllItems', jsCode: verifyHmacCode },
      id: 'waha-verify-hmac',
      name: 'Verify WAHA HMAC',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [-200, 160],
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [{
            id: 'waha-sig-ok',
            leftValue: '={{ $json.signature_ok }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          }],
          combinator: 'and',
        },
        options: {},
      },
      id: 'waha-if-sig',
      name: 'Signature Valid?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.3,
      position: [40, 160],
    },
    {
      parameters: { respondWith: 'text', responseBody: '', options: { responseCode: 200 } },
      id: 'waha-respond-200',
      name: 'Ack 200 Immediately',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.5,
      position: [300, 60],
    },
    {
      parameters: { respondWith: 'text', responseBody: 'invalid signature', options: { responseCode: '={{ $json.status_code }}' } },
      id: 'waha-respond-401',
      name: 'Reject',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.5,
      position: [300, 300],
    },
    {
      parameters: { mode: 'runOnceForAllItems', jsCode: adaptCode },
      id: 'waha-adapt',
      name: 'Adapt To Meta Envelope',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [560, 60],
    },
    {
      parameters: {
        workflowId: { __rl: true, value: 'whatsappProc0002', mode: 'id' },
        workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [] },
        options: { waitForSubWorkflow: true },
      },
      id: 'waha-call-processor',
      name: 'Hand Off To Processor',
      type: 'n8n-nodes-base.executeWorkflow',
      typeVersion: 1.3,
      position: [820, 60],
    },
    {
      parameters: {
        content:
          "## Workflow 1b — WAHA Webhook Receiver\n\nSecond entry point, alongside workflow 1 (Meta). WAHA calls this URL\ndirectly (`WHATSAPP_HOOK_URL` in docker-compose.yml) when\n`WHATSAPP_CONNECTOR=waha`.\n\n### Why it hands off to the SAME workflow 2\nRather than reimplementing dedup/assignment/Sheets logic for a second\nconnector, this normalizes WAHA's payload into the exact envelope shape\nworkflow 2 already parses from Meta. Everything downstream — dedup,\nconversation assignment (workflow 3), Sheets writes — runs unmodified.\n\n### Scope of this first cut — see docs/WAHA_CONNECTOR.md\nText messages only. Media messages are passed through as a labelled\nplaceholder rather than dropped or crashing. Not yet proven against a real\nscan-and-message round trip — only WAHA's container health and QR issuance\nare verified live.",
        height: 420,
        width: 620,
        color: 4,
      },
      id: 'waha-sticky',
      name: 'Note',
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [-460, -420],
    },
  ],
  connections: {
    'WAHA Events (POST)': { main: [[{ node: 'Verify WAHA HMAC', type: 'main', index: 0 }]] },
    'Verify WAHA HMAC': { main: [[{ node: 'Signature Valid?', type: 'main', index: 0 }]] },
    'Signature Valid?': {
      main: [
        [{ node: 'Ack 200 Immediately', type: 'main', index: 0 }],
        [{ node: 'Reject', type: 'main', index: 0 }],
      ],
    },
    'Ack 200 Immediately': { main: [[{ node: 'Adapt To Meta Envelope', type: 'main', index: 0 }]] },
    'Adapt To Meta Envelope': { main: [[{ node: 'Hand Off To Processor', type: 'main', index: 0 }]] },
  },
  settings: {
    executionOrder: 'v1',
    saveManualExecutions: true,
    saveExecutionProgress: true,
    errorWorkflow: '',
  },
  tags: [],
};

fs.writeFileSync(OUT, JSON.stringify(workflow, null, 2) + '\n', 'utf8');
console.log('Wrote ' + OUT);
