/**
 * Webhook security: signature verification, verify-token handshake, redaction.
 *
 * CANONICAL SOURCE. Unit-tested (tests/webhook/security.test.js) and injected
 * into n8n Code nodes by scripts/setup/build-workflows.js.
 *
 * Verified against official documentation on 2026-09-09:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 *   - GET verification: hub.mode / hub.verify_token / hub.challenge
 *   - POST payloads signed as X-Hub-Signature-256: sha256=<hex hmac>
 */

'use strict';

// `crypto` is available inside n8n Code nodes and in plain Node.
const crypto = require('crypto');

/**
 * Constant-time string comparison.
 *
 * A naive `a === b` on a secret leaks length and prefix information through
 * timing. `crypto.timingSafeEqual` requires equal-length buffers, so we hash
 * both sides first — this makes the comparison both constant-time AND
 * length-agnostic.
 */
function safeEqual(a, b) {
  const bufA = crypto.createHash('sha256').update(String(a === undefined || a === null ? '' : a)).digest();
  const bufB = crypto.createHash('sha256').update(String(b === undefined || b === null ? '' : b)).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Handle Meta's GET webhook verification handshake.
 *
 * Meta sends: ?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<int>
 * On success the endpoint MUST return the raw challenge value (status 200),
 * with no JSON wrapper — Meta compares the body byte-for-byte.
 *
 * @param {object} query          The parsed query string ($json.query in n8n).
 * @param {string} expectedToken  WEBHOOK_VERIFY_TOKEN from the environment.
 * @returns {{ ok: boolean, statusCode: number, body: string, reason: string }}
 */
function verifyWebhookHandshake(query, expectedToken) {
  const q = query || {};
  // n8n exposes dotted query keys verbatim, e.g. q['hub.mode'].
  const mode = q['hub.mode'] !== undefined ? String(q['hub.mode']) : null;
  const token = q['hub.verify_token'] !== undefined ? String(q['hub.verify_token']) : null;
  const challenge = q['hub.challenge'] !== undefined ? String(q['hub.challenge']) : null;

  if (!expectedToken || String(expectedToken).trim() === '') {
    // Fail closed: an unset verify token must never accept a handshake,
    // otherwise anyone could bind their own app to this endpoint.
    return {
      ok: false,
      statusCode: 500,
      body: 'verify token not configured',
      reason: 'VERIFY_TOKEN_NOT_CONFIGURED',
    };
  }
  if (mode !== 'subscribe') {
    return { ok: false, statusCode: 403, body: 'Forbidden', reason: 'BAD_HUB_MODE' };
  }
  if (token === null || !safeEqual(token, expectedToken)) {
    return { ok: false, statusCode: 403, body: 'Forbidden', reason: 'VERIFY_TOKEN_MISMATCH' };
  }
  if (challenge === null || challenge === '') {
    return { ok: false, statusCode: 400, body: 'Bad Request', reason: 'MISSING_CHALLENGE' };
  }
  return { ok: true, statusCode: 200, body: challenge, reason: 'VERIFIED' };
}

/**
 * Verify the X-Hub-Signature-256 HMAC on an incoming webhook POST.
 *
 * CRITICAL: the HMAC must be computed over the EXACT RAW BODY BYTES Meta sent.
 * Re-serializing the parsed JSON (JSON.stringify(body)) changes key order,
 * whitespace and unicode escaping, producing a different digest and rejecting
 * every legitimate request. In n8n this requires the Webhook node option
 * "Raw Body" to be enabled — see docs/N8N_WORKFLOWS.md.
 *
 * @param {string|Buffer} rawBody   Exact bytes of the request body.
 * @param {string} signatureHeader  Value of the X-Hub-Signature-256 header.
 * @param {string} appSecret        META_APP_SECRET.
 * @param {object} [opts]
 * @param {boolean} [opts.required=true]  When false, a missing signature is
 *        allowed (local fixture testing only — never in production).
 * @returns {{ ok: boolean, reason: string, statusCode: number }}
 */
function verifySignature(rawBody, signatureHeader, appSecret, opts) {
  const options = opts || {};
  const required = options.required === undefined ? true : !!options.required;

  if (!appSecret || String(appSecret).trim() === '') {
    if (!required) {
      return { ok: true, reason: 'SIGNATURE_CHECK_DISABLED', statusCode: 200 };
    }
    // Fail closed rather than silently accepting unsigned traffic.
    return { ok: false, reason: 'APP_SECRET_NOT_CONFIGURED', statusCode: 500 };
  }

  if (!signatureHeader || String(signatureHeader).trim() === '') {
    if (!required) {
      return { ok: true, reason: 'SIGNATURE_ABSENT_BUT_NOT_REQUIRED', statusCode: 200 };
    }
    return { ok: false, reason: 'MISSING_SIGNATURE_HEADER', statusCode: 401 };
  }

  const header = String(signatureHeader).trim();
  if (header.indexOf('sha256=') !== 0) {
    return { ok: false, reason: 'MALFORMED_SIGNATURE_HEADER', statusCode: 401 };
  }
  const provided = header.slice('sha256='.length).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return { ok: false, reason: 'MALFORMED_SIGNATURE_DIGEST', statusCode: 401 };
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody === undefined || rawBody === null ? '' : rawBody), 'utf8');
  const expected = crypto.createHmac('sha256', String(appSecret)).update(body).digest('hex');

  // Both are fixed-length hex strings here, so a direct timing-safe compare works.
  const okSig = crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  if (!okSig) {
    return { ok: false, reason: 'SIGNATURE_MISMATCH', statusCode: 401 };
  }
  return { ok: true, reason: 'SIGNATURE_VALID', statusCode: 200 };
}

