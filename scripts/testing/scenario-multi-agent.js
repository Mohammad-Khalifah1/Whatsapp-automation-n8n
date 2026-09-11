#!/usr/bin/env node
/**
 * Multi-agent, multi-message scenario test against a LIVE deployment.
 *
 * Proves the two behaviours a support desk actually depends on:
 *
 *   1. DISTRIBUTION — three different customers arriving in sequence are
 *      spread across three agents rather than piling onto one.
 *   2. STICKINESS — when the SAME customer sends a second and third message,
 *      the conversation stays with the agent already handling it. A support
 *      desk that reshuffles the owner mid-conversation is worse than useless.
 *
 * It also checks that the conversation status returns to UNANSWERED on every
 * new customer message, which is what keeps follow-up visible.
 *
 * Sends real signed webhooks to the deployment; contacts no customer and
 * costs nothing. Reads the sheet back with the service account to verify.
 *
 * Usage:
 *   node scripts/testing/scenario-multi-agent.js
 *   WEBHOOK_BASE=https://your-host node scripts/testing/scenario-multi-agent.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const BASE = process.env.WEBHOOK_BASE || 'https://72-61-181-1.sslip.io';
const SECRET_FILE = process.env.APP_SECRET_FILE || path.join(ROOT, 'meta');
const SA_FILE = process.env.GOOGLE_SA_FILE || path.join(ROOT, 'SHEETKEYS.TXT');
const SHEET = process.env.GOOGLE_SHEET_ID || '1Ua2yvAwBlGIUyy0q6ZHgZuL3UygmZJi64_WXXkxAGlI';
const BIZ = process.env.META_PHONE_NUMBER_ID || '1385581811295002';

const CUSTOMERS = [
  { phone: '962791110001', name: 'Omar Khaled',  texts: ['مرحبا، بدي أعرف السعر.', 'في خصم؟', 'شكرا'] },
  { phone: '962791110002', name: 'Layla Nasser', texts: ['السلام عليكم', 'بدي أستفسر عن الطلب'] },
  { phone: '962791110003', name: 'Sami Odeh',    texts: ['هل التوصيل مجاني؟'] },
];

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(host, pathname, method, body, headers) {
  return new Promise((resolve) => {
    const h = Object.assign({}, headers || {});
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ hostname: host, path: pathname, method, headers: h }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve({ s: res.statusCode, b: JSON.parse(d) }); }
                            catch { resolve({ s: res.statusCode, b: d }); } });
    });
    req.on('error', (e) => resolve({ s: 0, b: { error: e.message } }));
    if (body) req.write(body);
    req.end();
  });
}

/** Send one inbound customer message, signed exactly as Meta signs it. */
async function sendMessage(secret, customer, text, seq) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: '102290129340398',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15556704231', phone_number_id: BIZ },
          contacts: [{ profile: { name: customer.name }, wa_id: customer.phone }],
          messages: [{
            from: customer.phone,
            id: 'wamid.SCENARIO' + Date.now() + seq,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const host = BASE.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return request(host, '/webhook/whatsapp/webhook', 'POST', raw, {
    'Content-Type': 'application/json',
    'X-Hub-Signature-256': sig,
    'User-Agent': 'facebookplatform/1.0 (+http://developers.facebook.com)',
  });
}

async function sheetsToken() {
  const sa = JSON.parse(fs.readFileSync(SA_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
                  aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64(claim);
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const r = await request('oauth2.googleapis.com', '/token', 'POST',
    'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + unsigned + '.' + sig,
    { 'Content-Type': 'application/x-www-form-urlencoded' });
  if (!r.b.access_token) throw new Error('sheets auth failed');
  return r.b.access_token;
}

async function readTab(token, tab, range) {
  const r = await request('sheets.googleapis.com',
    `/v4/spreadsheets/${SHEET}/values/${encodeURIComponent(tab + '!' + range)}`, 'GET', null,
    { Authorization: 'Bearer ' + token });
  const rows = r.b.values || [];
  if (rows.length < 2) return [];
  const h = rows[0];
  return rows.slice(1).map((row) => {
    const o = {};
    h.forEach((k, i) => { o[k] = row[i]; });
    return o;
  });
}

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log('  [ok]   ' + label); }
  else { fail += 1; console.log('  [FAIL] ' + label + (detail ? '\n         ' + detail : '')); }
}

(async () => {
  const secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  console.log('Scenario: 3 customers, 6 messages, against ' + BASE + '\n');

  // --- phase 1: first message from each customer, spaced so assignment
  //     (which runs with concurrency 1) settles between them ---
  console.log('Phase 1 — first contact from each customer');
  for (let i = 0; i < CUSTOMERS.length; i += 1) {
    const c = CUSTOMERS[i];
    const r = await sendMessage(secret, c, c.texts[0], 'a' + i);
    console.log('  ' + c.name.padEnd(14) + ' -> HTTP ' + r.s);
    await sleep(9000);
  }

  const token = await sheetsToken();
  let convs = await readTab(token, 'Conversations', 'A1:Z50');
  const mine = convs.filter((c) => CUSTOMERS.some((x) => x.phone === c.customer_phone));

  console.log('\n  Conversations created: ' + mine.length + ' of ' + CUSTOMERS.length);
  for (const c of mine) {
    console.log('    ' + (c.customer_name || '?').padEnd(14) +
                ' agent=' + (c.assigned_agent_name || '(none)').padEnd(10) +
                ' status=' + c.status);
  }

  check('one conversation per customer', mine.length === CUSTOMERS.length,
        'got ' + mine.length);
  check('every conversation has an agent', mine.every((c) => c.assigned_agent_id),
        mine.filter((c) => !c.assigned_agent_id).map((c) => c.customer_phone).join(', '));
  check('every conversation starts UNANSWERED', mine.every((c) => c.status === 'UNANSWERED'),
        mine.map((c) => c.status).join(', '));

  const agents = new Set(mine.map((c) => c.assigned_agent_id).filter(Boolean));
  check('work is spread across multiple agents (not all on one)',
        agents.size > 1, 'distinct agents: ' + Array.from(agents).join(', '));

  // remember who owns what, to prove stickiness next
  const owner = {};
  for (const c of mine) owner[c.customer_phone] = c.assigned_agent_id;

  // --- phase 2: follow-up messages from the same customers ---
  console.log('\nPhase 2 — follow-up messages from the same customers');
  for (let i = 0; i < CUSTOMERS.length; i += 1) {
    const c = CUSTOMERS[i];
    for (let j = 1; j < c.texts.length; j += 1) {
      const r = await sendMessage(secret, c, c.texts[j], 'b' + i + j);
      console.log('  ' + c.name.padEnd(14) + ' msg#' + (j + 1) + ' -> HTTP ' + r.s);
      await sleep(8000);
    }
  }

  convs = await readTab(token, 'Conversations', 'A1:Z50');
  const after = convs.filter((c) => CUSTOMERS.some((x) => x.phone === c.customer_phone));

  console.log('');
  check('no duplicate conversations after follow-ups',
        after.length === CUSTOMERS.length,
        'expected ' + CUSTOMERS.length + ', got ' + after.length);

  let stuck = true;
  for (const c of after) {
    if (owner[c.customer_phone] && c.assigned_agent_id !== owner[c.customer_phone]) {
      stuck = false;
      console.log('         ' + c.customer_phone + ' moved ' + owner[c.customer_phone] + ' -> ' + c.assigned_agent_id);
    }
  }
  check('conversation stays with the SAME agent across messages', stuck);
  check('status returns to UNANSWERED on a new customer message',
        after.every((c) => c.status === 'UNANSWERED'),
        after.map((c) => c.customer_name + '=' + c.status).join(', '));

  // last_message should be the most recent text sent by that customer
  let latest = true;
  for (const c of after) {
    const def = CUSTOMERS.find((x) => x.phone === c.customer_phone);
    if (def && c.last_message !== def.texts[def.texts.length - 1]) {
      latest = false;
      console.log('         ' + c.customer_name + ': "' + c.last_message + '" != "' + def.texts[def.texts.length - 1] + '"');
    }
  }
  check('last_message shows the most recent customer message', latest);
  check('unread is TRUE while awaiting a reply',
        after.every((c) => String(c.unread).toUpperCase() === 'TRUE'));

  // --- messages and log ---
  const msgs = await readTab(token, 'Messages', 'A1:Z200');
  const relevant = msgs.filter((m) => CUSTOMERS.some((x) => x.phone === m.sender_phone));
  const expected = CUSTOMERS.reduce((n, c) => n + c.texts.length, 0);
  console.log('');
  check('every message recorded (' + relevant.length + '/' + expected + ')',
        relevant.length >= expected, 'one row per message is expected');

  const ids = relevant.map((m) => m.message_id);
  check('no duplicate message rows', new Set(ids).size === ids.length);

  const log = await readTab(token, 'Log', 'A1:Z200');
  check('assignment decisions are audited', log.length > 0, log.length + ' log rows');

  console.log('\n' + '-'.repeat(60));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('-'.repeat(60) + '\n');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('scenario failed: ' + e.message); process.exit(1); });
