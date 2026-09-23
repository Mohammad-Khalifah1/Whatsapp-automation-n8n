#!/usr/bin/env node
/**
 * The V2 spikes, on a throwaway spreadsheet (plan task V2-10, section 6.2).
 *
 * Phase 3 of the V2 plan waits on four questions about how Google Sheets
 * behaves. Each has a fallback design, and picking the fallback costs a lot
 * less before the work is done than after it. This answers the ones a machine
 * can answer, and sets up the sheet so a person can answer the rest by
 * looking:
 *
 *   S2  Does an API append with `null` in a derived column's position land
 *       directly below the last row, and does a bounded ARRAYFORMULA extend
 *       to cover it?                                                 automatic
 *   S3  Does a basic filter re-hide a row when an edit makes it fail its
 *       criteria, and does a sort inside a filter view leave the underlying
 *       order, as the API sees it, unchanged?                        automatic
 *   S1  Two header rows (keys in row 1, labels in row 2, row 1 hidden) and a
 *       localised tab name — fixture prepared, then checked in n8n   by hand
 *   S7  Protected ranges with the service account as an editor — fixture
 *       prepared, then checked as an ordinary editor                 by hand
 *   S4  getUi().alert inside a simple onEdit                          by hand
 *   S5  Filter views in the Sheets mobile app                         by hand
 *   S6  Free-form text after 24h inside a Click-to-WhatsApp window    by hand
 *
 * SAFETY
 *   - It refuses to touch the spreadsheet in GOOGLE_SHEET_ID. Pass a
 *     throwaway with --spreadsheet <id>, or --create one.
 *   - Every tab it makes is named SPIKE_*, and it writes nowhere else. They
 *     stay until a person has looked at them; --clean removes them.
 *   - It prints no secrets.
 *
 * Usage:
 *   node scripts/testing/spike-v2.js --spreadsheet <throwaway id>
 *   node scripts/testing/spike-v2.js --create          # API-only spikes
 *   node scripts/testing/spike-v2.js --spreadsheet <id> --clean   # remove the tabs
 *
 * Reads the service account from GOOGLE_SERVICE_ACCOUNT_FILE (default
 * SHEETKEYS.TXT). The throwaway spreadsheet must be shared with that service
 * account as an Editor, and — for the checks a person makes — with you.
 *
 * Write the answers, the date and the evidence back into section 6.2 of
 * docs/V2_PLAN.md. A "no" switches the affected tasks to their fallback
 * before Phase 3 starts.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

// ===========================================================================
// The part that decides. Pure functions, unit-tested in tests/spikes/, so the
// answer this prints is not itself an experiment.
// ===========================================================================

/** Tabs this tool owns. Anything else in the spreadsheet is none of its business. */
const SPIKE_TABS = {
  append: 'SPIKE_S2_append',
  filter: 'SPIKE_S3_filter',
  headers: 'SPIKE_S1_headers',
  protection: 'SPIKE_S7_protection',
};

/**
 * Refuse to experiment on the sheet the business works in.
 *
 * The spikes delete tabs, set filters and protect ranges. On the live sheet
 * that is somewhere between confusing and destructive, and the mistake is one
 * flag away, so it is refused rather than warned about.
 */
function guardSpreadsheet(target, productionId) {
  const id = String(target || '').trim();
  if (id === '') {
    throw new Error('no spreadsheet: pass --spreadsheet <throwaway id>, or --create');
  }
  if (productionId && id === String(productionId).trim()) {
    throw new Error('that is GOOGLE_SHEET_ID, the live sheet. Use a throwaway.');
  }
  return id;
}

/**
 * S2: where did the appended row land, and did the derived column follow?
 *
 * `values` is the grid as the API reads it back, rows of strings, header
 * included. The append is expected directly below the last data row, with the
 * derived cell computed from the row it was appended with.
 *
 * @param {object} input
 * @param {string[][]} input.values        Grid after the append (A1 down).
 * @param {number} input.seededRows        Data rows present before the append.
 * @param {number} input.derivedIndex      Column index of the derived cell.
 * @param {string} input.expectedDerived   What the formula should have made.
 * @param {string} input.formulaCell       C2 read with valueRenderOption=FORMULA.
 */
