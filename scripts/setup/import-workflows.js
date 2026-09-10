#!/usr/bin/env node
/**
 * Import the generated workflows into the running n8n container.
 *
 * IDEMPOTENT. Each workflow JSON carries a stable `id` (see
 * scripts/setup/build-workflows.js -> WORKFLOW_ID), and n8n's import UPDATES a
 * workflow whose id already exists rather than creating another copy. Running
 * this repeatedly re-syncs the same workflows instead of accumulating
 * duplicates.
 *
 * Because ids are fixed at build time, Execute Workflow cross-references are
 * already correct in the JSON — there is no post-import patching step.
 *
 * Usage:
 *   node scripts/setup/import-workflows.js
 *   node scripts/setup/import-workflows.js --list   # just show what's in n8n
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const WF_DIR = path.join(ROOT, 'n8n', 'workflows');
const CONTAINER = process.env.N8N_CONTAINER || 'n8n-whatsapp';
const CONTAINER_WF_DIR = '/home/node/n8n-workflows';

/** Workflow ids this project owns, in execution order. */
const EXPECTED_IDS = [
  'whatsappRecv0001',
  'whatsappProc0002',
  'whatsappConv0003',
  'whatsappSend0004',
  'whatsappQueu0005',
  'whatsappErrH0006',
  'whatsappShRp0007',
  'whatsappArch0008',
];

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8' });
}

function containerIsRunning() {
  try {
    return docker(['ps', '--filter', 'name=' + CONTAINER, '--format', '{{.Names}}'])
      .split(/\r?\n/)
      .indexOf(CONTAINER) !== -1;
  } catch (e) {
    return false;
  }
}

/** Read back id|name pairs from n8n. */
function listWorkflows() {
  const out = docker(['exec', CONTAINER, 'n8n', 'list:workflow']);
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const idx = line.indexOf('|');
    if (idx === -1) continue;
    const id = line.slice(0, idx).trim();
    const name = line.slice(idx + 1).trim();
    if (id && name) rows.push({ id, name });
  }
  return rows;
}

function report(rows) {
  const owned = rows.filter((r) => EXPECTED_IDS.indexOf(r.id) !== -1);
  const foreign = rows.filter((r) => EXPECTED_IDS.indexOf(r.id) === -1);

  console.log('\nProject workflows (' + owned.length + '/' + EXPECTED_IDS.length + '):');
  for (const id of EXPECTED_IDS) {
    const found = owned.find((r) => r.id === id);
    console.log('  ' + (found ? '[ok] ' : '[--] ') + id + '  ' + (found ? found.name : '(not imported)'));
  }

  if (foreign.length > 0) {
    console.log('\nOther workflows in this n8n instance (' + foreign.length + '):');
    for (const r of foreign) console.log('  ' + r.id + '  ' + r.name);
    const staleCopies = foreign.filter((r) => r.name.indexOf('WhatsApp — ') === 0);
    if (staleCopies.length > 0) {
      console.log(
        '\n  NOTE: ' + staleCopies.length + ' of these are stale copies of this project\'s'
      );
      console.log('  workflows from an import made before ids were pinned. They are inert');
      console.log('  (never activated) but should be deleted in the n8n UI to avoid');
      console.log('  confusion: http://localhost:5678/home/workflows');
    }
  }
  return { owned, foreign };
}

function main() {
  if (!containerIsRunning()) {
    console.error('n8n container "' + CONTAINER + '" is not running.');
    console.error('Start it with:  docker compose up -d');
    process.exit(1);
  }

  if (process.argv.indexOf('--list') !== -1) {
    report(listWorkflows());
    return;
  }

  const files = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.error('No workflow files. Run: node scripts/setup/build-workflows.js');
    process.exit(1);
  }

  console.log('Importing ' + files.length + ' workflows into ' + CONTAINER + '...');
  // --activeState is left at its default so imports never silently activate a
  // workflow. Activation is a deliberate operator action (see docs/SETUP.md).
  const out = docker([
    'exec', CONTAINER, 'n8n', 'import:workflow',
    '--separate', '--input=' + CONTAINER_WF_DIR,
  ]);
  console.log(out.trim());

  const { owned } = report(listWorkflows());

  if (owned.length !== EXPECTED_IDS.length) {
    console.error('\nSome workflows failed to import.');
    process.exit(1);
  }

  console.log('\nNEXT STEPS (require the n8n UI at http://localhost:5678):');
  console.log('  1. Create the Google Sheets service-account credential   -> docs/SETUP.md');
  console.log('  2. Create the "Meta WhatsApp Token" header-auth credential');
  console.log('  3. Assign both credentials to the Sheets / HTTP Request nodes');
  console.log('  4. Set workflow 6 as the Error Workflow on workflows 1-5, 7, 8');
  console.log('  5. Publish the workflows you need (1,2,3 always; 4,5,7,8 optional)');
  console.log('');
  console.log('  Workflow 3 already ships with concurrency=1 in its JSON — no manual step.');
}

main();
