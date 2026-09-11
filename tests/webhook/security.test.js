/**
 * Test scenario 25 (credentials not exposed) plus webhook verification and
 * HMAC signature validation.
 */

'use strict';

const {
  verifyWebhookHandshake,
  verifySignature,
  computeSignature,
  redact,
  maskToken,
} = require('../../scripts/lib/security');

const APP_SECRET = 'test_app_secret_do_not_use_in_production';
const VERIFY_TOKEN = 'test_verify_token_12345';

describe('webhook GET verification handshake', () => {
  it('echoes the challenge when mode and token are correct', () => {
    const r = verifyWebhookHandshake(
      { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1158201444' },
      VERIFY_TOKEN
    );
    assert.ok(r.ok);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, '1158201444', 'must return the raw challenge, unwrapped');
  });

  it('rejects a wrong verify token with 403', () => {
    const r = verifyWebhookHandshake(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '123' },
      VERIFY_TOKEN
    );
    assert.notOk(r.ok);
    assert.equal(r.statusCode, 403);
    assert.equal(r.reason, 'VERIFY_TOKEN_MISMATCH');
  });

  it('rejects a wrong hub.mode', () => {
    const r = verifyWebhookHandshake(
      { 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '123' },
      VERIFY_TOKEN
    );
    assert.equal(r.statusCode, 403);
    assert.equal(r.reason, 'BAD_HUB_MODE');
  });

  it('rejects a missing challenge with 400', () => {
    const r = verifyWebhookHandshake(
      { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN },
      VERIFY_TOKEN
    );
    assert.equal(r.statusCode, 400);
    assert.equal(r.reason, 'MISSING_CHALLENGE');
  });

  it('FAILS CLOSED when the verify token is not configured', () => {
    // Otherwise anyone could bind their own Meta app to this endpoint.
    for (const unset of ['', null, undefined, '   ']) {
      const r = verifyWebhookHandshake(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'anything', 'hub.challenge': '123' },
        unset
      );
      assert.notOk(r.ok, 'must not verify with unset token: ' + String(unset));
      assert.equal(r.reason, 'VERIFY_TOKEN_NOT_CONFIGURED');
    }
  });

  it('never throws on missing or hostile query objects', () => {
    for (const q of [null, undefined, {}, { 'hub.mode': null }, []]) {
      assert.doesNotThrow(() => verifyWebhookHandshake(q, VERIFY_TOKEN));
    }
  });
});

describe('X-Hub-Signature-256 verification', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

  it('accepts a correctly signed payload', () => {
    const sig = computeSignature(body, APP_SECRET);
    const r = verifySignature(body, sig, APP_SECRET);
    assert.ok(r.ok, r.reason);
    assert.equal(r.reason, 'SIGNATURE_VALID');
  });

  it('rejects a payload whose body was tampered with', () => {
    const sig = computeSignature(body, APP_SECRET);
    const tampered = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ evil: true }] });
    const r = verifySignature(tampered, sig, APP_SECRET);
    assert.notOk(r.ok);
    assert.equal(r.reason, 'SIGNATURE_MISMATCH');
    assert.equal(r.statusCode, 401);
  });

  it('rejects a signature made with the wrong secret', () => {
    const sig = computeSignature(body, 'attacker_secret');
    const r = verifySignature(body, sig, APP_SECRET);
    assert.notOk(r.ok);
    assert.equal(r.reason, 'SIGNATURE_MISMATCH');
  });

  it('rejects a missing signature header by default', () => {
    const r = verifySignature(body, '', APP_SECRET);
    assert.notOk(r.ok);
    assert.equal(r.reason, 'MISSING_SIGNATURE_HEADER');
  });

  it('rejects malformed signature headers', () => {
    assert.equal(verifySignature(body, 'garbage', APP_SECRET).reason, 'MALFORMED_SIGNATURE_HEADER');
    assert.equal(verifySignature(body, 'sha256=nothex', APP_SECRET).reason, 'MALFORMED_SIGNATURE_DIGEST');
    assert.equal(verifySignature(body, 'sha256=abc', APP_SECRET).reason, 'MALFORMED_SIGNATURE_DIGEST');
  });

  it('FAILS CLOSED when the app secret is not configured', () => {
    const r = verifySignature(body, computeSignature(body, APP_SECRET), '');
    assert.notOk(r.ok, 'unsigned traffic must not be silently accepted');
    assert.equal(r.reason, 'APP_SECRET_NOT_CONFIGURED');
  });

  it('allows an explicit opt-out for local fixture testing only', () => {
    const r = verifySignature(body, '', '', { required: false });
    assert.ok(r.ok);
    assert.equal(r.reason, 'SIGNATURE_CHECK_DISABLED');
  });

  it('verifies over RAW BYTES, so key reordering breaks the signature (as it must)', () => {
    // This proves why the n8n Webhook node must be configured with Raw Body:
    // re-serialising parsed JSON changes the bytes and would reject every
    // legitimate Meta request.
    const original = '{"a":1,"b":2}';
    const reserialized = JSON.stringify(JSON.parse('{"b":2,"a":1}'));
    const sig = computeSignature(original, APP_SECRET);
    assert.ok(verifySignature(original, sig, APP_SECRET).ok, 'raw bytes verify');
    assert.notOk(verifySignature(reserialized, sig, APP_SECRET).ok, 'reordered bytes do not');
  });

  it('handles unicode bodies (Arabic) byte-exactly', () => {
    const arabic = JSON.stringify({ text: 'مرحبا، بدي أعرف السعر.' });
    const sig = computeSignature(arabic, APP_SECRET);
    assert.ok(verifySignature(arabic, sig, APP_SECRET).ok);
    assert.ok(verifySignature(Buffer.from(arabic, 'utf8'), sig, APP_SECRET).ok, 'Buffer input too');
  });

  it('never throws on hostile input', () => {
    for (const b of [null, undefined, '', 0, {}]) {
      assert.doesNotThrow(() => verifySignature(b, 'sha256=' + 'a'.repeat(64), APP_SECRET));
    }
  });
});