function answerS2(input) {
  const values = input.values || [];
  const appendedRow = values[input.seededRows + 1]; // +1 for the header row
  if (!appendedRow) {
    return { answer: 'no', detail: 'nothing at row ' + (input.seededRows + 2) +
      ': the append did not land below the last data row (' + values.length + ' rows read)' };
  }
  const extra = values.length - (input.seededRows + 2);
  if (extra > 0) {
    return { answer: 'no', detail: extra + ' row(s) below the append: the formula spilled and the table looks taller than it is' };
  }
  const derived = String(appendedRow[input.derivedIndex] || '');
  if (derived !== input.expectedDerived) {
    return { answer: 'no', detail: 'the derived cell reads "' + derived +
      '", expected "' + input.expectedDerived + '": the bounded array did not extend over the new row' };
  }
  if (String(input.formulaCell || '').indexOf('ARRAYFORMULA') === -1) {
    return { answer: 'no', detail: 'the append overwrote the formula in the key cell' };
  }
  return { answer: 'yes', detail: 'appended at row ' + (input.seededRows + 2) +
    ', derived cell computed, formula intact' };
}

/**
 * S3, first half: does a write make a basic filter re-hide the row?
 *
 * `hiddenByFilter` is rowMetadata from spreadsheets.get, one entry per row.
 * The row edited to fail the criteria must come back hidden, and a row that
 * still passes must not.
 */
function answerS3Filter(input) {
  const hidden = input.hiddenByFilter || [];
  const failing = hidden[input.editedRowIndex];
  const passing = hidden[input.untouchedRowIndex];
  if (failing !== true) {
    return { answer: 'no', detail: 'the edited row is still visible: a filter does not re-apply on a write, so closing a case leaves it on screen until someone re-applies the filter' };
  }
  if (passing === true) {
    return { answer: 'no', detail: 'a row that still passes the criteria was hidden too' };
  }
  return { answer: 'yes', detail: 'the edited row was hidden by the filter, the untouched row was not' };
}

/**
 * S3, second half: does a sort inside a filter view move the real rows?
 *
 * `before` and `after` are the key column as the plain values API reads it,
 * either side of adding a filter view that sorts descending. If they differ,
 * the sort moved the underlying rows, and every in-flight write keyed on a row
 * index is pointing at the wrong customer.
 */
function answerS3Sort(input) {
  const before = (input.before || []).join('|');
  const after = (input.after || []).join('|');
  if (before !== after) {
    return { answer: 'no', detail: 'the underlying order changed: [' + before + '] became [' + after + ']' };
  }
  return { answer: 'yes', detail: 'the API still reads the rows in the order they were written' };
}

/** What a person has to look at, for the spikes no API answers. */
const MANUAL_CHECKS = {
  S1: [
    'Open ' + SPIKE_TABS.headers + '. Row 1 holds the column keys and is hidden; row 2 holds the labels.',
    'In n8n, point a Google Sheets "Get Row(s)" node at this tab with',
    '  Options > Header Row = 1 and First Data Row = 3, and run it.',
    'Then set the tab name to an expression ({{ $env.SPIKE_TAB }}) and run it again.',
    'yes = the node reads the keys, returns the data rows, and accepts the expression.',
  ],
  S4: [
    'In the throwaway spreadsheet: Extensions > Apps Script, paste',
    '  function onEdit(e) { SpreadsheetApp.getUi().alert("edit seen"); }',
    'Edit a cell on the desktop web app.',
    'yes = the alert appears (a simple trigger may refuse getUi in some accounts).',
  ],
  S5: [
    'Open the spreadsheet in the Sheets app on a phone.',
    'yes = the filter views created here are listed and can be opened, and the',
    '      basic filter hides what it hides on the desktop.',
  ],
  S6: [
    'Needs a real conversation that started from a Click-to-WhatsApp ad.',
    'More than 24 hours after the customer last wrote, and inside 72, send',
    'free-form text with the Cloud API.',
    'yes = it is accepted. no (error 131047) = the guard stays at 24 hours.',
  ],
  S7: [
    'Open ' + SPIKE_TABS.protection + ' as an ordinary editor (not the owner,',
    'not the service account): a second Google account you share it with.',
    'Try to: edit a cell in the protected block; sort the whole tab; delete a row.',
    'yes = the protected block and the row operations are refused, while the',
    '      unprotected columns can still be edited and filter views still work.',
  ],
};

/** The section 6.2 table, filled in, ready to paste into the plan. */
function renderResultsTable(results, today) {
  const lines = ['| Spike | Answer | Evidence | Checked |', '|---|---|---|---|'];
  for (const r of results) {
    lines.push('| ' + r.id + ' | ' + r.answer + ' | ' + r.detail.replace(/\|/g, '/') + ' | ' + today + ' |');
  }
  return lines.join('\n');
}

