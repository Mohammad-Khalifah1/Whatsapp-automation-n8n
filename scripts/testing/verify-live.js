#!/usr/bin/env node
/**
 * End-to-end verification against the RUNNING deployment.
 *
 * This is the check to run after any deploy. It talks to the real webhook over
 * HTTPS with correctly signed payloads and then reads the real spreadsheet, so
 * a pass here means the production path genuinely works — not that the code
 * compiles.
 *
 * What it proves, in order:
 *   1  verification handshake accepts the right token
 *   2  verification handshake rejects a wrong token
 *   3  an unsigned POST is rejected            (fails closed)
 *   4  a wrongly-signed POST is rejected
 *   5  a signed inbound message creates a conversation and a message row
 *   6  redelivering the same message_id creates nothing new   (idempotency)
 *   7  a second message from the same customer keeps the same agent
 *      and puts the conversation back to UNANSWERED           (stickiness)
 *   8  typing into reply_text sends and writes the outcome back
 *   9  status = ARCHIVED moves the row to Archive
 *  10  Conversations still has exactly its declared columns
 *
 * Test 8 sends to the synthetic number used by tests 5-7, so Meta rejects it
 * and the row ends FAILED with the reason recorded. That is the correct
 * outcome and it exercises the whole send path. Pass --real-send=<E.164> to
 * additionally send one genuine WhatsApp message to a number you control.
 *
 * Usage:
 *   node scripts/testing/verify-live.js
 *   node scripts/testing/verify-live.js --real-send=9627XXXXXXXX
 *
 * Secrets come from .env / .env.test.local and the service-account file named
 * by GOOGLE_SERVICE_ACCOUNT_FILE. Nothing secret is printed.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------- config ---

function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

const ENV = Object.assign(
  {},
  readEnvFile(path.join(ROOT, '.env')),
  readEnvFile(path.join(ROOT, '.env.test.local')),
  process.env
);

const HOST = ENV.VERIFY_HOST || '72-61-181-1.sslip.io';
const WEBHOOK_PATH = ENV.VERIFY_WEBHOOK_PATH || '/webhook/whatsapp/webhook';
const SHEET = ENV.GOOGLE_SHEET_ID;
const APP_SECRET = ENV.META_APP_SECRET;
const VERIFY_TOKEN = ENV.WEBHOOK_VERIFY_TOKEN;
const PHONE_NUMBER_ID = ENV.META_PHONE_NUMBER_ID;

const SA_FILE = ENV.GOOGLE_SERVICE_ACCOUNT_FILE ||
  path.join(ROOT, 'SHEETKEYS.TXT');

const realSendArg = process.argv.find((a) => a.startsWith('--real-send='));
const REAL_SEND = realSendArg ? realSendArg.split('=')[1].replace(/\D/g, '') : '';

// A synthetic customer, unique per run, so a rerun never collides with the
// rows left by the previous one.
const RUN = Date.now().toString().slice(-9);
const TEST_PHONE = '96279' + RUN.slice(0, 7);
const TEST_NAME = 'Verify ' + RUN;

// ------------------------------------------------------------- reporting ---

const results = [];
let failures = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  if (!ok) failures += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log('  ' + mark + '  ' + name + (detail && !ok ? '\n        ' + detail : ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ http ---

function request(options, body) {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    if (body) req.write(body);
    req.end();
  });
}

function get(pathname) {
  return request({ hostname: HOST, path: pathname, method: 'GET' });
}

/** POST a webhook payload, signed the way Meta signs it unless told otherwise. */
function postWebhook(payload, mode) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': raw.length,
    'User-Agent': 'facebookplatform/1.0',
  };
  if (mode !== 'unsigned') {
    const secret = mode === 'wrong' ? 'not-the-app-secret' : APP_SECRET;
    headers['X-Hub-Signature-256'] = 'sha256=' +
      crypto.createHmac('sha256', secret).update(raw).digest('hex');
  }
  return request({ hostname: HOST, path: WEBHOOK_PATH, method: 'POST', headers }, raw);
}

/** A minimal but structurally real Meta inbound text notification. */
function inboundText(messageId, text, atSeconds) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: ENV.META_WABA_ID || '0',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '15550000000',
            phone_number_id: PHONE_NUMBER_ID,
          },
          contacts: [{ profile: { name: TEST_NAME }, wa_id: TEST_PHONE }],
          messages: [{
            from: TEST_PHONE,
            id: messageId,
            timestamp: String(atSeconds),
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

// ---------------------------------------------------------------- sheets ---

const sa = JSON.parse(fs.readFileSync(SA_FILE, 'utf8'));
const b64url = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

function form(host, pathname, body) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: host, path: pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ raw: d }); } });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(body);
    req.end();
  });
}

