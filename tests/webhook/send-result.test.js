/**
 * Reading a send's outcome for both connectors (scripts/lib/send-result.js).
 *
 * The WAHA cases pin the regression that logged every successful NOWEB send
 * as FAILED: NOWEB answers sendText with { key: { id } }, not the top-level
 * `id` WAHA's OpenAPI spec declares. docs/WAHA_REFERENCE.md §6.1.
 */

'use strict';

const { interpretSendResponse } = require('../../scripts/lib/send-result');

describe('send result — WAHA', () => {
  it('reads NOWEB\'s real response shape: { key: { id } }', () => {
    // Shape observed from WAHA 2026.8.2's NOWEB engine (Baileys sock.sendMessage).
    const r = interpretSendResponse('waha', {
      key: { remoteJid: '962791234567@s.whatsapp.net', fromMe: true, id: '3EB0ABCDEF0123456789' },
      message: { extendedTextMessage: { text: 'hi' } },
      messageTimestamp: '1789731318',
      status: 'PENDING',
    });
    assert.ok(r.ok, 'a successful NOWEB send must not be recorded as FAILED');
    assert.equal(r.messageId, '3EB0ABCDEF0123456789');
    assert.equal(r.apiError, null);
  });

  it('reads the spec\'s WAMessage shape with a top-level id', () => {
    const r = interpretSendResponse('waha', { id: 'true_962791234567@c.us_3EB0AA', body: 'hi' });
    assert.ok(r.ok);
    assert.equal(r.messageId, 'true_962791234567@c.us_3EB0AA');
  });

  it('prefers the top-level id when both are present', () => {
    const r = interpretSendResponse('waha', { id: 'top', key: { id: 'nested' } });
    assert.equal(r.messageId, 'top');
  });

  it('treats a NestJS error body as a failure, with its code', () => {
    const r = interpretSendResponse('waha', {
      statusCode: 422,
      message: 'Session status is not as expected.',
      error: 'Unprocessable Entity',
    });
    assert.notOk(r.ok);
    assert.equal(r.apiError.code, 422);
    assert.equal(r.apiError.message, 'Session status is not as expected.');
  });

  it('joins a validation-error message array', () => {
    const r = interpretSendResponse('waha', { statusCode: 400, message: ['chatId must be a string', 'text should not be empty'] });
    assert.notOk(r.ok);
    assert.equal(r.apiError.message, 'chatId must be a string; text should not be empty');
  });

  it('rejects a key without an id, and 401 from a wrong key', () => {
    assert.notOk(interpretSendResponse('waha', { key: {} }).ok);
    const unauth = interpretSendResponse('waha', { message: 'Unauthorized', statusCode: 401 });
    assert.notOk(unauth.ok);
    assert.equal(unauth.apiError.code, 401);
  });

  it('matches the connector name case- and space-insensitively', () => {
    assert.ok(interpretSendResponse(' WAHA ', { key: { id: 'x' } }).ok);
  });
});

describe('send result — Meta (unchanged behaviour)', () => {
  it('reads messages[0].id', () => {
    const r = interpretSendResponse('meta', { messaging_product: 'whatsapp', messages: [{ id: 'wamid.ABC' }] });
    assert.ok(r.ok);
    assert.equal(r.messageId, 'wamid.ABC');
  });

  it('defaults to Meta when the connector is unset', () => {
    assert.ok(interpretSendResponse(undefined, { messages: [{ id: 'wamid.ABC' }] }).ok);
    assert.notOk(interpretSendResponse(undefined, { key: { id: 'x' } }).ok,
      'a WAHA-shaped body must not count as a Meta success');
  });

  it('passes Meta\'s error object through', () => {
    const r = interpretSendResponse('meta', { error: { code: 131047, type: 'OAuthException', message: 're-engagement' } });
    assert.notOk(r.ok);
    assert.equal(r.apiError.code, 131047);
  });

  it('never throws on empty or malformed input', () => {
    for (const bad of [undefined, null, '', 'text', 42, []]) {
      assert.doesNotThrow(() => interpretSendResponse('waha', bad));
      assert.doesNotThrow(() => interpretSendResponse('meta', bad));
      assert.notOk(interpretSendResponse('waha', bad).ok);
    }
  });
});