// ===========================================================================
// The part that talks to Google.
// ===========================================================================

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

function httpsJson(options, body) {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: { message: e.message } } }));
    if (body) req.write(body);
    req.end();
  });
}

function makeSheetsClient(serviceAccount) {
  const b64url = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  let token = null;

  async function auth() {
    if (token) return token;
    const now = Math.floor(Date.now() / 1000);
    const unsigned = b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url({
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now, exp: now + 3600,
    });
    const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(serviceAccount.private_key).toString('base64url');
    const form = 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + unsigned + '.' + sig;
    const res = await httpsJson({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
    }, form);
    if (!res.body || !res.body.access_token) throw new Error('service-account auth failed (no token returned)');
    token = res.body.access_token;
    return token;
  }

  return async function call(method, pathname, payload) {
    const t = await auth();
    const body = payload ? JSON.stringify(payload) : null;
    const headers = { Authorization: 'Bearer ' + t };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const res = await httpsJson({
      hostname: 'sheets.googleapis.com', path: '/v4/spreadsheets' + pathname, method, headers,
    }, body);
    if (res.status >= 400) {
      const message = res.body && res.body.error ? res.body.error.message : String(res.status);
      throw new Error(method + ' ' + pathname.split('?')[0] + ' failed: ' + message);
    }
    return res.body;
  };
}

// ===========================================================================
// The spikes themselves.
// ===========================================================================

const enc = encodeURIComponent;

async function resetTab(call, spreadsheetId, title, rows, columns) {
  const doc = await call('GET', '/' + spreadsheetId + '?fields=sheets.properties');
  const existing = (doc.sheets || []).find((s) => s.properties.title === title);
  const requests = [];
  if (existing) requests.push({ deleteSheet: { sheetId: existing.properties.sheetId } });
  requests.push({ addSheet: { properties: { title, gridProperties: { rowCount: rows, columnCount: columns } } } });
  const result = await call('POST', '/' + spreadsheetId + ':batchUpdate', { requests });
  const added = result.replies[result.replies.length - 1].addSheet.properties;
  return added.sheetId;
}

async function removeTabs(call, spreadsheetId) {
  const doc = await call('GET', '/' + spreadsheetId + '?fields=sheets.properties');
  const mine = (doc.sheets || []).filter((s) => s.properties.title.indexOf('SPIKE_') === 0);
  if (mine.length === 0) return 0;
  // A spreadsheet must keep one sheet, so a throwaway made by --create keeps
  // whatever it was created with and only the SPIKE_ tabs go.
  await call('POST', '/' + spreadsheetId + ':batchUpdate', {
    requests: mine.map((s) => ({ deleteSheet: { sheetId: s.properties.sheetId } })),
  });
  return mine.length;
}

/** S2: an append with null in a derived column, next to a bounded ARRAYFORMULA. */
async function runS2(call, spreadsheetId) {
  const tab = SPIKE_TABS.append;
  await resetTab(call, spreadsheetId, tab, 200, 3);

  const bound = 'A2:INDEX(A:A,MAX(2,COUNTA(A:A)))';
  const formula = '=ARRAYFORMULA(IF(' + bound + '="","",UPPER(' + bound + ')))';
  await call('PUT', '/' + spreadsheetId + '/values/' + enc(tab + '!A1:C4') +
    '?valueInputOption=USER_ENTERED', {
    values: [
      ['customer', 'note', 'derived'],
      ['one', 'n1', formula],
      ['two', 'n2'],
      ['three', 'n3'],
    ],
  });

  // Exactly what workflow 3 does: every column it does not write is null.
  await call('POST', '/' + spreadsheetId + '/values/' + enc(tab + '!A:C') +
    ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS', {
    values: [['four', 'n4', null]],
  });

  const grid = await call('GET', '/' + spreadsheetId + '/values/' + enc(tab + '!A1:C20'));
  const formulaCell = await call('GET', '/' + spreadsheetId + '/values/' + enc(tab + '!C2') +
    '?valueRenderOption=FORMULA');

  return answerS2({
    values: grid.values || [],
    seededRows: 3,
    derivedIndex: 2,
    expectedDerived: 'FOUR',
    formulaCell: ((formulaCell.values || [[]])[0] || [])[0],
  });
}

