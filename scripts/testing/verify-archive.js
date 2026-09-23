#!/usr/bin/env node
/**
 * Prove archiving, against the running deployment.
 *
 * Archiving is the one operation that DELETES from Conversations, so it is the
 * one worth its own test. The risky part is a batch: deleting a row shifts
 * every row beneath it, so a batch that does not delete bottom-up removes the
 * wrong rows — and it removes them from a tab whose whole job is not losing
 * anything.
 *
 * What this proves:
 *   1  three real conversations arrive and sit in Conversations
 *   2  marking two of them ARCHIVED moves BOTH, in one sweep
 *   3  every column survives the move, including what a human typed
 *   4  archived_at is stamped
 *   5  the two are gone from Conversations — no duplicate left behind
 *   6  the third is untouched: same row, same agent, same status
 *   7  Archive still matches its declared columns afterwards
 *
 * Usage:
 *   node scripts/testing/verify-archive.js
 *
 * Reads config from .env and the service account from the file named by
 * GOOGLE_SERVICE_ACCOUNT_FILE. Prints no secrets. It creates its own
 * conversations from synthetic numbers and archives only those.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const { toCode, toLabel } = require('../lib/labels');

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

// The language this sheet is kept in: a status is written in its own words,
// so the column's validation accepts what this script types into it.
const LANG = String(ENV.SHEET_LANGUAGE || 'en').trim().toLowerCase();

const RUN = Date.now().toString().slice(-9);
const PHONES = ['96279' + RUN.slice(0, 7), '96278' + RUN.slice(0, 7), '96277' + RUN.slice(0, 7)];
const NAMES = PHONES.map((_, i) => 'Archive' + (i + 1) + ' ' + RUN);

const results = [];
let failures = 0;
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  if (!ok) failures += 1;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail && !ok ? '\n        ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ http ---

function request(options, body) {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    if (body) req.write(body);
    req.end();
  });
}

function sendMessage(phone, name, messageId, text) {
  const payload = { object: 'whatsapp_business_account', entry: [{ id: ENV.META_WABA_ID || '0', changes: [{
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: ENV.META_BUSINESS_PHONE || '15550000000', phone_number_id: ENV.META_PHONE_NUMBER_ID },
      contacts: [{ profile: { name }, wa_id: phone }],
      messages: [{ from: phone, id: messageId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    },
  }] }] };
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  return request({
    hostname: HOST, path: WEBHOOK_PATH, method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': raw.length,
      'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', ENV.META_APP_SECRET).update(raw).digest('hex'),
    },
  }, raw);
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

async function sheets(method, pathname, payload) {
  const t = await auth();
  const body = payload ? JSON.stringify(payload) : null;
  const headers = { Authorization: 'Bearer ' + t };
  if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
  return httpsJson({
    hostname: 'sheets.googleapis.com', path: '/v4/spreadsheets/' + SHEET + pathname, method, headers,
  }, body);
}

async function readTab(tab) {
  const r = await sheets('GET', '/values/' + encodeURIComponent(tab + '!A1:BZ2000'));
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

function letter(i) {
  let s = ''; let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

async function setCell(tab, row, header, column, value) {
  const c = header.indexOf(column);
  if (c === -1) throw new Error('no column ' + column);
  return sheets('PUT',
    '/values/' + encodeURIComponent(tab + '!' + letter(c) + row) + '?valueInputOption=RAW',
    { values: [[value]] });
}

async function waitFor(seconds, predicate) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const got = await predicate();
    if (got) return got;
    await sleep(6000);
  }
  return null;
}

// ------------------------------------------------------------------ main ---

async function main() {
  for (const [name, value] of [['GOOGLE_SHEET_ID', SHEET], ['META_APP_SECRET', ENV.META_APP_SECRET],
    ['META_PHONE_NUMBER_ID', ENV.META_PHONE_NUMBER_ID]]) {
    if (!value) { console.error('Missing ' + name); process.exit(2); }
  }

  console.log('Archiving, against https://' + HOST);
  console.log('Three synthetic customers: ' + PHONES.join(', ') + '\n');

  // --- 1: three conversations, each with something worth preserving ---------
  for (let i = 0; i < 3; i += 1) {
    await sendMessage(PHONES[i], NAMES[i], 'wamid.ARCH' + i + '.' + RUN, 'message for archive test ' + (i + 1));
    await sleep(3000);
  }

  const present = await waitFor(120, async () => {
    const { rows } = await readTab('Conversations');
    return PHONES.every((p) => rows.some((r) => r.customer_phone === p)) ? rows : null;
  });
  record('three conversations are created', !!present,
    'not all three reached Conversations within 120s');
  if (!present) { report(); return; }

  // Type something a human would type, so the move can be checked for data loss.
  let conv = await readTab('Conversations');
  for (let i = 0; i < 2; i += 1) {
    const row = conv.rows.find((r) => r.customer_phone === PHONES[i]);
    await setCell('Conversations', row._row, conv.header, 'product', 'Perfume ' + (i + 1));
    await setCell('Conversations', row._row, conv.header, 'quantity', String(i + 2));
  }

  conv = await readTab('Conversations');
  const before = PHONES.map((p) => conv.rows.find((r) => r.customer_phone === p));
  const untouchedBefore = before[2];
  record('a human can type into product and quantity',
    before[0].product === 'Perfume 1' && before[1].quantity === '3',
    'product/quantity did not take');

  // --- 2: archive TWO of them, in the same sweep ----------------------------
  console.log('\nMarking two of the three ARCHIVED');
  for (let i = 0; i < 2; i += 1) {
    await setCell('Conversations', before[i]._row, conv.header, 'status', toLabel('status', 'ARCHIVED', LANG));
  }

  const moved = await waitFor(180, async () => {
    const conversations = await readTab('Conversations');
    const archive = await readTab('Archive');
    const goneFromConversations = PHONES.slice(0, 2)
      .every((p) => !conversations.rows.some((r) => r.customer_phone === p));
    const inArchive = PHONES.slice(0, 2)
      .every((p) => archive.rows.some((r) => r.customer_phone === p));
    return goneFromConversations && inArchive ? { conversations, archive } : null;
  });
  record('both rows move in one sweep', !!moved,
    'after 180s one or both were still in Conversations, or had not reached Archive');
  if (!moved) { report(); return; }

  // --- 3, 4: the move preserves everything ----------------------------------
  for (let i = 0; i < 2; i += 1) {
    const src = before[i];
    const dst = moved.archive.rows.filter((r) => r.customer_phone === PHONES[i]);

    record('archived row ' + (i + 1) + ' arrives exactly once', dst.length === 1,
      'found ' + dst.length + ' copies in Archive');
    if (dst.length !== 1) continue;

    const a = dst[0];
    const fields = ['customer_name', 'customer_phone', 'assigned_agent_name', 'assigned_agent_id',
      'product', 'quantity', 'conversation_id', 'first_message_at', 'last_message',
      'unanswered_messages', 'unanswered_count'];
    const lost = fields.filter((f) => src[f] !== undefined && String(src[f]) !== String(a[f]));
    record('archived row ' + (i + 1) + ' keeps every field',
      lost.length === 0,
      lost.map((f) => f + ': "' + src[f] + '" -> "' + a[f] + '"').join('; '));

    record('archived row ' + (i + 1) + ' is stamped with archived_at', !!a.archived_at,
      'archived_at is empty');
  }

  // --- 5: nothing left behind ------------------------------------------------
  for (let i = 0; i < 2; i += 1) {
    record('archived row ' + (i + 1) + ' is gone from Conversations',
      !moved.conversations.rows.some((r) => r.customer_phone === PHONES[i]));
  }

  // --- 6: the one NOT archived is untouched ---------------------------------
  const untouchedAfter = moved.conversations.rows.find((r) => r.customer_phone === PHONES[2]);
  record('the conversation that was NOT archived is still there', !!untouchedAfter,
    'deleting two rows took a third with it — the bottom-up delete is wrong');
  if (untouchedAfter) {
    const drifted = ['customer_name', 'customer_phone', 'assigned_agent_name', 'status', 'last_message']
      .filter((f) => String(untouchedBefore[f]) !== String(untouchedAfter[f]));
    record('the untouched conversation is unchanged', drifted.length === 0,
      drifted.map((f) => f + ': "' + untouchedBefore[f] + '" -> "' + untouchedAfter[f] + '"').join('; '));
    record('the untouched conversation is not in Archive',
      !moved.archive.rows.some((r) => r.customer_phone === PHONES[2]));
  }

  // --- 7: Archive still matches its schema -----------------------------------
  const declared = fs.readFileSync(path.join(ROOT, 'sheets-templates', 'Archive.csv'), 'utf8')
    .split(/\r?\n/)[0].split(',').map((s) => s.trim()).filter(Boolean);
  record('Archive still has exactly its declared columns',
    moved.archive.header.length === declared.length &&
    moved.archive.header.every((c, i) => c === declared[i]),
    'declared ' + declared.length + ', live ' + moved.archive.header.length);

  // --- 8: the other way in — the sweep of long-closed conversations ---------
  //
  // Setting ARCHIVED is the deliberate path. The sweep is the unattended one:
  // anything CLOSED for longer than ARCHIVE_AFTER_DAYS goes the same way, with
  // nobody watching. It is worth its own check for exactly that reason.
  console.log('\nSweeping a conversation closed long ago');
  const days = Number(ENV.ARCHIVE_AFTER_DAYS || 30);
  const longAgo = new Date(Date.now() - (days + 5) * 86400000).toISOString();

  const leftover = await readTab('Conversations');
  const last = leftover.rows.find((r) => r.customer_phone === PHONES[2]);
  if (last) {
    await setCell('Conversations', last._row, leftover.header, 'closed_at', longAgo);
    await setCell('Conversations', last._row, leftover.header, 'status', toLabel('status', 'CLOSED', LANG));

    const swept = await waitFor(180, async () => {
      const conversations = await readTab('Conversations');
      const archive = await readTab('Archive');
      const gone = !conversations.rows.some((r) => r.customer_phone === PHONES[2]);
      const arrived = archive.rows.find((r) => r.customer_phone === PHONES[2]);
      return gone && arrived ? arrived : null;
    });
    record('a conversation closed longer than ARCHIVE_AFTER_DAYS is swept up',
      !!swept, 'still in Conversations after 180s, or never reached Archive');
    if (swept) {
      record('the swept row keeps the date it was closed',
        String(swept.closed_at).slice(0, 10) === longAgo.slice(0, 10),
        'closed_at = ' + swept.closed_at);
    }
  } else {
    record('a conversation closed longer than ARCHIVE_AFTER_DAYS is swept up',
      false, 'the third conversation was not there to close');
  }

  report();
}

function report() {
  console.log('\n' + '-'.repeat(64));
  console.log('  ' + (results.length - failures) + ' passed, ' + failures + ' failed, ' + results.length + ' checks');
  console.log('-'.repeat(64));
  if (failures) {
    console.log('\nFailed:');
    for (const r of results.filter((x) => !x.ok)) {
      console.log('  - ' + r.name + (r.detail ? '\n      ' + r.detail : ''));
    }
  }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('\naborted: ' + e.message); process.exit(2); });
