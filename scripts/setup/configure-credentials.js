#!/usr/bin/env node
/**
 * Interactive credential entry.
 *
 * Prompts for each value, validates the mistakes people actually make, and
 * writes `.env` without disturbing variables you did not touch.
 *
 * SECRETS ARE NEVER ECHOED. Secret fields are read with terminal echo off, and
 * confirmation shows only a length (e.g. `<set: 211 chars>`) — enough to spot
 * "I pasted nothing" or "I pasted the wrong thing" without putting the value on
 * screen, in scrollback, or in a screenshot.
 *
 * Usage:
 *   node scripts/setup/configure-credentials.js          # only what is missing
 *   node scripts/setup/configure-credentials.js --all    # review everything
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env');
const REVIEW_ALL = process.argv.indexOf('--all') !== -1;

/**
 * Validators return null when the value is acceptable, or a message explaining
 * what is wrong. They target real paste errors, not theoretical ones.
 */
const FIELDS = [
  {
    key: 'META_PHONE_NUMBER_ID',
    secret: false,
    label: 'Meta Phone Number ID',
    help: 'WhatsApp -> API Setup. A long NUMBER, not the phone number itself.',
    url: 'https://developers.facebook.com/apps',
    validate(v) {
      if (!/^\d+$/.test(v)) return 'should be digits only';
      if (v.length < 10) return 'looks too short for a Phone Number ID';
      if (v.startsWith('+') || v.startsWith('00')) {
        return 'that looks like a phone NUMBER — you need the Phone Number ID';
      }
      return null;
    },
  },
  {
    key: 'META_WABA_ID',
    secret: false,
    optional: true,
    label: 'WhatsApp Business Account ID',
    help: 'WhatsApp -> API Setup. Optional; not used by the current workflows.',
    url: 'https://developers.facebook.com/apps',
    validate(v) {
      if (v && !/^\d+$/.test(v)) return 'should be digits only';
      return null;
    },
  },
  {
    key: 'META_APP_SECRET',
    secret: true,
    label: 'Meta App Secret',
    help: 'App Settings -> Basic -> App Secret (click Show). 32 hex characters.',
    url: 'https://developers.facebook.com/apps',
    validate(v) {
      if (!/^[0-9a-f]{32}$/i.test(v)) {
        return 'expected 32 hexadecimal characters';
      }
      return null;
    },
  },
  {
    key: 'META_ACCESS_TOKEN',
    secret: true,
    label: 'Meta Access Token',
    help: 'Use a SYSTEM USER token (never expires), not the 24-hour temporary one.',
    url: 'https://business.facebook.com/settings',
    validate(v) {
      // Check the specific mistake before the generic one, so the message
      // tells the user what to actually do.
      if (v.toLowerCase().startsWith('bearer ')) {
        return 'remove the "Bearer " prefix — put only the token here';
      }
      if (/\s/.test(v)) return 'contains whitespace — it was probably wrapped when copied';
      if (v.length < 50) return 'looks too short for a Meta access token';
      return null;
    },
    warn(v) {
      if (!v.startsWith('EAA')) {
        return 'Meta tokens usually start with "EAA" — double-check you copied the right value.';
      }
      return null;
    },
  },
  {
    key: 'WEBHOOK_VERIFY_TOKEN',
    secret: true,
    label: 'Webhook Verify Token',
    help: 'A string YOU invent. Paste the same value into the Meta webhook config.',
    url: 'https://developers.facebook.com/apps',
    validate(v) {
      if (v.length < 8) return 'use at least 8 characters';
      if (/\s/.test(v)) return 'must not contain whitespace';
      return null;
    },
  },
  {
    key: 'GOOGLE_SHEET_ID',
    secret: false,
    label: 'Google Sheet ID',
    help: 'The long string in the sheet URL between /d/ and /edit.',
    url: 'https://sheets.new',
    /** People paste the whole URL constantly, so extract it rather than reject. */
    transform(v) {
      const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(v);
      return m ? m[1] : v;
    },
    validate(v) {
      if (v.indexOf('http') === 0) return 'could not find a sheet id in that URL';
      if (!/^[a-zA-Z0-9_-]{20,}$/.test(v)) return 'does not look like a Google Sheet id';
      return null;
    },
  },
];

/** Parse .env preserving order, comments and blank lines. */
function readEnvLines() {
  if (!fs.existsSync(ENV_PATH)) return [];
  return fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
}

