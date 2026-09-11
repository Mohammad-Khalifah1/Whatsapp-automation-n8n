#!/usr/bin/env node
/**
 * Schema consistency checker.
 *
 * The same column names are declared in THREE places:
 *   1. sheets-templates/*.csv          — what you paste into a new sheet
 *   2. sheets-templates/SetupSheet.gs  — what the Apps Script creates
 *   3. n8n/workflows/*.json            — what the workflows read and write
 *
 * If they drift, the failure is silent and nasty: a workflow writes to a column
 * that does not exist, Google Sheets accepts it, and the data lands nowhere
 * visible. Nothing errors. You find out when a manager asks why the sheet is
 * empty.
 *
 * This checks all three agree.
 *
 * Usage:
 *   node scripts/validation/check-schema-consistency.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TEMPLATES = path.join(ROOT, 'sheets-templates');
const WORKFLOWS = path.join(ROOT, 'n8n', 'workflows');

const TABS = ['Agents', 'Conversations', 'Messages', 'Log', 'Categories'];

let failures = 0;
let checks = 0;

function ok(msg) {
  checks += 1;
  console.log('  [ok]   ' + msg);
}

function fail(msg, detail) {
  checks += 1;
  failures += 1;
  console.log('  [FAIL] ' + msg);
  if (detail) console.log('         ' + detail);
}

/** Header row of a CSV template. */
function csvColumns(tab) {
  const file = path.join(TEMPLATES, tab + '.csv');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].split(',').map((s) => s.trim());
}

/**
 * Column list for one tab out of the Apps Script SCHEMA object.
 * Parsed textually rather than evaluated — the file references
 * SpreadsheetApp, which does not exist outside Google.
 */
function appsScriptColumns(tab) {
  const file = path.join(TEMPLATES, 'SetupSheet.gs');
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, 'utf8');

  const schemaStart = src.indexOf('var SCHEMA = {');
  if (schemaStart === -1) return null;
  const schemaEnd = src.indexOf('\n};', schemaStart);
  const schema = src.slice(schemaStart, schemaEnd);

  const tabStart = schema.indexOf(tab + ': [');
  if (tabStart === -1) return null;
  const open = schema.indexOf('[', tabStart);
  const close = schema.indexOf(']', open);
  const body = schema.slice(open + 1, close);

  return body
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0);
}

/** Every column name any workflow writes to a given sheet. */
function workflowColumns(tab) {
  const found = new Set();
  if (!fs.existsSync(WORKFLOWS)) return found;

  for (const file of fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith('.json'))) {
    let wf;
    try {
      wf = JSON.parse(fs.readFileSync(path.join(WORKFLOWS, file), 'utf8'));
    } catch (e) {
      continue;
    }
    for (const node of wf.nodes || []) {
      if (node.type !== 'n8n-nodes-base.googleSheets') continue;
      const p = node.parameters || {};

      // Only nodes targeting this tab.
      const sheetName = p.sheetName && p.sheetName.value ? String(p.sheetName.value) : '';
      if (sheetName !== tab) continue;

      // Explicit column mappings.
      const cols = p.columns && p.columns.value ? p.columns.value : null;
      if (cols && typeof cols === 'object') {
        for (const key of Object.keys(cols)) found.add(key);
      }
      // Lookup filters address columns too.
      const filters = p.filtersUI && p.filtersUI.values ? p.filtersUI.values : [];
      for (const f of filters) {
        if (f && f.lookupColumn) found.add(String(f.lookupColumn));
      }
      // matchingColumns for update operations.
      const matching = cols === null && p.columns ? p.columns.matchingColumns : (p.columns ? p.columns.matchingColumns : null);
      if (Array.isArray(matching)) for (const m of matching) found.add(String(m));
    }
  }
  return found;
}

function main() {
  console.log('Schema consistency: CSV templates vs Apps Script vs workflows\n');

  for (const tab of TABS) {
    console.log(tab);

    const csv = csvColumns(tab);
    const gs = appsScriptColumns(tab);

    if (!csv) { fail(tab + ': CSV template missing'); continue; }
    if (!gs) { fail(tab + ': not found in SetupSheet.gs SCHEMA'); continue; }

    // --- CSV vs Apps Script must match exactly, including order ---
    if (csv.join('|') === gs.join('|')) {
      ok('CSV and Apps Script agree (' + csv.length + ' columns)');
    } else {
      const onlyCsv = csv.filter((c) => gs.indexOf(c) === -1);
      const onlyGs = gs.filter((c) => csv.indexOf(c) === -1);
      if (onlyCsv.length === 0 && onlyGs.length === 0) {
        fail('CSV and Apps Script have the same columns in a DIFFERENT ORDER',
             'order matters for a freshly pasted header row');
      } else {
        fail('CSV and Apps Script disagree',
             'only in CSV: [' + onlyCsv.join(', ') + ']  only in .gs: [' + onlyGs.join(', ') + ']');
      }
    }

    // --- every column a workflow writes must exist in the schema ---
    const used = workflowColumns(tab);
    const unknown = Array.from(used).filter((c) => csv.indexOf(c) === -1);

    if (used.size === 0) {
      ok('no workflow writes to this tab');
    } else if (unknown.length === 0) {
      ok('all ' + used.size + ' workflow-referenced columns exist in the schema');
    } else {
      fail('workflows reference columns that are NOT in the sheet schema',
           unknown.join(', ') + '  — these writes would silently go nowhere');
    }

    console.log('');
  }

  // --- archive tabs must be a superset of their source ---
  for (const pair of [['Conversations', 'Archive']]) {
    const src = csvColumns(pair[0]);
    const arch = csvColumns(pair[1]);
    if (!arch) { fail(pair[1] + ': template missing'); continue; }
    const missing = src.filter((c) => arch.indexOf(c) === -1);
    if (missing.length === 0 && arch.indexOf('archived_at') !== -1) {
      ok(pair[1] + ' mirrors ' + pair[0] + ' plus archived_at');
    } else if (missing.length > 0) {
      fail(pair[1] + ' is missing columns from ' + pair[0], missing.join(', '));
    } else {
      fail(pair[1] + ' has no archived_at column');
    }
  }

  console.log('\n' + '-'.repeat(64));
  console.log(checks + ' checks, ' + failures + ' failed');
  console.log('-'.repeat(64) + '\n');
  process.exit(failures > 0 ? 1 : 0);
}

main();
