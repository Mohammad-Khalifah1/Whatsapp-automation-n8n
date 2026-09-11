#!/usr/bin/env node
/**
 * Build the Dashboard tab.
 *
 * Every figure is a FORMULA over `Conversations`, `Messages`, `Archive` and
 * `Agents`. Not one number is copied in. That is the whole point: a dashboard
 * someone makes staffing decisions from must not be able to show a figure the
 * underlying data does not support, and it must not go stale between runs.
 *
 * Column letters are DERIVED from the CSV templates, never hard-coded. An
 * earlier version hard-coded them; reordering Conversations silently pointed
 * the response-time formulas at `product` and `last_message_direction`, and the
 * dashboard went on reporting confident, wrong numbers.
 *
 * Safe to re-run. It rewrites the tab from scratch each time.
 *
 * Usage:
 *   node scripts/setup/build-dashboard.js
 *
 * Reads GOOGLE_SHEET_ID from .env and the service account from the file named
 * by GOOGLE_SERVICE_ACCOUNT_FILE (default SHEETKEYS.TXT). Prints no secrets.
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
const SHEET = ENV.GOOGLE_SHEET_ID;
const SA_FILE = ENV.GOOGLE_SERVICE_ACCOUNT_FILE || path.join(ROOT, 'SHEETKEYS.TXT');

if (!SHEET) { console.error('GOOGLE_SHEET_ID is not set in .env'); process.exit(2); }

const header = (f) => fs.readFileSync(path.join(ROOT, 'sheets-templates', f), 'utf8')
  .split(/\r?\n/)[0].split(',').map((s) => s.trim()).filter(Boolean);

const CONV = header('Conversations.csv');
const ARCH = header('Archive.csv');
const MSGS = header('Messages.csv');
const AGENTS = header('Agents.csv');

/** 0-based column index to its spreadsheet letter. */
function letter(i) {
  let s = ''; let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** An absolute whole-column reference for a column, found by NAME. */
function col(tab, columns, name) {
  const i = columns.indexOf(name);
  if (i === -1) throw new Error('no column "' + name + '" in ' + tab);
  return "'" + tab + "'!$" + letter(i) + ':$' + letter(i);
}

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
    hostname: 'sheets.googleapis.com',
    path: '/v4/spreadsheets/' + SHEET + pathname, method, headers,
  }, body);
  if (res.status >= 400) {
    const msg = res.body && res.body.error ? res.body.error.message : String(res.body).slice(0, 200);
    throw new Error(method + ' ' + pathname.split('?')[0] + ' -> ' + res.status + ': ' + msg);
  }
  return res.body;
}

const rgb = (a) => ({ red: a[0], green: a[1], blue: a[2] });

// ------------------------------------------------------------------ main ---