/**
 * Check a shared-secret request header (e.g. workflow 4's X-Agent-Key)
 * against the configured value.
 *
 * Fails CLOSED like verifySignature: an unset expected key rejects every
 * request with 500 rather than letting unauthenticated traffic through.
 *
 * @param {object} headers      Request headers. n8n lower-cases the names;
 *                              any casing is accepted here.
 * @param {string} headerName   The header carrying the key.
 * @param {string} expectedKey  The secret from the environment.
 * @returns {{ ok: boolean, statusCode: number, reason: string }}
 */
function verifyApiKeyHeader(headers, headerName, expectedKey) {
  if (!expectedKey || String(expectedKey).trim() === '') {
    return { ok: false, statusCode: 500, reason: 'API_KEY_NOT_CONFIGURED' };
  }
  const h = headers || {};
  const wanted = String(headerName).toLowerCase();
  let provided;
  for (const name of Object.keys(h)) {
    if (name.toLowerCase() === wanted) {
      provided = h[name];
      break;
    }
  }
  if (provided === undefined || provided === null || String(provided) === '') {
    return { ok: false, statusCode: 401, reason: 'MISSING_API_KEY' };
  }
  if (!safeEqual(String(provided), String(expectedKey))) {
    return { ok: false, statusCode: 401, reason: 'API_KEY_MISMATCH' };
  }
  return { ok: true, statusCode: 200, reason: 'API_KEY_VALID' };
}

/** Compute a signature — used by the local test harness to sign fixtures. */
function computeSignature(rawBody, appSecret) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return 'sha256=' + crypto.createHmac('sha256', String(appSecret)).update(body).digest('hex');
}

/** Keys whose values must never appear in logs, in any casing. */
const SENSITIVE_KEY_PATTERN =
  /(authorization|access[_-]?token|api[_-]?key|agent[_-]?key|management[_-]?key|app[_-]?secret|private[_-]?key|verify[_-]?token|encryption[_-]?key|password|secret|credential|bearer|x-hub-signature|x-webhook-hmac)/i;

/**
 * Recursively redact sensitive values so payloads can be logged safely.
 * Depth-limited to avoid pathological structures.
 */
function redact(value, depth) {
  const d = depth === undefined ? 0 : depth;
  if (d > 8) return '[max-depth]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, d + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        const raw = value[key];
        out[key] =
          raw === null || raw === undefined || raw === ''
            ? '[REDACTED:empty]'
            : '[REDACTED:' + String(raw).length + 'chars]';
      } else {
        out[key] = redact(value[key], d + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * Redact a bare token for display, e.g. in an operator-facing error message.
 * Shows only enough to identify which credential is in play.
 */
function maskToken(token) {
  if (token === null || token === undefined || String(token) === '') return '[empty]';
  const s = String(token);
  if (s.length <= 8) return '[REDACTED:' + s.length + 'chars]';
  return s.slice(0, 4) + '…' + s.slice(-2) + ' (' + s.length + ' chars)';
}

module.exports = {
  verifyWebhookHandshake,
  verifySignature,
  verifyApiKeyHeader,
  computeSignature,
  safeEqual,
  redact,
  maskToken,
  SENSITIVE_KEY_PATTERN,
};
