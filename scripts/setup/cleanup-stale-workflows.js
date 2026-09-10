#!/usr/bin/env node
/**
 * Delete stale duplicate workflows from n8n.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before workflow ids were pinned, every `import:workflow` created a NEW copy
 * instead of updating the existing one. A few imports during development left
 * 18 duplicate "WhatsApp — ..." workflows behind. They are inert (never
 * published) but they clutter the workflow list and make it easy to open the
 * wrong one.
 *
 * The n8n CLI has NO delete command, so this uses the public REST API.
 *
 * SAFETY
 * ------
 *   - Only deletes workflows whose name starts with "WhatsApp — "
 *   - NEVER deletes one of this project's pinned ids
 *   - NEVER deletes a published/active workflow
 *   - Dry-run by default. You must pass --confirm to actually delete.
 *
 * GETTING AN API KEY
 * ------------------
 *   n8n UI -> Settings -> n8n API -> Create an API key
 *   Then:  N8N_API_KEY=<key> node scripts/setup/cleanup-stale-workflows.js
 *
 * If you would rather not create a key, deleting them in the UI is equally
 * fine: select the rows and delete. This script just makes it repeatable.
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const BASE_URL = process.env.N8N_BASE_URL || 'http://localhost:5678';
const API_KEY = process.env.N8N_API_KEY || '';
const CONFIRM = process.argv.indexOf('--confirm') !== -1;

/** Ids this project owns. These are never deleted. */
const PROTECTED_IDS = [
  'whatsappRecv0001',
  'whatsappProc0002',
  'whatsappConv0003',
  'whatsappSend0004',
  'whatsappQueu0005',
  'whatsappErrH0006',
  'whatsappShRp0007',
  'whatsappArch0008',
];

/** Only workflows named like this are even considered. */
const NAME_PREFIX = 'WhatsApp — ';

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: Object.assign(
          { 'X-N8N-API-KEY': API_KEY, Accept: 'application/json' },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
        ),
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** The API paginates; follow cursors so nothing is missed. */
async function listAllWorkflows() {
  const all = [];
  let cursor = null;

  for (let page = 0; page < 50; page += 1) {
    const path = '/api/v1/workflows?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const res = await request('GET', path);

    if (res.status === 401) {
      throw new Error(
        'Unauthorized. Create an API key in n8n: Settings -> n8n API -> Create API key,\n' +
        'then run:  N8N_API_KEY=<key> node scripts/setup/cleanup-stale-workflows.js'
      );
    }
    if (res.status !== 200) {
      throw new Error('Unexpected status ' + res.status + ': ' + JSON.stringify(res.body).slice(0, 200));
    }

    const data = res.body && res.body.data ? res.body.data : [];
    all.push.apply(all, data);

    cursor = res.body && res.body.nextCursor ? res.body.nextCursor : null;
    if (!cursor) break;
  }
  return all;
}

async function main() {
  if (!API_KEY) {
    console.log('No N8N_API_KEY set.\n');
    console.log('Create one:  n8n UI -> Settings -> n8n API -> Create an API key');
    console.log('Then run:    N8N_API_KEY=<key> node scripts/setup/cleanup-stale-workflows.js\n');
    console.log('Or simply delete the duplicates in the UI — select the rows and delete.');
    process.exit(1);
  }

  console.log('Reading workflows from ' + BASE_URL + ' ...\n');
  const workflows = await listAllWorkflows();

  const protectedOnes = [];
  const candidates = [];
  const skipped = [];

  for (const wf of workflows) {
    const id = String(wf.id);
    const name = String(wf.name || '');

    if (PROTECTED_IDS.indexOf(id) !== -1) {
      protectedOnes.push(wf);
      continue;
    }
    if (name.indexOf(NAME_PREFIX) !== 0) {
      skipped.push(wf);
      continue;
    }
    // Never touch something that is live.
    if (wf.active === true) {
      skipped.push(wf);
      console.log('  SKIP (active): ' + id + '  ' + name);
      continue;
    }
    candidates.push(wf);
  }

  console.log('Protected (this project):   ' + protectedOnes.length);
  console.log('Unrelated / active, kept:   ' + skipped.length);
  console.log('Stale duplicates found:     ' + candidates.length + '\n');

  if (candidates.length === 0) {
    console.log('Nothing to clean up.');
    return;
  }

  for (const wf of candidates) {
    console.log('  ' + wf.id + '  ' + wf.name);
  }

  if (!CONFIRM) {
    console.log('\nDRY RUN — nothing was deleted.');
    console.log('Re-run with --confirm to delete the ' + candidates.length + ' workflow(s) listed above.');
    return;
  }

  console.log('\nDeleting...');
  let deleted = 0;
  let failed = 0;

  for (const wf of candidates) {
    const res = await request('DELETE', '/api/v1/workflows/' + encodeURIComponent(wf.id));
    if (res.status === 200 || res.status === 204) {
      deleted += 1;
      console.log('  deleted  ' + wf.id);
    } else {
      failed += 1;
      console.log('  FAILED   ' + wf.id + '  (status ' + res.status + ')');
    }
  }

  console.log('\n' + deleted + ' deleted, ' + failed + ' failed.');
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\n' + err.message);
  process.exit(1);
});