let cachedToken = null;
async function sheetsToken() {
  if (cachedToken) return cachedToken;
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const unsigned = b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url(claims);
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const res = await form('oauth2.googleapis.com', '/token',
    'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + unsigned + '.' + sig);
  if (!res.access_token) throw new Error('service-account auth failed');
  cachedToken = res.access_token;
  return cachedToken;
}

async function sheets(method, pathname, body) {
  const token = await sheetsToken();
  const payload = body ? JSON.stringify(body) : null;
  const headers = { Authorization: 'Bearer ' + token };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'sheets.googleapis.com',
      path: '/v4/spreadsheets/' + SHEET + pathname,
      method, headers,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Read a tab as objects keyed by its header row, plus the 1-based row index. */
async function readTab(tab) {
  const r = await sheets('GET', '/values/' + encodeURIComponent(tab + '!A1:BZ5000'));
  const values = (r.body && r.body.values) || [];
  if (!values.length) return { header: [], rows: [] };
  const header = values[0].map((h) => String(h).trim());
  const rows = values.slice(1).map((v, i) => {
    const o = { _row: i + 2 };
    header.forEach((h, c) => { o[h] = v[c] === undefined ? '' : v[c]; });
    return o;
  }).filter((o) => header.some((h) => o[h] !== ''));
  return { header, rows };
}

async function writeCell(tab, row, header, column, value) {
  const col = header.indexOf(column);
  if (col === -1) throw new Error('no column ' + column + ' in ' + tab);
  const letter = (function (i) {
    let s = ''; i += 1;
    while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
    return s;
  })(col);
  return sheets('PUT',
    '/values/' + encodeURIComponent(tab + '!' + letter + row) + '?valueInputOption=RAW',
    { values: [[value]] });
}

/**
 * Poll until `predicate` is satisfied. The scheduled workflows run once a
 * minute, so anything they do needs a window longer than that.
 */
async function waitFor(label, seconds, predicate) {
  const deadline = Date.now() + seconds * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(6000);
  }
  return null;
}

// ------------------------------------------------------------------ main ---

async function main() {
  for (const [name, value] of [['GOOGLE_SHEET_ID', SHEET], ['META_APP_SECRET', APP_SECRET],
    ['WEBHOOK_VERIFY_TOKEN', VERIFY_TOKEN], ['META_PHONE_NUMBER_ID', PHONE_NUMBER_ID]]) {
    if (!value) {
      console.error('Missing ' + name + '. Set it in .env or .env.test.local.');
      process.exit(2);
    }
  }

  console.log('Verifying https://' + HOST + WEBHOOK_PATH);
  console.log('Synthetic customer: ' + TEST_PHONE + '\n');

  // --- 1 & 2: the verification handshake -----------------------------------
  console.log('Webhook verification');
  const okHandshake = await get(WEBHOOK_PATH +
    '?hub.mode=subscribe&hub.verify_token=' + encodeURIComponent(VERIFY_TOKEN) +
    '&hub.challenge=' + RUN);
  record('handshake echoes the challenge for the correct token',
    okHandshake.status === 200 && okHandshake.body.trim() === RUN,
    'got ' + okHandshake.status + ' ' + okHandshake.body.slice(0, 60));

  const badHandshake = await get(WEBHOOK_PATH +
    '?hub.mode=subscribe&hub.verify_token=definitely-wrong&hub.challenge=' + RUN);
  record('handshake refuses a wrong token',
    badHandshake.status === 403 || badHandshake.status === 401,
    'got ' + badHandshake.status);

  // --- 3 & 4: signature enforcement ----------------------------------------
  console.log('\nSignature enforcement');
  const unsigned = await postWebhook(inboundText('wamid.UNSIGNED.' + RUN, 'unsigned', Math.floor(Date.now() / 1000)), 'unsigned');
  record('unsigned POST is rejected',
    unsigned.status === 401 || unsigned.status === 403,
    'got ' + unsigned.status + ' — an unsigned webhook must never be processed');

  const forged = await postWebhook(inboundText('wamid.FORGED.' + RUN, 'forged', Math.floor(Date.now() / 1000)), 'wrong');
  record('wrongly-signed POST is rejected',
    forged.status === 401 || forged.status === 403,
    'got ' + forged.status);

  // --- 5: a real inbound message becomes a conversation --------------------
  console.log('\nInbound message');
  const msg1 = 'wamid.VERIFY1.' + RUN;
  const post1 = await postWebhook(inboundText(msg1, 'First message from the verification run', Math.floor(Date.now() / 1000)));
  record('signed POST is accepted', post1.status === 200, 'got ' + post1.status);

  const conv = await waitFor('conversation row', 90, async () => {
    const { rows } = await readTab('Conversations');
    return rows.find((r) => r.customer_phone === TEST_PHONE) || null;
  });
  record('a conversation row is created for the customer', !!conv,
    'no Conversations row for ' + TEST_PHONE + ' after 90s');

  if (conv) {
    record('the conversation is waiting for a reply',
      conv.status === 'UNANSWERED' || conv.status === 'WAITING_FOR_AGENT',
      'status = ' + (conv.status || '(empty)'));
    record('the conversation is assigned to an agent', !!conv.assigned_agent_name,
      'assigned_agent_name is empty — check Agents has an active, available row');
    record('the customer name from WhatsApp is recorded', conv.customer_name === TEST_NAME,
      'customer_name = ' + conv.customer_name);
    record('first contact time is recorded', !!conv.first_message_at,
      'first_message_at is empty');
  }

  // The Messages row is written after the conversation row, so give the same
  // execution a moment to finish rather than reading mid-flight.
  const logged = await waitFor('message row', 60, async () => {
    const { rows } = await readTab('Messages');
    return rows.some((r) => r.message_id === msg1) || null;
  });
  record('the message itself is logged', !!logged,
    'no Messages row with message_id ' + msg1);

  // --- 6: redelivery must not duplicate ------------------------------------
  console.log('\nIdempotency');
  const countBefore = (await readTab('Conversations')).rows.filter((r) => r.customer_phone === TEST_PHONE).length;
  const msgBefore = (await readTab('Messages')).rows.filter((r) => r.message_id === msg1).length;
  const repost = await postWebhook(inboundText(msg1, 'First message from the verification run', Math.floor(Date.now() / 1000)));
  record('redelivered webhook is still acknowledged', repost.status === 200, 'got ' + repost.status);
  await sleep(20000);
  const countAfter = (await readTab('Conversations')).rows.filter((r) => r.customer_phone === TEST_PHONE).length;
  const msgAfter = (await readTab('Messages')).rows.filter((r) => r.message_id === msg1).length;
  record('redelivery creates no second conversation', countAfter === countBefore,
    countBefore + ' -> ' + countAfter);
  record('redelivery creates no second message row', msgAfter === msgBefore,
    msgBefore + ' -> ' + msgAfter);

  // --- 7: the assigned agent sticks ----------------------------------------
  console.log('\nAgent stickiness');
  const agentFirst = conv ? conv.assigned_agent_name : '';
  const msg2 = 'wamid.VERIFY2.' + RUN;
  await postWebhook(inboundText(msg2, 'Second message from the same customer', Math.floor(Date.now() / 1000)));
  const conv2 = await waitFor('second message applied', 90, async () => {
    const { rows } = await readTab('Conversations');
    const r = rows.find((x) => x.customer_phone === TEST_PHONE);
    return r && r.last_message === 'Second message from the same customer' ? r : null;
  });
  record('the second message updates the same conversation', !!conv2,
    'last_message never became the second message');
  if (conv2) {
    record('the same agent keeps the conversation', conv2.assigned_agent_name === agentFirst,
      agentFirst + ' -> ' + conv2.assigned_agent_name);
    record('a new customer message returns the status to UNANSWERED',
      conv2.status === 'UNANSWERED', 'status = ' + conv2.status);
  }

  // --- 8: replying from the sheet ------------------------------------------
  console.log('\nReply from the sheet');
  const convTab = await readTab('Conversations');
  const target = convTab.rows.find((r) => r.customer_phone === TEST_PHONE);
  if (target) {
    await writeCell('Conversations', target._row, convTab.header, 'reply_text',
      'Reply typed into the sheet by the verification run.');
    const replied = await waitFor('reply processed', 150, async () => {
      const { rows } = await readTab('Conversations');
      const r = rows.find((x) => x.customer_phone === TEST_PHONE);
      return r && r.reply_status ? r : null;
    });
    record('typing into reply_text is picked up and acted on', !!replied,
      'reply_status stayed empty for 150s');
    if (replied) {
      // The synthetic number is not a real WhatsApp user, so Meta refuses it.
      // FAILED-with-a-reason is the correct result and proves the whole path.
      record('the outcome is written back to the same row',
        replied.reply_status === 'SENT' || replied.reply_status === 'FAILED',
        'reply_status = ' + replied.reply_status);
      record('reply_text is cleared so the text is not sent twice',
        replied.reply_text === '', 'reply_text = ' + replied.reply_text);
      if (replied.reply_status === 'FAILED') {
        record('a failure records why', !!replied.reply_error,
          'reply_error is empty');
      }
    }
  } else {
    record('typing into reply_text is picked up and acted on', false, 'no row to reply to');
  }

  // --- 8b: optional genuine send -------------------------------------------
  if (REAL_SEND) {
    console.log('\nReal WhatsApp send to ' + REAL_SEND);
    const tab = await readTab('Conversations');
    // Write at a computed row rather than using values:append. With a
    // single-cell range, append decides for itself where the table is, and it
    // put the new row ABOVE row 1 - which pushed the header down and broke
    // every column lookup in the running system until it was repaired.
    const lastRow = tab.rows.length ? Math.max.apply(null, tab.rows.map((r) => r._row)) : 1;
    const targetRow = lastRow + 1;
    const lastCol = (function (i) {
      let out = ''; let n = i;
      while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
      return out;
    })(tab.header.length);
    const appendRes = await sheets('PUT',
      '/values/' + encodeURIComponent('Conversations!A' + targetRow + ':' + lastCol + targetRow) +
      '?valueInputOption=RAW',
      { values: [tab.header.map((h) => {
        if (h === 'customer_name') return 'Live Send ' + RUN;
        if (h === 'customer_phone') return REAL_SEND;
        if (h === 'reply_text') return 'Verification run ' + RUN + ': this message was sent from the Google Sheet.';
        return '';
      })] });
    record('a hand-typed row can be added', appendRes.status === 200, 'HTTP ' + appendRes.status);
    const sent = await waitFor('real send', 150, async () => {
      const { rows } = await readTab('Conversations');
      const r = rows.find((x) => x.customer_name === 'Live Send ' + RUN);
      return r && r.reply_status ? r : null;
    });
    record('a hand-typed row sends a real WhatsApp message',
      !!sent && sent.reply_status === 'SENT',
      sent ? 'reply_status = ' + sent.reply_status + ' ' + (sent.reply_error || '') : 'no outcome after 150s');
  }

  // --- 9: archiving ---------------------------------------------------------
  console.log('\nArchiving');
  const beforeArchive = await readTab('Conversations');
  const toArchive = beforeArchive.rows.find((r) => r.customer_phone === TEST_PHONE);
  if (toArchive) {
    await writeCell('Conversations', toArchive._row, beforeArchive.header, 'status', 'ARCHIVED');
    const moved = await waitFor('archive move', 150, async () => {
      const conversations = await readTab('Conversations');
      const archive = await readTab('Archive');
      const goneFromConversations = !conversations.rows.some((r) => r.customer_phone === TEST_PHONE);
      const inArchive = archive.rows.find((r) => r.customer_phone === TEST_PHONE);
      return goneFromConversations && inArchive ? inArchive : null;
    });
    record('ARCHIVED moves the row out of Conversations and into Archive', !!moved,
      'the row was still in Conversations, or never reached Archive, after 150s');
    if (moved) {
      record('the archived row records when it was archived', !!moved.archived_at,
        'archived_at is empty');
      record('the archived row keeps the customer data',
        moved.customer_name === TEST_NAME, 'customer_name = ' + moved.customer_name);
    }
  } else {
    record('ARCHIVED moves the row out of Conversations and into Archive', false,
      'no row to archive');
  }

  // --- 10: the sheet keeps its declared shape -------------------------------
  console.log('\nSheet integrity');
  const declared = fs.readFileSync(path.join(ROOT, 'sheets-templates', 'Conversations.csv'), 'utf8')
    .split(/\r?\n/)[0].split(',').map((s) => s.trim()).filter(Boolean);
  const live = (await readTab('Conversations')).header;
  record('Conversations has exactly its declared columns',
    live.length === declared.length && live.every((c, i) => c === declared[i]),
    'declared ' + declared.length + ', live ' + live.length +
    (live.length > declared.length ? ' — extra: ' + live.slice(declared.length).join(', ') : ''));

  const declaredArchive = declared.concat(['archived_at']);
  const liveArchive = (await readTab('Archive')).header;
  record('Archive has exactly its declared columns',
    liveArchive.length === declaredArchive.length &&
    liveArchive.every((c, i) => c === declaredArchive[i]),
    'declared ' + declaredArchive.length + ', live ' + liveArchive.length);

  // --- summary --------------------------------------------------------------
  console.log('\n' + '-'.repeat(64));
  console.log('  ' + (results.length - failures) + ' passed, ' + failures +
              ' failed, ' + results.length + ' checks');
  console.log('-'.repeat(64));
  if (failures) {
    console.log('\nFailed:');
    for (const r of results.filter((x) => !x.ok)) {
      console.log('  - ' + r.name + (r.detail ? '\n      ' + r.detail : ''));
    }
  }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('\nverification aborted: ' + e.message);
  process.exit(2);
});
