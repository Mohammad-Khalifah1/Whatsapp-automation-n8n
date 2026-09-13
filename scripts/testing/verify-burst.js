#!/usr/bin/env node
/**
 * Prove that nothing is lost when several messages arrive at the same moment.
 *
 * This is the test that found the worst bug in the system. Two webhooks posted
 * simultaneously returned HTTP 200 each, and only one of them ever became a
 * conversation: no row, no message, no log entry, no error. Two customers
 * messaging at the same second, one of them silently ignored — the exact
 * failure a support desk cannot tolerate and cannot notice.
 *
 * There were two causes, both of them a limit that DROPPED rather than queued:
 *   - the Execute Workflow handoff ran fire-and-forget, so the parent execution
 *     ended before the sub-workflow had started
 *   - N8N_CONCURRENCY_PRODUCTION_LIMIT=1, set to serialise assignment, threw
 *     away everything over the limit
 *
 * So this posts a burst and then insists that every single message is present.
 * It is the regression test for both.
 *
 * Usage:
 *   node scripts/testing/verify-burst.js          # 3 customers x 2 messages
 *   node scripts/testing/verify-burst.js 5 3      # 5 customers x 3 messages
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

const ENV = Object.assign({}, readEnvFile(path.join(ROOT, '.env')), process.env);
const HOST = ENV.VERIFY_HOST || '72-61-181-1.sslip.io';
const WEBHOOK_PATH = ENV.VERIFY_WEBHOOK_PATH || '/webhook/whatsapp/webhook';
const SHEET = ENV.GOOGLE_SHEET_ID;
const SA_FILE = ENV.GOOGLE_SERVICE_ACCOUNT_FILE || path.join(ROOT, 'SHEETKEYS.TXT');

const CUSTOMERS = Number(process.argv[2] || 3);
const PER_CUSTOMER = Number(process.argv[3] || 2);
const RUN = Date.now().toString().slice(-9);

const results = [];
let failures = 0;
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  if (!ok) failures += 1;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail && !ok ? '\n        ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ http ---

function post(phone, name, id, text) {
  const payload = { object: 'whatsapp_business_account', entry: [{ id: ENV.META_WABA_ID || '0', changes: [{
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: ENV.META_BUSINESS_PHONE || '15550000000', phone_number_id: ENV.META_PHONE_NUMBER_ID },
      contacts: [{ profile: { name }, wa_id: phone }],
      messages: [{ from: phone, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    },
  }] }] };
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  return new Promise((resolve) => {
    const req = https.request({
      hostname: HOST, path: WEBHOOK_PATH, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': raw.length,
        'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', ENV.META_APP_SECRET).update(raw).digest('hex'),
      },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', (e) => resolve('ERR ' + e.message));
    req.write(raw); req.end();
  });
}

// ---------------------------------------------------------------- sheets ---

const sa = JSON.parse(fs.readFileSync(SA_FILE, 'utf8'));
const b64url = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

function httpsJson(options, body) {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    if (body) req.write(body);
    req.end();
  });
}

let token = null;
async function auth() {
  if (token) return token;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const body = 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + unsigned + '.' + sig;
  const res = await httpsJson({
    hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  if (!res.body.access_token) throw new Error('service-account auth failed');
  token = res.body.access_token;
  return token;
}

async function readTab(tab) {
  const t = await auth();
  const res = await httpsJson({
    hostname: 'sheets.googleapis.com',
    path: '/v4/spreadsheets/' + SHEET + '/values/' + encodeURIComponent(tab + '!A1:BZ5000'),
    method: 'GET', headers: { Authorization: 'Bearer ' + t },
  });
  const values = (res.body && res.body.values) || [];
  if (!values.length) return [];
  const header = values[0].map((h) => String(h).trim());
  return values.slice(1).filter((v) => v.join('').trim() !== '').map((v) => {
    const o = {};
    header.forEach((h, c) => { o[h] = v[c] === undefined ? '' : v[c]; });
    return o;
  });
}

async function waitFor(seconds, predicate) {
  const deadline = Date.now() + seconds * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last && last.done) return last;
    await sleep(8000);
  }
  return last;
}

// ------------------------------------------------------------------ main ---

async function main() {
  for (const [name, value] of [['GOOGLE_SHEET_ID', SHEET], ['META_APP_SECRET', ENV.META_APP_SECRET],
    ['META_PHONE_NUMBER_ID', ENV.META_PHONE_NUMBER_ID]]) {
    if (!value) { console.error('Missing ' + name); process.exit(2); }
  }

  const total = CUSTOMERS * PER_CUSTOMER;
  const sends = [];
  const expected = [];
  for (let c = 0; c < CUSTOMERS; c += 1) {
    const phone = '9627' + (c % 10) + RUN.slice(0, 7);
    for (let m = 0; m < PER_CUSTOMER; m += 1) {
      const id = 'wamid.BURST' + c + '-' + m + '.' + RUN;
      const text = 'burst ' + RUN + ' c' + c + ' m' + m;
      expected.push({ phone, id, text });
      sends.push(() => post(phone, 'Burst' + c + ' ' + RUN, id, text));
    }
  }

  console.log('Posting ' + total + ' webhooks at once — ' + CUSTOMERS +
              ' customers, ' + PER_CUSTOMER + ' messages each\n');

  // All at once. Not staggered, not throttled: this is the point.
  const codes = await Promise.all(sends.map((f) => f()));
  const accepted = codes.filter((c) => c === 200).length;
  record('every webhook is accepted', accepted === total, accepted + ' of ' + total + ' returned 200');

  // A burst takes longer than one message: allow generously, then insist.
  const outcome = await waitFor(240, async () => {
    const messages = await readTab('Messages');
    const ids = new Set(messages.map((r) => r.message_id));
    const missing = expected.filter((e) => !ids.has(e.id));
    return { done: missing.length === 0, missing, messages };
  });

  record('every message is recorded — none silently dropped',
    outcome && outcome.missing.length === 0,
    outcome ? outcome.missing.length + ' of ' + total + ' never appeared: ' +
      outcome.missing.map((e) => e.text).join(', ') : 'could not read Messages');

  const conversations = await readTab('Conversations');
  const phones = Array.from(new Set(expected.map((e) => e.phone)));

  const withoutRow = phones.filter((p) => !conversations.some((r) => r.customer_phone === p));
  record('every customer has a conversation', withoutRow.length === 0,
    'no row for: ' + withoutRow.join(', '));

  // A duplicate is not a failure here - workflow 8 folds them within a minute -
  // but it IS worth reporting, because it is the cost of not dropping anything.
  const duplicated = phones.filter((p) =>
    conversations.filter((r) => r.customer_phone === p).length > 1);
  if (duplicated.length) {
    console.log('\n  note: ' + duplicated.length + ' customer(s) got a duplicate row.');
    console.log('  That is expected under a burst — Google Sheets has no compare-and-set.');
    console.log('  Workflow 8 folds them back together on its next sweep.');
  }

  const backlogs = phones.map((p) => {
    const rows = conversations.filter((r) => r.customer_phone === p);
    return rows.reduce((n, r) => n + Number(r.unanswered_count || 0), 0);
  });
  record('every message reaches a backlog',
    backlogs.every((n) => n === PER_CUSTOMER),
    'expected ' + PER_CUSTOMER + ' each, got ' + backlogs.join(', '));

  console.log('\n' + '-'.repeat(64));
  console.log('  ' + (results.length - failures) + ' passed, ' + failures + ' failed, ' + results.length + ' checks');
  console.log('-'.repeat(64));
  if (failures) {
    console.log('\nFailed:');
    for (const r of results.filter((x) => !x.ok)) {
      console.log('  - ' + r.name + (r.detail ? '\n      ' + r.detail : ''));
    }
  }
  console.log('\nClean up with:  node scripts/testing/clean-test-rows.js --dry-run');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('\naborted: ' + e.message); process.exit(2); });
