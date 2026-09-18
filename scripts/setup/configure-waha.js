#!/usr/bin/env node
/**
 * Put the WAHA session this project uses into the state docs/WAHA_REFERENCE.md
 * describes, and mint the two scoped keys n8n uses.
 *
 * IDEMPOTENT. Re-running converges on the same state and changes nothing
 * that is already right.
 *
 *   1. Session WAHA_SESSION ("default") gets exactly this config:
 *        ignore  status, groups, channels, broadcast = true
 *        noweb   markOnline = false — otherwise WhatsApp stops sending push
 *                notifications to the owner's phone while WAHA is connected
 *        no per-session webhooks — the global WHATSAPP_HOOK_* webhook in
 *                docker-compose.yml already covers every session; a
 *                per-session copy of it made WAHA post every event twice
 *      The NOWEB store stays off: nothing here reads chat history from WAHA.
 *      A missing session is created STOPPED; start it from the Dashboard when
 *      the phone is in hand, since the QR expires after about 2 min 40 s.
 *      WAHA restarts a running session to apply new config; a linked session
 *      reconnects by itself, no re-scan.
 *
 *   2. A key scoped to WAHA_SESSION that can only SEND — reused if one exists,
 *      created through WAHA's Keys API if not — is written to .env as
 *      WAHA_SEND_API_KEY. The value is never printed. Recreate n8n afterwards
 *      (`docker compose up -d n8n`) so it picks the key up.
 *
 *   3. A SECOND key, scoped to WAHA_SESSION with read+control but never
 *      send, written to .env as WAHA_STATUS_API_KEY — for the management
 *      UI's Connection tab (status, QR, restart). Kept separate from the
 *      send-only key: neither key alone can both read connection state
 *      and send as the business.
 *
 *   4. Warns about any OTHER session with a webhook pointing outside this
 *      stack. The Dashboard's "Add webhook" button fills in
 *      https://httpbin.org/post, a public third-party service.
 *
 * Talks to WAHA on the host port (WAHA_URL, default http://localhost:3000)
 * with the admin WAHA_API_KEY from .env.
 *
 * Usage:
 *   node scripts/setup/configure-waha.js           # apply
 *   node scripts/setup/configure-waha.js --check   # report only, change nothing
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env');
const CHECK_ONLY = process.argv.includes('--check');

const SEND_ONLY = { read: false, send: true, control: false, setting: false, app: false, delete: false };
// Session status + QR + restart, for the management UI's Connection tab —
// same least-privilege reasoning as SEND_ONLY: this key can see connection
// state and reconnect the session, but cannot send a message, change
// settings, or touch any OTHER session. No dedicated /api/keys/status
// convenience endpoint exists (unlike /api/keys/control, which grants
// control alone but not read), so this goes through the generic
// POST /api/keys with explicit actions, same as SEND_ONLY does.
const STATUS_AND_CONTROL = { read: true, send: false, control: true, setting: false, app: false, delete: false };

function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_PATH)) return out;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq !== -1) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

/** Set KEY=value in .env, replacing an existing line or appending one. */
function writeEnvValue(key, value) {
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const line = key + '=' + value;
  const pattern = new RegExp('^' + key + '=.*$', 'm');
  const next = pattern.test(raw)
    ? raw.replace(pattern, line)
    : raw.replace(/\s*$/, '') + eol + eol + '# Send-only WAHA session key, minted by scripts/setup/configure-waha.js' + eol + line + eol;
  fs.writeFileSync(ENV_PATH, next, 'utf8');
}

function desiredConfig() {
  return {
    ignore: { status: true, groups: true, channels: true, broadcast: true },
    noweb: { markOnline: false },
  };
}

/** True when the session's stored config already matches desiredConfig(). */
function configMatches(config) {
  const c = config || {};
  const ig = c.ignore || {};
  const webhooks = Array.isArray(c.webhooks) ? c.webhooks : [];
  return ig.status === true && ig.groups === true && ig.channels === true && ig.broadcast === true
    && c.noweb && c.noweb.markOnline === false
    && !(c.noweb.store && c.noweb.store.enabled)
    && webhooks.length === 0;
}

function isSendOnlyKeyFor(k, session) {
  if (!k || k.isAdmin || !k.isActive || k.session !== session || !k.actions) return false;
  return Object.keys(SEND_ONLY).every((a) => k.actions[a] === SEND_ONLY[a]);
}

