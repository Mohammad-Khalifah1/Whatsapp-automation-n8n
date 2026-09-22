#!/usr/bin/env node
/**
 * Make the live spreadsheet match what this repository declares.
 *
 * One script, run as often as you like. It is the only thing that decides what
 * the sheet looks like: which tabs exist, in what order, with which columns,
 * which cells are dropdowns, what the colours mean, and what each tab is for.
 *
 * It is safe to re-run. Existing rows are re-mapped BY COLUMN NAME, so a
 * reordered or newly added column never shifts a value under the wrong
 * heading, and no row is ever dropped.
 *
 * WHY THIS IS A NODE SCRIPT AND NOT APPS SCRIPT
 * Apps Script has to be pasted into the spreadsheet by hand and authorised
 * before it does anything. This runs from the same service account the
 * workflows already use, so a new deployment needs no manual step at all.
 * sheets-templates/SheetTools.gs remains available for people who want the
 * in-sheet menu, but nothing depends on it.
 *
 * A NOTE ON VALIDATION RANGES
 * A dropdown or checkbox rule applied over a whole column makes Sheets treat
 * every blank cell below the data as a real, valued cell. That is how an
 * earlier run produced 59 phantom Agents rows. Every rule here is bounded to
 * the rows that exist plus a working margin.
 *
 * Usage:
 *   node scripts/setup/apply-sheet-layout.js
 *   node scripts/setup/apply-sheet-layout.js --dry-run
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
const DRY = process.argv.indexOf('--dry-run') !== -1;

// ----------------------------------------------------------------- config ---

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
if (!fs.existsSync(SA_FILE)) { console.error('Service account file not found: ' + SA_FILE); process.exit(2); }

const header = (f) => fs.readFileSync(path.join(ROOT, 'sheets-templates', f), 'utf8')
  .split(/\r?\n/)[0].split(',').map((s) => s.trim()).filter(Boolean);

// ------------------------------------------------------------ the layout ---

/** Tab order: look at it, work in it, configure it, then the archive. */
const TABS = [
  { name: 'Dashboard', columns: null },
  { name: 'Conversations', columns: header('Conversations.csv') },
  { name: 'Agents', columns: header('Agents.csv') },
  { name: 'Archive', columns: header('Archive.csv') },
  { name: 'Messages', columns: header('Messages.csv') },
  { name: 'Log', columns: header('Log.csv'), hidden: true },
];

/**
 * Values a column is allowed to hold. Each becomes a dropdown.
 *
 * Keyed by tab, because `status` means two different things. In Conversations
 * it is the state of the conversation - has anyone answered this customer. In
 * Messages it is the delivery state of one message. Sharing one list put
 * DELIVERED in the conversation dropdown and ARCHIVED in the message dropdown,
 * which is how someone ends up archiving a conversation by picking a value
 * that was never meant for it.
 */
const MESSAGE_TYPES = ['text', 'image', 'audio', 'video', 'document', 'sticker',
  'location', 'contacts', 'interactive', 'button', 'reaction', 'template'];

const ENUMS = {
  Conversations: {
    status: ['WAITING_FOR_AGENT', 'UNANSWERED', 'REPLIED', 'WAITING_FOR_CUSTOMER', 'CLOSED', 'ARCHIVED'],
    reply_status: ['', 'SENT', 'FAILED', 'WINDOW_CLOSED'],
    last_message_direction: ['inbound', 'outbound'],
    last_message_type: MESSAGE_TYPES,
    unread: ['TRUE', 'FALSE'],
  },
  Archive: {
    status: ['WAITING_FOR_AGENT', 'UNANSWERED', 'REPLIED', 'WAITING_FOR_CUSTOMER', 'CLOSED', 'ARCHIVED'],
    reply_status: ['', 'SENT', 'FAILED', 'WINDOW_CLOSED'],
    last_message_direction: ['inbound', 'outbound'],
    last_message_type: MESSAGE_TYPES,
    unread: ['TRUE', 'FALSE'],
  },
  Messages: {
    status: ['RECEIVED', 'SENT', 'DELIVERED', 'READ', 'FAILED'],
    direction: ['inbound', 'outbound'],
    message_type: MESSAGE_TYPES,
    sent_via: ['cloud_api', 'whatsapp_business_app', 'google_sheet', 'template'],
    pricing_category: ['', 'service', 'utility', 'marketing', 'authentication', 'referral_conversion'],
    billable: ['', 'TRUE', 'FALSE'],
    processing_status: ['parsed', 'unsupported', 'deferred'],
    supported: ['TRUE', 'FALSE'],
  },
  Agents: {
    active: ['TRUE', 'FALSE'],
    available: ['TRUE', 'FALSE'],
    role: ['agent', 'supervisor', 'admin'],
  },
  Log: {
    status: ['RECEIVED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'ASSIGNED',
      'WAITING_FOR_AGENT', 'ARCHIVED', 'REJECTED'],
  },
};

