#!/usr/bin/env node
/**
 * Print what is actually in the live spreadsheet, right now. Read-only.
 *
 * Every question that came up while building this — "did the message arrive?",
 * "who is it assigned to?", "why is nobody being assigned?", "is it sorted?" —
 * was answered by reading the sheet. This is that, as a command, so the answer
 * takes one line instead of a throwaway script.
 *
 * It writes nothing. There is no flag that makes it write.
 *
 * Usage:
 *   node scripts/testing/show-sheet.js                 # a summary of every tab
 *   node scripts/testing/show-sheet.js Conversations   # one tab, in full
 *   node scripts/testing/show-sheet.js Messages 20     # one tab, first 20 rows
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const { toCode } = require('../lib/labels');

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
const SHEET = ENV.GOOGLE_SHEET_ID;
const SA_FILE = ENV.GOOGLE_SERVICE_ACCOUNT_FILE || path.join(ROOT, 'SHEETKEYS.TXT');
if (!SHEET) { console.error('GOOGLE_SHEET_ID is not set in .env'); process.exit(2); }

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
    iss: sa.client_email,
    // Read-only: this tool cannot write even if it wanted to.
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
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

async function api(pathname) {
  const t = await auth();
  const res = await httpsJson({
    hostname: 'sheets.googleapis.com',
    path: '/v4/spreadsheets/' + SHEET + pathname,
    method: 'GET', headers: { Authorization: 'Bearer ' + t },
  });
  if (res.status >= 400) throw new Error('GET ' + pathname.split('?')[0] + ' -> ' + res.status);
  return res.body;
}

async function readTab(tab) {
  const r = await api('/values/' + encodeURIComponent(tab + '!A1:BZ5000'));
  const values = r.values || [];
  if (!values.length) return { header: [], rows: [] };
  const header = values[0].map((h) => String(h).trim());
  const rows = values.slice(1)
    .filter((v) => v.join('').trim() !== '')
    .map((v) => {
      const o = {};
      header.forEach((h, c) => { o[h] = v[c] === undefined ? '' : v[c]; });
      return o;
    });
  return { header, rows };
}

const pad = (s, n) => {
  const v = String(s === undefined || s === '' ? '-' : s);
  return v.length > n ? v.slice(0, n - 1) + '…' : v + ' '.repeat(n - v.length);
};

/** The columns worth printing for each tab, in the order worth reading. */
const SUMMARY = {
  Conversations: ['customer_phone', 'customer_name', 'status', 'assigned_agent_name',
    'unanswered_count', 'last_message', 'last_activity_at'],
  Archive: ['customer_phone', 'customer_name', 'status', 'assigned_agent_name', 'archived_at'],
  Messages: ['timestamp', 'direction', 'customer_phone', 'status', 'sent_via', 'text'],
  Agents: ['agent_id', 'name', 'active', 'available', 'open_conversations', 'max_open_conversations'],
  Log: ['timestamp', 'event_type', 'status', 'error'],
};

const WIDTH = { text: 34, last_message: 30, customer_name: 18, error: 30, event_type: 22 };

async function main() {
  const [tabArg, limitArg] = process.argv.slice(2);
  const meta = await api('?fields=sheets.properties');
  const tabs = meta.sheets.map((s) => s.properties);

  if (!tabArg) {
    console.log('Spreadsheet ' + SHEET + '\n');
    for (const p of tabs) {
      const { header, rows } = await readTab(p.title);
      console.log('  ' + pad(p.title, 15) + pad(rows.length + ' rows', 11) +
                  pad(header.length + ' columns', 12) + (p.hidden ? 'hidden' : ''));
    }

    // The two questions that get asked most, answered without a second command.
    const conv = await readTab('Conversations');
    // Compared as codes: the sheet may hold the labels of another language.
    const statusOf = (r) => toCode('status', r.status);
    const open = conv.rows.filter((r) => r.status &&
      statusOf(r) !== 'CLOSED' && statusOf(r) !== 'ARCHIVED');
    const waiting = open.filter((r) => statusOf(r) === 'UNANSWERED');
    const unassigned = open.filter((r) => !r.assigned_agent_name);
    console.log('\n  ' + open.length + ' open, ' + waiting.length + ' waiting for a reply, ' +
                unassigned.length + ' with nobody assigned');

    const agents = await readTab('Agents');
    const eligible = agents.rows.filter((a) =>
      String(a.active).toUpperCase() === 'TRUE' &&
      String(a.available).toUpperCase() === 'TRUE' &&
      Number(a.open_conversations || 0) < Number(a.max_open_conversations || 0));
    console.log('  ' + eligible.length + ' of ' + agents.rows.length + ' agents can take a new conversation');
    if (agents.rows.length && !eligible.length) {
      console.log('\n  Nobody is eligible, so new customers will arrive as WAITING_FOR_AGENT.');
      console.log('  Check active, available, and open_conversations against max_open_conversations.');
    }
    console.log('\n  For one tab in full:  node scripts/testing/show-sheet.js Conversations');
    return;
  }

  const title = tabs.map((p) => p.title).find((t) => t.toLowerCase() === tabArg.toLowerCase());
  if (!title) {
    console.error('No tab called "' + tabArg + '". There is: ' + tabs.map((p) => p.title).join(', '));
    process.exit(1);
  }

  const { header, rows } = await readTab(title);
  const cols = (SUMMARY[title] || header).filter((c) => header.indexOf(c) !== -1);
  const limit = limitArg ? Number(limitArg) : rows.length;

  console.log(title + ' — ' + rows.length + ' rows, ' + header.length + ' columns' +
              (limit < rows.length ? ' (showing ' + limit + ')' : '') + '\n');
  console.log('  ' + cols.map((c) => pad(c, WIDTH[c] || 16)).join(' '));
  console.log('  ' + cols.map((c) => '-'.repeat(WIDTH[c] || 16)).join(' '));
  for (const r of rows.slice(0, limit)) {
    console.log('  ' + cols.map((c) => pad(String(r[c]).split('\n')[0], WIDTH[c] || 16)).join(' '));
  }

  const hidden = header.filter((c) => cols.indexOf(c) === -1);
  if (hidden.length) console.log('\n  not shown: ' + hidden.join(', '));
}

main().catch((e) => { console.error('failed: ' + e.message); process.exit(1); });