function isStatusKeyFor(k, session) {
  if (!k || k.isAdmin || !k.isActive || k.session !== session || !k.actions) return false;
  return Object.keys(STATUS_AND_CONTROL).every((a) => k.actions[a] === STATUS_AND_CONTROL[a]);
}

async function main() {
  const env = readEnv();
  const base = (process.env.WAHA_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const adminKey = env.WAHA_API_KEY;
  const session = env.WAHA_SESSION || 'default';

  if (!adminKey) {
    console.error('WAHA_API_KEY is empty in .env — nothing to authenticate with.');
    process.exit(1);
  }

  async function call(method, uri, body, key) {
    const res = await fetch(base + uri, {
      method,
      headers: { 'X-Api-Key': key || adminKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { status: res.status, json };
  }

  const ping = await call('GET', '/api/server/version').catch((e) => ({ status: 0, error: e }));
  if (ping.status !== 200) {
    console.error('Cannot reach WAHA at ' + base + ' (status ' + ping.status + ').');
    console.error('Is the container up (`docker compose up -d waha`) and WAHA_API_KEY right?');
    process.exit(1);
  }
  console.log('WAHA ' + ping.json.version + ' (' + ping.json.engine + ') at ' + base + (CHECK_ONLY ? '  [--check: no changes]' : ''));

  // ---- 1. Session config -------------------------------------------------
  const existing = await call('GET', '/api/sessions/' + encodeURIComponent(session));
  if (existing.status === 404) {
    if (CHECK_ONLY) {
      console.log('  [--] session "' + session + '" does not exist');
    } else {
      const r = await call('POST', '/api/sessions', { name: session, start: false, config: desiredConfig() });
      if (r.status >= 300) throw new Error('create session failed: HTTP ' + r.status + ' ' + JSON.stringify(r.json));
      console.log('  [ok] session "' + session + '" created (STOPPED) — start it from the Dashboard to scan the QR');
    }
  } else if (existing.status === 200) {
    const s = existing.json;
    if (configMatches(s.config)) {
      console.log('  [ok] session "' + session + '" config already correct (status ' + s.status + ')');
    } else if (CHECK_ONLY) {
      console.log('  [!!] session "' + session + '" config differs: ' + JSON.stringify(s.config));
    } else {
      const r = await call('PUT', '/api/sessions/' + encodeURIComponent(session), { name: session, config: desiredConfig() });
      if (r.status >= 300) throw new Error('update session failed: HTTP ' + r.status + ' ' + JSON.stringify(r.json));
      console.log('  [ok] session "' + session + '" config updated (was ' + JSON.stringify(s.config) + ')');
    }
  } else {
    throw new Error('GET session failed: HTTP ' + existing.status);
  }

  // ---- 2. Send-only key --------------------------------------------------
  const keys = await call('GET', '/api/keys');
  if (keys.status !== 200 || !Array.isArray(keys.json)) throw new Error('GET /api/keys failed: HTTP ' + keys.status);
  let sendKey = keys.json.find((k) => isSendOnlyKeyFor(k, session));

  if (!sendKey && !CHECK_ONLY) {
    const r = await call('POST', '/api/keys', { isAdmin: false, session, isActive: true, actions: SEND_ONLY });
    if (r.status >= 300 || !r.json || !r.json.key) throw new Error('create key failed: HTTP ' + r.status);
    sendKey = r.json;
    console.log('  [ok] send-only key created for "' + session + '" (id ' + sendKey.id + ')');
  } else if (sendKey) {
    console.log('  [ok] send-only key exists for "' + session + '" (id ' + sendKey.id + ')');
  } else {
    console.log('  [--] no send-only key for "' + session + '"');
  }

  if (sendKey) {
    if (env.WAHA_SEND_API_KEY === sendKey.key) {
      console.log('  [ok] .env WAHA_SEND_API_KEY matches it');
    } else if (CHECK_ONLY) {
      console.log('  [!!] .env WAHA_SEND_API_KEY ' + (env.WAHA_SEND_API_KEY ? 'does not match it' : 'is empty'));
    } else {
      writeEnvValue('WAHA_SEND_API_KEY', sendKey.key);
      console.log('  [ok] .env WAHA_SEND_API_KEY written (' + sendKey.key.length + ' chars, value not shown)');
      console.log('       -> recreate n8n so it picks the key up:  docker compose up -d n8n');
    }

    // Prove the scope: this key must NOT be able to read.
    const probe = await call('GET', '/api/sessions/' + encodeURIComponent(session), undefined, sendKey.key);
    const denied = probe.status === 401 || probe.status === 403;
    console.log('  [' + (denied ? 'ok' : '!!') + '] send-only key reading session info -> HTTP ' + probe.status
      + (denied ? ' (denied, as intended)' : ' — EXPECTED A DENIAL, check the key scope'));
  }

  // ---- 3. Status/control key (read + control, no send) -------------------
  // For the management UI's Connection tab: session status, QR, restart —
  // never a message. Kept as a THIRD key, not folded into sendKey or the
  // admin key, so a compromised UI can reconnect a session but never send
  // as the business, and a compromised n8n send path still cannot read
  // connection state or force a reconnect.
  let statusKey = keys.json.find((k) => isStatusKeyFor(k, session));

  if (!statusKey && !CHECK_ONLY) {
    const r = await call('POST', '/api/keys', { isAdmin: false, session, isActive: true, actions: STATUS_AND_CONTROL });
    if (r.status >= 300 || !r.json || !r.json.key) throw new Error('create status key failed: HTTP ' + r.status);
    statusKey = r.json;
    console.log('  [ok] status/control key created for "' + session + '" (id ' + statusKey.id + ')');
  } else if (statusKey) {
    console.log('  [ok] status/control key exists for "' + session + '" (id ' + statusKey.id + ')');
  } else {
    console.log('  [--] no status/control key for "' + session + '"');
  }

  if (statusKey) {
    if (env.WAHA_STATUS_API_KEY === statusKey.key) {
      console.log('  [ok] .env WAHA_STATUS_API_KEY matches it');
    } else if (CHECK_ONLY) {
      console.log('  [!!] .env WAHA_STATUS_API_KEY ' + (env.WAHA_STATUS_API_KEY ? 'does not match it' : 'is empty'));
    } else {
      writeEnvValue('WAHA_STATUS_API_KEY', statusKey.key);
      console.log('  [ok] .env WAHA_STATUS_API_KEY written (' + statusKey.key.length + ' chars, value not shown)');
      console.log('       -> recreate n8n so it picks the key up:  docker compose up -d n8n');
    }

    // Prove the scope both ways: can read, cannot send.
    const readProbe = await call('GET', '/api/sessions/' + encodeURIComponent(session), undefined, statusKey.key);
    console.log('  [' + (readProbe.status === 200 ? 'ok' : '!!') + '] status key reading session info -> HTTP ' + readProbe.status
      + (readProbe.status === 200 ? ' (allowed, as intended)' : ' — EXPECTED SUCCESS, check the key scope'));

    const sendProbe = await call('POST', '/api/sendText', { session, chatId: '000000000000@c.us', text: 'scope probe — should be rejected' }, statusKey.key);
    const sendDenied = sendProbe.status === 401 || sendProbe.status === 403;
    console.log('  [' + (sendDenied ? 'ok' : '!!') + '] status key attempting to send -> HTTP ' + sendProbe.status
      + (sendDenied ? ' (denied, as intended)' : ' — EXPECTED A DENIAL, check the key scope'));
  }

  // ---- 4. Foreign webhooks on other sessions -----------------------------
  const all = await call('GET', '/api/sessions?all=true');
  const warnings = [];
  for (const s of Array.isArray(all.json) ? all.json : []) {
    for (const w of (s.config && s.config.webhooks) || []) {
      let host = '';
      try { host = new URL(w.url).hostname; } catch (e) { host = String(w.url); }
      if (host !== 'n8n') warnings.push(s.name + ' -> ' + w.url + (w.hmac && w.hmac.key ? '' : ' (unsigned)'));
    }
  }
  if (warnings.length) {
    console.log('\n  WARNING: webhooks leaving this stack — every message on these sessions goes there:');
    for (const w of warnings) console.log('    ' + w);
    console.log('  Delete the session (DELETE /api/sessions/<name>) or fix its webhook before linking a phone to it.');
  } else {
    console.log('  [ok] no session sends webhooks outside this stack');
  }
}

main().catch((e) => {
  console.error('configure-waha failed: ' + e.message);
  process.exit(1);
});