/** S3: a basic filter after a write, and a filter view's sort. */
async function runS3(call, spreadsheetId) {
  const tab = SPIKE_TABS.filter;
  const sheetId = await resetTab(call, spreadsheetId, tab, 200, 3);

  await call('PUT', '/' + spreadsheetId + '/values/' + enc(tab + '!A1:C5') +
    '?valueInputOption=USER_ENTERED', {
    values: [
      ['conversation_id', 'status', 'last_activity_at'],
      ['C-1', 'UNANSWERED', '2026-09-20T10:00:00+03:00'],
      ['C-2', 'UNANSWERED', '2026-09-21T10:00:00+03:00'],
      ['C-3', 'REPLIED', '2026-09-22T10:00:00+03:00'],
      ['C-4', 'UNANSWERED', '2026-09-23T10:00:00+03:00'],
    ],
  });

  // "Everything except CLOSED", the filter the team works in.
  await call('POST', '/' + spreadsheetId + ':batchUpdate', {
    requests: [{ setBasicFilter: { filter: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 3 },
      criteria: { 1: { condition: { type: 'TEXT_NOT_EQ', values: [{ userEnteredValue: 'CLOSED' }] } } },
    } } }],
  });

  // Closing a case is a write, exactly as workflow 7 would make it.
  await call('PUT', '/' + spreadsheetId + '/values/' + enc(tab + '!B3') +
    '?valueInputOption=USER_ENTERED', { values: [['CLOSED']] });

  const meta = await call('GET', '/' + spreadsheetId + '?includeGridData=true&ranges=' +
    enc(tab + '!A1:C5') + '&fields=sheets.data.rowMetadata.hiddenByFilter');
  const rowMetadata = (((meta.sheets || [{}])[0].data || [{}])[0].rowMetadata) || [];
  const filterAnswer = answerS3Filter({
    hiddenByFilter: rowMetadata.map((r) => r.hiddenByFilter === true),
    editedRowIndex: 2,     // C-2, now CLOSED
    untouchedRowIndex: 1,  // C-1, still UNANSWERED
  });

  const before = await call('GET', '/' + spreadsheetId + '/values/' + enc(tab + '!A2:A5'));
  await call('POST', '/' + spreadsheetId + ':batchUpdate', {
    requests: [{ addFilterView: { filter: {
      title: 'SPIKE newest first',
      range: { sheetId, startRowIndex: 0, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 3 },
      sortSpecs: [{ dimensionIndex: 2, sortOrder: 'DESCENDING' }],
    } } }],
  });
  const after = await call('GET', '/' + spreadsheetId + '/values/' + enc(tab + '!A2:A5'));

  const sortAnswer = answerS3Sort({
    before: (before.values || []).map((r) => r[0]),
    after: (after.values || []).map((r) => r[0]),
  });

  const answer = filterAnswer.answer === 'yes' && sortAnswer.answer === 'yes' ? 'yes' : 'no';
  return { answer, detail: 'filter: ' + filterAnswer.detail + '. sort: ' + sortAnswer.detail };
}

/** S1's fixture: keys in row 1 (hidden), labels in row 2, data from row 3. */
async function prepareS1(call, spreadsheetId) {
  const tab = SPIKE_TABS.headers;
  const sheetId = await resetTab(call, spreadsheetId, tab, 200, 4);
  await call('PUT', '/' + spreadsheetId + '/values/' + enc(tab + '!A1:D4') +
    '?valueInputOption=USER_ENTERED', {
    values: [
      ['conversation_id', 'customer_name', 'status', 'reply_text'],
      ['رقم الحالة', 'اسم الزبون', 'الحالة', 'اكتب ردك هنا'],
      ['C-1', 'Ahmad', 'UNANSWERED', ''],
      ['C-2', 'Rana', 'REPLIED', ''],
    ],
  });
  await call('POST', '/' + spreadsheetId + ':batchUpdate', {
    requests: [{ updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
      properties: { hiddenByUser: true },
      fields: 'hiddenByUser',
    } }],
  });
}

/** S7's fixture: a protected block only the owner and the service account may edit. */
async function prepareS7(call, spreadsheetId, serviceAccountEmail) {
  const tab = SPIKE_TABS.protection;
  const sheetId = await resetTab(call, spreadsheetId, tab, 200, 4);
  await call('PUT', '/' + spreadsheetId + '/values/' + enc(tab + '!A1:D3') +
    '?valueInputOption=USER_ENTERED', {
    values: [
      ['you may edit', 'you may edit', 'system column', 'system column'],
      ['a', 'b', 'c', 'd'],
      ['e', 'f', 'g', 'h'],
    ],
  });
  await call('POST', '/' + spreadsheetId + ':batchUpdate', {
    requests: [{ addProtectedRange: { protectedRange: {
      range: { sheetId, startColumnIndex: 2, endColumnIndex: 4 },
      description: 'SPIKE S7 — system columns',
      warningOnly: false,
      editors: { users: [serviceAccountEmail].filter(Boolean) },
    } } }],
  });
}

