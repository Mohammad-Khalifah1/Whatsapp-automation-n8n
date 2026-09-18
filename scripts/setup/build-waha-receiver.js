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
// handles it unmodified.
//
// Group messages (chat id ending "@g.us") are explicitly recognised and
// SKIPPED, not misinterpreted — WAHA's payload.from for a group is the
// GROUP's id, with the actual sender in payload.participant. Earlier code
// split payload.from on "@" without checking this, which would have created
// a bogus "conversation" keyed on a group id used as if it were a customer
// phone number. Recorded as an unhandled event (visible in the Log sheet),
// not silently dropped.
//
// Media messages (payload.hasMedia) are typed from payload.media.mimetype —
// image/audio/video prefix, else "document" — with caption/filename/mime
// captured the same fields Meta's own parser already reads
// (m[type].caption, m[type].filename, m[type].mime_type). The media file
// itself is not downloaded, matching how Meta's own path only ever captures
// media_id/mime_type too (see scripts/lib/webhook-parser.js) — downloading
// and storing either connector's media is a separate, not-yet-built step.
//
// Broadcast/newsletter/channel senders (status@broadcast, @broadcast,
// @newsletter) are skipped the same way groups are — not a customer.
//
// LID senders ("<digits>@lid", WhatsApp's privacy-preserving id) are
// resolved via the raw event's key.remoteJidAlt, NOT used as-is: this
// project's phone normalization accepts a bare 14-15 digit string as a
// plausible foreign number, so an unresolved LID passed through would risk
// a reply routed to a different, possibly real, person. See
// docs/WAHA_REFERENCE.md. Unresolvable -> recorded and dropped, never
// guessed.
//
// payload.fromMe === true means the message was sent from the linked phone
// itself (the owner replying in the regular WhatsApp app while the session
// is connected) rather than through this system — mapped to message_echoes,
// reusing the exact mechanism workflow 2 already has for Meta Coexistence.

const body = $json.body || {};
const event = body.event;
const session = body.session || $env.WAHA_SESSION || 'default';
const payload = body.payload || {};

const rawFrom = String(payload.from || payload.to || '');
const isGroup = rawFrom.indexOf('@g.us') !== -1;
// Broadcast lists and newsletter/channel posts are not a customer — same
// "do not misinterpret as a phone number" reasoning as groups.
const isBroadcastOrChannel =
  rawFrom.indexOf('status@broadcast') !== -1 ||
  rawFrom.indexOf('@broadcast') !== -1 ||
  rawFrom.indexOf('@newsletter') !== -1;

// A LID ("Linked ID") sender: WhatsApp's privacy-preserving id instead of a
// phone number. NOWEB can pass payload.from as "<digits>@lid" unchanged.
// Those digits are NOT a phone number, but this project's own phone
// normalization accepts a bare 14-15 digit string as a plausible foreign
// E.164 number — so treating a LID as-is risks routing a reply to a
// different, possibly real, person. Resolve via the raw event's
// key.remoteJidAlt (present for 1:1 chats on the engine this project runs);
// unresolvable is NOT the same as safe-to-guess, so it is recorded and
// dropped instead of guessed at. See docs/WAHA_REFERENCE.md.
const isLid = rawFrom.indexOf('@lid') !== -1;
function resolveLid() {
  const raw = payload._data && payload._data.key ? payload._data.key : {};
  const alt = typeof raw.remoteJidAlt === 'string' ? raw.remoteJidAlt : '';
  if (!alt) return null;
  const digits = alt.split('@')[0].split(':')[0];
  return digits || null;
}

const waId = isLid ? (resolveLid() || rawFrom.split('@')[0]) : rawFrom.split('@')[0];
const lidUnresolved = isLid && !resolveLid();
const businessId = 'waha:' + session;

function textOf(p) {
  return typeof p.body === 'string' && p.body !== '' ? p.body : null;
}

/** Meta-style media type + type-keyed object (m.image = {...}), or null for plain text. */
function mediaOf(p) {
  if (!p.hasMedia) return null;
  const media = p.media || {};
  const mimetype = typeof media.mimetype === 'string' ? media.mimetype : '';
  let type = 'document';
  if (mimetype.indexOf('image/') === 0) type = 'image';
  else if (mimetype.indexOf('audio/') === 0) type = 'audio';
  else if (mimetype.indexOf('video/') === 0) type = 'video';
  const text = textOf(p);
  return {
    type,
    payload: {
      id: null, // WAHA gives a fetchable media.url, not a Meta-style media id — not downloaded yet
      mime_type: mimetype || null,
      caption: text || undefined,
      filename: typeof media.filename === 'string' ? media.filename : undefined,
    },
  };
}

const base = {
  waba_id: businessId,
  field: 'messages',
  business_phone_number_id: businessId,
  business_display_phone_number: session,
};

let value = {};

if (isGroup) {
  value = { unhandled_waha_event: 'group_message', group_id: waId, participant: payload.participant || null };
} else if (isBroadcastOrChannel) {
  value = { unhandled_waha_event: 'broadcast_or_channel', raw_from: rawFrom };
} else if (isLid && lidUnresolved) {
  // Fail closed: an unresolvable LID must never fall through to being
  // treated as a phone number. Visible in the Log sheet, not silently lost.
  value = { unhandled_waha_event: 'message_unresolved_lid', raw_from: rawFrom };
} else if (event === 'message' && payload.fromMe !== true) {
  const media = mediaOf(payload);
  const text = textOf(payload);
  const msg = {
    from: waId,
    id: payload.id || null,
    timestamp: payload.timestamp != null ? String(payload.timestamp) : null,
    type: media ? media.type : 'text',
  };
  if (media) {
    msg[media.type] = media.payload;
  } else {
    msg.text = { body: text || '' };
  }
  value = {
    metadata: { phone_number_id: businessId, display_phone_number: session },
    contacts: [{ wa_id: waId, profile: { name: null } }],
    messages: [msg],
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
