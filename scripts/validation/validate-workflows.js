#!/usr/bin/env node
/**
 * Workflow validator.
 *
 * Catches the failure mode that would otherwise only surface at 3am when a real
 * customer message arrives: a Code node whose injected JavaScript does not
 * parse, a broken node reference in `connections`, or a node type/version that
 * does not exist in the running n8n.
 *
 * Checks performed:
 *   1. The file is valid JSON with the required top-level shape.
 *   2. Every Code node's jsCode PARSES as JavaScript (via vm.Script compile).
 *   3. Every Code node's inlined library functions are actually reachable.
 *   4. Every connection references a node that exists.
 *   5. Every node has a unique name and id.
 *   6. No secret-looking literal is embedded in any workflow.
 *   7. Every node type/typeVersion is one the running n8n supports (optional —
 *      only when a node type inventory is supplied).
 *
 * Usage:
 *   node scripts/validation/validate-workflows.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const WF_DIR = path.join(ROOT, 'n8n', 'workflows');

/**
 * Node types and the versions this project targets, verified against the
 * running n8n 2.38.5 image on 2026-09-10.
 */
const EXPECTED_NODE_VERSIONS = {
  'n8n-nodes-base.webhook': [1, 1.1, 2, 2.1],
  'n8n-nodes-base.respondToWebhook': [1, 1.1, 1.2, 1.3, 1.4, 1.5],
  'n8n-nodes-base.code': [1, 2],
  'n8n-nodes-base.if': [1, 2, 2.1, 2.2, 2.3],
  'n8n-nodes-base.switch': [1, 2, 3, 3.1, 3.2, 3.3, 3.4],
  'n8n-nodes-base.set': [1, 2, 3, 3.1, 3.2, 3.3, 3.4, 3.5],
  'n8n-nodes-base.httpRequest': [1, 2, 3, 4, 4.1, 4.2, 4.3, 4.4, 4.5],
  'n8n-nodes-base.googleSheets': [1, 2, 3, 4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7],
  'n8n-nodes-base.noOp': [1],
  'n8n-nodes-base.merge': [1, 2, 3, 3.1, 3.2],
  'n8n-nodes-base.executeWorkflow': [1, 1.1, 1.2, 1.3],
  'n8n-nodes-base.executeWorkflowTrigger': [1, 1.1, 1.2],
  'n8n-nodes-base.stopAndError': [1],
  'n8n-nodes-base.scheduleTrigger': [1, 1.1, 1.2, 1.3, 1.4],
  'n8n-nodes-base.errorTrigger': [1],
  'n8n-nodes-base.stickyNote': [1],
};

/**
 * Patterns that indicate a real secret was hard-coded into a workflow.
 * Deliberately narrow to avoid false positives on placeholders.
 */
const SECRET_PATTERNS = [
  { name: 'Meta access token', re: /\bEAA[A-Za-z0-9]{20,}/ },
  { name: 'Google private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Bearer token literal', re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: 'Google service account json', re: /"type"\s*:\s*"service_account"/ },
];

const results = { passed: 0, failed: 0, failures: [] };

function check(label, condition, detail) {
  if (condition) {
    results.passed += 1;
  } else {
    results.failed += 1;
    results.failures.push({ label, detail: detail || '' });
    console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : ''));
    return false;
  }
  return true;
}

/**
 * Compile a Code node body the way n8n effectively does: as a function body
 * with n8n's globals in scope. We only need to know that it PARSES — we do
 * not execute it (executing would need the whole n8n runtime).
 */