// ===========================================================================
// Runner
// ===========================================================================

function parseArgs(argv) {
  const args = { spreadsheet: '', create: false, clean: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--spreadsheet') { args.spreadsheet = argv[i + 1] || ''; i += 1; }
    else if (argv[i] === '--create') args.create = true;
    else if (argv[i] === '--clean') args.clean = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = Object.assign({}, readEnvFile(path.join(ROOT, '.env')), process.env);
  const saFile = env.GOOGLE_SERVICE_ACCOUNT_FILE || path.join(ROOT, 'SHEETKEYS.TXT');
  if (!fs.existsSync(saFile)) {
    console.log('No service account file at ' + path.basename(saFile) + '.');
    console.log('Set GOOGLE_SERVICE_ACCOUNT_FILE to the JSON key.');
    process.exit(1);
  }
  const sa = JSON.parse(fs.readFileSync(saFile, 'utf8'));
  const call = makeSheetsClient(sa);

  let spreadsheetId = args.spreadsheet;
  if (args.create && !spreadsheetId) {
    const made = await call('POST', '', { properties: { title: 'V2 spikes — throwaway ' + new Date().toISOString().slice(0, 10) } });
    spreadsheetId = made.spreadsheetId;
    console.log('Created a throwaway spreadsheet: ' + spreadsheetId);
    console.log('It belongs to the service account, so only the automatic spikes can use it.');
    console.log('For the checks a person makes, share a spreadsheet of your own with');
    console.log(sa.client_email + ' and pass --spreadsheet <id>.\n');
  }
  spreadsheetId = guardSpreadsheet(spreadsheetId, env.GOOGLE_SHEET_ID);

  // Tidying up is its own run: the fixtures have to survive until a person has
  // looked at them, so nothing is removed at the end of a spike run.
  if (args.clean) {
    const removed = await removeTabs(call, spreadsheetId);
    console.log('Removed ' + removed + ' SPIKE_ tab(s) from ' + spreadsheetId + '.');
    process.exit(0);
  }

  console.log('V2 spikes on ' + spreadsheetId + '\n');
  const results = [];

  for (const spike of [{ id: 'S2', run: runS2 }, { id: 'S3', run: runS3 }]) {
    try {
      const result = await spike.run(call, spreadsheetId);
      results.push(Object.assign({ id: spike.id }, result));
      console.log('  ' + spike.id + '  ' + result.answer.toUpperCase() + '  ' + result.detail);
    } catch (e) {
      results.push({ id: spike.id, answer: 'error', detail: e.message });
      console.log('  ' + spike.id + '  ERROR  ' + e.message);
    }
  }

  try {
    await prepareS1(call, spreadsheetId);
    await prepareS7(call, spreadsheetId, sa.client_email);
    console.log('\n  S1 and S7 fixtures are ready in ' + SPIKE_TABS.headers + ' and ' + SPIKE_TABS.protection + '.');
  } catch (e) {
    console.log('\n  fixtures for S1/S7 could not be prepared: ' + e.message);
  }

  console.log('\nBy hand:');
  for (const id of Object.keys(MANUAL_CHECKS)) {
    console.log('\n  ' + id);
    for (const line of MANUAL_CHECKS[id]) console.log('    ' + line);
  }

  console.log('\nFor section 6.2 of docs/V2_PLAN.md:\n');
  console.log(renderResultsTable(results, new Date().toISOString().slice(0, 10)));

  console.log('\nThe SPIKE_ tabs stay: S1, S4, S5 and S7 are answered by looking at them.');
  console.log('When you are done:  node scripts/testing/spike-v2.js --spreadsheet ' +
    spreadsheetId + ' --clean');

  process.exit(results.some((r) => r.answer === 'error') ? 1 : 0);
}

module.exports = {
  SPIKE_TABS,
  MANUAL_CHECKS,
  guardSpreadsheet,
  answerS2,
  answerS3Filter,
  answerS3Sort,
  renderResultsTable,
  parseArgs,
};

if (require.main === module) {
  main().catch((e) => {
    console.log('\n' + e.message);
    process.exit(1);
  });
}
