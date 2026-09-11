#!/usr/bin/env node
/**
 * Remove the rows the verification scripts leave behind. Nothing else.
 *
 * WHY THIS IS A SCRIPT AND NOT A ONE-LINER
 * It was a one-liner, and it matched test numbers with a regex over the phone
 * column. The pattern `9627[0-9](1[0-9]|21|55)[0-9]{5}` was meant to catch the
 * synthetic numbers the tests invent — and it also matched a real customer's
 * number, deleting 46 genuine message rows. A pattern over phone numbers cannot
 * distinguish a made-up number from a real one, because there is nothing in the
 * digits that says which is which.
 *
 * So this matches on what the tests actually control: the NAME they write.
 * Every verification script names its fixtures with a known prefix. A row whose
 * customer_name does not start with one of those is never touched, whatever its
 * number looks like.
 *
 * Messages have no name, so they are matched by conversation_id — the ids of
 * the conversations being removed — and by nothing else.
 *
 * Usage:
 *   node scripts/testing/clean-test-rows.js --dry-run    # always do this first
 *   node scripts/testing/clean-test-rows.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const DRY = process.argv.indexOf('--dry-run') !== -1;

/**
 * The exact prefixes the verification scripts write into customer_name.
 * Adding a test means adding its prefix here, deliberately.
 */
const TEST_NAME_PREFIXES = [
  'Verify ',            // scripts/testing/verify-live.js
  'Archive1 ', 'Archive2 ', 'Archive3 ',  // scripts/testing/verify-archive.js
  'Live Send ',         // verify-live.js --real-send
  'Backlog ',           // the unanswered-backlog check
  'Stick ',             // the stickiness check
];

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
const SHEET = ENV.GOOGLE_SHEET_ID;
const SA_FILE = ENV.GOOGLE_SERVICE_ACCOUNT_FILE || path.join(ROOT, 'SHEETKEYS.TXT');
if (!SHEET) { console.error('GOOGLE_SHEET_ID is not set'); process.exit(2); }

const header = (f) => fs.readFileSync(path.join(ROOT, 'sheets-templates', f), 'utf8')
  .split(/\r?\n/)[0].split(',').map((s) => s.trim()).filter(Boolean);

// ------------------------------------------------------------------- api ---

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
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
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

async function api(method, pathname, payload) {
  const t = await auth();
  const body = payload ? JSON.stringify(payload) : null;
  const headers = { Authorization: 'Bearer ' + t };
  if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
  const res = await httpsJson({
    hostname: 'sheets.googleapis.com', path: '/v4/spreadsheets/' + SHEET + pathname, method, headers,
  }, body);
  if (res.status >= 400) throw new Error(method + ' -> ' + res.status);
  return res.body;
}

async function readTab(tab) {
  const r = await api('GET', '/values/' + encodeURIComponent(tab + '!A1:BZ5000'));
  const values = r.values || [];
  if (!values.length) return { header: [], rows: [] };
  const head = values[0].map((h) => String(h).trim());
  const rows = values.slice(1).map((v) => {
    const o = {};
    head.forEach((h, c) => { o[h] = v[c] === undefined ? '' : v[c]; });
    o._raw = v;
    return o;
  }).filter((o) => o._raw.join('').trim() !== '');
  return { header: head, rows };
}

const isFixture = (name) =>
  TEST_NAME_PREFIXES.some((p) => String(name || '').startsWith(p));

// ------------------------------------------------------------------ main ---

(async () => {
  console.log('Removing verification fixtures' + (DRY ? ' (dry run)' : '') + '\n');

  const removedConversationIds = new Set();
  let total = 0;

  for (const [tab, file] of [['Conversations', 'Conversations.csv'], ['Archive', 'Archive.csv']]) {
    const cols = header(file);
    const { rows } = await readTab(tab);
    const drop = rows.filter((r) => isFixture(r.customer_name));
    const keep = rows.filter((r) => !isFixture(r.customer_name));

    for (const r of drop) if (r.conversation_id) removedConversationIds.add(r.conversation_id);

    console.log('  ' + tab.padEnd(14) + 'keep ' + keep.length + ', remove ' + drop.length);
    for (const r of drop) console.log('      - ' + r.customer_name + '  ' + r.customer_phone);
    total += drop.length;

    if (!DRY && drop.length) {
      await api('POST', '/values/' + encodeURIComponent(tab + '!A1:BZ5000') + ':clear', {});
      await api('PUT', '/values/' + encodeURIComponent(tab + '!A1') + '?valueInputOption=RAW',
        { values: [cols].concat(keep.map((r) => cols.map((c) => r[c] === undefined ? '' : r[c]))) });
    }
  }

  // Messages carry no name. They are removed only when they belong to a
  // conversation that was itself a fixture — never by guessing at the number.
  const cols = header('Messages.csv');
  const { rows } = await readTab('Messages');
  const drop = rows.filter((r) => removedConversationIds.has(r.conversation_id));
  const keep = rows.filter((r) => !removedConversationIds.has(r.conversation_id));
  console.log('  ' + 'Messages'.padEnd(14) + 'keep ' + keep.length + ', remove ' + drop.length +
              ' (belonging to ' + removedConversationIds.size + ' fixture conversations)');
  total += drop.length;

  if (!DRY && drop.length) {
    // Newest first, the order the tab is kept in.
    keep.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
    await api('POST', '/values/' + encodeURIComponent('Messages!A1:BZ5000') + ':clear', {});
    await api('PUT', '/values/' + encodeURIComponent('Messages!A1') + '?valueInputOption=RAW',
      { values: [cols].concat(keep.map((r) => cols.map((c) => r[c] === undefined ? '' : r[c]))) });
  }

  console.log('\n  ' + (DRY ? 'would remove ' : 'removed ') + total + ' rows');
  if (DRY) console.log('  run again without --dry-run to apply');
})().catch((e) => { console.error('failed: ' + e.message); process.exit(1); });