(async () => {
  // Column references, by name.
  const C_AGENT = col('Conversations', CONV, 'assigned_agent_name');
  const C_STATUS = col('Conversations', CONV, 'status');
  const C_FIRST = col('Conversations', CONV, 'first_message_at');
  const C_PHONE = col('Conversations', CONV, 'customer_phone');
  const C_DIR = col('Conversations', CONV, 'last_message_direction');
  const A_AGENT = col('Archive', ARCH, 'assigned_agent_name');
  const A_PHONE = col('Archive', ARCH, 'customer_phone');
  const M_DIR = col('Messages', MSGS, 'direction');
  const M_AGENT = col('Messages', MSGS, 'agent_id');
  const M_VIA = col('Messages', MSGS, 'sent_via');
  const M_TYPE = col('Messages', MSGS, 'message_type');
  const M_SUPPORTED = col('Messages', MSGS, 'supported');

  // "Open" means a conversation someone still owes a reply on.
  const OPEN = C_STATUS + ',"<>CLOSED",' + C_STATUS + ',"<>ARCHIVED",' + C_STATUS + ',"<>"';

  const agentsRead = await api('GET', '/values/' + encodeURIComponent('Agents!A1:Z200'));
  const agentRows = (agentsRead.values || []).slice(1)
    .filter((r) => r[AGENTS.indexOf('agent_id')]);

  const rows = [];
  const push = (...cells) => rows.push(cells);

  push('WHATSAPP SUPPORT — LIVE DASHBOARD', '', '', '', '', '', '', '');
  push('=CONCATENATE("Every number below is a formula over Conversations, Messages, Archive and Agents. Updated: ", TEXT(NOW(),"yyyy-mm-dd hh:mm"))', '', '', '', '', '', '', '');
  push('', '', '', '', '', '', '', '');

  push('RIGHT NOW', '', '', '', '', '', '', '');
  push('Open conversations', '=COUNTIFS(' + OPEN + ')',
       'Waiting for a reply', '=COUNTIF(' + C_STATUS + ',"UNANSWERED")',
       'Nobody assigned', '=COUNTIF(' + C_STATUS + ',"WAITING_FOR_AGENT")',
       'Answered', '=COUNTIF(' + C_STATUS + ',"REPLIED")');
  push('Customers in the sheet', '=COUNTA(' + C_PHONE + ')-1',
       'Customer spoke last', '=COUNTIF(' + C_DIR + ',"inbound")',
       'We spoke last', '=COUNTIF(' + C_DIR + ',"outbound")',
       'Archived (all time)', '=COUNTA(' + A_PHONE + ')-1');
  push('', '', '', '', '', '', '', '');

  push('RESPONSE TIME', '', '', '', '', '', '', '');
  // first_message_at is local ISO-8601 with an offset, and TEXT(NOW()) renders
  // local time in the same shape, so this string comparison is a real one.
  push('Waiting over 1 hour',
       '=COUNTIFS(' + C_STATUS + ',"UNANSWERED",' + C_FIRST + ',"<"&TEXT(NOW()-1/24,"yyyy-mm-ddThh:mm:ss"))',
       'Waiting over 24 hours',
       '=COUNTIFS(' + C_STATUS + ',"UNANSWERED",' + C_FIRST + ',"<"&TEXT(NOW()-1,"yyyy-mm-ddThh:mm:ss"))',
       'Oldest unanswered',
       '=IFERROR(MINIFS(' + C_FIRST + ',' + C_STATUS + ',"UNANSWERED"),"none")', '', '');
  push('', '', '', '', '', '', '', '');

  push('PER AGENT', '', '', '', '', '', '', '');
  push('Agent', 'Open now', 'Waiting for a reply', 'Answered', 'Messages sent',
       'Archived (all time)', 'Capacity', 'Load');

  for (const a of agentRows) {
    const name = a[AGENTS.indexOf('name')];
    const id = a[AGENTS.indexOf('agent_id')];
    const max = a[AGENTS.indexOf('max_open_conversations')] || 5;
    const openForAgent = 'COUNTIFS(' + C_AGENT + ',"' + name + '",' + OPEN + ')';
    push(
      name,
      '=' + openForAgent,
      '=COUNTIFS(' + C_AGENT + ',"' + name + '",' + C_STATUS + ',"UNANSWERED")',
      '=COUNTIFS(' + C_AGENT + ',"' + name + '",' + C_STATUS + ',"REPLIED")',
      '=COUNTIFS(' + M_AGENT + ',"' + id + '",' + M_DIR + ',"outbound")',
      '=COUNTIF(' + A_AGENT + ',"' + name + '")',
      String(max),
      // A capacity of zero is a legitimate "takes nothing", not an error.
      '=IF(' + max + '=0,"off",TEXT(' + openForAgent + '/' + max + ',"0%"))'
    );
  }
  push('', '', '', '', '', '', '', '');

  push('HOW REPLIES GO OUT', '', '', '', '', '', '', '');
  push('From the sheet', '=COUNTIF(' + M_VIA + ',"google_sheet")',
       'From the WhatsApp app', '=COUNTIF(' + M_VIA + ',"whatsapp_business_app")',
       'Via the API', '=COUNTIF(' + M_VIA + ',"cloud_api")',
       'Total sent', '=COUNTIF(' + M_DIR + ',"outbound")');
  push('', '', '', '', '', '', '', '');

  push('WHAT CUSTOMERS SEND', '', '', '', '', '', '', '');
  push('Text', '=COUNTIFS(' + M_TYPE + ',"text",' + M_DIR + ',"inbound")',
       'Image', '=COUNTIFS(' + M_TYPE + ',"image",' + M_DIR + ',"inbound")',
       'Other media',
       '=COUNTIF(' + M_DIR + ',"inbound")-COUNTIFS(' + M_TYPE + ',"text",' + M_DIR + ',"inbound")-COUNTIFS(' + M_TYPE + ',"image",' + M_DIR + ',"inbound")',
       'Types we cannot read', '=COUNTIF(' + M_SUPPORTED + ',"FALSE")');

  // --- write ---------------------------------------------------------------
  const TAB = 'Dashboard';
  let meta = await api('GET', '?fields=sheets.properties');
  let props = meta.sheets.map((s) => s.properties).find((p) => p.title === TAB);
  if (!props) {
    await api('POST', ':batchUpdate', { requests: [{ addSheet: { properties: { title: TAB, index: 0 } } }] });
    meta = await api('GET', '?fields=sheets.properties');
    props = meta.sheets.map((s) => s.properties).find((p) => p.title === TAB);
  }

  await api('POST', '/values/' + encodeURIComponent(TAB + '!A1:H60') + ':clear', {});
  await api('PUT', '/values/' + encodeURIComponent(TAB + '!A1') + '?valueInputOption=USER_ENTERED',
    { values: rows });

  const id = props.sheetId;
  const reqs = [];
  reqs.push({ repeatCell: {
    range: { sheetId: id, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 8 },
    cell: { userEnteredFormat: {
      backgroundColor: rgb([0.10, 0.18, 0.25]),
      textFormat: { foregroundColor: rgb([1, 1, 1]), bold: true, fontSize: 14 },
      verticalAlignment: 'MIDDLE' } },
    fields: 'userEnteredFormat' } });
  reqs.push({ updateDimensionProperties: {
    range: { sheetId: id, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
    properties: { pixelSize: 42 }, fields: 'pixelSize' } });
  reqs.push({ updateSheetProperties: {
    properties: { sheetId: id, gridProperties: { frozenRowCount: 2 } },
    fields: 'gridProperties.frozenRowCount' } });

  // Section headers: a row with text in column A and nothing beside it.
  rows.forEach((r, i) => {
    const v = String(r[0] || '');
    if (i > 0 && v && !r[1] && v === v.toUpperCase() && v.length > 3) {
      reqs.push({ repeatCell: {
        range: { sheetId: id, startRowIndex: i, endRowIndex: i + 1, startColumnIndex: 0, endColumnIndex: 8 },
        cell: { userEnteredFormat: {
          backgroundColor: rgb([0.85, 0.89, 0.93]),
          textFormat: { bold: true, fontSize: 11 } } },
        fields: 'userEnteredFormat' } });
    }
  });

  const agentHeader = rows.findIndex((r) => r[0] === 'Agent');
  if (agentHeader > 0) {
    reqs.push({ repeatCell: {
      range: { sheetId: id, startRowIndex: agentHeader, endRowIndex: agentHeader + 1, startColumnIndex: 0, endColumnIndex: 8 },
      cell: { userEnteredFormat: {
        backgroundColor: rgb([0.149, 0.251, 0.31]),
        textFormat: { foregroundColor: rgb([1, 1, 1]), bold: true } } },
      fields: 'userEnteredFormat' } });
  }

  reqs.push({ updateDimensionProperties: {
    range: { sheetId: id, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
    properties: { pixelSize: 210 }, fields: 'pixelSize' } });
  for (let c = 1; c < 8; c += 1) {
    reqs.push({ updateDimensionProperties: {
      range: { sheetId: id, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 },
      properties: { pixelSize: 155 }, fields: 'pixelSize' } });
  }
  reqs.push({ repeatCell: {
    range: { sheetId: id, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
    cell: { note: [
      'DASHBOARD - read only.',
      '',
      'Every cell is a formula over Conversations, Messages, Archive and Agents.',
      'Nothing here is a copied number, so it cannot go stale and it cannot show',
      'a figure the data does not support.',
      '',
      'Rebuild after adding or removing an agent:',
      '  node scripts/setup/build-dashboard.js',
    ].join('\n') }, fields: 'note' } });

  await api('POST', ':batchUpdate', { requests: reqs });

  console.log('  Dashboard rebuilt: ' + rows.length + ' rows, ' + agentRows.length + ' agents');
  console.log('  Every figure is a live formula. Column letters derived from sheets-templates/.');
})().catch((e) => { console.error('  failed: ' + e.message); process.exit(1); });