/** Colour carries the meaning: red waiting, amber in flight, green done. */
const COLORS = {
  WAITING_FOR_AGENT: [0.97, 0.84, 0.84],
  UNANSWERED: [0.99, 0.94, 0.80],
  REPLIED: [0.85, 0.92, 0.83],
  WAITING_FOR_CUSTOMER: [0.85, 0.92, 0.83],
  CLOSED: [0.93, 0.94, 0.95],
  ARCHIVED: [0.88, 0.85, 0.94],
  SENT: [0.85, 0.92, 0.83],
  FAILED: [0.93, 0.60, 0.58],
  RECEIVED: [0.89, 0.94, 0.99],
  DELIVERED: [0.85, 0.92, 0.83],
  READ: [0.72, 0.88, 0.70],
  inbound: [0.89, 0.94, 0.99],
  outbound: [0.85, 0.92, 0.83],
  unsupported: [0.99, 0.90, 0.78],
  deferred: [0.95, 0.95, 0.87],
  google_sheet: [0.88, 0.90, 0.97],
  whatsapp_business_app: [0.85, 0.92, 0.83],
};

/** Wide enough to read without clicking into the cell. */
const WIDTHS = {
  customer_name: 170, customer_phone: 130, assigned_agent_name: 150, status: 165,
  last_message: 300, last_message_type: 130, last_message_direction: 150,
  unanswered_count: 95, unanswered_messages: 340, customer_phone: 140,
  product: 140, quantity: 80, first_message_at: 170, last_activity_at: 170,
  reply_text: 300, reply_status: 115, unread: 80, wa_link: 190,
  name: 150, agent_id: 110, phone: 130, text: 340, message_id: 150,
  direction: 110, recipient_phone: 140, sender_phone: 140, message_type: 130,
  sent_via: 150, processing_status: 145, supported: 100, status_updated_at: 165,
  created_at: 165,
  conversation_id: 200, timestamp: 165, details: 300, error: 240,
  event_type: 180, source: 160,
};

/** Kept, but out of the way: the system maintains these, nobody edits them. */
const HIDE_COLUMNS = {
  Conversations: ['conversation_id', 'assigned_agent_id', 'business_phone_number_id',
    'last_message_id', 'last_customer_message_at', 'last_agent_message_at',
    'created_at', 'updated_at', 'closed_at', 'unassigned_reason', 'reply_sent_at',
    'reply_blocked_hash'],
  Archive: ['conversation_id', 'assigned_agent_id', 'business_phone_number_id',
    'last_message_id', 'created_at', 'updated_at', 'unassigned_reason', 'reply_blocked_hash'],
  Messages: ['dedupe_key', 'correlation_id', 'raw_event_reference', 'conversation_id'],
};

/**
 * Filter views, each a saved ordering a person opens from Data > Filter views.
 *
 * The workflows used to sort the Conversations tab itself after every new
 * conversation. A sort moves rows under every write that is in flight, and a
 * write resolved to a row index before the sort then lands on another
 * customer's row. A filter view orders what one person sees and moves nothing,
 * so "newest first" lives here now. Matched by title, so re-running updates a
 * view instead of adding another copy.
 */
const FILTER_VIEWS = [
  { tab: 'Conversations', title: 'Newest first', sortBy: 'last_activity_at', order: 'DESCENDING' },
];

