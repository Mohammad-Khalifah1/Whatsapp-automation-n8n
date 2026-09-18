/**
 * Read the outcome of a WhatsApp send, for either connector.
 *
 * CANONICAL SOURCE. Unit-tested (tests/webhook/send-result.test.js) and
 * injected into workflow 4's "Interpret Send Result" and workflow 7's
 * "Interpret Sheet Send" Code nodes by scripts/setup/build-workflows.js.
 *
 * The two connectors answer a send differently:
 *
 *   Meta Cloud API   { messages: [{ id: "wamid..." }] }   or   { error: {...} }
 *   WAHA (NOWEB)     { key: { remoteJid, fromMe, id }, message, ... }
 *
 * WAHA's OpenAPI spec declares sendText's response as a WAMessage with a
 * top-level string `id`. NOWEB does not return that: its sendText hands back
 * the Baileys sock.sendMessage() result untransformed, so the id is under
 * `key.id`. Reading only the top-level `id` logged every successful WAHA send
 * as FAILED. Both shapes are accepted here, top-level first, so a WAHA engine
 * that does follow the spec (WEBJS, GOWS) still works.
 * See docs/WAHA_REFERENCE.md §6.1.
 *
 * WAHA's errors are NestJS exceptions: { statusCode: 4xx|5xx, message, error }.
 */

'use strict';

/**
 * @param {string} connector  WHATSAPP_CONNECTOR — "waha" or anything else (Meta).
 * @param {object} response   The HTTP Request node's JSON output.
 * @returns {{ ok: boolean, messageId: string|null, apiError: {code: *, message: string}|null }}
 */
function interpretSendResponse(connector, response) {
  const r = response && typeof response === 'object' ? response : {};
  const isWaha = String(connector || 'meta').trim().toLowerCase() === 'waha';

  let messageId = null;
  let apiError = null;

  if (isWaha) {
    if (typeof r.statusCode === 'number' && r.statusCode >= 400) {
      const detail = Array.isArray(r.message) ? r.message.join('; ') : (r.message || r.error);
      apiError = { code: r.statusCode, message: String(detail || 'WAHA send failed') };
    }
    if (typeof r.id === 'string' && r.id !== '') {
      messageId = r.id;
    } else if (r.key && typeof r.key.id === 'string' && r.key.id !== '') {
      messageId = r.key.id;
    }
  } else {
    if (r.error) {
      apiError = r.error;
    }
    if (Array.isArray(r.messages) && r.messages[0] && r.messages[0].id) {
      messageId = r.messages[0].id;
    }
  }

  return { ok: !!messageId && !apiError, messageId, apiError };
}

module.exports = {
  interpretSendResponse,
};