function currentValues(lines) {
  const out = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

/** Rewrite only the keys we changed; append any that were absent. */
function writeEnv(lines, updates) {
  const keys = Object.keys(updates);
  const seen = new Set();
  const out = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const eq = t.indexOf('=');
    if (eq === -1) return line;
    const key = t.slice(0, eq).trim();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      return key + '=' + updates[key];
    }
    return line;
  });
  for (const k of keys) {
    if (!seen.has(k)) out.push(k + '=' + updates[k]);
  }
  // Write without a BOM — Docker Compose's .env parser chokes on one.
  fs.writeFileSync(ENV_PATH, out.join('\n'), { encoding: 'utf8' });
}

/** Read a line with echo suppressed, so a pasted secret never appears. */
function askHidden(query) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    process.stdout.write(query);

    if (!stdin.isTTY) {
      // Non-interactive (piped input): fall back to a normal read.
      const rl = readline.createInterface({ input: stdin, output: process.stdout });
      rl.question('', (a) => { rl.close(); resolve(a); });
      return;
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';

    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(wasRaw || false);
        stdin.pause();
        process.stdout.write('\n');
        resolve(buf);
      } else if (ch === '') {           // Ctrl-C
        process.stdout.write('\n');
        process.exit(130);
      } else if (ch === '' || ch === '\b') {
        buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function askVisible(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (a) => { rl.close(); resolve(a.trim()); });
  });
}

function describe(field, value) {
  if (!value) return '<empty>';
  return field.secret ? '<set: ' + value.length + ' chars>' : value;
}

async function main() {
  const lines = readEnvLines();
  if (lines.length === 0) {
    console.log('No .env found. Create one first:  cp .env.example .env');
    process.exit(1);
  }

  const current = currentValues(lines);
  const updates = {};

  console.log('');
  console.log('  Credential setup');
  console.log('  Secrets are never displayed — only a character count.');
  console.log('  Press Enter to keep the current value. Ctrl-C to abort.');
  console.log('  Links and full instructions: docs/CREDENTIALS_CHECKLIST.md');
  console.log('  ' + '-'.repeat(64));

  for (const field of FIELDS) {
    const existing = current[field.key] || '';
    const isSet = existing !== '';

    if (isSet && !REVIEW_ALL) {
      // Already configured and we are only filling gaps.
      console.log('\n  ' + field.label.padEnd(30) + describe(field, existing) + '  (keeping)');
      continue;
    }

    console.log('\n  ' + field.label);
    console.log('    ' + field.help);
    console.log('    ' + field.url);
    if (isSet) console.log('    current: ' + describe(field, existing));

    let accepted = false;
    while (!accepted) {
      const prompt = '    > ';
      const raw = field.secret ? await askHidden(prompt) : await askVisible(prompt);
      let value = String(raw).trim();

      if (value === '') {
        if (isSet) { accepted = true; break; }            // keep existing
        if (field.optional) { accepted = true; break; }   // skip optional
        console.log('    (required — paste a value, or Ctrl-C to abort)');
        continue;
      }

      if (field.transform) value = field.transform(value);

      const problem = field.validate ? field.validate(value) : null;
      if (problem) {
        console.log('    rejected: ' + problem);
        continue;
      }

      const warning = field.warn ? field.warn(value) : null;
      if (warning) console.log('    note: ' + warning);

      updates[field.key] = value;
      console.log('    accepted: ' + describe(field, value));
      accepted = true;
    }
  }

  const changed = Object.keys(updates);
  console.log('\n  ' + '-'.repeat(64));

  if (changed.length === 0) {
    console.log('  Nothing changed.\n');
    return;
  }

  writeEnv(lines, updates);
  console.log('  Wrote ' + changed.length + ' value(s) to .env: ' + changed.join(', '));
  console.log('');
  console.log('  Next:');
  console.log('    docker compose up -d                     # pick up the new values');
  console.log('    node scripts/validation/check-env.js     # confirm');
  console.log('');
  console.log('  Still to do in the n8n UI (these cannot live in .env):');
  console.log('    - Google Sheets service-account credential');
  console.log('    - "Meta WhatsApp Token" header-auth credential');
  console.log('    See docs/CREDENTIALS_CHECKLIST.md part 3.');
  console.log('');
}

main().catch((err) => {
  console.error('\nFailed: ' + err.message);
  process.exit(1);
});