/** What each tab is for, shown as a note on A1. */
const NOTES = {
  Dashboard: [
    'DASHBOARD - read only.',
    '',
    'Live totals for conversations, response times, per-agent load and how',
    'agents reply. Every cell is a formula over Conversations, Messages and',
    'Archive, so it cannot show a number the data does not support.',
    'Do not type here.',
  ],
  Conversations: [
    'CONVERSATIONS - this is where you work. One row per customer.',
    '',
    'To reply: type into reply_text. Within a minute it is sent to',
    'customer_phone, reply_status becomes SENT, and reply_text clears. FAILED',
    'means it did not go out, and reply_error says why.',
    'To message a NEW number: add a row, fill customer_phone and reply_text.',
    'To hand a conversation over: pick a name in assigned_agent_name.',
    'To archive: set status to ARCHIVED - the row moves to Archive within a',
    'minute, and nothing is deleted.',
    '',
    'unanswered_messages is everything the customer has said that nobody has',
    'answered yet, newest first. It grows with each message and is cleared the',
    'moment a reply goes out - so a row with three lines in it is a customer',
    'who has written three times and is still waiting. unanswered_count is the',
    'same thing as a number, for sorting and filtering.',
    '',
    'last_message is what was said last, last_message_type is what kind of',
    'message it was, and last_message_direction says whether the customer sent',
    'it (inbound) or your team did (outbound).',
    '',
    'Coloured columns are dropdowns. The columns after wa_link are maintained',
    'by the system and are hidden; unhide them if you need to trace something.',
    '',
    'One row per CUSTOMER, newest activity at the top. last_message is the',
    'latest thing they said, not the only thing - every message ever sent or',
    'received is kept in the Messages tab.',
    'A row leaves this tab in exactly one way: you set status to ARCHIVED, or',
    'the nightly sweep moves a long-closed conversation. Nothing else deletes.',
  ],
  Agents: [
    'AGENTS - the routing configuration. One row per team member.',
    '',
    'active and available decide who can receive a new conversation.',
    'max_open_conversations caps how many they hold at once.',
    'A new customer goes to the eligible agent with the fewest open',
    'conversations, and that agent then keeps the conversation - later messages',
    'from the same customer are not reassigned.',
    'The name column feeds the assigned_agent_name dropdown in Conversations.',
    '',
    'Edit this tab to change who gets work. No workflow change is needed.',
  ],
  Archive: [
    'ARCHIVE - closed and archived conversations, kept out of the way.',
    '',
    'Rows arrive here two ways: you set status to ARCHIVED in Conversations, or',
    'the nightly sweep moves conversations closed for longer than the retention',
    'window. archived_at records when it happened.',
    'Nothing is deleted - the row is copied here first, then removed from',
    'Conversations.',
  ],
  Messages: [
    'MESSAGES - every message, kept. One row per message, in and out, newest',
    'first.',
    '',
    'Who is who:',
    '  customer_phone  - always the customer, whichever way the message went.',
    '  direction       - inbound = the customer sent it TO your business number.',
    '                    outbound = your business number sent it to them.',
    '  sender_phone    - who sent this one. Your business number when outbound.',
    '  recipient_phone - who received it. Your business number when inbound.',
    '  status          - the delivery state of THIS message: RECEIVED for one',
    '                    that arrived, then SENT, DELIVERED, READ or FAILED for',
    '                    one you sent. Not a conversation state.',
    '',
    'This is the history. Conversations shows one row per CUSTOMER, so its',
    'last_message column only ever shows the latest thing they said - the',
    'earlier ones are not overwritten, they are here. Nothing is ever replaced',
    'and nothing is ever deleted from this tab.',
    '',
    'It is also the duplicate check: WhatsApp resends a webhook until it is',
    'acknowledged, and this tab is how the same message_id is recognised and',
    'not recorded twice. Deleting rows here can make a message be processed a',
    'second time.',
    '',
    'Written by the system. There is nothing to edit.',
  ],
  Log: [
    'LOG - system events and errors.',
    '',
    'Written by the system when something is rejected, retried or fails, with',
    'enough context to trace it. Read it when a message did not arrive.',
    '',
    'Hidden by default because nobody needs to edit it.',
  ],
};

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
    const msg = res.body && res.body.error ? res.body.error.message : JSON.stringify(res.body).slice(0, 200);
    throw new Error(method + ' ' + pathname.split('?')[0] + ' -> ' + res.status + ': ' + msg);
  }
  return res.body;
}

const rgb = (a) => ({ red: a[0], green: a[1], blue: a[2] });

