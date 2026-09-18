#!/usr/bin/env node
/**
 * Environment configuration checker.
 *
 * Reports which variables are set and which are missing, grouped by the feature
 * they enable — so you can see at a glance that (say) the webhook will work but
 * outgoing messages will not, rather than discovering it when a customer
 * messages you.
 *
 * NEVER PRINTS A SECRET VALUE. Only <set>/<empty> and a character count, which
 * is enough to spot "I pasted an empty string" or "I pasted the wrong thing"
 * without putting the secret into a terminal, a screenshot, or a CI log.
 *
 * Usage:
 *   node scripts/validation/check-env.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/** Variables that look like secrets and must never have their value printed. */
const SECRET_PATTERN =
  /(TOKEN|SECRET|KEY|PASSWORD|PRIVATE|CREDENTIAL)/i;

const GROUPS = [
  {
    name: 'n8n core',
    required: true,
    vars: [
      { key: 'N8N_ENCRYPTION_KEY', required: true, note: '64 hex chars; back this up', validate: (v) => /^[0-9a-f]{64}$/.test(v) ? null : 'expected 64 hex characters' },
      { key: 'TZ', required: false, note: 'default Asia/Amman' },
      { key: 'GENERIC_TIMEZONE', required: false, note: 'default Asia/Amman' },
      { key: 'N8N_WEBHOOK_URL', required: false, note: 'set to your tunnel URL for Meta' },
    ],
  },
  {
    name: 'Inbound webhook (receiving customer messages)',
    required: true,
    vars: [
      { key: 'WEBHOOK_VERIFY_TOKEN', required: true, note: 'you invent this; must match Meta dashboard' },
      { key: 'META_APP_SECRET', required: true, note: 'without it, ALL webhooks are rejected (fail closed)' },
    ],
  },
  {
    name: 'Outbound messages (agent replies)',
    required: false,
    vars: [
      { key: 'META_ACCESS_TOKEN', required: true, note: 'use a System User token, not the 24h temporary one' },
      { key: 'META_PHONE_NUMBER_ID', required: true, note: 'the ID, not the phone number' },
      { key: 'META_GRAPH_API_VERSION', required: false, note: 'default v26.0' },
      { key: 'META_WABA_ID', required: false, note: 'not used by current workflows' },
    ],
  },
  {
    name: 'Agent send API (workflow 4)',
    required: false,
    vars: [
      { key: 'AGENT_SEND_API_KEY', required: true, note: 'X-Agent-Key header; unset = every send rejected (fail closed)' },
    ],
  },
  {
    name: 'WAHA connector (only when WHATSAPP_CONNECTOR=waha)',
    required: false,
    vars: [
      { key: 'WHATSAPP_CONNECTOR', required: false, note: 'meta (default) or waha' },
      { key: 'WAHA_API_KEY', required: true, note: 'admin key, 64+ random chars; n8n never gets it', validate: (v) => v.length >= 64 ? null : 'WAHA\'s security alert asks for at least 64 characters' },
      { key: 'WAHA_SEND_API_KEY', required: true, note: 'written by: node scripts/setup/configure-waha.js' },
      { key: 'WAHA_HMAC_SECRET', required: true, note: 'unset = workflow 1b rejects every event' },
      { key: 'WAHA_DASHBOARD_PASSWORD', required: true, note: 'Dashboard + Swagger login' },
      { key: 'WAHA_SESSION', required: false, note: 'default "default"' },
    ],
  },
  {
    name: 'Google Sheets persistence',
    required: false,
    vars: [
      { key: 'GOOGLE_SHEET_ID', required: true, note: 'from the spreadsheet URL' },
      { key: 'GOOGLE_SERVICE_ACCOUNT_EMAIL', required: false, note: 'the Sheets node uses an n8n credential instead' },
      { key: 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', required: false, note: 'the Sheets node uses an n8n credential instead' },
    ],
  },
  {
    name: 'Business logic tuning',
    required: false,
    vars: [
      { key: 'CONVERSATION_INACTIVITY_HOURS', required: false, note: 'default 24; does NOT auto-close' },
      { key: 'DEFAULT_COUNTRY_CODE', required: false, note: 'default 962 (Jordan)' },
      { key: 'ASSIGNMENT_STRATEGY', required: false, note: 'default LEAST_OPEN_CONVERSATIONS' },
      { key: 'REOPEN_CLOSED_CONVERSATIONS', required: false, note: 'default true' },
      { key: 'N8N_CONCURRENCY_PRODUCTION_LIMIT', required: false, note: 'set to 1 to serialize assignment' },
    ],
  },
];

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

/** Render a value safely: secrets become a length, non-secrets show through. */
function describe(key, value) {
  if (value === undefined || value === '') return '<empty>';
  if (SECRET_PATTERN.test(key)) return '<set: ' + value.length + ' chars>';
  return value;
}

function main() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    console.log('No .env file found.\n');
    console.log('Create one with:  cp .env.example .env');
    process.exit(1);
  }

  const env = readEnvFile(envPath);
  console.log('Configuration check — .env\n');

  let blocking = 0;
  const featureStatus = [];

  for (const group of GROUPS) {
    console.log('  ' + group.name);
    let groupMissing = 0;

    for (const v of group.vars) {
      const value = env[v.key];
      const isSet = value !== undefined && value !== '';
      const validationError = isSet && v.validate ? v.validate(value) : null;

      let mark;
      if (isSet && !validationError) {
        mark = 'ok  ';
      } else if (!isSet && v.required) {
        mark = 'MISS';
        groupMissing += 1;
      } else if (validationError) {
        mark = 'BAD ';
        groupMissing += 1;
      } else {
        mark = '--  ';
      }

      console.log(
        '    [' + mark + '] ' + v.key.padEnd(36) + describe(v.key, value)
      );
      if (validationError) {
        console.log('             ^ ' + validationError);
      }
      if ((mark === 'MISS' || mark === 'BAD ') && v.note) {
        console.log('             ^ ' + v.note);
      }
    }

    const working = groupMissing === 0;
    featureStatus.push({ name: group.name, working, required: group.required });
    if (!working && group.required) blocking += 1;
    console.log('');
  }

  console.log('  ' + '-'.repeat(62));
  console.log('  Feature readiness:');
  for (const f of featureStatus) {
    console.log('    ' + (f.working ? '[ready]      ' : '[incomplete] ') + f.name);
  }
  console.log('  ' + '-'.repeat(62) + '\n');

  if (blocking > 0) {
    console.log('  ' + blocking + ' required group(s) incomplete — the system cannot receive');
    console.log('  messages until those are set. See docs/ENVIRONMENT.md.\n');
    process.exit(1);
  }

  console.log('  Core configuration is complete.');
  console.log('  Incomplete optional groups just mean those features are not enabled yet.\n');
  process.exit(0);
}

main();