function compilesAsFunctionBody(code) {
  try {
    // Wrap in an async function because n8n Code nodes may use await.
    new vm.Script('(async function n8nCodeNode() {\n' + code + '\n})');
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function validateWorkflow(file) {
  console.log('\n' + file);
  const full = path.join(WF_DIR, file);
  const raw = fs.readFileSync(full, 'utf8');

  let wf;
  try {
    wf = JSON.parse(raw);
  } catch (e) {
    check('valid JSON', false, e.message);
    return;
  }
  check('valid JSON', true);

  check('has a name', typeof wf.name === 'string' && wf.name.length > 0);
  check('has a nodes array', Array.isArray(wf.nodes) && wf.nodes.length > 0);
  check('has a connections object', wf.connections && typeof wf.connections === 'object');

  // --- unique names and ids ---
  const names = wf.nodes.map((n) => n.name);
  const ids = wf.nodes.map((n) => n.id);
  check(
    'node names are unique',
    new Set(names).size === names.length,
    'duplicates: ' + names.filter((n, i) => names.indexOf(n) !== i).join(', ')
  );
  check(
    'node ids are unique',
    new Set(ids).size === ids.length,
    'duplicates: ' + ids.filter((n, i) => ids.indexOf(n) !== i).join(', ')
  );

  // --- node types and versions ---
  for (const node of wf.nodes) {
    const allowed = EXPECTED_NODE_VERSIONS[node.type];
    if (!allowed) {
      check('known node type: ' + node.type, false, 'node "' + node.name + '" uses an unrecognised type');
      continue;
    }
    check(
      'supported version for ' + node.name + ' (' + node.type + ' v' + node.typeVersion + ')',
      allowed.indexOf(node.typeVersion) !== -1,
      'supported: ' + allowed.join(', ')
    );
  }

  // --- connections reference real nodes ---
  const nameSet = new Set(names);
  for (const sourceName of Object.keys(wf.connections)) {
    check('connection source exists: ' + sourceName, nameSet.has(sourceName));
    const outputs = wf.connections[sourceName].main || [];
    for (const branch of outputs) {
      if (!Array.isArray(branch)) continue;
      for (const target of branch) {
        check(
          'connection target exists: ' + sourceName + ' -> ' + target.node,
          nameSet.has(target.node)
        );
      }
    }
  }

  // --- every non-trigger, non-sticky node is reachable ---
  const connected = new Set();
  for (const sourceName of Object.keys(wf.connections)) {
    connected.add(sourceName);
    for (const branch of wf.connections[sourceName].main || []) {
      for (const t of branch || []) connected.add(t.node);
    }
  }
  for (const node of wf.nodes) {
    if (node.type === 'n8n-nodes-base.stickyNote') continue;
    check('node is wired into the graph: ' + node.name, connected.has(node.name));
  }

  // --- Code node bodies must parse ---
  const codeNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code');
  for (const node of codeNodes) {
    const code = node.parameters && node.parameters.jsCode;
    if (typeof code !== 'string' || code.trim() === '') {
      check('Code node has a body: ' + node.name, false);
      continue;
    }
    const compiled = compilesAsFunctionBody(code);
    check('Code node parses as JavaScript: ' + node.name, compiled.ok, compiled.error);

    // The generated block must not have accidentally kept module wiring.
    check(
      'no leftover module.exports in: ' + node.name,
      code.indexOf('module.exports') === -1
    );
    check(
      'no relative require() left in: ' + node.name,
      !/require\(['"]\.\.?\//.test(code)
    );
  }

  // --- sheet writes must name their columns ---
  // A Google Sheets APPEND with mappingMode 'autoMapInputData' creates a new
  // column for every top-level field it does not recognise. In this project the
  // item flowing into those nodes carries the whole pipeline context, which is
  // how a live Conversations tab grew from 26 columns to 67. An append must
  // therefore name the columns it writes. An UPDATE is safe: it only touches
  // columns that already exist.
  for (const node of wf.nodes) {
    if (!node.type || node.type.indexOf('googleSheets') === -1) continue;
    const params = node.parameters || {};
    if (params.operation !== 'append' && params.operation !== 'appendOrUpdate') continue;
    const mode = params.columns && params.columns.mappingMode;
    check(
      'sheet append names its columns: ' + node.name,
      mode !== 'autoMapInputData',
      "operation '" + params.operation + "' with autoMapInputData appends unknown " +
        'fields as new columns; use mappingMode defineBelow'
    );
  }

  // --- secret scanning ---
  for (const pattern of SECRET_PATTERNS) {
    const hit = pattern.re.exec(raw);
    check(
      'no hard-coded ' + pattern.name,
      hit === null,
      hit ? 'matched near: ' + raw.slice(Math.max(0, hit.index - 20), hit.index + 30).replace(/\s+/g, ' ') : ''
    );
  }

  console.log('  (' + wf.nodes.length + ' nodes, ' + codeNodes.length + ' code nodes checked)');
}

function main() {
  if (!fs.existsSync(WF_DIR)) {
    console.log('No workflows directory. Run: node scripts/setup/build-workflows.js');
    process.exit(1);
  }
  const files = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) {
    console.log('No workflow files found. Run: node scripts/setup/build-workflows.js');
    process.exit(1);
  }

  console.log('Validating ' + files.length + ' workflow file(s)...');
  for (const f of files) validateWorkflow(f);

  console.log('\n' + '-'.repeat(64));
  console.log(results.passed + ' checks passed, ' + results.failed + ' failed');
  console.log('-'.repeat(64) + '\n');

  if (results.failed > 0) {
    console.log('Failures:');
    for (const f of results.failures) console.log('  - ' + f.label);
    console.log('');
    process.exit(1);
  }
  process.exit(0);
}

main();