/** 0-based column index to its spreadsheet letter. */
function columnLetter(i) {
  let s = ''; let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ------------------------------------------------------------------ main ---

async function main() {
  console.log('Applying the declared layout to the spreadsheet' + (DRY ? ' (dry run)' : '') + '\n');

  let meta = await api('GET', '?fields=sheets.properties');
  const props = {};
  for (const s of meta.sheets) props[s.properties.title] = s.properties;

  // --- create any missing tab -----------------------------------------------
  const missing = TABS.filter((t) => !props[t.name]);
  if (missing.length) {
    console.log('  creating: ' + missing.map((t) => t.name).join(', '));
    if (!DRY) {
      await api('POST', ':batchUpdate', {
        requests: missing.map((t) => ({ addSheet: { properties: { title: t.name } } })),
      });
      meta = await api('GET', '?fields=sheets.properties');
      for (const s of meta.sheets) props[s.properties.title] = s.properties;
    }
  }

  // --- header and data ------------------------------------------------------
  for (const tab of TABS) {
    if (!tab.columns || !props[tab.name]) continue;
    const range = tab.name + '!A1:CZ5000';
    const read = await api('GET', '/values/' + encodeURIComponent(range));
    const values = read.values || [];
    const old = values.length ? values[0].map((s) => String(s).trim()) : [];

    const same = old.length === tab.columns.length && old.every((c, i) => c === tab.columns[i]);
    if (same) {
      console.log('  ' + tab.name.padEnd(14) + tab.columns.length + ' columns, unchanged');
      continue;
    }

    // Refuse to migrate from something that is not a header. If row 1 does not
    // look like column names, re-mapping by name maps EVERYTHING to blank and
    // silently empties the tab. This happened for real: a values:append with a
    // single-cell range inserted a data row above row 1, and the next layout
    // run mapped the whole tab to nothing. Stop instead, and say what to do.
    const recognised = old.filter((c) => tab.columns.indexOf(c) !== -1).length;
    if (values.length && recognised < Math.min(3, tab.columns.length)) {
      console.error('\n  ' + tab.name + ': row 1 does not look like a header.');
      console.error('  Only ' + recognised + ' of ' + old.length +
                    ' cells match a known column, so migrating would blank every row.');
      console.error('  Row 1 reads: ' + old.slice(0, 5).join(' | '));
      console.error('  The real header may have been pushed down a row. Put it back on');
      console.error('  row 1, remove the stray row, then run this again.');
      process.exit(1);
    }

    // Re-map by NAME so nothing moves under the wrong heading.
    const data = values.slice(1)
      .filter((row) => row.join('').trim() !== '')
      .map((row) => tab.columns.map((name) => {
        const i = old.indexOf(name);
        return i === -1 ? '' : (row[i] === undefined ? '' : row[i]);
      }));

    console.log('  ' + tab.name.padEnd(14) + (old.length || 0) + ' -> ' +
                tab.columns.length + ' columns, ' + data.length + ' rows kept');
    if (DRY) continue;

    await api('POST', '/values/' + encodeURIComponent(range) + ':clear', {});
    await api('PUT', '/values/' + encodeURIComponent(tab.name + '!A1') + '?valueInputOption=RAW',
      { values: [tab.columns].concat(data) });

    const grid = props[tab.name].gridProperties.columnCount;
    if (grid > tab.columns.length) {
      await api('POST', ':batchUpdate', { requests: [{ deleteDimension: { range: {
        sheetId: props[tab.name].sheetId, dimension: 'COLUMNS',
        startIndex: tab.columns.length, endIndex: grid } } }] });
    }
  }

  if (DRY) {
    console.log('\n  filter views: ' + FILTER_VIEWS.map((v) => v.tab + ' "' + v.title + '"').join(', '));
    console.log('  dry run: no formatting applied');
    return;
  }

  // Re-read: clearing and deleting columns changes the grid.
  meta = await api('GET', '?fields=sheets.properties');
  for (const s of meta.sheets) props[s.properties.title] = s.properties;

  // Where the agent names live, for the agent dropdown.
  const agentCols = header('Agents.csv');
  const agentNameRange = 'Agents!$' + columnLetter(agentCols.indexOf('name')) + '$2:$' +
                         columnLetter(agentCols.indexOf('name')) + '$200';

  // --- formatting -----------------------------------------------------------
  for (const tab of TABS) {
    if (!tab.columns || !props[tab.name]) continue;
    const sheetId = props[tab.name].sheetId;
    const cols = tab.columns;

    const read = await api('GET', '/values/' + encodeURIComponent(tab.name + '!A1:A5000'));
    const dataRows = Math.max(((read.values || []).length) - 1, 0);
    const endRow = dataRows + 100;   // real rows plus room to type

    const reqs = [];

    reqs.push({ repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: cols.length },
      cell: { userEnteredFormat: {
        backgroundColor: rgb([0.149, 0.251, 0.31]),
        textFormat: { foregroundColor: rgb([1, 1, 1]), bold: true, fontSize: 10 },
        verticalAlignment: 'MIDDLE',
        padding: { top: 6, bottom: 6, left: 8, right: 8 } } },
      fields: 'userEnteredFormat' } });
    reqs.push({ updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount' } });
    reqs.push({ updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 34 }, fields: 'pixelSize' } });

    // Dropdowns. strict:false keeps a value the API writes that is not in the
    // list from being rejected; it is flagged, not blocked.
    //
    // Clear FIRST, across the whole width. A validation rule belongs to a
    // column POSITION, so inserting two columns shifted every rule right and
    // left a TRUE/FALSE dropdown sitting on reply_text - a free-text cell the
    // whole reply feature depends on. Only ever adding rules cannot undo that;
    // the sheet has to be told what each column is NOT, too.
    reqs.push({ setDataValidation: {
      range: { sheetId, startRowIndex: 1, endRowIndex: endRow, startColumnIndex: 0, endColumnIndex: cols.length },
    } });

    const tabEnums = ENUMS[tab.name] || {};
    let dropdowns = 0;
    for (const name of Object.keys(tabEnums)) {
      const c = cols.indexOf(name);
      if (c === -1) continue;
      reqs.push({ setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: endRow, startColumnIndex: c, endColumnIndex: c + 1 },
        rule: { condition: { type: 'ONE_OF_LIST', values: tabEnums[name].map((v) => ({ userEnteredValue: v })) },
          showCustomUi: true, strict: false } } });
      dropdowns += 1;
    }

    // The agent dropdown reads the Agents tab, so adding a team member is one
    // row in one place and the dropdown follows.
    const agentCol = cols.indexOf('assigned_agent_name');
    if (agentCol !== -1) {
      reqs.push({ setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: endRow, startColumnIndex: agentCol, endColumnIndex: agentCol + 1 },
        rule: { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: '=' + agentNameRange }] },
          showCustomUi: true, strict: false } } });
      dropdowns += 1;
    }

    // Widths, wrapping, and hiding the plumbing.
    for (const name of Object.keys(WIDTHS)) {
      const c = cols.indexOf(name);
      if (c === -1) continue;
      reqs.push({ updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 },
        properties: { pixelSize: WIDTHS[name] }, fields: 'pixelSize' } });
    }
    for (const name of ['last_message', 'unanswered_messages', 'reply_text', 'text',
      'details', 'error', 'product']) {
      const c = cols.indexOf(name);
      if (c === -1) continue;
      reqs.push({ repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: c, endColumnIndex: c + 1 },
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
        fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)' } });
    }
    // Hidden-ness belongs to a column POSITION, not to a column name. Reordering
    // a tab therefore leaves the old positions hidden while different columns
    // now sit in them - which is how `status` vanished from Conversations after
    // the reorder, with nothing in the sheet to say why. So set it explicitly,
    // both ways, for every column.
    const hide = HIDE_COLUMNS[tab.name] || [];
    cols.forEach((name, c) => {
      reqs.push({ updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 },
        properties: { hiddenByUser: hide.indexOf(name) !== -1 },
        fields: 'hiddenByUser' } });
    });

    if (NOTES[tab.name]) {
      reqs.push({ repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { note: NOTES[tab.name].join('\n') }, fields: 'note' } });
    }

    await api('POST', ':batchUpdate', { requests: reqs });

    // Colours, applied after the rules so the indexes are stable. Existing
    // rules are cleared first so re-running does not stack duplicates.
    const existing = await api('GET', '?fields=sheets(properties.sheetId,conditionalFormats)');
    const mine = (existing.sheets.find((s) => s.properties.sheetId === sheetId) || {}).conditionalFormats || [];
    const clear = [];
    for (let i = mine.length - 1; i >= 0; i -= 1) {
      clear.push({ deleteConditionalFormatRule: { sheetId, index: i } });
    }
    if (clear.length) await api('POST', ':batchUpdate', { requests: clear });

    const colourReqs = [];
    let index = 0;
    for (const name of Object.keys(tabEnums)) {
      const c = cols.indexOf(name);
      if (c === -1) continue;
      for (const value of tabEnums[name]) {
        if (!value || !COLORS[value]) continue;
        colourReqs.push({ addConditionalFormatRule: { index: index, rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: endRow, startColumnIndex: c, endColumnIndex: c + 1 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: value }] },
            format: { backgroundColor: rgb(COLORS[value]) } } } } });
        index += 1;
      }
    }
    // A whole row that nobody owns should be visible from across the room.
    const statusCol = cols.indexOf('status');
    if (statusCol !== -1 && tab.name === 'Conversations') {
      colourReqs.push({ addConditionalFormatRule: { index: index, rule: {
        ranges: [{ sheetId, startRowIndex: 1, endRowIndex: endRow, startColumnIndex: 0, endColumnIndex: cols.length }],
        booleanRule: {
          condition: { type: 'CUSTOM_FORMULA', values: [{
            userEnteredValue: '=$' + columnLetter(statusCol) + '2="WAITING_FOR_AGENT"' }] },
          format: { backgroundColor: rgb([0.99, 0.93, 0.93]) } } } } });
      index += 1;
    }
    if (colourReqs.length) await api('POST', ':batchUpdate', { requests: colourReqs });

    console.log('  ' + tab.name.padEnd(14) + dropdowns + ' dropdowns, ' +
                colourReqs.length + ' colour rules, rows 2-' + endRow);
  }

  // --- filter views: an order for people that moves no row ------------------
  const existingViews = await api('GET',
    '?fields=sheets(properties(sheetId,title),filterViews(filterViewId,title))');
  const viewReqs = [];
  for (const spec of FILTER_VIEWS) {
    const tab = TABS.find((t) => t.name === spec.tab);
    if (!tab || !tab.columns || !props[spec.tab]) continue;
    const col = tab.columns.indexOf(spec.sortBy);
    if (col === -1) continue;
    const sheetId = props[spec.tab].sheetId;
    // No endRowIndex: the view covers every row, including ones added later.
    const view = {
      title: spec.title,
      range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: tab.columns.length },
      sortSpecs: [{ dimensionIndex: col, sortOrder: spec.order }],
    };
    const sheet = (existingViews.sheets || []).find((s) => s.properties.sheetId === sheetId) || {};
    const found = (sheet.filterViews || []).find((v) => v.title === spec.title);
    viewReqs.push(found
      ? { updateFilterView: { filter: Object.assign({ filterViewId: found.filterViewId }, view),
        fields: 'title,range,sortSpecs' } }
      : { addFilterView: { filter: view } });
  }
  if (viewReqs.length) await api('POST', ':batchUpdate', { requests: viewReqs });
  console.log('\n  filter views: ' + FILTER_VIEWS.map((v) => v.tab + ' "' + v.title + '"').join(', '));

  // --- tab order and visibility ---------------------------------------------
  const finalReqs = [];
  TABS.forEach((tab, i) => {
    if (!props[tab.name]) return;
    finalReqs.push({ updateSheetProperties: {
      properties: { sheetId: props[tab.name].sheetId, index: i, hidden: !!tab.hidden },
      fields: 'index,hidden' } });
  });
  if (NOTES.Dashboard && props.Dashboard) {
    finalReqs.push({ repeatCell: {
      range: { sheetId: props.Dashboard.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
      cell: { note: NOTES.Dashboard.join('\n') }, fields: 'note' } });
  }
  await api('POST', ':batchUpdate', { requests: finalReqs });

  console.log('\n  tab order: ' + TABS.map((t) => t.name + (t.hidden ? ' (hidden)' : '')).join(', '));
  console.log('  done.');
}

main().catch((e) => { console.error('\nfailed: ' + e.message); process.exit(1); });