describe('secret redaction (scenario 25: credentials must not appear in logs)', () => {
  it('redacts every sensitive key name variant', () => {
    const payload = {
      Authorization: 'Bearer EAAG_super_secret_token_value',
      access_token: 'EAAG123456789',
      META_ACCESS_TOKEN: 'EAAG123456789',
      app_secret: 'abc123',
      appSecret: 'abc123',
      'x-hub-signature-256': 'sha256=deadbeef',
      private_key: '-----BEGIN PRIVATE KEY-----MIIEv...',
      WEBHOOK_VERIFY_TOKEN: 'my-token',
      n8n_encryption_key: 'ffff',
      password: 'hunter2',
      safe_field: 'this must survive',
    };
    const out = redact(payload);
    const serialized = JSON.stringify(out);

    for (const leak of ['EAAG_super_secret_token_value', 'EAAG123456789', 'abc123', 'deadbeef', 'MIIEv', 'my-token', 'hunter2']) {
      assert.ok(serialized.indexOf(leak) === -1, 'leaked secret value: ' + leak);
    }
    assert.equal(out.safe_field, 'this must survive', 'non-secrets must be preserved');
  });

  it('reports the length so operators can tell an empty token from a wrong one', () => {
    const out = redact({ access_token: '12345' });
    assert.equal(out.access_token, '[REDACTED:5chars]');
    assert.equal(redact({ access_token: '' }).access_token, '[REDACTED:empty]');
  });

  it('redacts nested structures, including inside arrays', () => {
    const out = redact({
      request: { headers: { authorization: 'Bearer leak_me' } },
      list: [{ api_key: 'leak_me_too' }],
    });
    const s = JSON.stringify(out);
    assert.ok(s.indexOf('leak_me') === -1, 'nested secret leaked');
    assert.ok(s.indexOf('leak_me_too') === -1, 'array secret leaked');
  });

  it('does not recurse forever on cyclic-ish deep structures', () => {
    let deep = { value: 'bottom' };
    for (let i = 0; i < 30; i += 1) deep = { nested: deep };
    assert.doesNotThrow(() => redact(deep));
  });

  it('maskToken shows enough to identify a credential without exposing it', () => {
    const masked = maskToken('EAAGabcdefghijklmnop');
    assert.ok(masked.indexOf('abcdefghijklmn') === -1, 'must not show the middle');
    assert.includes(masked, '20 chars');
    assert.equal(maskToken(''), '[empty]');
    assert.equal(maskToken('short'), '[REDACTED:5chars]');
  });

  it('preserves non-secret payload content so logs stay useful', () => {
    const out = redact({
      message_id: 'wamid.ABC',
      customer_phone: '962791234567',
      text: 'مرحبا',
      access_token: 'secret',
    });
    assert.equal(out.message_id, 'wamid.ABC');
    assert.equal(out.customer_phone, '962791234567');
    assert.equal(out.text, 'مرحبا');
  });
});

describe('signature verification fails closed (production regression)', () => {
  // A real deployment accepted a FORGED, unsigned webhook because
  // META_APP_SECRET was empty and the code inferred "not required" from
  // "not configured". Absence of a secret must be a misconfiguration, never
  // permission. These tests pin that behaviour.

  it('rejects an unsigned payload when no app secret is configured', () => {
    const body = '{"object":"whatsapp_business_account"}';
    const r = verifySignature(body, '', '', { required: true });
    assert.notOk(r.ok, 'an unconfigured secret must NOT mean "accept anything"');
    assert.equal(r.reason, 'APP_SECRET_NOT_CONFIGURED');
    assert.equal(r.statusCode, 500, 'surfaces as a server misconfiguration');
  });

  it('rejects a forged payload that carries no signature at all', () => {
    const forged = '{"object":"whatsapp_business_account","entry":[{"id":"forged"}]}';
    const r = verifySignature(forged, '', APP_SECRET, { required: true });
    assert.notOk(r.ok);
    assert.equal(r.statusCode, 401);
  });

  it('only skips verification on an EXPLICIT opt-out', () => {
    const body = '{"a":1}';
    assert.notOk(verifySignature(body, '', '', { required: true }).ok,
      'default must be closed');
    assert.ok(verifySignature(body, '', '', { required: false }).ok,
      'explicit opt-out is the only way through');
  });
});
