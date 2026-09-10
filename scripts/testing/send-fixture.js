#!/usr/bin/env node
/**
 * Send a Meta webhook fixture to the local n8n webhook, correctly signed.
 *
 * This is the "level 2" test described in docs/TESTING.md: it exercises the
 * REAL workflow end to end — signature verification, parsing, routing,
 * deduplication — WITHOUT touching Meta and without sending a real WhatsApp
 * message to anyone. Nothing here costs money or contacts a customer.
 *
 * The signature is computed exactly the way Meta computes it (HMAC-SHA256 of
 * the raw body bytes with the app secret), so a passing test here means the
 * production signature path genuinely works.
 *
 * Usage:
 *   node scripts/testing/send-fixture.js                       # send them all
 *   node scripts/testing/send-fixture.js text-message.json     # send one
 *   node scripts/testing/send-fixture.js text-message.json --bad-signature
 *   node scripts/testing/send-fixture.js text-message.json --twice   # dedupe test
 *
 * Reads the app secret from .env.test.local (preferred) or .env. Never prints
 * secret values.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'n8n', 'fixtures');

const WEBHOOK_HOST = process.env.WEBHOOK_HOST || 'localhost';
const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT || 5678);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook/whatsapp/webhook';

/** Minimal .env parser — no dependency, tolerant of comments and blanks. */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function loadAppSecret() {
  // .env.test.local wins so a developer can test without touching real config.
  const testEnv = readEnvFile(path.join(ROOT, '.env.test.local'));
  if (testEnv.META_APP_SECRET) return testEnv.META_APP_SECRET;
  const env = readEnvFile(path.join(ROOT, '.env'));
  if (env.META_APP_SECRET) return env.META_APP_SECRET;
  return null;
}

function post(bodyBuffer, signature) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': bodyBuffer.length,
      'User-Agent': 'facebookplatform/1.0 (+http://developers.facebook.com)',
    };
    if (signature) headers['X-Hub-Signature-256'] = signature;

    const req = http.request(
      { host: WEBHOOK_HOST, port: WEBHOOK_PORT, path: WEBHOOK_PATH, method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('request timed out')); });
    req.write(bodyBuffer);
    req.end();
  });
}

async function sendFixture(name, opts) {
  const options = opts || {};
  const file = path.join(FIXTURES, name);
  if (!fs.existsSync(file)) {
    console.log('  SKIP  ' + name + ' (not found)');
    return null;
  }

  // Read the RAW BYTES — never re-serialize, or the signature will not match
  // what a real Meta request would produce.
  const bodyBuffer = fs.readFileSync(file);
  const appSecret = loadAppSecret();

  let signature = null;
  if (options.badSignature) {
    signature = 'sha256=' + '0'.repeat(64);
  } else if (options.noSignature) {
    signature = null;
  } else if (appSecret) {
    signature = 'sha256=' + crypto.createHmac('sha256', appSecret).update(bodyBuffer).digest('hex');
  }

  const result = await post(bodyBuffer, signature);
  const label = name.padEnd(32);
  const sigLabel = options.badSignature
    ? 'bad-sig  '
    : options.noSignature
      ? 'no-sig   '
      : 'signed   ';
  console.log('  ' + label + sigLabel + ' HTTP ' + result.status + '  ' + JSON.stringify(result.body).slice(0, 60));
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = {
    badSignature: args.indexOf('--bad-signature') !== -1,
    noSignature: args.indexOf('--no-signature') !== -1,
    twice: args.indexOf('--twice') !== -1,
  };
  const named = args.filter((a) => !a.startsWith('--'));

  if (!loadAppSecret() && !flags.noSignature && !flags.badSignature) {
    console.log('WARNING: META_APP_SECRET not found in .env.test.local or .env.');
    console.log('         Requests will be sent UNSIGNED and will be rejected if the');
    console.log('         workflow has an app secret configured.\n');
  }

  const files = named.length > 0
    ? named
    : fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();

  console.log('POST http://' + WEBHOOK_HOST + ':' + WEBHOOK_PORT + WEBHOOK_PATH + '\n');

  for (const f of files) {
    await sendFixture(f, flags);
    if (flags.twice) {
      // Second identical delivery — simulates a Meta retry. The system must
      // treat it as a duplicate and NOT create a second conversation.
      await sendFixture(f, flags);
    }
  }

  console.log('\nHTTP 200 means the webhook ACCEPTED and acked the event.');
  console.log('It does NOT mean downstream processing succeeded — check the n8n');
  console.log('execution list at http://localhost:5678 for the processing result.');
}

main().catch((err) => {
  console.error('Failed: ' + err.message);
  process.exit(1);
});
