#!/usr/bin/env node
/**
 * Adds a missing column header to the LIVE Agents tab — for schema changes
 * made after a sheet was already set up, so nobody has to re-run
 * sheets-templates/SetupSheet.gs's setupEverything() by hand just to pick
 * up one new column.
 *
 * n8n's Google Sheets node resolves columns by HEADER NAME, not position
 * (already relied on throughout scripts/setup/build-management-api.js's
 * generated nodes), so this appends the new header at the end of row 1
 * rather than inserting it at its "logical" position in SCHEMA — no
 * existing column shifts, no risk to existing data alignment.
 *
 * IDEMPOTENT. Does nothing if the column already exists.
 *
 * Auth pattern copied from scripts/setup/apply-sheet-layout.js (service-
 * account JWT bearer flow) rather than reinvented.
 *
 * Usage:
 *   node scripts/setup/add-agents-column.js whatsapp_accounts
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const COLUMN = process.argv[2];

if (!COLUMN) {
  console.error('Usage: node scripts/setup/add-agents-column.js <column_name>');
  process.exit(2);
}

function readEnvFile(p) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
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
if (!fs.existsSync(SA_FILE)) { console.error('Service account file not found: ' + SA_FILE); process.exit(2); }

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
  if (!res.body.access_token) throw new Error('service-account auth failed: ' + JSON.stringify(res.body));
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
    const msg = res.body && res.body.error ? res.body.error.message : JSON.stringify(res.body).slice(0, 200);
    throw new Error(method + ' ' + pathname.split('?')[0] + ' -> ' + res.status + ': ' + msg);
  }
  return res.body;
}

function columnLetter(index) {
  let n = index, letter = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

async function main() {
  const values = await api('GET', '/values/Agents!1:1');
  const headers = (values.values && values.values[0]) || [];

  if (headers.indexOf(COLUMN) !== -1) {
    console.log('[ok] "' + COLUMN + '" already exists in Agents (column ' + columnLetter(headers.indexOf(COLUMN) + 1) + ')');
    return;
  }

  const nextCol = headers.length + 1;
  const range = 'Agents!' + columnLetter(nextCol) + '1';
  await api('PUT', '/values/' + encodeURIComponent(range) + '?valueInputOption=RAW', { values: [[COLUMN]] });
  console.log('[ok] "' + COLUMN + '" added to Agents at column ' + columnLetter(nextCol) + ' (was ' + headers.length + ' columns)');
}

main().catch((e) => {
  console.error('add-agents-column failed: ' + e.message);
  process.exit(1);
});
